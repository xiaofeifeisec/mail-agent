/**
 * agent/session.ts —— 把「一次 Web 会话」装配成可运行的 Agent。
 *
 * 【为什么单独一层】
 *   createAgentConfig() 需要 Config + 当前邮件 + UserIO + Memory + 发信实现，
 *   这些拼装逻辑不该塞进 server.ts 的路由里。这里做成纯工厂：
 *   给依赖，返回一个能跑的会话管理器。
 *
 * 【审批为什么要「两段式」】
 *   UserIO.approve() 返回 Promise<boolean>，而 HTTP 请求是无状态的。
 *   直接 await 会让请求挂住几十秒，浏览器/代理随时可能断开。
 *   所以改成：
 *     ① runAgent 在后台跑，遇到副作用工具时调 approve() → 挂起一个 Promise
 *     ② 路由立刻返回 runId；前端轮询 status 拿到「待审批项」
 *     ③ 用户点同意 → POST approve → resolve 那个 Promise → runAgent 继续
 *   每个 HTTP 请求都是短请求，状态留在进程内存里。
 *
 * 【为什么不把 send 默认成真实发信】
 *   装配层不猜副作用。必须由调用方显式传 send 函数，
 *   测试传假的、生产传 smtp 的 —— 这样一次测试永远不会误发邮件。
 */

import type { Config } from '../config.js';
import type { Email } from '../mailbox/types.js';
import type { ToolCall, UserIO, AgentResult } from './types.js';
import { createAgentConfig, type AgentDeps } from './tools.js';
import { Memory, defaultMemoryPath } from './memory.js';
import { runAgent } from './loop.js';
import { describeCall } from './userio.js';

/** 一次运行的状态。 */
export type RunStatus = 'running' | 'awaiting_approval' | 'awaiting_answer' | 'done' | 'error';

export interface ApprovalRequest {
  /** 审批 id —— 提交决定时带上它，防止用户点到上一次的旧审批 */
  id: string;
  kind: 'approve' | 'ask';
  call?: ToolCall;
  question: string;
  detail: string;
}

export interface AgentRun {
  id: string;
  question: string;
  status: RunStatus;
  /** 最终回答（done 时才有） */
  text: string;
  /** 终止原因 */
  outcome?: AgentResult['status'];
  /** 工具调用轨迹（审计 + 前端展示） */
  calls: AgentResult['calls'];
  turns: number;
  error: string;
  /** 当前挂起的审批/提问 */
  pending: ApprovalRequest | null;
  startedAt: number;
  updatedAt: number;
}

export interface SessionDeps {
  cfg: Config;
  mails: Email[];
  projectRoot: string;
  /** 真实发信实现（生产传 smtp；测试传假函数）。不传则 send 工具会报「未配置」。 */
  send?: AgentDeps['send'];
  makeLm?: AgentDeps['makeLm'];
  /** 显式传 false 可关掉记忆（测试用） */
  memory?: Memory | false;
}

export interface AgentSession {
  /** 启动一次提问，立刻返回 runId（不等待跑完） */
  ask(question: string): string;
  status(runId: string): AgentRun | undefined;
  /** 提交审批决定；返回是否成功唤醒 */
  decide(runId: string, approvalId: string, approved: boolean, answer?: string): boolean;
  /** 最近 N 次运行 */
  recent(limit: number): AgentRun[];
  /** 清空运行记录（服务关闭时调用） */
  dispose(): void;
}

