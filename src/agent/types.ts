/**
 * agent/types.ts —— ⑨a 完整 harness 的核心契约。
 *
 * 【为什么这个文件必须第一个写、且要手抄一遍】
 *   ToolSpec / ToolResult / ParsedResponse / AgentConfig / AgentResult 这五个接口
 *   是后面 6 个文件的共同语言。这里定义错一个字段，后面全错。
 *   施工图的建议是"写之前先手抄一遍" —— 因为抄的过程会逼你想清楚：
 *   这个字段真的必要吗？是这个类型吗？谁产生的、谁消费的？
 *
 * 【本文件不 import 任何 agent/ 内部模块】
 *   只依赖 llm 与 mailbox 的类型。原因：其他文件都 import 它，
 *   它不能反过来依赖别人，否则循环引用。
 */

import type { ChatMessage, CompleteOptions } from '../llm/client.js';
import type { Email } from '../mailbox/types.js';

/* ============================ 工具调用 ============================ */

/**
 * 一次工具调用的请求。
 *
 * 【参数为什么是 unknown 而不是具体类型】
 *   参数来自模型输出的 JSON —— 在通过 registry.validate 之前，
 *   它只是一堆不可信数据。标成 unknown 是为了强制调用方先校验再使用，
 *   而不是 `any` 一路传下去最后在深处炸掉。
 */
export interface ToolCall {
  /** 工具名。 */
  name: string;
  /** 原始参数（未经校验）。 */
  args: unknown;
  /**
   * 模型给的调用理由（可选）。
   *
   * 【为什么要留着】
   *   审批弹窗要给人看"它想干什么、为什么"。
   *   只说"要执行 sendDraftReply"没人敢点同意；
   *   说"因为用户要求回复这封邮件"就敢了。
   */
  reason?: string;
}

/**
 * 工具执行结果。
 *
 * 【status 为什么不是 ok/fail 两态】
 *   因为"失败"有好几种，而且处理方式完全不同：
 *     unknown_tool  → 模型写错了工具名 → 告诉它有哪些工具
 *     invalid_args  → 参数不合格 → 告诉它缺什么，它自己补
 *     denied        → 被安全规则/用户拒绝 → 它不是"错"，是"不许"
 *     tool_error    → 工具自己炸了 → 告诉它错误信息
 *   区分这四种，模型才能做出不同的补救动作。
 */
export interface ToolResult {
  status: 'ok' | 'unknown_tool' | 'invalid_args' | 'tool_error' | 'denied';
  /**
   * 给模型看的内容。
   *
   * 【重要】这段文字会【逐字】进入下一次模型调用 ——
   * 所以它必须是自解释的（模型只看得到这段字，看不到你的代码注释）。
   */
  content: string;
}

/**
 * 一个工具的定义。
 *
 * 【description 的地位被严重低估】
 *   模型能看到的只有 name + description + parameters 三样东西。
 *   它看不到你的实现、看不到注释、看不到文件路径。
 *   description 写得含糊，模型就会瞎调——这是实践中最常见的 Agent 故障源。
 */
export interface ToolSpec {
  /** 工具名。给模型看，用下划线命名（search_emails 而不是 searchEmails）。 */
  name: string;
  /**
   * 工具说明。给模型看。
   *
   * 【好的 description 要说三件事】
   *   ① 干什么（在邮件里做全文检索）
   *   ② 参数怎么填（query 用中文关键词，如「证书 过期」）
   *   ③ 什么情况下【不该】用（只能在用户确认后调用）
   */
  description: string;
  /** 参数 JSON Schema（只用到 type / properties / required / enum / description）。 */
  parameters: JSONSchema;
  /**
   * 真的干活。
   *
   * 【为什么返回 string 而不是对象】
   *   因为结果最终是要喂给模型的文本。让它直接产出文本，
   *   省掉一层"对象 → JSON.stringify"的无意义转换，
   *   也避免有人在这里返回一个巨大对象把上下文撑爆。
   */
  fn: (args: Record<string, unknown>) => Promise<string> | string;
  /**
   * 只读？
   *
   * 【这是安全分界线】
   *   true  → 不改变任何状态，可以随便跑（检索、读邮件、查摘要）
   *   false → 有副作用（发信、改标签），confirm 模式下必须先问人
   */
  readOnly: boolean;
}

/**
 * 工具参数的 JSON Schema 子集。
 *
 * 【为什么只支持这么少】
 *   完整的 JSON Schema 规范有几十个关键字。我们只需要
 *   "有没有传、类型对不对、是不是枚举里那个"这三件事。
 *   手写 20 行校验就够了，引 ajv 会多一个依赖树 ——
 *   而这个项目至今只有 imapflow 一个第三方依赖，这个记录值得守住。
 */
export interface JSONSchema {
  type: 'object';
  properties?: Record<string, JSONSchemaProperty>;
  /** 必填字段名。 */
  required?: string[];
}

export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'boolean';
  /** 给模型看的字段说明。 */
  description?: string;
  /** 枚举约束（type 为 string 时用）。 */
  enum?: string[];
}

/* ============================ 协议解析 ============================ */

/**
 * 模型一次回复的解析结果。
 *
 * 【三态而不是两态】
 *   看起来应该只有"有工具调用"和"没有工具调用"两种。
 *   但实际还有第三种：**解析失败**（模型输出了一堆谁也看不懂的东西）。
 *   把它和"没有调用"混在一起是致命的 —— 那会让 loop 把一次坏回复
 *   当成"模型说完了"，于是直接结束，用户看到一个空答案。
 */
