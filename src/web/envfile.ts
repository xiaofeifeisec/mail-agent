/**
 * src/web/envfile.ts —— 读写 .env 文件。
 *
 * 【为什么单独一个文件】
 *   config.ts 是"读"配置（启动时），这里是"写"配置（用户改设置时）。
 *   两者分开，读写逻辑互不干扰 —— 尤其不能让"写"的 bug 影响启动。
 *
 * 【写入的三条铁律】
 *   ① 保留原有注释和顺序 —— .env 是给人看的，注释是文档
 *   ② 原子写（临时文件 + rename）—— 断电时不会写出半个文件
 *   ③ 先备份 —— 万一写坏了能退回去
 *
 * 【只允许写白名单里的键】
 *   不能让前端传什么键就写什么键 —— 否则一个恶意网页
 *   就能往你的 .env 里塞 `NODE_OPTIONS=--require 恶意脚本`。
 *   白名单是硬编码的，接口只能改这些。
 */

import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 允许通过接口修改的键（模式匹配）。
 *
 * ⚠️ 这个白名单是安全边界 —— 新增键要想清楚：
 *   绝不能放 NODE_OPTIONS / NODE_PATH / LD_PRELOAD 这类
 *   能让 Node 加载任意代码的环境变量。
 *
 * 【为什么用模式而不是精确列表】
 *   界面稿支持多邮箱账号（MAIL_IMAP_USER_2）和多厂商（LLM_OPENAI_API_KEY），
 *   这些键名是动态的 —— 用模式匹配才能覆盖。
 *   但模式必须够窄：MAIL_IMAP_* 允许后缀，LLM_* 只允许特定后缀。
 */
const WRITABLE_PATTERNS: RegExp[] = [
  // 邮箱（允许多账号后缀 _2 _3 …）
  /^MAIL_IMAP_(PROVIDER|HOST|PORT|SECURE|USER|PASS|MAILBOX|LABEL)(_\d+)?$/,
  // LLM 厂商（只允许这几类字段，且厂商段是大写 id）
  /^LLM_[A-Z0-9]+_(BASE_URL|API_KEY|MODEL|AUX_MODEL|SYSTEM_DELIVERY)$/,
  // 顶层 LLM 开关
  /^LLM_(PROVIDER|BASE_URL|API_KEY|MODEL|AUX_MODEL|SYSTEM_DELIVERY)$/,
  // 预算与行为
  /^MAIL_(BUDGET_USD|MAX_TURNS|TOKEN_BUDGET|CONTEXT_BUDGET|MODE|TIMEZONE)$/,
  /^LLM_TIMEOUT_MS$/,
  // 用户身份
  /^MAIL_USER_(NAME|ALIAS|SIGNATURE)$/,
  // 数字人形象：key 是预设名、color 是配色、VIDEO 是选中的视频文件名
  /^MAIL_AVATAR_(KEY|COLOR|VIDEO)$/,
  // 界面偏好（主题、默认城市）—— 跨浏览器/换设备也一致
  /^MAIL_UI_(THEME|WEATHER_CITY)$/,
];

/** 判断一个键是否允许写入。 */
export function isWritableKey(key: string): boolean {
  const k = key.trim();
  if (FORBIDDEN_KEYS.has(k)) return false;
  return WRITABLE_PATTERNS.some((re) => re.test(k));
}

/** 绝不允许通过接口写入的键（防御性清单）。 */
const FORBIDDEN_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'PATH',
  'HOME',
  'SHELL',
]);

/** 写 .env 的结果。 */
export interface EnvWriteResult {
  ok: boolean;
  /** 实际改了哪些键 */
  changed: string[];
  /** 被拒绝的键（不在白名单） */
  rejected: string[];
  /** 备份文件路径 */
  backupPath: string;
  /** 出错原因 */
  error?: string;
}

/**
 * 把一组键值写进 .env。
 *
 * @param envPath .env 的完整路径
 * @param values  要写入的键值对
 */
