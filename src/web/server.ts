/**
 * src/web/server.ts —— Web UI 的后端。
 *
 * 【为什么用 Node 内置 http】
 *   项目至今零第三方依赖（除了 imapflow），加 express 就要多背一个依赖树。
 *   Node 22 的内置 http 完全够用 —— 这个服务只有 6 个接口。
 *
 * 【安全边界（重要）】
 *   这个服务只监听 127.0.0.1 —— 不对外网暴露。
 *   它能做的事：读你的邮箱、调你的模型。这两件事都不该暴露到公网。
 *   真要远程访问，必须先加身份认证 + TLS —— 那不是这个教学项目该做的事。
 *
 * 【接口清单】
 *   GET  /                     → 界面稿（index.html）
 *   GET  /api/health           → 健康检查（不花钱、不联网）
 *   GET  /api/providers        → 厂商清单（不含密钥）
 *   GET  /api/emails?limit=N   → 抓真实邮件 + LLM 分类（花钱、连网）
 *   GET  /api/status           → 当前配置与花费（密钥打码）
 *   POST /api/llm/test         → 真发 1 次最小 LLM 请求，回显 HTTP 状态 / 耗时 / 网关原文
 *   POST /api/agent            → 「问管家」：自主编排工具，支持两段式审批
 *   GET  /api/agent/status     → 查询运行状态 / 待审批项
 *   POST /api/agent/approve    → 提交审批决定
 *   GET  /api/events           → SSE 事件流（后台守护发现紧急邮件时推 alert）
 *   GET  /api/monitor/status   → 守护循环状态
 *   POST /api/voice/stt        → 语音转文字（上传 base64 音频）
 *   POST /api/voice/tts        → 文字转语音（macOS say），返回音频 URL
 *   GET  /api/voice/audio/<名> → 播放生成的音频文件
 *   GET  /api/voice/status     → 语音能力可用性（STT 需额外依赖）
 *   GET  /api/attachment       → 按需下载会话内邮件的某个附件（PDF/图片预览，支持 Range）
 *   POST /api/avatar/chat      → 数字人对话：自然语言提问 → LLM 结合邮件/天气上下文回答（只读）
 *   GET  /vendor/pdf.min.js    → pdf.js 库（前端把 PDF 渲染成 canvas，不依赖浏览器插件）
 *   GET  /vendor/pdf.worker.min.js → pdf.js 的 worker（解析 PDF 用，独立线程）
 *   GET  /logo.png | /favicon.png → 品牌图标
 *   POST /api/todo/extract     → 从会话里的一封邮件识别「待办 + 日期」（只读，结果交给前端日历）
 *   GET  /api/avatars          → 数字人视频清单（扫「数字人视频」目录）
 *   GET  /数字人视频/<文件名>   → 视频文件（支持 Range 拖动播放）
 *   POST /api/config           → 写配置到 .env（需要 token）
 *
 * 【专注计时器是页面内视图，不是外部工具】
 *   全部逻辑在 web/index.html 里，数据存浏览器 localStorage。
 *   后端不参与、不需要 8765 服务、不拉起任何 App。
 *
 * 【为什么 POST /api/config 要 token】
 *   它能改你的 .env。没有认证的话，任何本地网页（甚至你打开的恶意网页）
 *   都能通过 fetch 改你的配置。加 token 后，本地网页拿不到 token 就改不了。
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, readdir, stat, writeFile, mkdir, unlink } from 'node:fs/promises';
import { statSync, existsSync, createReadStream } from 'node:fs';
import { join, resolve, extname, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { loadDotenv, loadConfig, describeConfig, listProviders, projectRoot, type Config } from '../config.js';
import { fetchImap } from '../mailbox/imap.js';
import { MailStore } from '../mailbox/store.js';
import type { Email } from '../mailbox/types.js';
import { LM, ledgerSummary, estimateCost } from '../llm/client.js';
import { classifyAll, applyLabels, type ClassifyResult } from '../pipelines/classify.js';
import { buildDigest } from '../pipelines/digest.js';
import { generateReply, buildReplySubject } from '../pipelines/reply.js';
import { extractTodo, localYmd } from '../pipelines/todo.js';
import { answerQuestion, type QaHit } from '../pipelines/qa.js';
import { BM25Index } from '../pipelines/bm25.js';
import { sendMail, SmtpError } from '../mailbox/smtp.js';
import { createAgentSession, type AgentSession } from '../agent/session.js';
import { startMonitor, type MonitorHandle, type AlertEvent } from '../monitor/monitor.js';
import { createVoiceBridge, safeAudioName, type VoiceBridge } from './voice-bridge.js';
import { avatarChat, type AvatarContext } from './avatar-chat.js';
import { writeEnv, readEnvValues, envPath } from './envfile.js';

const ROOT = projectRoot();

/** 从邮件的 labels 里取当前分类（跟 agent/tools.ts 的 categoryOf 一致）。 */
function categoryOfMail(m: Email): string {
  return m.labels.find((l) => l === 'urgent' || l === 'normal' || l === 'ignore') ?? 'unknown';
}

/**
 * 时区：邮件按本地时区分组，必须跟 .env 里的 MAIL_TIMEZONE 一致。
 * 做成可变全局而不是写死 'Asia/Shanghai' —— 用户换时区时不能改代码。
 */
let WEB_TIMEZONE = 'Asia/Shanghai';

/**
 * 会话级邮件缓存。
 *
 * 【为什么需要】
 *   /api/digest 要用"已分类的邮件"。如果没有缓存，它得自己再抓一遍邮箱、
 *   再跑一遍分类 —— 那就是**重复花钱**（虽然 LLM 缓存会挡掉大部分，
 *   但 IMAP 连接、时间排序、元数据拉取全要重做）。
 *   所以 /api/emails 抓完就存这里，/api/digest 直接复用。
 *
 * 【和 store.ts 的 MailStore 什么关系】
 *   MailStore 负责"去重 + 按天查询"，是这个缓存的轻量版。
 *   这里额外存了分类结果（ClassifyResult[]），因为摘要需要 category。
 *
 * 【生命周期】
 *   进程内存，重启即清空 —— 符合"不落盘"的原则。
 */
const SESSION: {
  mails: Email[];
  results: ClassifyResult[];
  fetchedAt: number;
  /** BM25 索引缓存 —— 跟着 mails 一起失效 */
  qaIndex: BM25Index | null;
  /** 索引对应的 mails 数量 + fetchedAt，用来判断缓存是否过期 */
  qaIndexKey: string;
} = { mails: [], results: [], fetchedAt: 0, qaIndex: null, qaIndexKey: '' };

/**
 * Agent Web 会话。
 *
 * 【为什么要按 fetchedAt 重建】
 *   Agent 的 10 个工具只看「建会话时的邮件快照」。用户重新「拉取邮件」后
 *   SESSION.mails 换了新数组，若继续用旧会话，Agent 会检索到上次的旧邮件 ——
 *   界面显示的是新邮件、它答的是旧邮件，这种错位极难排查。
 *   所以用 fetchedAt 当 key，一变就重建。
 */
let agentSession: AgentSession | null = null;
let agentSessionKey = '';

function getAgentSession(cfg: Config): AgentSession {
  const key = `${SESSION.fetchedAt}:${SESSION.mails.length}`;
  if (!agentSession || agentSessionKey !== key) {
    agentSession?.dispose();
    agentSession = createAgentSession({
      cfg,
      mails: SESSION.mails,
      projectRoot: ROOT,
      send: (mail) =>
        sendMail(
          {
            host: process.env.MAIL_SMTP_HOST ?? 'smtp.qq.com',
            port: Number(process.env.MAIL_SMTP_PORT ?? 465),
            secure: (process.env.MAIL_SMTP_SECURE ?? 'true') !== 'false',
            user: cfg.imap?.user ?? '',
            pass: cfg.imap?.pass ?? '',
            helo: 'localhost',
          },
          mail,
        ),
    });
    agentSessionKey = key;
  }
  return agentSession;
}

/* ============================ SSE 推送通道 ============================ */

/**
 * 已连接的浏览器（Server-Sent Events）。
 *
 * 【为什么用 SSE 而不是 WebSocket】
 *   我们只需要「服务端 → 浏览器」单向推提醒，SSE 用原生 EventSource 就行，
 *   不用引第三方库、不用处理握手/心跳的双向语义。
 */
const SSE_CLIENTS = new Set<ServerResponse>();

/** 广播一条事件给所有已连接的页面。 */
function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of SSE_CLIENTS) {
    try {
      res.write(payload);
    } catch {
      SSE_CLIENTS.delete(res);
    }
  }
}

/** 后台守护循环句柄（进程内单例，和 web 同生共死）。 */
let monitorHandle: MonitorHandle | null = null;

