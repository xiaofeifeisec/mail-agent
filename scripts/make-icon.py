#!/usr/bin/env python3
"""
生成「邮箱助手」App 图标，输出 1024x1024 PNG。

优先使用项目里的品牌图 web/logo-1024.png（机器人+信封+@ 图标，白底），
这样 App 图标和网页 logo 保持一致。若品牌图缺失，再回退到手画的信封图标。

用法：python3 scripts/make-icon.py <输出png路径>
"""

import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BRAND = os.path.join(ROOT, 'web', 'logo-1024.png')


def try_brand(out: str) -> bool:
    """把品牌图直接作为图标输出。返回是否成功。"""
    if not os.path.isfile(BRAND):
        return False
    try:
        from PIL import Image  # 环境有 Pillow 时走这条，最省事
        im = Image.open(BRAND).convert('RGB')
        if im.size != (1024, 1024):
            im = im.resize((1024, 1024), Image.LANCZOS)
        im.save(out, 'PNG')
        return True
    except Exception:
        pass
    # 没有 Pillow：品牌图本身就是 1024 PNG，直接字节复制
    try:
        with open(BRAND, 'rb') as f:
            data = f.read()
        if data[:8] == b'\x89PNG\r\n\x1a\n':
            with open(out, 'wb') as f:
                f.write(data)
            return True
    except Exception:
        pass
    return False


# ---- 以下为手画信封 fallback（原逻辑）----
S = 1024
BG_TOP = (37, 99, 235)
BG_BOT = (29, 78, 216)
ENV = (255, 255, 255)
ENV_SHADE = (203, 213, 225)
ACCENT = (244, 63, 94)


def rounded_rect_alpha(x, y, w, h, r):
    x0, y0, x1, y1 = 0.0, 0.0, w, h
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
    edge = 1.0 if (x0 + r <= x <= x1 - r) or (y0 + r <= y <= y1 - r) else 0.0
    inside = 1.0 if edge or d <= r else 0.0
    return min(1.0, max(0.0, (r - d) + 0.5)) if not edge else inside


def blend(dst, src, a):
    return tuple(int(round(d * (1 - a) + s * a)) for d, s in zip(dst, src))


def draw_fallback(out):
    ex0, ey0, ex1, ey1, er = 190.0, 320.0, 834.0, 700.0, 26.0
    rows = bytearray()
    for py in range(S):
        rows.append(0)
        for px in range(S):
            x, y = px + 0.5, py + 0.5
            t = y / S
            bg = (
                int(BG_TOP[0] * (1 - t) + BG_BOT[0] * t),
                int(BG_TOP[1] * (1 - t) + BG_BOT[1] * t),
                int(BG_TOP[2] * (1 - t) + BG_BOT[2] * t),
            )
            hl = max(0.0, 1.0 - (y / 260.0) ** 2) * 0.10
            bg = blend(bg, (255, 255, 255), hl)
            if ex0 <= x <= ex1 and ey0 <= y <= ey1:
                cx = min(max(x, ex0 + er), ex1 - er)
                cy = min(max(y, ey0 + er), ey1 - er)
                d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
                if d <= er + 0.5:
                    mid_x = (ex0 + ex1) / 2
                    mid_y = ey0 + (ey1 - ey0) * 0.56
                    if x < mid_x:
                        k = (x - ex0) / (mid_x - ex0)
                        line_y = ey0 + k * (mid_y - ey0)
                    else:
                        k = (ex1 - x) / (ex1 - mid_x)
                        line_y = ey0 + k * (mid_y - ey0)
                    px_col = ENV_SHADE if (abs(y - line_y) <= 11 and y <= mid_y + 12) else ENV
                else:
                    px_col = bg
            else:
                px_col = bg
            ax, ay, ar = 762.0, 268.0, 74.0
            dd = ((x - ax) ** 2 + (y - ay) ** 2) ** 0.5
            if dd <= ar + 0.5:
                px_col = ACCENT
            elif dd <= ar + 5 and dd > ar:
                px_col = blend(px_col, ACCENT, (ar + 5 - dd) / 5)
            rows.extend(px_col)
    raw = bytes(rows)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(out, "wb") as f:
        f.write(png)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "icon.png"
    if try_brand(out):
        print(f"icon written from brand logo: {out}")
    else:
        draw_fallback(out)
        print(f"icon written (fallback envelope): {out}")


if __name__ == "__main__":
    main()
