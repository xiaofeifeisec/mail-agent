#!/usr/bin/env bash
# build.sh —— 编译 shim 并把语音识别部分打成 macOS .app bundle。
#
# 用法: ./voice/build.sh
#
# 【两个必须解决的 macOS 问题】
#
#  1. SDK 与编译器版本不匹配
#     /usr/bin/swift 默认挑最新的 SDK（如 MacOSX26.2），但本机编译器可能比它老，
#     直接 swift foo.swift 会报：
#       "this SDK is not supported by the compiler
#        (the SDK is built with 'Apple Swift version 6.2' while this compiler is
#        'Apple Swift version 6.1.2')"
#     解决：探测可用 SDK —— 先试编译器默认，不行就显式指定旧 SDK，从新到旧逐个试。
#
#  2. TCC 隐私授权
#     macOS 要求访问麦克风/语音识别的进程在 Info.plist 里声明用途。命令行二进制
#     没有 Info.plist，跑起来会被系统 SIGABRT（崩溃报告：attempted to access
#     privacy-sensitive data without a usage description）。
#     解决：语音识别部分打成 .app bundle + Info.plist + ad-hoc 签名，由宿主通过
#     LaunchServices (`open -a`) 启动。录音部分不需要 bundle（麦克风授权归宿主
#     进程），保持普通命令行二进制。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIMS="$ROOT/shims"
BUILD="$ROOT/build"
SDKROOT="/Library/Developer/CommandLineTools/SDKs"

say() { printf '%s\n' "$*" >&2; }

if [ "$(uname -s)" != "Darwin" ]; then
  say "✗ 这些 shim 只适用于 macOS"
  exit 1
fi

# ---- 探测可用 SDK --------------------------------------------------------
pick_sdk() {
  local probe; probe="$(mktemp -d)/probe.swift"
  printf 'import Foundation\nprint("ok")\n' > "$probe"

  # 先试编译器默认 SDK —— 通常这是最匹配的组合。
  if (cd "$(dirname "$probe")" && swift "$probe" >/dev/null 2>&1); then
    rm -rf "$(dirname "$probe")"
    echo ""
    return 0
  fi

  # 退而求其次：显式指定 SDK，从新到旧逐个试。
  local sdk
  local candidates=()
  if [ -d "$SDKROOT" ]; then
    while IFS= read -r d; do
      candidates+=("$SDKROOT/$d")
    done < <(ls -1 "$SDKROOT" | grep -E '^MacOSX[0-9.]*\.sdk$' | sort -V)
  fi
  for (( i=${#candidates[@]}-1; i>=0; i-- )); do
    sdk="${candidates[$i]}"
    if (cd "$(dirname "$probe")" && swift -sdk "$sdk" "$probe" >/dev/null 2>&1); then
      rm -rf "$(dirname "$probe")"
      echo "$sdk"
      return 0
    fi
  done

  rm -rf "$(dirname "$probe")"
  echo ""
}

SDK="$(pick_sdk)"
if [ -z "$SDK" ]; then
  say "✗ 找不到可用的 Swift SDK —— 请先安装 Xcode Command Line Tools：xcode-select --install"
  exit 1
fi
say "使用 SDK: ${SDK:-（编译器默认）}"

mkdir -p "$BUILD"

# ---- 录音 shim：普通命令行二进制 ----------------------------------------
say "编译 macos-record …"
swiftc -sdk "$SDK" -O \
  "$SHIMS/macos-record.swift" \
  -o "$BUILD/macos-record"

# ---- 语音识别 shim：打成 .app bundle -------------------------------------
say "编译 macos-stt 并打包 bundle …"
APP="$BUILD/VoiceSTT.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -sdk "$SDK" -O \
  "$SHIMS/macos-stt.swift" \
  -o "$APP/Contents/MacOS/VoiceSTT"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key><string>local.workbuddy.voice.stt</string>
	<key>CFBundleName</key><string>VoiceSTT</string>
	<key>CFBundleExecutable</key><string>VoiceSTT</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
	<key>LSUIElement</key><true/>
	<key>NSSpeechRecognitionUsageDescription</key><string>将录音转换为文本。</string>
	<key>NSMicrophoneUsageDescription</key><string>从麦克风录制音频。</string>
</dict>
</plist>
PLIST

# ad-hoc 签名：未签名的 bundle 会被 Gatekeeper 拦下。
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

say "✓ 构建完成"
say "  录音:   $BUILD/macos-record"
say "  识别:   $APP"
say ""
say "首次使用语音识别时，系统会弹「语音识别」授权框，需要允许一次。"
