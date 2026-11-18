/**
 * mailbox/providers.ts —— 各家邮箱服务商的 IMAP 接入参数（纯数据，无依赖）。
 *
 * 单独成文件的原因：config.ts 要用它（把 MAIL_IMAP_PROVIDER 解析成连接参数），
 * 而 imap.ts 要用它（拉邮件）。如果放在 imap.ts 里，
 * config.ts 一 import 就会把 imapflow 整个拖进来 —— 不必要。
 */

/** 一家邮箱服务商的接入参数。 */
export interface ImapProviderSpec {
  id: string;
  label: string;
  /** IMAP 服务器地址 */
  host: string;
  port: number;
  /** true = 直连 TLS（IMAPS，通常 993）；false = 先明文再 STARTTLS */
  secure: boolean;
  /** 给用户的提示：这类邮箱要用什么凭证 */
  authNote: string;
}

/**
 * 内置服务商预设。
 * 加一家新邮箱服务商？往这里加一行就行，代码不用改。
 */
export const IMAP_PROVIDERS: ImapProviderSpec[] = [
  {
    id: 'qq',
    label: 'QQ 邮箱',
    host: 'imap.qq.com',
    port: 993,
    secure: true,
    authNote: '要用「授权码」而不是 QQ 密码（设置 → 账户 → POP3/IMAP/SMTP → 开启 → 生成授权码）',
  },
  {
    id: 'exmail',
    label: '腾讯企业邮',
    host: 'imap.exmail.qq.com',
    port: 993,
    secure: true,
    authNote: '要用「客户端专用密码」（邮箱设置 → 安全 → 客户端专用密码）',
  },
  {
    id: 'outlook',
    label: 'Outlook / Hotmail',
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    authNote: '微软账号一般要「应用密码」；企业版建议走 OAuth2（accessToken）',
  },
  {
    id: 'gmail',
    label: 'Gmail',
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    authNote: '要用「应用专用密码」，且账号必须开启两步验证',
  },
  {
    id: '163',
    label: '网易 163 邮箱',
    host: 'imap.163.com',
    port: 993,
    secure: true,
    authNote: '要用「客户端授权密码」（设置 → POP3/SMTP/IMAP → 开启 → 生成授权密码）',
  },
  {
    id: '126',
    label: '网易 126 邮箱',
    host: 'imap.126.com',
    port: 993,
    secure: true,
    authNote: '同 163，要「客户端授权密码」',
  },
  {
    id: 'custom',
    label: '自定义服务器',
    host: '',
    port: 993,
    secure: true,
    authNote: '自己填 MAIL_IMAP_HOST / MAIL_IMAP_PORT / MAIL_IMAP_SECURE',
  },
];

/** 用服务商 id 找预设；找不到返回 undefined。 */
export function providerSpec(id: string): ImapProviderSpec | undefined {
  return IMAP_PROVIDERS.find((p) => p.id === id);
}
