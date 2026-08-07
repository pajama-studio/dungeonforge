// Small pieces shared by the world modes.

import * as THREE from "three/webgpu";
import type { Layout } from "../gen/dungeon";
import { FLOOR } from "../gen/dungeon";
import { TH, CELL } from "../config";
import type { IslandWalk } from "./walkmap";

export interface Origin { ox: number; oy: number; oz: number }

/** world-space docking point of a block's gate on side `dir` (just outside the wall) */
export function gateWorld(l: Layout, p: Origin, dir: number): THREE.Vector3 | null {
  const g = l.gates.find((gg) => gg.dir === dir);
  if (!g) return null;
  const fx = [1, -1, 0, 0][dir], fz = [0, 0, 1, -1][dir];
  return new THREE.Vector3(
    p.ox + (g.x - (l.N - 1) / 2) * CELL + fx * (CELL / 2 + 0.3),
    p.oy + g.tier * TH + 0.1,
    p.oz + (g.y - (l.N - 1) / 2) * CELL + fz * (CELL / 2 + 0.3),
  );
}


/** find a clear elevator shaft joining a stacked pair: a cell that is open
 *  floor in BOTH layers — searched outward from the child's center.
 *  `relax` loosens the criteria so a shaft is ALWAYS found when any floor
 *  overlap exists (the map must be walkable): 0 = pristine (no support
 *  pillar, no stairs in either cell), 1 = allow a support pillar beside the
 *  tower, 2 = allow stair cells too. */
export function findShaft(par: IslandWalk, chi: IslandWalk, relax = 0): { x: number; z: number; y0: number; y1: number } | null {
  const l = chi.l, cN = l.N, pN = par.l.N;
  for (let r = 0; r < cN / 2; r++) {
    for (let gy = Math.max(1, ((cN - 1) >> 1) - r); gy <= Math.min(cN - 2, ((cN - 1) >> 1) + r); gy++) {
      for (let gx = Math.max(1, ((cN - 1) >> 1) - r); gx <= Math.min(cN - 2, ((cN - 1) >> 1) + r); gx++) {
        const cc = gy * cN + gx;
        if (l.kind[cc] !== FLOOR) continue;
        if (relax < 2 && l.stairMask[cc]) continue;
        if (relax < 1 && l.support[cc] !== l.tier[cc]) continue;
        const wxp = chi.ox + (gx - (cN - 1) / 2) * CELL;
        const wzp = chi.oz + (gy - (cN - 1) / 2) * CELL;
        const pgx = Math.round((wxp - par.ox) / CELL + (pN - 1) / 2);
        const pgy = Math.round((wzp - par.oz) / CELL + (pN - 1) / 2);
        if (pgx < 1 || pgy < 1 || pgx >= pN - 1 || pgy >= pN - 1) continue;
        const pc = pgy * pN + pgx;
        if (par.l.kind[pc] !== FLOOR) continue;
        if (relax < 2 && par.l.stairMask[pc]) continue;
        return {
          x: wxp, z: wzp,
          y0: par.oy + par.l.tier[pc] * TH + 0.16,
          y1: chi.oy + l.tier[cc] * TH + 0.16,
        };
      }
    }
  }
  return null;
}

/** three-step ladder: pristine shaft → beside a pillar → anywhere floor
 *  overlaps. Returns null only when the footprints share no walkable overlap. */
export function findShaftAnyhow(par: IslandWalk, chi: IslandWalk): ReturnType<typeof findShaft> {
  return findShaft(par, chi, 0) ?? findShaft(par, chi, 1) ?? findShaft(par, chi, 2);
}

/** post-hoc gate carving: if the generator failed to carve a gate on `side`
 *  (rare — no boundary wall with interior floor), open one now so the bridge
 *  crossing is genuinely walkable. Mutates the layout; caller rebuilds. */
export function ensureGate(l: Layout, side: number): boolean {
  if (l.gates.some((g) => g.dir === side)) return false;
  const N = l.N;
  let best = -1, bestScore = Infinity;
  for (let t = 1; t < N - 1; t++) {
    const bx = side === 0 ? N - 1 : side === 1 ? 0 : t;
    const by = side === 2 ? N - 1 : side === 3 ? 0 : t;
    const ix = side === 0 ? N - 2 : side === 1 ? 1 : t;
    const iy = side === 2 ? N - 2 : side === 3 ? 1 : t;
    if (l.kind[by * N + bx] !== 2 /* WALL */ || l.kind[iy * N + ix] !== FLOOR) continue;
    const score = Math.abs(t - (N - 1) / 2);
    if (score < bestScore) { bestScore = score; best = t; }
  }
  if (best < 0) return false;
  const bx = side === 0 ? N - 1 : side === 1 ? 0 : best;
  const by = side === 2 ? N - 1 : side === 3 ? 0 : best;
  const ix = side === 0 ? N - 2 : side === 1 ? 1 : best;
  const iy = side === 2 ? N - 2 : side === 3 ? 1 : best;
  const b = by * N + bx;
  l.kind[b] = FLOOR;
  l.tier[b] = l.tier[iy * N + ix];
  l.gates.push({ x: bx, y: by, dir: side as 0 | 1 | 2 | 3, tier: l.tier[b] });
  return true;
}

/** building an island costs 10-20ms of instance filling on the main thread —
 *  modes spread a chain across frames instead of stalling one frame with all of it.
 *  Hidden tabs never fire rAF, so a timeout fallback keeps a background forge
 *  moving instead of stalling until the tab is foregrounded. */
export const nextFrame = (): Promise<void> => new Promise((resolve) => {
  let done = false;
  const settle = () => { if (!done) { done = true; resolve(); } };
  const t = setTimeout(settle, 60);
  requestAnimationFrame(() => { clearTimeout(t); settle(); });
});
