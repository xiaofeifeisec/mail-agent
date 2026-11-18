/**
 * mailbox/smtp.ts —— 极简 SMTP 客户端（只发信，不收信）。
 *
 * 【为什么不引 nodemailer】
 * 这个项目的成色是"从零搭" —— 现在只有 imapflow 一个依赖。
 * SMTP 协议的核心流程就 8 条命令，用 Node 内置的 tls/socket 就能写完，
 * 而且【写一遍能看清每一步】。引一个库反而把协议细节藏起来了。
 *
 * 【发送流程（SMTP 的标准顺序）】
 *   1. 连上 → 读 220 greeting
 *   2. EHLO <domain> → 读 250 + 能力列表
 *   3. AUTH LOGIN → 334 → base64(user) → 334 → base64(pass) → 235
 *   4. MAIL FROM:<发件人> → 250
 *   5. RCPT TO:<收件人>   → 250        （可以多次，收多个人）
 *   6. DATA              → 354
 *   7. 发信正文，以 "\r\n.\r\n" 结束 → 250
 *   8. QUIT              → 221
 *
 * 【两个容易踩的坑】
 *   ① 点行（"." 开头）会被当成结束标记 —— 正文里的 "." 必须转义成 ".."
 *   ② 正文必须用 CRLF 换行，不是 LF
 *
 * 【安全】这个模块有【真实外部副作用】—— 信真的会发出去。
 *   所以它【只负责发】，不负责决定发什么、发给谁。
 *   那些决策在上层（agent 的审批流）。
 */

import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

/* ============================== 类型 ============================== */

/** SMTP 连接参数。 */
export interface SmtpConfig {
  /** SMTP 服务器地址，如 smtp.qq.com */
  host: string;
  /** 端口：465 = 隐式 TLS，587 = 明文 + STARTTLS */
  port: number;
  /** true = 直接 TLS（465）；false = 先明文再 STARTTLS（587） */
  secure: boolean;
  /** 登录账号（一般是完整邮箱地址） */
  user: string;
  /** 授权码 / 应用专用密码（不是登录密码！） */
  pass: string;
  /** 发信时用的域名（EHLO 用） */
  helo?: string;
  /** 单次发送超时（毫秒） */
  timeoutMs?: number;
}

/** 一封要发出去的邮件。 */
export interface OutgoingMail {
  /** 发件人地址（通常是登录账号） */
  from: string;
  /** 收件人（可多个） */
  to: string[];
  /** 抄送（可多个） */
  cc?: string[];
  /** 主题（会自动处理中文编码） */
  subject: string;
  /** 正文（纯文本） */
  text: string;
  /** HTML 正文（可选，与 text 同时给时 multipart/alternative） */
  html?: string;
  /** 附件内容（可选） */
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
  /** 引用回复的原邮件（会带上 In-Reply-To / References） */
  inReplyTo?: string;
}

/** 发送结果。 */
export interface SendResult {
  ok: boolean;
  /** 服务器返回的最终状态码 */
  code: number;
  /** 服务器返回的文本 */
  message: string;
  /** 完整协议对话（排障用） */
  transcript: string[];
}

/** 发信失败时抛出的异常。 */
export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly transcript: string[] = [],
  ) {
    super(message);
    this.name = 'SmtpError';
  }
}

/* ============================== 邮件报文构造 ============================== */

/** MIME 边界（每次发信随机生成，避免撞车）。 */
function makeBoundary(): string {
  return `--=_mailagent_${randomBytes(12).toString('hex')}`;
}

/**
 * 把主题编码成 MIME 编码字。
 *
 * 【为什么要编码】SMTP 协议本身只支持 ASCII。
 * 中文主题直接发会变成乱码（或被服务器拒收）。
 * 标准做法是 `=?UTF-8?B?<base64>?=`。
 *
 * 纯 ASCII 主题原样返回 —— 英文主题不该被无谓地编码。
 */
export function encodeHeaderValue(value: string): string {
  // 已经是 MIME 编码过的就别再编码一层
  if (/^=\?[^?]+\?[BbQq]\?/.test(value)) return value;

  // 纯 ASCII → 原样
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7E]/.test(value)) return value;

  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * 处理正文里的点行。
 *
 * SMTP 规定：正文中单独一行的 "." 表示正文结束。
 * 所以正文里以 "." 开头的行必须变成 ".."（转义）。
 * 这是最容易漏的一个坑 —— 漏了会导致邮件被截断。
 *
 * 【注意】必须保留原来的换行符（CRLF 还是 LF）。
 * 之前写成 `'\n..'` 会把 CRLF 的 `\r` 吃掉 —— 整个邮件格式就坏了。
 */
