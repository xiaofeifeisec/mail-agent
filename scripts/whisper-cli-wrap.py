#!/usr/bin/env python3
"""
whisper-cli 包装器 —— 给本地语音识别加一个"音频格式归一化"的前置步骤。

【为什么需要它】
  前端 MediaRecorder 录的音频在 Chromium/Electron 里通常是 m4a/aac 或 webm，
  而 whisper.cpp 自带的解码器只认 flac/mp3/ogg/wav。直接把录音喂给 whisper-cli
  会失败。这个包装器先把任意音频转成 16kHz 单声道 PCM wav，再调用真正的
  whisper-cli —— 不改项目任何源码，只在配置里把 whisper 的 bin 指向本脚本即可。

【它会被放在哪】
  scripts/setup-voice.sh 会把它复制到 <项目根>/.voice-local/，
  和 whisper.cpp 的编译产物放在一起。脚本通过自身位置推算路径：

      .voice-local/whisper-cli-wrap.py     ← 本脚本
      .voice-local/whisper.cpp/build/bin/whisper-cli   ← 真正的二进制
      <项目根>                              ← ROOT

【参数】
  透传 whisper-cli 的参数，只识别并替换 -f 后面的音频路径：
    -f <audio> -oj -of <prefix> [-m <model>]
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REAL_CLI = os.path.join(HERE, "whisper.cpp", "build", "bin", "whisper-cli")


def find_ffmpeg() -> "str | None":
    """找 ffmpeg：项目内 ffmpeg-static > PATH。webm/opus 容器 afconvert 读不了，靠它兜底。
    必须实际跑通 -version 才算可用——避免损坏/被系统拦截的二进制反而误导。"""
    from shutil import which
    cands = [os.path.join(ROOT, "node_modules", "ffmpeg-static", "ffmpeg"), which("ffmpeg")]
    for cand in cands:
        if not cand or not os.path.isfile(cand) or not os.access(cand, os.X_OK):
            continue
        try:
            probe = subprocess.run([cand, "-version"], capture_output=True, timeout=5)
            if probe.returncode == 0:
                return cand
        except (OSError, subprocess.TimeoutExpired):
            continue
    return None


def transcode(audio: str, wav_path: str) -> "tuple[bool, str]":
    """把任意音频转成 16kHz 单声道 wav。先试 afconvert（macOS 自带），失败再用 ffmpeg。"""
    from shutil import which

    afconvert_err = "未找到 afconvert（非 macOS 环境）"
    if which("afconvert"):
        conv = subprocess.run(
            ["afconvert", "-f", "WAVE", "-d", "LEI16@16000", audio, wav_path],
            capture_output=True,
            text=True,
        )
        if conv.returncode == 0 and os.path.isfile(wav_path):
            return True, ""
        afconvert_err = conv.stderr.strip() or conv.stdout.strip() or "未知原因"

    # afconvert 读不了 webm/opus 等容器（或不在 macOS 上）→ ffmpeg 兜底
    ffmpeg = find_ffmpeg()
    if ffmpeg:
        conv2 = subprocess.run(
            [ffmpeg, "-y", "-i", audio, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav_path],
            capture_output=True,
            text=True,
        )
        if conv2.returncode == 0 and os.path.isfile(wav_path):
            return True, ""
        tail = conv2.stderr.strip().splitlines()
        return False, "ffmpeg 转码失败: " + (tail[-1] if tail else "未知原因")

    return False, "音频转码失败: " + afconvert_err + "（webm/opus 需安装 ffmpeg：npm i ffmpeg-static）"


def main() -> int:
    if not os.path.isfile(REAL_CLI):
        sys.stderr.write(
            "whisper-wrap: 找不到真正的 whisper-cli: " + REAL_CLI + "\n"
            "请先运行 bash scripts/setup-voice.sh 完成本地语音环境安装。\n"
        )
        return 1

    args = sys.argv[1:]
    # 找到 -f 后面的音频路径
    audio = None
    audio_idx = None
    for i, a in enumerate(args):
        if a == "-f" and i + 1 < len(args):
            audio = args[i + 1]
            audio_idx = i + 1
            break
    if audio is None or not os.path.isfile(audio):
        # 没有 -f 或文件不存在（如 --version）—— 原样透传
        return subprocess.call([REAL_CLI] + args)

    # 已是可解码格式则直接透传，省一次转码
    ext = os.path.splitext(audio)[1].lower()
    if ext in (".wav", ".mp3", ".flac", ".ogg"):
        return subprocess.call([REAL_CLI] + args)

    # 转成 16kHz 单声道 wav（whisper 原生支持）
    tmpdir = tempfile.mkdtemp(prefix="whisper-wrap-")
    wav_path = os.path.join(tmpdir, "input.wav")
    try:
        ok, err = transcode(audio, wav_path)
        if not ok:
            sys.stderr.write("whisper-wrap: " + err + "\n")
            return 1
        new_args = list(args)
        new_args[audio_idx] = wav_path
        return subprocess.call([REAL_CLI] + new_args)
    finally:
        # 中间 wav 删掉；whisper 的 -of 输出(prefix.json)在别处，不受影响
        try:
            os.remove(wav_path)
            os.rmdir(tmpdir)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
