/**
 * mailbox/store.ts —— ③b 邮件仓库（内存态，**不落盘**）。
 *
 * 【为什么不是 jsonl 存储】
 *   施工图原方案是"一行一封的 jsonl"，但你的要求是【原始邮件不下载到本地、只做在线分析】。
 *   所以这里改成内存索引：
 *     - 拉回来的邮件只在内存里活着 → 分析完就扔 → 磁盘上没有任何邮件正文
 *     - 去重靠内存 Map（同一封重复拉不会变成两条）
 *     - 按天查询靠内存索引
 *
 * 【这个取舍的代价（明说）】
 *   1. 进程重启 → 内存里的邮件全没了（重新拉一次即可，IMAP 不贵）
 *   2. 跨运行的幂等要靠【水位线】—— 记下"上次处理到哪个 UID"，
 *      这件事由第 ⑪ 步的 monitor 负责（它记 processed.json，不含邮件正文）。
 *   3. 想留历史快照，就显式调 saveSnapshot() 主动写 —— 默认不写。
 *
 * 【为什么不把"分类结果"也存内存】
 *   分类结果（labels）是【我们自己的结论】，不是邮件原文。
 *   但为了简单，本版也只在内存里；需要持久化时用 saveSnapshot()。
 */

import type { Email } from './types.js';
import { dateKey, DEFAULT_TIMEZONE } from './types.js';

/** 仓库的统计信息。 */
export interface MailStats {
  total: number;
  /** 按天统计：日期 → 封数 */
  byDate: Record<string, number>;
  /** 最早 / 最晚的日期 */
  earliest: string;
  latest: string;
}

export class MailStore {
  /** id → 邮件。Map 保证去重与 O(1) 查找。 */
  readonly #byId = new Map<string, Email>();
  /** 日期 → 该天的邮件 id 列表（按天查询走这里，不用每次扫全表）。 */
  readonly #byDate = new Map<string, Set<string>>();
  /** 按天分组用的时区。邮件时间是本地时间，分组必须跟着用户时区走。 */
  readonly #tz: string;

  constructor(timeZone: string = DEFAULT_TIMEZONE) {
    this.#tz = timeZone;
  }

  /**
   * 收进一批邮件。
   * @returns 实际新增的条数（已存在的不算）
   */
  upsert(list: Email[]): number {
    let added = 0;
    for (const mail of list) {
      if (this.#byId.has(mail.id)) continue; // 已处理过 → 跳过（这就是去重）
      this.#byId.set(mail.id, mail);

      const key = dateKey(mail.date, this.#tz);
      if (key) {
        let bucket = this.#byDate.get(key);
        if (!bucket) {
          bucket = new Set<string>();
          this.#byDate.set(key, bucket);
        }
        bucket.add(mail.id);
      }
      added += 1;
    }
    return added;
  }

  /** 按 id 取一封。 */
  get(id: string): Email | undefined {
    return this.#byId.get(id);
  }

  /** 全部邮件（按日期升序）。 */
  all(): Email[] {
    return [...this.#byId.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * 按天查询。
   * @param date 'YYYY-MM-DD'
   */
  emailsOn(date: string): Email[] {
    const bucket = this.#byDate.get(date);
    if (!bucket) return [];
    const out: Email[] = [];
    for (const id of bucket) {
      const mail = this.#byId.get(id);
      if (mail) out.push(mail);
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  /** 有邮件的所有日期，降序（最近的在前）。 */
  dates(): string[] {
    return [...this.#byDate.keys()].sort((a, b) => b.localeCompare(a));
  }

  /** 统计信息。 */
  stats(): MailStats {
    const dates = this.dates();
    const byDate: Record<string, number> = {};
    for (const [d, ids] of this.#byDate) byDate[d] = ids.size;
    return {
      total: this.#byId.size,
      byDate,
      earliest: dates.length ? dates[dates.length - 1] : '',
      latest: dates.length ? dates[0] : '',
    };
  }

  /** 清空（内存态，free）。 */
  clear(): void {
    this.#byId.clear();
    this.#byDate.clear();
  }

  get size(): number {
    return this.#byId.size;
  }

  /**
   * 主动写一份快照到磁盘（**默认不调用**）。
   * 只在你明确说"我要留档"时才用 —— 默认路径下磁盘上没有邮件内容。
   */
  async saveSnapshot(file: string): Promise<number> {
    const { writeFile } = await import('node:fs/promises');
    const lines = this.all().map((m) => JSON.stringify(m)).join('\n');
    await writeFile(file, lines + (lines ? '\n' : ''), 'utf8');
    return this.#byId.size;
  }
}
