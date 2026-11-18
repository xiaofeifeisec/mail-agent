/**
 * agent/tools.ts —— ⑨f 把已有管线接成 Agent 能自主调用的 10 个工具。
 *
 * 【这个文件是整条链路的"接线盒"】
 *   前面 6 个 agent 文件都是机制：怎么解析、怎么校验、怎么循环、怎么记。
 *   只有这个文件真正碰业务 —— 它把 ⑤ bm25 / ⑥ classify / ⑦ digest /
 *   ⑧ qa / ②③ reply+smtp 全部包成 ToolSpec，塞进注册表。
 *   没有它，loop 跑起来是个"什么工具都没有"的空壳。
 *
 * 【三条设计原则】
 *
 * ① 工具返回的文本必须是【自解释】的
 *    ToolResult.content 会逐字喂回模型，模型看不到我们的代码、注释、日志。
 *    所以"找不到邮件"不能只返回 null 或空串，得写成
 *    「找不到 id=xxx 的邮件，请先用 search_emails 查到正确的 id」——
 *    模型读到这句话才知道下一步该干什么。这一条决定了 Agent 会不会卡死。
 *
 * ② 不给模型「自由指定收件人」的能力
 *    send_draft_reply 的参数只有 id / body / subject，没有 to。
 *    收件人由代码从原邮件的 sender 里算出来。
 *    理由：邮件正文是不可信输入（提示注入可以让模型"把内容转发到 attacker@x"），
 *    如果允许模型填 to，一次注入就等于一次数据外泄。
 *    【能力最小化】比"让模型自觉"可靠得多。
 *
 * ③ readOnly 是安全分界线，不是描述词
 *    只有真正改变外部世界/邮件状态的两个工具标 false，
 *    loop 才会对它们弹审批。标错一个，审批就形同虚设。
 */

import type { Config } from '../config.js';
import { LM } from '../llm/client.js';
import type { Email } from '../mailbox/types.js';
import { sendMail } from '../mailbox/smtp.js';
import type { OutgoingMail, SendResult } from '../mailbox/smtp.js';
import { BM25Index } from '../pipelines/bm25.js';
import { classifyEmail } from '../pipelines/classify.js';
import type { Category } from '../pipelines/classify.js';
import { buildDigest } from '../pipelines/digest.js';
import { answerQuestion, formatHits } from '../pipelines/qa.js';
import type { QaHit, QaSearchFn } from '../pipelines/qa.js';
import { buildReplySubject, generateReply } from '../pipelines/reply.js';
import { Memory } from './memory.js';
import { PROTOCOL_PROMPT } from './protocol.js';
import { Registry } from './registry.js';
import type { AgentConfig, AgentMemory, ToolSpec, UserIO } from './types.js';

/* ============================ 依赖 ============================ */

/**
 * 组装 Agent 所需的全部外部依赖。
 *
 * 【为什么要显式注入，而不是在函数里自己 new / 读全局】
 *   三件事都必须在测试里换掉：
 *     lm     → 不能真调模型花钱、也不能忍受输出不稳定
 *     send   → 不能真发一封邮件出去
 *     mails  → 需要造几封固定内容的邮件来断言检索结果
 *   把它们做成参数，测试就能塞替身，而 tools.ts 的业务逻辑一行都不用改。
 */
export interface AgentDeps {
  /** 全局配置（时区、预算、模式、IMAP 账号）。 */
  cfg: Config;
  /** 本次会话可见的邮件。Agent 只能在【这个范围】里查，凭空编 id 会被拒。 */
  mails: Email[];

  /**
   * 按 tag 创建模型客户端。
   * 【为什么要传函数而不是一个 LM 实例】
   *   各管线的缓存 key、日志 tag 不同（classify / qa / digest / reply 各自统计）。
   *   共用一个实例会让统计混在一起，排查"这次到底谁调了模型"时看不出来。
   */
  makeLm?: (tag: string) => LM;

