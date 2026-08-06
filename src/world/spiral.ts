// Pure spiral-staircase math (no THREE imports — unit-tested in node).
// The walkable surface of a square spiral stair is ANALYTIC: perimeter
// arc-length × slope, loop index disambiguated by a reference height.

import { STAIR } from "../config";

export interface StairSpan { y0: number; y1: number }

/** arc-length position along the square mid-ring perimeter for (dx,dz) */
export function stairPerimeterS(dx: number, dz: number): number {
  const m = STAIR.M;
  const cx = Math.max(-m, Math.min(m, dx)), cz = Math.max(-m, Math.min(m, dz));
  const ax = Math.abs(dx), az = Math.abs(dz);
  if (az >= ax) {
    if (dz < 0) return cx + m;                 // side 0
    return 4 * m + (m - cx);                   // side 2
  }
  if (dx > 0) return 2 * m + (cz + m);         // side 1
  return 6 * m + (m - cz);                     // side 3
}

/** analytic spiral height at (dx,dz), loop index disambiguated by refY
 *  (the same xz repeats every revolution) — clamped to the tower's span */
export function spiralHeight(t: StairSpan, dx: number, dz: number, refY: number): number {
  const P = 8 * STAIR.M;
  const s = stairPerimeterS(dx, dz);
  const slope = STAIR.RISE / STAIR.STEP;
  const kMax = Math.ceil((t.y1 - t.y0) / (P * slope));
  const k = Math.max(0, Math.min(kMax, Math.round(((refY - t.y0) / slope - s) / P)));
  return Math.min(t.y1, Math.max(t.y0, t.y0 + (k * P + s) * slope));
}
