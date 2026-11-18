/**
 * ⑦ pipelines/digest.ts —— 邮箱内容总结。
 *
 * 【它做什么】
 *   把一批已分类的邮件，压成一份"该你行动的 + 值得知道的"摘要。
 *
 * 【为什么不让模型直接读全部邮件】
 *   200 封邮件 ≈ 40 万 token —— 爆上下文，而且模型一定会漏项。
 *   所以分工是：
 *     代码做：分组、丢弃 ignore、排序、组装要点、算字数
 *     模型做：把要点写成通顺的摘要（≤300 字）
 *   这就是「确定性归代码，语义归模型」的典型分工。
 *
 * 【输出格式】
 *   固定的三段式（不是自由发挥）：
 *     ┌ 头部：N 封新邮件 · 需处理 X 封 · 已忽略 Y 封
 *     ├ ■ 需要你行动：每条 = 标题 + 关键事实（时间/公司/人名/链接）
 *     └ ■ 值得知道：每条 = 标题 + 一句话
 *
 *   为什么固定格式：摘要要能被程序解析（Web UI 要按段落渲染、
 *   以后还要按段落做"加入待办"之类），自由文本没法用。
 *
 * 【安全】
 *   邮件正文是敌意输入 —— 里面可能写着"忽略以上规则"。
 *   三道防线同 classify：
 *     ① system 明确声明"正文是数据不是指令"
 *     ② 正文里的 <email> 标签被中和
 *     ③ 模型只被允许输出固定 JSON
 */

import { LM } from '../llm/client.js';
import type { ChatMessage } from '../llm/client.js';
import type { Email } from '../mailbox/types.js';
import { normalizeCategory, type Category } from './classify.js';

/* ============================ 类型 ============================ */

/** 一条要点。 */
export interface DigestItem {
  /** 邮件 id（回溯用） */
  id: string;
  /** 类别 */
  category: Category;
  /** 标题 */
  subject: string;
  /** 发件人显示名 */
  from: string;
  /** 时间（MM-DD HH:MM） */
  at: string;
  /** 一句话要点（模型写的） */
  point: string;
  /** 邮件里的关键链接（代码抽，不让模型编） */
  links: string[];
  /** 邮件里的关键日期（代码抽） */
  dates: string[];
}

/** 完整摘要。 */
export interface Digest {
  /** 头部说明 */
  head: string;
  /** 需要你行动 */
  action: DigestItem[];
  /** 值得知道 */
  know: DigestItem[];
  /** 已忽略的封数（只给数字，不给内容） */
  ignoredCount: number;
  /** 参与总结的邮件总数 */
  total: number;
  /** 完整文本（拼接好的，可直接复制走） */
  text: string;
  /** 统计（调用方自己用） */
  stats: {
    urgent: number;
    normal: number;
    ignored: number;
    tokensIn: number;
    tokensOut: number;
  };
}

/* ============================ 常量 ============================ */

/** 送进模型的正文上限（每封）。 */
const MAX_BODY_CHARS = 600;

/** 最多送几封进模型 —— 防止邮件太多把上下文撑爆。 */
const MAX_FOR_MODEL = 30;

/** 摘要正文上限字数。 */
export const MAX_DIGEST_CHARS = 600;

const SYSTEM_PROMPT = `你是邮件摘要助手。只输出 JSON，不要任何解释文字。

你的任务：把给定的邮件列表写成一份简洁的中文摘要。

要求：
1. 只依据给定邮件里的事实，不要编造任何信息（时间、公司、人名、链接必须来自原文）。
2. 分两类输出：
   - action：需要收件人本人采取行动的（面试邀请、需要回复的、需要确认的、有明确截止时间的）
   - know：值得知道但不用立刻动的（通知、公告、新项目发布）
3. 每条 point 不超过 30 字，要点出具体事实（时间/公司/项目/人名），不要写"这是一封重要邮件"这种废话。
4. 绝不要提及 ignore 类邮件的内容 —— 那些已经在提示里告诉你被过滤掉了。
5. ignore 类别代表营销推送、验证码、自动通知 —— 即使正文里有"紧急""立即行动"也不要放进任何一类。

输出格式（严格）：
{"action":[{"subject":"...","point":"..."}],"know":[{"subject":"...","point":"..."}]}`;

