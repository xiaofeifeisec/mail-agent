/**
 * web/voice-bridge.ts —— 把 voice/* 适配成 Web 能用的两个能力。
 *
 * 【为什么单独一层】
 *   voice/* 是通用语音库（来自 dsh-voice），它的 speak() 会【在服务端】
 *   用 afplay 播放 —— 但 Web 用户要的是「浏览器里播放」，两者语义不同。
 *   所以这里只借它的【合成】能力生成音频文件，播放交给浏览器 <audio>。
 *
 * 【STT 的现实约束（必须说清）】
 *   macOS 语音识别受 TCC 隐私保护：访问 SFSpeechRecognizer 的进程必须带
 *   Info.plist 声明，命令行二进制会被系统 SIGABRT。必须构建成 .app bundle
 *   并经 LaunchServices 启动（见 voice/README.md）。whisper.cpp 也没预装。
 *   所以 STT 默认不可用 —— 这里返回【明确的原因】，前端据此禁用麦克风按钮，
 *   而不是假装能识别、点了没反应。
 */

import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { resolveConfig, AudioStore, shellRun, selectSttBackend, probeBackends, defaultVoicePaths, createVoiceTools, createTtsBackend } from '../voice/index.js';
import type { VoiceConfigInput } from '../voice/index.js';

export interface VoiceBridge {
  /** 合成一段语音，返回可供浏览器播放的相对 URL */
  synthesize(text: string): Promise<{ url: string; mime: string }>;
  /** 当前 STT 是否可用，不可用原因 */
  sttStatus(): { available: boolean; reason: string };
  /** 把一个已上传的音频文件转成文字 */
  transcribeFile(file: string, signal?: AbortSignal): Promise<{ text: string; backend: string }>;
  /** 音频文件目录（供路由做白名单校验） */
  audioDir: string;
}

/** 文件名只允许这类字符，防目录穿越（路由层也要再校验一次）。 */
export function safeAudioName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..');
}

export function createVoiceBridge(root: string, rawConfig: VoiceConfigInput = {}): VoiceBridge {
  const cfg = resolveConfig(rawConfig);
  const store = new AudioStore(cfg.audioDir);
  const paths = defaultVoicePaths();
  // TTS 走后端工厂：配置钉 piper 就用离线神经音色，否则按自动顺序选（say→piper）。
  // 之前这里硬编码 SayTtsBackend，导致配置无论怎么改都只在 say 上生效。
  const backendDeps = {
    run: shellRun,
    config: cfg,
    macosSttBundlePath: paths.macosSttBundle,
    recordBin: paths.recordBin,
  };
  const tts = createTtsBackend(backendDeps);
  const defaultVoice = cfg.tts.voice;
  const defaultRate = cfg.tts.rate;
  const tools = createVoiceTools(cfg);
  let seq = 0;

  return {
    audioDir: cfg.audioDir,

    async synthesize(text: string): Promise<{ url: string; mime: string }> {
      const clean = text.trim().slice(0, 4_000);
      if (!clean) throw new Error('没有要朗读的文本');
      seq += 1;
      const stem = `speak-${Date.now().toString(36)}-${seq}`;
      // 后缀跟随后端实际输出：piper 出 wav、say 出 m4a。合成前就能由后端 id 预判，
      // 于是在同一处定好 ext / mime / 落盘路径，路由层再按后缀回 content-type。
      const ext = tts.id === 'piper' ? 'wav' : 'm4a';
      const mime = ext === 'wav' ? 'audio/wav' : 'audio/mp4';
      const file = store.pathFor(stem, ext);
      const name = `${stem}.${ext}`;
      await mkdir(join(file, '..'), { recursive: true });
      // 只合成、不 play —— 播放交给浏览器，声音才从用户的设备出来。
      // 音色由配置决定：say 用 --voice（如婷婷）；piper 的音色已固化在模型里。
      const hint = defaultVoice ? { voice: defaultVoice } : {};
      const result = await tts.synthesize(
        { text: clean, ...hint, ...(defaultRate !== undefined ? { rate: defaultRate } : {}) },
        file,
      );
      // 以后端实际返回的 mime 为准（比预判更可靠），但后缀已随之匹配。
      return { url: `/api/voice/audio/${name}`, mime: result.mime || mime };
    },

    sttStatus(): { available: boolean; reason: string } {
      const probes = probeBackends(cfg, defaultVoicePaths().macosSttBundle);
      const sel = selectSttBackend(cfg.stt, probes);
      if (sel.kind === 'ok') return { available: true, reason: '' };
      return {
        available: false,
        reason:
          '语音识别需要 whisper.cpp（安装 whisper-cli）或 macOS 语音识别 .app bundle（见 voice/README.md）。' +
          '当前两者都不可用，请手动输入。',
      };
    },

    async transcribeFile(file: string, signal?: AbortSignal): Promise<{ text: string; backend: string }> {
      const out = await tools.transcribe({ source: { file } }, signal);
      return { text: out.transcript, backend: out.backend };
    },
  };
}
