#!/usr/bin/env python3
"""
piper 包装器 —— 修掉「一口气念完、听不懂」的问题。

【为什么要它】
  piper 的中文分句（espeak-ng 的 cmn 语音）**不认中文标点**。
  实测：「你好，我是助手。今天有三封邮件。」整段 6.36 秒中间零停顿，
  逗号和句号全被吞掉，听感就是一串没有呼吸的长音，很难听懂。
  `--sentence-silence` 也只对少数被它认作句子边界的位置生效。

【做法】
  在调用 piper 之前按标点把文本切成小段，逐段合成，再在段与段之间
  插入我们自己控制的静音：
      逗号/顿号/冒号  → 约 0.28 秒
      句号/问号/叹号  → 约 0.55 秒
  模型只加载一次（用 piper 的 Python API），所以多切几段也不会明显变慢。
  如果 Python API 不可用，自动回退到「逐段调用 piper 命令行」。

【用法】与 piper 命令行兼容，项目里只需要把 bin 指向本脚本：
    piper-wrap.py -m <model.onnx> --output_file <out.wav>   （文本走 stdin）

【可调】
  环境变量 PIPER_COMMA_PAUSE / PIPER_SENTENCE_PAUSE 改停顿时长（秒）。
"""
import argparse
import os
import sys
import tempfile
import wave

# 句末类标点：停得久一点
END_PUNCT = set("。！？!?；;…")
# 句内停顿类标点：短停
SOFT_PUNCT = set("，、：,:）)】」』")


