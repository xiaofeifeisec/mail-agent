/**
 * voice/backends/openai.ts —— STT 后端：OpenAI 兼容的 whisper-1 接口。
 *
 * 【定位】云端识别后端。**只有显式配置才会用到**，因为它会把音频发出去。
 *
 * 【API key 的处理】只读环境变量，不落盘、不进配置文件。key 的值永远不进日志
 * 或返回值。
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { SttBackend, SttOutcome } from '../types.js';

/** OpenAI 兼容的语音识别后端。 */
export class OpenAiSttBackend implements SttBackend {
  readonly id = 'openai' as const;

  private readonly options: {
    readonly baseUrl: string;
    readonly apiKeyEnv: string;
    readonly model: string;
    readonly fetchImpl?: typeof fetch;
  };

  constructor(options: {
    readonly baseUrl: string;
    readonly apiKeyEnv: string;
    readonly model: string;
    readonly fetchImpl?: typeof fetch;
  }) {
    this.options = options;
  }

  async transcribe(file: string, signal?: AbortSignal): Promise<SttOutcome> {
    const key = process.env[this.options.apiKeyEnv];
    if (key === undefined || key === '') {
      throw new Error(`openai: no API key — export ${this.options.apiKeyEnv} in the environment`);
    }

    const bytes = await readFile(file);
    const form = new FormData();
    form.append('file', new Blob([bytes]), basename(file));
    form.append('model', this.options.model);

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(
      `${this.options.baseUrl.replace(/\/$/, '')}/audio/transcriptions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal,
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `openai: transcription failed (HTTP ${response.status})${detail !== '' ? `: ${detail.slice(0, 300)}` : ''}`,
      );
    }

    const data = (await response.json()) as { text?: unknown };
    if (typeof data.text !== 'string' || data.text.trim() === '') {
      throw new Error('openai: transcription returned no text');
    }
    return { transcript: data.text.trim(), backend: this.id, detail: this.options.model };
  }
}
