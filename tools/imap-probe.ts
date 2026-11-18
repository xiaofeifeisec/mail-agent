/**
 * tools/imap-probe.ts —— 邮箱连通性探针（实时抓取的"手动挡"）。
 *
 * 用途：填好 .env 之后，用它确认"能不能连上邮箱、能不能抓到信"。
 * 它【不落盘】：拉到的邮件只在内存里打印一下摘要就扔掉。
 *
 * 跑法：
 *   npx tsx tools/imap-probe.ts              # 连通性检查 + 拉最近 5 封
 *   npx tsx tools/imap-probe.ts 20           # 拉最近 20 封
 *   npx tsx tools/imap-probe.ts 20 --full    # 连正文一起打印
 *
 * 两步走：
 *   ① verifyImap  —— 只登录、只列邮箱夹，绝不碰邮件内容（verifyOnly 模式）
 *   ② fetchImap   —— 真的拉 N 封（用 BODY.PEEK，不会把邮件标记成已读）
 */

import { loadDotenv, loadConfig } from '../src/config.js';
import { IMAP_PROVIDERS } from '../src/mailbox/providers.js';
import { verifyImap, fetchImap } from '../src/mailbox/imap.js';

loadDotenv();
const cfg = loadConfig();

/** 没配凭证时，把各家怎么配打印出来 —— 让用户照着填就行。 */
function printSetupGuide(): void {
  console.log('没有配置邮箱凭证，所以没法拉邮件。\n');
  console.log('在 .env 里加这几行（以 QQ 邮箱为例）：\n');
  console.log('  MAIL_IMAP_PROVIDER=qq');
  console.log('  MAIL_IMAP_USER=你的QQ号@qq.com');
  console.log('  MAIL_IMAP_PASS=你的授权码\n');
  console.log('授权码不是 QQ 密码：设置 → 账户 → POP3/IMAP/SMTP → 开启 → 生成授权码。\n');
  console.log('各家服务器地址与凭证要求（填 MAIL_IMAP_PROVIDER=<id> 即可自动选）：\n');
  for (const p of IMAP_PROVIDERS) {
    if (p.id === 'custom') continue;
    console.log(`  ${p.id.padEnd(9)} ${p.host}:${p.port}`);
    console.log(`            ${p.authNote}`);
  }
  console.log('\n  custom   自己填 MAIL_IMAP_HOST / MAIL_IMAP_PORT / MAIL_IMAP_SECURE');
}

async function main(): Promise<void> {
  if (!cfg.imap) {
    printSetupGuide();
    return;
  }

  const imap = cfg.imap;
  const args = process.argv.slice(2);
  const limit = Number(args.find((a) => /^\d+$/.test(a)) ?? 5);
  const full = args.includes('--full');

  console.log(`服务商 : ${imap.provider}`);
  console.log(`服务器 : ${imap.host}:${imap.port}  secure=${imap.secure}`);
  console.log(`账号   : ${imap.user}`);
  console.log(`邮箱夹 : ${imap.mailbox}`);
  console.log();

  // ① 连通性检查：只登录、只列邮箱夹
  console.log('① 连通性检查（只登录，不取任何邮件）…');
  const v = await verifyImap(imap);
  if (!v.ok) {
    console.log(`   ❌ ${v.message}`);
    console.log('\n常见原因：');
    console.log('   · 授权码不对（不是登录密码）');
    console.log('   · 邮箱服务器没开 IMAP 服务');
    console.log('   · 账号需要先开启两步验证 / 应用专用密码');
    console.log(`   · 端口或加密方式不对（当前 ${imap.port} secure=${imap.secure}）`);
    if (imap.authNote) console.log(`   · ${imap.authNote}`);
    process.exitCode = 1;
    return;
  }
  console.log(`   ✅ ${v.message}`);
  console.log(`   邮箱夹：${v.mailboxes.slice(0, 8).join(', ')}${v.mailboxes.length > 8 ? ' …' : ''}`);
  console.log();

  // ② 真的拉几封（只读，不标记已读，不落盘）
  console.log(`② 拉取最近 ${limit} 封（BODY.PEEK，不会标记已读；不落盘）…`);
  const mails = await fetchImap(imap, { limit });
  if (mails.length === 0) {
    console.log('   （收件箱是空的，或者没有匹配的邮件）');
    return;
  }

  console.log(`   ✅ 抓到 ${mails.length} 封\n`);
  for (const m of mails) {
    console.log(`─${'─'.repeat(78)}`);
    console.log(`日期 : ${m.date}`);
    console.log(`主题 : ${m.subject}`);
    console.log(`发件 : ${m.sender}`);
    console.log(`收件 : ${m.to.join(', ')}`);
    console.log(`id   : ${m.id}   uid=${String(m.meta.uid ?? '?')}`);
    console.log(`正文 : ${m.body.length} 字符`);
    if (full) {
      console.log('─'.repeat(80));
      console.log(m.body.slice(0, 3000));
    } else {
      console.log(`摘要 : ${m.body.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
  console.log(`─${'─'.repeat(78)}`);
  console.log('\n提示：这些内容只在内存里，没有写入任何文件。');
}

main().catch((e) => {
  console.error('探针崩了：', e);
  process.exitCode = 1;
});
