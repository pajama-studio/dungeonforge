// Thorn thickets for the basin bed — the drowned briar under the glowing water.
//
// Built the same way as everything else in this generator: no Math.random, one
// geometry shared by thousands of instances, and all per-element motion in the
// vertex shader. The CPU only decides where clumps sit; it never touches a
// thorn again after that.
//
// Shape comes from how a real bramble grows. A cane leaves the ground steeply,
// arches over under its own weight and comes back down — so the silhouette is
// an arch, not a spike. Thorns ride the outside of that arch, biggest at the
// crown where the cane is under most tension. Several canes from one root make
// a clump; overlapping clumps make a thicket you cannot see the bed through.

import * as THREE from "three/webgpu";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";

import { hash2, hash3 } from "../gen/rng";

/** Cross-section sides. Three is the cheapest tube that still reads round-ish
 *  under faceted shading, and a cane is thin enough that nobody counts. */
const SIDES = 3;

export interface CaneOptions {
  /** Spine subdivisions. More is smoother and costs 6 triangles each. */
  segments: number;
  /** How far the arch reaches from its root, in world units. */
  reach: number;
  /** Peak height of the arch. */
  rise: number;
  /** Stem radius at the root; the tip tapers to near nothing. */
  radius: number;
  /** Thorn length as a multiple of the local stem radius. */
  thornScale: number;
}

export const CANE_DEFAULTS: CaneOptions = {
  segments: 6,
  reach: 1.9,
  rise: 1.15,
  radius: 0.05,
  thornScale: 2.6,
};

/** Quadratic Bezier — cheap, and its tangent is analytic, which is what the
 *  cross-section frame needs. */
function bezier(t: number, reach: number, rise: number): [number, number] {
  const u = 1 - t;
  // P0 (0,0) → P1 (reach*0.3, rise*1.35) → P2 (reach, rise*0.06)
  const x = 2 * u * t * (reach * 0.3) + t * t * reach;
  const y = 2 * u * t * (rise * 1.35) + t * t * (rise * 0.06);
  return [x, y];
}

function bezierTangent(t: number, reach: number, rise: number): [number, number] {
  const u = 1 - t;
  const dx = 2 * u * (reach * 0.3) + 2 * t * (reach - reach * 0.3);
  const dy = 2 * u * (rise * 1.35) + 2 * t * (rise * 0.06 - rise * 1.35);
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

/** One arching cane, lying in the XY plane and rooted at the origin.
 *
 *  Non-indexed on purpose: computeVertexNormals then gives true per-face
 *  normals, which is the faceted look the rest of the kit uses, and it lets
 *  each triangle carry its own colour without splitting seams by hand.
 */
export function brambleCaneGeometry(
  seed: number,
  salt: number,
  options: Partial<CaneOptions> = {},
): THREE.BufferGeometry {
  const o = { ...CANE_DEFAULTS, ...options };
  const positions: number[] = [];
  const colors: number[] = [];

  // Value ramp: near-black in the silt, paler toward the tip where the water
  // light reaches. Thorns get a lift so they catch that light and read.
  const shade = (t: number, lift = 0): [number, number, number] => {
    const v = 0.20 + t * 0.34 + lift;
    return [v * 0.86, v, v * 0.94];
  };

  const rings: number[][] = [];
  for (let i = 0; i <= o.segments; i++) {
    const t = i / o.segments;
    const [cx, cy] = bezier(t, o.reach, o.rise);
    const [tx, ty] = bezierTangent(t, o.reach, o.rise);
    // Frame: the cane bends only in XY, so Z is always a valid side vector and
    // the normal in-plane is the tangent turned a quarter.
    const nx = -ty, ny = tx;
    const r = o.radius * (1 - 0.84 * t) * (0.85 + hash3(seed, salt, i, 11) * 0.3);
    const ring: number[] = [];
    for (let k = 0; k < SIDES; k++) {
      const a = (k / SIDES) * Math.PI * 2 + hash3(seed, salt, i, 12) * 0.6;
      const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
      ring.push(cx + nx * ca, cy + ny * ca, sa);
    }
    rings.push(ring);
  }

  const tri = (
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number, col: [number, number, number],
  ) => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let n = 0; n < 3; n++) colors.push(col[0], col[1], col[2]);
  };

  for (let i = 0; i < o.segments; i++) {
    const t = (i + 0.5) / o.segments;
    const col = shade(t);
    const a = rings[i], b = rings[i + 1];
    for (let k = 0; k < SIDES; k++) {
      const k2 = (k + 1) % SIDES;
      const a0 = k * 3, a1 = k2 * 3;
      tri(a[a0], a[a0 + 1], a[a0 + 2], b[a0], b[a0 + 1], b[a0 + 2], b[a1], b[a1 + 1], b[a1 + 2], col);
      tri(a[a0], a[a0 + 1], a[a0 + 2], b[a1], b[a1 + 1], b[a1 + 2], a[a1], a[a1 + 1], a[a1 + 2], col);
    }
  }

  // Thorns: one flat three-sided barb per ring, angled back down the cane the
  // way a real one does — forward-pointing thorns look like spines, backward
  // ones look like they would catch you.
  for (let i = 1; i < o.segments; i++) {
    const t = i / o.segments;
    if (hash3(seed, salt, i, 21) > 0.86) continue; // a few bare stretches
    const [cx, cy] = bezier(t, o.reach, o.rise);
    const [tx, ty] = bezierTangent(t, o.reach, o.rise);
    const r = o.radius * (1 - 0.84 * t);
    // Thorns are longest at the crown, where the arch carries the most tension.
    const crown = Math.sin(t * Math.PI);
    const len = r * o.thornScale * (0.55 + crown * 0.75);
    const spin = hash3(seed, salt, i, 22) * Math.PI * 2;
    const ox = -ty * Math.cos(spin), oy = tx * Math.cos(spin), oz = Math.sin(spin);
    // Tip sits out along the outward direction and back along the cane.
    const px = cx + ox * len - tx * len * 0.45;
    const py = cy + oy * len - ty * len * 0.45;
    const pz = oz * len;
    const col = shade(t, 0.12);
    const bx = cx + ox * r, by = cy + oy * r, bz = oz * r;
    const s = r * 0.9;
    tri(bx - tx * s, by - ty * s, bz, bx + tx * s, by + ty * s, bz, px, py, pz, col);
    tri(bx + tx * s, by + ty * s, bz, bx - tx * s, by - ty * s, bz + s, px, py, pz, col);
    tri(bx - tx * s, by - ty * s, bz + s, bx - tx * s, by - ty * s, bz, px, py, pz, col);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colors), 3));
  geo.computeVertexNormals();
  return geo;
}