/** 语音桥接（懒加载：第一次调用才初始化，避免启动时做无谓的后端探测）。 */
let voiceBridge: VoiceBridge | null = null;
function getVoiceBridge(): VoiceBridge {
  if (!voiceBridge) {
    // 本地 whisper 配置：环境变量优先，路径按项目根解析成绝对路径。
    // 之所以要从环境变量读：macOS 系统语音识别（默认后端）用 ad-hoc 签名会被
    // TCC 卡死，本地 whisper 是唯一稳定的离线方案；但装在哪、用哪个模型是
    // 用户环境相关的事，不该写死在源码里。
    const bin = (process.env.MAIL_STT_WHISPER_BIN ?? '').trim();
    const model = (process.env.MAIL_STT_WHISPER_MODEL ?? '').trim();
    // 朗读音色与后端：默认 piper（离线神经音色，比 say 流畅）。
    //   MAIL_TTS_BACKEND=piper|say   MAIL_TTS_VOICE=音色名（仅 say 用）
    //   MAIL_TTS_PIPER_BIN / MAIL_TTS_PIPER_MODEL = piper 可执行与模型路径
    const backendRaw = (process.env.MAIL_TTS_BACKEND ?? '').trim();
    const voice = (process.env.MAIL_TTS_VOICE ?? 'Tingting').trim() || 'Tingting';
    const piperBin = (process.env.MAIL_TTS_PIPER_BIN ?? '').trim();
    const piperModel = (process.env.MAIL_TTS_PIPER_MODEL ?? '').trim();
    const abs = (p: string) => {
      if (p.startsWith('~/') || p === '~') return join(homedir(), p.slice(1));
      return isAbsolute(p) ? p : resolve(ROOT, p);
    };
    // 显式配了 piper 路径，或没指定后端 → 默认钉 piper（离线、流畅）。
    const wantPiper = backendRaw === 'piper' || (backendRaw === '' && (piperBin || piperModel));
    const ttsCfg: {
      backend?: 'piper' | 'say';
      voice: string;
      piper?: { bin?: string; model?: string };
    } = {
      ...(backendRaw === 'say' ? { backend: 'say' as const } : {}),
      ...(wantPiper ? { backend: 'piper' as const } : {}),
      voice,
      ...(piperBin || piperModel ? {
        piper: {
          ...(piperBin ? { bin: abs(piperBin) } : {}),
          ...(piperModel ? { model: abs(piperModel) } : {}),
        },
      } : {}),
    };
    const raw: Parameters<typeof createVoiceBridge>[1] = (bin || model) ? {
      stt: {
        backend: 'whisper-local',
        ...(bin ? { whisperLocal: {
          bin: abs(bin),
          ...(model ? { model: abs(model) } : {}),
        } } : {}),
        ...(model ? { model: abs(model) } : {}),
      },
      tts: ttsCfg,
    } : {
      tts: ttsCfg,
    };
    voiceBridge = createVoiceBridge(ROOT, raw);
  }
  return voiceBridge;
}

/**
 * 启动 monitor（在 serve() 里调用一次）。
 *
 * 【为什么不单独进程】冷却期是全局的，两个进程会各弹各的。
 *   同进程跑，警报直接走 SSE 推给页面，不需要跨进程共享状态。
 */
function bootMonitor(): void {
  if (monitorHandle) return;
  monitorHandle = startMonitor({
    cfg: loadConfig(),
    watermarkPath: join(ROOT, 'data', 'notify-watermark.json'),
    intervalMs: 60_000,
    // 增量：只取水位线之后的新邮件。这里用「当前会话最新 uid + 1」近似，
    // 因为 monitor 和「拉取邮件」共享 SESSION，不必自己维护 IMAP 水位。
    fetchNew: async () => {
      const cfg = loadConfig();
      if (!cfg.imap) return [];
      const mails = await fetchImap(cfg.imap, { limit: 20 });
      // 只保留没进过当前会话的（按 id 去重）
      const known = new Set(SESSION.mails.map((m) => m.id));
      const fresh = mails.filter((m) => !known.has(m.id));
      if (fresh.length) {
        // 把新邮件并进会话，这样 Agent / 问邮件也能看到它们
        SESSION.mails = [...fresh, ...SESSION.mails].slice(0, 100);
        SESSION.qaIndex = null;
        SESSION.qaIndexKey = '';
      }
      return fresh;
    },
    classify: async (mails) => {
      if (!mails.length) return new Map();
      const cfg = loadConfig();
      const lm = new LM(cfg, 'monitor');
      const results = await classifyAll(lm, mails, cfg.timezone, 8);
      applyLabels(mails, results);
      return new Map(results.map((r) => [r.id, r.category]));
    },
    onAlert: (alert: AlertEvent) => {
      // 前端收到 alert 事件后自己弹提醒卡、写事件流
      broadcast('alert', alert);
    },
  });
}

/* ============================ 写配置的安全机制 ============================ */

/**
 * 一次性 nonce。
 *
 * 【为什么需要】
 *   POST /api/config 能改 .env（含 API key、邮箱授权码）。
 *   如果任何本地网页都能调这个接口，你只要在浏览器里打开一个恶意网页，
 *   它就能偷偷改掉你的配置 —— 这是真实存在的攻击面（CSRF / DNS rebinding）。
 *
 * 【为什么 nonce 能挡住】
 *   nonce 通过 GET /api/nonce 的**响应体**返回。
 *   跨域 fetch 拿不到响应体（除非服务端发了 CORS 头，我们不发）→
 *   恶意网页拿不到 nonce → 提交时带不上 → 被拒。
 *   同源页面（我们的 Web UI）则能正常拿到。
 *
 * 【补充防护】
 *   ① nonce 用完即作废（一次性）
 *   ② 还要过 Origin 检查
 *   ③ 键名白名单 —— 就算 nonce 泄漏了，也写不了 NODE_OPTIONS 这类危险变量
 */
const NONCES = new Set<string>();

function issueNonce(): string {
  const n = randomBytes(24).toString('base64url');
  NONCES.add(n);
  // 防止无限增长：只保留最近 20 个
  if (NONCES.size > 20) {
    const first = NONCES.values().next().value;
    if (typeof first === 'string') NONCES.delete(first);
  }
  return n;
}

function consumeNonce(n: string): boolean {
  if (!NONCES.has(n)) return false;
  NONCES.delete(n); // 一次性
  return true;
}

/** 当前服务监听的地址（用于 Origin 检查）。 */
let CURRENT_SERVER: Server | null = null;

function serverAddress(): { port: number } | null {
  const addr = CURRENT_SERVER?.address();
  if (addr && typeof addr === 'object') return { port: addr.port };
  return null;
}

/* ============================ 类型 ============================ */

/** 前端要的邮件结构（字段名跟界面稿的假数据对齐，省得前端改）。 */
interface WebMail {
  /**
   * 邮件唯一 id（内容哈希）。
   *
   * 【为什么必须有它】前端用这个当草稿/回复状态的键（drafts[id]）。
   * 缺了它，所有邮件的 id 都是 undefined → 共用同一个槽位 →
   * 给一封写草稿，所有邮件都显示"回复已发送"。
   */
  id: string;
  /**
   * 发件人的【完整原始字符串】，如 `"@xwk" <1515574581@qq.com>`。
   *
   * 【为什么要单独给】
   * f 字段是"去掉地址后的显示名"（如 "@xwk"）——
   * 只看它用户不知道邮件到底是谁发的、回复要发到哪。
   * 而原稿的详情区写死了假地址 `<ops@corp.example>`，
   * 会让人以为要回复给那个根本不存在的地址。
   */
  from: string;
  /** 类别：urgent / normal / ignore / unknown */
  c: string;
  /** subject */
  s: string;
  /** sender 显示名 */
  f: string;
  /** 时间（HH:MM） */
  t: string;
  /** 日期（MM-DD） */
  d: string;
  /** body */
  b: string;
  /** reason */
  r: string;
  /** 置信度（0-1）；LLM 没给就算一个缺省值 */
  cf: number;
  /**
   * 完整时间戳（ISO 8601）—— 专门给前端排序用。
   * 【为什么不能只靠 d + t 排序】
   *   d 是 MM-DD、t 是 HH:MM，跨年时会算错（12-31 vs 01-01）。
   *   界面上显示的仍然是 d/t（好看），排序用这个（准确）。
   */
  ts: string;
  /** uid */
  uid: string;
  /** 邮箱夹（如 INBOX）—— 技术信息里显示，不能写死 */
  mailbox?: string;
  /** IMAP 服务器（技术信息里显示，不能写死） */
  provider?: string;
  /**
   * 附件清单。
   *
   * 【为什么只给元信息，不给字节】
   *   Buffer 直接 JSON 序列化会变成 {type:'Buffer',data:[...]}，体积膨胀 3~4 倍，
   *   一封 8MB 的 PDF 就是 30MB 的 JSON —— 页面直接卡死。
   *   所以这里只传 文件名/类型/大小，真正要看时再按 id + idx 单独下载。
   */
  att?: WebAttachment[];
}

/** 附件对外暴露的形状（不含字节）。 */
export interface WebAttachment {
  /** 在 attachments 数组里的下标 —— 下载接口用它定位 */
  i: number;
  /** 文件名 */
  n: string;
  /** MIME 类型 */
  t: string;
  /** 字节数 */
  z: number;
}

/* ============================ 工具 ============================ */

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 发一段 HTML（用于错误页）。 */
/** API Key 打码：回显里永远不能出现完整密钥（可能被截图 / 贴进聊天记录）。 */
function maskApiKey(key: string): string {
  if (!key) return '未填（本机网关可免 Key）';
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}（${key.length} 位）`;
}
/**
 * 发 HTML。
 *
 * 【为什么要设缓存头】
 * 不设的话浏览器会自己缓存 index.html —— 于是你改了前端代码、
 * 刷新页面，却还在跑旧代码（而且缓存不会自动失效）。
 *
 * 这个症状非常坑：明明代码改对了，界面却没变，
 * 容易误以为是"代码没生效"或者"缓存了邮件数据"。
 *
 * 现在的策略：
 *   no-store + no-cache + must-revalidate  → 浏览器每次都重新拉
 *   ETag（基于文件 mtime+size）             → 没变时返回 304，省流量
 */
function sendHtml(res: ServerResponse, status: number, html: string, etag?: string): void {
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    // 开发期最要紧的一条：别缓存
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
    expires: '0',
    // 【安全】CSP 兜底：即使将来某处漏了转义，也能挡住 XSS 外带数据。
    // 本页大量内联脚本/样式，且用 blob:(附件/音频)、data:(图片)、iframe(附件兜底)、
    // EventSource(SSE)，所以这些源必须放行；object-src 关掉可挡住插件类内容。
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "frame-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
    ].join('; '),
  };
  if (etag) headers.etag = etag;
  res.writeHead(status, headers);
  res.end(html);
}

/**
 * 算一个文件的 ETag。
 *
 * 用 mtime + size 而不是内容哈希 —— 因为每次请求都要算一遍，
 * 读文件 stat 比算哈希便宜得多。
 */
function etagOf(filePath: string): string | undefined {
  try {
    const st = statSync(filePath);
    return `W/"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
  } catch {
    return undefined;
  }
}

