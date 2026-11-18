/**
 * mailbox/imap.ts —— ③c IMAP 只读拉取 + 各家邮箱服务商接入。
 *
 * 【为什么各家邮箱能共用一套代码】
 *   IMAP 是标准协议，QQ / Outlook / Gmail / 163 / 企业邮 都提供 IMAP 服务，
 *   差别只在【服务器地址】和【认证方式】—— 所以差异全部收进下面的预设表。
 *
 * 【只读的三重保证】
 *   1. imapflow 内部用 BODY.PEEK 拉取 → 【不会把邮件标记成已读】。
 *      （这是"用脚本读邮箱"最重要的礼貌：不改变你的邮箱状态。）
 *   2. 我们只调 fetch / search，绝不调 store / setFlags / copy / move。
 *   3. 用完立刻 logout，不留长连接。
 *
 * 【不落盘】
 *   拉回来的邮件只在内存里活着：洗成纯文本 → 交给管线 → 扔掉。
 *   磁盘上不会出现任何邮件正文。
 *
 * 【认证的小坑（各家都踩过）】
 *   几乎所有邮箱都不接受"登录密码"做 IMAP 认证，要用专门的凭证：
 *     - QQ 邮箱     → 设置 → 账户 → POP3/IMAP → 生成"授权码"
 *     - QQ 企业邮   → 客户端专用密码
 *     - 163 / 126   → 客户端授权密码
 *     - Gmail       → 应用专用密码（且账号要开两步验证）
 *     - Outlook     → 应用密码或 OAuth2
 *   这些凭证只写在 .env 里，不进代码、不进日志。
 */

import { ImapFlow } from 'imapflow';
import type { Email } from './types.js';
import { toEmail } from './types.js';
import { IMAP_PROVIDERS, providerSpec, type ImapProviderSpec } from './providers.js';

export { IMAP_PROVIDERS, providerSpec };
export type { ImapProviderSpec };

/** 拉取所需的连接参数（凭证从 .env 来，不写死在代码里）。 */
export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  /** 登录账号，一般是完整邮箱地址 */
  user: string;
  /** 授权码 / 应用专用密码（不是登录密码） */
  pass: string;
  /** 要打开的邮箱夹，默认 INBOX */
  mailbox: string;
}

/** 拉取选项。 */
export interface FetchOptions {
  /** 最多拉几封（取最新的） */
  limit?: number;
  /** 只拉这个时间之后收到的邮件（ISO 字符串）—— 实时增量靠它 */
  since?: string;
  /** 覆盖默认邮箱夹 */
  mailbox?: string;
  /** 单封邮件最多取多少原始字节（防止巨型邮件） */
  maxBytes?: number;
  /**
   * 先只看最近多少天的邮件（默认 30）。
   * 不够 limit 封就自动扩大窗口（30 → 90 → 360 → 不限）。
   * 为什么要有窗口：服务器给"全部 959 封"拉元数据要 70 秒，而"最近 30 天"只要几秒。
   */
  maxAgeDays?: number;
}

/** 把数组切成固定大小的块（IMAP 命令行有长度上限，不能一次塞几千个 UID）。 */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 构造 imapflow 客户端。所有"安静模式"开关都在这里。 */
function makeClient(cfg: ImapConfig): ImapFlow {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    // 关掉 pino 日志：不然每次连接刷一屏 INFO
    logger: false,
    // 我们是短连接，不要它自动进 IDLE 挂着
    disableAutoIdle: true,
    // 【安全】默认校验 TLS 证书，防中间人截取账号授权码和邮件正文。
    // 老版本为了兼容证书链不全的服务器一律放行，等于让 MITM 畅通无阻。
    // 若你的服务器确实用自签证书，在 .env 里设 MAIL_TLS_REJECT_UNAUTHORIZED=0
    // 显式放宽（只影响能否连上，通道仍是 TLS 加密的）。
    tls: { rejectUnauthorized: process.env.MAIL_TLS_REJECT_UNAUTHORIZED !== '0' },
  });
}

/**
 * 把 imapflow 的错误翻译成人能看懂的话。
 *
 * 【为什么要自己转】
 *   imapflow 抛出来的 message 常常只是 "Command failed" —— 毫无信息量。
 *   真正有用的是服务器回的原文（e.response），比如：
 *     2 NO [AUTHENTICATIONFAILED] Login fail. Account is abnormal, service is not open...
 *   把这段丢了，用户就只能瞎猜。现在我们把它带出来，并给出针对性的下一步。
 */
export function describeImapError(e: unknown): string {
  const err = e as { response?: string; message?: string; code?: string };
  const server = (err.response ?? '').trim();
  const msg = (err.message ?? '').trim() || String(e);

  if (/AUTHENTICATIONFAILED/i.test(server)) {
    return (
      `认证被服务器拒绝。服务器原文：${server}\n` +
      '   → ① 用的是「授权码」不是登录密码（QQ：设置→账户→POP3/IMAP/SMTP→开启→生成授权码）\n' +
      '   → ② 确认已在邮箱设置里开启 IMAP 服务\n' +
      '   → ③ 账号是否异常 / 是否被限制登录频率'
    );
  }
  if (/\[ALERT\]|system is busy|TIMEOUT|CONNECTION/i.test(server)) {
    return `服务器暂时不可用：${server}\n   → 稍后重试，或检查网络（部分邮箱服务器要代理）`;
  }
  if (/NONEXISTENT|Unknown Mailbox/i.test(server)) {
    return `邮箱夹不存在：${server}\n   → 改 MAIL_IMAP_MAILBOX（默认 INBOX）`;
  }
  if (server) return `服务器返回：${server}`;
  return msg;
}