/** A root's worth of canes, fanned around it.
 *
 *  One instance being a clump rather than a single cane is what makes a thicket
 *  affordable: the bed needs visual mass, and mass per draw call is the whole
 *  budget. */
export function brambleClumpGeometry(seed: number, variant: number, canes = 4): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let c = 0; c < canes; c++) {
    const salt = variant * 97 + c;
    const scale = 0.7 + hash3(seed, variant, c, 31) * 0.75;
    const cane = brambleCaneGeometry(seed, salt, {
      reach: CANE_DEFAULTS.reach * scale,
      rise: CANE_DEFAULTS.rise * (0.65 + hash3(seed, variant, c, 32) * 0.7),
      radius: CANE_DEFAULTS.radius * (0.8 + hash3(seed, variant, c, 33) * 0.5),
    });
    // Fan the canes around the root and roll each one so its thorns do not all
    // face the same way.
    cane.rotateZ((hash3(seed, variant, c, 34) - 0.5) * 0.5);
    cane.rotateY((c / canes) * Math.PI * 2 + (hash3(seed, variant, c, 35) - 0.5) * 0.9);
    cane.translate(
      (hash3(seed, variant, c, 36) - 0.5) * 0.28,
      0,
      (hash3(seed, variant, c, 37) - 0.5) * 0.28,
    );
    parts.push(cane);
  }
  const merged = BufferGeometryUtils.mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

export interface BrambleScatter {
  /** Clumps actually placed — fewer than capacity when the ring is thin. */
  count: number;
}

/** Deterministic scatter across an annulus of the basin bed.
 *
 *  Rejection-free: the radius is drawn as sqrt(u) so clumps land with uniform
 *  area density rather than bunching at the middle, which is what a naive
 *  uniform radius does. The inner hole keeps the briar out of the statue's own
 *  pool, where it would fight the tentacle roots for silhouette.
 */
export function scatterBrambles(
  mesh: THREE.InstancedMesh,
  seed: number,
  center: THREE.Vector3,
  radius: number,
  innerFraction = 0.18,
): BrambleScatter {
  const matrix = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const axis = new THREE.Vector3(0, 1, 0);
  const inner = radius * innerFraction;

  let n = 0;
  for (let i = 0; i < mesh.count; i++) {
    const u = hash2(seed, i, 401);
    const r = Math.sqrt(inner * inner / (radius * radius) + u * (1 - inner * inner / (radius * radius))) * radius;
    const a = hash2(seed, i, 402) * Math.PI * 2;
    // A slight lean, so a thicket does not look like a field of identical hoops.
    const lean = (hash2(seed, i, 405) - 0.5) * 0.34;
    const scale = 0.75 + hash2(seed, i, 404) * 0.9;
    p.set(center.x + Math.cos(a) * r, center.y, center.z + Math.sin(a) * r);
    q.setFromAxisAngle(axis, hash2(seed, i, 403) * Math.PI * 2);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), lean));
    s.setScalar(scale);
    mesh.setMatrixAt(i, matrix.compose(p, q, s));
    n++;
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  return { count: n };
}
