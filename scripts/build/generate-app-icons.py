"""Generate deterministic raster assets from the checked-in Easy Rewind SVG design.

Requires Pillow. The generated files are release inputs, so this script avoids
network fonts, machine metadata, and non-deterministic image generators.
"""

from pathlib import Path

from PIL import Image, ImageDraw


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DESKTOP_ASSETS = REPOSITORY_ROOT / "desktop" / "assets"
MOBILE_ASSETS = REPOSITORY_ROOT / "mobile" / "assets"
CANVAS = 1024


def gradient_icon(*, transparent: bool = False) -> Image.Image:
    image = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    if not transparent:
        top = (124, 58, 237)
        bottom = (236, 72, 153)
        for y in range(CANVAS):
            position = y / (CANVAS - 1)
            color = tuple(round(start + (end - start) * position) for start, end in zip(top, bottom))
            draw.line((0, y, CANVAS, y), fill=(*color, 255))
        mask = Image.new("L", (CANVAS, CANVAS), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, CANVAS - 1, CANVAS - 1), radius=240, fill=255)
        image.putalpha(mask)

    scale = CANVAS / 64
    white = (255, 255, 255, 255)
    muted = (255, 255, 255, 154)
    width = round(2.5 * scale)
    points = [(20 * scale, 44 * scale), (20 * scale, 22 * scale), (32 * scale, 14 * scale),
              (44 * scale, 22 * scale), (44 * scale, 44 * scale), (20 * scale, 44 * scale)]
    draw.line(points, fill=white, width=width, joint="curve")
    draw.line(
        [(28 * scale, 30 * scale), (30.5 * scale, 32.5 * scale), (36 * scale, 27 * scale)],
        fill=white,
        width=width,
        joint="curve",
    )
    draw.line(
        [(24 * scale, 50 * scale), (40 * scale, 50 * scale)],
        fill=muted,
        width=round(2 * scale),
    )
    return image


def notification_icon() -> Image.Image:
    image = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    scale = 96 / 64
    points = [(20 * scale, 44 * scale), (20 * scale, 22 * scale), (32 * scale, 14 * scale),
              (44 * scale, 22 * scale), (44 * scale, 44 * scale), (20 * scale, 44 * scale)]
    draw.line(points, fill="white", width=5, joint="curve")
    draw.line(
        [(28 * scale, 30 * scale), (30.5 * scale, 32.5 * scale), (36 * scale, 27 * scale)],
        fill="white",
        width=5,
        joint="curve",
    )
    return image


def save() -> None:
    DESKTOP_ASSETS.mkdir(parents=True, exist_ok=True)
    MOBILE_ASSETS.mkdir(parents=True, exist_ok=True)
    icon = gradient_icon()
    foreground = gradient_icon(transparent=True)

    icon.save(DESKTOP_ASSETS / "icon.png", optimize=True)
    icon.resize((64, 64), Image.Resampling.LANCZOS).save(
        DESKTOP_ASSETS / "tray-icon.png", optimize=True
    )
    icon.save(
        DESKTOP_ASSETS / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    icon.save(MOBILE_ASSETS / "icon.png", optimize=True)
    foreground.save(MOBILE_ASSETS / "adaptive-icon.png", optimize=True)
    notification_icon().save(MOBILE_ASSETS / "notification-icon.png", optimize=True)


if __name__ == "__main__":
    save()
