/**
 * mailbox/types.ts —— ③a Email 数据模型 + MIME 清洗（纯函数，好测）。
 *
 * 【设计约束：不落盘】
 *   本项目的原始邮件【不写入磁盘】—— 只在内存里分析完就丢。
 *   所以这一层只有纯函数：拉回来 → 洗成纯文本 → 传给管线 → 扔掉。
 *
 * 【为什么 MIME 清洗要自己写】
 *   邮件正文可能是 multipart（文本+HTML+附件）、可能是 base64/quoted-printable 编码、
 *   还可能是 GBK/Big5 中文编码。三件事都要处理：
 *     1. 拆 multipart，挑出正文（text/plain 优先，没有再用 text/html 转纯文本）
 *     2. 解 transfer-encoding（base64 / quoted-printable）
 *     3. 按 charset 解码（Node 内置 TextDecoder 支持 utf-8 / gbk / gb18030 / big5，
 *        不需要为了中文邮件再引一个编码库）
 */

import { createHash } from 'node:crypto';

/** 一封邮件。body 永远是纯文本，labels 是我们自己打的分类标签。 */
export interface Email {
  /** 内容哈希截断 12 位 —— 同一封邮件重复拉不会产生第二条 */
  id: string;
  subject: string;
  sender: string;
  to: string[];
  /** ISO 字符串 */
  date: string;
  /** 纯文本正文（已截断到 MAX_BODY_CHARS） */
  body: string;
  /** 分类标签：urgent / normal / ignore … */
  labels: string[];
  /** 扩展字段：uid、messageId、原始 headers 摘要… */
  meta: Record<string, unknown>;
  /**
   * 附件（只存在于内存）。
   *
   * 【为什么不是必填】
   *   存量代码与测试都按「邮件没有附件」构造对象，加必填字段会让它们全挂。
   *   缺省即「没有附件」，语义和空数组一致。
   */
  attachments?: Attachment[];
}

/** 正文最大字符数。超了截断 —— 一封带巨型附件的邮件能把上下文撑爆。 */
export const MAX_BODY_CHARS = 20_000;

/**
 * 邮件 id = 内容哈希。
 * 用 sha1 是因为快、且这里不需要抗碰撞（不是安全用途，是去重键）。
 * 截断到 12 位：够短、够用、看着像 id。
 */
export function emailId(subject: string, date: string, from: string, body: string): string {
  const blob = `${subject}\u0000${date}\u0000${from}\u0000${body}`;
  return createHash('sha1').update(blob, 'utf8').digest('hex').slice(0, 12);
}

/* ========================= 附件解析 ========================= */

/**
 * 从 Content-Disposition / Content-Type 里取附件文件名。
 *
 * 【为什么这么麻烦】中文文件名在邮件里有三种写法，真实邮件三种都会遇到：
 *   1. RFC 2231 编码（最规范）：
 *        Content-Disposition: attachment; filename*=UTF-8''%E7%AE%80%E5%8E%86.pdf
 *   2. RFC 2047 编码（很多国内邮件客户端还在用）：
 *        Content-Disposition: attachment; filename="=?UTF-8?B?566A5Y6GLnBkZg==?="
 *   3. 直接写原始 UTF-8 / GBK（不合规但极常见），要靠 decodeBytes 猜
 * 三种都要试，取第一个非空的；全失败就退回 nameless。
 */
