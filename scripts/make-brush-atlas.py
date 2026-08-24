#!/usr/bin/env python3
"""Build a tileable hand-painted brush atlas from the statue albedo.

The masonry reads as machined next to the statues, and the reason is that the
statues carry a painted albedo baked off a real sculpt — broad brush planes,
mineral variation, grime settled in the crevices — while the bricks sample a
fine-grain stone image that reads as noise.

Rather than invent a matching texture, take it from the statues directly, so
the bricks are literally painted with the same hand. Four crops become a 2x2
atlas; the material picks a tile per instance, which is where the variation
comes from.

    python3 scripts/make-brush-atlas.py \
        --input /tmp/oracle-albedo.jpg \
        --output public/assets/textures/hand-painted-brush-1024.webp
"""

from __future__ import annotations

import argparse
import numpy as np
from PIL import Image, ImageFilter


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--tile", type=int, default=256, help="tile edge")
    parser.add_argument("--grid", type=int, default=4, help="atlas is grid x grid tiles")
    parser.add_argument("--feather", type=int, default=24, help="seam blend width in pixels")
    parser.add_argument("--contrast", type=float, default=0.11,
                        help="target luma standard deviation; 0.024 reads as noise, 0.32 as camouflage")
    parser.add_argument("--blur", type=float, default=18.0,
                        help="high-pass radius; larger keeps more of the sculpture's form")
    return parser.parse_args()


def interesting_crops(image: Image.Image, tile: int, count: int) -> list[Image.Image]:
    """Pick regions with real painted structure.

    A baked albedo has large dead areas — UV gutter, the flat underside, deep
    shadow — that would make a lifeless tile. Score candidates by local contrast
    and reject the too-dark ones, then spread the picks out so the four tiles do
    not all come from the same patch of the model.
    """
    gray = np.asarray(image.convert("L")).astype(float) / 255.0
    height, width = gray.shape
    stride = max(tile // 4, 16)

    # Thresholds come from this image's own distribution. A baked statue albedo
    # is dark — the oracle's mean luma is 0.169 — so a hardcoded "at least 0.22"
    # rejects every window and the atlas comes out black. Percentiles adapt to
    # whatever source is handed in.
    lo, hi = np.percentile(gray, [35, 99])
    scored: list[tuple[float, int, int]] = []
    for y in range(0, height - tile + 1, stride):
        for x in range(0, width - tile + 1, stride):
            patch = gray[y:y + tile, x:x + tile]
            mean = patch.mean()
            if mean < lo or mean > hi:
                continue  # gutter, black shadow, or blown highlight
            # Standard deviation alone favours hard edges; add gradient energy
            # so broad painterly modulation scores above flat-with-one-line.
            gy, gx = np.gradient(patch)
            score = patch.std() * 0.6 + float(np.abs(gx).mean() + np.abs(gy).mean()) * 0.4
            scored.append((score, x, y))

    scored.sort(reverse=True)
    picks: list[tuple[int, int]] = []
    for _, x, y in scored:
        if all(abs(x - px) >= tile // 2 or abs(y - py) >= tile // 2 for px, py in picks):
            picks.append((x, y))
        if len(picks) == count:
            break
    # Relax the spacing rule rather than returning fewer tiles: an atlas short
    # of tiles is an atlas with black squares in it.
    index = 0
    while len(picks) < count and scored:
        picks.append((scored[index % len(scored)][1], scored[index % len(scored)][2]))
        index += 1
    if not picks:
        raise SystemExit("no usable crops — check the source image")
    return [image.crop((x, y, x + tile, y + tile)) for x, y in picks]


def make_seamless(tile: Image.Image, feather: int) -> Image.Image:
    """Offset by half, then blend the cross-seam with a feathered mirror.

    Standard offset-and-heal. Without it the atlas repeats with a visible grid,
    which on masonry reads as a manufacturing defect rather than stone.
    """
    size = tile.size[0]
    arr = np.asarray(tile.convert("RGB")).astype(float)
    rolled = np.roll(np.roll(arr, size // 2, axis=0), size // 2, axis=1)

    blended = rolled.copy()
    ramp = np.linspace(0.0, 1.0, feather)[:, None, None]
    mid = size // 2

    # Horizontal seam: blend rows around the middle with the mirrored rows.
    top = rolled[mid - feather:mid]
    bottom = rolled[mid:mid + feather]
    blended[mid - feather:mid] = top * (1 - ramp) + bottom[::-1] * ramp
    blended[mid:mid + feather] = bottom * ramp[::-1] + top[::-1] * (1 - ramp[::-1])

    # Vertical seam, same treatment on columns.
    ramp_v = ramp.transpose(1, 0, 2)
    left = blended[:, mid - feather:mid]
    right = blended[:, mid:mid + feather]
    blended[:, mid - feather:mid] = left * (1 - ramp_v) + right[:, ::-1] * ramp_v
    blended[:, mid:mid + feather] = right * ramp_v[:, ::-1] + left[:, ::-1] * (1 - ramp_v[:, ::-1])

    out = Image.fromarray(np.clip(blended, 0, 255).astype(np.uint8))
    return out.filter(ImageFilter.SMOOTH)


def normalise(tile: Image.Image, contrast: float, blur: float) -> Image.Image:
    """Keep the statue's surface character, discard its shapes.

    A straight crop carries tentacles and facet silhouettes, which tile into
    camouflage. What is wanted is the brushwork on top of those forms: the
    mottling, the tool marks, the grime in the crevices. Subtracting a heavy
    blur removes everything at the scale of the sculpture and leaves exactly
    that.

    Contrast is then set deliberately. The source atlas this replaces had a
    luma standard deviation of 0.024, which is why it read as noise; the first
    attempt here landed at 0.319, which reads as camouflage. The target is in
    between and is a tuning parameter rather than a guess.
    """
    grey = np.asarray(tile.convert("L")).astype(float)
    low = np.asarray(
        Image.fromarray(grey.astype(np.uint8)).filter(ImageFilter.GaussianBlur(blur)),
    ).astype(float)
    detail = grey - low

    # Re-centre on mid grey and scale to the requested standard deviation.
    spread = max(detail.std(), 1e-3)
    out = 128.0 + detail * (contrast * 255.0 / spread)
    out = np.clip(out, 0, 255)
    return Image.fromarray(np.dstack([out, out, out]).astype(np.uint8))


def main() -> None:
    args = parse_args()
    source = Image.open(args.input).convert("RGB")
    count = args.grid * args.grid
    crops = interesting_crops(source, args.tile, count)
    tiles = [normalise(make_seamless(crop, args.feather), args.contrast, args.blur) for crop in crops]

    atlas = Image.new("RGB", (args.tile * args.grid, args.tile * args.grid))
    for index, tile in enumerate(tiles):
        atlas.paste(tile, ((index % args.grid) * args.tile, (index // args.grid) * args.tile))
    atlas.save(args.output, "WEBP", quality=92, method=6)

    arr = np.asarray(atlas.convert("L")).astype(float) / 255.0
    print(f"wrote {args.output}  {atlas.size[0]}x{atlas.size[1]}")
    print(f"  luma mean {arr.mean():.3f}  std {arr.std():.3f}  range {arr.min():.3f}..{arr.max():.3f}")


if __name__ == "__main__":
    main()
