// The atom layer: a declarative vocabulary of dungeon pieces, sitting between
// the generator's Layout and the renderer.
//
// The generator already decides topology — where floors, walls, stairs and
// features go. It does not decide *which piece of geometry* renders each of
// those, and today build.ts answers that inline with hardcoded kit lookups.
// This layer makes the answer data: atoms declare what they are and where they
// fit, and a resolver picks one.
//
// Everything here is pure and deterministic. Placement is driven by hash2, not
// by an RNG stream, so results never depend on iteration order and every client
// computes the same dungeon — the project's standing constraint.

import type { StoryRole } from "../gen/dungeon";

/** What a cell face offers to its neighbour.
 *
 *  Deliberately small. A wave-function-collapse solver needs dozens of socket
 *  types because it invents topology; here the maze solver has already decided
 *  it, so sockets only validate what the generator produced. */
export type SocketType =
  | "FLOOR"   // walkable at this cell's tier
  | "WALL"    // solid masonry
  | "OPEN"    // doorway or arch punched through a wall
  | "ABYSS"   // faces the void
  | "STAIR";  // sloped tier change

/** The four grid directions, matching Dir in the generator (+x, -x, +y, -y) so
 *  the generator's existing direction fields drive rotation with no mapping. */
export interface SocketSet {
  px: SocketType;
  nx: SocketType;
  py: SocketType;
  ny: SocketType;
}

/** Which kind of question an atom answers. One slot per thing the generator
 *  can ask for; every slot has a procedural fallback so the dungeon renders
 *  with zero authored atoms registered. */
export type AtomSlot =
  | "wall"
  | "floor"
  | "stair"
  | "gate"
  | "fixture"        // torch bracket, brazier, banner
  | "role-dressing"  // the identity layer: one signature set per StoryRole
  | "landmark";      // the boss/story piece

/** Footprint in module units, not metres. 1 = one CELL in plan, one TH in
 *  height. Keeping atoms in module units is what stops seams: an atom that
 *  thinks in metres drifts the moment CELL changes. */
export interface Footprint {
  w: number;
  d: number;
  h: number;
}

export interface AtomDef {
  id: string;
  slot: AtomSlot;
  footprint: Footprint;
  sockets: SocketSet;
  /** Restrict to these narrative roles. Empty/undefined = any role. */
  roles?: readonly StoryRole[];
  /** Condition window this atom is appropriate for. A pristine altar should
   *  not appear in a collapsed ossuary, and rubble should not appear in a
   *  freshly built sanctum. */
  minDecay?: number;
  maxDecay?: number;
  /** Relative selection weight among equally valid candidates. */
  weight?: number;
  /** Where the geometry comes from. `kit` names a procedural geometry already
   *  in src/scene/kit; `url` streams a GLB (props.pajama.studio). */
  source: { kit: string } | { url: string; scale?: number };
}

/** Everything the resolver is allowed to consider. Passing the cell hash in,
 *  rather than letting the resolver draw from an RNG, is what keeps selection
 *  independent of the order cells are visited. */
export interface AtomContext {
  role: StoryRole;
  decay: number;
  tier: number;
  hash: number; // [0,1) from hash2(seed, x, y)
}

/** A resolved atom, positioned in grid space. The renderer converts to world
 *  space with CELL/TH; this layer never touches world units. */
export interface AtomPlacement {
  atomId: string;
  x: number;
  y: number;
  tier: number;
  /** 0..3, multiples of 90°, matching Dir. */
  rotation: number;
}

/** Condition knobs derived from what the generator already produces, rather
 *  than adding new authoring parameters that would have to be kept in sync. */
export interface StyleModifiers {
  age: number;
  damage: number;
  moss: number;
  corruption: number;
}
