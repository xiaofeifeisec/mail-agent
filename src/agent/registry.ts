/**
 * agent/registry.ts —— ⑨c 工具注册表（校验 / 执行分离）。
 *
 * 【核心设计：validate 与 execute 必须分开】
 *   validate(name, args) 只查不执行，返回错误原因（不抛异常）
 *   execute(name, args)  先校验再执行
 *
 * 【为什么这个分离是必须的，不是"优雅"】
 *   在 confirm 模式下，一个副作用工具要经过"请用户审批"这一关。
 *   如果校验和执行是一体的，你会遇到两个都很糟的选择：
 *     A. 先问用户 → 用户点了同意 → 执行时才发现参数缺失
 *        （用户对着一个残缺的调用点了同意，他同意的是什么？）
 *     B. 先执行 → 执行到一半发现参数错了
 *        （副作用已经发生了）
 *
 *   分开之后：**参数不全的调用在弹窗之前就被拒了**。
 *   用户看到的审批框，永远是参数完整的。
 *
 * 【为什么手写校验，不用 ajv】
 *   我们只需要"有没有传、类型对不对、是不是枚举里那个"三件事。
 *   20 行代码够了。引 ajv 会带进来一个依赖树 ——
 *   而这个项目至今只有 imapflow 一个第三方依赖，这个记录值得守住。
 */

import type { JSONSchemaProperty, ToolCall, ToolResult, ToolRegistry, ToolSpec } from './types.js';

/**
 * 工具注册表。
 *
 * 【为什么工具名重复注册要报错而不是覆盖】
 *   覆盖会让"我明明注册了新版本"和"怎么跑的还是老逻辑"混在一起。
 *   这在 Agent 里特别难查 —— 因为你看不到模型到底调了哪个。
 *   直接报错，让问题在启动时就暴露。
 */
export class Registry implements ToolRegistry {
  readonly #tools = new Map<string, ToolSpec>();

  /** 注册一个工具。重名抛错。 */
  register(spec: ToolSpec): void {
    if (!spec.name || !/^[a-z][a-z0-9_]*$/.test(spec.name)) {
      throw new Error(`工具名不合法：${JSON.stringify(spec.name)}（要求小写字母开头、只用字母数字下划线）`);
    }
    if (this.#tools.has(spec.name)) {
      throw new Error(`工具重复注册：${spec.name}`);
    }
    this.#tools.set(spec.name, spec);
  }

  get(name: string): ToolSpec | undefined {
    return this.#tools.get(name);
  }

