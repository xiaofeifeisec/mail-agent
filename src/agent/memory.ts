/**
 * agent/memory.ts —— ⑨e 跨会话记忆。
 *
 * 【它解决什么问题】
 *   Agent 每次启动都是白纸。用户上周说过"我偏好简短回复"、
 *   "李雷是我组长"，这次还得再说一遍。
 *   记忆就是让这些"关于用户的事"跨会话留下来。
 *
 * 【两个工具】
 *   remember(content) —— 记一条
 *   recall(query)     —— 检索
 *
 * 【为什么用 BM25 而不是向量检索】
 *   记忆量很小（几十条），而且内容是我们自己写的短句。
 *   ⑤ 的 BM25 已经在项目里了，直接复用它：
 *   不需要额外的 embedding API、不花钱、不联网。
 *   这跟 ⑧ qa.ts 的选择是同一个理由。
 *
 * 【关键设计：新会话注入的是"索引"，不是全文】
 *   如果把所有记忆全文塞进 system prompt：
 *     ① 撑爆上下文预算（每条 100 字 × 50 条 = 5000 字，还没开始干活就花掉一大截）
 *     ② 大部分记忆这次根本用不上，白占注意力
 *   所以只注入【每条前 40 字】的索引 —— 模型知道"有什么"就够了，
 *   需要哪条它会自己调 recall。
 *
 * 【为什么不落盘到 data/ 而是单独文件】
 *   记忆和邮件是两种东西：邮件是"输入数据"，记忆是"Agent 的状态"。
 *   混在一起会让 data/ 目录的语义变模糊，也不方便单独备份/清空。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

import { BM25Index } from '../pipelines/bm25.js';
import type { Email } from '../mailbox/types.js';

/** 一条记忆。 */
export interface MemoryItem {
  /** 短 id（给模型引用/给日志看）。 */
  id: string;
  /** 内容全文。 */
  content: string;
  /** 写入时间（ISO）。 */
  ts: string;
  /** 来源标签，比如 'qa' / 'manual' —— 排查"这条哪来的"用。 */
  source?: string;
}

/** 注入索引时每条截多少字。 */
export const INDEX_CHARS = 40;

/** 最多注入多少条索引。 */
export const INDEX_LIMIT = 20;

/** 最多存多少条（超了淘汰最旧的）。 */
export const MAX_ITEMS = 200;

/**
 * 记忆库。
 *
 * 【为什么构造时不读盘】
 *   测试里要能造一个"不落盘"的记忆库（传 file=null）。
 *   构造即读盘的话，测试会互相污染。
 */
export class Memory {
  readonly #file: string | null;
  #items: MemoryItem[] = [];
  #loaded = false;

  /**
   * @param file JSON 文件路径。传 null = 纯内存（测试用）
   */
  constructor(file: string | null) {
    this.#file = file;
  }

  /** 从磁盘加载（幂等）。 */
  load(): this {
    if (this.#loaded) return this;
    this.#loaded = true;
    if (!this.#file || !existsSync(this.#file)) return this;
    try {
      const raw = readFileSync(this.#file, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        // 只保留形状对得上的项 —— 手改坏了不至于让整个 agent 起不来
        this.#items = arr.filter(
          (x): x is MemoryItem =>
            !!x && typeof x === 'object' && typeof x.id === 'string' && typeof x.content === 'string',
        );
      }
    } catch (e) {
      // 【不抛】记忆文件坏了不该让 agent 起不来。空着继续跑，下次保存会覆盖。
      console.warn('[memory] 读取记忆失败，当作空的继续：', e);
      this.#items = [];
    }
    return this;
  }

  /** 存盘。 */
  save(): void {
    if (!this.#file) return;
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      writeFileSync(this.#file, JSON.stringify(this.#items, null, 2), 'utf8');
    } catch (e) {
      console.warn('[memory] 保存记忆失败：', e);
    }
  }

  /** 全部记忆（按时间倒序，新的在前）。 */
  all(): MemoryItem[] {
    this.load();
    return [...this.#items];
  }

  /**
   * 记一条。
   *
   * @returns 给模型看的反馈文本
   */
  remember(content: string, source = 'agent'): string {
    this.load();
    const text = String(content ?? '').trim();
    if (!text) return '记忆内容为空，没有保存';

    // 去重：完全一样的就别重复记（模型有时会反复 remember 同一件事）
    const dup = this.#items.find((i) => i.content === text);
    if (dup) return `这条已经记过了（id=${dup.id}），没有重复保存`;

    const item: MemoryItem = {
      id: randomBytes(4).toString('hex'),
      content: text.slice(0, 1000),
      ts: new Date().toISOString(),
      source,
    };
    this.#items.unshift(item);

    // 超上限就裁掉最旧的（数组尾部）
    if (this.#items.length > MAX_ITEMS) {
      this.#items = this.#items.slice(0, MAX_ITEMS);
    }

    this.save();
    return `已记住（id=${item.id}）`;
  }

  /**
   * 检索记忆。
   *
   * 【为什么复用 BM25】
   *   记忆是小语料（几十条短句），词面匹配足够。
   *   而且 BM25 已经在项目里 —— 不引 embedding、不联网、不花钱。
   */
  recall(query: string, k = 5): MemoryItem[] {
    this.load();
    const q = String(query ?? '').trim();
    if (!q || this.#items.length === 0) return [];

    // BM25 要 Email[] 形状的东西 —— 这里做一次轻量适配。
    // 只用 id + body 两个字段，其余填空值（BM25 不读它们）。
    const fake: Email[] = this.#items.map((i) => ({
      id: i.id,
      subject: '',
      sender: '',
      to: [],
      date: i.ts,
      body: i.content,
      labels: [],
      meta: {},
    }));

    const idx = new BM25Index().build(fake);
    const hits = idx.search(q, k);
    const byId = new Map(this.#items.map((i) => [i.id, i]));
    return hits.map((h) => byId.get(h.id)).filter((x): x is MemoryItem => !!x);
  }

  /**
   * 生成注入 system prompt 的索引文本。
   *
   * 【每条只取前 40 字】
   *   见文件头的解释：注入全文会撑爆预算、白占注意力。
   */
  indexText(): string {
    this.load();
    if (this.#items.length === 0) return '';

    const lines = this.#items.slice(0, INDEX_LIMIT).map((i) => {
      const head = i.content.replace(/\s+/g, ' ').slice(0, INDEX_CHARS);
      const more = i.content.length > INDEX_CHARS ? '…' : '';
      return `- id=${i.id} ${head}${more}`;
    });

    const extra =
      this.#items.length > INDEX_LIMIT
        ? `\n（还有 ${this.#items.length - INDEX_LIMIT} 条更早的记忆，需要时用 recall 检索）`
        : '';

    return `【我记住的关于你的事】\n${lines.join('\n')}${extra}\n（需要细节就用 recall 查）`;
  }

  /** 清空（调试用）。 */
  clear(): void {
    this.#items = [];
    this.#loaded = true;
    this.save();
  }

  /** 条数。 */
  get size(): number {
    this.load();
    return this.#items.length;
  }
}

/** 默认记忆文件路径。 */
export function defaultMemoryPath(root: string): string {
  return join(root, 'data', 'agent-memory.json');
}
