/**
 * config.ts —— ① 配置加载：全项目唯一的「默认值集中地」。
 *
 * 【三条铁律】
 * 1. 魔法数字只允许出现在这个文件里（超时、预算、轮数上限……）。
 *    其它文件里出现 120_000 这种字面量，就是设计被破坏了。
 * 2. 优先级：环境变量 > .env 文件 > 代码默认值。
 *    真实环境变量（CI、shell export）永远压过 .env 文件。
 * 3. 缺关键配置在启动时立刻炸，不等到跑到一半才失败 ——
 *    "启动就报错"和"跑三分钟后来一句 undefined"是两种完全不同的体验。
 *
 * 【与 client.ts 的联动】
 *   Config extends LLMConfig
 *   —— 保证 loadConfig() 造出来的对象一定满足 client.ts 的要求，
 *      不用手写一份两边对齐的类型；将来 client.ts 加了字段，这里自动跟上。
 *      （TS 的结构化类型：多出来的字段不碍事，少的字段不行。）
 *
 * 【零依赖】
 *   .env 解析自己写十几行，不引 dotenv —— 依赖越少，看到的细节越多。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { LLMConfig, SystemDelivery } from './llm/client.js';
import { providerSpec, type ImapProviderSpec } from './mailbox/providers.js';

/**
 * 找项目根目录（package.json 所在的那一层），从当前目录一层层往上找。
 *
 * 【为什么必须这样做】
 *   配置文件和数据目录都【相对于启动目录】解析的话，就会出这种鬼故事：
 *     在深层子目录直接跑脚本        →  找不到 .env，报"没有 API key"
 *     在包根用 npm 脚本跑同一份代码  →  npm 把 cwd 设成包根，一切正常
 *   同一份代码、同一台机器，只因为你在哪一层敲命令就表现不同 —— 这没法调试。
 *   所以这里统一：所有相对路径都基于【项目根】解析，跟你在哪敲命令无关。
 */
export function projectRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(start);
}

/**
 * 邮箱接入配置（实时抓取用）。
 * 凭证只在这里、且只从 .env 来 —— 不进代码、不进日志、不进 git。
 */
export interface ImapSettings {
  /** 服务商 id：qq / exmail / outlook / gmail / 163 / 126 / custom */
  provider: string;
  /** 该服务商的接入提示（授权码怎么拿） */
  authNote: string;
  host: string;
  port: number;
  secure: boolean;
  /** 登录账号，一般是完整邮箱地址 */
  user: string;
  /** 授权码 / 应用专用密码（不是登录密码） */
  pass: string;
  /** 要打开的邮箱夹 */
  mailbox: string;
}

/** Agent 的运行模式：confirm = 副作用工具先要人审批；auto = 直接执行。 */
export type AgentMode = 'confirm' | 'auto';

/**
 * 厂商清单里的一项 —— **不含密钥**。
 * 这份东西是可以直接丢给前端渲染下拉框的：id / 显示名 / baseUrl / 默认模型。
 */
export interface ProviderSpec {
  /** 短标识，环境变量里对应 LLM_<大写ID>_API_KEY */
  id: string;
  /** 给人看的名字 */
  label: string;
  /** OpenAI 兼容接口的基地址 */
  baseUrl: string;
  /** 默认模型名 */
  model: string;
  /** 辅助模型（摘要/压缩用）。空 = 与主模型相同。 */
  auxModel?: string;
  /**
   * system 送达方式：inline（放在 messages 里）/ top（放请求体顶层）/ both（都放）。
   * 空 = 用默认值 'inline'。
   *
   * 【实测踩过的坑】网关之间在这件事上不统一：
   *   本机网关（OpenAI→Anthropic 转换）丢 role:system → 要 'top'
   *   8888ok.cc 这类中转站丢顶层 system          → 要 'inline'
   */
  systemDelivery?: SystemDelivery;
}

/** 厂商清单 + 密钥 + 就绪状态。密钥只留在后端，不外泄。 */
export interface ProviderConfig extends ProviderSpec {
  apiKey: string;
  /** 有没有配 key —— 前端据此决定这一项能不能选 */
  configured: boolean;
  /** 是不是内置预设（自定义的来自 providers.json） */
  builtin: boolean;
}

/**
 * 全项目唯一的配置结构。
 * 继承 LLMConfig 是为了跟 client.ts 保持同步 —— 那边要什么，这里就给什么。
 */
