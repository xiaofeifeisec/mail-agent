#!/usr/bin/env bash
#
# tools/install-git-hooks.sh —— 装上 pre-commit 密钥检查。
#
# 【为什么需要】
#   .gitignore 挡的是"默认不提交"，挡不住 git add -f，
#   也挡不住密钥以别的形式出现（粘在源码注释里、写进文档里）。
#   pre-commit hook 是最后一道闸：提交前扫暂存区内容，发现密钥就拒绝。
#
# 【用法】
#   bash tools/install-git-hooks.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_DIR="$ROOT/.git/hooks"
HOOK_FILE="$HOOKS_DIR/pre-commit"

# ---- 前置检查 ----
if [ ! -d "$ROOT/.git" ]; then
  echo "❌ 这还不是一个 git 仓库。先跑：git init"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "⚠️  找不到 node 命令 —— hook 会用 .local/bin/node 兜底"
fi

mkdir -p "$HOOKS_DIR"

# ---- 写 hook ----
cat > "$HOOK_FILE" <<'HOOK'
#!/usr/bin/env bash
# pre-commit —— 提交前扫密钥。由 tools/install-git-hooks.sh 生成。
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
CHECK="$ROOT/tools/check-secrets.ts"

# 找 node：优先 PATH 上的，找不到就用本机稳定软链
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] && [ -x "$HOME/.local/bin/node" ]; then
  NODE_BIN="$HOME/.local/bin/node"
fi
if [ -z "$NODE_BIN" ]; then
  echo "⚠️  找不到 node，跳过密钥检查（不阻断提交）"
  exit 0
fi

TSX="$ROOT/node_modules/tsx/dist/cli.mjs"
if [ ! -f "$TSX" ]; then
  echo "⚠️  没装 tsx，跳过密钥检查（不阻断提交）"
  exit 0
fi

"$NODE_BIN" "$TSX" "$CHECK"
HOOK

chmod +x "$HOOK_FILE"

echo "✅ 已安装 pre-commit hook：$HOOK_FILE"
echo
echo "验证一下（提交时会自动跑）："
echo "  npx tsx tools/check-secrets.ts"
echo
echo "⚠️  提醒：hook 只对【本次提交】生效。"
echo "   如果密钥曾经被提交过，删历史很麻烦 —— 发现泄露要立刻去平台后台吊销那个 key。"
