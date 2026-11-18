/**
 * monitor/monitor.ts —— ⑪ 后台守护循环（把「你点才动」变成「新邮件自己处理」）。
 *
 * 【分工】
 *   state.ts    = 纯函数状态机（要不要弹、弹几次、什么时候降级）
 *   monitor.ts  = 驱动器（定时拉邮件 → 分类 → 问状态机 → 把决策交给通知出口）
 *   通知出口（onAlert）由调用方注入 —— 这里不碰 HTTP、不碰 SSE、不碰浏览器。
 *
 * 【为什么不在模块顶层 import web/server】
 *   会造成循环依赖：server 要启动 monitor，monitor 又要读 server 的 SESSION。
 *   所以这里只认「依赖注入」：给什么函数就用什么函数，web 层把 SESSION 包成闭包传进来。
 *
 * 【为什么单实例】
 *   decideNotify 的冷却期是【全局】的（latestShownAt 扫全部记录）。
 *   同时跑两个 monitor 会各算各的、互相不知道对方弹过 → 同一批邮件弹两次。
 *   startMonitor 内部有单例保护，重复调用直接返回已有实例。
 */

import {
  createRecord,
  decideNotify,
  markShown,
  tick,
  pruneWatermark,
  loadWatermark,
  saveWatermark,
  DEFAULT_NOTIFY_OPTIONS,
  type NotifyRecord,
  type NotifyOptions,
} from './state.js';
import type { Email } from '../mailbox/types.js';
import type { Config } from '../config.js';

/** 一条通知决策的输出（交给前端弹窗 / 系统通知）。 */
export interface AlertEvent {
  emailId: string;
  subject: string;
  from: string;
  category: string;
  reason: string;
  at: number;
  uid?: number;
}

/** 驱动循环需要的外部能力，全部注入。 */
export interface MonitorDeps {
  cfg: Config;
  /** 拉新邮件。调用方决定增量策略（since 水位），这里只管消费结果。 */
  fetchNew: () => Promise<Email[]>;
  /** 分类。返回每个 id 的类别；失败时调用方应返回空 Map（当 unknown 处理）。 */
  classify: (mails: Email[]) => Promise<Map<string, string>>;
  /** 通知出口。只有 decideNotify 判定要弹时才会调用。 */
  onAlert: (event: AlertEvent) => void | Promise<void>;
  /** 水位线文件（只存通知记录，不存邮件正文） */
  watermarkPath: string;
  /** 轮询间隔，默认 60 秒 */
  intervalMs?: number;
  /** 注入时钟（测试用） */
  now?: () => number;
}

export interface MonitorHandle {
  /** 立即跑一轮（不等定时器；也用于测试） */
  runOnce(): Promise<AlertEvent[]>;
  stop(): void;
  /** 当前状态快照（供 /api/monitor/status 展示） */
  snapshot(): { running: boolean; records: number; active: number; lastRunAt: number };
}

let singleton: MonitorHandle | null = null;

function optsFromCfg(cfg: Config): NotifyOptions {
  return {
    popupTtlMs: cfg.popupTtlMs,
    escalateAfterMs: cfg.escalateAfterMs,
    cooldownMs: cfg.notifyCooldownMs,
    maxRepeat: cfg.notifyMaxRepeat,
  };
}

/**
 * 建（或取）守护循环。
 * 重复调用不会起第二个定时器 —— 这是"全局冷却期"语义正确性的前提。
 */
export function startMonitor(deps: MonitorDeps): MonitorHandle {
  if (singleton) return singleton;

  const records: Map<string, NotifyRecord> = loadWatermark(deps.watermarkPath);
  const opts = optsFromCfg(deps.cfg);
  const now = deps.now ?? (() => Date.now());
  const intervalMs = deps.intervalMs ?? 60_000;
  let running = false;
  let lastRunAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function runOnce(): Promise<AlertEvent[]> {
    // 防止上一轮还没跑完就又来一轮（慢邮箱 + 短间隔时会叠在一起）
    if (running) return [];
    running = true;
    const alerts: AlertEvent[] = [];
    try {
      const t = now();
      tick(records, t);

      let mails: Email[] = [];
      try {
        mails = await deps.fetchNew();
      } catch {
        // 拉取失败（网络抖动 / 授权码过期）不该杀掉循环，下一轮再试
        return alerts;
      }
      if (mails.length === 0) {
        lastRunAt = now();
        return alerts;
      }

      const cats = await deps.classify(mails);
      for (const mail of mails) {
        const category = cats.get(mail.id) ?? (mail.labels.includes('urgent') ? 'urgent' : 'normal');
        if (!records.has(mail.id)) {
          records.set(
            mail.id,
            createRecord(
              {
                emailId: mail.id,
                uid: Number(mail.meta.uid ?? 0) || undefined,
                category,
                subject: mail.subject,
                from: mail.sender,
              },
              now(),
            ),
          );
        }
        const decision = decideNotify(records, mail.id, category, opts, now());
        if (!decision.notify) continue;

        const rec = records.get(mail.id);
        if (rec) markShown(rec, now(), opts);
        const event: AlertEvent = {
          emailId: mail.id,
          subject: mail.subject,
          from: mail.sender,
          category,
          reason: decision.reason,
          at: now(),
          uid: Number(mail.meta.uid ?? 0) || undefined,
        };
        alerts.push(event);
        try {
          await deps.onAlert(event);
        } catch {
          // 通知出口失败不影响状态机（已经标记 shown，不会重复弹）
        }
      }

      pruneWatermark(records, { keepRecent: 200, maxAgeMs: 7 * 86_400_000, now: now() });
      saveWatermark(deps.watermarkPath, records);
      lastRunAt = now();
    } finally {
      running = false;
    }
    return alerts;
  }

  singleton = {
    runOnce,
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      singleton = null;
    },
    snapshot() {
      return {
        running,
        records: records.size,
        active: [...records.values()].filter((r) => r.state === 'shown').length,
        lastRunAt,
      };
    },
  };

  // 定时器启动后立即跑一轮？不 —— 启动时用户可能还没拉邮件，
  // 第一轮交给 interval 到点再跑，避免和「拉取邮件」抢 IMAP 连接。
  timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  // 不阻塞进程退出
  if (typeof timer.unref === 'function') timer.unref();

  return singleton;
}

/** 测试用：重置单例（不要在生产调用） */
export function resetMonitorForTest(): void {
  singleton?.stop();
  singleton = null;
}

export { DEFAULT_NOTIFY_OPTIONS };
