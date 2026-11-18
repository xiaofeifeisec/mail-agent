/**
 * 探针：验证 QQ 邮箱授权码能否用于 SMTP（不发邮件，只握手 + AUTH）。
 *
 * 【为什么先探这个】
 * IMAP 和 SMTP 是两套独立的服务，但同一个「授权码」通常两者通用。
 * 如果 SMTP 认证也失败，那"回复出现在 QQ 邮箱里"这件事
 * 就得先解决凭证问题，而不是写代码。
 *
 * 用法：npx tsx tools/smtp-probe.ts
 */

import { connect, type TLSSocket } from 'node:tls';
import { loadDotenv, loadConfig } from '../src/config.js';

loadDotenv();
const cfg = loadConfig();

interface SmtpProbe {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

const PROBE: SmtpProbe = {
  host: process.env.MAIL_SMTP_HOST ?? 'smtp.qq.com',
  port: Number(process.env.MAIL_SMTP_PORT ?? 465),
  secure: true,
  user: cfg.imap?.user ?? '',
  pass: cfg.imap?.pass ?? '',
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 逐行读 SMTP 响应（多行响应用 "250-" 续行，最后一行 "250 "）。 */
function readResponse(sock: TLSSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('读响应超时'));
    }, 15000);

    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/).filter((l) => l.length > 0);
      // 最后一行不能是 "250-" 这种续行
      const last = lines[lines.length - 1] ?? '';
      if (/^\d{3} /.test(last)) {
        cleanup();
        resolve(lines.join('\n'));
      }
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('连接被关闭'));
    };
    function cleanup() {
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('error', onError);
      sock.off('close', onClose);
    }

    sock.on('data', onData);
    sock.on('error', onError);
    sock.on('close', onClose);
  });
}

async function main(): Promise<void> {
  console.log('=== SMTP 探针（只握手认证，不发邮件）===\n');
  console.log('服务器 :', `${PROBE.host}:${PROBE.port}`, PROBE.secure ? '(隐式 TLS)' : '(明文+STARTTLS)');
  console.log('账号   :', PROBE.user);
  console.log('密码   :', PROBE.pass ? `${PROBE.pass.slice(0, 3)}…${PROBE.pass.slice(-2)}（授权码）` : '(空)');
  console.log();

  if (!PROBE.user || !PROBE.pass) {
    console.log('❌ 没配置 MAIL_IMAP_USER / MAIL_IMAP_PASS');
    return;
  }

  const sock = connect({
    host: PROBE.host,
    port: PROBE.port,
    servername: PROBE.host,
    rejectUnauthorized: false,
  });

  const transcript: string[] = [];

  try {
    // ① 读 greeting
    const greeting = await readResponse(sock);
    transcript.push('S: ' + greeting.split('\n')[0]);
    console.log('① 服务器问候:', greeting.split('\n')[0]);

    // ② EHLO
    sock.write('EHLO localhost\r\n');
    const ehlo = await readResponse(sock);
    transcript.push('C: EHLO localhost');
    transcript.push('S: ' + ehlo.split('\n')[0]);
    console.log('② EHLO:', ehlo.split('\n')[0]);

    const caps = ehlo.toUpperCase();
    console.log('   能力:', caps.split('\n').map((l) => l.slice(4).trim()).filter(Boolean).join(' / '));

    // ③ AUTH LOGIN
    if (!caps.includes('AUTH')) {
      console.log('❌ 服务器不支持 AUTH');
      return;
    }
    sock.write('AUTH LOGIN\r\n');
    const a1 = await readResponse(sock);
    transcript.push('C: AUTH LOGIN');
    transcript.push('S: ' + a1.split('\n')[0]);

    const userB64 = Buffer.from(PROBE.user, 'utf8').toString('base64');
    sock.write(userB64 + '\r\n');
    const a2 = await readResponse(sock);
    transcript.push('C: <base64 user>');

    const passB64 = Buffer.from(PROBE.pass, 'utf8').toString('base64');
    sock.write(passB64 + '\r\n');
    const a3 = await readResponse(sock);
    transcript.push('C: <base64 pass>');
    transcript.push('S: ' + a3.split('\n')[0]);

    const ok = /^235/.test(a3);
    console.log('③ 认证:', a3.split('\n')[0]);
    console.log();
    console.log(ok ? '✅ 授权码可用于 SMTP —— 可以实现真发信' : '❌ 认证失败 —— 授权码不能用于 SMTP（或需要先开启 SMTP 服务）');

    if (ok) {
      sock.write('QUIT\r\n');
      await wait(300);
    }
  } catch (e) {
    console.log('❌ 出错:', (e as Error).message);
  } finally {
    sock.destroy();
  }

  console.log('\n--- 协议对话 ---');
  for (const t of transcript) console.log('  ' + t);
}

main().catch((e) => {
  console.error('探针崩了:', e);
  process.exitCode = 1;
});