export function writeEnv(envPath: string, values: Record<string, string>): EnvWriteResult {
  const changed: string[] = [];
  const rejected: string[] = [];

  // ---- ① 校验键 ----
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const k = key.trim();
    if (FORBIDDEN_KEYS.has(k)) {
      rejected.push(`${k}（禁止写入的环境变量）`);
      continue;
    }
    if (!isWritableKey(k)) {
      rejected.push(`${k}（不在白名单）`);
      continue;
    }
    clean[k] = String(value);
  }

  if (rejected.length > 0) {
    return {
      ok: false,
      changed: [],
      rejected,
      backupPath: '',
      error: `有 ${rejected.length} 个键不允许写入：${rejected.join('、')}`,
    };
  }

  // ---- ② 读原文件（不存在就当空）----
  const original = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const lines = original.length > 0 ? original.split(/\r?\n/) : [];

  // ---- ②b 空值保护 ----
  //   空值意味着"没填"。如果直接写进去，会把 .env 里已有的密钥清空。
  //   （前端已经跳过空值，这里是后端兜底 —— 双保险。）
  const existing = readEnvValues(envPath);
  for (const [k, v] of Object.entries(clean)) {
    if (v.trim() === '' && existing[k] !== undefined && existing[k] !== '') {
      delete clean[k]; // 保留原值，不清空
    }
  }

  // ---- ③ 备份 ----
  const backupPath = `${envPath}.bak`;
  if (existsSync(envPath)) {
    try {
      copyFileSync(envPath, backupPath);
      chmodSync(backupPath, 0o600);
    } catch {
      // 备份失败不阻断 —— 至少要保证主流程能走
    }
  }

  // ---- ④ 逐行更新，保留注释与顺序 ----
  const seen = new Set<string>();
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // 注释行、空行原样保留
    if (!trimmed || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }

    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      out.push(line); // 不是合法赋值，原样保留
      continue;
    }

    const key = trimmed.slice(0, eq).trim();
    if (!(key in clean)) {
      out.push(line); // 不在本次更新范围内的键，原样保留
      continue;
    }

    if (seen.has(key)) {
      continue; // 同一个键重复出现，只保留第一处（避免歧义）
    }
    seen.add(key);

    // 【只有值真的变了才算"改了"】
    //   否则用户点一次保存，面板会说"改了 7 项"，
    //   实际只有 1 项变了 —— 数字不准会让人怀疑是不是把配置搞乱了。
    const oldValue = existing[key];
    const newValue = clean[key];
    if (oldValue === newValue) {
      out.push(line); // 值没变，原样保留（连引号格式都不动）
      continue;
    }

    out.push(`${key}=${formatValue(newValue)}`);
    changed.push(key);
  }

  // ---- ⑤ 新键追加到末尾（带空行分隔）----
  const missing = Object.keys(clean).filter((k) => !seen.has(k));
  if (missing.length > 0) {
    if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('');
    out.push('# ---- 由 Web UI 设置面板写入 ----');
    for (const k of missing) {
      out.push(`${k}=${formatValue(clean[k])}`);
      changed.push(k);
    }
  }

  // ---- ⑥ 原子写 ----
  try {
    const tmp = `${envPath}.tmp`;
    writeFileSync(tmp, out.join('\n') + '\n', 'utf8');
    chmodSync(tmp, 0o600); // 只有本人可读写
    renameSync(tmp, envPath);
    chmodSync(envPath, 0o600);
  } catch (e) {
    return {
      ok: false,
      changed: [],
      rejected,
      backupPath,
      error: `写入失败：${(e as Error).message}`,
    };
  }

  // ---- ⑦ 同步到 process.env，让本次运行的配置立刻生效 ----
  for (const [k, v] of Object.entries(clean)) {
    process.env[k] = v;
  }

  return { ok: true, changed, rejected, backupPath };
}

/**
 * 格式化值：需要引号的加引号，含特殊字符的转义。
 * 为什么要引号：值里有空格或 # 时，不加引号会被解析错。
 */
function formatValue(v: string): string {
  if (v === '') return '';
  // 需要引号的场景：含空格 / # / 引号 / 换行 / 特殊符号
  if (/[\s#"'`\\]/.test(v)) {
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return v;
}

/**
 * 读出 .env 的键值对（不写入 process.env）。
 * 用于前端展示"当前配置"。
 */
export function readEnvValues(envPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(envPath)) return out;

  for (const raw of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (key) out[key] = value;
  }
  return out;
}

/** .env 的默认路径。 */
export function envPath(root: string): string {
  return join(root, '.env');
}