export function escapeDots(text: string): string {
  return text.replace(/(\r?\n)\./g, '$1..');
}

/**
 * 构造完整的 MIME 报文。
 *
 * 为什么要自己构造而不是用库：
 * 这就是"邮件长什么样"的真相 —— 头 + 空行 + 正文。
 * 看懂这个就懂 MIME 了。
 */
export function buildMessage(mail: OutgoingMail, fromName?: string): string {
  const boundary = makeBoundary();
  const lines: string[] = [];

  // ── 头部 ──
  const fromDisplay = fromName ? `${encodeHeaderValue(fromName)} <${mail.from}>` : `<${mail.from}>`;
  lines.push(`From: ${fromDisplay}`);
  lines.push(`To: ${sanitizeAddressList(mail.to).join(', ')}`);
  if (mail.cc?.length) lines.push(`Cc: ${sanitizeAddressList(mail.cc).join(', ')}`);
  lines.push(`Subject: ${encodeHeaderValue(mail.subject)}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push(`Message-ID: <${randomBytes(16).toString('hex')}@${mail.from.split('@')[1] ?? 'localhost'}>`);
  lines.push(`MIME-Version: 1.0`);

  // 引用原邮件（这样在 QQ 邮箱里会显示成"回复"而不是新邮件）
  if (mail.inReplyTo) {
    lines.push(`In-Reply-To: ${mail.inReplyTo}`);
    lines.push(`References: ${mail.inReplyTo}`);
  }

  const hasAttachments = (mail.attachments?.length ?? 0) > 0;

  if (!hasAttachments && !mail.html) {
    // 纯文本 —— 最简单的情况
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    // 正文用 base64：避免换行/编码的各种坑
    lines.push(wrapBase64(Buffer.from(mail.text, 'utf8').toString('base64')));
    return lines.join('\r\n') + '\r\n';
  }

  if (!hasAttachments && mail.html) {
    // text + html → multipart/alternative
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(wrapBase64(Buffer.from(mail.text, 'utf8').toString('base64')));
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(wrapBase64(Buffer.from(mail.html, 'utf8').toString('base64')));
    lines.push('');
    lines.push(`--${boundary}--`);
    return lines.join('\r\n') + '\r\n';
  }

  // 有附件 → multipart/mixed（内层再套 alternative）
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push('');
  lines.push(`--${boundary}`);
  lines.push('Content-Type: multipart/alternative; boundary="${boundary}-alt"');
  lines.push('');
  lines.push(`--${boundary}-alt`);
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(wrapBase64(Buffer.from(mail.text, 'utf8').toString('base64')));
  lines.push('');
  lines.push(`--${boundary}-alt`);
  lines.push('Content-Type: text/html; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(wrapBase64(Buffer.from(mail.html ?? '', 'utf8').toString('base64')));
  lines.push('');
  lines.push(`--${boundary}-alt--`);
  lines.push('');

  for (const att of mail.attachments ?? []) {
    lines.push(`--${boundary}`);
    lines.push(
      `Content-Type: ${att.contentType ?? 'application/octet-stream'}; name="${encodeHeaderValue(att.filename)}"`,
    );
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${encodeHeaderValue(att.filename)}"`);
    lines.push('');
    lines.push(wrapBase64(att.content.toString('base64')));
    lines.push('');
  }

  lines.push(`--${boundary}--`);
  return lines.join('\r\n') + '\r\n';
}

/** base64 按 76 字符折行（MIME 要求）。 */
function wrapBase64(b64: string): string {
  return b64.match(/.{1,76}/g)?.join('\r\n') ?? b64;
}

/* ============================== SMTP 客户端 ============================== */

/**
 * 收件人里去掉换行（防命令注入）。
 *
 * 【为什么两处都要清】
 * ① 头部（To:/Cc:）—— CRLF 能注入额外头部
 * ② 命令行（RCPT TO:）—— CRLF 能直接插入一条新的 SMTP 命令
 * 一次都不能漏。
 */
function sanitizeAddress(addr: string): string {
  return addr.replace(/[\r\n]/g, '').trim();
}

/** 头部里的地址列表也要清洗。 */
function sanitizeAddressList(list: string[]): string[] {
  return list.map(sanitizeAddress).filter(Boolean);
}

class SmtpSession {
  readonly transcript: string[] = [];
  #sock: TLSSocket | Socket;
  #buf = '';

  constructor(sock: TLSSocket | Socket) {
    this.#sock = sock;
  }

  get socket(): TLSSocket | Socket {
    return this.#sock;
  }