export interface Config extends LLMConfig {
  /**
   * 项目根目录（package.json 所在）。
   * 所有相对路径（data/、cache/、.env）都基于它解析 —— 从哪个目录启动都一样。
   */
  root: string;

  /** 辅助模型（上下文压缩、摘要这类离线慢任务用便宜模型）。空 = 与主模型相同。 */
  auxModel: string;

  /** 数据目录：emails.jsonl / processed.json / processed_log.jsonl 都在这。 */
  dataDir: string;

  /**
   * 时区。邮件里的时间是本地时间，"按天分组"必须跟着它走 ——
   * 换算成 UTC 会把 10月31日 03:00 的邮件分到 10月30日，晨报的"今天"就错了。
   */
  timezone: string;

  /* --- Agent 行为（第 ⑨ 步用，先把位置留出来）--- */

  /** 单次 send 最多几轮 ReAct。 */
  maxTurns: number;
  /** 单次 send 允许消耗的总 token。 */
  tokenBudget: number;
  /** 单次模型调用的上下文上限，超过就先压缩再发。 */
  contextBudget: number;
  /** confirm = 副作用工具先审批；auto = 直接执行。 */
  mode: AgentMode;
  /** 危险命令正则黑名单（护栏）。 */
  denyRules: RegExp[];

  /* --- 通知（monitor）--- */

  /** 弹窗在屏幕上停留多久（毫秒）。到点自动消失。 */
  popupTtlMs: number;
  /** 弹窗后多久没人处理就降级为普通、不再打扰（毫秒）。 */
  escalateAfterMs: number;
  /** 两次弹窗之间的最小间隔（毫秒）—— 防刷屏。 */
  notifyCooldownMs: number;
  /** 同一封邮件最多弹几次。 */
  notifyMaxRepeat: number;

  /* --- 多厂商 --- */

  /** 所有可选厂商（内置预设 + providers.json 自定义 + 旧式单厂商写法）。 */
  providers: ProviderConfig[];
  /** 当前选中的厂商 id。 */
  providerId: string;

  /* --- 邮箱（实时抓取）--- */

  /**
   * IMAP 配置。没配账号密码时是 null —— 程序照常跑，只是没法拉邮件。
   * （凭证是可选的：没有邮箱也能用演示数据跑管线。）
   */
  imap: ImapSettings | null;
}

/**
 * 内置厂商预设。
 * 作用：用户只要在 .env 里填一个 API key 就能多出一个可选项，不用改任何代码。
 * 想加新厂商？两条路：① 在 data/providers.json 里写一段；② 改这里加一条预设。
 */
export const BUILTIN_PROVIDERS: ProviderSpec[] = [
  { id: 'local', label: '本机网关', baseUrl: 'http://127.0.0.1:8787/v1', model: 'GLM-5.3' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'glm', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'moonshot', label: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'qwen', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
];


/**
 * 把 .env 文件读进 process.env。
 *
 * 约定：
 * - 已存在的环境变量优先，不被文件覆盖（真实环境 > 文件）。
 * - 支持 `KEY=value`、`KEY="value"`、`KEY='value'`。
 * - 未加引号时，` #` 之后算注释（跟大多数 .env 解析器一致）。
 * - 空行和 # 开头的行忽略。
 * - **不传路径时自动找项目根的 .env**（不是当前目录的！）——
 *   这样从任何子目录启动程序都能读到同一份配置。
 */
export function loadDotenv(path?: string): void {
  const file = path ?? join(projectRoot(), '.env');
  if (!existsSync(file)) return;

  const text = readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue; // 没有 = 或者 = 在最前面，都不是合法赋值

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1); // 去掉引号
    } else {
      const hash = value.indexOf(' #'); // 未加引号时，后面是注释
      if (hash >= 0) value = value.slice(0, hash).trim();
    }

    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * 从环境变量读一个数字。
 * 关键：**非法就抛错，而不是悄悄用默认值**。
 * `MAIL_BUDGET_USD=abc` 静默变成 2.0 是一件很坑的事 —— 你以为改了预算，其实没改。
 */
