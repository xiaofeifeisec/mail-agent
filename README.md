# Mail Agent · 会自己干活的邮箱助手

一个跑在本机的 AI 邮箱助理：读你的邮件、分类、检索、回答问题、写回复草稿、发信，还能把邮件里的待办日期识别出来加进日历，并且支持**语音对话**和**数字人形象**。

> 它和"邮箱客户端 + 搜索框"的区别：普通工具的下一步是代码写死的，这里的下一步由模型自己决定——想查什么就调什么工具，看到结果再决定下一步，直到把事办完（ReAct 循环）。发信、删除这类不可撤销的动作会被一道人工审批闸门拦住。

---

## 能做什么

| 能力 | 说明 |
|---|---|
| 在线读信 | IMAP 拉取，自己解析 MIME（含中文附件名），**原始邮件不落盘** |
| 智能分类 | 按紧急/会议/账单/广告等打标签，重要邮件弹窗提醒 |
| 多跳问答 | BM25 先粗筛最相关的几封，模型再精读作答，省 token 也降幻觉 |
| 晨报 | 每天汇总未读、紧急项、待办 |
| 回复草稿 | 按原邮件上下文生成回复，可改可发 |
| 发信 | SMTP 发送，**必须人工确认**才真的发出去 |
| 待办入日历 | 从正文里识别"下周三下午三点"这类时间，人工确认后写入工作日历 |
| 语音输入 | 离线 whisper.cpp 中文识别，说一句话转成文字 |
| 语音朗读 | 离线 piper 神经音色，按标点断句朗读回答 |
| 数字人 | 用一段循环视频当形象，可对话 |

---

## 快速开始

**要求**：Node ≥ 20、macOS（语音功能依赖系统自带的 `afconvert`；纯文本功能在 Linux 也能跑）

```bash
git clone https://github.com/xiaofeifeisec/mail-agent.git
cd mail-agent

bash scripts/setup.sh        # 一键安装：装依赖、生成 .env、交互式填配置
npm run web                  # 启动，浏览器打开 http://127.0.0.1:5173
```

`setup.sh` 会依次问你：用哪家模型（有 API key）、邮箱账号和授权码。全部填完就能用。

想先看看自己缺什么、不装任何东西：

```bash
bash scripts/setup.sh --check
```

### 想打包成桌面 App

```bash
bash scripts/build-electron-app.sh
# 生成 ~/Desktop/邮箱助手 Electron.app
```

---

## 语音功能（可选）

语音这块要下载约 525MB 的模型，并按你的 CPU 架构编译 whisper.cpp，所以**不放进仓库**。一条命令装好：

```bash
bash scripts/setup-voice.sh          # 完整安装
bash scripts/setup-voice.sh --check  # 只体检，看缺什么
```

脚本会做这些事（已完成的步骤自动跳过，中断可重跑）：

1. 装 `cmake`（用 pip，不需要 Homebrew）
2. 克隆并编译 `whisper.cpp`（Apple Silicon 自动开 Metal 加速）
3. 下载中文识别模型 `ggml-small`（约 465MB）
4. `pip install --user piper-tts`，下载中文音色模型 `huayan`（约 60MB）
5. 把配置写进 `.env`

装完重启服务即可。模型走 `hf-mirror.com` 镜像，GitHub 不通时可用镜像克隆：

```bash
WHISPER_REPO=https://ghproxy.net/https://github.com/ggml-org/whisper.cpp.git bash scripts/setup-voice.sh
```

### 关于朗读断句

piper 的中文分句**不认中文标点**：实测「你好，我是助手。今天有三封邮件。」会一口气念完，中间零停顿，基本听不懂。

所以项目把 piper 的入口指向 `scripts/piper-wrap.py`——它先按标点切句，逐句合成，再插回停顿（逗号约 0.22 秒、句号约 0.45 秒），最后拼成一个 wav。同一个模型，听感差别很大。

觉得停顿还不够，改环境变量即可：

```bash
PIPER_SENTENCE_PAUSE=0.6 PIPER_COMMA_PAUSE=0.3 npm run web
```

---

## 配置

所有配置都在 `.env`（从 `.env.example` 复制，**不进版本库**）。

### 模型

```ini
LLM_PROVIDER=deepseek            # local / openai / deepseek / glm / moonshot / qwen
LLM_DEEPSEEK_API_KEY=sk-xxx
LLM_DEEPSEEK_MODEL=deepseek-chat
```

各家分别配，变量名规则是 `LLM_<大写ID>_<字段>`。任何 OpenAI 兼容的中转站也能接（自定义一个 id 即可）。

### 邮箱

QQ 邮箱、163 等需要在网页端开启 IMAP 并生成**授权码**（不是登录密码），然后：

```ini
MAIL_IMAP_PROVIDER=qq
MAIL_IMAP_USER=你的账号@qq.com
MAIL_IMAP_PASS=授权码
```

### 安全开关

```ini
MAIL_MODE=confirm    # confirm：副作用工具必须人工确认（默认）；auto：全自动
MAIL_BUDGET_USD=10   # 累计花费上限，超了直接停，防止 Agent 循环烧钱
MAIL_MAX_TURNS=8     # 单次任务最多循环几轮
```

---

## 隐私与安全

这是设计上的重点，不是事后补的：

- **邮件不落盘**：原始邮件只在内存里分析，磁盘上没有正文。代价是重启要重新拉取（IMAP 拉取很便宜）
- **两段式审批**：副作用工具（发信/删除）在 `confirm` 模式下挂起等待你点头；参数不完整的调用在弹窗之前就被拒掉
- **不依赖厂商特性**：工具调用没用 OpenAI 的 function calling，而是自定义纯文本 JSON 协议，任何 OpenAI 兼容模型都能跑
- **检索不联网**：BM25 纯本地计算，不用向量数据库，不产生额外费用
- **默认校验 TLS**：IMAP/SMTP 证书校验默认开启
- **密钥不进库**：`.env` 和 `data/` 都被 `.gitignore` 挡住；仓库里也有 `npm run secrets` 可以扫一遍

---

## 项目结构

```
src/
  mailbox/      IMAP 拉取、MIME 解析、内存邮件仓库（types.ts / store.ts）
  pipelines/    分类、BM25 检索、多跳问答、晨报、回复草稿
  agent/        ReAct 循环、工具注册表、文本工具协议、跨会话记忆
  llm/          统一模型客户端：预算、缓存、token 估算、多网关适配
  voice/        语音识别与合成后端（whisper / piper / 系统 say）
  web/          HTTP 服务与前端接口
web/index.html  单文件前端（原生 JS，无框架依赖）
electron/       桌面版外壳
scripts/        安装与打包脚本
.voice-local/   语音引擎与模型（本地生成，不进库）
```

---

## 常见问题

**启动报错说连不上模型？**
检查 `LLM_PROVIDER` 和对应那家的 `BASE_URL` / `API_KEY`。用本机网关的话确认网关在跑（默认 `127.0.0.1:8787`）。

**点了🎤没反应？**
先跑 `bash scripts/setup-voice.sh --check`。如果是桌面版，还要确认系统设置里给了 App 麦克风权限。

**朗读像念经、听不懂？**
确认 `.env` 里 `MAIL_TTS_PIPER_BIN=scripts/piper-wrap.py`（不是 `piper` 本身）。包装器负责断句，直接用 piper 会吞掉所有标点。

**邮件正文看不到？**
这是设计如此——正文只在内存里，不进数据库。点开某封邮件时才会实时拉取。

---

## 许可

MIT
