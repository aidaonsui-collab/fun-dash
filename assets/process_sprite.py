#!/usr/bin/env python3
"""Turn a green-screen mascot render into a clean trimmed transparent game sprite.
Usage: process_sprite.py <in.png> <out.png> [max_size]
"""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

def main(inp, outp, max_size=340):
    im = Image.open(inp).convert("RGBA")
    a = np.asarray(im).astype(np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]

    # --- chroma key: green-dominant pixels become background ---
    is_green = (g > 80) & (g > r + 25) & (g > b + 25)
    fg = ~is_green

    # keep only the largest connected foreground blob (drops stray sparkles/specks)
    lbl, n = ndimage.label(fg)
    if n > 1:
        sizes = ndimage.sum(np.ones_like(lbl), lbl, range(1, n + 1))
        keep = (np.argmax(sizes) + 1)
        fg = lbl == keep

    out = a.copy().astype(np.uint8)
    alpha = np.where(fg, 255, 0).astype(np.uint8)

    # --- despill: pull down green fringe on anti-aliased edges ---
    rr, bb = a[..., 0], a[..., 2]
    cap = ((rr + bb) // 2).astype(np.int16)
    spill = fg & (g > cap + 8)
    out[..., 1] = np.where(spill, np.clip(cap, 0, 255), a[..., 1]).astype(np.uint8)
    out[..., 3] = alpha

    res = Image.fromarray(out, "RGBA")

    # --- trim to content bounding box ---
    ys, xs = np.where(alpha > 0)
    if len(xs):
        pad = 6
        x0, x1 = max(0, xs.min() - pad), min(res.width, xs.max() + pad)
        y0, y1 = max(0, ys.min() - pad), min(res.height, ys.max() + pad)
        res = res.crop((x0, y0, x1, y1))

    # --- downscale to game size (preserve aspect) ---
    if max(res.size) > max_size:
        s = max_size / max(res.size)
        res = res.resize((round(res.width * s), round(res.height * s)), Image.LANCZOS)

    res.save(outp)
    print(f"{outp}  {res.width}x{res.height}")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 340)
