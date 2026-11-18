# 上游参考代码

这里是 [dsh-voice](https://github.com/Jesse-njx/dsh-voice) 插件的**原始源码**，
仅作参考对照之用，不参与本项目的编译或运行。

| 目录 | 说明 |
|---|---|
| `src/` | 上游的 TypeScript 源码（DSH 框架插件） |
| `shims/` | 上游的 Swift shim（**在 macOS 上有 bug，见下方**） |
| `package.json` | 上游的包配置（依赖 `@deepseek-ai/*` 框架） |
| `LICENSE` | MIT License |

## 本项目移植了什么

保留并移植到 `src/voice/`：

- 后端实现（`say` / `macos` / `whisper-local` / `edge-tts` / `piper` / `openai` / `fake`）
- 后端选择逻辑（`selection.ts`）—— 包括"云端后端永不自动选中"这条安全约定
- 音频仓库与路径守卫（`audio.ts`）
- 两个工具的语义（transcribe / speak）

剥掉了（因为依赖 DSH 框架，本项目没有）：

- `ctx.tools.register` / `defineTool` —— 工具注册改为普通 async 函数
- `ctx.jobs` —— speak 不再走后台任务，直接返回结果
- DSH 会话事件（`voice/note`）、Web 音频路由、`/voice` 斜杠命令
- `ctx.shell` —— 换成 Node 原生 `child_process.spawn`（见 `src/voice/shell.ts`）

## 上游在 macOS 上的两个 bug（已在本项目修掉）

### 1. `shims/macos-record.swift` 编译不过

上游用了 `AVAudioSession` —— iOS 专有 API，macOS SDK 里没有：

```
error: 'AVAudioSession' is unavailable in macOS
```

**本项目修法**：改用 `AVAudioRecorder`（macOS 10.7+ 就有，无需 session 设置）。

### 2. `shims/macos-stt.swift` 运行即崩（TCC）

上游是普通命令行二进制。macOS 的 TCC 要求访问语音识别的进程在 Info.plist
里声明用途，没有就直接 `SIGABRT`：

> This app has crashed because it attempted to access privacy-sensitive data
> without a usage description.

**本项目修法**：打成 `.app` bundle + Info.plist + ad-hoc 签名，由宿主通过
LaunchServices（`open -a`）启动。参数改走 bundle 内的 job 文件
（LaunchServices 启动的进程拿不到 argv 和环境变量）。

细节见 `../shims/macos-stt.swift` 的注释。
