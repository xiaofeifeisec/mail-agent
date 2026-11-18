/**
 * voice/probe.ts —— ④ 后端可用性探测。
 *
 * 【定位】回答一个问题："这台机器上现在有哪些后端能用？"
 *
 * 【为什么不做实时探测】上游在插件加载时探一次，之后一直用。这里改成每次调用
 *         前探 —— 因为用户可能中途装上 whisper、放个模型文件。多探一次的代价
 *         是几个毫秒的 stat 调用，换来的是"装完立刻能用"，值得。
 *
 * 【探测方式】全部是文件系统 / PATH 检查，不执行命令、不联网 —— 确定性且廉价。
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { VoiceConfig } from './types.js';

/** 各后端的可用性事实。 */
export interface BackendProbes {
  /** 能找到 whisper.cpp 可执行文件。 */
  readonly whisperLocal: boolean;
  /** macOS 的 `say` 在 PATH 上。 */
  readonly say: boolean;
  /** macOS + swift 运行时可用（SFSpeechRecognizer shim 的前提）。 */
  readonly macos: boolean;
  /** 能找到 piper 可执行文件。 */
  readonly piper: boolean;
  /** 能找到 edge-tts 可执行文件。 */
  readonly edgeTts: boolean;
  /** 有麦克风录音路径（ffmpeg 或 swift shim）。 */
  readonly mic: boolean;
  /** macOS 语音识别 bundle 已构建（.app 形态，带 Info.plist）。 */
  readonly macosSttBundle: boolean;
}

/** 某个命令是否在 PATH 上。 */
export function probeOnPath(name: string): boolean {
  const path = process.env.PATH ?? '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of path.split(':').filter((entry) => entry !== '')) {
    for (const ext of exts) {
      try {
        const candidate = join(dir, `${name}${ext}`);
        if (existsSync(candidate) && statSync(candidate).isFile()) return true;
      } catch {
        // 某个目录读不了 —— 跳过继续扫
      }
    }
  }
  return false;
}

/** 某个指定的文件路径是否存在。 */
export function probeFile(path: string | undefined): boolean {
  if (path === undefined || path === '') return false;
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/** macOS 的 `say` 是否可用。 */
export function probeSay(): boolean {
  return process.platform === 'darwin' && probeOnPath('say');
}

/** swift 运行时是否可用。 */
export function probeSwift(): boolean {
  return process.platform === 'darwin' && probeOnPath('swift');
}

/** whisper.cpp 是否可用（配置里指定的路径，或 PATH 上的 whisper-cli）。 */
export function probeWhisper(config: VoiceConfig): boolean {
  const configured = config.stt.whisperLocal?.bin;
  if (configured !== undefined && configured !== '') return probeFile(configured);
  return probeOnPath('whisper-cli') || probeOnPath('whisper');
}

/** 麦克风录音路径是否存在。 */
export function probeMic(): boolean {
  if (process.platform !== 'darwin') return false;
  return probeOnPath('ffmpeg') || probeOnPath('swift');
}

/**
 * macOS 语音识别 bundle 是否已构建。
 *
 * 【为什么单独探测】macOS 的 TCC（隐私授权）要求进程带 Info.plist 里的用途声明。
 *   命令行二进制直接跑会被系统 abort。所以 STT 必须打成 .app 才能用 ——
 *   bundle 不存在 = 这个后端不可用，而不是"运行时才报错"。
 */
export function probeMacosSttBundle(bundlePath: string): boolean {
  const exe = join(bundlePath, 'Contents', 'MacOS', 'VoiceSTT');
  const plist = join(bundlePath, 'Contents', 'Info.plist');
  return existsSync(exe) && existsSync(plist);
}

/** 探测全部后端。 */
export function probeBackends(config: VoiceConfig, macosSttBundlePath: string): BackendProbes {
  return {
    whisperLocal: probeWhisper(config),
    say: probeSay(),
    macos: probeSwift(),
    piper: probeFile(config.tts.piper?.bin) || probeOnPath('piper'),
    edgeTts: probeOnPath('edge-tts'),
    mic: probeMic(),
    macosSttBundle: probeMacosSttBundle(macosSttBundlePath),
  };
}
