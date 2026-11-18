/**
 * agent/protocol.ts —— ⑨b 文本工具调用协议。
 *
 * 【它解决什么问题】
 *   我们没有走 OpenAI 的 function calling（那是厂商特性），而是让模型
 *   在【纯文本】里输出一个 JSON 块来表示"我要调哪个工具、参数是什么"。
 *   这个文件负责把那段文本可靠地解析出来。
 *
 * 【为什么说它"最容易翻车"】
 *   因为模型的输出不受你控制。实测会遇到的情况：
 *     ① 前后带解释："好的，我来搜索：\n```json\n{...}\n```\n希望有帮助"
 *     ② 围栏被截断：```json 开了没闭（token 上限到了）
 *     ③ 参数里嵌套着完整调用文本 —— 想骗你多解析一个
 *     ④ 一次输出好几个 json 块（先来个示例、再来真的）
 *     ⑤ 输出到一半断掉，JSON 不完整
 *   任何一种处理错，轻则工具没执行，重则执行了一个模型没想执行的调用。
 *
 * 【四条硬规则（施工图指定）】
 *   1. 截断安全：任意字符处切断 → 只可能得到"无调用"或"恰好原调用"。
 *      切在参数中间必须是 error，绝不能拼出一个"看起来合法"的调用。
 *   2. 嵌套安全：参数值里含完整调用文本不能被骗 → 只认【最后一个】```json 块。
 *   3. 围栏计数：count('```') 为奇数 = 围栏未闭合 = 被截断，先查这个再找块。
 *   4. 永不抛异常：这个函数在任何输入下都返回 ParsedResponse，不 throw。
 *      理由：它紧挨着模型输出，是最不可信的一环。让它抛异常等于把
 *      "模型说了句怪话"升级成"整个 agent 崩溃"。
 *
 * 【协议格式（写死在 PROTOCOL_PROMPT 里）】
 *   工具调用 = 一个 ```json 围栏，内容是：
 *     {"tool": "工具名", "args": {...}, "reason": "可选"}
 *   没有这个围栏 = 模型在直接回答用户。
 */

import type { ParsedResponse, ToolCall } from './types.js';

/** 围栏标记。 */
const FENCE = '```';

/**
 * 写给模型的协议说明。
 *
 * 【为什么单独导出】
 *   system prompt 要引用它，测试也要断言它的措辞。
 *   分散在两处写，改了这边忘了那边 → 协议和解析对不上，最难查。
 */
export const PROTOCOL_PROMPT = `【工具调用协议】
需要调用工具时，输出一个 json 代码块，格式严格如下：
\`\`\`json
{"tool": "工具名", "args": {"参数名": "值"}, "reason": "为什么调它（可选）"}
\`\`\`

规则：
1. 一次只调一个工具。调完停下等结果，不要自己编造结果。
2. 不需要调工具时，直接用自然语言回答，不要输出 json 块。
3. json 块里不要写注释，不要用单引号，必须是合法 JSON。
4. args 必须符合该工具声明的参数；缺参数会被拒绝，你得重新调用。`;

/* ============================ 主解析 ============================ */

/**
 * 解析模型的一次回复。
 *
 * 【永不抛异常】任何输入都返回一个 ParsedResponse。
 */
