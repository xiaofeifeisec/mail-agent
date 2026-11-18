import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/* ============================== 类型 ============================== */

/**
 * 本模块需要的最小配置。
 * 刻意在 client.ts 里自己定义 —— 这样这个文件是自包含的，
 * 单独拿走就能用；项目根的 config.ts 只要产出一个满足这个形状的对象即可
 * （TS 的结构化类型允许多余字段，所以以后 config.ts 加字段不用回来改这里）。
 */
export interface LLMConfig {
  /** OpenAI 兼容接口的基地址，例如 http://127.0.0.1:8787/v1 */
  llmBaseUrl: string;
  /** Bearer key */
  llmApiKey: string;
  /** 模型名 */
  llmModel: string;
  /** 预算上限（美元）。<= 0 表示不限。 */
  budgetUsd: number;
  /** 单次请求超时（毫秒） */
  requestTimeoutMs: number;
  /** 缓存与账本的落盘目录 */
  cacheDir: string;
  /**
   * 缓存隔离域（可选，默认 ''）。
   *
   * 为什么需要它：缓存 key 只由「模型 + 温度 + 消息」构成。
   * 如果你同时接了多家厂商，而两家的模型**同名**（都叫 gpt-4o-mini），
   * 那么 A 厂商的回复会被当成 B 厂商的缓存命中 —— 拿到错的结果。
   * 所以 key 里必须带上"这是谁的缓存"。
   * 用法：厂商 id（openai / deepseek / local…）。同一家的不同账号也建议用不同 scope。
   */
  scope?: string;
  /**
   * system 送达方式（可选，默认 'inline'）。
   * 按厂商配：本机网关要 'top'，多数 OpenAI 兼容中转站要 'inline'，不确定就用 'both'。
   */
  systemDelivery?: SystemDelivery;
}

/**
 * system 消息的送达方式 —— 因为**网关之间在这件事上是不统一的**。
 *
 * - 'inline'：放在 messages 数组里（{"role":"system","content":...}）。
 *   OpenAI 官方、绝大多数 OpenAI 兼容中转站、DeepSeek、智谱都认这种。
 * - 'top'：放在请求体顶层 system 字段。Anthropic 原生协议要求这样
 *   （它的 messages 里不允许出现 role:system）。
 * - 'both'：两个地方都放。给"不确定的中转站"兜底 —— 代价是模型可能看到两遍规则。
 *
 * 【实测踩过的坑】
 *   本机网关（OpenAI→Anthropic 转换）会丢 role:system → 需要 'top' 或 'both'
 *   8888ok.cc 这类中转站会丢顶层 system      → 需要 'inline' 或 'both'
 *   所以它不能写死，必须按厂商配。
 */
export type SystemDelivery = 'inline' | 'top' | 'both';

export type ChatRole = 'system' | 'user' | 'assistant';

/** 一条对话消息。故意只保留 role/content 两个字段：这就是我们送给模型的全部。 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** complete() 的可选参数。传数字是 temperature 的简写（与 Python 版 lm(msgs, 0.0) 等价）。 */
export interface CompleteOptions {
  temperature?: number;
  maxTokens?: number;
  /** 覆盖构造时的 tag，用于把同一次调用记到不同用途上。 */
  tag?: string;
  /** 本次跳过缓存（强制真实调用）。 */
  noCache?: boolean;
  /** 调用方的取消信号。 */
  signal?: AbortSignal;
  /**
   * 这次调用用哪种 system 送达方式，覆盖实例默认值。
   * 临时遇到"网关不听规则"时，可以单次试另一种写法。
   */
  systemDelivery?: SystemDelivery;
}

