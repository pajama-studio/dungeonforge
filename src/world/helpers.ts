// Small pieces shared by the world modes.

import * as THREE from "three/webgpu";
import type { Dir, Layout, VerticalAnchor } from "../gen/dungeon";
import { FLOOR, WALL } from "../gen/dungeon";
import { TH, CELL } from "../config";
import type { StairDock } from "./stairs";

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

export interface VerticalStairDock extends StairDock {
  x: number;
  z: number;
  y0: number;
  y1: number;
}

/** Resolve one generator-owned vertical connection into a tower and two
 * exactly matching floor landings. Both layouts carry the same link id, so
 * this remains correct when their sizes and rotations differ. */
export function verticalStairDock(
  par: { l: Layout } & Origin,
  chi: { l: Layout } & Origin,
  linkId: number,
): VerticalStairDock | null {
  const pa = par.l.verticalAnchors.find((a) => a.id === linkId);
  const ca = chi.l.verticalAnchors.find((a) => a.id === linkId);
  if (!pa || !ca) return null;
  const point = (l: Layout, o: Origin, a: VerticalAnchor) => {
    const x = a.x + [1, -1, 0, 0][a.dockDir];
    const y = a.y + [0, 0, 1, -1][a.dockDir];
    const c = y * l.N + x;
    if (l.kind[c] !== FLOOR) return null;
    return {
      x: o.ox + (x - (l.N - 1) / 2) * CELL,
      y: o.oy + l.tier[c] * TH + 0.16,
      z: o.oz + (y - (l.N - 1) / 2) * CELL,
    };
  };
  const lower = point(par.l, par, pa), upper = point(chi.l, chi, ca);
  if (!lower || !upper || upper.y <= lower.y) return null;
  const px = par.ox + (pa.x - (par.l.N - 1) / 2) * CELL;
  const pz = par.oz + (pa.y - (par.l.N - 1) / 2) * CELL;
  const cx = chi.ox + (ca.x - (chi.l.N - 1) / 2) * CELL;
  const cz = chi.oz + (ca.y - (chi.l.N - 1) / 2) * CELL;
  if (Math.hypot(px - cx, pz - cz) > 0.15) return null;
  return {
    x: (px + cx) / 2, z: (pz + cz) / 2,
    y0: lower.y, y1: upper.y,
    side: pa.dockDir ^ 1,
    lower, upper,
  };
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

/** Carve a real room apron through one side of a block. Two facing aprons plus
 * the wide seam deck form a single cross-block court; this changes the maze
 * data itself (floor/support/masks/navigation), not just its rendering. */
export function fuseDistrictBoundary(
  l: Layout, side: Dir, halfWidth = 2, depth = 3,
): number {
  const gate = l.gates.find((candidate) => candidate.dir === side);
  if (!gate) return 0;
  const N = l.N;
  const inward = (side ^ 1) as Dir;
  const ix = [1, -1, 0, 0][inward], iy = [0, 0, 1, -1][inward];
  const tx = iy, ty = -ix;
  const touched = new Set<number>();
  let addedFloor = 0, removedWall = 0;
  for (let d = 0; d < depth; d++) for (let lateral = -halfWidth; lateral <= halfWidth; lateral++) {
    const x = gate.x + ix * d + tx * lateral;
    const y = gate.y + iy * d + ty * lateral;
    if (x < 0 || y < 0 || x >= N || y >= N) continue;
    const c = y * N + x;
    // A portal facade or vertical shaft owns its volume end-to-end. Fused
    // seams choose other cells rather than silently destroying a landmark.
    if (l.doorMask[c] || l.shaftMask[c]) continue;
    if (l.kind[c] !== FLOOR) {
      if (l.kind[c] === WALL) removedWall++;
      addedFloor++;
    }
    touched.add(c);
    l.kind[c] = FLOOR;
    l.tier[c] = gate.tier;
    l.support[c] = gate.tier;
    l.wallBase[c] = gate.tier;
    l.wallTop[c] = gate.tier;
    l.stairMask[c] = 0;
    l.ruinMask[c] = 0;
    l.redMask[c] = 0;
    l.templeMask[c] = 0;
    l.plazaMask[c] = 0;
    l.volumeMask[c] = 0;
  }
  if (touched.size === 0) return 0;
  l.stats.floor += addedFloor;
  l.stats.wall -= removedWall;
  const keep = (x: number, y: number) => !touched.has(y * N + x);
  l.stairs = l.stairs.filter((item) => keep(item.x, item.y));
  l.torches = l.torches.filter((item) => keep(item.x, item.y));
  l.banners = l.banners.filter((item) => keep(item.x, item.y));
  l.towers = l.towers.filter((item) => keep(item.x, item.y));
  l.braziers = l.braziers.filter((item) => keep(item.x, item.y));
  l.templeCells = l.templeCells.filter((cell) => !touched.has(cell));
  return touched.size;
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

/** Resume after the browser has had a chance to present the requested frame,
 * not in the microtask checkpoint between two RAF callbacks. Used for the
 * first-island handoff: resuming forge work inside that checkpoint delayed the
 * renderer's own callback by the whole assembly budget. */
const afterNextFrame = (): Promise<void> => new Promise((resolve) => {
  let done = false;
  const settle = () => { if (!done) { done = true; resolve(); } };
  const fallback = setTimeout(settle, 60);
  requestAnimationFrame(() => {
    clearTimeout(fallback);
    setTimeout(settle, 0);
  });
});

/** Frame-budget pacer. Generation is subdivided into SMALL steps (one island
 *  build, one gate repair, one bridge, one pier set…) and `tick()` is awaited
 *  between them: once the budget is spent the rest of the frame goes back to
 *  the renderer. The active mode chooses the budget that leaves enough room
 *  for its render path, so a forge reads as a rise animation, never a hitch. */
export class Pacer {
  private used = performance.now();
  constructor(private budgetMs = 6) {}
  async tick(force = false): Promise<void> {
    const elapsed = performance.now() - this.used;
    if (force || elapsed > this.budgetMs) {
      await (force ? afterNextFrame() : nextFrame());
      this.used = performance.now();
    }
  }
}

/** How far the entrance tower descends below the floor it arrives on.
 *
 *  Authored, not measured. A ground block sits near y=0 and the abyss floor's
 *  plane is around -27 with ±11 of relief, so the natural drop is 16-38 units
 *  and varies per seed — and the bedrock lives in ringGroup, which fit()
 *  rescales with the chain, so deriving the climb from the terrain would tie
 *  the tower's height to a presentation fit. Fixing it here makes the climb a
 *  pacing decision the design owns. See docs/GROUND-ENTRANCE.md §5.1. */
export const GROUND_CLIMB = 26;

/** The way into the world, as a tower dock.
 *
 *  Unlike a stair court this joins one floor, not two: the upper end is the
 *  shaft's landing inside the lowest block, and the lower end is the tower's
 *  foot out in the open abyss, GROUND_CLIMB below it. There is no partner
 *  layout to agree with, which is exactly why the generator refuses to move the
 *  anchor — the foot and its doorway are sited against this, not against
 *  another block. */
export function groundStairDock(
  block: { l: Layout } & Origin,
  anchorId: number,
): VerticalStairDock | null {
  const a = block.l.verticalAnchors.find((v) => v.id === anchorId);
  if (!a) return null;
  const lx = a.x + [1, -1, 0, 0][a.dockDir];
  const ly = a.y + [0, 0, 1, -1][a.dockDir];
  const c = ly * block.l.N + lx;
  if (block.l.kind[c] !== FLOOR) return null;

  const x = block.ox + (a.x - (block.l.N - 1) / 2) * CELL;
  const z = block.oz + (a.y - (block.l.N - 1) / 2) * CELL;
  const upper = {
    x: block.ox + (lx - (block.l.N - 1) / 2) * CELL,
    y: block.oy + block.l.tier[c] * TH + 0.16,
    z: block.oz + (ly - (block.l.N - 1) / 2) * CELL,
  };
  const y0 = upper.y - GROUND_CLIMB;
  return {
    x, z, y0, y1: upper.y,
    side: a.dockDir ^ 1,
    // The foot's doorway faces the way the landing docks, so arriving from
    // below and walking out read as one axis.
    lower: { x, y: y0, z },
    upper,
  };
}
