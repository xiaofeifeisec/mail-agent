/**
 * voice/types.ts —— ① 语音工具的类型契约与配置。
 *
 * 【定位】本模块唯一的"事实来源"：配置形状、后端 id、音频引用、工具入参/出参
 *         全在这里定义。其余文件只 import 类型，不各自定义。
 *
 * 【与上游 dsh-voice 的差异】
 *   上游用 `zod`（schemastery）做运行时校验 + 从 DSH 设置服务读配置。本项目
 *   已有自己的 config.ts 体系（见 llm/client.ts 的 LLMConfig 模式），所以这里
 *   改成纯 TS 类型 + 一个手写的 resolveConfig()，不引入新依赖。
 */

/** 语音识别（STT）后端 id。`fake` 是测试替身，不做真实识别。 */
export type SttBackendId = 'whisper-local' | 'openai' | 'macos' | 'fake';

/** 语音合成（TTS）后端 id。 */
export type TtsBackendId = 'say' | 'piper' | 'edge-tts' | 'fake';

/**
 * STT 后端配置。
 *
 * 【自动选择的语义】backend 不填 = 自动。自动只会挑**离线**后端
 * （whisper-local → macos），绝不自动连云。这是上游的安全约定，本项目沿用：
 * 用户的语音不该因为"装了个插件"就悄悄发到第三方。
 */
export interface SttConfig {
  /** 钉死后端。填了就一定用它（包括 openai 云端）。 */
  readonly backend?: SttBackendId;
  /** 识别模型。openai 后端是 whisper-1，whisper.cpp 后端是本地 ggml 模型路径。 */
  readonly model?: string;
  /** whisper.cpp 本地后端配置。 */
  readonly whisperLocal?: {
    /** whisper.cpp 可执行文件路径。默认 `whisper-cli`（从 PATH 找）。 */
    readonly bin?: string;
    /** ggml 模型文件路径，传给 `whisper-cli -m`。 */
    readonly model?: string;
  };
  /** OpenAI 兼容的云端识别后端配置。 */
  readonly openai?: {
    /** 接口基地址。默认 https://api.openai.com/v1 */
    readonly baseUrl?: string;
    /** API key 的环境变量名（不是 key 本身）。 */
    readonly apiKeyEnv?: string;
  };
}

/** TTS 后端配置。 */
export interface TtsConfig {
  /** 钉死后端。填了就一定用它（包括 edge-tts 云端）。 */
  readonly backend?: TtsBackendId;
  /** 默认音色。say 用系统音色名（如 Tingting），edge-tts 用神经网络音色名。 */
  readonly voice?: string;
  /** 默认语速。say 的单位是词/分钟。 */
  readonly rate?: number;
  /** 本地 piper 神经 TTS 后端配置。 */
  readonly piper?: {
    /** piper 可执行文件路径。默认 `piper`（从 PATH 找）。 */
    readonly bin?: string;
    /** piper ONNX 模型路径，传给 `piper -m`。 */
    readonly model?: string;
  };
  /** edge-tts 云端后端配置。 */
  readonly edgeTts?: {
    /** 神经网络音色名。 */
    readonly voice?: string;
  };
}

/** 语音模块的完整配置。 */
export interface VoiceConfig {
  readonly stt: SttConfig;
  readonly tts: TtsConfig;
  /** 音频文件的落盘根目录。默认 ~/.dsh/voice。 */
  readonly audioDir: string;
}

/** 原始配置：所有字段可选。 */
export interface VoiceConfigInput {
  readonly stt?: SttConfig;
  readonly tts?: TtsConfig;
  readonly audioDir?: string;
}

/** 补全默认值后的配置。 */
export function resolveConfig(raw: VoiceConfigInput | undefined): VoiceConfig {
  const stt = raw?.stt ?? {};
  const tts = raw?.tts ?? {};
  return {
    stt: {
      ...(stt.backend !== undefined ? { backend: stt.backend } : {}),
      ...(stt.model !== undefined ? { model: stt.model } : {}),
      ...(stt.whisperLocal !== undefined ? { whisperLocal: stt.whisperLocal } : {}),
      ...(stt.openai !== undefined ? { openai: stt.openai } : {}),
    },
    tts: {
      ...(tts.backend !== undefined ? { backend: tts.backend } : {}),
      ...(tts.voice !== undefined ? { voice: tts.voice } : {}),
      ...(tts.rate !== undefined ? { rate: tts.rate } : {}),
      ...(tts.piper !== undefined ? { piper: tts.piper } : {}),
      ...(tts.edgeTts !== undefined ? { edgeTts: tts.edgeTts } : {}),
    },
    audioDir: raw?.audioDir ?? '',
  };
}

