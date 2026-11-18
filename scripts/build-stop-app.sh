#!/usr/bin/env bash
# build-stop-app.sh —— 在桌面生成「停止邮箱助手.command」。
#
# 为什么需要：
# App 是 nohup 拉起服务的，App 窗口关了服务还在跑（这是故意的 —— 关窗口不该停服务）。
# 但你总得有个办法停它，尤其是不想让它一直连着邮箱的时候。
#
# .command 是 macOS 原生的可执行脚本，双击会在终端里跑，跑完自动关窗。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="$HOME/Desktop"
TARGET="$DESKTOP/停止邮箱助手.command"
PORT=5173

cat > "$TARGET" <<'LAUNCH'
#!/bin/bash
# 停止「邮箱助手」Web UI 服务。

echo "正在停止邮箱助手服务…"

# ① 先按端口找（最准，不会误杀别的 node 进程）
PIDS=$(/usr/sbin/lsof -nP -iTCP:5173 -sTCP:LISTEN -t 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  for p in $PIDS; do
    /bin/kill "$p" 2>/dev/null || true
  done
  sleep 1
  # 还活着就强制
  PIDS2=$(/usr/sbin/lsof -nP -iTCP:5173 -sTCP:LISTEN -t 2>/dev/null || true)
  for p in $PIDS2; do
    /bin/kill -9 "$p" 2>/dev/null || true
  done
  echo "✅ 已停止（端口 5173 已释放）"
else
  echo "ℹ️  服务本来就没在运行"
fi

echo ""
echo "提示：下次双击桌面上的「邮箱助手」即可重新启动。"
echo ""
echo "按回车关闭此窗口。"
read -r
LAUNCH

chmod +x "$TARGET"
printf '✅ 已生成：%s\n' "$TARGET"