/** LM 构造参数。tagOrOpts 传字符串时等价于 { tag }，方便 `new LM(cfg, 'classify')`。 */
export interface LMOptions {
  /** 覆盖 cfg.llmModel（摘要这类活儿用便宜模型）。 */
  model?: string;
  /** 花费归类标签，`run.ts llm-stats` 按它汇总。 */
  tag?: string;
  /** 注入假 fetch（测试用）。生产代码不要传。 */
  fetchImpl?: typeof fetch;
  /** 最大尝试次数（含第一次）。默认 3。 */
  maxAttempts?: number;
  /** 退避基数（毫秒）。默认 1000 → 1s / 2s / 4s。 */
  retryBaseDelayMs?: number;
  /** 退避上限（毫秒）。默认 8000。 */
  retryMaxDelayMs?: number;
  /** 单次请求超时（毫秒）。默认取 cfg.requestTimeoutMs。 */
  timeoutMs?: number;
  /** 构造后默认不写缓存（少数特殊场景用）。 */
  noCache?: boolean;
  /**
   * 覆盖配置里的 system 送达方式（inline / top / both）。
   * 临时遇到"网关不吃规则"时可以单次调用改一下试。
   */
  systemDelivery?: SystemDelivery;
}

/**
 * 账本一行。字段名故意用 snake_case —— 和 Python 版 ledger.jsonl 完全同构，
 * 两个版本的账本可以互相读，也方便用 grep/jq 直接查。
 */
export interface LedgerRecord {
  ts: string;
  model: string;
  tag: string;
  in_tok: number;
  out_tok: number;
  cost: number;
  cached: boolean;
  latency_ms: number;
  attempt: number;
}

/** 缓存条目。 */
interface CacheEntry {
  reply: string;
  ts: string;
  model?: string;
}

/* ============================== 常量 ============================== */

/** 默认温度。分类/抽取这类要稳定的地方请显式传 0。 */
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 8000;
/** 预算预估用的"输出 token 标称值"：真实输出事前未知，用一个保守常量顶。 */
const NOMINAL_OUTPUT_TOKENS = 200;
/** 可重试的 HTTP 状态码：限流 + 网关/服务抖动。4xx 其它一律不重试（重试也不会变好）。 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const CACHE_FILE = 'llm-cache.json';
const LEDGER_FILE = 'ledger.jsonl';

/**
 * 粗略计价（美元 / 百万 token）。只用于预算控制，不是精确账单。
 * 本机网关 / 免费模型填 0 —— 记账变成"纯净度仪表"，不再花钱。
 */
export const PRICES: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'deepseek-chat': { input: 0.14, output: 0.28 },
  'glm-4-flash': { input: 0, output: 0 },
  'glm-4.5-flash': { input: 0, output: 0 },
};
export const DEFAULT_PRICE = { input: 1.0, output: 3.0 };

/* ============================== 异常 ============================== */

/** 预算烧完。调用方应当捕获并停止整条管线，而不是继续重试。 */
export class BudgetExceeded extends Error {
  constructor(
    message: string,
    readonly spent: number,
    readonly budget: number,
  ) {
    super(message);
    this.name = 'BudgetExceeded';
  }
}

/** 模型侧或传输层的硬错误（非重试型 HTTP 错误、重试用尽、响应格式不对）。 */
export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/* ============================ 纯函数工具 ============================ */

/**
 * 粗估 token 数：中文 1 字 ≈ 1 token，英文/符号 4 字符 ≈ 1 token。
 * 比 Python 版的 len//3 精确一点 —— 混合中文邮件里 len//3 会明显低估。
 * 精确计数要装 tiktoken，这里刻意不装：估算只用于预算，够用即可。
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.max(1, Math.ceil(cjk + rest / 4));
}

/**
 * 估算一段对话的 token 数。
 * 每条消息额外 +4 token（role 标记 + 分隔符），这是经验值。
 */
export function countMessageTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += countTokens(m.content) + 4;
  return total;
}

/** 按模型价目表算钱（美元）。 */
export function estimateCost(model: string, inTok: number, outTok: number): number {
  const price = PRICES[model] ?? DEFAULT_PRICE;
  return (inTok * price.input + outTok * price.output) / 1_000_000;
}

