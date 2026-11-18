/**
 * agent/loop.ts —— ⑨d ReAct 循环（心脏）。
 *
 * 【它在做什么】
 *   让模型反复"想 → 调工具 → 看结果 → 再想"，直到它给出最终回答。
 *
 * 【谁决定下一步】
 *   管线（classify / digest / reply）的下一步是代码写死的。
 *   Agent 的下一步是模型看上下文决定的 —— 这就是两者的根本区别。
 *
 * 【每轮固定 8 步，顺序不能变】
 *   1  查插话     用户又有话说了？转向
 *   2  组装消息   历史 + 当前用户消息
 *   3  超预算压缩 上下文太长就砍旧工具结果
 *   4  查 token 预算 不够就停，别发请求
 *   5  调模型
 *   6  解析       protocol.parseResponse
 *   7  坏回复喂回错误；连续 3 次熔断
 *   8  有调用 → 校验 → deny规则 → 审批 → 执行 → 结果进 transcript
 *
 * 【顺序为什么不能变】
 *   · 步骤 3 必须在 4 之前：先压缩再看预算，否则明明能压下来却直接判定超限
 *   · 步骤 4 必须在 5 之前：先查预算再发请求，否则钱已经花了才发现超了
 *   · 步骤 7 在 8 之前：坏回复不该占用工具执行的机会
 *
 * 【两条不可破坏的不变量】
 *   A. tool_result 必须【逐字】出现在下一次调用里
 *      否则模型看不到自己刚拿到什么，会重复调同一个工具 —— 死循环烧钱
 *   B. 当前用户消息【每次】都在消息列表里
 *      否则多轮之后模型会忘了用户到底在问什么
 *
 *   这两条违反后的症状都是"模型突然变傻"，而且不报错 —— 最难查的一类 bug。
 */

import type { ChatMessage } from '../llm/client.js';
import { countMessageTokens, countTokens } from '../llm/client.js';
import { parseResponse } from './protocol.js';
import type { AgentConfig, AgentResult, ToolResult } from './types.js';

/** 连续多少次解析失败就熔断。 */
export const MAX_MALFORMED = 3;

/** 压缩上下文时，保留最近几轮不动（太近的砍掉会让模型失去连贯性）。 */
export const KEEP_RECENT_MESSAGES = 6;

/** 工具结果被压缩后截到多少字。 */
export const COMPACTED_RESULT_CHARS = 200;

/**
 * 跑一次 Agent。
 *
 * @param cfg       运行配置
 * @param userInput 用户这次说的话
 */
export async function runAgent(cfg: AgentConfig, userInput: string): Promise<AgentResult> {
  // 组装 system prompt：
  //   基础提示词 + 工具清单（从注册表生成，永远不会跟实际工具脱节）
  //   + 记忆索引（如果传了 memory）
  const sysParts = [cfg.systemPrompt];
  if (cfg.memory) {
    const memIdx = cfg.memory.indexText();
    if (memIdx) sysParts.push(memIdx);
  }

  const transcript: ChatMessage[] = [{ role: 'system', content: sysParts.join('\n\n') }];
  const calls: AgentResult['calls'] = [];

  let malformed = 0;
  let turns = 0;

  while (turns < cfg.maxTurns) {
    turns++;

    // ── 步骤 1：查插话 ──
    // 【非阻塞】只在这一瞬间看一眼有没有新输入。
    // 阻塞等输入会把整个循环卡死。
    if (cfg.user) {
      const interrupt = cfg.user.pendingMessage();
      if (interrupt) {
        transcript.push({
          role: 'user',
          content: `（用户插话）${interrupt}`,
        });
      }
    }

    // ── 步骤 2：组装消息 ──
    // 【不变量 B】当前用户消息每次都在。
    // 这里每次都 push 一条 —— 看起来会重复，但这是刻意的：
    // 模型在长上下文里会"忘掉"前面说了什么，把当前问题重复放在最近位置
    // 能显著提高它不跑偏的概率。代价是几十个 token，值得。
    transcript.push({ role: 'user', content: userInput });

    // ── 步骤 3：超预算压缩 ──
    const est = estimateTokens(transcript);
    if (est > cfg.contextBudget) {
      compact(transcript);
    }

    // ── 步骤 4：查 token 预算 ──
    const used = estimateTokens(transcript);
    if (used > cfg.tokenBudget) {
      return {
        text: '',
        status: 'token_budget',
        turns,
        transcript,
        calls,
      };
    }

    // ── 步骤 5：调模型 ──
    let raw: string;
    try {
      raw = await cfg.lm.complete(transcript, { temperature: 0, maxTokens: 1200, tag: 'agent' });
    } catch (e) {
      // 模型调用本身失败（网络/预算/额度）—— 不该让整个运行崩掉
      return {
        text: `模型调用失败：${e instanceof Error ? e.message : String(e)}`,
        status: 'done',
        turns,
        transcript,
        calls,
      };
    }

    // ── 步骤 6：解析 ──
    const parsed = parseResponse(raw);

    // ── 步骤 7：坏回复喂回错误 ──
    if (parsed.error) {
      malformed++;
      if (malformed >= MAX_MALFORMED) {
        // 【熔断】连续 3 次都解析不了 —— 再试下去只是烧钱
        return {
          text: parsed.text || `模型连续 ${MAX_MALFORMED} 次输出无法解析，已停止`,
          status: 'malformed',
          turns,
          transcript,
          calls,
        };
      }

      // 把错误喂回去让模型自己改
      transcript.push({ role: 'assistant', content: raw });
      transcript.push({
        role: 'user',
        content:
          `（系统提示）上一次回复无法解析：${parsed.error}。` +
          '请按工具调用协议重新输出：要么直接用自然语言回答，' +
          '要么输出一个合法的 ```json 块。',
      });
      continue;
    }

    // 解析成功 → 重置熔断计数
    malformed = 0;

    // 没有工具调用 → 模型在直接回答 → 收工
    if (!parsed.toolCall) {
      return {
        text: parsed.text,
        status: 'done',
        turns,
        transcript,
        calls,
      };
    }

    // ── 步骤 8：有调用 → 五道关 ──
    const call = parsed.toolCall;

    // 【必须先把模型的这句话记进 transcript】
    // 不记的话，模型下一轮看不到"我说过要调这个工具"，
    // 只看到一个孤立的结果 —— 它会困惑这个结果是谁的。
    transcript.push({ role: 'assistant', content: raw });

    // 关 1：校验（只查不执行）
    //   【关键】参数残缺的调用在这里就被拒 —— 走不到审批那一步。
    const spec = cfg.registry.get(call.name);
    const v = cfg.registry.validate(call.name, call.args);
    if (!v.ok) {
      const result: ToolResult = {
        status: spec ? 'invalid_args' : 'unknown_tool',
        content: v.error ?? '参数校验失败',
      };
      finishCall(transcript, calls, call.name, call.args, result);
      continue;
    }

    // 关 2：deny 规则
    //   有些操作连问都不该问（比如把邮件转发到外部地址）。
    const denyHit = cfg.denyRules.find((re) => re.test(call.name + ' ' + JSON.stringify(call.args)));
    if (denyHit) {
      const result: ToolResult = {
        status: 'denied',
        content: `这个调用被安全规则拒绝（命中规则：${denyHit.source}）。换一个做法，或者用 ask_user 问用户。`,
      };
      finishCall(transcript, calls, call.name, call.args, result);
      continue;
    }

    // 关 3：审批
    //   只有副作用工具（readOnly=false）且 confirm 模式才问
    if (spec && !spec.readOnly && cfg.mode === 'confirm') {
      if (!cfg.user) {
        const result: ToolResult = {
          status: 'denied',
          content: 'confirm 模式下没有可用的用户接口，无法审批，已拒绝这个有副作用的操作。',
        };
        finishCall(transcript, calls, call.name, call.args, result);
        continue;
      }

      let approved = false;
      try {
        approved = await cfg.user.approve(call);
      } catch {
        approved = false;
      }

      if (!approved) {
        // 【拒绝是正常结果，不是错误】
        //   喂回 denied 让模型换条路（先问清楚、或换个工具），
        //   而不是直接结束整个运行。
        const result: ToolResult = {
          status: 'denied',
          content: '用户拒绝了这个操作。请不要重试同一个调用；可以先解释原因，或改用 ask_user 询问用户想怎么做。',
        };
        finishCall(transcript, calls, call.name, call.args, result);
        continue;
      }
    }

    // 关 4：执行
    const result = await cfg.registry.execute(call.name, call.args);

    // 关 5：结果进 transcript
    finishCall(transcript, calls, call.name, call.args, result);
  }

  // 轮数用尽
  return {
    text: '',
    status: 'max_turns',
    turns,
    transcript,
    calls,
  };
}

