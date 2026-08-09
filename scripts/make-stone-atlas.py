#!/usr/bin/env python3
"""Generate a tileable PBR stone set procedurally — albedo, normal, roughness,
AO and the mask maps — from one height field.

The whole reference sheet is derivable. Author the height and everything else
falls out of it:

    normal      gradient of height
    AO          height minus its own blur, i.e. how deep a pixel sits
    roughness   smooth where worn high, rough where recessed and mossy
    cracks      cell boundaries, sharpened
    moss        low ground plus a large-scale blotch, so it settles in joints
    edge wear   curvature, so it appears on arrises where feet and hands go
    albedo      palette ramp over height, then the masks composited on top

That single dependency is what makes the set look like one material rather than
five images that happen to share a layout. Painting them separately is what
produces normal maps that disagree with their own albedo.

Tileability is by construction: the cell lattice wraps, and every noise octave
is sampled on a torus.

    python3 scripts/make-stone-atlas.py --style mossy --seed 7 --out-dir public/assets/textures/stone
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


STYLES = {
    # base, joint, moss, wear, cell scale, jitter, crack, roughness range
    "clean":  dict(base=(0.55, 0.58, 0.62), moss=0.0,  crack=0.15, wear=0.35, cells=6, rough=(0.62, 0.86)),
    "mossy":  dict(base=(0.52, 0.55, 0.58), moss=0.75, crack=0.25, wear=0.30, cells=6, rough=(0.55, 0.92)),
    "ruined": dict(base=(0.48, 0.50, 0.53), moss=0.35, crack=0.85, wear=0.65, cells=7, rough=(0.70, 0.95)),
    "sand":   dict(base=(0.76, 0.62, 0.40), moss=0.05, crack=0.20, wear=0.45, cells=5, rough=(0.68, 0.90)),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--style", choices=sorted(STYLES), default="clean")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--size", type=int, default=1024)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--bond", choices=["running", "irregular"], default="running")
    parser.add_argument("--cells", type=int, default=0,
                        help="override the style's stone count; 1 gives a single face for per-brick use")
    return parser.parse_args()


def wrap_blur(field: np.ndarray, radius: float) -> np.ndarray:
    """Gaussian blur that wraps.

    PIL clamps at the border, so the AO and curvature derived from a blur come
    out different on opposite edges and the texture stops tiling — which the
    seam check below catches. Tiling 3x3 and cropping the centre makes the blur
    see the wrapped neighbourhood.
    """
    tiled = np.tile(field, (3, 3))
    blurred = np.asarray(
        Image.fromarray((tiled * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius)),
    ).astype(float) / 255.0
    n = field.shape[0]
    return blurred[n:2 * n, n:2 * n]


def torus_noise(size: int, freq: int, rng: np.random.Generator) -> np.ndarray:
    """Value noise sampled on a torus, so it wraps in both axes."""
    lattice = rng.random((freq, freq))
    ys = np.linspace(0, freq, size, endpoint=False)
    xs = np.linspace(0, freq, size, endpoint=False)
    y0 = np.floor(ys).astype(int) % freq
    x0 = np.floor(xs).astype(int) % freq
    y1 = (y0 + 1) % freq
    x1 = (x0 + 1) % freq
    ty = (ys - np.floor(ys))[:, None]
    tx = (xs - np.floor(xs))[None, :]
    sy = ty * ty * (3 - 2 * ty)
    sx = tx * tx * (3 - 2 * tx)
    a = lattice[np.ix_(y0, x0)]
    b = lattice[np.ix_(y0, x1)]
    c = lattice[np.ix_(y1, x0)]
    d = lattice[np.ix_(y1, x1)]
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy


def fbm(size: int, rng: np.random.Generator, octaves: int = 5, base: int = 4) -> np.ndarray:
    out = np.zeros((size, size))
    amp, total = 1.0, 0.0
    for i in range(octaves):
        out += torus_noise(size, base * (2 ** i), rng) * amp
        total += amp
        amp *= 0.5
    return out / total


def brick_cells(size: int, cells: int, rng: np.random.Generator, bond: str) -> tuple[np.ndarray, np.ndarray]:  # noqa: C901
    """Distance to the nearest joint, plus a per-stone id.

    A running bond offsets alternate rows by half a stone, which is what makes
    masonry read as masonry rather than as a grid of tiles.
    """
    # A running bond alternates by row parity, so it only closes over an EVEN
    # number of rows. With an odd count the parity flips across the wrap and the
    # texture seams — measured at 11.6 and 8.3 for the 7- and 5-cell styles
    # against 3.9 for the 6-cell ones, which is what gave it away.
    if bond == "running" and cells % 2 == 1:
        cells += 1

    ys = np.arange(size) / size * cells
    xs = np.arange(size) / size * cells
    row = np.floor(ys).astype(int)[:, None]
    shift = np.where(row % 2 == 1, 0.5, 0.0) if bond == "running" else 0.0

    # No jitter on the joint positions.
    #
    # Displacing a boundary per row cannot wrap: row 0 and row n-1 meet across
    # the seam carrying different offsets, so the joint steps there. Measured as
    # a persistently worse y-seam than x across every style. Irregularity comes
    # from the surface noise and the per-stone height instead, which are sampled
    # on a torus and wrap by construction.

    gx = xs[None, :] + shift
    col = np.floor(gx).astype(int) % cells
    rw = row % cells
    fx = gx - np.floor(gx)
    fy = ys[:, None] - np.floor(ys[:, None])

    # Distance to the nearest edge of this stone's cell, warped by a torus
    # noise so joints wander without the lattice ever failing to close.
    warp = (torus_noise(size, max(2, cells), rng) - 0.5) * 0.18
    edge = np.minimum(np.minimum(fx, 1 - fx), np.minimum(fy, 1 - fy)) + warp
    stone_id = (rw * cells + col).astype(float) / (cells * cells)
    return edge, stone_id


def build(args: argparse.Namespace) -> dict:
    size = args.size
    style = STYLES[args.style]
    rng = np.random.default_rng(args.seed)

    edge, stone_id = brick_cells(size, args.cells or style["cells"], rng, args.bond)

    # --- height: the one authored field ------------------------------------
    joint = np.clip(edge / 0.055, 0, 1) ** 0.6          # mortar recess
    surface = fbm(size, rng, octaves=5, base=6)
    # Count derived from stone_id, not from the style, because a running bond
    # may have bumped the row count to keep the wrap closed.
    stone_count = int(round(1.0 / max(np.min(stone_id[stone_id > 0]), 1e-6))) if np.any(stone_id > 0) else 1
    stone_count = max(stone_count, int(stone_id.max() * 1 + 1), 1)
    lut = rng.random((stone_count + 1,))
    per_stone = (lut[(stone_id * stone_count).astype(int).clip(0, stone_count)] - 0.5) * 0.10
    fracture = 1 - np.abs(fbm(size, rng, octaves=4, base=8) * 2 - 1)   # ridged = cracks
    cracks = np.clip((fracture - 0.72) / 0.28, 0, 1) * style["crack"]

    height = joint * 0.72 + surface * 0.22 + per_stone + 0.06
    height = np.clip(height - cracks * 0.35, 0, 1)

    # --- everything else derives from it ------------------------------------
    blurred = wrap_blur(height, size / 90.0)
    cavity = np.clip(0.5 + (height - blurred) * 3.2, 0, 1)      # AO
    curvature = np.clip((height - blurred) * 6.0, 0, 1)          # convex = worn arris

    moss_blotch = fbm(size, rng, octaves=4, base=3)
    moss = np.clip((moss_blotch - 0.42) * 3.0, 0, 1) * np.clip(1 - height * 1.4, 0, 1) * style["moss"]
    wear = curvature * style["wear"]

    # Gradient computed with np.roll so it wraps; np.gradient uses one-sided
    # differences at the border, which is a seam in the normal map.
    gy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5
    gx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5
    strength = size / 220.0
    nx, ny, nz = -gx * strength, gy * strength, np.ones_like(height)
    norm = np.sqrt(nx ** 2 + ny ** 2 + nz ** 2)
    normal = np.dstack([nx / norm, ny / norm, nz / norm]) * 0.5 + 0.5

    base = np.array(style["base"])
    albedo = np.dstack([height * 0.45 + 0.55] * 3) * base
    albedo = albedo * (1 - cavity[:, :, None] * 0.35)                 # dirt in the recesses
    albedo += wear[:, :, None] * np.array([0.16, 0.15, 0.14])         # pale worn arrises
    albedo = albedo * (1 - moss[:, :, None]) + moss[:, :, None] * np.array([0.24, 0.31, 0.16])
    albedo = np.clip(albedo, 0, 1)

    lo, hi = style["rough"]
    roughness = np.clip(lo + (1 - height) * (hi - lo) + moss * 0.06 - wear * 0.10, 0, 1)

    # Centre the two maps the shader uses multiplicatively on 0.5, so it can
    # modulate around 1.0 instead of darkening. Un-centred, the ruined albedo
    # came out at mean 0.352 and the AO at 0.506, which multiplied the masonry
    # by roughly a half — the scene going dark was arithmetic, not art.
    albedo = np.clip(albedo * (0.5 / max(albedo.mean(), 1e-3)), 0, 1)
    cavity = np.clip(cavity * (0.5 / max(cavity.mean(), 1e-3)), 0, 1)

    return {
        "albedo": (albedo * 255).astype(np.uint8),
        "normal": (normal * 255).astype(np.uint8),
        "roughness": (roughness * 255).astype(np.uint8),
        "ao": (cavity * 255).astype(np.uint8),
        "height": (height * 255).astype(np.uint8),
        "mask-moss": (moss * 255).astype(np.uint8),
        "mask-cracks": (np.clip(cracks / max(style["crack"], 1e-3), 0, 1) * 255).astype(np.uint8),
        "mask-wear": (wear * 255).astype(np.uint8),
    }


def main() -> None:
    args = parse_args()
    maps = build(args)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    written = []
    for name, data in maps.items():
        image = Image.fromarray(data if data.ndim == 3 else data, "RGB" if data.ndim == 3 else "L")
        path = out_dir / f"{args.style}-{name}-{args.size}.webp"
        image.save(path, "WEBP", quality=92, method=6)
        written.append((path.name, path.stat().st_size // 1024))

    # Tileability check: opposite edges must match, or the wrap shows a seam.
    alb = maps["albedo"].astype(float)
    seam_x = np.abs(alb[:, 0] - alb[:, -1]).mean()
    seam_y = np.abs(alb[0, :] - alb[-1, :]).mean()

    print(f"{args.style} seed {args.seed}")
    for name, kb in written:
        print(f"  {name:<34} {kb:>4} KB")
    print(f"  wrap seam: x {seam_x:.2f}  y {seam_y:.2f}  (0 = perfectly tileable, >8 is visible)")
    print(json.dumps({"style": args.style, "seed": args.seed, "seam": [seam_x, seam_y]}))


if __name__ == "__main__":
    main()