export interface ParsedResponse {
  /** 回复里的自然语言部分（给用户看的）。 */
  text: string;
  /** 解析出的工具调用；null = 这轮没有调用工具。 */
  toolCall: ToolCall | null;
  /** 解析失败的原因；null = 解析成功。 */
  error: string | null;
}

/* ============================ 人机接口 ============================ */

/**
 * 人机交互接口。
 *
 * 【三种实现同构的意义】
 *   真人（ConsoleUserIO）、脚本（ScriptUserIO）、模拟用户 ——
 *   只要它们实现同一个接口，loop.ts 就完全不知道自己在跟谁打交道。
 *   于是**Agent 逻辑可以脱离真人、甚至脱离真模型测试**：
 *   用 ScriptUserIO 就能把审批分支、拒绝分支全跑一遍。
 */
export interface UserIO {
  /**
   * 请求批准一个有副作用的操作。
   * @returns true = 同意执行；false = 拒绝
   *
   * 【为什么返回 boolean 而不是抛异常】
   *   "用户拒绝"是一个【正常结果】，不是错误。
   *   模型需要知道"被拒了"，才能换一条路（比如先问清楚再发）。
   *   抛异常会绕过模型、直接结束整个循环。
   */
  approve(call: ToolCall): Promise<boolean>;

  /** 问用户一个问题，拿到回答。 */
  ask(question: string): Promise<string>;

  /**
   * 用户有没有插话。
   *
   * 【必须是非阻塞的】
   *   Agent 循环每轮会调一次这个方法"扫一眼"。
   *   如果它阻塞等输入，整个循环就卡死在那儿了。
   *   没有新消息就立刻返回 null。
   */
  pendingMessage(): string | null;
}

/* ============================ 运行配置与结果 ============================ */

/** Agent 一次运行的全部参数。 */
export interface AgentConfig {
  /** 模型客户端。只用到 complete。 */
  lm: AgentLm;
  /** 工具注册表。 */
  registry: ToolRegistry;
  /** 系统提示词（含工具清单 + 输出格式要求）。 */
  systemPrompt: string;

  /** 最多几轮 ReAct。防死循环。 */
  maxTurns: number;
  /** 单次运行允许消耗的总 token。超了就停。 */
  tokenBudget: number;
  /** 单次调用的上下文上限。超了先压缩。 */
  contextBudget: number;

  /** confirm = 副作用工具先审批；auto = 直接执行。 */
  mode: 'confirm' | 'auto';
  /**
   * 危险调用的正则黑名单。
   *
   * 【它是审批之前的一道网】
   *   有些操作连"问用户"都不该问 —— 比如把邮件转发到外部地址。
   *   命中这里的调用直接拒，模型会收到 denied，用户根本不会看到弹窗。
   */
  denyRules: RegExp[];

  /** 人机接口。confirm 模式必需；auto 模式可以不传。 */
  user?: UserIO;

  /** 跨会话记忆（可选）。传了就会把记忆索引注入 system prompt。 */
  memory?: AgentMemory;
}

/** Agent 需要的最小模型能力（只取 complete，方便测试塞假模型）。 */
export type AgentLm = {
  complete(messages: ChatMessage[], options?: CompleteOptions | number): Promise<string>;
};

/** Agent 需要的最小注册表能力（同样为了可测）。 */
export interface ToolRegistry {
  register(spec: ToolSpec): void;
  get(name: string): ToolSpec | undefined;
  /** 只校验，不执行。 */
  validate(name: string, args: unknown): { ok: boolean; error?: string };
  /** 先校验再执行。 */
  execute(name: string, args: unknown): Promise<ToolResult>;
  /** 全部工具（用来生成提示词里的工具清单）。 */
  list(): ToolSpec[];
}

/** Agent 需要的最小记忆能力。 */
export interface AgentMemory {
  /** 注入 system prompt 的索引文本（每条压到 40 字）。 */
  indexText(): string;
  /** 存一条。 */
  remember(content: string): string;
  /**
   * 检索记忆。
   *
   * 【为什么返回 string[] 而不是 Email[]】
   *   记忆是"用户说过的话"，不是邮件。复用一个假 Email 结构去套
   *   BM25 的入参，会让类型变得莫名其妙（记忆的 sender 是谁？）。
   *   这里只返回命中的记忆正文，由调用方决定怎么拼给模型。
   */
  recall(query: string): string[];
}

/**
 * 一次运行的结局。
 *
 * 【为什么要区分这么多种结束方式】
 *   "done"（模型答完了）和 "max_turns"（循环用尽）在用户看来都是"结束了"，
 *   但前者可信、后者可能只做了一半。
 *   不区分的话，用户拿不到"这次没做完"的信息，会以为任务完成了。
 */
export interface AgentResult {
  /** 最终回复文本。非 done 状态下可能为空。 */
  text: string;
  status:
    | 'done' // 模型给出了最终回答
    | 'max_turns' // 轮数用尽
    | 'token_budget' // token 预算用尽
    | 'malformed' // 连续多次解析失败，熔断
    | 'denied_by_user'; // 用户中途拒绝
  /** 实际跑了几轮。 */
  turns: number;
  /**
   * 完整对话记录。
   *
   * 【为什么要返回它】
   *   出错时唯一能查的东西。用户说"它怎么这样"，
   *   只有 transcript 能回答"它当时看到了什么、说了什么、调了什么"。
   */
  transcript: ChatMessage[];
  /** 工具调用记录（审计用）。 */
  calls: Array<{ name: string; args: unknown; result: ToolResult }>;
}
