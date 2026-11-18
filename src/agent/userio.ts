/**
 * agent/userio.ts —— ⑨g 人机接口（真人 / 脚本 / 模拟用户同构）。
 *
 * 【这个抽象的真正的价值】
 *   表面上看它只是"把三个操作包一层"。
 *   真正的收益是：**loop.ts 完全不知道自己面对的是人还是脚本**。
 *
 *   于是 Agent 逻辑可以脱离真人和真模型测试 ——
 *   用 ScriptUserIO 就能把"审批通过"、"用户拒绝"、"用户插话"三条分支
 *   全部跑一遍，不花钱、不等待、结果可复现。
 *
 *   没有这个抽象会怎样？loop.ts 里到处是 readline / DOM / 弹窗调用，
 *   想测审批分支就得起个浏览器 —— 那基本等于没法测。
 *
 * 【三个方法为什么是这三个】
 *   approve        —— 副作用操作要人点头（这是安全边界）
 *   ask            —— Agent 主动问人（"发给运维组还是你自己？"）
 *   pendingMessage —— 用户插话（非阻塞，每轮扫一眼）
 */

import type { ToolCall, UserIO } from './types.js';

/* ============================ 真人：命令行 ============================ */

/**
 * 命令行实现。
 *
 * 【用 stdin 读一行的正确姿势】
 *   Node 里没有内置的"读一行"。
 *   自己写 readline 的坑在于：一次性读多行时，第二次 question 会丢掉缓冲的输入。
 *   所以这里用 readline.Interface 的 question，每次只问一件事。
 */
export class ConsoleUserIO implements UserIO {
  readonly #ask: (prompt: string) => Promise<string>;
  readonly #autoApprove: boolean;

  /**
   * @param askFn 自定义提问函数（默认用 readline）
   * @param autoApprove true = 不问了直接同意（`--yes` 那种场景）
   */
  constructor(askFn?: (prompt: string) => Promise<string>, autoApprove = false) {
    this.#ask = askFn ?? defaultAsk;
    this.#autoApprove = autoApprove;
  }