/** 读请求体（JSON）。 */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从 Email + 分类结果拼出前端要的形状。 */
/**
 * 从原邮件里提出可回复的地址。
 *
 * 原文可能是 `"王财务" <finance@corp.com>` 或纯 `finance@corp.com`。
 * 要的是能直接放进 SMTP RCPT TO 的纯地址。
 */
function replyToOf(email: Email): string {
  const m = email.sender.match(/<([^>]+)>/);
  return (m?.[1] ?? email.sender).trim();
}

/**
 * 从 Email + 分类结果拼出前端要的形状。
 *
 * 导出（而不是私藏）是为了让测试能直接验证"每封邮件的 id 都唯一"
 * —— 这曾经是个真 bug：id 字段漏了，前端所有邮件共用一个草稿槽位。
 */
export function toWebMail(email: Email, result: ClassifyResult | undefined): WebMail {
  // 日期格式必须跟界面稿一致：MM-DD（它按这个做日期分组，sort 排序）
  const dateKey = localDateKey(email.date);
  const time = localTime(email.date);
  // dateKey 形如 2026-11-02 → 取后两段（月份、日）
  const segs = dateKey.split('-');
  const mm = segs.length >= 3 ? segs[1] : segs[0] ?? '';
  const dd = segs.length >= 3 ? segs[2] : segs[1] ?? '';
  return {
    // 唯一 id：前端用它做草稿/回复状态的键（缺了会导致所有邮件串状态）
    id: email.id,
    // 完整发件人（显示名 + 真实地址）—— 详情区要显示这个，
    // 不能只显示显示名（用户会不知道回复要发到哪）
    from: email.sender.trim(),
    c: result?.category ?? 'unknown',
    s: email.subject,
    f: email.sender.replace(/\s*<[^>]*>\s*/, '').trim() || '(未知发件人)',
    t: time,
    d: `${mm}-${dd}`,
    b: email.body,
    r: result?.reason ?? '未分析',
    // LLM 不给置信度字段，用一个缺省值（前端要显示进度条）
    cf: result?.category === 'unknown' ? 0.3 : 0.9,
    uid: String(email.meta.uid ?? email.id),
    // 排序用：真实的收件时间（服务器接收时间），不是发件人写的 Date 头
    ts: mailTimestamp(email),
    // 邮箱夹与 IMAP 服务器 —— 技术信息里要显示真实值，不能写死
    mailbox: typeof email.meta.mailbox === 'string' ? email.meta.mailbox : undefined,
    provider: typeof email.meta.provider === 'string' ? email.meta.provider : undefined,
    // 附件只给元信息；字节走 /api/attachment 按需取
    att: email.attachments?.length
      ? email.attachments.map((a, i) => ({ i, n: a.filename, t: a.contentType, z: a.size }))
      : undefined,
  };
}

/**
 * 取用于排序的真实时间戳。
 * 优先服务器接收时间（internalDate），退回 Date 头 —— 都没有就用 0。
 */
function mailTimestamp(email: Email): string {
  const internal = email.meta.internalDate;
  if (typeof internal === 'string' && Number.isFinite(Date.parse(internal))) {
    return new Date(Date.parse(internal)).toISOString();
  }
  if (typeof internal === 'number' && Number.isFinite(internal)) {
    return new Date(internal).toISOString();
  }
  const t = Date.parse(email.date);
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

/** 本地时区的日期（YYYY-MM-DD）。 */
function localDateKey(date: string): string {
  const t = Date.parse(date);
  if (!Number.isFinite(t)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WEB_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(t));
  const get = (k: string): string => parts.find((p) => p.type === k)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 本地时区的时间（HH:MM）。 */
function localTime(date: string): string {
  const t = Date.parse(date);
  if (!Number.isFinite(t)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WEB_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(t));
  const get = (k: string): string => parts.find((p) => p.type === k)?.value ?? '';
  return `${get('hour')}:${get('minute')}`;
}

/* ============================ 数字人视频 ============================ */

/**
 * 视频目录名。跟 avatar_server.py 保持一致 —— 两边共用同一个目录。
 */
const VIDEO_DIRNAME = '数字人视频';

/** 允许的视频扩展名。 */
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);

/** 扩展名 → Content-Type。 */
const VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.ogv': 'video/ogg',
};

/**
 * 视频目录在哪。
 *
 * 【为什么必须由后端来管】
 *   前端 avScanVideos() 请求的是同源的 /api/avatars；拿不到才降级去读
 *   「数字人视频/manifest.json」；再拿不到就只剩「选择本地文件夹」这一条路。
 *   而「选择本地文件夹」走的是 blob: URL —— **刷新即失效**，数字人会变回默认形象。
 *   所以必须由后端把目录扫出来、用 http URL 发出去，刷新后照样能用。
 *
 * 优先级：.env 的 MAIL_AVATAR_DIR → AVATAR_VIDEO_DIR（与 avatar_server.py 同名，方便两边共用）
 *       → 项目根/数字人视频 → ~/数字人视频
 */
function videoDir(): string {
  const fromEnv = (process.env.MAIL_AVATAR_DIR ?? process.env.AVATAR_VIDEO_DIR ?? '').trim();
  if (fromEnv) return resolve(fromEnv);
  const local = join(ROOT, VIDEO_DIRNAME);
  if (existsSync(local)) return local;
  return join(homedir(), VIDEO_DIRNAME);
}

/**
 * 扫描视频目录 → [{name, url, size, mtime}]。
 *
 * 【格式必须与 avatar_server.py 一致】前端不挑后端，只要字段对得上就能用。
 * mtime 用【秒】（跟 Python 的 int(st.st_mtime) 对齐），不是毫秒。
 */
async function scanVideos(): Promise<Array<{ name: string; url: string; size: number; mtime: number }>> {
  const root = videoDir();
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return []; // 目录不存在 → 空列表，不是错误
  }

  const out: Array<{ name: string; url: string; size: number; mtime: number }> = [];
  for (const fn of names.sort()) {
    if (!VIDEO_EXTS.has(extname(fn).toLowerCase())) continue;
    try {
      const st = await stat(join(root, fn));
      if (!st.isFile()) continue;
      out.push({
        name: fn,
        url: `/${VIDEO_DIRNAME}/${encodeURIComponent(fn)}`,
        size: st.size,
        mtime: Math.floor(st.mtimeMs / 1000),
      });
    } catch {
      // 单个文件 stat 失败（比如刚被删）→ 跳过，不影响整批
    }
  }
  return out;
}

/**
 * 发视频文件（支持 Range）。
 *
 * 【为什么必须支持 Range】
 *   Chrome 播放 webm/mp4 会先发 Range 请求要一小段试探。
 *   不支持的话要么整文件传（浪费），要么浏览器直接报错不播。
 */
function sendVideo(req: IncomingMessage, res: ServerResponse, file: string, size: number, ext: string): void {
  const ctype = VIDEO_TYPES[ext] ?? 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      if (end >= size) end = size - 1;
      res.writeHead(206, {
        'content-type': ctype,
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
        'content-length': end - start + 1,
        'cache-control': 'no-store',
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, {
    'content-type': ctype,
    'accept-ranges': 'bytes',
    'content-length': size,
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}

/**
 * 轻量同源校验：只接受从本服务页面发出的请求。
 *
 * 【和 nonce 的分工】nonce 用于「改配置」这种写操作；
 *   Agent 提问虽然会花钱，但不改文件，所以用 Origin 校验 + 本地监听就够。
 *   没有 Origin 头（curl / 同源 GET）时放行 —— 浏览器跨站写操作一定会带 Origin。
 */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const port = (serverAddress() ?? {}).port;
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin);
}

/**
 * 发一个内存里的附件字节（支持 Range）。
 *
 * 【为什么必须支持 Range】
 *   Chrome 内置 PDF 阅读器打开 PDF 时会先发 Range 请求要文件头/尾，
 *   不支持的话预览会一直转圈或显示空白 —— 视频那条链路踩过同样的坑。
 *
 * 【安全】content-type 来自邮件的 MIME 头（不可信输入）。
 *   绝不能让附件里的 HTML/SVG 以 text/html、image/svg+xml 发出来：
 *   浏览器会在【本站 origin】渲染它，里面的脚本就能读到本地数据。
 *   所以这里强制只允许白名单类型，其余一律降级成 octet-stream + 强制下载。
 *
 * 【为什么去掉 CSP sandbox（曾经踩的坑）】
 *   之前这里发 `content-security-policy: default-src 'none'; sandbox`，
 *   结果 Chrome 内置 PDF 阅读器在 iframe 里直接白屏 —— sandbox 指令会
 *   禁用 PDF 插件。现在 PDF 改由前端 pdf.js 拿字节后用 canvas 渲染，
 *   不依赖任何浏览器插件，这个头也就没有存在意义了（反而添乱）。
 *   XSS 防护改由上面的「白名单 MIME + octet-stream 降级」承担。
 */
const INLINE_TYPES = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp',
  'text/plain', 'text/csv',
]);

