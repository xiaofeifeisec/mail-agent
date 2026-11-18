/**
 * monitor/state.ts —— 通知状态机 + 水位线。
 *
 * 【它解决什么问题】
 * 收到邮件 → 分类 → 只有 urgent 才弹窗。但"弹窗"这件事本身有状态：
 *   - 弹过没有？弹过几次？
 *   - 弹窗在屏幕上停留多久后自动消失？
 *   - 多久没人管，就降级成普通、只进摘要不再打扰？
 *   - 同一封邮件要不要重复弹？冷却期过了没？
 *
 * 这些全是【确定性判断】—— 交给代码，不花 token，不问模型。
 *
 * 【两个时限千万别搞混】
 *   popupTtlMs      弹窗在屏幕上停留多久        10 秒  ← 纯 UI 行为
 *   escalateAfterMs 弹窗后多久没人管就降级      30 分钟 ← 业务 SLA
 *
 * 用 10 秒当"降级时限"是没意义的 —— 人根本来不及反应。
 * 所以这两个是独立配置，别混成一个。
 *
 * 【状态流转】
 *
 *   pending ──弹窗──> shown ──TTL 到──> dismissed ──SLA 到──> expired
 *      │                 │                                          │
 *      │                 └────────用户已处理────────> handled      │
 *      └──用户已处理──────────────────────────────> handled      │
 *                                                                 ↓
 *                                            expired = 不再打扰，只进摘要
 *
 * 【为什么纯同步、不依赖任何东西】
 * 这个模块要在 watch 循环里每轮都调，而且要能被离线测试。
 * 所以：零第三方依赖、零网络、状态全在内存 + 一个 JSON 文件。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/* ============================== 类型 ============================== */

/** 一封邮件的通知状态。 */
export type NotifyState =
  /** 已发现为 urgent，还没弹过 */
  | 'pending'
  /** 弹窗正在屏幕上显示 */
  | 'shown'
  /** 弹窗已消失（TTL 到期或用户手动关掉），还在等待处理 */
  | 'dismissed'
  /** 超过 SLA 没人管 → 降级，不再打扰，只进摘要 */
  | 'expired'
  /** 用户已处理（回复、标记、忽略） */
  | 'handled';

/** 一条通知记录。 */
export interface NotifyRecord {
  /** 邮件 id（内容哈希）—— 主键 */
  emailId: string;
  /** IMAP uid（有就带上，便于回溯） */
  uid?: number;
  /** 分类结果：只有 urgent 才进通知流程 */
  category: string;
  subject: string;
  from: string;
  /** 检测到的时间（epoch ms） */
  detectedAt: number;
  /** 当前状态 */
  state: NotifyState;
  /** 弹窗时刻 */
  shownAt?: number;
  /** 弹窗自动消失时刻 = shownAt + popupTtlMs */
  expiresAt?: number;
  /** 降级时刻 = shownAt + escalateAfterMs */
  escalateAt?: number;
  /** 弹过几次 */
  shownCount: number;
  /** 用户处理的时刻 */
  handledAt?: number;
}

/** 通知策略（可配）。 */
export interface NotifyOptions {
  /** 弹窗在屏幕上停留多久（ms）—— 10 秒就是 10_000 */
  popupTtlMs: number;
  /** 弹窗后多久没人处理就降级（ms）—— 30 分钟就是 1_800_000 */
  escalateAfterMs: number;
  /** 两次弹窗之间的最小间隔（ms）—— 防刷屏 */
  cooldownMs: number;
  /**
   * 同一封邮件最多弹几次。
   *
   * 【1 = 每封信只提醒一次】—— 这是默认且推荐的值。
   * 弹过一次就记住；用户没处理的话，弹窗到 TTL 自动消失，
   * 之后这封信只会进摘要，不再打扰。
   *
   * 【为什么不做成"过一会儿再提醒一次"】
   * 弹窗只有 10 秒，用户可能根本没看到。再弹一次的价值不大，
   * 但打扰是真的 —— 所以宁可少提醒，不要反复骚扰。
   *
   * 【和 cooldownMs 的分工】
   *   maxRepeat  管【同一封】重复弹
   *   cooldownMs 管【不同封】之间的间隔（一批邮件同时到时防刷屏）
   * 两者互补，都需要。
   */
  maxRepeat: number;
}

/** 默认策略：跟 Web UI 的弹窗体验对齐。 */
export const DEFAULT_NOTIFY_OPTIONS: NotifyOptions = {
  popupTtlMs: 10_000,
  escalateAfterMs: 30 * 60_000,
  cooldownMs: 5 * 60_000,
  // 每封信只提醒一次 —— 弹过就不再打扰，只进摘要
  maxRepeat: 1,
};