  async approve(call: ToolCall): Promise<boolean> {
    if (this.#autoApprove) return true;

    const lines = [
      '',
      '──────── 需要你批准 ────────',
      `工具：${call.name}`,
      `参数：${JSON.stringify(call.args, null, 2)}`,
    ];
    if (call.reason) lines.push(`理由：${call.reason}`);
    lines.push('同意执行吗？(y/N) ');

    const ans = (await this.#ask(lines.join('\n'))).trim().toLowerCase();
    return ans === 'y' || ans === 'yes' || ans === '是';
  }

  async ask(question: string): Promise<string> {
    return (await this.#ask(question + '\n> ')).trim();
  }

  /**
   * 命令行场景下"插话"没法优雅实现：
   *   stdin 同一时刻只能有一个消费者，question 期间读不到。
   *   返回 null 表示"没有插话"—— 这是诚实的做法，
   *   而不是假装支持、让用户敲的字进到别的地方去。
   */
  pendingMessage(): string | null {
    return null;
  }
}

/** 默认的 readline 提问。 */
async function defaultAsk(prompt: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/* ============================ 脚本：全自动 ============================ */

/**
 * 脚本实现 —— 测试和批量运行用。
 *
 * 【answers 是队列不是数组】
 *   问三次就拿三次的回答，用的是 shift()。
 *   Agent 每次问什么我们不能预知，但可以按顺序准备好回答。
 */
export class ScriptUserIO implements UserIO {
  readonly #answers: string[];
  readonly #approve: boolean;
  /** 记录审批过的调用 —— 测试可以断言"确实问了" */
  readonly approvals: ToolCall[] = [];
  /** 记录问过的问题 */
  readonly questions: string[] = [];

  /**
   * @param answers   依次回答 ask() 的问题；用完了就返回空串
   * @param approveAll 是否同意所有审批
   */
  constructor(answers: string[] = [], approveAll = true) {
    this.#answers = [...answers];
    this.#approve = approveAll;
  }

  async approve(call: ToolCall): Promise<boolean> {
    this.approvals.push(call);
    return this.#approve;
  }

  async ask(question: string): Promise<string> {
    this.questions.push(question);
    const next = this.#answers.shift();
    // 【不抛】回答用完了给空串 —— 让 Agent 自己处理"用户没回答"
    return next ?? '';
  }

  pendingMessage(): string | null {
    return null;
  }
}

/* ============================ 模拟用户：可编排 ============================ */

/**
 * 模拟用户 —— 可以精确编排"什么时候说什么"。
 *
 * 【和 ScriptUserIO 的区别】
 *   Script 是"按顺序给回答"，够用但只能线性。
 *   模拟用户支持：
 *     · 按调用顺序决定"这次同意、下次拒绝"（测熔断/拒绝后继续）
 *     · 在第 N 轮插话（测转向）
 *
 * 【为什么需要"个别拒绝"】
 *   "用户拒绝"是 Agent 里最容易写错的分支：
 *   拒绝后应该把 denied 喂回模型继续，而不是整个结束。
 *   要测这个，就得能精确控制在第几次调用时拒绝。
 */
export class MockUserIO implements UserIO {
  readonly #answers: string[];
  /** 每次审批的返回值队列；用完了用最后一个值 */
  readonly #approveSeq: boolean[];
  /** 第 N 轮返回这条插话（轮次从 1 开始） */
  readonly #interrupts: Map<number, string>;
  #askCount = 0;
  #pendingCount = 0;

  readonly approvals: ToolCall[] = [];
  readonly questions: string[] = [];

  constructor(opts: {
    answers?: string[];
    /** 审批序列，比如 [true, false] = 第一次同意、第二次拒绝 */
    approveSeq?: boolean[];
    /** { 2: '等等，换个做法' } = 第 2 轮插话 */
    interrupts?: Record<number, string>;
  } = {}) {
    this.#answers = [...(opts.answers ?? [])];
    this.#approveSeq = [...(opts.approveSeq ?? [true])];
    this.#interrupts = new Map(
      Object.entries(opts.interrupts ?? {}).map(([k, v]) => [Number(k), v]),
    );
  }

  async approve(call: ToolCall): Promise<boolean> {
    this.approvals.push(call);
    const v = this.#approveSeq.length > 1 ? this.#approveSeq.shift()! : this.#approveSeq[0];
    return v ?? true;
  }

  async ask(question: string): Promise<string> {
    this.questions.push(question);
    this.#askCount++;
    const next = this.#answers.shift();
    return next ?? '';
  }

  pendingMessage(): string | null {
    this.#pendingCount++;
    const msg = this.#interrupts.get(this.#pendingCount);
    return msg ?? null;
  }

  /** 自定义提问函数风格（和 ConsoleUserIO 构造参数对齐，方便互换）。 */
  static fromPrompts(prompts: Array<{ approve?: boolean; answer?: string }>): MockUserIO {
    return new MockUserIO({
      answers: prompts.map((p) => p.answer ?? ''),
      approveSeq: prompts.map((p) => p.approve ?? true),
    });
  }
}

/* ============================ 工具：审批文案 ============================ */

/**
 * 生成审批请求的可读描述。
 *
 * 【为什么单独抽出来】
 *   真人看的审批框、日志里记的审计、测试里的断言，
 *   都应该看到同一段文字。三处各写一遍必然会不一致。
 */
export function describeCall(call: ToolCall): string {
  const args =
    call.args && typeof call.args === 'object'
      ? JSON.stringify(call.args, null, 2)
      : String(call.args);
  const lines = [`工具：${call.name}`, `参数：${args}`];
  if (call.reason) lines.push(`理由：${call.reason}`);
  return lines.join('\n');
}

/** 判断一个工具调用是否需要审批。 */
export function needsApproval(readOnly: boolean, mode: 'confirm' | 'auto'): boolean {
  // auto 模式全放行；confirm 模式下只有副作用工具要问
  if (mode === 'auto') return false;
  return !readOnly;
}
