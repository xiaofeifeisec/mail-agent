/**
 * voice/backends/macos.ts —— STT 后端：macOS 系统语音识别 + 麦克风录音。
 *
 * 【定位】macOS 专用后端，两个职责：
 *   1. MacosSttBackend —— 用系统内置的 SFSpeechRecognizer 识别音频（走 bundle shim）
 *   2. recordWithMacos —— 从麦克风录一段音频（走 swift shim 或 ffmpeg）
 *
 * 【为什么必须用 .app bundle 而不是命令行二进制】
 *   macOS 的 TCC（隐私授权）规定：访问麦克风/语音识别的进程，必须在 Info.plist
 *   里声明用途（NSSpeechRecognitionUsageDescription / NSMicrophoneUsageDescription）。
 *   命令行二进制没有 Info.plist，直接跑会被系统 SIGABRT 杀掉 —— 崩溃报告里
 *   写得很直白："attempted to access privacy-sensitive data without a usage
 *   description"。所以识别必须打成 .app 并通过 LaunchServices 启动。
 *
 * 【LaunchServices 的副作用】`open -a` 启动的进程拿不到 argv 和环境变量。
 *   所以参数通过 bundle 内的固定 job 文件传递（见 shims/macos-stt.swift）。
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { ShellRun } from '../shell.js';
import type { SttBackend, SttOutcome } from '../types.js';

/** macOS 语音识别 bundle 的默认位置（相对本文件所在目录）。 */
export function defaultMacosSttBundlePath(): string {
  // src/voice/backends/macos.ts → 上溯到 src/voice → 上溯到 src → 上溯到项目根
  return join(process.cwd(), 'voice', 'build', 'VoiceSTT.app');
}

/**
 * macOS SFSpeechRecognizer 语音识别后端。
 *
 * 【调用方式】不是直接跑 bundle 里的二进制，而是用 `open -a` 走 LaunchServices。
 *   直接跑二进制 TCC 会拒；走 LaunchServices 时 TCC 认的是 bundle 本身。
 */
export class MacosSttBackend implements SttBackend {
  readonly id = 'macos' as const;

  private readonly run: ShellRun;
  private readonly bundlePath: string;

  constructor(run: ShellRun, bundlePath: string) {
    this.run = run;
    this.bundlePath = bundlePath;
  }

  async transcribe(file: string, signal?: AbortSignal): Promise<SttOutcome> {
    // 【关键】`open -a` 的参数是「应用名」，相对路径会被当成名字去找，报
    // `Unable to find application named 'voice/build/...'`。必须在启动前 resolve
    // 成绝对路径。这里兜底，即使调用方传的是自定义相对路径也不会翻车。
    const bundlePath = isAbsolute(this.bundlePath) ? this.bundlePath : resolve(this.bundlePath);
    const jobPath = join(bundlePath, 'Contents', 'Resources', 'job.json');
    const resultPath = join(bundlePath, 'Contents', 'Resources', 'result.txt');

    // job 文件是传参通道：LaunchServices 启动的进程拿不到 argv。
    const { writeFile, rm } = await import('node:fs/promises');
    await writeFile(jobPath, JSON.stringify({ input: file, output: resultPath }), 'utf8');
    await rm(resultPath, { force: true }).catch(() => {});

    // `open -n` = 每次都开新实例（否则第二次调用会复用已在运行的进程）。
    const outcome = await this.run('open', ['-n', '-a', bundlePath], { signal });
    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim() || outcome.stdout.trim();
      throw new Error(`macos: failed to launch speech bundle (exit ${outcome.exitCode})${detail !== '' ? `: ${detail}` : ''}`);
    }

    // open 是异步的 —— 它启动进程就返回了。这里轮询等结果文件出现。
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (signal?.aborted === true) throw new Error('macos: transcription cancelled');
      if (existsSync(resultPath)) {
        // 文件可能是刚被写完，等它稳定。
        await new Promise((resolve) => setTimeout(resolve, 100));
        const { readFile } = await import('node:fs/promises');
        const text = (await readFile(resultPath, 'utf8')).trim();
        await rm(resultPath, { force: true }).catch(() => {});
        if (text === '') {
          throw new Error('macos: speech recognition returned an empty transcript');
        }
        if (text.startsWith('FAIL:')) {
          throw new Error(`macos: ${text.slice(5).trim()}`);
        }
        return { transcript: text, backend: this.id, detail: 'SFSpeechRecognizer' };
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error('macos: speech recognition timed out after 60s');
  }
}

/**
 * 从麦克风录音到 outFile。
 *
 * 【优先 ffmpeg】ffmpeg 的 avfoundation 输入更稳（能指定设备、处理各种采样率）；
 *   没有 ffmpeg 时退回 swift shim。两条路都失败就报错，不静默降级。
 */
export async function recordWithMacos(
  run: ShellRun,
  recordBin: string,
  outFile: string,
  seconds: number | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const duration = seconds !== undefined && seconds > 0 ? seconds : 5;

  if (await tryRun(run, 'ffmpeg', ['-version'], signal)) {
    if (await runFfmpeg(run, outFile, duration, signal)) return;
  }

  if (!existsSync(recordBin)) {
    throw new Error('voice: mic recording unavailable — build the recorder shim (voice/build.sh) or install ffmpeg');
  }
  const outcome = await run(recordBin, [outFile, String(duration)], { signal });
  if (outcome.exitCode !== 0) {
    const detail = outcome.stderr.trim() || outcome.stdout.trim();
    throw new Error(`voice: mic recording failed (exit ${outcome.exitCode})${detail !== '' ? `: ${detail}` : ''}`);
  }
}

async function runFfmpeg(
  run: ShellRun,
  outFile: string,
  duration: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const outcome = await run(
    'ffmpeg',
    ['-y', '-f', 'avfoundation', '-i', ':0', '-t', String(duration), '-c:a', 'aac', outFile],
    { signal },
  );
  if (outcome.exitCode === 0) return true;
  // ffmpeg 存在但录制失败（例如设备名不是 ":0"）—— 交给 swift shim 兜底。
  return false;
}

async function tryRun(run: ShellRun, command: string, args: readonly string[], signal?: AbortSignal): Promise<boolean> {
  try {
    const outcome = await run(command, args, { signal });
    return outcome.exitCode === 0;
  } catch {
    return false;
  }
}
