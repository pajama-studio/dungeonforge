// Positional erosion for the big procedural rock masses.
//
// Landmark rock is authored as boxes and icosahedra because that is how you get
// a silhouette worth looking at. It stops working the moment a camera comes
// close: the backing cliff is 335 world units across and carried 1264
// triangles, so its facets were tens of units wide and read as folded paper.
//
// The fix is displacement, and the important detail is WHAT it displaces along.
//
// Displacing along vertex normals is the obvious choice and it tears every
// object built from boxes. A box duplicates its corner vertices — one per face,
// each with a different normal — so two vertices sitting at the same point move
// in different directions and the box opens at its seams. Faceted geometry with
// per-face normals has this problem everywhere, not just at corners.
//
// Displacing by a function of POSITION cannot tear. Two vertices at the same
// coordinate get the same offset whatever their normals say, so seams stay
// welded by construction and no welding pass is needed first. The cost is that
// the displacement is not along the surface, which for eroded rock is exactly
// right anyway — weathering does not respect a face.

import * as THREE from "three/webgpu";

import { hash3 } from "../../gen/rng";

/** Trilinear-smoothed lattice noise. Continuous in position, which is the
 *  property the whole approach rests on. */
function noise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);
  const sz = zf * zf * (3 - 2 * zf);
  const at = (i: number, j: number, k: number) => hash3(seed, i * 73856093 ^ j, k * 83492791, j);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c00 = lerp(at(xi, yi, zi), at(xi + 1, yi, zi), sx);
  const c10 = lerp(at(xi, yi + 1, zi), at(xi + 1, yi + 1, zi), sx);
  const c01 = lerp(at(xi, yi, zi + 1), at(xi + 1, yi, zi + 1), sx);
  const c11 = lerp(at(xi, yi + 1, zi + 1), at(xi + 1, yi + 1, zi + 1), sx);
  return lerp(lerp(c00, c10, sy), lerp(c01, c11, sy), sz);
}

function fbm3(x: number, y: number, z: number, seed: number, octaves: number): number {
  let sum = 0, amp = 1, total = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += noise3(x * f, y * f, z * f, seed + o * 7919) * amp;
    total += amp;
    amp *= 0.5;
    f *= 2.07; // not exactly 2, so octaves do not line up into a grid
  }
  return sum / total;
}

export interface ErodeOptions {
  seed: number;
  /** Peak displacement in world units. */
  amplitude: number;
  /** Lattice cells per world unit — the size of the biggest lumps. */
  frequency: number;
  octaves: number;
  /** Extra vertical bias, so erosion cuts horizontal strata the way bedded
   *  rock weathers rather than looking like uniform lumpiness. */
  strata: number;
}

export const ERODE_DEFAULTS: ErodeOptions = {
  seed: 1,
  amplitude: 1.6,
  frequency: 0.05,
  octaves: 4,
  strata: 0.55,
};

/** Weather a geometry in place and return it.
 *
 *  Recomputes normals afterwards so the faceted look survives, and leaves the
 *  caller to re-bake vertex colours — displacement changes which way a face
 *  points, so any face-value painting has to happen after this, not before.
 */
export function erodeGeometry(
  geometry: THREE.BufferGeometry,
  options: Partial<ErodeOptions> = {},
): THREE.BufferGeometry {
  const o = { ...ERODE_DEFAULTS, ...options };
  const position = geometry.getAttribute("position");
  if (!position) return geometry;
  const f = o.frequency;

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    // Three decorrelated fields, one per axis. Offsetting the sample point is
    // enough to decorrelate them and costs nothing.
    const dx = fbm3(x * f, y * f, z * f, o.seed, o.octaves) - 0.5;
    const dy = fbm3(x * f + 31.7, y * f + 11.3, z * f + 57.1, o.seed, o.octaves) - 0.5;
    const dz = fbm3(x * f + 73.9, y * f + 41.7, z * f + 19.3, o.seed, o.octaves) - 0.5;
    // Bedding planes: a higher-frequency band in Y only, so the rock splits
    // into courses instead of dissolving into noise.
    const bed = (noise3(0, y * f * 4.3, 0, o.seed + 991) - 0.5) * o.strata;
    position.setXYZ(
      i,
      x + (dx + bed * 0.6) * o.amplitude * 2,
      y + dy * o.amplitude * 2 * (1 - o.strata * 0.5),
      z + (dz + bed * 0.6) * o.amplitude * 2,
    );
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}


/** Midpoint-subdivide every triangle, `levels` times.
 *
 *  Erosion can only move vertices that exist. A 1,000-triangle remesh standing
 *  128 units tall has facets ten units across, and no amount of displacement
 *  fixes that — it just makes ten-unit facets that wobble. This gives the
 *  displacement something to bite on.
 *
 *  Triangle count multiplies by 4 per level, so two levels is 16x. Non-indexed
 *  in, non-indexed out: erodeGeometry displaces by position, so the duplicated
 *  vertices along shared edges still land together and nothing cracks.
 */
export function subdivideGeometry(geometry: THREE.BufferGeometry, levels = 1): THREE.BufferGeometry {
  let source = geometry.index ? geometry.toNonIndexed() : geometry;
  for (let pass = 0; pass < levels; pass++) {
    const position = source.getAttribute("position");
    if (!position) return source;
    const out = new Float32Array(position.count * 4 * 3);
    let w = 0;
    const push = (
      ax: number, ay: number, az: number, bx: number, by: number, bz: number,
      cx: number, cy: number, cz: number,
    ) => {
      out[w++] = ax; out[w++] = ay; out[w++] = az;
      out[w++] = bx; out[w++] = by; out[w++] = bz;
      out[w++] = cx; out[w++] = cy; out[w++] = cz;
    };
    for (let i = 0; i < position.count; i += 3) {
      const ax = position.getX(i), ay = position.getY(i), az = position.getZ(i);
      const bx = position.getX(i + 1), by = position.getY(i + 1), bz = position.getZ(i + 1);
      const cx = position.getX(i + 2), cy = position.getY(i + 2), cz = position.getZ(i + 2);
      const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
      const nx = (bx + cx) / 2, ny = (by + cy) / 2, nz = (bz + cz) / 2;
      const ox = (cx + ax) / 2, oy = (cy + ay) / 2, oz = (cz + az) / 2;
      push(ax, ay, az, mx, my, mz, ox, oy, oz);
      push(mx, my, mz, bx, by, bz, nx, ny, nz);
      push(ox, oy, oz, nx, ny, nz, cx, cy, cz);
      push(mx, my, mz, nx, ny, nz, ox, oy, oz);
    }
    const next = new THREE.BufferGeometry();
    next.setAttribute("position", new THREE.BufferAttribute(out, 3));
    if (source !== geometry) source.dispose();
    source = next;
  }
  source.computeVertexNormals();
  return source;
}
