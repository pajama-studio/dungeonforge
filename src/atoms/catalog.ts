// The atom library.
//
// One signature set per StoryRole. Seven roles already exist in the generator
// and currently render identically; this is what makes them read as seven
// different places.
//
// Every entry is a free-standing prop that sits at a cell centre, so its
// sockets are WALL on all four faces — it never has to mate with a neighbour,
// which is exactly why text-to-3D can author it. Tiling geometry (walls,
// floors, stairs) stays procedural and gets its look from material instead.

import { getAtom, registerAtoms } from "./registry";
import { uniformSockets } from "./sockets";
import type { AtomDef } from "./types";

const PROPS = "https://props.pajama.studio/r";

/** Cell-centre dressing: solid on every face, one module square, one storey. */
function dressing(
  id: string,
  role: AtomDef["roles"],
  over: Partial<AtomDef> = {},
): AtomDef {
  return {
    id,
    slot: "role-dressing",
    roles: role,
    footprint: { w: 1, d: 1, h: 1 },
    sockets: uniformSockets("WALL"),
    weight: 1,
    // Resolved against the shelf at build time; see scripts/sync-atom-urls.mjs.
    source: { url: `${PROPS}/${id}`, scale: 1 },
    ...over,
  };
}

export const ATOMS: readonly AtomDef[] = [
  // ---- threshold: the edge of the known ---------------------------------
  dressing("atom-threshold-boundary-stone", ["threshold"]),
  dressing("atom-threshold-warding-post", ["threshold"]),

  // ---- archive: stored knowledge, mostly lost ---------------------------
  // The bookcase is authored collapsed, so it wants some decay behind it.
  dressing("atom-archive-bookcase", ["archive"], { minDecay: 0.25 }),
  dressing("atom-archive-lectern", ["archive"]),

  // ---- ossuary: the dead, stacked --------------------------------------
  dressing("atom-ossuary-bone-rack", ["ossuary"]),
  // Already on the shelf from The Drowned Court.
  dressing("court-votive-heads", ["ossuary"], { weight: 0.7 }),

  // ---- forge: work, heat, waste ----------------------------------------
  dressing("atom-forge-anvil-block", ["forge"]),
  dressing("atom-forge-slag-heap", ["forge"], { minDecay: 0.2 }),

  // ---- pilgrim: passage and offering -----------------------------------
  dressing("court-lamp-hermit", ["pilgrim"]),
  dressing("atom-threshold-boundary-stone-pilgrim", ["pilgrim"], {
    // The same waystone form serves both roles; registered twice rather than
    // widening `roles`, so each role's mix can be weighted independently.
    source: { url: `${PROPS}/atom-threshold-boundary-stone`, scale: 1 },
    weight: 0.6,
  }),

  // ---- overgrowth: the dungeon losing ----------------------------------
  dressing("atom-overgrowth-root-mass", ["overgrowth"]),
  dressing("atom-overgrowth-fungal-shelf", ["overgrowth"]),

  // ---- sanctum: what is still worshipped -------------------------------
  dressing("atom-sanctum-censer", ["sanctum"]),
  dressing("court-many-handed-idol", ["sanctum"], { weight: 0.5 }),
];

/** Register the library. Idempotent so hot reload does not throw on duplicate
 *  ids, which would otherwise take the whole scene down mid-session.
 *
 *  Idempotence is derived from the registry rather than a module-level flag: a
 *  flag goes stale the moment anything clears the registry, and then this
 *  returns early and registers nothing at all. */
export function installAtoms(): void {
  if (ATOMS.length === 0 || getAtom(ATOMS[0].id)) return;
  registerAtoms(ATOMS);
}