  list(): ToolSpec[] {
    return [...this.#tools.values()];
  }

  /**
   * 只校验，不执行。
   *
   * 【返回错误原因而不抛异常】
   *   因为"参数不对"是流程的一部分（要告诉模型让它改），
   *   不是程序异常。抛异常会让调用方不得不 try/catch，
   *   而 catch 之后它又不知道该返回什么状态。
   */
  validate(name: string, args: unknown): { ok: boolean; error?: string } {
    const spec = this.#tools.get(name);
    if (!spec) {
      // 把可用工具列出来 —— 模型拼错名字时能看到正确拼法
      const names = this.list().map((t) => t.name).join(', ');
      return { ok: false, error: `没有这个工具。可用的有：${names}` };
    }

    // args 必须是对象（null 也算错）
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return { ok: false, error: 'args 必须是一个 JSON 对象' };
    }

    const obj = args as Record<string, unknown>;
    const schema = spec.parameters;

    // ① 必填字段
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined || obj[key] === null) {
        return { ok: false, error: `缺少必填参数：${key}` };
      }
    }

    // ② 逐个字段校验类型和枚举
    for (const [key, rule] of Object.entries(schema.properties ?? {})) {
      const v = obj[key];
      if (v === undefined || v === null) continue; // 可选字段没传就跳过
      const err = checkValue(key, v, rule);
      if (err) return { ok: false, error: err };
    }

    // ③ 危险字段名：原型污染防御
    //
    // 【为什么必须用 hasOwnProperty 而不是 `in`】
    //   `'constructor' in obj` 对【任何】普通对象都是 true ——
    //   因为它查的是整条原型链。写成 `in` 会把所有合法调用都误拒。
    //   实测踩过这个坑：5 个正常用例全被 invalid_args 挡住。
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      if (Object.prototype.hasOwnProperty.call(obj, bad)) {
        return { ok: false, error: `args 里有非法字段名：${bad}` };
      }
    }

    return { ok: true };
  }

  /**
   * 先校验再执行。
   *
   * 【所有异常都转成 tool_error，不往上抛】
   *   工具内部炸了（网络断了、文件没了）是"这次调用失败"，
   *   不是"程序崩溃"。把它变成 tool_result 喂回模型，
   *   模型能决定是重试、换工具、还是放弃。
   */
  async execute(name: string, args: unknown): Promise<ToolResult> {
    const v = this.validate(name, args);
    if (!v.ok) {
      // 区分"工具不存在"和"参数不对" —— 模型对这两种的补救动作不一样
      const status = this.#tools.has(name) ? 'invalid_args' : 'unknown_tool';
      return { status, content: v.error ?? '参数校验失败' };
    }

    const spec = this.#tools.get(name)!;
    try {
      const content = await spec.fn(args as Record<string, unknown>);
      // 工具返回非字符串（可能有人图省事返回对象）→ 兜底转成 JSON
      return { status: 'ok', content: typeof content === 'string' ? content : JSON.stringify(content) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: 'tool_error', content: `工具执行失败：${msg}` };
    }
  }

  /**
   * 生成给模型看的工具清单。
   *
   * 【为什么要有这个方法】
   *   模型不知道有哪些工具 —— 它只能从 system prompt 里读。
   *   而手写这份清单必然会跟实际注册的工具脱节
   *   （加了个工具忘了写进 prompt → 模型永远不用它）。
   *   从注册表生成，就永远不会脱节。
   */
  describe(): string {
    return this.list()
      .map((t) => {
        const params = Object.entries(t.parameters.properties ?? {})
          .map(([k, p]) => {
            const req = (t.parameters.required ?? []).includes(k) ? '必填' : '可选';
            const en = p.enum ? `，取值 ${p.enum.join('|')}` : '';
            return `    - ${k}（${p.type}，${req}${en}）${p.description ?? ''}`;
          })
          .join('\n');
        const ro = t.readOnly ? '' : '  [有副作用，需要审批]';
        return `· ${t.name}${ro}\n  ${t.description}${params ? '\n' + params : ''}`;
      })
      .join('\n\n');
  }
}

/**
 * 校验一个字段值。
 * @returns 错误信息；null = 通过
 */
function checkValue(key: string, v: unknown, rule: JSONSchemaProperty): string | null {
  switch (rule.type) {
    case 'string':
      if (typeof v !== 'string') return `参数 ${key} 应该是字符串，收到 ${typeof v}`;
      if (rule.enum && !rule.enum.includes(v)) {
        return `参数 ${key} 取值非法，只能是 ${rule.enum.join(' / ')}`;
      }
      return null;

    case 'number':
      // 【注意】不接受数字字符串。
      //   模型常把数字写成 "5"，宽容接受会掩盖"它其实没理解类型"的问题，
      //   而且 JSON 里本来就该是数字。让它改一次，比以后到处做类型转换好。
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return `参数 ${key} 应该是数字，收到 ${typeof v}`;
      }
      return null;

    case 'boolean':
      if (typeof v !== 'boolean') return `参数 ${key} 应该是布尔值，收到 ${typeof v}`;
      return null;

    default:
      return `参数 ${key} 的类型声明有问题`;
  }
}

/**
 * 从一次调用里取出工具名（给日志/审计用）。
 */
export function callLabel(call: ToolCall): string {
  const args = call.args && typeof call.args === 'object' ? JSON.stringify(call.args) : '';
  const short = args.length > 80 ? args.slice(0, 80) + '…' : args;
  return `${call.name}(${short})`;
}