/** 决定要不要弹窗的结果。 */
export interface NotifyDecision {
  /** 弹还是不弹 */
  notify: boolean;
  /** 为什么（可写进日志/事件流） */
  reason: string;
  /** 不弹时的原因分类，便于统计 */
  kind:
    | 'ok'
    | 'not-urgent'
    | 'already-shown'
    | 'handled'
    | 'expired'
    | 'cooldown'
    | 'max-repeat';
}

/* ============================== 记录构造 ============================== */

/** 建一条记录。 */
export function createRecord(
  input: {
    emailId: string;
    uid?: number;
    category: string;
    subject: string;
    from: string;
  },
  now: number,
): NotifyRecord {
  return {
    emailId: input.emailId,
    uid: input.uid,
    category: input.category,
    subject: input.subject,
    from: input.from,
    detectedAt: now,
    state: 'pending',
    shownCount: 0,
  };
}

/* ============================== 状态推进 ============================== */

/**
 * 把时间推进到 now，结算所有到期的状态转移。
 *
 * 必须每轮 watch 都调 —— 否则状态永远停在 shown，
 * 会出现"弹过一次就再也不弹"的假象。
 */
export function tick(records: Map<string, NotifyRecord>, now: number): void {
  for (const rec of records.values()) {
    // 弹窗 TTL 到了 → 从"显示中"变成"已消失"
    if (rec.state === 'shown' && rec.expiresAt !== undefined && now >= rec.expiresAt) {
      rec.state = 'dismissed';
    }
    // 等待期也过了 → 降级，不再打扰
    if (rec.state === 'dismissed' && rec.escalateAt !== undefined && now >= rec.escalateAt) {
      rec.state = 'expired';
    }
  }
}

/* ============================== 弹窗决策 ============================== */

/**
 * 决定这封邮件现在要不要弹窗。
 *
 * 顺序很重要：先看"该不该弹"（分类），再看"能不能弹"（状态、冷却）。
 */
export function decideNotify(
  records: Map<string, NotifyRecord>,
  emailId: string,
  category: string,
  opts: NotifyOptions = DEFAULT_NOTIFY_OPTIONS,
  now: number = Date.now(),
): NotifyDecision {
  // ① 只有 urgent 才弹 —— 这是用户明确要求的
  if (category !== 'urgent') {
    return { notify: false, reason: `分类是 ${category}，不弹`, kind: 'not-urgent' };
  }

  const rec = records.get(emailId);

  if (rec) {
    if (rec.state === 'handled') {
      return { notify: false, reason: '已经处理过了', kind: 'handled' };
    }
    if (rec.state === 'expired') {
      return { notify: false, reason: '已超时降级，只进摘要', kind: 'expired' };
    }
    if (rec.state === 'shown') {
      return { notify: false, reason: '弹窗正在显示中', kind: 'already-shown' };
    }

    // ② 重复弹的限制（只对已经弹过的邮件有意义）
    if (rec.shownCount >= opts.maxRepeat) {
      return {
        notify: false,
        reason: `已经弹过 ${rec.shownCount} 次（上限 ${opts.maxRepeat}）`,
        kind: 'max-repeat',
      };
    }
  }

  // ③ 冷却期 —— 【全局】限制，不是 per-email。
  //    必须放在这里（新邮件也要检查），否则一批邮件同时到达时会连环弹窗刷屏。
  const lastShown = latestShownAt(records);
  if (lastShown !== undefined && now - lastShown < opts.cooldownMs) {
    const wait = Math.ceil((opts.cooldownMs - (now - lastShown)) / 1000);
    return {
      notify: false,
      reason: `冷却中，还有 ${wait} 秒`,
      kind: 'cooldown',
    };
  }

  if (!rec) {
    return { notify: true, reason: '新邮件且是 urgent', kind: 'ok' };
  }

  return { notify: true, reason: 'urgent 且可以提醒', kind: 'ok' };
}

/** 记录一次弹窗。 */
export function markShown(
  rec: NotifyRecord,
  now: number,
  opts: NotifyOptions = DEFAULT_NOTIFY_OPTIONS,
): NotifyRecord {
  rec.state = 'shown';
  rec.shownAt = now;
  rec.expiresAt = now + opts.popupTtlMs;
  rec.escalateAt = now + opts.escalateAfterMs;
  rec.shownCount += 1;
  return rec;
}

/** 标记用户已处理。 */
export function markHandled(rec: NotifyRecord, now: number): NotifyRecord {
  rec.state = 'handled';
  rec.handledAt = now;
  return rec;
}

