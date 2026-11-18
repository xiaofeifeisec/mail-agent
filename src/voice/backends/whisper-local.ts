/**
 * voice/backends/whisper-local.ts —— STT 后端：本地 whisper.cpp。
 *
 * 【定位】完全离线的语音识别。跑 whisper.cpp 可执行文件，用 `-oj` 让它输出
 *         JSON，再从 JSON 里取转写文本。
 *
 * 【为什么要解析两种 JSON 形状】whisper.cpp 历史上产出过三种格式：
 *   1. `{"text": "..."}`            —— 当前默认输出
 *   2. `{"transcription": [{"text": "..."}]}` —— 老版本
 *   3. `{"segments": [{"text": "..."}]}`       —— 分段输出模式
 *   三种都见过，所以三个都试。这是上游踩过坑后留下的防御逻辑。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShellRun } from '../shell.js';
import type { SttBackend, SttOutcome } from '../types.js';

/** 从 whisper.cpp 的 JSON 输出里提取转写文本；解析不出来返回 undefined。 */
export function parseWhisperJson(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;

  // 形状 1：直接一个 text 字段。
  if (typeof record.text === 'string' && record.text.trim() !== '') return record.text.trim();

  // 形状 2：transcription 数组。
  const transcription = record.transcription;
  if (Array.isArray(transcription) && transcription.length > 0) {
    const first = transcription[0];
    if (typeof first === 'object' && first !== null) {
      const text = (first as Record<string, unknown>).text;
      if (typeof text === 'string') return text.trim();
    }
  }

  // 形状 3：segments 数组。
  const segments = record.segments;
  if (Array.isArray(segments) && segments.length > 0) {
    const first = segments[0];
    if (typeof first === 'object' && first !== null) {
      const text = (first as Record<string, unknown>).text;
      if (typeof text === 'string') return text.trim();
    }
  }

  return undefined;
}

/** 本地 whisper.cpp 语音识别后端。 */
export class WhisperLocalSttBackend implements SttBackend {
  readonly id = 'whisper-local' as const;

  private readonly run: ShellRun;
  private readonly options: { readonly bin: string; readonly model?: string };

  constructor(run: ShellRun, options: { readonly bin: string; readonly model?: string }) {
    this.run = run;
    this.options = options;
  }

  async transcribe(file: string, signal?: AbortSignal): Promise<SttOutcome> {
    // 输出目录用临时目录 —— whisper 会写 .json 等中间文件，不该污染项目。
    const dir = await mkdtemp(join(tmpdir(), 'voice-whisper-'));
    try {
      const prefix = join(dir, 'out');
      const args = ['-f', file, '-oj', '-of', prefix];
      if (this.options.model !== undefined && this.options.model !== '') {
        args.push('-m', this.options.model);
      }

      const outcome = await this.run(this.options.bin, args, { signal });
      if (outcome.exitCode !== 0) {
        const detail = outcome.stderr.trim() || outcome.stdout.trim();
        throw new Error(`whisper-local: recognition failed (exit ${outcome.exitCode})${detail !== '' ? `: ${detail}` : ''}`);
      }

      const raw = await readFile(`${prefix}.json`, 'utf8');
      const transcript = parseWhisperJson(raw);
      if (transcript === undefined || transcript === '') {
        throw new Error('whisper-local: no transcript in whisper.cpp JSON output');
      }
      return { transcript, backend: this.id, detail: this.options.model ?? 'whisper.cpp' };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