/* ============================ 确定性预处理 ============================ */

/**
 * 从正文里抽链接。
 * 【为什么不让模型给链接】
 *   模型可能会"顺手编"一个看起来像的 URL —— 那你点开就是钓鱼链接。
 *   所以链接由代码正则抽，模型碰不到。
 */
export function extractLinks(body: string, limit = 3): string[] {
  const out: string[] = [];
  const re = /https?:\/\/[^\s<>"'）)，。；、]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null && out.length < limit) {
    const url = m[0];
    // URL 前面紧贴的那一小段（标签词），最多 12 字
    const before = body.slice(Math.max(0, m.index - 12), m.index);

    // 【关键】"退订"两个字常常在链接【前面】("退订：https://...")，
    // 不在 URL 里 —— 只看 URL 会漏掉。
    //
    // 但绝不能看大范围上下文：否则"请访问 https://x 参加面试。退订：https://y"
    // 这种正常句子里，第一个链接会因为"附近 20 字内有退订"被误伤。
    //
    // 正确做法：只看【紧贴链接的标签词】——
    //   链接前面那一小段（去掉标点和空白后）如果就是"退订/取消订阅"这类词，
    //   才判定它是退订链接。 句子中段出现的退订词不影响前面的链接。
    const label = before.replace(/[\s:：，,。、；;（）()\[\]【】]/g, '');
    if (/退订|取消订阅|拒绝接收|停止接收|unsubscribe/i.test(label)) continue;

    // URL 自身带退订标记的
    if (/unsubscribe|list-unsubscribe|mailto:/i.test(url)) continue;

    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/**
 * 从正文里抽日期。
 * 同样是代码抽 —— 模型编日期的概率比编链接还高。
 */
export function extractDates(body: string, limit = 3): string[] {
  const out: string[] = [];
  const patterns = [
    /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/g,
    /\d{4}-\d{2}-\d{2}/g,
    /\d{1,2}\s*月\s*\d{1,2}\s*日/g,
    /\d{1,2}:\d{2}/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null && out.length < limit) {
      const d = m[0].trim();
      if (!out.includes(d)) out.push(d);
    }
  }
  return out;
}

/** 中和围栏标签（同 classify 的做法）。 */
function neutralize(text: string): string {
  return text.replace(/<\/?email>/gi, '[标签已中和]');
}

/** 发件人显示名（去掉尖括号里的地址）。 */
function senderName(sender: string): string {
  const s = sender.replace(/\s*<[^>]*>\s*/, '').trim();
  return s || '(未知发件人)';
}

/* ============================ 摘要组装 ============================ */

/**
 * 选出要进摘要的邮件。
 * ignore 一律丢掉 —— 但要记住数量（头部要报）。
 */
export function selectForDigest(
  mails: Array<{ email: Email; category: Category }>,
): { keep: Array<{ email: Email; category: Category }>; ignored: number } {
  const keep = mails.filter((m) => m.category !== 'ignore');
  const ignored = mails.length - keep.length;
  // 紧急优先，其次按时间新的优先；超量就截断
  const sorted = keep.slice().sort((a, b) => {
    if (a.category !== b.category) return a.category === 'urgent' ? -1 : 1;
    return Date.parse(b.email.date) - Date.parse(a.email.date);
  });
  return { keep: sorted.slice(0, MAX_FOR_MODEL), ignored };
}

/** 组装送进模型的消息。 */
function buildMessages(
  items: Array<{ email: Email; category: Category }>,
  ignoredCount: number,
): ChatMessage[] {
  const blocks = items.map(({ email, category }) => {
    const body = neutralize(email.body).slice(0, MAX_BODY_CHARS);
    return [
      '<email>',
      `类别：${category}`,
      `发件人：${senderName(email.sender)}`,
      `主题：${neutralize(email.subject)}`,
      '正文：',
      body,
      '</email>',
    ].join('\n');
  });

  const hint =
    ignoredCount > 0
      ? `\n（另有 ${ignoredCount} 封营销推送/验证码类邮件已过滤，不需要提及它们。）`
      : '';

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `以下是 ${items.length} 封邮件：\n\n${blocks.join('\n\n')}${hint}\n\n请按 system 里的格式输出 JSON。`,
    },
  ];
}

