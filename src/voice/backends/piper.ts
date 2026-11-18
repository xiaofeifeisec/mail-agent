/**
 * voice/backends/piper.ts —— TTS 后端：本地 piper 神经 TTS。
 *
 * 【定位】离线神经 TTS。音质接近云端，但完全本地跑。
 *
 * 【文本走 stdin】piper 的用法是 `piper -m model --output_file out`，文本从标准
 *   输入喂进去。所以这里的 ShellRun 必须支持 stdin —— 这是它与其它后端唯一
 *   的差别。
 */
import type { ShellRun } from '../shell.js';
import type { SynthesizeResult, TtsBackend } from '../types.js';

/** 本地 piper 语音合成后端。 */
export class PiperTtsBackend implements TtsBackend {
  readonly id = 'piper' as const;

  private readonly run: ShellRun;
  private readonly options: { readonly bin: string; readonly model: string };

  constructor(run: ShellRun, options: { readonly bin: string; readonly model: string }) {
    this.run = run;
    this.options = options;
  }

  async synthesize(
    input: { readonly text: string },
    dest: string,
    signal?: AbortSignal,
  ): Promise<SynthesizeResult> {
    const outcome = await this.run(
      this.options.bin,
      ['-m', this.options.model, '--output_file', dest],
      { signal, stdin: input.text },
    );
    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim() || outcome.stdout.trim();
      throw new Error(`piper: synthesis failed (exit ${outcome.exitCode})${detail !== '' ? `: ${detail}` : ''}`);
    }
    return { mime: 'audio/wav' };
  }

  async play(): Promise<void> {
    // piper 只写文件；播放交给调用方。
  }
}
