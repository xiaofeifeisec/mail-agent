/**
 * voice/backends/edge-tts.ts —— TTS 后端：edge-tts（微软 Edge 神经网络音色）。
 *
 * 【定位】云端合成后端。音质最好、免费，但**会把文本发到微软**。
 *
 * 【永不自动选中】见 selection.ts 的核心规则。必须显式配 tts.backend: 'edge-tts'。
 *
 * 【注意】edge-tts 只写文件不播放 —— 播放交给调用方的播放器（macOS 上是 afplay）。
 */
import type { ShellRun } from '../shell.js';
import type { SynthesizeResult, TtsBackend } from '../types.js';

/** edge-tts 命令行后端。 */
export class EdgeTtsBackend implements TtsBackend {
  readonly id = 'edge-tts' as const;

  private readonly run: ShellRun;
  private readonly options: { readonly bin: string; readonly voice: string };

  constructor(run: ShellRun, options: { readonly bin: string; readonly voice: string }) {
    this.run = run;
    this.options = options;
  }

  async synthesize(
    input: { readonly text: string; readonly voice?: string },
    dest: string,
    signal?: AbortSignal,
  ): Promise<SynthesizeResult> {
    const voice = input.voice ?? this.options.voice;
    const outcome = await this.run(
      this.options.bin,
      ['--voice', voice, '--write-media', dest, '--text', input.text],
      { signal },
    );
    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim() || outcome.stdout.trim();
      throw new Error(`edge-tts: synthesis failed (exit ${outcome.exitCode})${detail !== '' ? `: ${detail}` : ''}`);
    }
    return { mime: 'audio/mpeg' };
  }

  async play(): Promise<void> {
    // edge-tts 只产出文件；播放交给调用方。
  }
}
