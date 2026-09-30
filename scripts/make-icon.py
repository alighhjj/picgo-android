#!/usr/bin/env python3
"""生成应用图标源图（1024×1024 的 app-icon.png）。

为什么要脚本化：图标文件必须真实存在，否则 tauri 的 generate_context! 直接编译失败。
把生成过程留下来，改配色/形状就能重跑，而不是留一个来路不明的二进制。

依赖只有 Pillow（本机已有）。用法：
    python scripts/make-icon.py
    npx tauri icon app-icon.png     # 再生成各平台全套图标
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 1024
SUPERSAMPLE = 4  # 先按 4 倍画再缩，边缘才不会有锯齿

TOP = (47, 111, 235)
BOTTOM = (22, 72, 176)
WHITE = (255, 255, 255, 255)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def gradient(size: int) -> Image.Image:
    image = Image.new("RGB", (1, size))
    pixels = image.load()
    for y in range(size):
        ratio = y / (size - 1)
        pixels[0, y] = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * ratio) for i in range(3))
    return image.resize((size, size))


def main() -> None:
    size = SIZE * SUPERSAMPLE
    scale = size / SIZE

    canvas = gradient(size).convert("RGBA")
    canvas.putalpha(rounded_mask(size, round(220 * scale)))

    # 前景：上传箭头 + 底部托盘，缩到 48px 也要能一眼认出来
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    stem = (472 * scale, 400 * scale, 552 * scale, 700 * scale)
    draw.rounded_rectangle(stem, radius=24 * scale, fill=WHITE)

    head = [(512 * scale, 286 * scale), (330 * scale, 476 * scale), (694 * scale, 476 * scale)]
    draw.polygon(head, fill=WHITE)

    tray = (288 * scale, 712 * scale, 736 * scale, 764 * scale)
    draw.rounded_rectangle(tray, radius=26 * scale, fill=WHITE)

    canvas.alpha_composite(layer)
    icon = canvas.resize((SIZE, SIZE), Image.LANCZOS)

    target = Path(__file__).resolve().parent.parent / "app-icon.png"
    icon.save(target, "PNG", optimize=True)
    print(f"已生成 {target}")


if __name__ == "__main__":
    main()