export function attachmentName(
  disposition: string,
  contentType: string,
  fallback: string,
): string {
  // ① RFC 2231：filename*=charset'lang'percent-encoded
  const ext = /filename\*\s*=\s*([^'"]*)'[^']*'([^;\r\n]+)/i.exec(disposition);
  if (ext) {
    const charset = (ext[1] || 'utf-8').trim().toLowerCase();
    const pct = ext[2].trim().replace(/^"|"$/g, '');
    // 【别用 decodeURIComponent】它固定按 UTF-8 解码并直接返回字符串，
    // 遇到 charset=gbk 就错了；而且解完再转回字节会二次破坏。
    // 正确做法：自己把 %XX 还原成原始字节，再交给 charset 解码。
    const bytes: number[] = [];
    for (let i = 0; i < pct.length; i++) {
      if (pct[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(pct.slice(i + 1, i + 3))) {
        bytes.push(parseInt(pct.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(pct.charCodeAt(i) & 0xff);
      }
    }
    const s = decodeBytes(Buffer.from(bytes), charset).trim();
    if (s) return s;
  }

  // ② 普通 filename=：值可能被 RFC 2047 编码过
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;\r\n]+))/i.exec(disposition);
  if (plain) {
    let name = (plain[1] ?? plain[2] ?? '').trim();
    if (name) {
      name = decodeRfc2047(name);
      // 没解出编码标记但出现替换字符 → 大概率是原始 GBK，按 GBK 再试一次
      if (name.includes('\uFFFD')) {
        const guess = decodeBytes(Buffer.from(name, 'latin1'), 'gb18030');
        if (!guess.includes('\uFFFD')) return guess.trim();
      }
      if (name.includes('=?')) return name; // 解不动就原样保留，别丢文件名
      return name;
    }
  }

  // ③ name=（少数邮件写在 Content-Type 里）
  const named = /name\s*=\s*(?:"([^"]*)"|([^;\r\n]+))/i.exec(contentType);
  if (named) {
    const name = decodeRfc2047((named[1] ?? named[2] ?? '').trim());
    if (name) return name;
  }

  return fallback;
}

/** 扩展名 → 兜底 MIME。附件头没写 Content-Type 时靠它猜。 */
const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

/** 按扩展名猜 MIME（猜不到就给 octet-stream，浏览器会当下载处理）。 */
export function guessMime(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename);
  return (m && EXT_MIME[m[1].toLowerCase()]) || 'application/octet-stream';
}

/**
 * 判断一个 MIME part 是不是「附件」。
 *
 * 【为什么不能只看 application/*】
 *   邮件有两种"附件"：
 *     · 显式附件：Content-Disposition: attachment（不管什么类型都是附件）
 *     · 内嵌资源：inline 且带 filename（正文里引用的图片）
 *   而正文的 text/plain、text/html 通常没有 disposition。
 *   还有一种坑：有些邮件把 PDF 直接当 part 塞进来，却不写 disposition ——
 *   此时只能靠 Content-Type 不是 text/* 来判断。
 */
export function isAttachmentPart(headers: Record<string, string>): boolean {
  const cd = headers['content-disposition'] ?? '';
  // 【缺省必须是 text/plain】RFC 2045 规定没有 Content-Type 就是 text/plain。
  //   这里若取空串，下面「不是 text/* 就当附件」的兜底会把纯文本正文判成附件，
  //   整封邮件的正文直接消失 —— 实测就是这样丢了 4 条测试。
  const ct = (headers['content-type'] ?? 'text/plain').toLowerCase();
  if (/^\s*attachment/i.test(cd)) return true;
  // inline 且带 filename → 内嵌图片，也算附件（用户要能看到它）
  if (/^\s*inline/i.test(cd) && /filename|name\s*=/i.test(cd)) return true;
  // 没有任何 disposition，但类型明确不是正文 → 当附件
  if (!cd && !/^text\//i.test(ct) && !/^multipart\//i.test(ct) && !/^message\//i.test(ct)) {
    return true;
  }
  return false;
}

/** 把 part 的 transfer-encoding + charset 还原成原始字节。 */
function attachmentBytes(bytes: Buffer, headers: Record<string, string>): Buffer {
  const cte = (headers['content-transfer-encoding'] ?? '').toLowerCase().trim();
  if (cte === 'base64') {
    return Buffer.from(bytes.toString('latin1').replace(/\s+/g, ''), 'base64');
  }
  if (cte === 'quoted-printable') {
    return decodeQuotedPrintable(bytes.toString('latin1'));
  }
  return bytes;
}


/**
 * 一个附件。
 *
 * 【为什么要把字节留在内存里】
 *   界面要能「看」附件（PDF 预览、图片显示、其它下载），就必须有原始字节。
 *   但项目铁律是【不落盘】，所以只挂在内存的 Email 对象上，进程退出即消失。
 *   content 是 Buffer —— 绝不能直接 JSON.stringify 给前端（体积爆炸 + 乱码），
 *   对外只暴露 filename / contentType / size 三个字段。
 */
export interface Attachment {
  /** 文件名（已解 RFC 2047 / RFC 2231 编码，中文名能正常显示） */
  filename: string;
  /** MIME 类型，如 application/pdf、image/png */
  contentType: string;
  /** 字节数（解码后、编码前） */
  size: number;
  /** 原始字节 —— 只在服务端内存里转一圈，不落盘、不进 JSON 响应 */
  content: Buffer;
}

/** 单个附件上限 8MB；合计上限 24MB —— 防止一封巨型邮件把内存吃光。 */
export const MAX_ATTACHMENT_BYTES = 8_000_000;
export const MAX_TOTAL_ATTACHMENT_BYTES = 24_000_000;

/** 解析出来的原始邮件：头字段 + 两种正文候选 + 附件。 */
export interface ParsedMail {
  /** 头字段，键名小写 */
  headers: Record<string, string>;
  /** text/plain 正文（可能有，也可能空） */
  text: string;
  /** text/html 正文（可能有，也可能空） */
  html: string;
  /** 附件（PDF / 图片 / 压缩包…）；没有就是空数组 */
  attachments: Attachment[];
}

/* ========================= MIME 解析 ========================= */

/** 找 headers 与 body 的分隔位置（\r\n\r\n 或 \n\n）。 */
function findHeaderEnd(buf: Buffer): number {
  const crlf = buf.indexOf('\r\n\r\n');
  const lf = buf.indexOf('\n\n');
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return crlf;
  return lf >= 0 ? lf : -1;
}

/**
 * 解析头部。
 * 要点：头字段可以"折行"（续行以空格/制表符开头），要把续行接回上一行。
 */
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  let lastKey = '';

  for (const raw of lines) {
    if (!raw) continue;
    // 续行：以空白开头，接在上一个字段后面
    if (/^[ \t]/.test(raw) && lastKey) {
      out[lastKey] += ' ' + raw.trim();
      continue;
    }
    const idx = raw.indexOf(':');
    if (idx <= 0) continue;
    const key = raw.slice(0, idx).trim().toLowerCase();
    out[key] = raw.slice(idx + 1).trim();
    lastKey = key;
  }
  return out;
}

