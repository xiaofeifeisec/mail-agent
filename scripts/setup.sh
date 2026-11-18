#!/usr/bin/env bash
# ============================================================
# setup.sh —— mail-agent 一键安装脚本
# ============================================================
# 用法：
#   bash scripts/setup.sh            完整交互式安装
#   bash scripts/setup.sh --check    只检测环境，不改动任何文件
#
# 它帮你做 6 件事：
#   1. 检测 Node.js 版本（要求 ≥ 20）
#   2. npm install 装依赖
#   3. 复制 .env.example → .env（不覆盖已有配置）
#   4. 交互式引导填写模型密钥 / 邮箱授权码
#   5. 修好桌面 App 依赖的 node 软链（~/.local/bin/node）
#   6. 生成桌面的「邮箱助手.app」
#
# 设计原则：
#   - 不破坏已有配置：.env 存在时默认不覆盖
#   - 每一步都能重复跑（幂等）：装过的、配过的会跳过或原地更新
#   - 密钥只写进 .env（已被 .gitignore 挡住），不进代码、不回显到屏幕
#
# 为什么不用 set -e：交互脚本里 read 遇到用户直接回车会返回非 0，
# 开了 -e 会让脚本莫名退出。这里改成"关键命令手动检查返回值"。
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
EXAMPLE="$ROOT/.env.example"
NODE_LINK="$HOME/.local/bin/node"

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

# ---------- 输出 helpers（终端才上色，管道里保持纯文本）----------
if [[ -t 1 ]]; then
  C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_D=$'\033[2m'; C_0=$'\033[0m'
else
  C_G=''; C_Y=''; C_R=''; C_D=''; C_0=''