  log(line: string): void {
    this.transcript.push(line);
  }

  /** 读一条 SMTP 响应（多行响应会合并）。 */
  async readResponse(timeoutMs: number): Promise<{ code: number; lines: string[] }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new SmtpError('读 SMTP 响应超时', 0, this.transcript));
      }, timeoutMs);

      const onData = (chunk: Buffer) => {
        this.#buf += chunk.toString('utf8');
        const lines = this.#buf.split(/\r?\n/).filter((l) => l.length > 0);
        const last = lines[lines.length - 1] ?? '';
        // 末行必须是 "250 " 这种（不是 "250-" 续行）
        if (/^\d{3} /.test(last)) {
          cleanup();
          this.#buf = '';
          resolve({ code: Number(last.slice(0, 3)), lines });
        }
      };
      const onError = (e: Error) => {
        cleanup();
        reject(new SmtpError(`SMTP 连接错误：${e.message}`, 0, this.transcript));
      };
      const onClose = () => {
        cleanup();
        reject(new SmtpError('SMTP 连接被关闭', 0, this.transcript));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.#sock.off('data', onData);
        this.#sock.off('error', onError);
        this.#sock.off('close', onClose);
      };

      this.#sock.on('data', onData);
      this.#sock.on('error', onError);
      this.#sock.on('close', onClose);
    });
  }

  /**
   * 写一行命令。
   * 【安全】sensitive=true 时，transcript 里只留占位符 —— 认证凭证（授权码的
   * base64）绝不能进 transcript，否则一旦发信失败被回显，等于把密码交出去。
   * 真正写到 socket 的仍是原文，不影响认证本身。
   */
  write(line: string, sensitive = false): void {
    const logged = sensitive
      ? 'C: <认证凭证已脱敏>'
      : `C: ${line.length > 90 ? line.slice(0, 90) + '…' : line}`;
    this.log(logged);
    this.#sock.write(line + '\r\n');
  }
}

/**
 * 发一封邮件。
 *
 * ⚠️ **这会真的把信发出去** —— 不可撤销（除非对方还没读，你自己去 IMAP 里撤）。
 * 所以调用方必须先做人工确认。
 */
export async function sendMail(cfg: SmtpConfig, mail: OutgoingMail): Promise<SendResult> {
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  const helo = cfg.helo ?? 'localhost';
  const transcript: string[] = [];

  if (!mail.to.length && !mail.cc?.length) {
    throw new SmtpError('没有收件人', 0);
  }
  if (!mail.text.trim() && !mail.html?.trim()) {
    throw new SmtpError('正文是空的', 0);
  }

  // ① 建立连接
  const sock = cfg.secure
    ? tlsConnect({
        host: cfg.host,
        port: cfg.port,
        servername: cfg.host,
        // 【安全】默认校验证书；自签证书可设 MAIL_TLS_REJECT_UNAUTHORIZED=0 放宽
        rejectUnauthorized: process.env.MAIL_TLS_REJECT_UNAUTHORIZED !== '0',
      })
    : netConnect({ host: cfg.host, port: cfg.port });

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new SmtpError('连接超时', 0)), timeoutMs);
    sock.once(cfg.secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(t);
      resolve();
    });
    sock.once('error', (e) => {
      clearTimeout(t);
      reject(new SmtpError(`连接失败：${e.message}`, 0));
    });
  });

  const s = new SmtpSession(sock);

  try {
    // ② greeting
    const greeting = await s.readResponse(timeoutMs);
    s.log(`S: ${greeting.lines[0]}`);
    if (greeting.code !== 220) {
      throw new SmtpError(`服务器问候异常：${greeting.lines[0]}`, greeting.code, s.transcript);
    }

    // ③ EHLO
    s.write(`EHLO ${helo}`);
    const ehlo = await s.readResponse(timeoutMs);
    s.log(`S: ${ehlo.lines[0]}`);
    if (ehlo.code !== 250) {
      throw new SmtpError(`EHLO 失败：${ehlo.lines[0]}`, ehlo.code, s.transcript);
    }
    const caps = ehlo.lines.join('\n').toUpperCase();

    // ④ AUTH（优先 PLAIN，退回 LOGIN）
    if (!caps.includes('AUTH')) {
      throw new SmtpError('服务器不支持认证', ehlo.code, s.transcript);
    }
    await authenticate(s, cfg, caps, timeoutMs);

    // ⑤ MAIL FROM
    const from = sanitizeAddress(mail.from);
    s.write(`MAIL FROM:<${from}>`);
    const r1 = await s.readResponse(timeoutMs);
    s.log(`S: ${r1.lines[0]}`);
    if (r1.code !== 250) {
      throw new SmtpError(`MAIL FROM 被拒绝：${r1.lines[0]}`, r1.code, s.transcript);
    }

    // ⑥ RCPT TO（每个收件人一次）
    const recipients = [...mail.to, ...(mail.cc ?? [])].map(sanitizeAddress);
    for (const rcpt of recipients) {
      s.write(`RCPT TO:<${rcpt}>`);
      const r = await s.readResponse(timeoutMs);
      s.log(`S: ${r.lines[0]}`);
      if (r.code !== 250 && r.code !== 251) {
        throw new SmtpError(`收件人被拒绝（${rcpt}）：${r.lines[0]}`, r.code, s.transcript);
      }
    }

    // ⑦ DATA
    s.write('DATA');
    const r2 = await s.readResponse(timeoutMs);
    s.log(`S: ${r2.lines[0]}`);
    if (r2.code !== 354) {
      throw new SmtpError(`DATA 被拒绝：${r2.lines[0]}`, r2.code, s.transcript);
    }

    // ⑧ 正文 —— 点行要转义！
    const message = buildMessage(mail, cfg.user.split('@')[0]);
    const escaped = escapeDots(message);
    // 发完正文要用 CRLF + "." 结束
    sock.write(escaped.endsWith('\r\n') ? escaped + '.\r\n' : escaped + '\r\n.\r\n');
    s.log('C: <正文>');

    const r3 = await s.readResponse(timeoutMs);
    s.log(`S: ${r3.lines[0]}`);
    if (r3.code !== 250) {
      throw new SmtpError(`发送失败：${r3.lines[0]}`, r3.code, s.transcript);
    }

    // ⑨ QUIT
    s.write('QUIT');
    await s.readResponse(timeoutMs).catch(() => undefined);

    return {
      ok: true,
      code: r3.code,
      message: r3.lines[0],
      transcript: s.transcript,
    };
  } catch (e) {
    if (e instanceof SmtpError) {
      throw new SmtpError(e.message, e.code, e.transcript.length ? e.transcript : s.transcript);
    }
    throw new SmtpError((e as Error).message, 0, s.transcript);
  } finally {
    sock.destroy();
  }
}

