# 语音模块（voice）

给 `mail-agent` 提供的语音能力：**口述转文字** + **文字朗读**。

移植自 [dsh-voice](https://github.com/Jesse-njx/dsh-voice)（MIT License）——
一个 DSH（DeepSeek Harness）插件。上游把工具注册在 DSH 框架的 `ctx.tools` 上，
本项目没有那套框架，所以剥掉了注册层，只保留并修正后端实现。

---

## 为什么邮件 agent 需要语音

邮件处理的场景里，用户经常**不在键盘前**：走路、开会、做饭时想口述一封邮件；
或者邮件批量处理跑了几分钟，想让它出声告诉自己结果。

- `transcribe` —— 麦克风录音 → 文本。文本直接就是邮件正文，或一条指令。
- `speak` —— 文字 → 语音，把结果播报出来。

两个都是**普通 async 函数**，不绑定任何框架。调用方直接 `await`。

---

## 快速开始

```ts
import { createVoiceTools, resolveConfig } from './voice/index.ts';

// 配置可选。不填就走自动选择：STT 优先 whisper-local 再 macos，TTS 优先 say。
const cfg = resolveConfig({
  stt: { backend: 'macos' },
  tts: { backend: 'say', voice: 'Tingting' },
});

const voice = createVoiceTools(cfg);

// 口述 5 秒，转成文字
const { transcript } = await voice.transcribe({
  source: { record: { seconds: 5 } },
});
console.log(transcript);

// 朗读一段文字
await voice.speak({ text: '三封邮件已处理完毕' });
```

---

## 后端矩阵

| 能力 | 后端 | 需要什么 | 上网？ |
|---|---|---|---|
| STT | `whisper-local` | whisper.cpp + ggml 模型 | 否 |
| STT | `macos` | macOS 系统语音识别（本仓库已带 shim） | 否 |
| STT | `openai` | OpenAI 兼容接口 + API key | **是** |
| STT | `fake` | 无（测试替身） | 否 |
| TTS | `say` | macOS 自带 | 否 |
| TTS | `piper` | piper + ONNX 模型 | 否 |
| TTS | `edge-tts` | edge-tts CLI | **是** |
| TTS | `fake` | 无（测试替身） | 否 |

### 云端后端永不自动选中

自动选择只在**离线**后端里按顺序挑（STT: `whisper-local` → `macos`；
TTS: `say` → `piper`）。

原因很直接：语音是隐私数据。用户装了工具不等于同意把录音发到第三方。
要显式配 `stt.backend: 'openai'` 或 `tts.backend: 'edge-tts'` 才走云端 ——
那是明确的意图。

---

## 目录结构

```
src/voice/
  types.ts        类型契约与配置（唯一的"事实来源"）
  audio.ts        音频落盘与路径守卫
  shell.ts        命令执行层（Node 原生 spawn，不经 shell）
  probe.ts        后端可用性探测
  selection.ts    后端选择（纯函数）
  tools.ts        transcribe / speak 本体
  backends/
    say.ts        macOS 内置合成
    macos.ts      macOS 系统识别 + 录音
    whisper-local.ts  本地 whisper.cpp
    edge-tts.ts   edge-tts 云端合成
    piper.ts      本地 piper 神经合成
    openai.ts     OpenAI 兼容云端识别
    fake.ts       测试替身
    index.ts      后端工厂

voice/
  shims/          Swift shim 源码
    macos-record.swift
    macos-stt.swift
  build.sh        编译脚本
  build/          编译产物（build.sh 生成）
```

---

## 构建 shim

macOS 的语音识别和录音都需要一个 Swift 小程序：

```bash
./voice/build.sh
```

产物：

- `voice/build/macos-record` —— 录音 shim
- `voice/build/VoiceSTT.app` —— 语音识别 bundle

### 为什么 shim 要打成 .app

macOS 的 TCC（隐私授权）规定：访问麦克风 / 语音识别的进程，必须在 `Info.plist`
里声明用途（`NSSpeechRecognitionUsageDescription`）。命令行二进制没有
`Info.plist`，跑起来会被系统直接 `SIGABRT` 杀掉 —— 崩溃报告里写得很直白：

> This app has crashed because it attempted to access privacy-sensitive data
> without a usage description.

所以语音识别部分打成 `.app`，由宿主通过 LaunchServices（`open -a`）启动，
TCC 才认这个 bundle。

副作用：LaunchServices 启动的进程拿不到 argv 和环境变量。所以参数通过
bundle 内一个固定的 job 文件传递（`<bundle>/Contents/Resources/job.json`），
host 侧负责写这个文件、轮询等结果。

---

## 修了上游两个 macOS bug

上游的 shim 是照着 iOS 写的，直接搬到 macOS 上跑不起来：

### 1. `macos-record.swift` 编译不过

上游用了 `AVAudioSession` —— 那是 **iOS 专有 API**，macOS 的 SDK 里根本没有：

```
error: 'AVAudioSession' is unavailable in macOS
```

**修法**：改用 `AVAudioRecorder`。它在 macOS 10.7+ 就有，不需要 session 分类设置。

### 2. `macos-stt.swift` 运行即崩

上游是普通命令行二进制，触发上面说的 TCC 崩溃。

**修法**：打成 `.app` bundle + `Info.plist` + ad-hoc 签名，改用 job 文件传参。

另外还修了一个 SDK 问题：本机 `swift` 默认挑最新 SDK，但编译器可能比 SDK 老，
报 `this SDK is not supported by the compiler`。`build.sh` 会自动探测可用 SDK
（先试默认，不行就显式指定旧 SDK，从新到旧逐个试）。

---

## 首次使用

第一次调用 `transcribe`（macOS 后端）时，系统会弹**语音识别**授权框，需要允许一次。
之后可以在「系统设置 › 隐私与安全性 › 语音识别」里管理。

麦克风授权归**宿主进程**（终端 / IDE）管，不归这个 bundle。

---

## 音频存哪

默认 `~/.dsh/voice/`（可用 `audioDir` 配置改）。纯文件，随时可以看、可以删。
会话记录里只存路径引用，不重复存音频字节。

---

## 测试

用 `fake` 后端可以在没有麦克风、没有网络的情况下跑通整条链路：

```ts
import { FakeSttBackend, FakeTtsBackend } from './voice/index.ts';

// fake TTS 把 {"transcript": "<文本>"} 写进输出文件，
// fake STT 再把它读回来 —— 闭环可测。
```

`fake` 后端的映射规则是确定的：STT 读文件，内容是带 `transcript` 字段的 JSON
就返回该字段，否则取文件名（去扩展名、`-`/`_` 转空格）。
所以 `fixture-build-done.m4a` 会转写成 `build done`。