fi
info() { printf '  %s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_Y" "$C_0" "$*"; }
err()  { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$*" >&2; }
ask()  { printf '  %s\n' "$*"; }
hr()   { printf '%s\n' '────────────────────────────────────────'; }

# 读一行，带默认值。提示走 stderr，值走 stdout —— 这样能 VAL=$(read_def ...) 捕获。
# read 遇到 EOF（管道输入结束）时用默认值，方便自动化/自检。
read_def() {
  local prompt="$1" def="$2" out=''
  printf '  %s%s [%s]: %s' "$C_D" "$prompt" "$def" "$C_0" >&2
  IFS= read -r out || true
  printf '%s' "${out:-$def}"
}

# 读密码：read -s 关闭回显，避免授权码被旁边的人看到 / 留在屏幕上
read_secret() {
  local prompt="$1" out=''
  printf '  %s%s:%s ' "$C_D" "$prompt" "$C_0" >&2
  IFS= read -rs out || true
  printf '\n' >&2
  printf '%s' "$out"
}

# ---------- 1. 检测 Node ----------
check_node() {
  if ! command -v node >/dev/null 2>&1; then
    err '没找到 node。请先装 Node.js ≥ 20（nodejs.org 下载 LTS 版）'
    return 1
  fi
  local ver major
  ver="$(node -v)"                       # 形如 v22.22.2
  major="${ver#v}"; major="${major%%.*}"
  if ! [[ "$major" =~ ^[0-9]+$ ]] || [[ "$major" -lt 20 ]]; then
    err "Node 版本不符合要求（${ver}），需要 ≥ 20"
    return 1
  fi
  NODE_REAL="$(command -v node)"         # 后续建软链要用真实路径
  ok "Node.js ${ver}（满足 ≥20）→ ${NODE_REAL}"
}

# ---------- 2. 装依赖 ----------
install_deps() {
  if [[ -d "$ROOT/node_modules" ]]; then
    ok '依赖已安装（node_modules 存在），跳过。要重装可手动删除它再跑。'
    return 0
  fi
  info '正在安装依赖（运行 imapflow / tsx / typescript，很快）...'
  if (cd "$ROOT" && npm install); then
    ok '依赖安装完成'
  else
    err 'npm install 失败，请检查网络后重新运行本脚本'
    return 1
  fi
}

# ---------- 3. 准备 .env ----------
prepare_env() {
  if [[ -f "$ENV_FILE" ]]; then
    ok '.env 已存在，保留你的现有配置（不覆盖）'
    return 0
  fi
  if [[ ! -f "$EXAMPLE" ]]; then
    err '找不到 .env.example，无法创建 .env'
    return 1
  fi
  cp "$EXAMPLE" "$ENV_FILE"
  ok '已从 .env.example 创建 .env'
}

# ---------- 写 .env 里的某一行 ----------
# 用 python 而不是 sed：值里可能有 & / \ / 空格，sed 转义极易出错。
# 值通过环境变量传给 python（不拼进代码），避免注入。
# 命中已有行（含被注释掉的 #KEY=）就原地替换，否则追加到末尾。
set_env() {
  local key="$1" val="$2"
  if ! command -v python3 >/dev/null 2>&1; then
    warn "没找到 python3，无法自动写入 ${key}；请手动编辑 .env"
    return 1
  fi
  SET_KEY="$key" SET_VAL="$val" SET_FILE="$ENV_FILE" python3 - <<'PY'
import os, re
path = os.environ['SET_FILE']
key  = os.environ['SET_KEY']
val  = os.environ['SET_VAL']
try:
    with open(path, 'r', encoding='utf-8') as f:
        lines = f.read().splitlines()
except FileNotFoundError:
    lines = []
# 同时匹配 "KEY=..." 和被注释掉的 "# KEY=..."
pat = re.compile(r'^\s*#?\s*' + re.escape(key) + r'\s*=')
for i, line in enumerate(lines):
    if pat.match(line):
        lines[i] = f'{key}={val}'
        break
else:
    lines.append(f'{key}={val}')
with open(path, 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines) + '\n')
PY
}

# ---------- 4. 配模型 ----------
configure_llm() {
  hr
  ask '【4/6】配置模型（AI 的大脑）'
  ask '  1) local     本机网关 127.0.0.1:8787（默认，你目前用的就是这个）'
  ask '  2) glm       智谱 GLM（有免费模型，新手推荐）'
  ask '  3) deepseek  DeepSeek（国内直连）'
  ask '  4) relay     自定义中转（任何 OpenAI 兼容接口）'
  ask '  5) 跳过，稍后自己编辑 .env'
  local choice
  choice="$(read_def '请选择 1-5' '1')"
  case "$choice" in
    1)
      local base model
      base="$(read_def '网关地址 BASE_URL' 'http://127.0.0.1:8787/v1')"
      model="$(read_def '模型名 MODEL' 'GLM-5.3')"
      set_env LLM_PROVIDER local       || true
      set_env LLM_LOCAL_BASE_URL "$base" || true
      set_env LLM_LOCAL_MODEL "$model"   || true
      ok '已设为 local 网关（key 沿用默认值 local-gateway，无需填写）'
      ;;
    2)
      local glm_key
      glm_key="$(read_secret '智谱 API Key（输入时不显示）')"
      if [[ -z "$glm_key" ]]; then
        warn '没填 key，已跳过；稍后在 .env 里填 LLM_GLM_API_KEY'
        return 0
      fi
      set_env LLM_PROVIDER glm          || true
      set_env LLM_GLM_API_KEY "$glm_key" || true
      set_env LLM_GLM_MODEL glm-4-flash || true
      ok '已配置智谱 GLM（免费模型 glm-4-flash）'
      ;;
    3)
      local ds_key
      ds_key="$(read_secret 'DeepSeek API Key（输入时不显示）')"
      if [[ -z "$ds_key" ]]; then
        warn '没填 key，已跳过；稍后在 .env 里填 LLM_DEEPSEEK_API_KEY'
        return 0
      fi
      set_env LLM_PROVIDER deepseek       || true
      set_env LLM_DEEPSEEK_API_KEY "$ds_key" || true
      set_env LLM_DEEPSEEK_MODEL deepseek-chat || true
      ok '已配置 DeepSeek'
      ;;
    4)
      local r_base r_key r_model
      r_base="$(read_def '中转站地址 BASE_URL' 'https://your-relay.example/v1')"
      r_key="$(read_secret 'API Key（输入时不显示）')"
      r_model="$(read_def '模型名 MODEL' 'gpt-4o-mini')"
      set_env LLM_PROVIDER relay        || true
      set_env LLM_RELAY_BASE_URL "$r_base" || true
      set_env LLM_RELAY_API_KEY "$r_key"   || true
      set_env LLM_RELAY_MODEL "$r_model"   || true
      ok '已配置自定义中转站'
      ;;
    5)
      info '跳过。要手动配置时编辑 .env，里面有每个厂商的示例和注释。'
      ;;
    *)
      warn "无效选择（${choice}），跳过模型配置"
      ;;
  esac
}