function sendAttachment(
  req: IncomingMessage,
  res: ServerResponse,
  filename: string,
  contentType: string,
  bytes: Buffer,
): void {
  const raw = contentType.split(';')[0].trim().toLowerCase();
  const safeType = INLINE_TYPES.has(raw) ? raw : 'application/octet-stream';
  // 文件名写进响应头前必须去掉 CR/LF 和引号，否则可以注入额外响应头
  const safeName = filename.replace(/[\r\n"\\]/g, '_').slice(0, 200);
  const disposition = safeType === 'application/octet-stream' ? 'attachment' : 'inline';

  // RFC 5987：中文文件名要用 UTF-8''+百分号编码，否则浏览器显示乱码
  let ascii = safeName.replace(/[^\x20-\x7e]/g, '_');
  if (!ascii) ascii = 'attachment';
  const encoded = encodeURIComponent(safeName);
  const headers: Record<string, string | number> = {
    'content-type': safeType + (safeType.startsWith('text/') ? '; charset=utf-8' : ''),
    'content-disposition': `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    'x-content-type-options': 'nosniff',
    // 关键：允许 PDF 被 pdf.js 通过 fetch 读取（同源，不需 CORS），
    // 且不封死 iframe —— 浏览器原生 PDF 阅读器作为兜底仍可用。
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };

  const size = bytes.length;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      if (end >= size) end = size - 1;
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': end - start + 1,
      });
      res.end(bytes.subarray(start, end + 1));
      return;
    }
  }

  res.writeHead(200, { ...headers, 'content-length': size });
  res.end(bytes);
}

/* ============================ 检索索引缓存 ============================ */

/**
 * 拿（或重建）当前会话的 BM25 索引。
 *
 * 【为什么要缓存】
 *   建索引是纯 CPU 活（20 封约几毫秒），但每次提问都重建一遍没必要 ——
 *   而且问答常常连着问好几个，缓存能省掉重复计算。
 *
 * 【失效条件】
 *   索引 key = mails.length + fetchedAt。
 *   /api/emails 每次抓完都会更新 fetchedAt → key 变了 → 自动重建。
 *   这样"重新拉了邮件但索引还是旧的"这种 bug 不会发生。
 */
function qaIndexOf(cfg: Config): BM25Index {
  const key = `${SESSION.mails.length}:${SESSION.fetchedAt}`;
  if (SESSION.qaIndex && SESSION.qaIndexKey === key) return SESSION.qaIndex;

  const index = new BM25Index().build(SESSION.mails);
  SESSION.qaIndex = index;
  SESSION.qaIndexKey = key;
  return index;
}

/* ============================ 主处理 ============================ */

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  /* ---------- 静态页面 ---------- */
  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    try {
      const file = join(ROOT, 'web', 'index.html');
      const html = await readFile(file, 'utf8');
      const etag = etagOf(file);

      // 浏览器带着 If-None-Match 来了 → 文件没变，返回 304（省流量但保证最新）
      if (etag && req.headers['if-none-match'] === etag) {
        res.writeHead(304, {
          etag,
          'cache-control': 'no-store, no-cache, must-revalidate',
        });
        res.end();
        return;
      }

      sendHtml(res, 200, html, etag);
    } catch {
      sendHtml(res, 404, '<h1>找不到 web/index.html</h1><p>先运行 npm run web</p>');
    }
    return;
  }

  /* ---------- pdf.js 静态资源（白名单，防目录穿越）----------
   * 前端用 pdf.js 把 PDF 渲染成 canvas —— 不依赖浏览器内置插件，
   * 所以在 WorkBuddy 内嵌预览面板里也能正常显示。
   * 【为什么用精确白名单而不是 /vendor/* 通配】
   *   路径来自 URL，是可信输入里的不可信部分。只放行这两个已知文件名，
   *   目录穿越（../）和其它任意文件读取就都无从谈起。
   */
  if (req.method === 'GET' && (path === '/vendor/pdf.min.js' || path === '/vendor/pdf.worker.min.js')) {
    const file = join(ROOT, 'web', 'vendor', path.slice('/vendor/'.length));
    try {
      const bytes = await readFile(file);
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'content-length': bytes.length,
        'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff',
      });
      res.end(bytes);
    } catch {
      sendJson(res, 404, { error: '缺少 pdf.js 文件，请检查 web/vendor 目录' });
    }
    return;
  }

  /* ---------- 品牌资源：logo / favicon（同样是精确白名单）---------- */
  if (req.method === 'GET' && (path === '/logo.png' || path === '/favicon.png')) {
    const file = join(ROOT, 'web', path.slice(1));
    try {
      const bytes = await readFile(file);
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': bytes.length,
        'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff',
      });
      res.end(bytes);
    } catch {
      sendJson(res, 404, { error: '缺少 logo 资源' });
    }
    return;
  }

  /* ---------- 邮件附件（按需下载，不进 JSON）----------
   * 【为什么只收 id + i，不收文件名】
   *   文件名来自邮件头，是不可信输入；让它参与路径拼接就是目录穿越漏洞。
   *   这里只接受「会话内邮件的第几个附件」，找不到就 404，没有任何文件系统操作。
   *   字节一直待在 SESSION.mails 的内存里，从不落盘。
   */
  if (req.method === 'GET' && path === '/api/attachment') {
    const id = url.searchParams.get('id') ?? '';
    const idxRaw = url.searchParams.get('i') ?? '';
    const idx = Number(idxRaw);
    if (!id || !/^\d+$/.test(idxRaw) || !Number.isSafeInteger(idx)) {
      sendJson(res, 400, { error: '缺少 id 或附件序号' });
      return;
    }
    const mail = SESSION.mails.find((m) => m.id === id);
    if (!mail) {
      sendJson(res, 404, { error: '这封邮件不在本次会话里，请先「拉取邮件」' });
      return;
    }
    const att = mail.attachments?.[idx];
    if (!att) {
      sendJson(res, 404, { error: '这封邮件没有这个附件' });
      return;
    }
    sendAttachment(req, res, att.filename, att.contentType, att.content);
    return;
  }

  /* ---------- 数字人对话 ----------
   * 【安全】邮件统计一律用服务端的 SESSION.mails 现算，不信前端传的数字；
   *   前端只能补充"天气摘要/城市"这类浏览器侧算出来的只读事实。
   *   同源校验挡跨站刷账单；只读、无工具，物理上无法发信或改配置。
   */
  if (path === '/api/avatar/chat' && req.method === 'POST') {
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: '来源不被允许' });
      return;
    }
    const body = (await readBody(req)) as { q?: string; context?: AvatarContext } | null;
    const q = typeof body?.q === 'string' ? body.q.slice(0, 300) : '';
    if (!q.trim()) {
      sendJson(res, 400, { error: '请填写问题' });
      return;
    }
    const cfg = loadConfig();
    if (!cfg.llmApiKey) {
      sendJson(res, 400, { error: '没配置 LLM 密钥，数字人无法回答' });
      return;
    }
    // 从服务端会话里算邮件统计 —— 前端传的 context 只取天气/城市这类本地事实
    const mails = SESSION.mails;
    const rawCtx = body?.context ?? {};
    const ctx: AvatarContext = {
      mailCount: mails.length,
      urgentCount: mails.filter((m) => categoryOfMail(m) === 'urgent').length,
      normalCount: mails.filter((m) => categoryOfMail(m) === 'normal').length,
      ignoreCount: mails.filter((m) => categoryOfMail(m) === 'ignore').length,
      urgentMails: mails
        .filter((m) => categoryOfMail(m) === 'urgent')
        .slice(0, 5)
        .map((m) => `${m.subject}（来自 ${m.sender}）`),
      recentMails: mails.slice(0, 6).map((m) => `${m.subject}（${categoryOfMail(m)}）`),
      todos: Array.isArray(rawCtx.todos) ? rawCtx.todos.slice(0, 8) : undefined,
      weather: typeof rawCtx.weather === 'string' ? rawCtx.weather : undefined,
      city: typeof rawCtx.city === 'string' ? rawCtx.city : undefined,
    };
    try {
      const reply = await avatarChat(cfg, q, ctx);
      sendJson(res, 200, { ok: true, text: reply.text, cached: reply.cached });
    } catch (e) {
      sendJson(res, 502, { error: '数字人回答失败：' + (e as Error).message });
    }
    return;
  }

  /* ---------- Agent「问管家」----------
   * ① POST /api/agent        提问 → 立刻返回 runId
   * ② GET  /api/agent/status 轮询状态（结果 / 待审批项）
   * ③ POST /api/agent/approve 提交审批决定
   *
   * 【为什么是三段而不是一次请求】
   *   runAgent 中途可能要用户批准发信。HTTP 请求挂几十秒会被代理/浏览器断开。
   *   拆成短请求后，状态在进程内存里，刷新页面还能接着看。
   * 【安全】只收 question 文本，不收邮件正文 / 工具名 / 配置 —— 防止被当成
   *   「任意文本调模型」的开放代理。同源校验挡跨站刷账单。
   */
  if (path === '/api/agent' && req.method === 'POST') {
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: '来源不被允许' });
      return;
    }
    const body = (await readBody(req)) as { q?: string } | null;
    const q = typeof body?.q === 'string' ? body.q.trim().slice(0, 2_000) : '';
    if (!q) {
      sendJson(res, 400, { error: '请填写问题' });
      return;
    }
    if (SESSION.mails.length === 0) {
      sendJson(res, 409, { error: '本次会话没有邮件，请先「拉取邮件」' });
      return;
    }
    try {
      const cfg = loadConfig();
      const session = getAgentSession(cfg);
      const runId = session.ask(q);
      sendJson(res, 200, { ok: true, runId });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
    return;
  }

  if (path === '/api/agent/status' && req.method === 'GET') {
    const runId = url.searchParams.get('runId') ?? '';
    const session = agentSession;
    const run = runId ? session?.status(runId) : undefined;
    if (!run) {
      sendJson(res, 404, { error: '找不到这次提问（服务重启后会清空）' });
      return;
    }
    // 只回前端需要的字段，不把整个内部对象（含 transcript）倒出去
    sendJson(res, 200, {
      id: run.id,
      question: run.question,
      status: run.status,
      text: run.text,
      outcome: run.outcome ?? null,
      turns: run.turns,
      error: run.error,
      pending: run.pending
        ? {
            id: run.pending.id,
            kind: run.pending.kind,
            question: run.pending.question,
            detail: run.pending.detail,
          }
        : null,
      calls: run.calls.map((c) => ({ name: c.name, status: c.result.status })),
      elapsedMs: run.updatedAt - run.startedAt,
    });
    return;
  }

  if (path === '/api/agent/approve' && req.method === 'POST') {
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: '来源不被允许' });
      return;
    }
    const body = (await readBody(req)) as
      | { runId?: string; approvalId?: string; approved?: boolean; answer?: string }
      | null;
    const runId = typeof body?.runId === 'string' ? body.runId : '';
    const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
    const approved = body?.approved === true;
    const answer = typeof body?.answer === 'string' ? body.answer.slice(0, 2_000) : '';
    const ok = agentSession?.decide(runId, approvalId, approved, answer) ?? false;
    if (!ok) {
      sendJson(res, 409, { error: '审批已失效（可能已处理过，或提交的是旧的审批）' });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  /* ---------- SSE 事件流 + monitor 状态 ---------- */
  if (req.method === 'GET' && path === '/api/events') {
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: '来源不被允许' });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    SSE_CLIENTS.add(res);
    // 心跳：防止代理把空闲连接掐掉
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
    }, 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      SSE_CLIENTS.delete(res);
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/monitor/status') {
    sendJson(res, 200, {
      enabled: !!monitorHandle,
      intervalMs: 60_000,
      ...(monitorHandle?.snapshot() ?? { running: false, records: 0, active: 0, lastRunAt: 0 }),
      sseClients: SSE_CLIENTS.size,
    });
    return;
  }

  /* ---------- 语音（TTS 朗读可用；STT 需额外依赖）---------- */
  if (req.method === 'POST' && path === '/api/voice/stt') {
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: '来源不被允许' });
      return;
    }
    // 先按 Content-Length 预检，避免超大 body 进内存（base64 会再涨 1/3）
    const len = Number(req.headers['content-length'] ?? 0);
    if (len > 22_000_000) {
      sendJson(res, 413, { error: '音频太大（上限约 15MB）' });
      return;
    }
    const bridge = getVoiceBridge();
    const stt = bridge.sttStatus();
    if (!stt.available) {
      sendJson(res, 503, { error: stt.reason });
      return;
    }
    const body = (await readBody(req)) as { audio?: string; mime?: string } | null;
    const b64 = typeof body?.audio === 'string' ? body.audio : '';
    // 只接受 base64 音频；大小上限 15MB（约 10 分钟录音）
    if (!b64 || b64.length > 20_000_000) {
      sendJson(res, 400, { error: '没有音频数据或音频过大（上限约 15MB）' });
      return;
    }
    // data URL 形如 data:audio/webm;codecs=opus;base64,XXXX
    // 注意 mime 后可能跟任意多个 ;参数（codecs=opus），不能用 /^data:[^;]+;base64,/
    // 剥离：那会在遇到 codecs 参数时匹配失败，把整个 data URL 当音频解码成垃圾，
    // 正是"录音识别不出文字"的根因。改成匹配到逗号前的 base64 标记为止。
    const dm = b64.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s);
    const mime = (dm?.[1] ?? body?.mime ?? 'audio/m4a').toLowerCase();
    const rawB64 = dm?.[2] ?? b64.replace(/^data:[^,]*,/, '');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(rawB64, 'base64');
    } catch {
      sendJson(res, 400, { error: '音频数据不是合法的 base64' });
      return;
    }
    if (!bytes.length) {
      sendJson(res, 400, { error: '音频数据为空' });
      return;
    }
    // 临时文件扩展名跟随真实 mime：包装器据此决定用 afconvert 还是 ffmpeg 转码
    const ext = mime.includes('webm') ? '.webm'
      : mime.includes('ogg') ? '.ogg'
      : mime.includes('mp3') ? '.mp3'
      : mime.includes('wav') ? '.wav'
      : '.m4a';
    const name = `stt-${randomBytes(8).toString('hex')}${ext}`;
    const tmp = join(tmpdir(), name);
    try {
      await writeFile(tmp, bytes);
      const out = await bridge.transcribeFile(tmp);
      sendJson(res, 200, { ok: true, text: out.text, backend: out.backend });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
    return;
  }

  if (req.method === 'GET' && path === '/api/voice/status') {
    sendJson(res, 200, { tts: { available: true }, stt: getVoiceBridge().sttStatus() });
    return;
  }

  if (req.method === 'POST' && path === '/api/voice/tts') {
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: '来源不被允许' });
      return;
    }
    const body = (await readBody(req)) as { text?: string } | null;
    const text = typeof body?.text === 'string' ? body.text.slice(0, 4_000) : '';
    if (!text.trim()) {
      sendJson(res, 400, { error: '没有要朗读的文本' });
      return;
    }
    try {
      const r = await getVoiceBridge().synthesize(text);
      sendJson(res, 200, { ok: true, url: r.url, mime: r.mime });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
    return;
  }

  if (req.method === 'GET' && path.startsWith('/api/voice/audio/')) {
    const name = decodeURIComponent(path.slice('/api/voice/audio/'.length));
    // 文件名白名单：只接受我们生成的格式，绝不让请求拼出任意路径。
    // say 出 .m4a，piper 出 .wav —— 两种都放行，按后缀回 content-type。
    const m = /^speak-[A-Za-z0-9-]+\.(m4a|wav)$/.exec(name);
    if (!safeAudioName(name) || !m) {
      sendJson(res, 400, { error: '无效的文件名' });
      return;
    }
    const file = join(getVoiceBridge().audioDir, name);
    try {
      const buf = await readFile(file);
      res.writeHead(200, {
        'content-type': m[1] === 'wav' ? 'audio/wav' : 'audio/mp4',
        'content-length': buf.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(buf);
    } catch {
      sendJson(res, 404, { error: '音频不存在' });
    }
    return;
  }

  /* ---------- 数字人视频清单 ---------- */
  // 前端 avScanVideos() 先问这个；拿不到才降级读 manifest.json / 手动选本地文件夹。
  if (path === '/api/avatars') {
    sendJson(res, 200, { dir: VIDEO_DIRNAME, videos: await scanVideos() });
    return;
  }

  /* ---------- 数字人视频文件 ---------- */
  // 【注意】url.pathname 是【百分号编码】的（"/数字人视频/示例-机器人.webm" 会被编码成
  // "/%E6%95%B0%E5%AD%97...%E7%BD%91%E5%8F%98"）。所以要先解码再判断路径。
  // 不解码的话 path.startsWith('/数字人视频/') 永远不成立 → 视频 404。
  let decodedPath = path;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    // 非法百分号编码 → 保持原样，后面的白名单检查会拒掉
  }

  if (req.method === 'GET' && decodedPath.startsWith(`/${VIDEO_DIRNAME}/`)) {
    const name = decodedPath.slice(`/${VIDEO_DIRNAME}/`.length);
    // 【防目录穿越】只接受纯文件名 —— 不接受任何分隔符，也不接受 ..
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
      sendJson(res, 400, { error: '非法文件名' });
      return;
    }
    const ext = extname(name).toLowerCase();
    // manifest.json 是设计里明确的"静态托管降级"路径：
    // 前端拿不到 /api/avatars 时会去读它，所以这里放行（且只放行这一个文件名）。
    if (ext === '.json') {
      if (name !== 'manifest.json') {
        sendJson(res, 404, { error: '不是视频文件' });
        return;
      }
      try {
        const text = await readFile(join(videoDir(), name), 'utf8');
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(text);
      } catch {
        sendJson(res, 404, { error: '找不到 manifest.json' });
      }
      return;
    }
    if (!VIDEO_EXTS.has(ext)) {
      sendJson(res, 404, { error: '不是视频文件' });
      return;
    }
    try {
      const full = join(videoDir(), name);
      const st = await stat(full);
      if (!st.isFile()) throw new Error('not a file');
      sendVideo(req, res, full, st.size, ext);
    } catch {
      sendJson(res, 404, { error: '找不到视频文件' });
    }
    return;
  }

  /* ---------- 健康检查 ---------- */
  if (path === '/api/health') {
    sendJson(res, 200, { ok: true, node: process.version });
    return;
  }

  /* ---------- 前端版本号（用于自动检测代码变化）---------- */
  if (path === '/api/version') {
    const file = join(ROOT, 'web', 'index.html');
    const etag = etagOf(file);
    sendJson(res, 200, {
      version: etag ?? 'unknown',
      // 明确不要缓存这个接口
    });
    return;
  }

  /* ---------- 厂商清单（不含密钥）---------- */
  if (path === '/api/providers') {
    const cfg = loadConfig();
    sendJson(res, 200, { providers: listProviders(cfg), current: cfg.providerId });
    return;
  }

  /* ---------- 当前状态 ---------- */
  if (path === '/api/status') {
    const cfg = loadConfig();
    sendJson(res, 200, {
      config: describeConfig(cfg),
      provider: cfg.providerId,
      hasImap: cfg.imap !== null,
      imapProvider: cfg.imap?.provider ?? null,
      imapUser: cfg.imap?.user ?? null,
      mailbox: cfg.imap?.mailbox ?? 'INBOX',
    });
    return;
  }

  /* ---------- LLM 连通性测试：发 1 次最小请求，把结果结构化回显 ---------- */
  /**
   * 【为什么要真发请求】
   *   设置面板原来那个「测试连接」只 fetch /api/status 问当前配置，
   *   回显「后端已就绪 · 当前厂商 …」—— 压根没连过模型。
   *   Key 写错、中转站欠费、模型名不存在，它照样显示"已就绪"。
   *   诊断必须发一次请求，并把 HTTP 状态 / 耗时 / 网关原文带回来。
   *
   * 【为什么测表单值、不写 .env】
   *   用户改完 Base URL / Key 想先试一下再保存；写盘就变成"先改配置再测"了。
   *
   * 【为什么换一个临时 cacheDir】
   *   LM 的账本和缓存都落在 cacheDir。指向系统临时目录后，这次测试：
   *     ① 不会因为"本月已花超预算"而误报失败（新账本 spent=0）；
   *     ② 不会把测试花费混进生产账本，也不写生产缓存。
   *
   * 【为什么也要 nonce + 同源】
   *   它会花钱，而且请求体里带着用户填的 API Key —— 和发信同级防护。
   */
  if (path === '/api/llm/test' && req.method === 'POST') {
    const body = (await readBody(req)) as
      | { baseUrl?: string; apiKey?: string; model?: string; nonce?: string }
      | null;

    if (!body || !body.nonce || !consumeNonce(body.nonce)) {
      sendJson(res, 403, { error: '无效的请求令牌（可能是跨站请求，已拒绝）' });
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      const port = (serverAddress() ?? {}).port;
      const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
      if (!allowed.includes(origin)) {
        sendJson(res, 403, { error: `来源不被允许：${origin}` });
        return;
      }
    }

    const base = loadConfig();
    const llmBaseUrl =
      typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : base.llmBaseUrl;
    const llmApiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : base.llmApiKey;
    const llmModel = typeof body.model === 'string' ? body.model.trim() : base.llmModel;

    // 「测出来了」的结果一律 200 + ok:false（前端一套逻辑就能渲染）。
    // 只有安全防护失败才是真 HTTP 错误。
    const fail = (stage: string, error: string): void => {
      sendJson(res, 200, { ok: false, stage, error, elapsedMs: 0, httpStatus: 0, raw: '' });
    };

    // 只接受 http(s)：new URL 也能解析 file:// / data:，但那不是 LLM 网关，
    // 放过去等于给本地服务开一个任意协议探测口。
    let parsed: URL;
    try {
      parsed = new URL(llmBaseUrl);
    } catch {
      fail('validate', `Base URL 不是合法地址：${llmBaseUrl}`);
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      fail('validate', `Base URL 只能用 http/https，当前是 ${parsed.protocol}`);
      return;
    }
    // 【安全】拦截内网段与云元数据地址（169.254.169.254），防止把测试端点当
    // SSRF 跳板探测内网。**回环地址放行** —— 本地网关（如 127.0.0.1:8787）是
    // 本功能的正当用途，拦掉会让「测试连接」失效。该端点已有 nonce + Origin 保护，
    // 外部网页够不着，这里只封真正危险的跨网段目标。
    const host = (parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    const isLoopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
    const isDangerPrivate =
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.endsWith('.local') ||
      host.endsWith('.internal');
    if (isDangerPrivate && !isLoopback && process.env.MAIL_LLM_TEST_ALLOW_PRIVATE !== '1') {
      fail('validate', `Base URL 指向内网/元数据地址（${host}），出于安全拒绝。确实要测内网请在 .env 里设 MAIL_LLM_TEST_ALLOW_PRIVATE=1`);
      return;
    }
    if (!llmModel) {
      fail('validate', '模型名为空，填一个再测');
      return;
    }

    // 包一层 fetch：LM 内部自己组装 payload、处理 systemDelivery、超时、错误，
    // 这一层只负责"看见"原始 HTTP 状态与响应体，不改变请求。
    const captured = { url: '', status: 0, body: '' };
    const probeFetch: typeof fetch = async (input, init) => {
      const r = await globalThis.fetch(input, init);
      captured.url = String(input);
      captured.status = r.status;
      // clone 后再读，否则会消费掉 LM 后续要用的 body
      try {
        captured.body = await r.clone().text();
      } catch {
        captured.body = '';
      }
      return r;
    };

    const testCfg: Config = {
      ...base,
      llmBaseUrl,
      llmApiKey,
      llmModel,
      cacheDir: join(tmpdir(), 'mail-agent-llm-test'),
      budgetUsd: 0, // 配合独立账本，双保险：测试永不被预算闸门误挡
    };

    const t0 = Date.now();
    let ok = false;
    let reply = '';
    let error = '';
    let kind = '';
    let httpStatus = 0;
    let raw = '';

    try {
      // maxAttempts:1 —— 诊断要快速失败，不要退避重试拖着用户等
      const lm = new LM(testCfg, {
        tag: 'test',
        fetchImpl: probeFetch,
        maxAttempts: 1,
        noCache: true,
        timeoutMs: 15_000,
      });
      reply = await lm.complete(
        [{ role: 'user', content: '请只回复 OK 两个字母，不要说别的。' }],
        { temperature: 0, maxTokens: 16 },
      );
      ok = true;
      httpStatus = captured.status;
    } catch (e) {
      const err = e as { name?: string; message?: string; status?: number; body?: string };
      kind = err.name === 'BudgetExceeded' ? '预算' : err.name === 'LLMError' ? '网关/模型' : '网络';
      error = err.message ?? String(e);
      httpStatus = err.status ?? captured.status;
      raw = err.body ?? '';
    }
    if (!raw) raw = captured.body;

    sendJson(res, 200, {
      ok,
      kind,
      elapsedMs: Date.now() - t0,
      url: captured.url || `${llmBaseUrl.replace(/\/+$/, '')}/chat/completions`,
      httpStatus,
      model: llmModel,
      keyHint: maskApiKey(llmApiKey),
      reply: reply.slice(0, 300),
      error,
      // 网关原始响应：欠费 / 模型不存在 / 鉴权失败的原因都藏在这里，
      // 只给一句"连接失败"等于没回显。截断防止把整页撑爆。
      raw: raw.slice(0, 1200),
    });
    return;
  }

  /* ---------- 抓邮件 + 分类（花钱、连网）---------- */
  if (path === '/api/emails') {
    // 【安全】会连邮箱、调模型（花钱），必须校验来源，防本地恶意网页偷触发
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: '来源不被允许' });
      return;
    }
    const cfg = loadConfig();
    if (!cfg.imap) {
      sendJson(res, 400, { error: '没配置邮箱凭证。在 .env 里填 MAIL_IMAP_USER / MAIL_IMAP_PASS' });
      return;
    }

    const limit = Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, 50);
    // 调试开关：?classify=0 跳过 LLM 分类。
    // 【为什么需要】LLM 网关不稳时，前端会一直卡在"加载中"，
    // 根本没法调试界面本身。跳过分类后所有邮件的 category 都是 unknown，
    // 但列表/详情/草稿这些前端行为都能正常验证。
    const skipClassify = url.searchParams.get('classify') === '0';

    try {
      // 时区跟着配置走（用户改了 .env 不用改代码）
      WEB_TIMEZONE = cfg.timezone;

      const t0 = Date.now();
      const mails = await fetchImap(cfg.imap, { limit });
      const fetchMs = Date.now() - t0;

      const store = new MailStore(cfg.timezone);
      store.upsert(mails);

      let results: ClassifyResult[] = [];
      let classifyMs = 0;
      let calls = 0;
      let hits = 0;

      if (skipClassify) {
        classifyMs = 0;
      } else {
        const lm = new LM(cfg, 'classify');
        const t1 = Date.now();
        results = await classifyAll(lm, mails, cfg.timezone, 8);
        classifyMs = Date.now() - t1;
        calls = lm.callCount;
        hits = lm.hitCount;
      }

      applyLabels(mails, results);
      const byId = new Map(results.map((r) => [r.id, r]));

      const out: WebMail[] = mails.map((m) => toWebMail(m, byId.get(m.id)));

      // 存进会话缓存 —— /api/digest 直接复用，不重复抓、不重复分类（省钱）
      SESSION.mails = mails;
      SESSION.results = results;
      SESSION.fetchedAt = Date.now();

      sendJson(res, 200, {
        mails: out,
        stats: {
          count: mails.length,
          fetchMs,
          classifyMs,
          calls,
          hits,
        },
      });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
    return;
  }

  /* ---------- 写配置到 .env（能改密钥，要严格防护）---------- */
  if (path === '/api/config' && req.method === 'POST') {
    const body = (await readBody(req)) as { values?: Record<string, string>; nonce?: string } | null;

    if (!body || typeof body.values !== 'object' || body.values === null) {
      sendJson(res, 400, { error: '请求体缺少 values' });
      return;
    }

    // 【安全】一次性 nonce 校验
    //   nonce 只能通过同源 fetch 拿到（跨域会被 CORS 挡住读不到响应体），
    //   用掉即作废。这样即使有恶意网页想改你的 .env，也拿不到 nonce。
    if (!body.nonce || !consumeNonce(body.nonce)) {
      sendJson(res, 403, { error: '无效的请求令牌（可能是跨站请求，已拒绝）' });
      return;
    }

    // 【安全】来源检查：只接受同源
    const origin = req.headers.origin;
    if (origin) {
      const allowed = [`http://127.0.0.1:${(serverAddress() ?? {}).port}`, `http://localhost:${(serverAddress() ?? {}).port}`];
      if (!allowed.includes(origin)) {
        sendJson(res, 403, { error: `来源不被允许：${origin}` });
        return;
      }
    }

    const result = writeEnv(envPath(ROOT), body.values);
    if (!result.ok) {
      sendJson(res, 400, { error: result.error, rejected: result.rejected });
      return;
    }

    // 写完重新加载配置，让本次运行立刻生效
    try {
      loadConfig();
    } catch {
      // 配置可能不合法（比如 baseUrl 写错）—— 不影响写入，但告诉用户
      sendJson(res, 200, {
        ok: true,
        changed: result.changed,
        backupPath: result.backupPath,
        warning: '已写入 .env，但当前配置校验不通过，重启后可能报错',
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      changed: result.changed,
      backupPath: result.backupPath,
    });
    return;
  }

  /* ---------- 待办识别：从一封邮件里读出「要做什么 + 哪天之前」 ----------
   *
   * 【为什么只收 id，不收正文】
   *   邮件正文是不可信输入；让前端传正文等于开了个「任意文本调模型」的口子，
   *   既能刷账单，也会绕过「必须是本次会话真实邮件」这个前提。
   *   只认 SESSION.mails 里的 id —— 和 /api/reply 同一条原则。
   *
   * 【为什么加同源检查】
   *   这个接口会花钱（一次 LLM 请求）。虽然没有写副作用，但不该被随便一个
   *   本地网页跨站调起来。nonce 是给「改 .env」这类写操作用的，这里只做轻量 Origin 校验。
   *
   * 【结果不落盘】
   *   后端只把草稿返回给前端；真正写进日历是用户点「加入日历」之后、
   *   在浏览器 localStorage 里发生的 —— 和晨报、草稿一样的边界。
   */
  if (path === '/api/todo/extract' && req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin) {
      const port = (serverAddress() ?? {}).port;
      const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
      if (!allowed.includes(origin)) {
        sendJson(res, 403, { error: `来源不被允许：${origin}` });
        return;
      }
    }

    const body = (await readBody(req)) as { id?: string } | null;
    if (!body?.id) {
      sendJson(res, 400, { error: '缺少邮件 id' });
      return;
    }
    const target = SESSION.mails.find((m) => m.id === body.id);
    if (!target) {
      sendJson(res, 404, { error: '这封邮件不在本次会话里，请先「拉取邮件」' });
      return;
    }

    const cfg = loadConfig();
    const today = localYmd(new Date());
    try {
      const lm = new LM(cfg, 'todo');
      const t0 = Date.now();
      const todo = await extractTodo(lm, target, today);
      sendJson(res, 200, {
        ok: true,
        id: target.id,
        subject: target.subject,
        sender: target.sender,
        emailDate: target.date,
        today,
        todo,
        elapsedMs: Date.now() - t0,
        calls: lm.callCount,
        hits: lm.hitCount,
      });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
    return;
  }

  /* ---------- 回复草稿（只读：只生成，不发送）---------- */
  if (path === '/api/reply' && req.method === 'POST') {
    // 【安全】会调模型（花钱），校验来源
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: '来源不被允许' });
      return;
    }
    const body = (await readBody(req)) as { id?: string } | null;
    if (!body?.id) {
      sendJson(res, 400, { error: '缺少邮件 id' });
      return;
    }

    const cfg = loadConfig();

    // 从会话缓存里找这封邮件（必须是【已抓到】的，不能凭 id 去猜内容）
    const target = SESSION.mails.find((m) => m.id === body.id);
    if (!target) {
      sendJson(res, 404, { error: '这封邮件不在本次会话里，请先「拉取邮件」' });
      return;
    }

    try {
      const lm = new LM(cfg, 'reply');
      const t0 = Date.now();
      const draft = await generateReply(lm, {
        email: target,
        userName: process.env.MAIL_USER_NAME ?? '',
        userSignature: process.env.MAIL_USER_SIGNATURE ?? '',
      });
      const elapsedMs = Date.now() - t0;

      sendJson(res, 200, {
        ok: true,
        should: draft.should,
        reason: draft.reason,
        subject: buildReplySubject(target.subject, draft.subject),
        body: draft.body,
        to: replyToOf(target),
        elapsedMs,
        calls: lm.callCount,
        hits: lm.hitCount,
      });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
    return;
  }

  /* ---------- 真发信（有外部副作用，鉴权最严）---------- */
  if (path === '/api/send' && req.method === 'POST') {
    const body = (await readBody(req)) as
      | { to?: string; subject?: string; body?: string; inReplyTo?: string; nonce?: string }
      | null;

    if (!body || !body.to || !body.subject || !body.body) {
      sendJson(res, 400, { error: '缺少收件人/主题/正文' });
      return;
    }

    // 【安全】发信能【以你的名义】把内容发出去 —— 比改 .env 更危险。
    //   所以要求一次性 nonce + 同源检查，两道都要过。
    if (!body.nonce || !consumeNonce(body.nonce)) {
      sendJson(res, 403, { error: '无效的请求令牌（可能是跨站请求，已拒绝）' });
      return;
    }

    const origin = req.headers.origin;
    if (origin) {
      const port = (serverAddress() ?? {}).port;
      const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
      if (!allowed.includes(origin)) {
        sendJson(res, 403, { error: `来源不被允许：${origin}` });
        return;
      }
    }

    const cfg = loadConfig();
    if (!cfg.imap) {
      sendJson(res, 400, { error: '没配置邮箱凭证' });
      return;
    }

    // 收件人数量上限 —— 防止手滑填了一万个地址
    const recipients = body.to.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    if (recipients.length === 0) {
      sendJson(res, 400, { error: '收件人无效' });
      return;
    }
    if (recipients.length > 20) {
      sendJson(res, 400, { error: '收件人太多（上限 20 个）' });
      return;
    }
    // 收件人必须是合法邮箱 —— 防止把信发到奇怪的地方
    for (const r of recipients) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r)) {
        sendJson(res, 400, { error: `收件人格式不对：${r}` });
        return;
      }
    }

    try {
      const result = await sendMail(
        {
          host: process.env.MAIL_SMTP_HOST ?? 'smtp.qq.com',
          port: Number(process.env.MAIL_SMTP_PORT ?? 465),
          secure: (process.env.MAIL_SMTP_SECURE ?? 'true') !== 'false',
          user: cfg.imap.user,
          pass: cfg.imap.pass,
          helo: 'localhost',
        },
        {
          from: cfg.imap.user,
          to: recipients,
          subject: body.subject,
          text: body.body,
          inReplyTo: body.inReplyTo,
        },
      );

      // 记录到事件流（前端会显示）
      sendJson(res, 200, {
        ok: true,
        message: result.message,
        to: recipients,
        sentAt: new Date().toISOString(),
      });
    } catch (e) {
      if (e instanceof SmtpError) {
        // 【安全】transcript 只留在服务端日志排障，绝不回显给浏览器。
        // 认证行在 smtp.ts 的 write() 里已脱敏，这里再兜一层：只记前若干行。
        console.error('[web] 发信失败：', e.message, '\n' + e.transcript.slice(0, 12).join('\n'));
        sendJson(res, 502, { error: e.message });
      } else {
        sendJson(res, 500, { error: (e as Error).message });
      }
    }
    return;
  }

  /* ---------- 拿一次性 nonce ---------- */
  if (path === '/api/nonce') {
    sendJson(res, 200, { nonce: issueNonce() });
    return;
  }

  /* ---------- 读当前 .env 的值（用于设置面板回填）---------- */
  if (path === '/api/env') {
    const values = readEnvValues(envPath(ROOT));
    // 密钥打码 —— 不因为是本地就明文返回
    const masked: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      masked[k] = /KEY|PASS|SECRET|TOKEN/i.test(k) && v.length > 0 ? '••••••••' : v;
    }
    sendJson(res, 200, { values: masked });
    return;
  }

  /* ---------- 邮箱总结（花钱，但复用已抓的邮件）---------- */
  if (path === '/api/digest') {
    // 【安全】会调模型（花钱），校验来源
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: '来源不被允许' });
      return;
    }
    const cfg = loadConfig();

    // 没抓过 → 先抓一次（前端一般先拉邮件再点总结，这里是兜底）
    if (SESSION.mails.length === 0) {
      if (!cfg.imap) {
        sendJson(res, 400, { error: '没配置邮箱凭证' });
        return;
      }
      try {
        WEB_TIMEZONE = cfg.timezone;
        const mails = await fetchImap(cfg.imap, { limit: 20 });
        const lm = new LM(cfg, 'classify');
        const results = await classifyAll(lm, mails, cfg.timezone, 8);
        SESSION.mails = mails;
        SESSION.results = results;
        SESSION.fetchedAt = Date.now();
      } catch (e) {
        sendJson(res, 500, { error: (e as Error).message });
        return;
      }
    }

    try {
      const t0 = Date.now();
      const lm = new LM(cfg, 'digest');
      const pairs = SESSION.mails.map((email) => ({
        email,
        category: (SESSION.results.find((r) => r.id === email.id)?.category ?? 'unknown') as
          | 'urgent'
          | 'normal'
          | 'ignore'
          | 'unknown',
      }));

      const digest = await buildDigest(lm, pairs, cfg.timezone);

      sendJson(res, 200, {
        digest: {
          head: digest.head,
          action: digest.action,
          know: digest.know,
          ignoredCount: digest.ignoredCount,
          total: digest.total,
          text: digest.text,
          stats: digest.stats,
        },
        elapsedMs: Date.now() - t0,
        // 用的是哪一批邮件（前端可以显示"数据来自 X 分钟前"）
        fetchedAt: SESSION.fetchedAt,
      });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
    return;
  }

  /* ---------- 多跳检索问答（⑧）---------- */
  if (path === '/api/qa') {
    // 【安全】会调模型（花钱），校验来源
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: '来源不被允许' });
      return;
    }
    const question = (url.searchParams.get('q') ?? '').trim();
    if (!question) {
      sendJson(res, 400, { error: '缺少问题。用法：/api/qa?q=你的问题' });
      return;
    }
    if (question.length > 500) {
      sendJson(res, 400, { error: '问题太长（上限 500 字）' });
      return;
    }
    if (SESSION.mails.length === 0) {
      sendJson(res, 400, { error: '还没有邮件数据。先点「拉取邮件」再提问。' });
      return;
    }

    const cfg = loadConfig();
    try {
      const index = qaIndexOf(cfg);
      const byId = new Map(SESSION.mails.map((m) => [m.id, m]));

      // 【关键】BM25 只返回 {id, score} —— 光有 id 模型什么也看不到。
      // 这里把主题/发件人/正文补进去，模型才能据此作答。
      const searchFn = (query: string, k: number): QaHit[] =>
        index.search(query, k).map((h) => {
          const m = byId.get(h.id);
          return {
            id: h.id,
            score: h.score,
            meta: m
              ? { subject: m.subject, sender: m.sender, date: m.date, body: m.body }
              : undefined,
          };
        });

      const t0 = Date.now();
      const lm = new LM(cfg, 'qa');
      const result = await answerQuestion(lm, question, searchFn, 3);

      sendJson(res, 200, {
        question,
        answer: result.answer,
        support: result.support,
        hops: result.hops,
        searches: result.searches,
        droppedSupport: result.droppedSupport,
        error: result.error,
        elapsedMs: Date.now() - t0,
        // 引用了哪几封 —— 前端可以直接展示主题，比裸 id 有用
        sources: result.support
          .map((id) => byId.get(id))
          .filter((m): m is Email => !!m)
          .map((m) => ({ id: m.id, subject: m.subject, sender: m.sender, date: m.date })),
        fetchedAt: SESSION.fetchedAt,
        stats: { calls: lm.callCount, hits: lm.hitCount },
      });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
    return;
  }

  /* ---------- 数字人形象：存到 .env ---------- */
  //
  // 【为什么存 .env 而不是 localStorage】
  //   localStorage 是"这个浏览器、这台机器"的。清缓存、换浏览器、换设备就没了。
  //   而"我喜欢哪个数字人形象"是用户的长期偏好 —— 该跟 .env 里的其它配置放在一起。
  //   这样换浏览器打开，形象还是同一个。
  if (path === '/api/avatar' && req.method === 'GET') {
    const v = readEnvValues(envPath(ROOT));
    sendJson(res, 200, {
      key: v.MAIL_AVATAR_KEY ?? '',
      color: v.MAIL_AVATAR_COLOR ?? '',
      video: v.MAIL_AVATAR_VIDEO ?? '',
    });
    return;
  }

  if (path === '/api/avatar' && req.method === 'POST') {
    const body = (await readBody(req)) as
      | { key?: string; color?: string; video?: string; nonce?: string }
      | null;
    if (!body) {
      sendJson(res, 400, { error: '请求体为空' });
      return;
    }

    // 和 /api/config 同一套防护：nonce + 同源
    if (!body.nonce || !consumeNonce(body.nonce)) {
      sendJson(res, 403, { error: '无效的请求令牌' });
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      const allowed = [
        `http://127.0.0.1:${(serverAddress() ?? {}).port}`,
        `http://localhost:${(serverAddress() ?? {}).port}`,
      ];
      if (!allowed.includes(origin)) {
        sendJson(res, 403, { error: `来源不被允许：${origin}` });
        return;
      }
    }

    const values: Record<string, string> = {};
    // 空字符串表示"取消选择"（回到预设/默认配色），也要能存
    if (typeof body.key === 'string') values.MAIL_AVATAR_KEY = body.key.slice(0, 40);
    if (typeof body.color === 'string') values.MAIL_AVATAR_COLOR = body.color.slice(0, 40);
    if (typeof body.video === 'string') values.MAIL_AVATAR_VIDEO = body.video.slice(0, 255);

    const result = writeEnv(envPath(ROOT), values);
    if (!result.ok) {
      sendJson(res, 400, { error: result.error, rejected: result.rejected });
      return;
    }
    sendJson(res, 200, { ok: true, changed: result.changed, backupPath: result.backupPath });
    return;
  }

  /* ---------- 上传数字人视频到「数字人视频」目录 ---------- */
  //
  // 【为什么要这个接口】
  //   前端「选择视频文件」原来走 URL.createObjectURL → blob: 地址，
  //   刷新必然失效（blob 只活在当前页面里）。用户以为"上传了"，其实是假象。
  //   要真正持久化，文件必须落到磁盘 —— 也就是「数字人视频」目录。
  //
  // 【限制】
  //   · 只接受视频扩展名
  //   · 单文件上限 20MB（数字人形象是个小循环动画，不需要更大）
  //   · 文件名只允许安全字符，且不能覆盖已有文件（重名自动加后缀）
  if (path === '/api/avatars/upload' && req.method === 'POST') {
    const body = (await readBody(req)) as
      | { nonce?: string; name?: string; data?: string }
      | null;
    if (!body || typeof body.name !== 'string' || typeof body.data !== 'string') {
      sendJson(res, 400, { error: '请求体需要 { name, data(base64) }' });
      return;
    }
    if (!body.nonce || !consumeNonce(body.nonce)) {
      sendJson(res, 403, { error: '无效的请求令牌' });
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      const allowed = [
        `http://127.0.0.1:${(serverAddress() ?? {}).port}`,
        `http://localhost:${(serverAddress() ?? {}).port}`,
      ];
      if (!allowed.includes(origin)) {
        sendJson(res, 403, { error: `来源不被允许：${origin}` });
        return;
      }
    }

    // 文件名清洗：只留字母数字汉字和 . _ - 空格，去掉路径分隔符和 ..，
    const rawName = body.name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_').trim();
    const ext = extname(rawName).toLowerCase();
    if (!VIDEO_EXTS.has(ext)) {
      sendJson(res, 400, { error: '只接受 mp4 / webm / mov / m4v / ogv 视频' });
      return;
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(body.data.replace(/^data:[^;]+;base64,/, ''), 'base64');
    } catch {
      sendJson(res, 400, { error: 'base64 数据无法解码' });
      return;
    }
    const MAX_UPLOAD = 20 * 1024 * 1024;
    if (buf.length === 0) {
      sendJson(res, 400, { error: '文件是空的' });
      return;
    }
    if (buf.length > MAX_UPLOAD) {
      sendJson(res, 413, { error: `文件太大（上限 20MB，收到 ${(buf.length / 1048576).toFixed(1)}MB）` });
      return;
    }

    const dir = videoDir();
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      // 目录已存在
    }

    // 重名不覆盖 —— 加 -2 -3 后缀
    const base = rawName.slice(0, rawName.length - ext.length);
    let finalName = rawName;
    for (let i = 2; i < 100; i++) {
      if (!existsSync(join(dir, finalName))) break;
      finalName = `${base}-${i}${ext}`;
    }

    try {
      await writeFile(join(dir, finalName), buf);
      sendJson(res, 200, { ok: true, name: finalName, size: buf.length, dir: VIDEO_DIRNAME });
    } catch (e) {
      sendJson(res, 500, { error: `写入失败：${(e as Error).message}` });
    }
    return;
  }

  /* ---------- 花费明细 ---------- */
  if (path === '/api/ledger') {
    const cfg = loadConfig();
    sendJson(res, 200, { summary: await ledgerSummary(cfg) });
    return;
  }

  sendJson(res, 404, { error: '没有这个接口', path });
}

