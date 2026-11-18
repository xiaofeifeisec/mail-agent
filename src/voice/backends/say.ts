/**
 * voice/backends/say.ts —— TTS 后端：macOS 内置 `say`。
 *
 * 【定位】本机默认的语音合成后端。零安装、零网络、每台 Mac 都有。
 *
 * 【为什么输出 m4a 而不是 aiff】
 *   上游选 m4a（AAC）是有道理的：aiff 文件极大（一分钟几十 MB），而 m4a
 *   压缩后小一个数量级，且 Safari/Chrome/QuickTime 都能直接播。代价是
 *   `say` 需要 `--file-format=m4af --data-format=aac` 两个参数。
 *
 * 【播放用 afplay】macOS 自带的播放器。和合成分开 —— 播放器缺失不该让合成失败。
 */
import type { ShellRun } from '../shell.js';
import type { SynthesizeResult, TtsBackend } from '../types.js';

/** macOS `say` 语音合成后端。 */
export class SayTtsBackend implements TtsBackend {
  readonly id = 'say' as const;

  private readonly run: ShellRun;

  constructor(run: ShellRun) {
    this.run = run;
  }

  async synthesize(
    input: { readonly text: string; readonly voice?: string; readonly rate?: number },
    dest: string,
    signal?: AbortSignal,
  ): Promise<SynthesizeResult> {
    const args = ['-o', dest, '--file-format=m4af', '--data-format=aac'];
    if (input.voice !== undefined && input.voice !== '') args.push('--voice', input.voice);
    // say 的 -r 单位是词/分钟。低于 1 会让它拒绝执行，所以这里过滤。
    if (input.rate !== undefined && input.rate > 0) args.push('-r', String(Math.round(input.rate)));
    // 文本作为最后一个位置参数。spawn 不经 shell，特殊字符不会被解释。
    args.push(input.text);

    const outcome = await this.run('say', args, { signal });
    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim() || outcome.stdout.trim();
      throw new Error(`say: synthesis failed (exit ${outcome.exitCode})${detail !== '' ? `: ${detail}` : ''}`);
    }
    return { mime: 'audio/mp4' };
  }

  async play(file: string, signal?: AbortSignal): Promise<void> {
    const outcome = await this.run('afplay', [file], { signal });
    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim() || outcome.stdout.trim();
      throw new Error(`afplay: playback failed (exit ${outcome.exitCode})${detail !== '' ? `: ${detail}` : ''}`);
    }
  }
}