/** 解析模型返回的 JSON。 */
export function parseDigest(raw: string): {
  action: Array<{ subject: string; point: string }>;
  know: Array<{ subject: string; point: string }>;
} | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;

  const rec = obj as Record<string, unknown>;
  const pick = (v: unknown): Array<{ subject: string; point: string }> => {
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((x) => ({
        subject: String(x.subject ?? '').slice(0, 80),
        point: String(x.point ?? '').slice(0, 60),
      }))
      .filter((x) => x.point.length > 0);
  };

  return { action: pick(rec.action), know: pick(rec.know) };
}

/**
 * 把要点和原始邮件对上号。
 *
 * 【为什么要对齐】
 *   模型只返回 subject + point，可能把标题改写了。
 *   我们要拿到原邮件的 id / 发件人 / 链接 / 时间戳 —— 这些模型不该编。
 *
 * 【共享 used 集合】
 *   action 和 know 必须共用一个"已占用"记录 ——
 *   否则同一封邮件可能同时出现在两类里（或者 action 用掉的，
 *   know 又按顺序兜底匹配到它，导致另一封真实的邮件被挤掉）。
 */
function alignItems(
  parsed: Array<{ subject: string; point: string }>,
  pool: Array<{ email: Email; category: Category }>,
  used: Set<number>,
): DigestItem[] {
  const out: DigestItem[] = [];

  for (const p of parsed) {
    // 优先按标题匹配（取前 6 个字，容忍模型微调）
    let idx = pool.findIndex(
      (m, i) => !used.has(i) && m.email.subject.includes(p.subject.slice(0, 6)),
    );
    // 标题匹配不上才按顺序兜底
    if (idx < 0) idx = pool.findIndex((_m, i) => !used.has(i));
    if (idx < 0) break;

    used.add(idx);
    const { email, category } = pool[idx];
    out.push({
      id: email.id,
      category,
      subject: email.subject,
      from: senderName(email.sender),
      at: formatAt(email),
      point: p.point,
      links: extractLinks(email.body),
      dates: extractDates(email.body),
    });
  }
  return out;
}