/**
 * 拉取邮件（只读，不落盘）。
 *
 * 返回的 Email 里 meta.uid 是 IMAP 的唯一标识 —— 拿它做水位线，
 * 下次只拉 uid 更大的，就实现了"实时增量"。
 */
export async function fetchImap(cfg: ImapConfig, opts: FetchOptions = {}): Promise<Email[]> {
  const limit = opts.limit ?? 20;
  const maxBytes = opts.maxBytes ?? 500_000;
  const mailbox = opts.mailbox ?? cfg.mailbox ?? 'INBOX';

  const client = makeClient(cfg);
  const out: Email[] = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock(mailbox);
    try {
      // 1) 先搜出符合条件的 UID。
      //    【自适应时间窗】：先用"最近 N 天"搜，不够 limit 封就扩大窗口，最后才不限。
      //    为什么不能直接全量：959 封的邮箱拉元数据要 70 秒，而最近 30 天只要几秒。
      const maxAgeDays = opts.maxAgeDays ?? 30;
      const windows = opts.since
        ? [0] // 显式给了 since 就用它，不再自适应
        : [maxAgeDays, maxAgeDays * 3, maxAgeDays * 12, 0];

      let uids: number[] = [];
      for (const days of windows) {
        const q = opts.since
          ? { since: new Date(opts.since) }
          : days > 0
            ? { since: new Date(Date.now() - days * 86_400_000) }
            : {};
        const res = await client.search(q, { uid: true });
        const found = Array.isArray(res) ? res : []; // 搜索失败时服务器会回 false
        if (found.length > uids.length) uids = found; // 记住覆盖范围最大的那次
        if (found.length >= limit) break; // 够了，不用再试
        if (days === 0) break;
      }
      if (uids.length === 0) return [];

      // 2) 【关键】不能直接 slice(-limit) —— 很多服务器（QQ 就是）会重排 UID，
      //    "最大 UID"不等于"最新邮件"。实测：uid=1 的邮件是 2024-05-15，
      //    而 uid=963 的邮件是 2024-05-10。
      //    所以先只取【元数据】（envelope + internalDate，很轻）按时间排序，取最新的 N 封。
      const metas: Array<{ uid: number; at: number }> = [];
      for (const batch of chunk(uids, 200)) {
        for await (const msg of client.fetch(batch, { envelope: true, internalDate: true }, { uid: true })) {
          // internalDate 可能是 Date 也可能是字符串，两种都处理
          const raw = msg.internalDate;
          const internal =
            raw instanceof Date ? raw.getTime() : raw ? Date.parse(String(raw)) : 0;
          const header = msg.envelope?.date ? new Date(msg.envelope.date).getTime() : 0;
          // 服务器接收时间(internalDate)比发件人写的 Date 头可靠 → 优先用它
          metas.push({ uid: msg.uid, at: internal || header });
        }
      }
      if (metas.length === 0) return [];

      metas.sort((a, b) => b.at - a.at); // 时间倒序：新的在前
      const wanted = metas.slice(0, limit).map((m) => m.uid);

      // 3) 再取这 N 封的完整正文（UID 列表很短，命令不会超长）
      for await (const msg of client.fetch(wanted, { source: { maxLength: maxBytes } }, { uid: true })) {
        const source = msg.source;
        if (!source) continue;
        // internalDate = 服务器接收时间，比发件人写的 Date 头可靠。
        // 存进 meta 是为了让下游（Web UI 排序）能拿到准确的收件时间。
        const raw = msg.internalDate;
        const internalDate =
          raw instanceof Date
            ? raw.toISOString()
            : raw
              ? new Date(String(raw)).toISOString()
              : '';
        out.push(
          toEmail(source, {
            // mailbox 也要记 —— 前端技术信息里要显示真实的邮箱夹，不能写死 INBOX
            meta: { uid: msg.uid, provider: cfg.host, internalDate, mailbox: cfg.mailbox },
          }),
        );
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    // 把服务器原文带出来（"Command failed" 这种信息量为零的错误等于没报错）
    throw new Error(describeImapError(e));
  } finally {
    // 无论成败都断开，不留连接
    await client.logout().catch(() => undefined);
  }

  return out;
}
/**
 * 连通性自检：只验证"能不能登录、能看到哪些邮箱夹"，【不取任何邮件】。
 * 用 imapflow 的 verifyOnly 模式 —— 相当于登录一下就退，绝不碰邮箱内容。
 */
export async function verifyImap(cfg: ImapConfig): Promise<{
  ok: boolean;
  mailboxes: string[];
  message: string;
}> {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    disableAutoIdle: true,
    verifyOnly: true,        // 登录后只列邮箱夹就退出
    includeMailboxes: true,
    tls: { rejectUnauthorized: process.env.MAIL_TLS_REJECT_UNAUTHORIZED !== '0' },
  });

  try {
    await client.connect();
    const boxes = await client.list();
    const names = boxes.map((b) => b.path);
    return {
      ok: true,
      mailboxes: names,
      message: `登录成功，发现 ${names.length} 个邮箱夹`,
    };
  } catch (e) {
    return {
      ok: false,
      mailboxes: [],
      message: `登录失败：${describeImapError(e)}`,
    };
  } finally {
    await client.logout().catch(() => undefined);
  }
}
