/**
 * voice/index.ts —— 语音模块的统一入口。
 *
 * 【用法】
 *   import { createVoiceTools, resolveConfig } from './voice/index.js';
 *
 *   const cfg = resolveConfig({ stt: { backend: 'macos' }, tts: { backend: 'say' } });
 *   const voice = createVoiceTools(cfg);
 *
 *   const { transcript } = await voice.transcribe({ source: { record: { seconds: 5 } } });
 *   await voice.speak({ text: '邮件已处理完毕' });
 *
 * 【这个模块解决什么问题】
 *   邮件 agent 处理的是文本，但"写邮件"这个动作常常发生在用户离开键盘之后 ——
 *   走路、开会、做饭时想口述一封邮件。本模块提供两个能力：
 *     transcribe —— 口述音频 → 文本，作为邮件正文或指令
 *     speak      —— 把结果读出来（构建完成、失败提醒），用户不用盯着屏幕
 *
 * 【与上游 dsh-voice 插件的关系】
 *   移植自 github.com/Jesse-njx/dsh-voice（MIT License）。上游是 DSH 框架的
 *   插件，工具注册依赖 ctx.tools / ctx.jobs / DSH 会话体系；本项目把那层剥掉，
 *   只保留并修正后端实现。两个上游 bug 已修（见 shims/ 下的注释）。
 */
export { AudioStore, defaultAudioDir, expandHomePath, mimeForPath, resolveAudioDir } from './audio.js';
export {
  createRecordFn,
  createSttBackend,
  createTtsBackend,
  EdgeTtsBackend,
  FakeSttBackend,
  FakeTtsBackend,
  MacosSttBackend,
  OpenAiSttBackend,
  PiperTtsBackend,
  SayTtsBackend,
  WhisperLocalSttBackend,
  parseWhisperJson,
} from './backends/index.js';
export { probeBackends, probeOnPath, type BackendProbes } from './probe.js';
export { selectSttBackend, selectTtsBackend, type BackendSelection } from './selection.js';
export { commandExists, shellRun, type ShellOutcome, type ShellRun } from './shell.js';
export {
  createVoiceTools,
  defaultVoicePaths,
  speak,
  transcribe,
  type SpeakDeps,
  type TranscribeDeps,
  type VoicePaths,
  type VoiceTools,
} from './tools.js';
export {
  resolveConfig,
  type AudioRef,
  type SttBackend,
  type SttBackendId,
  type SttOutcome,
  type SttConfig,
  type SynthesizeResult,
  type TranscribeArgs,
  type TranscribeOutput,
  type TtsBackend,
  type TtsBackendId,
  type TtsConfig,
  type VoiceConfig,
  type VoiceConfigInput,
  type SpeakArgs,
  type SpeakOutput,
} from './types.js';