let seq = 0;
function nextId(prefix: string): string {
  seq++;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/**
 * 建一个会话管理器。
 *
 * 注意：mails 是【建会话时的快照】。用户重新拉取邮件后应重建会话，
 * 否则 Agent 看到的还是旧邮件 —— 和 /api/reply 只认会话内邮件的原则一致。
 */
export function createAgentSession(deps: SessionDeps): AgentSession {
  const runs = new Map<string, AgentRun>();
  // 【关键】每个 run 的唤醒函数单独存。若放在 ask() 的闭包变量里，
  // 并发第二次提问会把第一个 wake 覆盖掉，导致第一个 run 永远卡在审批。
  const wakes = new Map<string, (value: boolean | string) => void>();
  const memory =
    deps.memory === false ? undefined : deps.memory ?? new Memory(defaultMemoryPath(deps.projectRoot));

  function waitFor(runId: string): Promise<boolean | string> {
    return new Promise((resolve) => {
      wakes.set(runId, resolve);
    });
  }

  return {
    ask(question: string): string {
      const runId = nextId('run');
      const run: AgentRun = {
        id: runId,
        question,
        status: 'running',
        text: '',
        calls: [],
        turns: 0,
        error: '',
        pending: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
      runs.set(runId, run);

      const user: UserIO = {
        async approve(call: ToolCall): Promise<boolean> {
          // 【安全】能走到这里，说明 loop.ts 的关 3 已判定「副作用工具 + confirm 模式」。
          // 进入 approve() 就必须问人，绝不能再自行放行。历史上这里写成
          // needsApproval(true, mode)（true=只读），导致结果恒为 false → 恒放行，
          // 副作用工具（发信）被静默执行 —— 已修复：只有 auto 模式才自动通过。
          if (deps.cfg.mode === 'auto') return true;
          const req: ApprovalRequest = {
            id: nextId('appr'),
            kind: 'approve',
            call,
            question: `要执行「${call.name}」，是否允许？`,
            detail: describeCall(call),
          };
          run.pending = req;
          run.status = 'awaiting_approval';
          run.updatedAt = Date.now();
          const answer = await waitFor(runId);
          wakes.delete(runId);
          run.pending = null;
          run.status = 'running';
          run.updatedAt = Date.now();
          return answer === true || answer === 'true';
        },

        async ask(q: string): Promise<string> {
          const req: ApprovalRequest = {
            id: nextId('appr'),
            kind: 'ask',
            question: q,
            detail: 'Agent 需要你补充信息才能继续',
          };
          run.pending = req;
          run.status = 'awaiting_answer';
          run.updatedAt = Date.now();
          const answer = await waitFor(runId);
          wakes.delete(runId);
          run.pending = null;
          run.status = 'running';
          run.updatedAt = Date.now();
          return typeof answer === 'string' ? answer : '';
        },

        pendingMessage(): string | null {
          // Web 端目前没有「插话」通道，返回 null —— 比阻塞等待安全
          return null;
        },
      };

      // 后台跑，不阻塞路由。任何异常都收进 run.error，
      // 绝不让 unhandled rejection 杀掉整个服务进程（见上次的 ERR_HTTP_HEADERS_SENT 教训）。
      void (async () => {
        try {
          const config = createAgentConfig({
            cfg: deps.cfg,
            mails: deps.mails,
            makeLm: deps.makeLm,
            memory,
            user,
            send: deps.send,
          });
          const result = await runAgent(config, question);
          run.text = result.text;
          run.outcome = result.status;
          run.calls = result.calls;
          run.turns = result.turns;
          run.status = 'done';
        } catch (e) {
          run.error = (e as Error).message;
          run.status = 'error';
        } finally {
          run.pending = null;
          wakes.delete(runId);
          run.updatedAt = Date.now();
        }
      })();

      return runId;
    },

    status(runId: string): AgentRun | undefined {
      return runs.get(runId);
    },

    decide(runId: string, approvalId: string, approved: boolean, answer?: string): boolean {
      const run = runs.get(runId);
      const wake = wakes.get(runId);
      if (!run || !run.pending || run.pending.id !== approvalId || !wake) return false;
      wake(run.pending.kind === 'ask' ? String(answer ?? '') : approved);
      run.updatedAt = Date.now();
      return true;
    },

    recent(limit: number): AgentRun[] {
      // 同一毫秒内连发多次时 startedAt 相同，单靠它会让排序不稳定（Node 的
      // sort 不保证稳定语义跨版本一致）。Map 的插入顺序是可靠的，直接反序取。
      return [...runs.values()].reverse().slice(0, Math.max(0, limit));
    },

    dispose(): void {
      runs.clear();
      wakes.clear();
    },
  };
}
