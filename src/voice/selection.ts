/**
 * voice/selection.ts —— ④ 后端选择（纯函数）。
 *
 * 【定位】给定"配置里钉没钉后端"和"哪些后端可用"，决定这次用哪个。
 *
 * 【核心规则：云端后端永不自动选中】
 *   自动选择只在**离线**后端里按顺序挑。原因很直接：语音是隐私数据。
 *   用户装了工具不等于同意把录音发到微软/某个云端。钉死 openai 或 edge-tts
 *   则是明确的意图，那就可以用。
 *
 * 【为什么是纯函数】选择逻辑里有分支、有优先级、有"没有可用后端"的错误路径。
 *   纯函数让它能被穷举测试（给定 A+B 必得 C），不用起进程、不用装东西。
 */
import type { SttBackendId, TtsBackendId } from './types.js';
import type { BackendProbes } from './probe.js';

/** 离线 STT 的回退顺序。 */
export const AUTO_STT_ORDER: readonly SttBackendId[] = ['whisper-local', 'macos'];
/** 离线 TTS 的回退顺序。 */
export const AUTO_TTS_ORDER: readonly TtsBackendId[] = ['say', 'piper'];

/** 选择结果：要么定下来，要么给出"为什么不行"。 */
export type BackendSelection<Id extends string> =
  | { readonly kind: 'ok'; readonly id: Id }
  | { readonly kind: 'none'; readonly reason: string };

/**
 * 选 STT 后端。
 *
 * @param configured - 配置里钉死的后端（若有）
 * @param probes - 可用性探测结果
 */
export function selectSttBackend(
  configured: { readonly backend?: SttBackendId },
  probes: BackendProbes,
): BackendSelection<SttBackendId> {
  // 钉死了就用钉的 —— 包括云端，那代表用户明确要求。
  if (configured.backend !== undefined) return { kind: 'ok', id: configured.backend };
  for (const id of AUTO_STT_ORDER) {
    if (probeFor(id, probes)) return { kind: 'ok', id };
  }
  return {
    kind: 'none',
    reason: 'no offline STT backend available — install whisper.cpp, or build the macOS speech bundle (see voice/README.md); configure stt.backend to override',
  };
}

/**
 * 选 TTS 后端。
 *
 * @param configured - 配置里钉死的后端（若有）
 * @param probes - 可用性探测结果
 */
export function selectTtsBackend(
  configured: { readonly backend?: TtsBackendId },
  probes: BackendProbes,
): BackendSelection<TtsBackendId> {
  if (configured.backend !== undefined) return { kind: 'ok', id: configured.backend };
  for (const id of AUTO_TTS_ORDER) {
    if (probeFor(id, probes)) return { kind: 'ok', id };
  }
  return {
    kind: 'none',
    reason: 'no local TTS backend available — macOS `say` or piper; configure tts.backend to override',
  };
}

function probeFor(id: SttBackendId | TtsBackendId, probes: BackendProbes): boolean {
  switch (id) {
    case 'whisper-local': return probes.whisperLocal;
    case 'macos': return probes.macosSttBundle;
    case 'say': return probes.say;
    case 'piper': return probes.piper;
    default: return false;
  }
}