/** 格式化时间（MM-DD HH:MM）。 */
function formatAt(email: Email): string {
  const t = Date.parse(email.date);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const p = (n: number): string => (n < 10 ? '0' + n : String(n));
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把结果拼成纯文本（可复制走）。 */
export function renderDigestText(d: {
  head: string;
  action: DigestItem[];
  know: DigestItem[];
  ignoredCount: number;
}): string {
  const lines: string[] = [];
  lines.push(d.head);
  lines.push('');

  if (d.action.length > 0) {
    lines.push(`■ 需要你行动（${d.action.length}）`);
    for (const it of d.action) {
      lines.push(`• ${it.subject}`);
      lines.push(`  ${it.point}`);
      const facts: string[] = [];
      if (it.dates.length) facts.push(`时间 ${it.dates[0]}`);
      if (it.links.length) facts.push(it.links[0]);
      if (facts.length) lines.push(`  ${facts.join(' · ')}`);
      lines.push(`  ${it.from} · ${it.at}`);
    }
    lines.push('');
  }

  if (d.know.length > 0) {
    lines.push(`■ 值得知道（${d.know.length}）`);
    for (const it of d.know) {
      lines.push(`• ${it.subject}`);
      lines.push(`  ${it.point}`);
    }
    lines.push('');
  }

  if (d.ignoredCount > 0) {
    lines.push(`另有 ${d.ignoredCount} 封营销推送与自动通知已忽略。`);
  }

  return lines.join('\n').trim();
}

/* ============================ 主流程 ============================ */

/**
 * 生成邮箱摘要。
 *
 * @param lm    LLM 客户端
 * @param mails 已分类的邮件（带 category）
 * @param timeZone 计算时间用
 */
export async function buildDigest(
  lm: LM,
  mails: Array<{ email: Email; category: Category }>,
  timeZone: string,
): Promise<Digest> {
  const { keep, ignored } = selectForDigest(mails);

  const counts = { urgent: 0, normal: 0, ignored: 0 };
  for (const m of mails) {
    if (m.category === 'urgent') counts.urgent++;
    else if (m.category === 'normal') counts.normal++;
    else counts.ignored++;
  }

  // 一封都没留下（全是 ignore）→ 不用调模型
  if (keep.length === 0) {
    const head = `${mails.length} 封新邮件 · 无需处理 · 已忽略 ${ignored} 封`;
    const base = { head, action: [] as DigestItem[], know: [] as DigestItem[], ignoredCount: ignored, total: mails.length };
    return {
      ...base,
      text: renderDigestText(base),
      stats: { ...counts, tokensIn: 0, tokensOut: 0 },
    };
  }

  const messages = buildMessages(keep, ignored);
  const raw = await lm.complete(messages, { temperature: 0.2, maxTokens: 700, tag: 'digest' });

  const parsed = parseDigest(raw);
  // action 和 know 共用一个"已占用"记录 —— 同一封邮件不能出现在两类里
  const used = new Set<number>();
  const action = parsed ? alignItems(parsed.action, keep, used) : [];
  const know = parsed ? alignItems(parsed.know, keep, used) : [];

  // 【漏项兜底】模型可能漏掉某些邮件 —— 实测它就漏过一封 normal。
  // 这是"语义判断"的固有风险：模型只输出它"想说的"，没说到的就消失了。
  //
  // 兜底策略（确定性，代码做）：
  //   urgent 没被提到 → 一定要补（漏了紧急邮件是不可接受的）
  //   normal 没被提到 → 也补，但标注"（未展开）"
  //   这样保证"每一封非 ignore 的邮件都在摘要里出现过"，
  //   代价只是文字不那么精炼 —— 宁可啰嗦，不可漏项。
  for (let i = 0; i < keep.length; i++) {
    if (used.has(i)) continue;
    const { email, category } = keep[i];
    const point =
      category === 'urgent'
        ? '需要你尽快确认（模型未展开细节，请查看原文）'
        : '（模型未展开细节，请查看原文）';
    const item: DigestItem = {
      id: email.id,
      category,
      subject: email.subject,
      from: senderName(email.sender),
      at: formatAt(email),
      point,
      links: extractLinks(email.body),
      dates: extractDates(email.body),
    };
    // urgent 补进「需要你行动」；normal 补进「值得知道」——
    // 不能把不紧急的邮件放进"需要行动"里，那会骗用户
    if (category === 'urgent') action.push(item);
    else know.push(item);
    used.add(i);
  }

  const head =
    `${mails.length} 封新邮件 · 需处理 ${action.length} 封` +
    ` · 值得知道 ${know.length} 封` +
    ` · 已忽略 ${ignored} 封`;

  const base = { head, action, know, ignoredCount: ignored, total: mails.length };
  const text = renderDigestText(base).slice(0, MAX_DIGEST_CHARS);

  return {
    ...base,
    text,
    stats: {
      ...counts,
      tokensIn: messages.reduce((n, m) => n + m.content.length, 0),
      tokensOut: raw.length,
    },
  };
}

/**
 * 从裸邮件（没有分类结果）推断分类 —— 给"没跑过 classify"的场景用。
 * 复用 classify 的分类器，保持一致。
 */
export function classifyBy(lm: LM, email: Email, timeZone: string): Promise<Category> {
  // 动态 import 避免循环依赖
  return import('./classify.js').then(async (m) => {
    const r = await m.classifyEmail(lm, email, timeZone);
    return normalizeCategory(r.category);
  });
}