/**
 * 把一次工具调用的结果写进 transcript 和审计记录。
 *
 * 【不变量 A 的落实点】
 *   结果必须【逐字】作为一条 user 消息进入 transcript ——
 *   不摘要、不加工、不省略。模型看到的必须和你记录的一致。
 *
 * 【为什么用 user 角色而不是工具角色】
 *   ChatMessage 只有 system/user/assistant 三种角色（为了保持协议简单）。
 *   工具结果用 user 身份带上明确标记，模型能看懂，
 *   而且不会和"真正的用户说的话"混淆（因为带了 [工具结果] 前缀）。
 */
function finishCall(
  transcript: ChatMessage[],
  calls: AgentResult['calls'],
  name: string,
  args: unknown,
  result: ToolResult,
): void {
  const statusTag = result.status === 'ok' ? '' : `（${result.status}）`;
  transcript.push({
    role: 'user',
    content: `[工具结果${statusTag}：${name}]\n${result.content}`,
  });
  calls.push({ name, args, result });
}

/** 估算一组消息的 token 数。 */
export function estimateTokens(messages: ChatMessage[]): number {
  return countMessageTokens(messages) + countTokens(messages.map((m) => m.content).join(''));
}

/**
 * 压缩上下文。
 *
 * 【策略：从中间砍 —— 保住头和尾】
 *   头部：system prompt（工具清单、规则）绝对不能丢
 *   尾部：最近几轮（模型需要连贯性）
 *   中间：老的工具结果 —— 它们通常最长、信息密度最低
 *
 * 【为什么压缩老的工具结果而不是直接删】
 *   直接删会让模型觉得"我调了工具但没结果"，反而更困惑。
 *   保留前 200 字（通常够看出结果类型），并明确标注"已压缩"。
 */
export function compact(messages: ChatMessage[]): number {
  let saved = 0;
  const headEnd = messages.length > 0 && messages[0].role === 'system' ? 1 : 0;
  const tailStart = Math.max(headEnd, messages.length - KEEP_RECENT_MESSAGES);

  for (let i = headEnd; i < tailStart; i++) {
    const m = messages[i];
    if (m.content.length <= COMPACTED_RESULT_CHARS) continue;

    const isToolResult = m.content.startsWith('[工具结果');
    const keep = isToolResult ? COMPACTED_RESULT_CHARS : COMPACTED_RESULT_CHARS * 2;

    if (m.content.length > keep) {
      saved += m.content.length - keep;
      m.content =
        m.content.slice(0, keep) +
        `\n…（此处省略 ${m.content.length - keep} 字历史内容以节省上下文）`;
    }
  }
  return saved;
}