/** 从 Content-Type 头里取 charset（默认 utf-8）。 */
export function charsetOf(contentType: string): string {
  const m = /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType);
  return (m?.[1] ?? 'utf-8').toLowerCase();
}

/** 从 Content-Type 头里取 multipart 的 boundary。 */
export function boundaryOf(contentType: string): string | undefined {
  const m = /boundary\s*=\s*["']?([^"';\s]+)/i.exec(contentType);
  return m?.[1];
}

/**
 * 解 quoted-printable：=XX 是字节，=\n 是软换行（真正的换行是 =\r\n）。
 * 返回 Buffer —— 因为解出来的还是"原始字节"，要用什么字符集解是下一步的事。
 */
export function decodeQuotedPrintable(input: string): Buffer {
  const soft = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    if (soft[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(soft.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/**
 * 解 RFC 2047 编码的头部值：=?UTF-8?B?...?= / =?GBK?Q?...?=
 * 规范上中文主题必须这么编码，但很多邮件直接塞原始 UTF-8（不合规但常见），
 * 所以两种都要处理。
 */
export function decodeRfc2047(input: string): string {
  return input.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, charset: string, enc: string, data: string) => {
    try {
      if (enc.toUpperCase() === 'B') {
        const bytes = Buffer.from(data.replace(/\s+/g, ''), 'base64');
        return decodeBytes(bytes, charset);
      }
      // Q 编码：_ 表示空格，=XX 表示字节
      const s = data
        .replace(/_/g, ' ')
        .replace(/=([0-9A-Fa-f]{2})/g, (_x, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      return decodeBytes(Buffer.from(s, 'latin1'), charset);
    } catch {
      return m; // 解不了就原样留着，别把主题弄丢
    }
  });
}

/**
 * 头部字节 → 字符串。
 * 做法：先按 UTF-8 试解，如果出现替换字符（U+FFFD）说明不是合法 UTF-8 → 退回 latin1；
 * 最后再解 RFC 2047 编码的字段值。
 */
export function decodeHeaderBytes(buf: Buffer): string {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  const s = utf8.includes('\uFFFD') ? buf.toString('latin1') : utf8;
  return decodeRfc2047(s);
}

/** 按 charset 解码字节。Node 内置 TextDecoder 已支持中文常见编码。 */
export function decodeBytes(bytes: Buffer, charset: string): string {
  const cs = charset.toLowerCase();
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes); // 未知编码退回 utf-8，不抛
  }
}

/** 把一个 body part 的字节解成字符串（处理 transfer-encoding + charset）。 */
export function decodePart(bytes: Buffer, headers: Record<string, string>): string {
  const ct = headers['content-type'] ?? 'text/plain; charset=utf-8';
  const cte = (headers['content-transfer-encoding'] ?? '').toLowerCase().trim();

  let raw: Buffer;
  if (cte === 'base64') {
    raw = Buffer.from(bytes.toString('latin1').replace(/\s+/g, ''), 'base64');
  } else if (cte === 'quoted-printable') {
    raw = decodeQuotedPrintable(bytes.toString('latin1'));
  } else {
    raw = bytes;
  }
  return decodeBytes(raw, charsetOf(ct));
}

/** 按 boundary 把 multipart 的 body 拆成若干 part（每个 part 是 {head, body}）。 */
export function splitMultipart(body: Buffer, boundary: string): Array<{
  head: string;
  body: Buffer;
}> {
  const marker = Buffer.from('--' + boundary, 'latin1');
  const parts: Array<{ head: string; body: Buffer }> = [];

  let pos = body.indexOf(marker);
  if (pos < 0) return parts;

  while (pos >= 0) {
    const start = pos + marker.length;
    // 结束标记 "--boundary--"
    if (body.slice(start, start + 2).toString('latin1') === '--') break;

    const next = body.indexOf(marker, start);
    if (next < 0) break;

    // 去掉 boundary 行尾的换行
    let segStart = start;
    if (body.slice(segStart, segStart + 2).toString('latin1') === '\r\n') segStart += 2;
    else if (body[segStart] === 0x0a) segStart += 1;

    let segEnd = next;
    // 去掉分隔符前的换行
    if (body.slice(segEnd - 2, segEnd).toString('latin1') === '\r\n') segEnd -= 2;
    else if (body[segEnd - 1] === 0x0a) segEnd -= 1;

    const seg = body.subarray(segStart, segEnd);
    const hEnd = findHeaderEnd(seg);
    if (hEnd >= 0) {
      parts.push({
        head: seg.subarray(0, hEnd).toString('latin1'),
        body: seg.subarray(hEnd + (body.slice(hEnd, hEnd + 4).toString('latin1') === '\r\n\r\n' ? 4 : 2)),
      });
    }
    pos = next;
  }
  return parts;
}

/**
 * 解析一封原始邮件（IMAP 返回的原始字节）。
 * 正文挑取规则：text/plain 优先；没有 plain 才用 text/html（后面转纯文本）。
 */
export function parseMime(raw: Buffer): ParsedMail {
  const hEnd = findHeaderEnd(raw);
  if (hEnd < 0) {
    return { headers: {}, text: decodeBytes(raw, 'utf-8'), html: '', attachments: [] };
  }
  // 头部：先按 UTF-8/latin1 判断，再解 RFC2047（中文主题两种都常见）
  const headers = parseHeaders(decodeHeaderBytes(raw.subarray(0, hEnd)));
  const skip = raw.slice(hEnd, hEnd + 4).toString('latin1') === '\r\n\r\n' ? 4 : 2;
  const bodyBuf = raw.subarray(hEnd + skip);

  const ct = headers['content-type'] ?? 'text/plain; charset=utf-8';
  const boundary = boundaryOf(ct);

  let text = '';
  let html = '';
  const attachments: Attachment[] = [];

  if (boundary && /multipart\//i.test(ct)) {
    for (const part of splitMultipart(bodyBuf, boundary)) {
      const ph = parseHeaders(part.head);
      const pct = ph['content-type'] ?? 'text/plain; charset=utf-8';

      // 【递归】处理嵌套 multipart
      //
      // 【为什么必须有】真实邮件里最常见的结构是两层：
      //     multipart/mixed
      //       └─ multipart/alternative
  //            ├─ text/plain   ← 真正的正文在这
      //            └─ text/html
      // 只拆一层的话，alternative 既不是 text/plain 也不是 text/html → 被当附件丢掉 →
      // 正文全空。实测案例：绿盟科技「面试邀请」邮件（mail.mokahr.com）就是这个结构，
      // 结果是"面试时间"这类问题根本无从检索、也无从回答。
      //
      // 递归时要把 part 的头和体重新拼成一份完整的邮件字节，再交给 parseMime 自己处理。
      if (/multipart\//i.test(pct)) {
        const inner = parseMime(
          Buffer.concat([
            Buffer.from(part.head, 'latin1'),
            Buffer.from('\r\n\r\n', 'latin1'),
            part.body,
          ]),
        );
        if (inner.text) text += inner.text + '\n';
        if (inner.html) html += inner.html + '\n';
        // 附件也要从内层带出来 —— 否则 mixed→alternative 结构里的附件永远出不来
        attachments.push(...inner.attachments);
        continue;
      }

      // 【附件先判定】必须排在 text/plain 分支前面：
      //   text/calendar、text/csv 这类也是 text/*，但它们不是正文。
      //   以前这里直接 continue 丢掉，前端就永远看不到附件。
      if (isAttachmentPart(ph)) {
        const att = readAttachment(ph, part.body, attachments.length);
        if (att) attachments.push(att);
        continue;
      }

      if (/text\/plain/i.test(pct)) {
        text += decodePart(part.body, ph) + '\n';
      } else if (/text\/html/i.test(pct)) {
        html += decodePart(part.body, ph) + '\n';
      }
    }
  } else if (isAttachmentPart(headers)) {
    const att = readAttachment(headers, bodyBuf, 0);
    if (att) attachments.push(att);
  } else if (/text\/html/i.test(ct)) {
    html = decodePart(bodyBuf, headers);
  } else {
    text = decodePart(bodyBuf, headers);
  }

  // 超出总量上限就截断（从尾部丢），保证一封巨型邮件不会把内存吃光
  const capped: Attachment[] = [];
  let total = 0;
  for (const a of attachments) {
    if (total + a.size > MAX_TOTAL_ATTACHMENT_BYTES) break;
    total += a.size;
    capped.push(a);
  }

  return { headers, text: sanitizePlain(text), html: html.trim(), attachments: capped };
}

/**
 * 把一个 part 读成 Attachment；太大或读不出内容就返回 null（宁可少一个附件，不要抛异常）。
 * index 只用于生成占位文件名。
 */
function readAttachment(
  headers: Record<string, string>,
  body: Buffer,
  index: number,
): Attachment | null {
  let bytes: Buffer;
  try {
    bytes = attachmentBytes(body, headers);
  } catch {
    return null;
  }
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) return null;

  const rawCt = headers['content-type'] ?? '';
  const cd = headers['content-disposition'] ?? '';
  const name = attachmentName(cd, rawCt, `附件${index + 1}`);
  // 头里没写类型（或写的是 octet-stream）→ 按扩展名猜，否则浏览器不认识
  let contentType = rawCt.split(';')[0].trim().toLowerCase();
  if (!contentType || contentType === 'application/octet-stream') {
    contentType = guessMime(name);
  }

  return { filename: name, contentType, size: bytes.length, content: bytes };
}

/**
 * 清洗 text/plain 正文 —— 剥掉 HTML/脚本残留。
 *
 * 【为什么 text/plain 也要洗】
 *   规范上 text/plain 不该有 HTML，但真实世界不守规矩。
 *   实测案例：QQ 日历提醒邮件的 text/plain part（base64 编码）里
 *   塞了一整段 <script> 日历渲染代码 —— 于是正文变成：
 *     "你在QQ邮箱日历中为这一事件设置了提醒
 *      0?between:lunarYearDays.yearDays-Math.abs(between);var{monthDays}=..."
 *   这段东西对"这封邮件要紧吗"毫无意义，却会：
 *     ① 撑爆 token（白花钱）
 *     ② 污染 LLM 判断（它看到一堆代码，可能误判）
 *     ③ 直接显示在 Web UI 上（用户看到一堆 JS 源码）
 *
 *   所以这里统一剥掉 <script>/<style>/注释，再把残留标签去掉。
 *   注意：<script> 的正则要能处理"开标签和闭标签被截断"的情况 ——
 *   那种情况正则匹配不上，所以还要兜一层"疑似脚本内容"检测。
 */
export function sanitizePlain(input: string): string {
  if (!input) return '';
  let s = input;

  // ① 完整的 script / style 块
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  // ② 没闭合的 script（开标签在，闭标签丢了）—— 从 <script 一直删到结尾
  s = s.replace(/<script\b[\s\S]*$/gi, ' ');
  // ③ HTML 注释
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // ④ 残留标签
  s = s.replace(/<[^>]+>/g, ' ');

  // ⑤ 【关键】剥掉"裸露的代码块"
  //    真实案例：QQ 日历提醒邮件的 text/plain part 里，
  //    <script> 标签在 base64 解码过程中丢了，只剩裸 JS 源码 ——
  //    于是前面的正则全部匹配不到。
  //    特征很好认：连续的 JS 关键字 + 分号 + 括号。
  //    做法：从"第一个像代码的位置"开始，删到"最后一个像代码的位置"结束。
  s = stripBareCode(s);

  // ⑥ 空白规范化
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * 剥掉裸露的代码块（没有 HTML 标签包裹的 JS/CSS/JSON 片段）。
 *
 * 【判定策略】
 *   不追求"精确识别代码"—— 那需要真正的解析器。
 *   用"特征密度"启发式：连续多个代码特征 → 认定是代码 → 整段删。
 *
 *   代码特征（任一）：
 *     · 变量声明：var/let/const 后跟标识符
 *     · 函数定义：function 名字(
 *     · 控制流：if(...)/for(...)/while(...)
 *     · 语句结束：}  或  ;
 *     · 常见 API：document. / window. / var 关键字 / JSON 结构
 *
 * 【为什么这样就够】
 *   我们的目标是"别让代码污染邮件语义"，不是"完美还原正文"。
 *   误删一小段普通文字的代价 << 让几百行 JS 灌进 LLM 的代价。
 */
function stripBareCode(input: string): string {
  // 代码特征密集的片段
  const CODEISH = /(?:^|[\s;{}()\[\]])(?:var|let|const|function|return|if|for|while|switch|case|break|continue|new|typeof|instanceof)\s*[\w(]/;
  const APIISH = /\b(?:document|window|navigator|location|console|JSON|Math|Array|Object|String|Number|Date|RegExp)\s*[.[]/;
  // 分号后紧跟标识符= 赋值（JS 特征很强）
  const ASSIGN = /;\s*(?:var|let|const|function|if|for|while|return)\b/;

  // 逐行找代码起点
  const lines = input.split('\n');
  let inCode = false;
  let codeScore = 0;
  const kept: string[] = [];

  for (const line of lines) {
    const score =
      (CODEISH.test(line) ? 1 : 0) +
      (APIISH.test(line) ? 1 : 0) +
      (ASSIGN.test(line) ? 1 : 0);

    if (!inCode) {
      // 一行里就命中 ≥2 个特征 → 立刻判定进入代码
      if (score >= 2) {
        inCode = true;
        codeScore = score;
        continue;
      }
      kept.push(line);
    } else {
      codeScore += score;
      // 连续 3 行都不像代码 → 认为代码块结束
      if (score === 0) {
        codeScore -= 1;
        if (codeScore <= -2) {
          inCode = false;
          codeScore = 0;
        }
      }
    }
  }

  return kept.join('\n');
}

/* ========================= HTML → 纯文本 ========================= */

/** 常见 HTML 实体。 */
const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  hellip: '…', mdash: '—', ndash: '–', middot: '·', copy: '©', reg: '®',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', times: '×', divide: '÷',
};

/** 解 HTML 实体（命名实体 + 数字实体）。 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g: string) => {
    if (g.startsWith('#x') || g.startsWith('#X')) {
      const code = parseInt(g.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    if (g.startsWith('#')) {
      const code = parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const hit = ENTITIES[g.toLowerCase()];
    return hit ?? m;
  });
}

/**
 * HTML → 纯文本。
 * 顺序很重要：先去 script/style（里面的文字不是正文），再把块级标签换成换行，
 * 最后才剥剩下的标签 —— 反过来的话换行会丢。
 */
export function htmlToText(html: string): string {
  if (!html) return '';

  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, ' ');

  // 块级标签 → 换行（保留段落结构）
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|table|ul|ol|blockquote|section|article|header|footer)\s*>/gi, '\n');
  s = s.replace(/<\s*(p|div|tr|li|h[1-6]|table|ul|ol|blockquote|section|article|header|footer)\b[^>]*>/gi, '\n');

  // 剩下的标签剥掉
  s = s.replace(/<[^>]+>/g, ' ');

  s = decodeEntities(s);
  // 规范化空白：行内压成单空格，连续空行压成两行
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 默认时区。邮件里的时间是本地时间，按天分组也必须用本地时区。 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/**
 * 取日期键（YYYY-MM-DD），用于"按天查询"。
 *
 * 【为什么要指定时区】
 *   邮件头里的时间是本地时间（"Sat, 31 Oct 2026 03:00:00 +0800"）。
 *   换算成 UTC 就变成 10月30日 —— 于是"10月31日收到的邮件"被分到了 10月30日，
 *   晨报的"今天"就错了。所以一律按【用户所在时区】分组。
 */
export function dateKey(date: string, timeZone: string = DEFAULT_TIMEZONE): string {
  if (!date) return '';
  // 已经是纯日期（没有时间部分）→ 原样返回
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const t = Date.parse(date);
  if (!Number.isFinite(t)) return '';
  return formatInZone(new Date(t), timeZone, 'date');
}

/** 把时间格式化成指定时区的 'YYYY-MM-DD HH:mm'。 */
export function formatLocal(date: string, timeZone: string = DEFAULT_TIMEZONE): string {
  if (!date) return '';
  const t = Date.parse(date);
  if (!Number.isFinite(t)) return date;
  const d = formatInZone(new Date(t), timeZone, 'date');
  const hm = formatInZone(new Date(t), timeZone, 'hm');
  return `${d} ${hm}`;
}

/** 内部：按时区格式化（'date' → 2026-11-03；'hm' → 09:12）。 */
function formatInZone(d: Date, timeZone: string, kind: 'date' | 'hm'): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(kind === 'hm' ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
    });
    const parts = fmt.formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    if (kind === 'date') return `${get('year')}-${get('month')}-${get('day')}`;
    return `${get('hour')}:${get('minute')}`;
  } catch {
    // 时区名写错时退回 UTC，别让整个程序挂掉
    return kind === 'date' ? d.toISOString().slice(0, 10) : d.toISOString().slice(11, 16);
  }
}