# ---------- 5. 配邮箱 ----------
configure_mail() {
  hr
  ask '【5/6】配置邮箱（可选，用于收取真实邮件）'
  local yn
  yn="$(read_def '现在配置邮箱吗？y/N' 'n')"
  if [[ "$yn" != 'y' && "$yn" != 'Y' ]]; then
    info '跳过。不配邮箱也能启动，只是没法拉真实邮件。'
    return 0
  fi
  local provider user pass
  provider="$(read_def '服务商 qq/exmail/163/126/outlook/gmail/custom' 'qq')"
  user="$(read_def '邮箱地址' '')"
  pass="$(read_secret '授权码（不是登录密码，输入时不显示）')"
  if [[ -z "$user" || -z "$pass" ]]; then
    warn '账号或授权码为空，已跳过邮箱配置'
    return 0
  fi
  set_env MAIL_IMAP_PROVIDER "$provider" || true
  set_env MAIL_IMAP_USER "$user"         || true
  set_env MAIL_IMAP_PASS "$pass"         || true
  ok "邮箱已配置：$user"
  info '提示：QQ 邮箱要去「设置 → 账户 → POP3/IMAP/SMTP」开启后生成授权码'
}

# ---------- 修桌面 App 依赖的 node 软链 ----------
# build-desktop-app.sh 第 27 行把 NODE_BIN 写死成 ~/.local/bin/node。
# 这里建一个指向真实 node 的软链，换机器也不用改那个脚本。
fix_node_link() {
  mkdir -p "$HOME/.local/bin"
  if [[ -x "$NODE_LINK" ]]; then
    ok "node 软链已存在：$NODE_LINK"
    return 0
  fi
  if [[ -e "$NODE_LINK" || -L "$NODE_LINK" ]]; then
    warn "$NODE_LINK 存在但不可执行，备份后重建"
    mv -f "$NODE_LINK" "$NODE_LINK.bak" 2>/dev/null || true
  fi
  ln -s "$NODE_REAL" "$NODE_LINK"
  ok "已创建 node 软链：$NODE_LINK → $NODE_REAL"
}

# ---------- 6. 生成桌面 App ----------
build_app() {
  hr
  ask '【6/6】生成桌面 App（可选）'
  local yn
  yn="$(read_def '生成「邮箱助手.app」到桌面？Y/n' 'y')"
  if [[ "$yn" != 'y' && "$yn" != 'Y' ]]; then
    info '跳过。你仍然可以用 npm run web 启动。'
    return 0
  fi
  if [[ "$(uname -s)" != 'Darwin' ]]; then
    warn '当前不是 macOS，跳过桌面 App（.app 仅 macOS 可用）'
    return 0
  fi
  fix_node_link || true
  if bash "$ROOT/scripts/build-desktop-app.sh"; then
    ok '桌面 App 已生成'
  else
    warn '桌面 App 生成失败，但不影响用 npm run web 启动'
  fi
}

# ---------- 环境自检（--check）----------
check_report() {
  hr
  ask '【环境自检】'
  command -v npm >/dev/null 2>&1 && ok 'npm 可用' || err 'npm 不可用（装 Node 时会自带）'
  command -v python3 >/dev/null 2>&1 && ok 'python3 可用（自动填配置需要）' || warn 'python3 不可用：配置需手动编辑 .env'
  if [[ -d "$ROOT/node_modules" ]]; then
    ok '依赖已安装'
  else
    warn '依赖未安装（安装脚本会执行 npm install）'
  fi
  if [[ -f "$ENV_FILE" ]]; then
    ok '.env 已存在（安装时不会覆盖）'
  else
    warn '.env 不存在（安装时会从模板创建）'
  fi
  if [[ "$(uname -s)" == 'Darwin' ]]; then
    ok 'macOS：支持桌面 App 与 say 语音'
  else
    warn '非 macOS：桌面 App 不可用，但仍可用命令行启动'
  fi
  hr
  info '自检完成，未改动任何文件。运行 bash scripts/setup.sh 开始安装。'
}

# ---------- 主流程 ----------
main() {
  printf '\n'
  printf '  ╔══════════════════════════════════════╗\n'
  printf '  ║   mail-agent  一键安装               ║\n'
  printf '  ╚══════════════════════════════════════╝\n'
  printf '\n'

  check_node || exit 1

  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    check_report
    exit 0
  fi

  hr; ask '【1/6】环境已就绪'; hr          # 检测已在上面完成

  hr; ask '【2/6】安装依赖'
  install_deps || exit 1

  hr; ask '【3/6】准备配置文件'
  prepare_env || exit 1

  configure_llm
  configure_mail
  build_app

  printf '\n'
  hr
  ok '安装完成！启动方式二选一：'
  info '① 命令行：cd 到项目目录，运行 npm run web，浏览器打开 http://127.0.0.1:5173'
  info '② 双击桌面的「邮箱助手.app」（若你选择了生成）'
  info '配置想改？直接编辑 .env，改完重启服务即可。'
  hr
  info '想用语音（说话输入 / 朗读回答）？再跑一条：'
  info '  bash scripts/setup-voice.sh'
  info '它要下载约 525MB 模型并编译识别引擎，所以没塞进主安装流程。'
  hr
  printf '\n'
}

main "$@"
