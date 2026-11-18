#!/usr/bin/env node
/**
 * tools/check-secrets.ts —— 提交前自检：扫一遍暂存区，看有没有密钥要漏出去。
 *
 * 【为什么需要它】
 *   .gitignore 挡的是"默认不提交"，挡不住人为的 git add -f。
 *   而且密钥可能以别的形式出现：写在源码注释里、粘在日志里、
 *   出现在 docs/ 的文档中 —— 这些 .gitignore 都不管。
 *   所以要有一道【内容级】的检查：不管文件从哪来，只看内容像不像密钥。
 *
 * 【怎么用】
 *   装成 git hook（提交前自动跑）：
 *     git init && ln -sf ../../tools/check-secrets.ts .git/hooks/pre-commit
 *   或者手动跑：
 *     npx tsx tools/check-secrets.ts
 *
 * 【退出码】
 *   0 = 干净；1 = 发现疑似密钥（会打印文件名与行号，但【不打印密钥本身】）
 */

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, relative } from 'node:path';

/* ============================ 规则 ============================ */

interface Rule {
  name: string;
  /** 命中即视为疑似泄漏 */
  pattern: RegExp;
  /** 命中后要额外排除的行（避免误报） */
  allow?: RegExp;
}

/**
 * 密钥特征规则。
 * 刻意做得"宁可误报不可漏报" —— 误报的代价是手动加一行 allow。
 */
const RULES: Rule[] = [
  {
    // OpenAI / 中转站 / DeepSeek 等通用格式：sk- 开头 20 位以上
    name: 'OpenAI 风格 API key (sk-...)',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/,
    // 文档里写 sk-xxxx 之类的占位符是正常的
    allow: /sk-x{4,}|sk-\.{3}|你的|示例|example|placeholder|xxxx/i,
  },
  {
    // 智谱 / 月之暗面等：32 位十六进制
    name: '十六进制格式 API key',
    pattern: /\b[a-f0-9]{32}\b(?![a-f0-9])/i,
    allow: /0{8,}|a{8,}|f{8,}|1234|example|xxxx/i,
  },
  {
    // AWS Access Key
    name: 'AWS Access Key ID (AKIA...)',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    // GitHub token
    name: 'GitHub token (ghp_/github_pat_)',
    pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/,
  },
  {
    // 私钥文件头
    name: '私钥 (-----BEGIN ... PRIVATE KEY-----)',
    pattern: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    // 常见的 key/value 赋值形式
    name: '疑似赋值形式的密钥',
    pattern: /\b(api[_-]?key|api[_-]?secret|access[_-]?token|secret[_-]?key|password|passwd|auth[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/i,
    allow: /example|placeholder|your|你的|xxxx|test|dummy|\$\{|\{\{/i,
  },
];

/* ============================ 工具 ============================ */

/** 从暂存区拿到文件列表；不在 git 仓库里就退回扫工作区。 */
function listTargets(): string[] {
  try {
    const out = execSync('git diff --cached --name-only --diff-filter=ACM', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** 只扫文本文件 —— 二进制（图片、字体）跳过。 */
function isTextFile(path: string): boolean {
  try {
    const buf = readFileSync(path);
    if (buf.includes(0)) return false; // 有 NUL 字节 = 二进制
    return true;
  } catch {
    return false;
  }
}

/* ============================ 主流程 ============================ */

function main(): void {
  const root = process.cwd();
  const targets = listTargets();

  const files = targets.length > 0 ? targets : [];
  if (files.length === 0) {
    console.log('✅ 没有待检查的文件（暂存区是空的）');
    return;
  }

  let problems = 0;

  for (const file of files) {
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    if (!isTextFile(abs)) continue;

    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 一行里可能有多个密钥片段，逐个规则扫
      for (const rule of RULES) {
        if (!rule.pattern.test(line)) continue;
        if (rule.allow?.test(line)) continue;

        problems++;
        console.error(`❌ ${file}:${i + 1}  疑似 ${rule.name}`);
        // 只打印行号，且把疑似密钥【整段替换掉】——
        // 连截断都不行：截断的中段仍然是密钥的一部分，够别人拼回去。
        console.error(`   ${mask(line)}`);
        console.error('');
        break; // 同一行只报一次
      }
    }
  }

  if (problems > 0) {
    console.error(`\n发现 ${problems} 处疑似密钥，已阻止提交。`);
    console.error('如果确认是误报，在该行加 allow 注释，或在 tools/check-secrets.ts 的 RULES 里加 allow。');
    process.exit(1);
  }

  console.log(`✅ 扫了 ${files.length} 个文件，没有发现密钥`);
}

/**
 * 打码：把疑似密钥整段替换成 ***REDACTED***，其余内容保留。
 *
 * 【为什么不截断而是整段替换】
 *   截断会露出中段 —— 而很多 key 是"前缀+中段+后缀"拼出来的，
 *   露出中段等于给了对方 1/3 的答案。这里宁可少给上下文，也要彻底。
 *   剩下的行号信息足够定位问题。
 */
function mask(line: string): string {
  const masked = line.replace(
    /\b(sk-[A-Za-z0-9_-]{8,}|[a-f0-9]{32,})\b/gi,
    (m) => `${m.slice(0, 4)}***REDACTED***`,
  );
  const trimmed = masked.trim();
  if (trimmed.length <= 100) return trimmed;
  return trimmed.slice(0, 100) + ' …';
}

main();
