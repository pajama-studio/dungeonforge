// Pure spiral-staircase math (no THREE imports — unit-tested in node).
// The walkable surface of a square spiral stair is ANALYTIC: perimeter
// arc-length × slope, loop index disambiguated by a reference height.
//
// Towers VARY (diameter m, pitch rise) — every consumer reads the tower's own
// fields, so the drawn treads, the ground sampler and nav tracing stay one
// single source of truth. STAIR in config.ts holds the baseline constants.

import { STAIR } from "../config";

export interface StairSpan {
  y0: number;
  y1: number;
  m: number;
  rise: number;
  /** perimeter offset of the first tread. External stair docks use this to
   *  face both landings toward the fortress wall. */
  phase?: number;
}

/** arc-length position along the square mid-ring perimeter for (dx,dz) */
export function stairPerimeterS(dx: number, dz: number, m: number = STAIR.M): number {
  const cx = Math.max(-m, Math.min(m, dx)), cz = Math.max(-m, Math.min(m, dz));
  const ax = Math.abs(dx), az = Math.abs(dz);
  if (az >= ax) {
    if (dz < 0) return cx + m;                 // side 0
    return 4 * m + (m - cx);                   // side 2
  }
  if (dx > 0) return 2 * m + (cz + m);         // side 1
  return 6 * m + (m - cz);                     // side 3
}

/** square-ring position at a perimeter distance. Keeping this inverse beside
 *  stairPerimeterS means the mesh, nav route and analytic ground agree. */
export function stairXZAtS(s: number, m: number = STAIR.M): { x: number; z: number } {
  const P = 8 * m;
  const u0 = ((s % P) + P) % P;
  const side = Math.min(3, Math.floor(u0 / (2 * m)));
  const u = u0 - side * 2 * m - m;
  if (side === 0) return { x: u, z: -m };
  if (side === 1) return { x: m, z: u };
  if (side === 2) return { x: -u, z: m };
  return { x: -m, z: -u };
}

/** x/z point on the tread centreline at an exact world height. */
export function stairXZAtHeight(t: StairSpan, y: number): { x: number; z: number } {
  const slope = t.rise / STAIR.STEP;
  const s = (t.phase ?? 0) + (Math.max(t.y0, Math.min(t.y1, y)) - t.y0) / slope;
  return stairXZAtS(s, t.m);
}

/** analytic spiral height at (dx,dz), loop index disambiguated by refY
 *  (the same xz repeats every revolution) — clamped to the tower's span */
export function spiralHeight(t: StairSpan, dx: number, dz: number, refY: number): number {
  const P = 8 * t.m;
  const rawS = stairPerimeterS(dx, dz, t.m);
  const s = ((rawS - (t.phase ?? 0)) % P + P) % P;
  const slope = t.rise / STAIR.STEP;
  const kMax = Math.ceil((t.y1 - t.y0) / (P * slope));
  const k = Math.max(0, Math.min(kMax, Math.round(((refY - t.y0) / slope - s) / P)));
  return Math.min(t.y1, Math.max(t.y0, t.y0 + (k * P + s) * slope));
}
