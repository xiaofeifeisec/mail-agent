#!/usr/bin/env bash
# ============================================================
#  setup-voice.sh —— 一键安装本地语音环境（识别 + 合成，全离线）
# ============================================================
#  这个脚本补的是「跑起来但语音功能不可用」的那一半：
#    · 语音识别（STT）：whisper.cpp + 中文模型  → 把你说的转成文字
#    · 语音合成（TTS）：piper + 中文音色模型    → 把回答读出来
#
#  为什么不让模型/二进制进 git：
#    两者合计约 600MB，且 whisper.cpp 必须按本机架构编译。
#    所以项目只提交「怎么装」的脚本，装出来的东西放 .voice-local/（已被忽略）。
#
#  用法：
#    bash scripts/setup-voice.sh          完整安装（已装的步骤自动跳过）
#    bash scripts/setup-voice.sh --check  只体检，不下载不编译
#
#  说明：本脚本面向 macOS（转码依赖系统自带 afconvert）。
#        Linux 也能编译 whisper.cpp，但需要自己装 ffmpeg 做转码。
# ============================================================

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/.voice-local"
WHISPER_DIR="$DEST/whisper.cpp"
MODEL_DIR="$DEST/models"
WRAP_SRC="$ROOT/scripts/whisper-cli-wrap.py"
WRAP_DST="$DEST/whisper-cli-wrap.py"

STT_MODEL="$MODEL_DIR/ggml-small.bin"
TTS_MODEL="$MODEL_DIR/zh_CN-huayan-medium.onnx"
TTS_MODEL_JSON="$MODEL_DIR/zh_CN-huayan-medium.onnx.json"

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

# 镜像优先（国内直连 GitHub / huggingface.co 经常不通）
HF_MIRROR="${HF_MIRROR:-https://hf-mirror.com}"
WHISPER_REPO="${WHISPER_REPO:-https://github.com/ggml-org/whisper.cpp.git}"

