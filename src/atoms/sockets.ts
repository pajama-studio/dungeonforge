// Socket compatibility — the connection rules.
//
// Two atoms may sit side by side only if their facing sockets mate. The rules
// are asymmetric in one place (OPEN needs FLOOR on both sides), so the check
// takes the pair rather than a per-socket predicate.

import type { SocketSet, SocketType } from "./types";

/** Can socket `a` face socket `b` across a cell boundary?
 *
 *  A wall is always legal against anything — that is what makes the maze
 *  renderable no matter what the solver produced. The restrictive cases are
 *  OPEN (a doorway onto solid rock is a modelling error, not a style choice)
 *  and STAIR (which needs floor to land on). */
export function canMate(a: SocketType, b: SocketType): boolean {
  // OPEN is checked before the wall shortcut deliberately. A doorway facing
  // solid masonry is a doorway into rock — the same error as one facing the
  // void, and the reason this check cannot come second.
  if (a === "OPEN" || b === "OPEN") {
    // A doorway must open onto something walkable, or onto another doorway
    // (two arches back to back form a passage).
    const other = a === "OPEN" ? b : a;
    return other === "FLOOR" || other === "OPEN" || other === "STAIR";
  }
  if (a === "WALL" || b === "WALL") return true;
  if (a === "ABYSS" || b === "ABYSS") {
    // The void only meets the void. A floor that ends at the abyss needs an
    // edge piece, which declares ABYSS on that face itself.
    return a === b;
  }
  if (a === "STAIR" || b === "STAIR") {
    const other = a === "STAIR" ? b : a;
    return other === "FLOOR" || other === "STAIR";
  }
  return a === "FLOOR" && b === "FLOOR";
}

const ORDER = ["px", "nx", "py", "ny"] as const;

/** Rotate a socket set by `steps` × 90°.
 *
 *  Directions are ordered +x, -x, +y, -y to match the generator's Dir. That
 *  ordering is NOT a rotation cycle, so rotating means walking the geometric
 *  cycle (+x → +y → -x → -y) rather than shifting the array — getting this
 *  wrong mirrors pieces instead of turning them. */
export function rotateSockets(sockets: SocketSet, steps: number): SocketSet {
  const cycle = ["px", "py", "nx", "ny"] as const; // clockwise in grid space
  const n = ((steps % 4) + 4) % 4;
  const out = { ...sockets };
  for (let i = 0; i < cycle.length; i++) {
    const from = cycle[i];
    const to = cycle[(i + n) % cycle.length];
    out[to] = sockets[from];
  }
  return out;
}

/** Does an atom, rotated by `steps`, satisfy the sockets its cell requires?
 *  `required` uses undefined for "don't care". */
export function fits(
  atom: SocketSet,
  required: Partial<SocketSet>,
  steps = 0,
): boolean {
  const turned = rotateSockets(atom, steps);
  return ORDER.every((dir) => {
    const need = required[dir];
    return need === undefined || canMate(turned[dir], need);
  });
}

/** The first rotation (0..3) that fits, or null when the atom cannot be used
 *  in this cell at any orientation. */
export function fittingRotation(
  atom: SocketSet,
  required: Partial<SocketSet>,
): number | null {
  for (let steps = 0; steps < 4; steps++) {
    if (fits(atom, required, steps)) return steps;
  }
  return null;
}

export const uniformSockets = (type: SocketType): SocketSet => ({
  px: type, nx: type, py: type, ny: type,
});