/**
 * 把一封原始邮件变成 Email 对象。
 * 这是"原始字节 → 可分析对象"的唯一入口。
 */
export function toEmail(raw: Buffer, extra: Partial<Email> = {}): Email {
  const parsed = parseMime(raw);
  const subject = parsed.headers['subject'] ?? '';
  const from = parsed.headers['from'] ?? '';
  const rawDate = parsed.headers['date'] ?? '';

  // 正文选择：优先 text/plain，但要看它是不是"占位符"。
  //
  // 【真实案例】绿盟科技「面试邀请」邮件（Outlook 模板）：
  //   text/plain  = "新面试"            ← 只有 3 个字，是日历占位文本
  //   text/html   = 16064 字节          ← 真正的内容在这（日期/时间/会议链接/联系人）
  // 只按"plain 非空就用它"的规则，会把整封邮件的内容丢掉 ——
  // 检索能命中这封邮件，但正文里没有面试时间，模型自然答不出来。
  //
  // 【判定规则】plain 短到明显是占位符（< 20 字）时，才考虑换成 HTML 版；
  // 而且 HTML 版还得明显更丰富（至少 3 倍且不少于 20 字）。
  // 这样既救回占位符邮件，又不会把本来就完整的 plain 换成满是模板噪音的 html。
  const PLACEHOLDER_MAX_CHARS = 20;
  let body = parsed.text;
  const htmlText = parsed.html ? htmlToText(parsed.html) : '';
  const plainLooksLikePlaceholder = body.length < PLACEHOLDER_MAX_CHARS;
  if (plainLooksLikePlaceholder && htmlText.length >= 20 && htmlText.length > body.length * 3) {
    body = htmlText;
  } else if (!body) {
    body = htmlText;
  } else if (body && /<\s*(html|body|div|p|br|table|span|img|a)\b/i.test(body)) {
    body = htmlToText(body);
  }
  body = body.slice(0, MAX_BODY_CHARS);

  // 日期统一成 ISO —— 排序、算"第几天"都靠它
  const t = Date.parse(rawDate);
  const date = extra.date ?? (Number.isFinite(t) ? new Date(t).toISOString() : rawDate);

  return {
    id: extra.id ?? emailId(subject, date, from, body),
    subject: decodeEntities(subject),
    sender: from,
    to: (parsed.headers['to'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    date,
    body,
    labels: extra.labels ?? [],
    // 附件只放内存：Content 是 Buffer，进城后不会序列化出去
    attachments: parsed.attachments.length ? parsed.attachments : undefined,
    meta: {
      messageId: parsed.headers['message-id'] ?? '',
      ...extra.meta,
    },
  };
}
