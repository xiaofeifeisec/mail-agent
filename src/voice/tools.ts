/**
 * voice/tools.ts —— 语音工具本体：transcribe 与 speak。
 *
 * 【定位】上游 dsh-voice 把这两个工具注册在 DSH 框架的 `ctx.tools` 上
 *         （defineTool + ctx.tools.register）。本项目没有那套框架，所以这里
 *         导出的是**普通 async 函数** —— 调用方（管线 / agent）直接 await 它们。
 *         工具的语义、参数、返回值与上游保持一致。
 *
 * 【与上游的差异】
 *   1. 没有 `presentCall` / `render`（那是 UI 卡片渲染，属于 DSH 客户端的事）。
 *   2. transcribe 不再"把转写文本作为用户消息插入对话" —— 那是 DSH 的会话
 *      机制。这里直接返回 transcript，由调用方决定怎么用（插入消息、写邮件、
 *      还是当作指令）。**这反而更灵活**：邮件 agent 需要的是"这段话说了什么"，
 *      而不是"把它变成一条 user message"。
 *   3. speak 不返回 jobId —— 上游用后台任务是为了不阻塞 agent 回合。本项目
 *      的调用方自己决定要不要 await，所以直接返回结果。
 *
 * 【依赖注入】所有依赖都是参数，不读全局状态。测试可以塞假后端进去。
 */
import { basename, extname, join } from 'node:path';
import { AudioStore, resolveAudioDir } from './audio.js';
import { defaultMacosSttBundlePath } from './backends/macos.js';
import { createRecordFn, createSttBackend, createTtsBackend } from './backends/index.js';
import { shellRun, type ShellRun } from './shell.js';
import type {
  AudioRef,
  SttBackend,
  TtsBackend,
  TranscribeArgs,
  TranscribeOutput,
  SpeakArgs,
  SpeakOutput,
  VoiceConfig,
} from './types.js';

/** transcribe 需要的依赖。 */
export interface TranscribeDeps {
  readonly stt: SttBackend;
  /** 从麦克风录音，返回音频文件路径。 */
  readonly record: (seconds: number | undefined, signal?: AbortSignal) => Promise<{ readonly file: string; readonly durationMs?: number }>;
  /** 把音频文件提交进音频仓库。 */
  readonly commit: (file: string, name: string, extra?: { readonly durationMs?: number }) => Promise<AudioRef>;
}

/** speak 需要的依赖。 */
export interface SpeakDeps {
  readonly tts: TtsBackend;
  /** 在音频仓库里预留一个输出路径。 */
  readonly audioPath: () => string;
}

/**
 * 语音转文字。
 *
 * 【入参】source 恰好是 file 或 record 之一：
 *   - `{ file: "/path/to/a.m4a" }` —— 转写已有音频文件
 *   - `{ record: { seconds: 5 } }`  —— 先录 5 秒再转写（默认 5 秒）
 *
 * 【出参】transcript 是识别出的文本；audioRef 指向留存的音频文件。
 */
export async function transcribe(
  deps: TranscribeDeps,
  args: TranscribeArgs,
  signal?: AbortSignal,
): Promise<TranscribeOutput> {
  const source = args.source;

  let file: string;
  let mediaDurationMs: number | undefined;
  if ('file' in source) {
    file = source.file;
  } else {
    const recorded = await deps.record(source.record?.seconds, signal);
    file = recorded.file;
    mediaDurationMs = recorded.durationMs;
  }

  const outcome = await deps.stt.transcribe(file, signal);

  // 音频留个档：转写完用户可能想回放原话。文件名带时间戳避免撞名。
  const noteId = Date.now().toString(36);
  const audioRef = await deps.commit(file, `voice-in-${noteId}${extOf(file)}`);

  return {
    transcript: outcome.transcript,
    audioRef,
    backend: outcome.backend,
    ...(outcome.durationMs !== undefined
      ? { durationMs: outcome.durationMs }
      : mediaDurationMs !== undefined
        ? { durationMs: mediaDurationMs }
        : {}),
  };
}

/**
 * 文字转语音。
 *
 * 【合成与播放分开】合成失败会抛错（调用方需要知道）；播放失败只记日志不抛
 *   —— 播放器不存在不该让整个流程失败。
 *
 * 【出参】audioRef 指向生成的音频文件，调用方可以自己决定播不播。
 */
