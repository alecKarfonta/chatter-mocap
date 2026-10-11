"""Generate the app icon (Windows .ico, macOS .icns source PNGs).

this [2026-10-11] | INFO | make_icon | Same skeleton-joints mark as the old native app; PIL-only.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'build'

PALETTE = {
    'bg0': (18, 16, 30),
    'bg1': (38, 30, 66),
    'edge': (24, 20, 40),
    'joint': (255, 226, 122),
    'bone': (79, 210, 255),
    'lens': (61, 214, 140),
}

SIZES = [16, 32, 48, 64, 128, 256, 512, 1024]


def rounded_gradient(size: int) -> Image.Image:
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    grad = Image.new('RGBA', (size, size))
    px = grad.load()
    top, bottom = PALETTE['bg1'], PALETTE['bg0']
    for y in range(size):
        t = y / max(1, size - 1)
        row = tuple(int(top[i] * (1 - t) + bottom[i] * t) for i in range(3)) + (255,)
        for x in range(size):
            px[x, y] = row
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=size // 5, fill=255)
    img.paste(grad, (0, 0), mask)
    return img


def draw_figure(img: Image.Image) -> None:
    size = img.size[0]
    d = ImageDraw.Draw(img)
    bone = PALETTE['bone']
    joint = PALETTE['joint']
    cx = size * 0.5
    # skeleton proportions relative to canvas
    head = (cx, size * 0.20)
    chest = (cx, size * 0.42)
    hips = (cx, size * 0.62)
    lw = max(2, int(size * 0.035))
    def line(a, b):
        d.line([a, b], fill=bone, width=lw)
    line(head, chest)
    line((cx - size * 0.14, size * 0.40), (cx + size * 0.14, size * 0.40))
    line((cx - size * 0.14, size * 0.40), (cx - size * 0.26, size * 0.55))
    line((cx - size * 0.26, size * 0.55), (cx - size * 0.30, size * 0.70))
    line((cx + size * 0.14, size * 0.40), (cx + size * 0.26, size * 0.55))
    line((cx + size * 0.26, size * 0.55), (cx + size * 0.30, size * 0.70))
    line(chest, hips)
    line((cx - size * 0.08, size * 0.62), (cx - size * 0.09, size * 0.86))
    line((cx + size * 0.08, size * 0.62), (cx + size * 0.09, size * 0.86))
    def dot(p, r):
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=joint)
    jr = max(2, int(size * 0.028))
    for p in (head, chest, hips):
        dot(p, jr)
    # camera lens bottom-right
    lens_r = size * 0.16
    lx, ly = size * 0.76, size * 0.78
    d.ellipse([lx - lens_r, ly - lens_r, lx + lens_r, ly + lens_r], fill=PALETTE['edge'], outline=PALETTE['lens'], width=max(2, int(size * 0.02)))
    d.ellipse([lx - lens_r * 0.45, ly - lens_r * 0.45, lx + lens_r * 0.45, ly + lens_r * 0.45], fill=PALETTE['lens'])


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    pngs = {}
    for size in SIZES:
        img = rounded_gradient(size)
        if size >= 48:
            draw_figure(img)
        pngs[size] = img
        img.save(OUT / f'icon_{size}.png')
    # Windows .ico bundles several sizes
    pngs[256].save(
        OUT / 'icon.ico',
        sizes=[(s, s) for s in (16, 32, 48, 64, 128, 256)],
        append_images=[pngs[s] for s in (16, 32, 48, 64, 128)],
    )
    print(f'icons written to {OUT}')


if __name__ == '__main__':
    main()