function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`配置项 ${key} 不是合法数字：${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * 从环境变量读 Agent 的 deny 规则（额外护栏）。
 * 【为什么是纯文本而不是正则】让用户写正则 = 自找 ReDoS 和转义 bug。
 *   这里把每段文本当【字面子串】处理，转义掉正则元字符后编译，
 *   匹配「工具名 + 参数 JSON」里是否出现该子串。用 `||` 分隔多条。
 * 例：MAIL_AGENT_DENY=forward||external-transfer
 */
function denyRulesFromEnv(env: NodeJS.ProcessEnv): RegExp[] {
  const raw = env.MAIL_AGENT_DENY;
  if (!raw || !raw.trim()) return [];
  return raw
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
}

/**
 * 读自定义厂商清单：data/providers.json（可选文件，不存在就算了）。
 *
 * 为什么要单独一个文件：厂商清单是"结构化配置"（地址、模型、显示名），
 * 而密钥在 .env。两者分开 → 加一个新厂商只要改 JSON + 加一行 key，不用碰代码。
 *
 * 文件格式：
 *   { "my-gw": { "label": "公司网关", "baseUrl": "https://gw/v1", "model": "xxx" } }
 */
function loadProviderSpecs(env: NodeJS.ProcessEnv): ProviderSpec[] {
  const specs: ProviderSpec[] = [...BUILTIN_PROVIDERS];

  const file = resolve(env.MAIL_DATA_DIR ?? 'data', 'providers.json');
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Partial<ProviderSpec>>;
      for (const [id, spec] of Object.entries(raw)) {
        if (!id || !spec.baseUrl) continue; // 没地址的条目没法用，跳过
        specs.push({
          id,
          label: spec.label ?? id,
          baseUrl: spec.baseUrl,
          model: spec.model ?? 'gpt-4o-mini',
          auxModel: spec.auxModel,
        });
      }
    } catch (e) {
      throw new Error(`providers.json 解析失败：${(e as Error).message}`);
    }
  }

  // 兼容旧写法：只有 LLM_API_KEY 时，把它当成一家名叫 default 的厂商
  const legacyKey = (env.LLM_API_KEY ?? '').trim();
  if (legacyKey && !specs.some((s) => s.id === 'default')) {
    specs.push({
      id: 'default',
      label: '默认（.env 单厂商写法）',
      baseUrl: (env.LLM_BASE_URL ?? 'https://api.openai.com/v1').trim(),
      model: (env.LLM_MODEL ?? 'gpt-4o-mini').trim(),
      auxModel: (env.AUX_MODEL ?? '').trim() || undefined,
    });
  }

  // 纯 env 定义一家新厂商：LLM_<ID>_BASE_URL 出现，就自动生成这一家。
  // 这条是给「中转站」准备的 —— 中转站就是 OpenAI 兼容接口，
  // 所以接一家新中转站只要三行 .env，不用改代码、不用建 providers.json：
  //   LLM_PROVIDER=relay
  //   LLM_RELAY_BASE_URL=https://your-relay/v1
  //   LLM_RELAY_API_KEY=sk-xxx
  for (const [key, value] of Object.entries(env)) {
    const m = /^LLM_([A-Z0-9]+(?:_[A-Z0-9]+)*)_BASE_URL$/.exec(key);
    if (!m) continue;
    const upper = m[1];
    if (upper === 'PROVIDER') continue; // LLM_PROVIDER 是"当前选中谁"，不是一家厂商
    const id = upper.toLowerCase();
    if (specs.some((s) => s.id === id)) continue; // 内置预设/JSON 里已有的不重复加
    const raw = (value ?? '').trim();
    if (!raw) continue;
    specs.push({
      id,
      label: id.toUpperCase(),
      baseUrl: raw,
      model: (env[`LLM_${upper}_MODEL`] ?? 'gpt-4o-mini').trim(),
      auxModel: (env[`LLM_${upper}_AUX_MODEL`] ?? '').trim() || undefined,
    });
  }

  return specs;
}

/**
 * 组装厂商列表：把「清单」和「密钥」缝在一起。
 *
 * 密钥从 LLM_<大写ID>_API_KEY 读。所以：
 *   LLM_LOCAL_API_KEY   → 预设 local
 *   LLM_OPENAI_API_KEY  → 预设 openai
 *   LLM_MYGATEWAY_API_KEY → 自定义 mygateway（前提是 providers.json 里有它）
 *
 * 注意：我们只按「已知的 id」去取 key，不去遍历环境变量猜厂商 ——
 * 这样 LLM_PROVIDER（当前选中）不会被误认成一家厂商。
 */
export function loadProviders(env: NodeJS.ProcessEnv = process.env): ProviderConfig[] {
  const specs = loadProviderSpecs(env);

  return specs.map((spec) => {
    const prefix = `LLM_${spec.id.toUpperCase()}_`;
    // 只有旧式那一家（default）吃 LLM_API_KEY；其余各家必须用自己专属的变量名，
    // 否则一个 legacy key 会把所有预设都标成"已配置"。
    const apiKey =
      spec.id === 'default'
        ? (env.LLM_API_KEY ?? '').trim()
        : (env[`${prefix}API_KEY`] ?? '').trim();
    // 地址 / 模型也允许用 env 覆盖（这样改模型不用动 providers.json）
    const baseUrl = (env[`${prefix}BASE_URL`] ?? spec.baseUrl).trim();
    const model = (env[`${prefix}MODEL`] ?? spec.model).trim();
    const auxModel = (env[`${prefix}AUX_MODEL`] ?? spec.auxModel ?? '').trim();
    // system 送达方式也可按厂商覆盖
    const deliveryRaw = (env[`${prefix}SYSTEM_DELIVERY`] ?? spec.systemDelivery ?? 'inline')
      .trim()
      .toLowerCase();
    if (deliveryRaw !== 'inline' && deliveryRaw !== 'top' && deliveryRaw !== 'both') {
      throw new Error(
        `配置项 ${prefix}SYSTEM_DELIVERY 取值非法：${JSON.stringify(deliveryRaw)}` +
          `（只能是 inline / top / both）`,
      );
    }
    return {
      ...spec,
      apiKey,
      baseUrl,
      model,
      auxModel: auxModel || undefined,
      systemDelivery: deliveryRaw,
      configured: apiKey.length > 0,
      builtin: BUILTIN_PROVIDERS.some((b) => b.id === spec.id),
    };
  });
}

/**
 * 选定一家厂商，返回**可以直接喂给 client.ts 的 LLMConfig**。
 *
 * 这是"前端选厂商"落地的那个函数：
 *   前端传 id → 后端调它 → 拿到 LLMConfig → new LM(cfg, tag)
 * 密钥全程留在后端，前端从头到尾只见过一个 id。
 */
export function selectProvider(cfg: Config, id: string): LLMConfig {
  const p = cfg.providers.find((x) => x.id === id);
  if (!p) {
    throw new Error(
      `未知厂商：${JSON.stringify(id)}（可用：${cfg.providers.map((x) => x.id).join(' / ')}）`,
    );
  }
  if (!p.configured) {
    throw new Error(
      `厂商 ${p.label}（${p.id}）还没配置 API key —— 在 .env 里加 LLM_${p.id.toUpperCase()}_API_KEY`,
    );
  }
  return {
    llmBaseUrl: p.baseUrl,
    llmApiKey: p.apiKey,
    llmModel: p.model,
    budgetUsd: cfg.budgetUsd,
    requestTimeoutMs: cfg.requestTimeoutMs,
    cacheDir: cfg.cacheDir,
    // scope：告诉 client.ts "这份缓存属于哪一家" —— 同名模型不能共用缓存
    scope: p.id,
    // system 送达方式：按厂商配（网关之间不统一）
    systemDelivery: p.systemDelivery ?? 'inline',
  };
}

/**
 * 给前端渲染下拉框用的清单。
 * **注意返回值里没有 apiKey** —— 前端只该知道"有哪些家、选哪家、能不能用"。
 */
export function listProviders(cfg: Config): Array<{
  id: string;
  label: string;
  model: string;
  configured: boolean;
  active: boolean;
}> {
  return cfg.providers.map((p) => ({
    id: p.id,
    label: p.label,
    model: p.model,
    configured: p.configured,
    active: p.id === cfg.providerId,
  }));
}

/**
 * 读 IMAP（邮箱）配置。
 *
 * 两种配法：
 *   ① 按服务商（推荐）：MAIL_IMAP_PROVIDER=qq + MAIL_IMAP_USER + MAIL_IMAP_PASS
 *      host/port/secure 自动从预设表取。
 *   ② 完全自定义：MAIL_IMAP_PROVIDER=custom + MAIL_IMAP_HOST/PORT/SECURE
 *
 * 没配 user/pass 就返回 null —— "没邮箱"是合法状态，不该让程序起不来。
 */
export function loadImapSettings(env: NodeJS.ProcessEnv = process.env): ImapSettings | null {
  const provider = (env.MAIL_IMAP_PROVIDER ?? '').trim();
  const user = (env.MAIL_IMAP_USER ?? '').trim();
  const pass = (env.MAIL_IMAP_PASS ?? '').trim();
  if (!provider || !user || !pass) return null;

  const spec: ImapProviderSpec | undefined = providerSpec(provider);
  const host =
    (env.MAIL_IMAP_HOST ?? '').trim() || spec?.host || '';
  if (!host) {
    throw new Error(
      `MAIL_IMAP_PROVIDER=${provider} 没有可用的服务器地址 —— ` +
        '请在 .env 里补 MAIL_IMAP_HOST',
    );
  }

  const secureRaw = (env.MAIL_IMAP_SECURE ?? '').trim().toLowerCase();
  const secure =
    secureRaw === '' ? (spec?.secure ?? true) : secureRaw === 'true' || secureRaw === '1';

  return {
    provider,
    authNote: spec?.authNote ?? '',
    host,
    port: num(env, 'MAIL_IMAP_PORT', spec?.port ?? 993),
    secure,
    user,
    pass,
    mailbox: (env.MAIL_IMAP_MAILBOX ?? 'INBOX').trim(),
  };
}

/**
 * 读配置并做启动校验。
 *
 * 纯函数风格：给它一份 env，它给你一份 Config —— 所以测试可以随便传假 env 进来，
 * 不用真的改 process.env。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const providers = loadProviders(env);
  // 所有相对路径都基于项目根解析 —— 跟启动目录无关
  const root = projectRoot();

  // 当前选谁：LLM_PROVIDER > 旧式写法(default) > 第一个配好 key 的 > 第一个
  const requested = (env.LLM_PROVIDER ?? '').trim();
  if (requested && !providers.some((p) => p.id === requested)) {
    // 拼错 id 必须报错，不能静默回退到别家 —— 你以为在用 OpenAI，其实在用别的
    throw new Error(
      `LLM_PROVIDER=${requested} 不是已知厂商（可用：${providers.map((p) => p.id).join(' / ')}）`,
    );
  }
  const providerId =
    requested ||
    (providers.some((p) => p.id === 'default' && p.configured) ? 'default' : '') ||
    (providers.find((p) => p.configured)?.id ?? '') ||
    providers[0]?.id ||
    '';

  const active = providers.find((p) => p.id === providerId);

  const cfg: Config = {
    /* --- LLM：这三个字段 = 当前选中厂商的解析结果（兼容单厂商的老用法）--- */
    llmBaseUrl: active?.baseUrl ?? (env.LLM_BASE_URL ?? 'https://api.openai.com/v1').trim(),
    llmApiKey: active?.apiKey ?? (env.LLM_API_KEY ?? '').trim(),
    llmModel: active?.model ?? (env.LLM_MODEL ?? 'gpt-4o-mini').trim(),
    auxModel: active?.auxModel ?? (env.AUX_MODEL ?? '').trim(),
    // 预算上限（美元）。<= 0 表示不限 —— 本地调试时可以用它关掉护栏。
    budgetUsd: num(env, 'MAIL_BUDGET_USD', 2),
    // 单次 HTTP 请求超时（毫秒）
    requestTimeoutMs: num(env, 'LLM_TIMEOUT_MS', 120_000),

    /* --- 目录 --- */
    root,
    dataDir: resolve(root, env.MAIL_DATA_DIR ?? 'data'),
    cacheDir: resolve(root, env.MAIL_CACHE_DIR ?? '.cache'),
    timezone: env.MAIL_TIMEZONE ?? 'Asia/Shanghai',

    /* --- Agent 行为 --- */
    maxTurns: num(env, 'MAIL_MAX_TURNS', 15),
    tokenBudget: num(env, 'MAIL_TOKEN_BUDGET', 150_000),
    contextBudget: num(env, 'MAIL_CONTEXT_BUDGET', 12_000),
    mode: env.MAIL_MODE === 'auto' ? 'auto' : 'confirm',
    denyRules: denyRulesFromEnv(env),

    /* --- 通知时限 --- */
    // 弹窗显示时长：10 秒。这是纯 UI 行为 —— 到了就自动消失。
    popupTtlMs: num(env, 'MAIL_POPUP_TTL_MS', 10_000),
    // 降级时限：弹窗后多久没人管就不再打扰。30 分钟。
    // ⚠️ 这两个是【不同的东西】：TTL 决定"弹窗活多久"，SLA 决定"多久算过期"。
    escalateAfterMs: num(env, 'MAIL_ESCALATE_AFTER_MS', 30 * 60_000),
    // 冷却期：两封邮件之间至少隔多久才弹第二个，防止一批邮件同时到时刷屏
    notifyCooldownMs: num(env, 'MAIL_NOTIFY_COOLDOWN_MS', 5 * 60_000),
    // 同一封邮件最多弹几次。1 = 每封信只提醒一次（推荐）
    notifyMaxRepeat: num(env, 'MAIL_NOTIFY_MAX_REPEAT', 1),

    /* --- 多厂商 --- */
    providers,
    providerId,

    /* --- 邮箱 --- */
    imap: loadImapSettings(env),
  };

  // ---------- 启动即校验 ----------
  if (!cfg.llmApiKey) {
    throw new Error(
      '没有可用的模型厂商：' +
        (requested
          ? `LLM_PROVIDER=${requested} 但它没有配置 API key（.env 里加 LLM_${requested.toUpperCase()}_API_KEY）`
          : '在 .env 里加 LLM_<厂商>_API_KEY，或在 providers.json 里声明一家自定义厂商') +
        '（启动即校验，不等跑到一半才炸）',
    );
  }
  if (!/^https?:\/\//.test(cfg.llmBaseUrl)) {
    throw new Error(
      `LLM_BASE_URL 不合法：${JSON.stringify(cfg.llmBaseUrl)}（应以 http:// 或 https:// 开头）`,
    );
  }
  if (cfg.budgetUsd < 0) {
    throw new Error(`MAIL_BUDGET_USD 不能为负：${cfg.budgetUsd}`);
  }
  if (cfg.maxTurns <= 0) {
    throw new Error(`MAIL_MAX_TURNS 必须大于 0：${cfg.maxTurns}`);
  }
  if (cfg.contextBudget <= 0) {
    throw new Error(`MAIL_CONTEXT_BUDGET 必须大于 0：${cfg.contextBudget}`);
  }
  if (cfg.popupTtlMs <= 0) {
    throw new Error(`MAIL_POPUP_TTL_MS 必须大于 0：${cfg.popupTtlMs}`);
  }
  if (cfg.escalateAfterMs <= 0) {
    throw new Error(`MAIL_ESCALATE_AFTER_MS 必须大于 0：${cfg.escalateAfterMs}`);
  }
  if (cfg.notifyCooldownMs < 0) {
    throw new Error(`MAIL_NOTIFY_COOLDOWN_MS 不能为负：${cfg.notifyCooldownMs}`);
  }
  if (cfg.notifyMaxRepeat < 1) {
    throw new Error(`MAIL_NOTIFY_MAX_REPEAT 必须至少为 1：${cfg.notifyMaxRepeat}`);
  }

  return cfg;
}