export async function speak(
  deps: SpeakDeps,
  args: SpeakArgs,
  signal?: AbortSignal,
): Promise<SpeakOutput> {
  if (args.text.trim() === '') throw new Error('speak: text must not be empty');

  const file = deps.audioPath();
  const result = await deps.tts.synthesize(
    {
      text: args.text,
      ...(args.voice !== undefined ? { voice: args.voice } : {}),
      ...(args.rate !== undefined ? { rate: args.rate } : {}),
    },
    file,
    signal,
  );

  const audioRef: AudioRef = {
    path: file,
    mime: result.mime,
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
  };

  // 播放是尽力而为：失败只记，不抛。
  await deps.tts.play(file, signal).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[voice] playback failed: ${message}`);
  });

  return { audioRef, backend: deps.tts.id, ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}) };
}

/**
 * 工具的完整装配 —— 从配置一次性造出 transcribe/speak 两个可调用入口。
 *
 * 【为什么提供这个便利函数】调用方通常不想关心后端选择、仓库路径这些细节。
 *   给它一个 VoiceConfig 就能拿到两个能直接 await 的函数。
 *
 * 【路径约定】macOS 语音识别 bundle 与录音 shim 默认在 `<项目根>/voice/build/` 下，
 *   由 voice/build.sh 构建。可以用配置项覆盖。
 */
export interface VoiceTools {
  readonly transcribe: (args: TranscribeArgs, signal?: AbortSignal) => Promise<TranscribeOutput>;
  readonly speak: (args: SpeakArgs, signal?: AbortSignal) => Promise<SpeakOutput>;
  /** 音频仓库根目录。 */
  readonly audioDir: string;
  /** 音频仓库实例（需要直接操作文件时用）。 */
  readonly store: AudioStore;
}

/** 语音工具的路径配置。 */
export interface VoicePaths {
  /** macOS 语音识别 .app bundle 路径。 */
  readonly macosSttBundle: string;
  /** 录音 shim 可执行文件路径。 */
  readonly recordBin: string;
}

/**
 * 猜出默认路径。
 *
 * 【为什么必须是绝对路径】`open -a` 的第一个参数是「应用名」，不是路径。
 *   传相对路径 `voice/build/VoiceSTT.app` 时，LaunchServices 会按名字去找，
 *   报 `Unable to find application named 'voice/build/VoiceSTT.app'`；
 *   传绝对路径才认。这里从源头就给绝对路径，避免一路把相对路径传到 `open -a`。
 *   （后端 macos.ts 里还有一层 resolve 兜底，防止用户自定义相对路径时再踩。）
 */
export function defaultVoicePaths(): VoicePaths {
  return {
    macosSttBundle: defaultMacosSttBundlePath(),
    recordBin: join(process.cwd(), 'voice', 'build', 'macos-record'),
  };
}

/** 从配置装配出两个工具。 */
export function createVoiceTools(
  config: VoiceConfig,
  paths: VoicePaths = defaultVoicePaths(),
  run: ShellRun = shellRun,
): VoiceTools {
  const audioRoot = resolveAudioDir(config.audioDir);
  const store = new AudioStore(audioRoot);
  let speakSeq = 0;

  const backendDeps = () => ({
    run,
    config,
    macosSttBundlePath: paths.macosSttBundle,
    recordBin: paths.recordBin,
  });

  return {
    audioDir: audioRoot,
    store,

    async transcribe(args: TranscribeArgs, signal?: AbortSignal): Promise<TranscribeOutput> {
      return transcribe(
        {
          stt: createSttBackend(backendDeps()),
          record: createRecordFn(backendDeps()),
          commit: (file, name, extra) => store.commit(file, name, extra),
        },
        args,
        signal,
      );
    },

    async speak(args: SpeakArgs, signal?: AbortSignal): Promise<SpeakOutput> {
      speakSeq += 1;
      return speak(
        {
          tts: createTtsBackend(backendDeps()),
          // 文件名带时间戳+序号：同一秒内多次朗读不会互相覆盖。
          audioPath: () => store.pathFor(`voice-speak-${Date.now().toString(36)}-${speakSeq}`, 'm4a'),
        },
        args,
        signal,
      );
    },
  };
}

function extOf(file: string): string {
  const dot = file.lastIndexOf('.');
  return dot >= 0 ? file.slice(dot) : '.m4a';
}

/** 从文件名反推一个可读标签（调试用）。 */
export function labelOf(file: string): string {
  return basename(file, extname(file));
}