/** 认证：优先 AUTH PLAIN（一次往返），退回 AUTH LOGIN（两次）。 */
async function authenticate(
  s: SmtpSession,
  cfg: SmtpConfig,
  caps: string,
  timeoutMs: number,
): Promise<void> {
  if (caps.includes('AUTH PLAIN')) {
    const payload = Buffer.from(`\0${cfg.user}\0${cfg.pass}`, 'utf8').toString('base64');
    s.write(`AUTH PLAIN ${payload}`, true);
    const r = await s.readResponse(timeoutMs);
    s.log(`S: ${r.lines[0]}`);
    if (r.code !== 235) {
      throw new SmtpError(`认证失败：${r.lines[0]}`, r.code, s.transcript);
    }
    return;
  }

  // AUTH LOGIN
  s.write('AUTH LOGIN');
  const r1 = await s.readResponse(timeoutMs);
  s.log(`S: ${r1.lines[0]}`);
  if (r1.code !== 334) {
    throw new SmtpError(`认证协商失败：${r1.lines[0]}`, r1.code, s.transcript);
  }

  s.write(Buffer.from(cfg.user, 'utf8').toString('base64'), true);
  const r2 = await s.readResponse(timeoutMs);
  s.log(`S: ${r2.lines[0]}`);
  if (r2.code !== 334) {
    throw new SmtpError(`用户名被拒绝：${r2.lines[0]}`, r2.code, s.transcript);
  }

  s.write(Buffer.from(cfg.pass, 'utf8').toString('base64'), true);
  const r3 = await s.readResponse(timeoutMs);
  s.log(`S: ${r3.lines[0]}`);
  if (r3.code !== 235) {
    throw new SmtpError(`认证失败：${r3.lines[0]}`, r3.code, s.transcript);
  }
}

/* ============================== 指纹（幂等去重） ============================== */

/**
 * 算一封邮件的"回复指纹" —— 用来判断"这封信是不是已经发过了"。
 *
 * 【为什么需要】
 * 用户点了两次"发送"、或者网络超时重试，都可能重复发信。
 * 发出去的邮件撤不回来，所以宁可漏发也不能重发。
 */
export function sendFingerprint(mail: OutgoingMail): string {
  const payload = [
    mail.from,
    [...mail.to].sort().join(','),
    mail.subject,
    mail.text.trim(),
  ].join('|');
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16);
}
