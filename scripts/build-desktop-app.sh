#!/usr/bin/env bash
# build-desktop-app.sh —— 在桌面生成「邮箱助手.app」快捷方式。
#
# 用法：
#   ./scripts/build-desktop-app.sh            # 生成到 ~/Desktop/邮箱助手.app
#   ./scripts/build-desktop-app.sh --stop     # 顺带停掉正在跑的服务
#
# 【为什么需要它】
# 浏览器访问 127.0.0.1:5173 需要后端服务在跑。
# 手动敲 npm run web 麻烦，所以做成双击即用的 .app：
#   已在跑 → 直接开浏览器
#   没在跑 → 后台拉起来 → 等就绪 → 开浏览器
#
# 【可重复生成】
# 路径变了（项目搬家 / node 换版本）改脚本顶部的常量再跑一次即可。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ======================== 需要你按本机情况改的地方 ========================
APP_NAME="邮箱助手"
DESKTOP="$HOME/Desktop"
APP="$DESKTOP/$APP_NAME.app"
URL="http://127.0.0.1:5173/"
LOG_DIR="$HOME/Library/Logs/mail-agent-webui"
LOG="$LOG_DIR/server.log"
NODE_BIN="$HOME/.local/bin/node"          # 稳定的 node 软链
# =======================================================================

say() { printf '%s\n' "$*" >&2; }

# ---------- 生成图标 ----------
ICON_DIR="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICON_DIR"
ICON_SRC="$(mktemp -d)/icon1024.png"

if command -v python3 >/dev/null 2>&1; then
  python3 "$ROOT/scripts/make-icon.py" "$ICON_SRC" >/dev/null 2>&1 || true
fi

if [[ -s "$ICON_SRC" ]]; then
  # iconutil 要求这些尺寸齐备
  for spec in "16:icon_16x16" "32:icon_16x16@2x" "32:icon_32x32" "64:icon_32x32@2x" \
              "128:icon_128x128" "256:icon_128x128@2x" "256:icon_256x256" \
              "512:icon_256x256@2x" "512:icon_512x512" "1024:icon_512x512@2x"; do
    px="${spec%%:*}"; name="${spec##*:}"
    sips -z "$px" "$px" "$ICON_SRC" --out "$ICON_DIR/$name.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "$ICON_DIR" -o "$ICON_SRC.icns" 2>/dev/null || true
fi

# ---------- 写 app bundle ----------
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

if [[ -s "$ICON_SRC.icns" ]]; then
  cp "$ICON_SRC.icns" "$APP/Contents/Resources/AppIcon.icns"
fi

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>邮箱助手</string>
  <key>CFBundleDisplayName</key><string>邮箱助手</string>
  <key>CFBundleIdentifier</key><string>local.mailagent.webui</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# ---------- 启动脚本 ----------
# 用【占位符替换】而不是在 heredoc 里插变量 ——
# 否则 \$ 这种转义很容易漏（漏一个就在 set -u 下直接崩）。
cat > "$APP/Contents/MacOS/launch" <<'LAUNCH'
#!/bin/bash
# 双击「邮箱助手」：服务没在跑就启动它，然后打开 Web UI。
#
# 【和 Claude网关.app 的区别】
# 这个服务会连你的真实邮箱 + 调模型，所以启动时：
#   - 必须绕过本机 HTTP 代理（否则请求 127.0.0.1 会被代理拦成 502）
#   - 必须用绝对路径的 node（从 Dock 启动的 app 不继承 shell 的 PATH）
DIR="@@DIR@@"
URL="@@URL@@"
LOG_DIR="@@LOG_DIR@@"
LOG="@@LOG@@"
NODE_BIN="@@NODE_BIN@@"

probe() { /usr/bin/curl --noproxy '*' -s -o /dev/null -m 2 "$URL"; }

# 已在运行：直接打开页面
if probe; then
  /usr/bin/open "$URL"
  exit 0
fi

if [[ ! -d "$DIR" ]]; then
  /usr/bin/osascript -e "display alert \"邮箱助手启动失败\" message \"找不到程序目录：$DIR 已被移动或删除。请重新运行 scripts/build-desktop-app.sh。\" as critical" >/dev/null 2>&1
  exit 1
fi

if [[ ! -x "$NODE_BIN" ]]; then
  /usr/bin/osascript -e "display alert \"邮箱助手启动失败\" message \"找不到 node：$NODE_BIN\" as critical" >/dev/null 2>&1
  exit 1
fi

mkdir -p "$LOG_DIR"
# 日志超过 2MB 滚动一次
if [[ -f "$LOG" ]] && [[ $(/usr/bin/stat -f%z "$LOG") -gt 2097152 ]]; then
  /bin/mv -f "$LOG" "$LOG.1"
fi

cd "$DIR" || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# 【关键】本机有 HTTP_PROXY，不绕过的话 curl/浏览器请求本机会被代理拦掉
export NO_PROXY='*'
export no_proxy='*'

nohup "$NODE_BIN" "$DIR/node_modules/tsx/dist/cli.mjs" src/web/server.ts >> "$LOG" 2>&1 &

# 最多等 25 秒
for i in $(seq 1 50); do
  sleep 0.5
  if probe; then break; fi
done

if probe; then
  /usr/bin/open "$URL"
  exit 0
fi

/usr/bin/osascript -e "display alert \"邮箱助手启动失败\" message \"服务未能在 25 秒内就绪。日志：$LOG\" as critical" >/dev/null 2>&1
exit 1
LAUNCH

# 占位符 → 真实值（用 | 做分隔符，路径里不会有）
/usr/bin/sed -i '' \
  -e "s|@@DIR@@|$ROOT|g" \
  -e "s|@@URL@@|$URL|g" \
  -e "s|@@LOG_DIR@@|$LOG_DIR|g" \
  -e "s|@@LOG@@|$LOG|g" \
  -e "s|@@NODE_BIN@@|$NODE_BIN|g" \
  "$APP/Contents/MacOS/launch"

chmod +x "$APP/Contents/MacOS/launch"

# ad-hoc 签名（否则 macOS Gatekeeper 会拦）
codesign --force --deep --sign - "$APP" 2>/dev/null || true

# 刷新 LaunchServices，让图标立刻出现在桌面
touch "$APP"

say "✅ 已生成：$APP"
say "   双击即可 —— 服务没在跑会自动拉起来，然后打开 $URL"
say "   日志：$LOG"

# 可选：顺手停掉正在跑的服务
if [[ "${1:-}" == "--stop" ]]; then
  pkill -f "tsx.*src/web/server.ts" 2>/dev/null || true
  say "   （已停止正在运行的服务）"
fi