/* ============================ 启动 ============================ */

export interface ServeOptions {
  port?: number;
  host?: string;
}

export async function serve(opts: ServeOptions = {}): Promise<{ close: () => Promise<void>; port: number }> {
  // 启动时读一次 .env（后面的接口每次都重新读，方便改了配置立刻生效）
  loadDotenv();

  const host = opts.host ?? '127.0.0.1'; // 只监听本地 —— 见文件头的安全边界
  const port = opts.port ?? 5173;

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      const msg = (e as Error).message;
      // 响应已发出（或客户端提前断开）时绝不能再写第二次：writeHead 会抛
      // ERR_HTTP_HEADERS_SENT；而这个异常若发生在 catch 内部，就成了未处理的
      // rejection，Node 22 会直接让整个进程退出。这里只记日志，不回写。
      if (res.headersSent || res.writableEnded) {
        console.error('[web] 响应结束后仍有异常（已忽略）：', msg);
        return;
      }
      try {
        sendJson(res, 500, { error: msg });
      } catch {
        console.error('[web] 兜底响应发送失败：', msg);
      }
    });
  });
  CURRENT_SERVER = server;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  // ⚠️ 传 port=0 时，系统会分配一个随机端口 —— 但 `port` 变量还是 0。
  // 必须从 server.address() 取真实端口，否则调用方拿到 "http://127.0.0.1:0"。
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;

  return {
    port: actualPort,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/* 直接运行这个文件时启动服务 */
const isMain = process.argv[1]?.includes('web/server');
if (isMain) {
  const port = Number(process.env.PORT ?? 5173);
  serve({ port })
    .then(() => {
      // 守护循环只在实际启动服务时开；测试里 import serve({port:0}) 不受影响
      if (process.env.MAIL_MONITOR === '0') {
        console.log(`  后台守护：已通过 MAIL_MONITOR=0 关闭`);
      } else {
        bootMonitor();
        console.log(`  后台守护：已启动（每 60 秒检查新邮件，紧急的会弹提醒）`);
      }
      console.log(`\n  邮箱助手 Web UI 已启动`);
      console.log(`  → http://127.0.0.1:${port}\n`);
      console.log(`  提示：接口 /api/emails 会真的连邮箱、调模型（花钱）。`);
      console.log(`  停止：Ctrl+C\n`);
    })
    .catch((e) => {
      console.error(`启动失败：${(e as Error).message}`);
      process.exitCode = 1;
    });
}
