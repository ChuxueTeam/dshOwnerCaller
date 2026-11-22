"""Render docs/preview.png — the README illustration for dsh-caller.

Pure Pillow: a light DSH-ish background with the call card floating in it.
No screenshot involved, so the image stays stable even if the UI changes.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1280, 566
BG = (238, 241, 245)
SIDEBAR = (227, 232, 239)
SIDEBAR_INK = (196, 203, 214)
CARD = (255, 255, 255)
INK = (26, 27, 32)
SUB = (110, 115, 127)
ACCENT = (77, 107, 254)

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "preview.png"
FONTS = Path("C:/Windows/Fonts")


def load(names: list[str], size: int) -> ImageFont.FreeTypeFont:
    for name in names:
        path = FONTS / name
        if path.exists():
            try:
                return ImageFont.truetype(str(path), size)
            except OSError:
                continue
    return ImageFont.load_default()


def regular(size: int) -> ImageFont.FreeTypeFont:
    return load(["msyh.ttc", "msyh.ttf", "simhei.ttf", "arial.ttf"], size)


def bold(size: int) -> ImageFont.FreeTypeFont:
    return load(["msyhbd.ttc", "msyhbd.ttf", "simhei.ttf", "arialbd.ttf"], size)


def centered(draw: ImageDraw.ImageDraw, box: tuple[float, float, float, float], text: str, font, fill) -> None:
    left, top, right, bottom = box
    l, t, r, b = draw.textbbox((0, 0), text, font=font)
    draw.text((left + (right - left - (r - l)) / 2 - l, top + (bottom - top - (b - t)) / 2 - t), text, font=font, fill=fill)


def draw_bell(draw: ImageDraw.ImageDraw, x: float, y: float, size: float, color) -> None:
    """A small vector bell, so no emoji font is required."""
    s = size / 32.0
    draw.pieslice([x + 6 * s, y + 3 * s, x + 26 * s, y + 23 * s], 180, 360, fill=color)
    draw.rectangle([x + 6 * s, y + 13 * s, x + 26 * s, y + 21 * s], fill=color)
    draw.rounded_rectangle([x + 4 * s, y + 20 * s, x + 28 * s, y + 23 * s], 1.5 * s, fill=color)
    draw.ellipse([x + 12.5 * s, y + 25 * s, x + 19.5 * s, y + 32 * s], fill=color)


def main() -> None:
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    # 背景里给一点 DSH 界面的暗示：左侧栏 + 几条消息占位
    draw.rectangle([0, 0, 236, H], fill=SIDEBAR)
    draw.rounded_rectangle([22, 26, 34, 38], 3, fill=SIDEBAR_INK)
    draw.rounded_rectangle([46, 28, 128, 36], 4, fill=SIDEBAR_INK)
    for index in range(5):
        top = 84 + index * 52
        draw.rounded_rectangle([22, top, 214, top + 34], 10, fill=(241, 244, 248))
    draw.rounded_rectangle([300, 40, 700, 58], 9, fill=(226, 231, 238))

    # 卡片 + 投影
    cw, ch = 760, 246
    cx0, cy0 = (W + 236) / 2 - cw / 2, 176
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [cx0 + 2, cy0 + 14, cx0 + cw - 2, cy0 + ch + 12], 24, fill=(15, 23, 42, 92)
    )
    img = Image.alpha_composite(img.convert("RGBA"), shadow.filter(ImageFilter.GaussianBlur(20))).convert("RGB")
    draw = ImageDraw.Draw(img)

    draw.rounded_rectangle([cx0, cy0, cx0 + cw, cy0 + ch], 24, fill=CARD, outline=(228, 232, 240), width=2)

    # 图标
    icon_x, icon_y, icon = cx0 + 30, cy0 + 32, 54
    draw.rounded_rectangle([icon_x, icon_y, icon_x + icon, icon_y + icon], 15, fill=ACCENT)
    draw_bell(draw, icon_x + 11, icon_y + 11, 32, (255, 255, 255))

    # 文案
    text_x = icon_x + icon + 20
    draw.text((text_x, cy0 + 34), "呼叫", font=regular(19), fill=SUB)
    draw.text((text_x, cy0 + 66), "主人，哦鲸鲸找你", font=bold(38), fill=INK)

    # 按钮
    bx1, by1 = cx0 + cw - 30, cy0 + ch - 30
    bx0, by0 = bx1 - 116, by1 - 46
    draw.rounded_rectangle([bx0, by0, bx1, by1], 12, fill=ACCENT)
    centered(draw, (bx0, by0, bx1, by1), "知道啦", regular(20), (255, 255, 255))

    # 卡片底部的循环进度条
    draw.rounded_rectangle([cx0, cy0 + ch - 4, cx0 + cw * 0.62, cy0 + ch], 2, fill=ACCENT)
    draw.rounded_rectangle([cx0 + cw * 0.62, cy0 + ch - 4, cx0 + cw, cy0 + ch], 2, fill=(232, 236, 244))

    # 图注
    draw.text((cx0, cy0 + ch + 34), "提示音会一直响，直到你亲手点掉「知道啦」", font=regular(22), fill=SUB)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    print(f"{OUT} — {img.width}x{img.height}, {OUT.stat().st_size / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