export function parseResponse(raw: string): ParsedResponse {
  // 兜底：连字符串都不是（理论上不可能，但这是最外层防线）
  if (typeof raw !== 'string') {
    return { text: '', toolCall: null, error: '回复不是字符串' };
  }
  if (raw.trim() === '') {
    return { text: '', toolCall: null, error: '回复是空的' };
  }

  // ── 规则 3：围栏计数 ──
  // 奇数个 ``` 说明有围栏开了没闭 → 回复被截断。
  // 【关键】必须在找块之前查：先找块的话，可能从截断处凑出一个
  // "开头像调用"的片段，然后误判成一个参数不全的调用。
  const fenceCount = countOccurrences(raw, FENCE);
  if (fenceCount % 2 === 1) {
    return {
      text: stripFences(raw).trim(),
      toolCall: null,
      error: '围栏未闭合（回复被截断）',
    };
  }

  // ── 规则 2：只认最后一个 json 围栏块 ──
  // 模型可能先给一个"示例调用"再给"真调用"。取最后一个才对。
  // 同时这也天然防住了"参数里嵌套完整调用"的骗术：
  // 我们只解析【最外层围栏的内容】，参数里的嵌套文本不会单独成为一个块。
  const blocks = extractJsonBlocks(raw);

  if (blocks.length === 0) {
    // 没有围栏 → 模型在直接回答
    return { text: raw.trim(), toolCall: null, error: null };
  }

  const last = blocks[blocks.length - 1];

  // 围栏内容不是合法 JSON → 这是模型写坏了，必须报错而不是当"直接回答"
  let obj: unknown;
  try {
    obj = JSON.parse(last);
  } catch {
    return {
      text: stripFences(raw).trim(),
      toolCall: null,
      error: 'json 围栏内容不是合法 JSON',
    };
  }

  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return {
      text: stripFences(raw).trim(),
      toolCall: null,
      error: 'json 围栏内容不是对象',
    };
  }

  const rec = obj as Record<string, unknown>;

  // 有 tool 字段 → 当作工具调用
  if (typeof rec.tool === 'string' && rec.tool.trim()) {
    const call: ToolCall = {
      name: rec.tool.trim(),
      args: rec.args ?? {},
      ...(typeof rec.reason === 'string' && rec.reason.trim()
        ? { reason: rec.reason.trim().slice(0, 200) }
        : {}),
    };
    return {
      // 围栏外面的文字是给用户看的说明（"我来查一下"），保留
      text: stripFences(raw).trim(),
      toolCall: call,
      error: null,
    };
  }

  // 有 json 块但没有 tool 字段 → 不是我们的协议。
  // 【不能当成"直接回答"】用户会看到一堆 JSON，很怪。
  return {
    text: stripFences(raw).trim(),
    toolCall: null,
    error: 'json 块里没有 tool 字段',
  };
}

/**
 * 从文本里提取所有 ```json 围栏块的内容。
 *
 * 【为什么用手写扫描而不是正则】
 *   正则 /```json([\s\S]*?)```/g 在"围栏内容里本身含有 ```"时会错。
 *   参数里真能出现 ``` 吗？能 —— 用户可能让模型"把这段 markdown 存进记忆"。
 *   所以按位置配对扫描更稳。
 */
export function extractJsonBlocks(raw: string): string[] {
  const out: string[] = [];
  const positions: number[] = [];

  // 找出所有 ``` 的位置
  let idx = 0;
  while ((idx = raw.indexOf(FENCE, idx)) !== -1) {
    positions.push(idx);
    idx += FENCE.length;
  }

  // 两两配对：(0,1) (2,3) (4,5) ...
  // 配对顺序天然保证"只认完整的块"——落单的最后一个不会成块。
  for (let i = 0; i + 1 < positions.length; i += 2) {
    const openEnd = positions[i] + FENCE.length;
    const closeStart = positions[i + 1];
    let body = raw.slice(openEnd, closeStart);

    // 去掉语言标注行（json / JSON / javascript …）
    body = body.replace(/^[ \t]*[a-zA-Z0-9_-]*[ \t]*\r?\n/, '');
    out.push(body.trim());
  }

  return out;
}

/* ============================ 辅助 ============================ */

/** 数一个子串出现几次。 */
export function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = hay.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/**
 * 去掉围栏标记，留下自然语言部分。
 *
 * 【为什么要去】
 *   text 字段是给用户看的。留着 ```json {...}``` 会让用户
 *   看到一坨机器格式，像 bug。
 */
export function stripFences(raw: string): string {
  return raw
    .replace(/```[^\n]*\n[\s\S]*?```/g, '') // 完整块
    .replace(/```/g, '') // 落单的标记
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 从文本里提取所有 ```json 围栏块的结构化信息（调试用）。
 * 与 extractJsonBlocks 的区别：这个返回位置，方便打日志。
 */
export function debugBlocks(raw: string): Array<{ start: number; end: number; body: string }> {
  const positions: number[] = [];
  let idx = 0;
  while ((idx = raw.indexOf(FENCE, idx)) !== -1) {
    positions.push(idx);
    idx += FENCE.length;
  }
  const out: Array<{ start: number; end: number; body: string }> = [];
  for (let i = 0; i + 1 < positions.length; i += 2) {
    out.push({
      start: positions[i],
      end: positions[i + 1] + FENCE.length,
      body: raw.slice(positions[i] + FENCE.length, positions[i + 1]).trim(),
    });
  }
  return out;
}