/**
 * 缓存 key = sha256(模型 + 温度 + 完整消息)。
 * 用稳定序列化（递归排序 key）而不是 JSON.stringify：
 * 否则 {"role","content"} 和 {"content","role"} 会算出两个不同 key，白白多花一次钱。
 */
export function cacheKey(
  model: string,
  temperature: number,
  messages: ChatMessage[],
  scope = '',
): string {
  const blob = stableStringify({ scope, model, temperature, messages });
  return createHash('sha256').update(blob, 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * 把 system 消息摘出来，剩下的是普通对话。
 * 为什么：Anthropic 原生协议里 system 是顶层字段，不是消息；
 * 而部分网关在 OpenAI→Anthropic 转换时会把 {"role":"system"} 直接丢掉。
 * 两边都兼容的写法就是：顶层 system 字段 + messages 里不出现 system。
 * OpenAI 官方接口对多余的顶层字段是宽容的。
 */
/**
 * 把 system 消息摘出来，按送达方式组装成请求体。
 *
 * 为什么：Anthropic 原生协议里 system 是顶层字段，不是消息；
 * 而部分网关在 OpenAI→Anthropic 转换时会把 {"role":"system"} 直接丢掉。
 * 另一边，OpenAI 系的服务可能反过来丢顶层 system 字段 —— 所以要可配。
 */
function buildPayloadMessages(
  messages: ChatMessage[],
  mode: SystemDelivery,
): { messages: ChatMessage[]; system?: string } {
  const sysParts: string[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') sysParts.push(m.content);
    else rest.push(m);
  }
  const system = sysParts.join('\n\n');
  if (!system) return { messages: rest };

  if (mode === 'inline') {
    return { messages: [{ role: 'system', content: system }, ...rest] };
  }
  if (mode === 'top') {
    return { messages: rest, system };
  }
  return { messages: [{ role: 'system', content: system }, ...rest], system };
}

/** 从各种可能的响应格式里挖出文本（OpenAI 兼容是主路，另两条兜底）。 */
function extractText(data: unknown): string {
  const choice = (data as any)?.choices?.[0];
  let text = choice?.message?.content;
  if (Array.isArray(text)) {
    // 少数网关把 content 拆成 [{type:'text', text:'...'}] 数组
    text = text.map((part: any) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('');
  }
  if (typeof text !== 'string' || text.length === 0) {
    const alt = choice?.text; // 老式 completions 接口
    if (typeof alt === 'string') text = alt;
  }
  if (typeof text !== 'string') {
    throw new LLMError('响应里没有 choices[0].message.content（网关可能返回了非 OpenAI 格式）');
  }
  return text;
}

/** 拿真实 token 数；网关不给 usage 就返回 0，由调用方回落到估算值。 */
function extractUsage(data: unknown): { inTok: number; outTok: number } {
  const usage = (data as any)?.usage;
  return {
    inTok: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
    outTok: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0,
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

const sleep = (ms: number): Promise<void> =>
  // 注意：这里【不能】用 setTimeout(...).unref()。
  // unref 会让这个计时器不再"拉住"事件循环，退避等待期间进程可能提前退出，
  // 表现为 node:test 报 "Promise resolution is still pending but the event loop has already resolved"。
  // 重试等待期间进程必须活着，所以就让计时器正常计时。
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/* ============================ 文件层小工具 ============================ */

/** 文件级锁：同一路径的写操作串行化，避免两个 LM 实例互相覆盖缓存。 */
const fileLocks = new Map<string, Promise<void>>();

function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(file) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const gate = run.then(
    () => undefined,
    () => undefined,
  );
  fileLocks.set(file, gate);
  gate.then(() => {
    if (fileLocks.get(file) === gate) fileLocks.delete(file);
  });
  return run;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * 原子写：先写临时文件，再 rename 覆盖。
 * rename 在同一文件系统内是原子操作 —— 断电/崩溃时要么是旧文件，要么是新文件，不会是半个 JSON。
 */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, file);
}

/* ============================== 主类 ============================== */

/**
 * LM —— LLM 客户端。整个项目只应该 new 这一个东西（可以按 tag 多 new 几个用于分账）。
 *
 * 用法：
 *   const lm = new LM(cfg, 'classify');
 *   const text = await lm.complete([
 *     { role: 'system', content: '你是邮件分类器……' },
 *     { role: 'user', content: emailBody },
 *   ], 0);                                  // 0 = temperature，分类要稳定
 */
export class LM {
  readonly #cfg: LLMConfig;
  readonly #model: string;
  readonly #tag: string;
  readonly #fetch: typeof fetch;
  readonly #maxAttempts: number;
  readonly #retryBaseDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #timeoutMs: number;
  readonly #defaultNoCache: boolean;
  readonly #systemDelivery: SystemDelivery;

  /** 内存里的缓存索引：key → { reply } */
  readonly #cache = new Map<string, CacheEntry>();
  #loaded = false;
  /** 已花费（美元），从账本初始化，之后只增不减 */
  #spent = 0;
  #hits = 0;
  #calls = 0;

  constructor(cfg: LLMConfig, tagOrOpts: string | LMOptions = '') {
    const opts: LMOptions = typeof tagOrOpts === 'string' ? { tag: tagOrOpts } : tagOrOpts;
    this.#cfg = cfg;
    this.#model = opts.model ?? cfg.llmModel;
    this.#tag = opts.tag ?? '';
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
    this.#maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#retryBaseDelayMs = opts.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.#retryMaxDelayMs = opts.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.#timeoutMs = opts.timeoutMs ?? cfg.requestTimeoutMs;
    this.#defaultNoCache = opts.noCache ?? false;
    this.#systemDelivery = opts.systemDelivery ?? cfg.systemDelivery ?? 'inline';

    if (typeof this.#fetch !== 'function') {
      throw new Error('LM: 环境里没有 fetch（需要 Node >= 18）');
    }
  }

  /* ---------- 只读状态（给 CLI 展示用，不算"原语"）---------- */
  get model(): string {
    return this.#model;
  }
  get tag(): string {
    return this.#tag;
  }
  get spentUsd(): number {
    return this.#spent;
  }
  get hitCount(): number {
    return this.#hits;
  }
  get callCount(): number {
    return this.#calls;
  }

  /**
   * 【唯一的原语】发一轮对话，拿回一段文本。
   *
   * @param messages  依次为 system / user / assistant。system 会被提到请求体顶层。
   * @param options   数字 = temperature；或传对象（temperature/maxTokens/tag/noCache/signal）。
   * @returns         模型回复文本（纯字符串，不做解析 —— 解析是上层的事）。
   *
   * 失败语义：
   *   - 预算不够 → 抛 BudgetExceeded（不会白白调用一次）
   *   - 4xx 之类不可重试 → 抛 LLMError
   *   - 429/5xx/网络抖动重试用尽 → 抛 LLMError
   */
  async complete(messages: ChatMessage[], options: number | CompleteOptions = {}): Promise<string> {
    const opts: CompleteOptions = typeof options === 'number' ? { temperature: options } : options;
    const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
    const tag = opts.tag ?? this.#tag;
    const useCache = !(opts.noCache ?? this.#defaultNoCache);

    await this.#ensureLoaded();

    // ---------- 1) 缓存 ----------
    // scope 参与 key：多厂商同名模型不会串缓存
    const key = cacheKey(this.#model, temperature, messages, this.#cfg.scope ?? '');
    if (useCache) {
      const hit = this.#cache.get(key);
      if (hit) {
        this.#hits += 1;
        // 命中也写账本：cost=0、cached=true —— 让"省了多少钱"在账本上看得见
        const inTok = countMessageTokens(messages);
        const outTok = countTokens(hit.reply);
        await this.#appendLedger({
          ts: new Date().toISOString(),
          model: this.#model,
          tag,
          in_tok: inTok,
          out_tok: outTok,
          cost: 0,
          cached: true,
          latency_ms: 0,
          attempt: 0,
        });
        return hit.reply;
      }
    }

    // ---------- 2) 预算闸门（在花钱之前拦）----------
    this.#assertBudget(messages);

    // ---------- 3) 真实调用（内部含重试）----------
    const { text, usage, latencyMs, attempts } = await this.#callApi(messages, temperature, opts);

    // ---------- 4) 记账 ----------
    // 优先用网关返回的真实 usage，没有才用估算值。
    const inTok = usage.inTok > 0 ? usage.inTok : countMessageTokens(messages);
    const outTok = usage.outTok > 0 ? usage.outTok : countTokens(text);
    const cost = estimateCost(this.#model, inTok, outTok);
    this.#spent += cost;
    this.#calls += 1;
    await this.#appendLedger({
      ts: new Date().toISOString(),
      model: this.#model,
      tag,
      in_tok: inTok,
      out_tok: outTok,
      cost: Number(cost.toFixed(6)),
      cached: false,
      latency_ms: latencyMs,
      attempt: attempts,
    });

    // ---------- 5) 写缓存 ----------
    if (useCache) {
      this.#cache.set(key, { reply: text, ts: new Date().toISOString(), model: this.#model });
      await this.#persistCache();
    }

    return text;
  }

  /* ============================ 内部实现 ============================ */

  /** 懒加载缓存与已花费（构造是同步的，IO 是异步的，所以放到第一次调用前）。 */
  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;

    const raw = await readJson<Record<string, unknown>>(join(this.#cfg.cacheDir, CACHE_FILE), {});
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') {
        // 兼容 Python 版写出的纯字符串格式
        this.#cache.set(k, { reply: v, ts: '' });
      } else if (v && typeof (v as CacheEntry).reply === 'string') {
        this.#cache.set(k, v as CacheEntry);
      }
    }

    this.#spent = await this.#readSpent();
  }

  /** 从账本算已花费（坏行跳过 —— 账本可能被手改过）。 */
  async #readSpent(): Promise<number> {
    const raw = await readFile(join(this.#cfg.cacheDir, LEDGER_FILE), 'utf8').catch(() => '');
    let total = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as LedgerRecord;
        if (typeof rec.cost === 'number') total += rec.cost;
      } catch {
        /* 跳过坏行 */
      }
    }
    return total;
  }

  /**
   * 预算闸门。两道：
   *   1) 已经花超了 → 拒绝
   *   2) 剩余不够本次预计开销 → 拒绝（宁可停下，也别花超）
   * 预算 <= 0 视为"不限"（方便本地调试时关掉护栏）。
   */
  #assertBudget(messages: ChatMessage[]): void {
    const budget = this.#cfg.budgetUsd;
    if (!Number.isFinite(budget) || budget <= 0) return;

    if (this.#spent >= budget) {
      throw new BudgetExceeded(
        `已花费 $${this.#spent.toFixed(4)}，达到预算 $${budget.toFixed(2)}。` +
          `删除 ${join(this.#cfg.cacheDir, LEDGER_FILE)} 可重置记账（缓存不受影响）。`,
        this.#spent,
        budget,
      );
    }

    const estCost = estimateCost(this.#model, countMessageTokens(messages), NOMINAL_OUTPUT_TOKENS);
    if (this.#spent + estCost > budget) {
      throw new BudgetExceeded(
        `预算不足：已花 $${this.#spent.toFixed(4)} / $${budget.toFixed(2)}，` +
          `本次预计 $${estCost.toFixed(4)}。`,
        this.#spent,
        budget,
      );
    }
  }

  /**
   * 真正的 HTTP 调用 + 重试。
   *
   * 重试策略：
   *   - 可重试：408/409/425/429/500/502/503/504 + 网络错误 + 超时
   *   - 不可重试：其它 4xx（401 key 错了、400 参数错了）—— 立刻抛，重试只是浪费时间和钱
   *   - 退避：base × 2^(n-1) + 随机抖动（抖动避免并发请求同时重试打成尖峰）
   *   - 尊重 Retry-After 头（限流时服务端会告诉你等多久）
   */
  async #callApi(
    messages: ChatMessage[],
    temperature: number,
    opts: CompleteOptions,
  ): Promise<{ text: string; usage: { inTok: number; outTok: number }; latencyMs: number; attempts: number }> {
    // system 怎么送，按厂商配（inline / top / both）—— 网关之间在这件事上不统一
    const delivery = opts.systemDelivery ?? this.#systemDelivery;
    const built = buildPayloadMessages(messages, delivery);

    const payload: Record<string, unknown> = {
      model: this.#model,
      messages: built.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature,
      stream: false,
    };
    // 顶层 system 字段（'top' / 'both' 模式）
    if (built.system) payload.system = built.system;
    if (opts.maxTokens && opts.maxTokens > 0) payload.max_tokens = opts.maxTokens;

    const url = `${this.#cfg.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.#cfg.llmApiKey}`,
    };
    const body = JSON.stringify(payload);

    let lastError: unknown;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const started = Date.now();
      try {
        const res = await this.#fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: buildSignal(opts.signal, this.#timeoutMs),
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          if (RETRYABLE_STATUS.has(res.status) && attempt < this.#maxAttempts) {
            lastError = new LLMError(`HTTP ${res.status}: ${detail.slice(0, 300)}`, res.status, detail);
            await sleep(this.#backoff(attempt, res.headers.get('retry-after')));
            continue;
          }
          throw new LLMError(
            `LLM API 调用失败 HTTP ${res.status}: ${detail.slice(0, 300)}`,
            res.status,
            detail,
          );
        }

        const data = await res.json();
        return {
          text: extractText(data),
          usage: extractUsage(data),
          latencyMs: Date.now() - started,
          attempts: attempt,
        };
      } catch (err) {
        // 带 status 的 LLMError = 已判定为"不可重试"（或重试用尽），直接往上抛
        if (err instanceof LLMError && err.status !== undefined) throw err;
        // 调用方主动取消 → 不重试
        if (opts.signal?.aborted) throw err;

        lastError = err;
        if (attempt >= this.#maxAttempts) break;
        await sleep(this.#backoff(attempt, null));
      }
    }

    throw new LLMError(`LLM API 重试 ${this.#maxAttempts} 次仍失败：${describeError(lastError)}`);
  }

  /** 退避时长：优先听 Retry-After，否则指数退避 + 抖动。 */
  #backoff(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs)) {
        return Math.min(this.#retryMaxDelayMs, Math.max(0, secs * 1000));
      }
      const at = Date.parse(retryAfter);
      if (!Number.isNaN(at)) {
        return Math.min(this.#retryMaxDelayMs, Math.max(0, at - Date.now()));
      }
    }
    const base = this.#retryBaseDelayMs * 2 ** (attempt - 1);
    const jitter = base * 0.3 * Math.random();
    return Math.min(this.#retryMaxDelayMs, base + jitter);
  }

  /** 追加一行账本（O_APPEND，小行写入天然安全）。 */
  async #appendLedger(rec: LedgerRecord): Promise<void> {
    await mkdir(this.#cfg.cacheDir, { recursive: true });
    await appendFile(join(this.#cfg.cacheDir, LEDGER_FILE), `${JSON.stringify(rec)}\n`, 'utf8');
  }

  /**
   * 落盘缓存。
   * 关键：加文件锁 + 读磁盘合并 + 原子替换。
   * 合并的原因：另一个 LM 实例（不同 tag）可能刚写进了新条目，
   * 直接覆盖会把别人的条目冲掉，等于缓存失效又白花钱。
   */
  async #persistCache(): Promise<void> {
    const file = join(this.#cfg.cacheDir, CACHE_FILE);
    await mkdir(this.#cfg.cacheDir, { recursive: true });
    await withFileLock(file, async () => {
      const onDisk = await readJson<Record<string, unknown>>(file, {});
      const merged: Record<string, unknown> = { ...onDisk };
      for (const [k, v] of this.#cache) merged[k] = v;
      await writeJsonAtomic(file, merged);
    });
  }
}

/**
 * 组合超时与调用方取消信号。
 * AbortSignal.timeout：Node 内置的"到点自己 abort"，不需要第三方库。
 * AbortSignal.any：两个信号任一触发就触发（超时 OR 用户取消）。
 */
function buildSignal(user: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return user ? AbortSignal.any([user, timeout]) : timeout;
}

/* ============================== 统计 ============================== */

/**
 * 按 tag 汇总花费（给 `run.ts llm-stats` 用）。
 * 输出：每个 tag 的真实调用数 / 缓存命中数 / token / 美元，外加总计与预算余额。
 */
export async function ledgerSummary(cfg: LLMConfig): Promise<string> {
  const file = join(cfg.cacheDir, LEDGER_FILE);
  const raw = await readFile(file, 'utf8').catch(() => '');
  if (!raw.trim()) {
    return '还没有任何调用记录（全部命中缓存，或还没跑过）。';
  }

  interface TagStat {
    calls: number;
    hits: number;
    tokens: number;
    cost: number;
  }
  const byTag = new Map<string, TagStat>();
  let totalCost = 0;
  let totalCalls = 0;
  let totalHits = 0;
  let totalTokens = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: LedgerRecord;
    try {
      rec = JSON.parse(line) as LedgerRecord;
    } catch {
      continue;
    }
    const tag = rec.tag || '?';
    const stat = byTag.get(tag) ?? { calls: 0, hits: 0, tokens: 0, cost: 0 };
    const tokens = (rec.in_tok || 0) + (rec.out_tok || 0);
    if (rec.cached) {
      stat.hits += 1;
      totalHits += 1;
    } else {
      stat.calls += 1;
      totalCalls += 1;
      stat.cost += rec.cost || 0;
      totalCost += rec.cost || 0;
    }
    stat.tokens += tokens;
    totalTokens += tokens;
    byTag.set(tag, stat);
  }

  const rows = [...byTag.entries()].sort((a, b) => b[1].cost - a[1].cost || a[0].localeCompare(b[0]));

  const lines: string[] = [];
  lines.push(
    `${padEndW('tag', 16)}${padStartW('真实调用', 10)}${padStartW('缓存命中', 10)}` +
      `${padStartW('tokens', 12)}${padStartW('美元', 10)}`,
  );
  lines.push('-'.repeat(58));
  for (const [tag, s] of rows) {
    lines.push(
      `${padEndW(tag, 16)}${padStartW(String(s.calls), 10)}${padStartW(String(s.hits), 10)}` +
        `${padStartW(String(s.tokens), 12)}${padStartW(s.cost.toFixed(4), 10)}`,
    );
  }
  lines.push('-'.repeat(58));
  lines.push(
    `合计：真实调用 ${totalCalls} 次，缓存命中 ${totalHits} 次，tokens ${totalTokens}，` +
      `花费 $${totalCost.toFixed(4)}`,
  );
  lines.push(
    `预算 $${cfg.budgetUsd.toFixed(2)}，剩余 $${Math.max(0, cfg.budgetUsd - totalCost).toFixed(4)}`,
  );
  return lines.join('\n');
}

/* ---------- 中文表格对齐：CJK 字符占两列，padStart/padEnd 会错位 ---------- */

function displayWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

function padEndW(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

function padStartW(s: string, width: number): string {
  return ' '.repeat(Math.max(0, width - displayWidth(s))) + s;
}