/** 建好数据目录与缓存目录（幂等，重复调用无副作用）。 */
export function ensureDirs(cfg: Config): void {
  mkdirSync(resolve(cfg.dataDir), { recursive: true });
  mkdirSync(resolve(cfg.cacheDir), { recursive: true });
}

/**
 * 一次性启动：读 .env → 读配置 → 建目录。
 * 这是程序真正的入口该调用的那个函数。
 */
export function bootstrap(env: NodeJS.ProcessEnv = process.env): Config {
  loadDotenv();
  const cfg = loadConfig(env);
  ensureDirs(cfg);
  return cfg;
}

/**
 * 打印配置（**API key 打码**）。
 * 为什么要专门写这个函数：日志会被贴到群里、传给别人、存进 CI 输出里。
 * 顺手就把 key 露出去是最常见的低级事故。
 */
export function describeConfig(cfg: Config): string {
  const key = cfg.llmApiKey
    ? `${cfg.llmApiKey.slice(0, 3)}…${cfg.llmApiKey.slice(-2)}`
    : '(空)';
  const lines = [
    `当前厂商 ${cfg.providerId}  →  ${cfg.llmBaseUrl}  model=${cfg.llmModel}`,
    `key    ${key}`,
    `预算   $${cfg.budgetUsd}${cfg.budgetUsd <= 0 ? '（不限）' : ''}   超时 ${cfg.requestTimeoutMs}ms`,
    `目录   data=${cfg.dataDir}   cache=${cfg.cacheDir}`,
    `Agent  mode=${cfg.mode}   maxTurns=${cfg.maxTurns}   tokenBudget=${cfg.tokenBudget}   contextBudget=${cfg.contextBudget}`,
    '',
    '可选厂商：',
  ];
  for (const p of listProviders(cfg)) {
    const mark = p.active ? '*' : ' ';
    const state = p.configured ? '已配置' : '缺 API key';
    lines.push(`  ${mark} ${p.id.padEnd(10)} ${p.label.padEnd(12)} ${p.model.padEnd(18)} ${state}`);
  }
  return lines.join('\n');
}