/**
 * 一次识别的结果。
 *
 * 【durationMs 的意义】音频时长。它不是装饰 —— 上游用它决定音频卡片的进度条
 * 长度，也让调用方知道"用户说了多久"，对判断"是不是误触发"有用。
 */
export interface SttOutcome {
  /** 识别出的文本。 */
  readonly transcript: string;
  /** 音频时长（毫秒），后端能报出时才填。 */
  readonly durationMs?: number;
  /** 产出该结果的后端 id。 */
  readonly backend: SttBackendId;
  /** 后端细节（如用了哪个模型）。 */
  readonly detail?: string;
}

/**
 * 一个语音识别后端。
 *
 * 【契约】transcribe 只负责"文件 → 文本"，不碰播放、不碰会话、不碰 UI。
 *         职责单一是为了能单独测：给它一个文件，它就得给出文本。
 */
export interface SttBackend {
  readonly id: SttBackendId;
  /**
   * 识别一个音频文件。
   * @param file - 音频文件的绝对路径
   * @param signal - 取消信号
   */
  transcribe(file: string, signal?: AbortSignal): Promise<SttOutcome>;
}

/** 一次合成的结果。 */
export interface SynthesizeResult {
  /** 写出文件的 MIME 类型。 */
  readonly mime: string;
  /** 音频时长（毫秒），后端能报出时才填。 */
  readonly durationMs?: number;
}

/**
 * 一个语音合成后端。
 *
 * 【synthesize 与 play 分开】这是上游最重要的一个设计。合成是"要写文件"的
 * 可测步骤，播放是"尽力而为"的副作用 —— 播放器缺失不该让合成失败。
 * 分开后，测试只需验证文件内容，不必真出声。
 */
export interface TtsBackend {
  readonly id: TtsBackendId;
  /**
   * 把文本合成到 dest 文件。
   * @param dest - 目标文件路径，由调用方决定（必须在音频根目录内）
   */
  synthesize(
    input: { readonly text: string; readonly voice?: string; readonly rate?: number },
    dest: string,
    signal?: AbortSignal,
  ): Promise<SynthesizeResult>;
  /**
   * 尽力播放一个音频文件。**不抛异常** —— 播放器缺失或播放失败都应被吞掉。
   */
  play(file: string, signal?: AbortSignal): Promise<void>;
}

/**
 * 音频文件的引用。
 *
 * 【为什么只存引用不存字节】会话记录里只放路径 + MIME。原始音频留在磁盘上，
 * 用户想看想删随时可以，程序崩了也不丢数据。
 */
export interface AudioRef {
  /** 音频文件的绝对路径。 */
  readonly path: string;
  /** MIME 类型。 */
  readonly mime: string;
  /** 音频时长（毫秒）。 */
  readonly durationMs?: number;
}

/** transcribe 工具的入参。 */
export interface TranscribeArgs {
  /**
   * 输入来源，二选一。
   *
   * 【为什么用嵌套对象而不是两个平级参数】平级参数（file + record 同时可传）
   * 会产生"两个都填了"的非法状态，调用方得自己判优先级。嵌套成 source 后，
   * "要么给 file 要么给 record"由类型系统保证，运行时再校验一次即可。
   */
  readonly source:
    | { readonly file: string }
    | { readonly record: { readonly seconds?: number } };
}

/** transcribe 工具的出参。 */
export interface TranscribeOutput {
  /** 识别出的文本 —— 这才是调用方真正要的东西。 */
  readonly transcript: string;
  /** 音频文件的引用。 */
  readonly audioRef: AudioRef;
  /** 实际使用的后端 id。 */
  readonly backend: string;
  /** 音频时长（毫秒）。 */
  readonly durationMs?: number;
}

/** speak 工具的入参。 */
export interface SpeakArgs {
  /** 要朗读的文本。 */
  readonly text: string;
  /** 覆盖默认音色。 */
  readonly voice?: string;
  /** 覆盖默认语速（词/分钟）。 */
  readonly rate?: number;
}

/** speak 工具的出参。 */
export interface SpeakOutput {
  /** 音频文件的引用。 */
  readonly audioRef: AudioRef;
  /** 实际使用的后端 id。 */
  readonly backend: string;
  /** 音频时长（毫秒）。 */
  readonly durationMs?: number;
}
