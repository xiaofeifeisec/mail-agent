/**
 * voice/shell.ts —— ③ 语音工具的命令执行层。
 *
 * 【定位】dsh-voice 插件的后端（say / whisper / swift shim）全部靠"跑一条命令、
 *         读 stdout/stderr"实现。上游把它挂在 DSH 框架的 `ctx.shell` 上，本项目
 *         没有那套框架，所以这里用 Node 原生 child_process 重写同一套语义。
 *
 * 【为什么不用 execSync】
 *   1. 阻塞事件循环 —— 录音 5 秒、whisper 推理可能十几秒，阻塞整个进程不可接受。
 *   2. 拿不到 AbortSignal —— 上游的 `signal` 参数是贯穿所有后端的取消通道，
 *      同步 API 无法兑现。
 *   3. 引号处理要自己拼 —— 上游用 `shqFlags` 手写 POSIX 引号再交给 shell 解释；
 *      这里改用 spawn 的参数数组，根本不经过 shell，天然免去注入与引号问题。
 *
 * 【与上游的差异】
 *   上游 shqFlags 把以 `-` 开头的 token 原样输出、其余加单引号，因为它们要生成
 *   一条 `sh -c` 字符串。这里参数数组直接传给可执行文件，所以不需要引号逻辑；
 *   但要额外注意：`-` 开头的参数（如 `-r`）在数组形式下同样会被正确识别。
 */
import { spawn } from 'node:child_process';

/** 一次前台命令的执行结果。 */
export interface ShellOutcome {
  /** 退出码。进程被信号杀死时为 null。 */
  readonly exitCode: number | null;
  /** 标准输出。 */
  readonly stdout: string;
  /** 标准错误。 */
  readonly stderr: string;
}

/** 执行一条命令；Promise 在进程结束时 resolve（非零退出码也算正常结束）。 */
export type ShellRun = (
  command: string,
  args: readonly string[],
  opts?: { readonly signal?: AbortSignal; readonly stdin?: string },
) => Promise<ShellOutcome>;

/**
 * 默认执行器：spawn + 收集输出。
 *
 * 【为什么不走 shell】spawn 不带 shell:true 时，参数数组原样交给可执行文件，
 * 用户输入的文本（要朗读的内容、要转写的路径）不会与 shell 元字符混在一起。
 */
export const shellRun: ShellRun = (command, args, opts) =>
  new Promise<ShellOutcome>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(command, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // 不继承 shell 环境里的别名与函数，只用 PATH 找可执行文件。
      shell: false,
    });

    const onAbort = (): void => {
      if (!settled) child.kill('SIGTERM');
    };
    opts?.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      opts?.signal?.removeEventListener('abort', onAbort);
      // ENOENT 说明命令不存在 —— 这在探测阶段是正常情况，交给调用方判断。
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      opts?.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code, stdout, stderr });
    });

    if (opts?.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });

/**
 * 探测命令是否存在（不执行逻辑，只看能否启动）。
 *
 * 【为什么要单独探测】选择后端时需要先知道"say 在不在 PATH 上"。若用
 * `command -v say` 走 shell，就得再引号一次；直接 spawn 并捕获 ENOENT 更直接。
 * 注意：命令存在但执行失败（exit≠0）也算"可用" —— 比如 whisper 缺模型参数，
 * 那是使用问题，不是可用性问题。
 */
export async function commandExists(run: ShellRun, command: string): Promise<boolean> {
  try {
    const outcome = await run(command, ['--version']);
    return outcome.exitCode !== null;
  } catch {
    return false;
  }
}
