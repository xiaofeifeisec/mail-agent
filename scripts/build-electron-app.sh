#!/usr/bin/env bash
# build-electron-app.sh —— 生成可双击的「邮箱助手 Electron.app」
#
# 和现有的「邮箱助手.app」（启动器+系统浏览器）不同：
#   这个 App 会打开一个【独立的 Electron 窗口】，不依赖系统浏览器。
#
# 用法：bash scripts/build-electron-app.sh
#   生成到 ~/Desktop/邮箱助手 Electron.app
#
# 【不是 electron-builder 打包】
#   electron-builder 会把整个 Chromium（200MB+）打进 App，体积巨大。
#   这里生成一个"包装 App"：双击后调用项目里的 electron 二进制 + 源码。
#   好处是体积小、改代码立即生效；代价是需要保留项目目录（不能单独拷走 App）。
#   要真正可分发的独立安装包，再上 electron-builder（可选，见文末）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="邮箱助手 Electron"
APP="$HOME/Desktop/$APP_NAME.app"
NODE_BIN="$HOME/.local/bin/node"
ELECTRON_BIN="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ICON="$ROOT/electron/assets/icon.icns"

say() { printf '%s\n' "$*" >&2; }

# 前置检查
if [[ ! -x "$ELECTRON_BIN" ]]; then
  say "✗ Electron 二进制不存在：$ELECTRON_BIN"
  say "  请先运行：npm install（并确保 electron 二进制已下载）"
  exit 1
fi
if [[ ! -f "$ICON" ]]; then
  say "✗ 图标不存在：$ICON"
  exit 1
fi
# node 软链（launch.cjs 需要 node 来执行）
mkdir -p "$HOME/.local/bin"
if [[ ! -x "$NODE_BIN" ]]; then
  REAL_NODE="$(command -v node)"
  ln -s "$REAL_NODE" "$NODE_BIN"
  say "已创建 node 软链：$NODE_BIN → $REAL_NODE"
fi

say "正在生成 $APP ..."
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ICON" "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>邮箱助手</string>
  <key>CFBundleDisplayName</key><string>邮箱助手 Electron</string>
  <key>CFBundleIdentifier</key><string>local.mailagent.electron</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>用于语音输入：把你说的话转成文字，发给邮箱管家</string>
</dict>
</plist>
PLIST

# 启动脚本：调用项目的 launch.cjs（它负责清 ELECTRON_RUN_AS_NODE 并拉起 Electron）
cat > "$APP/Contents/MacOS/launch" <<LAUNCH
#!/bin/bash
# 双击 Electron 版邮箱助手：清环境 → 启动 Electron 独立窗口
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
unset ELECTRON_RUN_AS_NODE
cd "$ROOT" || exit 1
exec "$NODE_BIN" electron/launch.cjs >> "$HOME/Library/Logs/mail-agent-electron.log" 2>&1
LAUNCH
chmod +x "$APP/Contents/MacOS/launch"

codesign --force --deep --sign - "$APP" 2>/dev/null || true
touch "$APP"

say "✅ 已生成：$APP"
say "   双击即可打开独立窗口的邮箱助手"
say "   日志：~/Library/Logs/mail-agent-electron.log"
say ""
say "注意：这个 App 依赖项目目录（${ROOT}），移动/删除项目后需重新生成。"
