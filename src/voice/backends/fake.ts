/**
 * voice/backends/fake.ts —— 测试替身后端。
 *
 * 【定位】不做真实语音处理，只跑通整条链路。没有麦克风、没有网络也能测工具逻辑。
 *
 * 【映射规则是确定的】
 *   STT：读"音频"文件。内容是带 transcript 字段的 JSON 就返回该字段；
 *        否则取文件名（去扩展名、-/_ 转空格）。所以 `fixture-build-done.m4a`
 *        会转写成 "build done"。
 *   TTS：把 {"transcript": "<文本>"} 写进目标文件。于是 speak 的输出能被
 *        fake STT 原样读回 —— 闭环可测。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { SttBackend, SttOutcome, SynthesizeResult, TtsBackend } from '../types.js';

/** 从 fake 音频文件里取出预置的转写文本。 */
export async function fakeTranscriptFrom(file: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    raw = '';
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { transcript?: unknown };
      if (typeof parsed.transcript === 'string' && parsed.transcript !== '') return parsed.transcript;
    } catch {
      // 不是 JSON —— 走文件名规则
    }
  }
  return basename(file, extname(file)).replaceAll(/[-_]+/g, ' ').trim();
}

/** 假识别后端。 */
export class FakeSttBackend implements SttBackend {
  readonly id = 'fake' as const;

  async transcribe(file: string): Promise<SttOutcome> {
    const transcript = await fakeTranscriptFrom(file);
    return { transcript, backend: this.id, detail: 'fake: text-to-text fixture mapping' };
  }
}

/** 假合成后端。 */
export class FakeTtsBackend implements TtsBackend {
  readonly id = 'fake' as const;

  async synthesize(input: { readonly text: string }, dest: string): Promise<SynthesizeResult> {
    await writeFile(dest, JSON.stringify({ transcript: input.text }, null, 2), 'utf8');
    return { mime: 'application/json; fake-audio' };
  }

  async play(): Promise<void> {
    // 假播放是空操作 —— 没有声音，也不会失败。
  }
}