/* ============================== 查询 ============================== */

/** 最近一次弹窗的时刻（没有则 undefined）。 */
export function latestShownAt(records: Map<string, NotifyRecord>): number | undefined {
  let max: number | undefined;
  for (const rec of records.values()) {
    if (rec.shownAt !== undefined && (max === undefined || rec.shownAt > max)) {
      max = rec.shownAt;
    }
  }
  return max;
}

/** 现在还"有效"的记录（弹窗中 + 待处理）—— 这些是要展示给用户的。 */
export function activeAlerts(records: Map<string, NotifyRecord>): NotifyRecord[] {
  return [...records.values()]
    .filter((r) => r.state === 'shown' || r.state === 'dismissed')
    .sort((a, b) => (a.shownAt ?? 0) - (b.shownAt ?? 0));
}

/** 已降级的记录 —— 它们不再打扰，但还要进摘要。 */
export function suppressed(records: Map<string, NotifyRecord>): NotifyRecord[] {
  return [...records.values()]
    .filter((r) => r.state === 'expired')
    .sort((a, b) => b.detectedAt - a.detectedAt);
}

/** 统计各状态数量（给事件流/健康检查用）。 */
export function stateCounts(records: Map<string, NotifyRecord>): Record<NotifyState, number> {
  const out: Record<NotifyState, number> = {
    pending: 0,
    shown: 0,
    dismissed: 0,
    expired: 0,
    handled: 0,
  };
  for (const rec of records.values()) out[rec.state] += 1;
  return out;
}

/* ============================== 水位线（持久化） ============================== */

/** 水位线文件的格式。 */
export interface Watermark {
  version: 1;
  updatedAt: number;
  records: Record<string, NotifyRecord>;
}

/**
 * 读水位线。文件不存在 = 第一次运行，返回空表。
 *
 * 文件损坏时不抛错 —— 宁可丢状态（最多多弹一次）也不能让整个守护循环挂掉。
 */
export function loadWatermark(path: string): Map<string, NotifyRecord> {
  const out = new Map<string, NotifyRecord>();
  if (!existsSync(path)) return out;

  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Watermark;
    if (!raw || typeof raw !== 'object' || !raw.records) return out;
    for (const [k, v] of Object.entries(raw.records)) {
      if (v && typeof v.emailId === 'string') out.set(k, v);
    }
  } catch {
    // 坏文件 → 当空表用（下一轮会重新写一份干净的）
    return new Map();
  }
  return out;
}

/**
 * 写水位线。
 *
 * 原子写（临时文件 + rename）：守护循环随时可能被 kill，
 * 写到一半的 JSON 会让下一轮读不出来。
 */
export function saveWatermark(path: string, records: Map<string, NotifyRecord>): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const payload: Watermark = {
    version: 1,
    updatedAt: Date.now(),
    records: Object.fromEntries(records),
  };

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, path);
}

/**
 * 清理旧记录，防止文件无限膨胀。
 *
 * 保留规则（两条，顺序很重要）：
 *  1. **未到终态的记录（pending/shown/dismissed）永远保留** ——
 *     它们还没处理完，删掉等于把待处理的邮件弄丢。keepRecent 不对它们生效。
 *  2. 已终态的（handled/expired）：在 maxAgeMs 内 + 还有 keepRecent 名额 → 保留；
 *     超龄的直接删（不占名额）。
 */
export function pruneWatermark(
  records: Map<string, NotifyRecord>,
  opts: { keepRecent: number; maxAgeMs: number; now?: number },
): number {
  const now = opts.now ?? Date.now();
  const isLive = (r: NotifyRecord): boolean =>
    r.state === 'pending' || r.state === 'shown' || r.state === 'dismissed';

  // ① 未到终态的：全部保留（哪怕很老、哪怕超过 keepRecent）
  const live = [...records.values()].filter(isLive);
  const keep = new Set<string>(live.map((r) => r.emailId));

  // ② 已终态的：按时间倒序，超龄的跳过（不占名额），其余在名额内才保留
  const terminal = [...records.values()]
    .filter((r) => !isLive(r))
    .sort((a, b) => b.detectedAt - a.detectedAt);

  let budget = Math.max(0, opts.keepRecent - live.length);
  for (const r of terminal) {
    if (budget <= 0) break;
    if (now - r.detectedAt > opts.maxAgeMs) continue; // 太旧 → 直接删，不占名额
    keep.add(r.emailId);
    budget -= 1;
  }

  let removed = 0;
  for (const k of [...records.keys()]) {
    if (keep.has(k)) continue;
    records.delete(k);
    removed += 1;
  }
  return removed;
}
