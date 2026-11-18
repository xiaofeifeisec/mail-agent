/**
 * voice/backends/index.ts —— 后端工厂。
 *
 * 【定位】把"配置 + 探测结果"变成一个具体的后端实例。选择逻辑在 selection.ts
 *         （纯函数），这里只负责实例化。
 *
 * 【每次调用都新建】上游在插件加载时建一次后端。这里改成每次调用新建 —— 因为
 *         用户可能中途装好 whisper 或改配置。新建的开销只是几个对象，不值得
 *         为了这点性能牺牲"改完立刻生效"。
 */
import { join } from 'node:path';
import type { ShellRun } from '../shell.js';
import { probeBackends, type BackendProbes } from '../probe.js';
import { selectSttBackend, selectTtsBackend } from '../selection.js';
import type { SttBackend, TtsBackend, VoiceConfig } from '../types.js';
import { EdgeTtsBackend } from './edge-tts.js';
import { FakeSttBackend, FakeTtsBackend } from './fake.js';
import { MacosSttBackend } from './macos.js';
import { OpenAiSttBackend } from './openai.js';
import { PiperTtsBackend } from './piper.js';
import { SayTtsBackend } from './say.js';
import { WhisperLocalSttBackend } from './whisper-local.js';

/** 工厂需要的依赖。测试可注入 run 与 probes 覆盖真实行为。 */
export interface BackendDeps {
  readonly run: ShellRun;
  readonly config: VoiceConfig;
  /** macOS 语音识别 bundle 的路径。 */
  readonly macosSttBundlePath: string;
  /** 录音 shim 的路径。 */
  readonly recordBin: string;
  /** 探测结果覆盖（测试用）。 */
  readonly probes?: BackendProbes;
}

/** 建出配置的 STT 后端。没有可用后端时抛出带原因的错误。 */
export function createSttBackend(deps: BackendDeps): SttBackend {
  const probes = deps.probes ?? probeBackends(deps.config, deps.macosSttBundlePath);
  const selected = selectSttBackend(deps.config.stt, probes);
  if (selected.kind === 'none') throw new Error(`voice: ${selected.reason}`);

  switch (selected.id) {
    case 'fake':
      return new FakeSttBackend();
    case 'whisper-local':
      return new WhisperLocalSttBackend(deps.run, {
        bin: deps.config.stt.whisperLocal?.bin ?? 'whisper-cli',
        model: deps.config.stt.whisperLocal?.model,
      });
    case 'openai':
      return new OpenAiSttBackend({
        baseUrl: deps.config.stt.openai?.baseUrl ?? 'https://api.openai.com/v1',
        apiKeyEnv: deps.config.stt.openai?.apiKeyEnv ?? 'OPENAI_API_KEY',
        model: deps.config.stt.model ?? 'whisper-1',
      });
    case 'macos':
      return new MacosSttBackend(deps.run, deps.macosSttBundlePath);
  }
}

/** 建出配置的 TTS 后端。没有可用后端时抛出带原因的错误。 */
export function createTtsBackend(deps: BackendDeps): TtsBackend {
  const probes = deps.probes ?? probeBackends(deps.config, deps.macosSttBundlePath);
  const selected = selectTtsBackend(deps.config.tts, probes);
  if (selected.kind === 'none') throw new Error(`voice: ${selected.reason}`);

  switch (selected.id) {
    case 'fake':
      return new FakeTtsBackend();
    case 'say':
      return new SayTtsBackend(deps.run);
    case 'piper':
      return new PiperTtsBackend(deps.run, {
        bin: deps.config.tts.piper?.bin ?? 'piper',
        model: deps.config.tts.piper?.model ?? '',
      });
    case 'edge-tts':
      return new EdgeTtsBackend(deps.run, {
        bin: 'edge-tts',
        voice: deps.config.tts.edgeTts?.voice ?? deps.config.tts.voice ?? 'en-US-GuyNeural',
      });
  }
}

/**
 * 建出录音函数。
 *
 * 【为什么录音要先落到临时文件】录音器需要一个确定的输出路径（ffmpeg 和
 * swift shim 都是"写到某路径"）。先录到临时目录，成功后再提交进音频根目录。
 */
export function createRecordFn(deps: BackendDeps): (seconds: number | undefined, signal?: AbortSignal) => Promise<{ readonly file: string; readonly durationMs?: number }> {
  const probes = deps.probes ?? probeBackends(deps.config, deps.macosSttBundlePath);
  return async (seconds, signal) => {
    if (!probes.mic) {
      throw new Error('voice: mic recording unavailable — build the recorder shim (voice/build.sh) or install ffmpeg');
    }
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'voice-record-'));
    const file = join(dir, 'voice-record.m4a');
    const { recordWithMacos } = await import('./macos.js');
    await recordWithMacos(deps.run, deps.recordBin, file, seconds, signal);
    return { file, durationMs: seconds !== undefined && seconds > 0 ? Math.round(seconds * 1000) : 5000 };
  };
}

export { EdgeTtsBackend } from './edge-tts.js';
export { FakeSttBackend, FakeTtsBackend } from './fake.js';
export { MacosSttBackend, recordWithMacos } from './macos.js';
export { OpenAiSttBackend } from './openai.js';
export { PiperTtsBackend } from './piper.js';
export { SayTtsBackend } from './say.js';
export { WhisperLocalSttBackend, parseWhisperJson } from './whisper-local.js';
