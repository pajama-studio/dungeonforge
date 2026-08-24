// Turning a Layout into atom placements.
//
// The generator says where floors and walls are; this decides which cells earn
// a piece of dressing and which atom goes there. Placement is hashed per cell,
// never drawn from an RNG stream, so it is independent of iteration order.

import { FLOOR, WALL, type Dir, type Layout, type StoryRole } from "../gen/dungeon";
import { hash2 } from "../gen/rng";
import { resolve } from "./registry";
import type { AtomPlacement, SocketSet, SocketType } from "./types";

const DX = [1, -1, 0, 0] as const;
const DY = [0, 0, 1, -1] as const;

/** Sockets the four neighbours of a cell demand of whatever sits in it. */
export function requiredSockets(l: Layout, x: number, y: number): Partial<SocketSet> {
  const N = l.N;
  const keys = ["px", "nx", "py", "ny"] as const;
  const out: Partial<SocketSet> = {};
  for (let d = 0; d < 4; d++) {
    const nx = x + DX[d];
    const ny = y + DY[d];
    if (nx < 0 || ny < 0 || nx >= N || ny >= N) {
      out[keys[d]] = "ABYSS";
      continue;
    }
    const kind = l.kind[ny * N + nx];
    let socket: SocketType;
    if (kind === FLOOR) socket = "FLOOR";
    else if (kind === WALL) socket = "WALL";
    else socket = "ABYSS";
    out[keys[d]] = socket;
  }
  return out;
}

/** Floor cells with exactly one walkable neighbour.
 *
 *  Dead ends are where dressing pays: the player has to walk in and turn
 *  around, so they look at whatever is there. Corridors are passed through at
 *  speed and do not repay the draw call. */
export function deadEnds(l: Layout): Array<{ x: number; y: number; facing: Dir }> {
  const N = l.N;
  const out: Array<{ x: number; y: number; facing: Dir }> = [];
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      if (l.kind[y * N + x] !== FLOOR) continue;
      let open = 0;
      let openDir: Dir = 0;
      for (let d = 0; d < 4; d++) {
        if (l.kind[(y + DY[d]) * N + (x + DX[d])] === FLOOR) {
          open++;
          openDir = d as Dir;
        }
      }
      // Face the piece back down the corridor the player arrives from.
      if (open === 1) out.push({ x, y, facing: openDir });
    }
  }
  return out;
}

export interface DressingOptions {
  /** Fraction of eligible dead ends that get a piece. Full saturation reads as
   *  a showroom rather than a ruin. */
  density?: number;
  /** Minimum Chebyshev spacing, so pieces do not clump in a braided pocket. */
  spacing?: number;
}

/** Choose role dressing for a layout. Pure: same Layout in, same list out. */
export function planRoleDressing(
  l: Layout,
  options: DressingOptions = {},
): AtomPlacement[] {
  const role: StoryRole = l.params.narrativeRole ?? "threshold";
  const decay = l.params.decay ?? 0.5;
  const density = options.density ?? 0.55;
  const spacing = options.spacing ?? 3;

  const placements: AtomPlacement[] = [];
  const taken: Array<{ x: number; y: number }> = [];

  for (const cell of deadEnds(l)) {
    // Two independent hashes: one decides whether to dress the cell, one picks
    // the atom. Sharing a single hash would couple "is it dressed" to "which
    // atom", so raising density would also reshuffle every existing choice.
    if (hash2(l.seed ^ 0x51ed270b, cell.x, cell.y) > density) continue;

    if (taken.some((t) => Math.max(Math.abs(t.x - cell.x), Math.abs(t.y - cell.y)) < spacing)) {
      continue;
    }

    const tier = l.tier[cell.y * l.N + cell.x];
    const picked = resolve(
      "role-dressing",
      { role, decay, tier, hash: hash2(l.seed ^ 0x2f9e3b17, cell.x, cell.y) },
      requiredSockets(l, cell.x, cell.y),
    );
    if (!picked) continue;

    placements.push({
      atomId: picked.def.id,
      x: cell.x,
      y: cell.y,
      tier,
      rotation: picked.rotation,
    });
    taken.push({ x: cell.x, y: cell.y });
  }

  return placements;
}
