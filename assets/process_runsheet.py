#!/usr/bin/env python3
"""Slice a green-screen run-cycle sheet (N frames in a row) into a clean, aligned
transparent sprite strip for the game's SHEET hook.

Each frame is chroma-keyed, reduced to its largest blob, despilled, then placed on a
common cell: centered horizontally by the character's CENTROID (so the body stays put
while the legs swing) and bottom-aligned (feet on a shared baseline).

Usage: process_runsheet.py <in_sheet.png> <out_strip.png> [n_frames] [cell_max]
"""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage


def key_frame(sub):
    """sub: HxWx4 int16 → (rgba uint8 with alpha, bbox, centroid_x) or None."""
    r, g, b = sub[..., 0], sub[..., 1], sub[..., 2]
    fg = ~((g > 80) & (g > r + 25) & (g > b + 25))      # chroma key (green out)
    lbl, k = ndimage.label(fg)
    if k > 1:                                            # keep the biggest blob only
        sizes = ndimage.sum(np.ones_like(lbl), lbl, range(1, k + 1))
        fg = lbl == (int(np.argmax(sizes)) + 1)
    alpha = np.where(fg, 255, 0).astype(np.uint8)
    out = sub.astype(np.uint8)
    cap = ((r + b) // 2).astype(np.int16)                # despill green fringe
    spill = fg & (g > cap + 8)
    out[..., 1] = np.where(spill, np.clip(cap, 0, 255), sub[..., 1]).astype(np.uint8)
    out[..., 3] = alpha
    ys, xs = np.where(alpha > 0)
    if len(xs) == 0:
        return None
    return out, (xs.min(), xs.max() + 1, ys.min(), ys.max() + 1), float(xs.mean())


def main(inp, outp, n=4, cell_max=320, pad=16):
    im = Image.open(inp).convert("RGBA")
    A = np.asarray(im).astype(np.int16)
    H, W = A.shape[:2]
    cw = W // n
    frames = []
    for i in range(n):
        f = key_frame(A[:, i * cw:(i + 1) * cw].copy())
        if f:
            frames.append(f)
    # common cell: big enough for the widest/tallest frame + the centroid offset slack
    maxw = max(b[1] - b[0] for _, b, _ in frames)
    maxh = max(b[3] - b[2] for _, b, _ in frames)
    CW, CH = maxw + pad * 2 + 40, maxh + pad * 2
    cells = []
    for img, (x0, x1, y0, y1), cx in frames:
        crop = Image.fromarray(img[y0:y1, x0:x1], "RGBA")
        cell = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
        dst_x = int(round(CW / 2 - (cx - x0)))           # centroid → cell centre
        dst_y = CH - pad - (y1 - y0)                     # feet → shared baseline
        cell.paste(crop, (dst_x, dst_y), crop)
        cells.append(cell)
    # downscale cells so the strip is game-sized (preserve aspect)
    scale = min(1.0, cell_max / max(CW, CH))
    if scale < 1.0:
        CW, CH = round(CW * scale), round(CH * scale)
        cells = [c.resize((CW, CH), Image.LANCZOS) for c in cells]
    strip = Image.new("RGBA", (CW * len(cells), CH), (0, 0, 0, 0))
    for i, c in enumerate(cells):
        strip.paste(c, (i * CW, 0), c)
    strip.save(outp)
    print(f"{outp}  {strip.width}x{strip.height}  ({len(cells)} frames, cell {CW}x{CH})")


if __name__ == "__main__":
    inp, outp = sys.argv[1], sys.argv[2]
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    cm = int(sys.argv[4]) if len(sys.argv) > 4 else 320
    main(inp, outp, n, cm)