C_0=$'\033[0m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_B=$'\033[36m'
info() { printf '  %s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_Y" "$C_0" "$*"; }
err()  { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$*" >&2; }
hr()   { printf '%s\n' '────────────────────────────────────────'; }

# macOS 自带 bash 3.2：不要用关联数组、${var,,}、mapfile 等 4.0+ 特性

need_cmd() { command -v "$1" >/dev/null 2>&1; }

size_of() {
  # 输出字节数；文件不存在输出 0
  if [ -f "$1" ]; then
    stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0
  else
    echo 0
  fi
}

# fetch <url> <dest> <最小合格字节数> <描述>
# 已存在且体积达标就跳过——支持中断后重跑续做
fetch() {
  local url="$1" dest="$2" min="$3" label="$4"
  local cur
  cur=$(size_of "$dest")
  if [ "$cur" -ge "$min" ] 2>/dev/null; then
    ok "${label} 已存在（$((cur / 1024 / 1024)) MB），跳过"
    return 0
  fi
  info "下载 ${label} …"
  info "  $url"
  if curl -L --retry 3 --retry-delay 2 -m 1800 -o "${dest}.part" "$url"; then
    mv "${dest}.part" "$dest"
    cur=$(size_of "$dest")
    if [ "$cur" -ge "$min" ] 2>/dev/null; then
      ok "${label} 下载完成（$((cur / 1024 / 1024)) MB）"
      return 0
    fi
    err "${label} 下载不完整（$((cur / 1024)) KB），请重跑本脚本"
    return 1
  fi
  rm -f "${dest}.part"
  err "${label} 下载失败，请检查网络后重跑"
  return 1
}

# ---------- 体检 ----------
report() {
  hr
  printf '  语音环境体检\n'
  hr

  if [ -x "$WHISPER_DIR/build/bin/whisper-cli" ]; then
    ok "whisper-cli（语音识别引擎）已就绪"
  else
    err "whisper-cli 缺失 → 语音输入不可用"
  fi

  local s
  s=$(size_of "$STT_MODEL")
  if [ "$s" -ge 400000000 ] 2>/dev/null; then
    ok "中文识别模型已就绪（$((s / 1024 / 1024)) MB）"
  else
    err "中文识别模型缺失或不完整"
  fi

  if [ -x "$WRAP_DST" ]; then
    ok "格式转换包装器已就位"
  else
    err "格式转换包装器缺失 → 前端录音（m4a）无法喂给 whisper"
  fi

  local piper_bin="$HOME/.local/bin/piper"
  if [ -x "$piper_bin" ] || need_cmd piper; then
    ok "piper（语音合成引擎）已就绪"
  else
    err "piper 缺失 → 回答无法朗读"
  fi

  s=$(size_of "$TTS_MODEL")
  if [ "$s" -ge 50000000 ] 2>/dev/null; then
    ok "中文音色模型已就绪（$((s / 1024 / 1024)) MB）"
  else
    err "中文音色模型缺失"
  fi

  if [ "$(uname -s)" = "Darwin" ]; then
    ok "系统为 macOS，afconvert 转码可用"
  else
    warn "非 macOS：需要自备 ffmpeg 做音频转码"
  fi

  printf '\n'
}

# ---------- 1. cmake ----------
find_cmake() {
  if need_cmd cmake; then
    command -v cmake
    return 0
  fi
  # pip 装的 cmake 不在 PATH 里，用 python 问出位置
  python3 -c "import cmake,os;print(os.path.join(os.path.dirname(cmake.__file__),'data','bin','cmake'))" 2>/dev/null
}

step_cmake() {
  local found
  found=$(find_cmake)
  if [ -n "$found" ] && [ -x "$found" ]; then
    ok "cmake 可用：$found"
    CMAKE_BIN="$found"
    return 0
  fi
  info "未找到 cmake，用 pip 安装（不需要 Homebrew）…"
  python3 -m pip install --user cmake >/dev/null 2>&1
  found=$(find_cmake)
  if [ -z "$found" ] || [ ! -x "$found" ]; then
    err "cmake 安装失败"
    return 1
  fi
  CMAKE_BIN="$found"
  ok "cmake 已装：$found"
}

# ---------- 2. whisper.cpp ----------
step_whisper_src() {
  if [ -d "$WHISPER_DIR/.git" ]; then
    ok "whisper.cpp 源码已存在，跳过克隆"
    return 0
  fi
  info "克隆 whisper.cpp …"
  if git clone --depth 1 "$WHISPER_REPO" "$WHISPER_DIR" 2>&1 | tail -3; then
    ok "whisper.cpp 源码就绪"
    return 0
  fi
  err "克隆失败。可换镜像重试："
  info "  WHISPER_REPO=https://ghproxy.net/https://github.com/ggml-org/whisper.cpp.git bash scripts/setup-voice.sh"
  return 1
}

step_whisper_build() {
  if [ -x "$WHISPER_DIR/build/bin/whisper-cli" ]; then
    ok "whisper-cli 已编译，跳过"
    return 0
  fi

  local metal="OFF"
  local jobs
  jobs=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
  # Apple Silicon 开 Metal 走 GPU 加速，识别速度能快数倍
  if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
    metal="ON"
  fi

  info "配置构建（Metal=${metal}，${jobs} 并发）…"
  if ! "$CMAKE_BIN" -B "$WHISPER_DIR/build" -DGGML_METAL="$metal" -DCMAKE_BUILD_TYPE=Release >/dev/null 2>&1; then
    err "cmake 配置失败"
    return 1
  fi

  info "编译 whisper-cli（首次约需 1-3 分钟）…"
  if ! "$CMAKE_BIN" --build "$WHISPER_DIR/build" --target whisper-cli -j "$jobs" 2>&1 | tail -5; then
    err "编译失败"
    return 1
  fi

  if [ -x "$WHISPER_DIR/build/bin/whisper-cli" ]; then
    ok "whisper-cli 编译完成"
    return 0
  fi
  err "没找到编译产物 whisper-cli"
  return 1
}

# ---------- 3. 模型 ----------
step_stt_model() {
  fetch "$HF_MIRROR/ggerganov/whisper.cpp/resolve/main/ggml-small.bin" "$STT_MODEL" 400000000 "中文识别模型 ggml-small（约 465MB）"
}

# ---------- 4. piper ----------
find_piper() {
  if need_cmd piper; then
    command -v piper
    return 0
  fi
  if [ -x "$HOME/.local/bin/piper" ]; then
    echo "$HOME/.local/bin/piper"
    return 0
  fi
  return 1
}

step_piper() {
  local p
  p=$(find_piper)
  if [ -n "$p" ]; then
    ok "piper 已安装：$p"
    return 0
  fi
  info "安装 piper-tts（Python 包，自带二进制）…"
  python3 -m pip install --user piper-tts 2>&1 | tail -3
  p=$(find_piper)
  if [ -z "$p" ]; then
    err "piper 安装失败"
    return 1
  fi
  ok "piper 已装：$p"
}

step_tts_model() {
  fetch "$HF_MIRROR/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx" "$TTS_MODEL" 50000000 "中文音色模型 huayan（约 60MB）" || return 1
  fetch "$HF_MIRROR/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx.json" "$TTS_MODEL_JSON" 1000 "音色配置 json" || return 1
}

# ---------- 5. 包装器 ----------
step_wrapper() {
  if [ ! -f "$WRAP_SRC" ]; then
    err "缺少 $WRAP_SRC"
    return 1
  fi
  cp "$WRAP_SRC" "$WRAP_DST"
  chmod +x "$WRAP_DST"
  # piper 包装器直接从 scripts/ 运行（不复制），这里只确保可执行
  if [ -f "$ROOT/scripts/piper-wrap.py" ]; then
    chmod +x "$ROOT/scripts/piper-wrap.py"
  else
    err "缺少 scripts/piper-wrap.py（朗读断句依赖它）"
    return 1
  fi
  ok "格式转换包装器已就位（识别 + 朗读断句）"
}

# ---------- 6. 写配置 ----------
step_env() {
  local envf="$ROOT/.env"
  if [ ! -f "$envf" ]; then
    if [ -f "$ROOT/.env.example" ]; then
      cp "$ROOT/.env.example" "$envf"
      chmod 600 "$envf"
      warn "未找到 .env，已从 .env.example 复制一份（记得填模型和邮箱）"
    else
      err "既没有 .env 也没有 .env.example"
      return 1
    fi
  fi

  # 已经有配置就别覆盖——尊重用户手改
  if grep -q '^MAIL_STT_WHISPER_BIN=' "$envf" 2>/dev/null; then
    ok ".env 里已有语音配置，保持不变"
    return 0
  fi

  local piper_bin
  piper_bin=$(find_piper || echo "$HOME/.local/bin/piper")

  cat >> "$envf" <<EOF

# ===== 本地语音（由 scripts/setup-voice.sh 写入）=====
# 识别：把录音转成文字。bin 指向包装器（负责把 m4a 转成 wav 再喂 whisper）
MAIL_STT_WHISPER_BIN=.voice-local/whisper-cli-wrap.py
MAIL_STT_WHISPER_MODEL=.voice-local/models/ggml-small.bin
# 合成：把回答读出来。bin 指向 piper 包装器——它按标点切句并插入停顿，
# 否则 piper 会无视中文标点一口气念完，听不清断句。
# 底层真正的 piper 可执行文件：${piper_bin}
MAIL_TTS_BACKEND=piper
MAIL_TTS_PIPER_BIN=scripts/piper-wrap.py
MAIL_TTS_PIPER_MODEL=.voice-local/models/zh_CN-huayan-medium.onnx
EOF
  ok "已把语音配置写入 .env"
}

# ---------- main ----------
printf '\n'
hr
printf '  本地语音环境安装（识别 whisper + 合成 piper，全离线）\n'
hr
info "项目根目录：$ROOT"
info "安装位置：  $DEST"
printf '\n'

if [ "$CHECK_ONLY" -eq 1 ]; then
  report
  exit 0
fi

need_cmd python3 || { err '缺少 python3'; exit 1; }
need_cmd git     || { err '缺少 git'; exit 1; }
need_cmd curl    || { err '缺少 curl'; exit 1; }

mkdir -p "$DEST" "$MODEL_DIR"

hr; info '【1/6】准备构建工具 cmake'; hr
step_cmake || exit 1

hr; info '【2/6】获取 whisper.cpp 源码'; hr
step_whisper_src || exit 1

hr; info '【3/6】编译 whisper-cli'; hr
step_whisper_build || exit 1

hr; info '【4/6】下载模型（约 525MB，可中断重跑）'; hr
step_stt_model || exit 1

hr; info '【5/6】安装 piper 语音合成'; hr
step_piper || exit 1
step_tts_model || exit 1

hr; info '【6/6】配置接线'; hr
step_wrapper || exit 1
step_env || exit 1

printf '\n'
report
ok '语音环境安装完成'
info '下一步：重启服务（npm run web）后，点界面上的 🎤 说话，回答会自动朗读。'
info '想换朗读音色：改 .env 的 MAIL_TTS_PIPER_MODEL 指向别的模型，或设 MAIL_TTS_BACKEND=say 用系统音色。'
printf '\n'