  /** 跨会话记忆。传 Memory 实例或任何实现了 AgentMemory 的对象都行。 */
  memory?: AgentMemory | Memory;
  /** 人机接口。confirm 模式下审批副作用工具时必需。 */
  user?: UserIO;
  /**
   * 发信实现。默认走 mailbox/smtp.ts。
   * 【测试必须注入】否则一次集成测试就会真发邮件。
   */
  send?: (mail: OutgoingMail) => Promise<SendResult>;
}

/* ============================ 系统提示词 ============================ */

/** Agent 的角色与工作原则（不含工具清单、不含协议格式）。 */
export const AGENT_ROLE_PROMPT = `你是「邮件管家」，一个能自主使用工具的邮件助手。

工作原则：
1. 涉及具体邮件内容的问题，先检索再回答，不要凭印象编造。
2. 一次只调一个工具；看到工具结果后再决定下一步。
3. 只报告工具结果里出现过的事实。检索不到就如实说"没找到"。
4. 发信、改标签这类有副作用的操作，必须等用户明确同意后才调用。
5. 最终回答用中文，直接给结论，不要复述你调了哪些工具。`;

/**
 * 拼出完整的 system prompt。
 *
 * 【工具清单为什么要用 registry.describe() 生成，而不是手写】
 *   手写的清单一定会跟实际注册的工具脱节：加了个工具忘了写进 prompt，
 *   模型就永远不会用它；删了工具没删描述，模型会一直调一个不存在的名字。
 *   从注册表生成，两者永远同步 —— 这是 Agent 里最划算的一条防错。
 */
export function buildSystemPrompt(registry: Registry): string {
  return [
    AGENT_ROLE_PROMPT,
    PROTOCOL_PROMPT,
    '【可用工具】\n' + registry.describe(),
  ].join('\n\n');
}

/* ============================ 小工具函数 ============================ */

/**
 * 从 args 里安全取字符串。
 * registry 已经校验过类型，这里再判一次是为了让 TypeScript 收窄类型，
 * 也防住有人绕过 registry 直接调 spec.fn。
 */
function str(args: Record<string, unknown>, key: string, fallback = ''): string {
  const v = args[key];
  return typeof v === 'string' ? v : fallback;
}

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 找不到邮件时给模型看的提示 —— 必须告诉它怎么补救。 */
function missText(id: string): string {
  return `找不到 id=${id} 的邮件。id 来自邮件内容哈希，不能自己编；请先用 search_emails 检索，拿到结果里真实的 id 再调用。`;
}

/**
 * 从发件人里抠出纯邮箱地址。
 * sender 常见两种形状：`张三 <zhangsan@qq.com>` 或 `zhangsan@qq.com`。
 */
function replyAddress(sender: string): string {
  const m = sender.match(/<([^>]+)>/);
  return (m?.[1] ?? sender).trim();
}

/** 从 labels 里取当前分类（没有就 unknown）。 */
function categoryOf(email: Email): Category {
  const hit = email.labels.find((l) => l === 'urgent' || l === 'normal' || l === 'ignore');
  return (hit ?? 'unknown') as Category;
}