def env_float(name: str, default: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    try:
        v = float(raw)
        return v if v >= 0 else default
    except ValueError:
        return default


COMMA_PAUSE = env_float("PIPER_COMMA_PAUSE", 0.22)
SENTENCE_PAUSE = env_float("PIPER_SENTENCE_PAUSE", 0.45)


def clean_text(text: str) -> str:
    """去掉不该朗读的符号，但保留标点（切句要用）。"""
    out = []
    for ch in text:
        if ch in "*`#|~<>{}[]\\":
            out.append(" ")
        elif ch in "\r\t":
            out.append(" ")
        else:
            out.append(ch)
    s = "".join(out)
    # 连续空白压成一个空格，但保留换行作为潜在断句点
    lines = [" ".join(l.split()) for l in s.split("\n")]
    return "\n".join(l for l in lines if l)


def split_segments(text: str):
    """按标点切成 [(片段, 该片段之后的停顿秒数), ...]。

    连续标点（如「？！。」）不会产生空片段——停顿并入前一段。
    """
    segs = []
    buf = ""
    for ch in text:
        if ch == "\n":
            if buf.strip():
                segs.append([buf.strip(), SENTENCE_PAUSE])
            buf = ""
            continue
        buf += ch
        if ch in END_PUNCT:
            if buf.strip():
                segs.append([buf.strip(), SENTENCE_PAUSE])
            buf = ""
        elif ch in SOFT_PUNCT:
            if buf.strip():
                segs.append([buf.strip(), COMMA_PAUSE])
            buf = ""
    if buf.strip():
        segs.append([buf.strip(), 0.0])

    # 标点连着标点会让某段只剩标点符号 → 并入前段停顿，避免空合成
    merged = []
    for seg, pause in segs:
        only_punct = all((c in END_PUNCT or c in SOFT_PUNCT or c.isspace()) for c in seg)
        if only_punct:
            if merged:
                merged[-1][1] += pause
            continue
        merged.append([seg, pause])
    return merged


def silence_bytes(seconds: float, sample_rate: int, width: int, channels: int) -> bytes:
    frames = int(seconds * sample_rate)
    return b"\x00" * (frames * width * channels)


# ---------------- 合成：优先 Python API（模型只加载一次） ----------------
def synth_with_api(model: str, segs, out_file: str, length_scale, speaker, normalize) -> bool:
    try:
        from piper import PiperVoice, SynthesisConfig
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("piper-wrap: Python API 不可用（%s），改用命令行模式\n" % e)
        return False

    try:
        voice = PiperVoice.load(model)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("piper-wrap: 加载模型失败（%s），改用命令行模式\n" % e)
        return False

    kwargs = {"normalize_audio": normalize}
    if length_scale is not None:
        kwargs["length_scale"] = length_scale
    if speaker is not None:
        kwargs["speaker_id"] = speaker
    syn = SynthesisConfig(**kwargs)

    pcm = bytearray()
    sample_rate = None
    width = 2
    channels = 1

    for seg, pause in segs:
        got = False
        try:
            for chunk in voice.synthesize(seg, syn):
                if sample_rate is None:
                    sample_rate = chunk.sample_rate
                    width = chunk.sample_width
                    channels = chunk.sample_channels
                data = getattr(chunk, "audio_int16_bytes", None)
                if data is None:
                    arr = getattr(chunk, "audio_int16_array", None)
                    if arr is None:
                        arr = getattr(chunk, "_audio_int16_array", None)
                    data = arr.tobytes() if arr is not None else b""
                if data:
                    pcm.extend(data)
                    got = True
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("piper-wrap: 片段合成失败（%s）\n" % e)
        if not got:
            continue
        if pause > 0 and sample_rate:
            pcm.extend(silence_bytes(pause, sample_rate, width, channels))

    if not pcm or sample_rate is None:
        sys.stderr.write("piper-wrap: 没有产出任何音频（文本可能为空）\n")
        return False

    with wave.open(out_file, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(sample_rate)
        w.writeframes(bytes(pcm))
    return True


# ---------------- 回退：逐段调用 piper 命令行 ----------------
def find_piper_cli() -> "str | None":
    from shutil import which
    cand = which("piper")
    if cand:
        return cand
    guess = os.path.expanduser("~/.local/bin/piper")
    return guess if os.path.isfile(guess) and os.access(guess, os.X_OK) else None


def synth_with_cli(segs, out_file: str, extra_args) -> bool:
    import subprocess

    cli = find_piper_cli()
    if not cli:
        sys.stderr.write("piper-wrap: 找不到 piper 可执行文件\n")
        return False

    sample_rate = None
    width = 2
    channels = 1
    pcm = bytearray()
    tmpdir = tempfile.mkdtemp(prefix="piper-wrap-")
    try:
        for idx, (seg, pause) in enumerate(segs):
            part = os.path.join(tmpdir, "part-%03d.wav" % idx)
            proc = subprocess.run(
                [cli] + list(extra_args) + ["--output_file", part],
                input=seg,
                capture_output=True,
                text=True,
            )
            if proc.returncode != 0 or not os.path.isfile(part):
                continue
            with wave.open(part, "rb") as w:
                if sample_rate is None:
                    sample_rate = w.getframerate()
                    width = w.getsampwidth()
                    channels = w.getnchannels()
                pcm.extend(w.readframes(w.getnframes()))
            if pause > 0 and sample_rate:
                pcm.extend(silence_bytes(pause, sample_rate, width, channels))
    finally:
        for f in os.listdir(tmpdir):
            try:
                os.remove(os.path.join(tmpdir, f))
            except OSError:
                pass
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass

    if not pcm or sample_rate is None:
        return False
    with wave.open(out_file, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(sample_rate)
        w.writeframes(bytes(pcm))
    return True


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("-m", "--model", required=True)
    ap.add_argument("-c", "--config")
    ap.add_argument("-f", "--output_file", "--output-file", dest="output_file", required=True)
    ap.add_argument("-i", "--input-file", "--input_file", dest="input_file")
    ap.add_argument("--length-scale", "--length_scale", dest="length_scale", type=float)
    ap.add_argument("-s", "--speaker", dest="speaker", type=int)
    ap.add_argument("--no-normalize", "--no_normalize", dest="no_normalize", action="store_true")
    # 兼容项目/piper 的其余参数，不认识的忽略
    args, unknown = ap.parse_known_args()

    if args.input_file:
        with open(args.input_file, "r", encoding="utf-8") as f:
            text = f.read()
    else:
        text = sys.stdin.read()

    text = clean_text(text)
    if not text.strip():
        sys.stderr.write("piper-wrap: 没有要朗读的文本\n")
        return 1

    segs = split_segments(text)
    if not segs:
        sys.stderr.write("piper-wrap: 切句后没有可合成内容\n")
        return 1

    normalize = not args.no_normalize

    if synth_with_api(args.model, segs, args.output_file, args.length_scale, args.speaker, normalize):
        return 0

    # 回退：命令行逐段合成。--sentence-silence 设 0，停顿完全由我们控制
    echo_args = ["-m", args.model]
    if args.config:
        echo_args += ["-c", args.config]
    if args.length_scale is not None:
        echo_args += ["--length-scale", str(args.length_scale)]
    if args.speaker is not None:
        echo_args += ["-s", str(args.speaker)]
    echo_args += ["--sentence-silence", "0"]
    if not normalize:
        echo_args += ["--no-normalize"]
    if synth_with_cli(segs, args.output_file, echo_args):
        return 0

    sys.stderr.write("piper-wrap: 合成失败\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
