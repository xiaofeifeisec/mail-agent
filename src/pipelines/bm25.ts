

import { tokenize } from '../textproc/tokenize.js';
import type { Email } from '../mailbox/types.js';
import { MAX_BODY_CHARS } from '../mailbox/types.js';

/* ============================ 参数与结果 ============================ */

/** BM25 默认参数（施工图规格：k1=1.5, b=0.75）。 */
export const DEFAULT_K1 = 1.5;
export const DEFAULT_B = 0.75;

/**
 * 主题加权次数。
 *
 * 【为什么要加权】
 *   邮件主题是人写的摘要，正文是模板 + 寒暄 + 落款。
 *   "支付网关TLS迁移" 出现在主题里，比出现在正文里的意义大得多。
 *   做法很简单：主题里的 token 在 tf 里多算几次（默认 2 次）。
 */
export const DEFAULT_SUBJECT_BOOST = 2;

export interface BM25Options {
  /** 词频饱和系数，默认 1.5。 */
  readonly k1?: number;
  /** 长度归一系数，默认 0.75。 */
  readonly b?: number;
  /** 主题里的词算几次，默认 2。 */
  readonly subjectBoost?: number;
  /** 参与索引的正文最大字符数，默认 20000（等于 Email.body 的上限）。 */
  readonly maxBodyChars?: number;
}

/** 一条检索结果。 */
export interface Bm25Hit {
  /** 邮件 id（Email.id）。 */
  readonly id: string;
  /** BM25 得分。越大越相关。 */
  readonly score: number;
}


function indexTokens(text: string): string[] {
  if (!text) return [];
  return tokenize(text).filter((t) => t.length >= 2);
}


export class BM25Index {
  private readonly k1: number;
  private readonly b: number;
  private readonly subjectBoost: number;
  private readonly maxBodyChars: number;

  /** docIndex → 邮件 id */
  private docIds: string[] = [];
  /** docIndex → 文档长度（token 数） */
  private docLengths: number[] = [];
  /** term → (docIndex → tf) */
  private postings = new Map<string, Map<number, number>>();
  /** 所有文档的平均长度 */
  private avgLen = 0;

  constructor(options: BM25Options = {}) {
    this.k1 = options.k1 ?? DEFAULT_K1;
    this.b = options.b ?? DEFAULT_B;
    this.subjectBoost = options.subjectBoost ?? DEFAULT_SUBJECT_BOOST;
    this.maxBodyChars = options.maxBodyChars ?? MAX_BODY_CHARS;
  }

  /** 已索引的文档数。 */
  get size(): number {
    return this.docIds.length;
  }

  /** 索引里出现的不同词数。 */
  get vocabularySize(): number {
    return this.postings.size;
  }

  /** 平均文档长度（token 数）。 */
  get avgDocLength(): number {
    return this.avgLen;
  }

  /**
   * 建索引。
   *
   * 【每次调用都是"重建"，不是"追加"】
   *   邮件是整批换的（重新抓一次就是新的一批），追加会让旧邮件留在索引里、
   *   搜出已经不存在的 id。所以直接清空重来 —— 几十毫秒的事。
   *
   * @returns this —— 方便链式调用
   */
  build(emails: Email[]): this {
    this.reset();

    let totalLength = 0;

    emails.forEach((email, docIndex) => {
      const tokens = this.documentTokens(email);
      this.docIds.push(email.id);
      this.docLengths.push(tokens.length);
      totalLength += tokens.length;

      // 先在本文档内统计 tf
      const tf = new Map<string, number>();
      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }
      // 再挂到倒排索引上
      for (const [term, count] of tf) {
        let posting = this.postings.get(term);
        if (!posting) {
          posting = new Map<number, number>();
          this.postings.set(term, posting);
        }
        posting.set(docIndex, count);
      }
    });

    this.avgLen = emails.length > 0 ? totalLength / emails.length : 0;
    return this;
  }

  /**
   * 检索。
   *
   * @param query 查询串。会被切成 token；空查询返回空数组。
   * @param k     最多返回几条。k <= 0 返回空数组。
   * @returns 按分数降序排列的命中列表；同分按 id 字典序升序（保证结果稳定可测）。
   */
  search(query: string, k = 10): Bm25Hit[] {
    if (k <= 0) return [];
    if (this.docIds.length === 0) return [];

    const terms = [...new Set(indexTokens(query))];
    if (terms.length === 0) return [];

    const N = this.docIds.length;
    const scores = new Map<number, number>();

    for (const term of terms) {
      const posting = this.postings.get(term);
      if (!posting) continue; // 这个词不在任何文档里 → 跳过

      const idf = this.idfOf(posting.size, N);

      for (const [docIndex, tf] of posting) {
        const dl = this.docLengths[docIndex];
        const norm = this.k1 * (1 - this.b + this.b * (dl / this.avgDocLength));
        const contribution = idf * ((tf * (this.k1 + 1)) / (tf + norm));
        scores.set(docIndex, (scores.get(docIndex) ?? 0) + contribution);
      }
    }

    const hits: Bm25Hit[] = [];
    for (const [docIndex, score] of scores) {
      hits.push({ id: this.docIds[docIndex], score });
    }

    // 分数降序；同分按 id 字典序升序 —— 同分时不能依赖 Map 的插入顺序，
    // 否则同样的语料换个建库顺序结果就变了，测试就没法写。
    hits.sort((a, b) => {
      const diff = b.score - a.score;
      if (Math.abs(diff) > 1e-12) return diff;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    return hits.slice(0, k);
  }

  /* ============================ 内部 ============================ */

  private reset(): void {
    this.docIds = [];
    this.docLengths = [];
    this.postings = new Map<string, Map<number, number>>();
    this.avgLen = 0;
  }

  /**
   * 把一封邮件切成 token 序列（主题加权已算进去）。
   */
  private documentTokens(email: Email): string[] {
    const subject = indexTokens(email.subject);
    const body = indexTokens(email.body.slice(0, this.maxBodyChars));

    const tokens: string[] = [];
    for (let i = 0; i < this.subjectBoost; i++) {
      tokens.push(...subject);
    }
    tokens.push(...body);
    return tokens;
  }

  /**
   * IDF（Lucene 版）：ln((N−nt+0.5)/(nt+0.5)) + 1
   *
   * @param nt 包含该词的文档数
   * @param N  语料总文档数
   *
   * 【为什么要再 clamp 一次】
   *   施工图写的是 "+1 防负分"，但 +1 并不总能防住：
   *   N=1, nt=1 时 ln(0.333)+1 = −0.0986；N=5, nt=5 时 ln(0.0909)+1 = −1.398。
   *   也就是说"这个词出现在几乎所有文档里"时 IDF 仍是负的。
   *   负 IDF 会让命中该词的文档【分数低于没命中的文档】—— 排序直接颠倒。
   *   所以这里额外 clamp 到 0，与施工图的意图一致（"+1 防负分"）。
   */
  private idfOf(nt: number, N: number): number {
    const idf = Math.log((N - nt + 0.5) / (nt + 0.5)) + 1;
    return idf > 0 ? idf : 0;
  }
}