/** 按用户时区算本地日期 YYYY-MM-DD（digest 的按天过滤要跟界面一致）。 */
function localDay(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * BM25 索引缓存。
 *
 * 【key 为什么用 mails 数组本身】
 *   WeakMap 的 key 是数组引用：上层重新拉了邮件会换一个新数组 → 缓存自动失效。
 *   如果按 `mails.length` 做 key，就会出现"换了 20 封但总数没变、索引还是旧的"，
 *   查出来的结果是上一个会话的邮件 —— 这种 bug 极难发现。
 */
const INDEX_CACHE = new WeakMap<Email[], BM25Index>();

function indexOf(deps: AgentDeps): BM25Index {
  let idx = INDEX_CACHE.get(deps.mails);
  if (!idx) {
    idx = new BM25Index().build(deps.mails);
    INDEX_CACHE.set(deps.mails, idx);
  }
  return idx;
}

/** 把 BM25 的 {id, score} 补成模型看得懂的 QaHit（跟 /api/qa 的组装保持一致）。 */
function makeSearchFn(deps: AgentDeps): QaSearchFn {
  const idx = indexOf(deps);
  const byId = new Map(deps.mails.map((m) => [m.id, m]));
  return (query: string, k: number): QaHit[] =>
    idx.search(query, k).map((h) => {
      const m = byId.get(h.id);
      return {
        id: h.id,
        score: h.score,
        meta: m
          ? { subject: m.subject, sender: m.sender, date: m.date, body: m.body }
          : undefined,
      };
    });
}

/** Memory 类返回 MemoryItem[]，而 AgentMemory 契约要求 string[] —— 在这里适配一次。 */
function normalizeMemory(m: AgentDeps['memory']): AgentMemory | undefined {
  if (!m) return undefined;
  if (m instanceof Memory) {
    return {
      indexText: () => m.indexText(),
      remember: (content) => m.remember(content),
      recall: (query) => m.recall(query).map((item) => item.content),
    };
  }
  return m;
}

/** 默认发信：跟 Web 的 /api/send 用同一套 SMTP 配置。 */
async function defaultSend(deps: AgentDeps, mail: OutgoingMail): Promise<SendResult> {
  if (!deps.cfg.imap) {
    throw new Error('没有配置邮箱账号（.env 里缺 IMAP/SMTP 账号或授权码），无法发信');
  }
  return sendMail(
    {
      host: process.env.MAIL_SMTP_HOST ?? 'smtp.qq.com',
      port: Number(process.env.MAIL_SMTP_PORT ?? 465),
      secure: (process.env.MAIL_SMTP_SECURE ?? 'true') !== 'false',
      user: deps.cfg.imap.user,
      pass: deps.cfg.imap.pass,
      helo: 'localhost',
    },
    mail,
  );
}

function lmFor(deps: AgentDeps, tag: string): LM {
  return deps.makeLm?.(tag) ?? new LM(deps.cfg, tag);
}

function findMail(deps: AgentDeps, id: string): Email | undefined {
  return deps.mails.find((m) => m.id === id);
}

/* ============================ 10 个工具 ============================ */

/**
 * 造出全部工具。
 *
 * 【10 个工具的分组】
 *   只读 8 个：检索 / 分类 / 摘要 / 问答 / 起草 / 记 / 忆 / 问人
 *   副作用 2 个：打标签 / 发信（这两个才会触发审批）
 *
 * 【为什么 classify_email 不改 labels】
 *   分类结果只是"算出来给模型看"，打标签是另一个工具的事。
 *   混在一起的话，一个标着 readOnly=true 的工具会偷偷改邮件状态，
 *   loop 就不会弹审批 —— 安全边界被悄悄绕过去了。
 */
export function buildTools(deps: AgentDeps): ToolSpec[] {
  const memory = normalizeMemory(deps.memory);
  const tools: ToolSpec[] = [
    /* ---------- ① 检索 ---------- */
    {
      name: 'search_emails',
      description:
        '在本次会话的邮件里做 BM25 全文检索，返回命中的 id、主题、发件人、时间和正文片段。' +
        'query 填中文或英文关键词（如「证书 过期」「面试时间」）。' +
        '这是拿到邮件 id 的唯一途径，其他需要 id 的工具都必须先用它。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词，多个词用空格分开' },
          k: { type: 'number', description: '最多返回几条，默认 5，最大 20' },
        },
        required: ['query'],
      },
      readOnly: true,
      fn: (args) => {
        const query = str(args, 'query').trim();
        if (!query) return 'query 不能为空。请给出要检索的关键词。';
        const k = Math.min(20, Math.max(1, Math.trunc(num(args, 'k', 5))));
        const hits = makeSearchFn(deps)(query, k);
        return formatHits(hits, query);
      },
    },

    /* ---------- ② 分类 ---------- */
    {
      name: 'classify_email',
      description:
        '让模型判断某一封邮件属于 urgent / normal / ignore / unknown 哪一类，并给出一句话理由。' +
        '只返回结果，不会修改邮件标签；要打标签请用 flag_email（需要用户同意）。' +
        'id 必须来自 search_emails 的结果。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '邮件 id' } },
        required: ['id'],
      },
      readOnly: true,
      fn: async (args) => {
        const id = str(args, 'id');
        const mail = findMail(deps, id);
        if (!mail) return missText(id);
        const r = await classifyEmail(lmFor(deps, 'classify'), mail, deps.cfg.timezone);
        return [
          `邮件：${r.subject}`,
          `分类：${r.category}`,
          `理由：${r.reason || '（模型未给出理由）'}`,
          `当前标签：${mail.labels.join(', ') || '（无）'}`,
          '注意：这只是判断结果，标签尚未改动。',
        ].join('\n');
      },
    },

    /* ---------- ③ 摘要 ---------- */
    {
      name: 'build_digest',
      description:
        '把邮件按「需要你行动 / 值得知道」整理成一份中文晨报。' +
        '不传 date 就汇总全部会话邮件；传 YYYY-MM-DD 只汇总那一天（按用户本地时区）。' +
        '被标为 ignore 的邮件会自动跳过。',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: '可选，YYYY-MM-DD；不传则汇总全部' },
        },
      },
      readOnly: true,
      fn: async (args) => {
        const date = str(args, 'date').trim();
        const picked = date
          ? deps.mails.filter((m) => localDay(m.date, deps.cfg.timezone) === date)
          : deps.mails;
        if (picked.length === 0) {
          return `没有${date ? ` ${date} 这天的` : ''}邮件可汇总。可以先放宽日期，或确认邮件是否已拉取。`;
        }
        const pairs = picked.map((email) => ({ email, category: categoryOf(email) }));
        const d = await buildDigest(lmFor(deps, 'digest'), pairs, deps.cfg.timezone);
        return [
          `【邮件摘要】共 ${d.total} 封，忽略 ${d.ignoredCount} 封`,
          d.text,
        ].join('\n');
      },
    },

    /* ---------- ④ 多跳问答 ---------- */
    {
      name: 'answer_question',
      description:
        '回答需要跨多封邮件才能拼出答案的问题（如「面试改到几点了」「证书什么时候过期」）。' +
        '它会自动做最多 3 跳检索，答案里的引用 id 都经过校验，不会凭空编造。' +
        '简单事实查询用 search_emails 更省；需要推理、串联、对比时用这个。',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string', description: '用户的问题，用完整句子描述' } },
        required: ['question'],
      },
      readOnly: true,
      fn: async (args) => {
        const question = str(args, 'question').trim();
        if (!question) return 'question 不能为空。请写出要回答的问题。';
        const r = await answerQuestion(lmFor(deps, 'qa'), question, makeSearchFn(deps), 3);
        if (r.error) {
          return `这次问答没能得出答案（${r.error}）。检索了 ${r.hops} 跳；可以换一个更具体的问法，或改用 search_emails 自己查。`;
        }
        return [
          `答案：${r.answer}`,
          `引用邮件 id：${r.support.join(', ') || '（无）'}`,
          `检索跳数：${r.hops}`,
          r.droppedSupport > 0 ? `（模型编造的 ${r.droppedSupport} 个引用 id 已被丢弃）` : '',
        ]
          .filter(Boolean)
          .join('\n');
      },
    },

    /* ---------- ⑤ 起草回复 ---------- */
    {
      name: 'draft_reply',
      description:
        '为某一封邮件生成回复草稿（含主题和正文）。只生成文本，绝不发送。' +
        '正文里的日期、链接、工单号由代码抽取，不让模型编；检测到提示注入会直接拒绝起草。' +
        '要真正发出去必须用 send_draft_reply，且需要用户同意。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '要回复的邮件 id' } },
        required: ['id'],
      },
      readOnly: true,
      fn: async (args) => {
        const id = str(args, 'id');
        const mail = findMail(deps, id);
        if (!mail) return missText(id);
        const draft = await generateReply(lmFor(deps, 'reply'), {
          email: mail,
          userName: process.env.MAIL_USER_NAME ?? '',
          userSignature: process.env.MAIL_USER_SIGNATURE ?? '',
        });
        if (!draft.should) {
          return `模型判断这封邮件不需要回复。理由：${draft.reason || '（未给出）'}。原邮件 id=${id}。`;
        }
        return [
          `【回复草稿】原邮件 id=${id}`,
          `收件人（由原邮件发件人算出）：${replyAddress(mail.sender)}`,
          `建议主题：${buildReplySubject(mail.subject, draft.subject)}`,
          `正文：\n${draft.body}`,
          '',
          '这是草稿，尚未发送。若用户确认要发，调用 send_draft_reply，并把上面的正文放进 body 参数。',
        ].join('\n');
      },
    },

    /* ---------- ⑥ 记忆：写 ---------- */
    {
      name: 'remember',
      description:
        '把用户明确说过的偏好、习惯、长期事实记下来，供以后的会话使用。' +
        '只记「用户说过的话」，不要把邮件内容或本次检索结果记进去。' +
        '例：用户说「以后摘要都只给我看紧急邮件」→ 记这一句。',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string', description: '要记住的一句话，尽量简短完整' } },
        required: ['content'],
      },
      readOnly: true,
      fn: (args) => {
        if (!memory) return '当前没有启用记忆功能，无法保存。请直接把信息写进本次回答里。';
        return memory.remember(str(args, 'content'));
      },
    },

    /* ---------- ⑦ 记忆：读 ---------- */
    {
      name: 'recall',
      description:
        '检索之前记住的关于用户的事（偏好、习惯、背景）。' +
        '当你觉得"用户之前是不是说过什么相关要求"时用它。' +
        '系统提示词里已经有一次简短索引，需要完整原文时才用这个。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '要回忆的主题关键词' } },
        required: ['query'],
      },
      readOnly: true,
      fn: (args) => {
        if (!memory) return '当前没有启用记忆功能。';
        const hits = memory.recall(str(args, 'query'));
        if (!hits.length) return '没有找到相关的记忆。可以问用户，或按默认方式处理。';
        return `【相关记忆】\n${hits.map((h, i) => `${i + 1}. ${h}`).join('\n')}`;
      },
    },

    /* ---------- ⑧ 问人 ---------- */
    {
      name: 'ask_user',
      description:
        '向用户提一个问题并等待回答。当信息不足、有歧义、或即将做有副作用的操作需要确认时用。' +
        '一次只问一件事，问题要具体（不要问"你想怎么做"，要问"回复里要不要提周五的会议？"）。',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string', description: '要问用户的问题' } },
        required: ['question'],
      },
      readOnly: true,
      fn: async (args) => {
        const question = str(args, 'question').trim();
        if (!question) return 'question 不能为空。';
        if (!deps.user) return '当前没有可用的用户接口，问不到人。请基于已有信息给出最稳妥的回答，并说明这个限制。';
        const answer = await deps.user.ask(question);
        return answer.trim()
          ? `用户回答：${answer.trim()}`
          : '用户没有回答（或回答为空）。不要反复追问；按最保守的方式处理，或直接说明需要用户补充信息。';
      },
    },

    /* ---------- ⑨ 副作用：打标签 ---------- */
    {
      name: 'flag_email',
      description:
        '给某一封邮件加一个标签，会真的改动邮件数据。' +
        'label 只能是 urgent / normal / ignore / starred / done 之一。' +
        '调用前必须先向用户确认；confirm 模式下系统会自动弹审批。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '邮件 id，来自 search_emails' },
          label: {
            type: 'string',
            description: '要加的标签',
            enum: ['urgent', 'normal', 'ignore', 'starred', 'done'],
          },
        },
        required: ['id', 'label'],
      },
      readOnly: false,
      fn: (args) => {
        const id = str(args, 'id');
        const label = str(args, 'label');
        const mail = findMail(deps, id);
        if (!mail) return missText(id);
        const before = [...mail.labels];
        mail.labels = [...new Set([...mail.labels, label])];
        return `已给邮件 ${id}「${mail.subject}」加上标签 ${label}。原标签：${before.join(', ') || '（无）'}；现在：${mail.labels.join(', ')}`;
      },
    },

    /* ---------- ⑩ 副作用：发信 ---------- */
    {
      name: 'send_draft_reply',
      description:
        '把回复真的发出去。id 指向要回复的原邮件，收件人由代码从原邮件发件人算出，模型不能指定。' +
        'body 放已经给用户看过、且用户同意的回复正文。' +
        '这是整个 Agent 里唯一会对外发信的操作，confirm 模式下会自动弹审批。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要回复的原邮件 id' },
          body: { type: 'string', description: '回复正文（纯文本）' },
          subject: { type: 'string', description: '可选，回复主题；不传会自动生成 Re: 主题' },
        },
        required: ['id', 'body'],
      },
      readOnly: false,
      fn: async (args) => {
        const id = str(args, 'id');
        const body = str(args, 'body').trim();
        const mail = findMail(deps, id);
        if (!mail) return missText(id);
        if (!body) return 'body 不能为空，没有内容可发。请先用 draft_reply 生成草稿。';

        const to = replyAddress(mail.sender);
        if (!to || !to.includes('@')) {
          return `原邮件 ${id} 的发件人「${mail.sender}」不是有效邮箱地址，已拒绝发送，避免发错人。`;
        }

        const outgoing: OutgoingMail = {
          from: deps.cfg.imap?.user ?? '',
          to: [to],
          subject: str(args, 'subject').trim() || buildReplySubject(mail.subject, ''),
          text: body,
          inReplyTo:
            typeof mail.meta.messageId === 'string' ? mail.meta.messageId : undefined,
        };

        const result = deps.send
          ? await deps.send(outgoing)
          : await defaultSend(deps, outgoing);

        return result.ok
          ? `已发送给 ${to}，主题「${outgoing.subject}」。SMTP 返回 ${result.code} ${result.message}`
          : `发送失败（SMTP ${result.code}：${result.message}）。请把这个情况告诉用户，不要反复重试同一个调用。`;
      },
    },
  ];

  return tools;
}

/* ============================ 一站式组装 ============================ */

/**
 * 从依赖直接造出一个可以喂给 runAgent 的 AgentConfig。
 *
 * 【为什么要有这个函数】
 *   调用方（CLI / Web / monitor）不该自己重复"new Registry → 注册 10 个工具 →
 *   拼 systemPrompt → 从 Config 抄 6 个字段"这套流程。
 *   抄漏一个字段（比如忘了传 denyRules），安全护栏就静默失效了。
 */
export function createAgentConfig(deps: AgentDeps): AgentConfig {
  const registry = new Registry();
  for (const spec of buildTools(deps)) registry.register(spec);

  return {
    lm: lmFor(deps, 'agent'),
    registry,
    systemPrompt: buildSystemPrompt(registry),
    maxTurns: deps.cfg.maxTurns,
    tokenBudget: deps.cfg.tokenBudget,
    contextBudget: deps.cfg.contextBudget,
    mode: deps.cfg.mode,
    denyRules: deps.cfg.denyRules,
    user: deps.user,
    memory: normalizeMemory(deps.memory),
  };
}
