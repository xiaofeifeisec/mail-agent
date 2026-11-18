

/** 是不是中日韩统一表意文字（汉字）。 */
const CJK = /[\u3400-\u9FFF\uF900-\uFAFF]/;

/** 属于"单词"的字符：字母或数字。 */
const WORDY = /[a-zA-Z0-9]/;

/**
 * 把文本切成片段序列。
 * 汉字单独成段，连续的字母数字合成一段，其余字符只做分隔。
 */
function segment(text: string): string[] {
  const out: string[] = [];
  let buf = '';

  for (const ch of text) {
    if (CJK.test(ch)) {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      out.push(ch);
    } else if (WORDY.test(ch)) {
      buf += ch;
    } else {
      // 标点 / 空白 / 符号：分隔符，直接丢弃
      if (buf) {
        out.push(buf);
        buf = '';
      }
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * 切词主函数。
 *
 * 例："支付网关TLS迁移"
 *   → 支 付 网 关 TLS 迁移 ... + 支付 付网 网关 关TLS 网关TLS 迁移 ...
 */
export function tokenize(text: string): string[] {
  if (!text) return [];

  const segs = segment(text);
  if (segs.length === 0) return [];

  const tokens: string[] = [];

  // 1) 单字 / 单词（英文统一小写，大小写不该影响检索）
  for (const s of segs) {
    tokens.push(CJK.test(s) ? s : s.toLowerCase());
  }

  // 2) 中文二元组：只在中文字之间产生（规格如此）。
  //    英文单词之间【不】产生组合 —— "payment gateway" 合成 "paymentgateway" 是噪音，
  //    英文短语检索交给 FTS5 原生的短语匹配（"payment gateway" 带空格就是短语）更准。
  for (let i = 0; i + 1 < segs.length; i++) {
    const a = segs[i];
    const b = segs[i + 1];
    if (CJK.test(a) && CJK.test(b)) {
      tokens.push(a + b);
    }
  }

  // 3) 中英交界三元组：[中][中][英] → 网关tls
  //    作用：查询"网关tls"能精确命中"支付网关TLS"这种连写的原文。
  //    只在这一种形态上产生，中文内部不产生三元组（否则 token 数量爆炸）。
  for (let i = 0; i + 2 < segs.length; i++) {
    const a = segs[i];
    const b = segs[i + 1];
    const c = segs[i + 2];
    if (CJK.test(a) && CJK.test(b) && !CJK.test(c)) {
      tokens.push(a + b + c.toLowerCase());
    }
  }

  return tokens;
}

/**
 * 切成"空格分隔的一串 token"—— 专门给 SQLite FTS5 用。
 *
 * FTS5 的 unicode61 分词器不认中文，但它是按空格分词的：
 * 所以我们把中文切好、用空格连起来塞进去，它就能正常索引了。
 * 查询时用同一个函数处理查询词，两边就完全对得上。
 */
export function tokenizeToText(text: string): string {
  return tokenize(text).join(' ');
}

/**
 * 去重版本（保留首次出现的顺序）。
 * 用途：写 FTS5 索引前去掉重复 token，省空间、也避免同一词权重虚高。
 */
export function tokenizeUnique(text: string): string[] {
  return [...new Set(tokenize(text))];
}

/**
 * 提取关键词：只保留有检索价值的 token。
 *
 * 规则：丢掉单个汉字（"的""了""在"这种）和单个英文字母，
 * 因为它们的区分度太低，留在倒排索引里只会占地方、还拉低 BM25 得分。
 * 中文二元组、英文单词都保留。
 */
export function keywords(text: string): string[] {
  return tokenizeUnique(text).filter((t) => {
    if (CJK.test(t)) return t.length >= 2; // 中文：至少两个字（二元组）
    return t.length >= 2; // 英文：至少两个字符
  });
}
