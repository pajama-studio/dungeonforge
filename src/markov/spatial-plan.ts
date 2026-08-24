// DungeonForge adapter around the MarkovJunior-derived rewrite core.

import type { StoryRole, VerticalAnchor } from "../gen/dungeon";
import { hash3, mulberry32 } from "../gen/rng";
import { KEEP, MarkovGrid, MarkovProgram, RewriteRule, type Point3 } from "./grid";
import { findPath3D } from "./path";

export type MacroDir = 0 | 1 | 2 | 3 | 4;

export interface SpatialCell {
  mi: number;
  mj: number;
  mk: number;
  parent: number;
  dirFromParent: MacroDir | -1;
  district: number;
  role: StoryRole;
  joinFromParent: "origin" | "bridge" | "causeway" | "gallery" | "court" | "stair";
  landmark: boolean;
}

export interface SpatialPlanStats {
  spineCells: number;
  rewriteSteps: number;
  layers: number;
  verticalLinks: number;
  districts: number;
  fusedLinks: number;
  crossBlockCourts: number;
}

export interface SpatialPlan {
  cells: SpatialCell[];
  stats: SpatialPlanStats;
}

const MID_ROLES: readonly StoryRole[] = ["archive", "ossuary", "forge", "pilgrim", "overgrowth"];

/** Keep blocks as storage/LOD units while grouping the authored world into
 * irregular 2–5 block precincts. Horizontal members of one precinct receive
 * a broad architectural seam; story-chapter boundaries retain a true bridge. */
function assignDistricts(cells: Array<Omit<SpatialCell, "district" | "role" | "joinFromParent" | "landmark">>, seed: number): SpatialCell[] {
  const district = new Int16Array(cells.length).fill(-1);
  const sizes: number[] = [];
  let nextDistrict = 0;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (cell.parent < 0) {
      district[i] = nextDistrict++;
      sizes[0] = 1;
      continue;
    }
    const parentDistrict = district[cell.parent];
    const vertical = cell.dirFromParent === 4;
    const size = sizes[parentDistrict];
    const blendChance = vertical ? 0.12 : size === 1 ? 0.94 : 0.8;
    const blend = size < 5 && hash3(seed ^ 0x44495354, i, cell.parent, cell.mk) < blendChance;
    if (blend) {
      district[i] = parentDistrict;
      sizes[parentDistrict]++;
    } else {
      district[i] = nextDistrict++;
      sizes[district[i]] = 1;
    }
  }

  const topLayer = Math.max(...cells.map((cell) => cell.mk));
  let landmark = 0;
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i], b = cells[landmark];
    if (a.mk > b.mk || (a.mk === b.mk && i > landmark)) landmark = i;
  }
  const roleByDistrict: StoryRole[] = sizes.map((_, d) => {
    if (d === district[0]) return "threshold";
    if (d === district[landmark]) return "sanctum";
    let minLayer = topLayer;
    for (let i = 0; i < cells.length; i++) if (district[i] === d) minLayer = Math.min(minLayer, cells[i].mk);
    const roll = Math.floor(hash3(seed ^ 0x53544f52, d, minLayer, sizes[d]) * MID_ROLES.length);
    return MID_ROLES[roll];
  });

  return cells.map((cell, i) => {
    const sameDistrict = cell.parent >= 0 && district[i] === district[cell.parent];
    const seamRoll = hash3(seed ^ 0x5345414d, i, cell.parent, district[i]);
    const joinFromParent = cell.parent < 0 ? "origin"
      : cell.dirFromParent === 4 ? "stair"
      : !sameDistrict ? "bridge"
      : seamRoll < 0.2 ? "court" : seamRoll < 0.52 ? "gallery" : "causeway";
    return {
      ...cell,
      district: district[i],
      role: roleByDistrict[district[i]],
      joinFromParent,
      landmark: i === landmark,
    };
  });
}

const pointKey = (p: Point3) => `${p.x},${p.y},${p.z}`;
const EMPTY_WAVE = 1 << 0, BLOCK_WAVE = 1 << 1;
const SPATIAL_RULES = [
  ...new RewriteRule([BLOCK_WAVE, EMPTY_WAVE], 2, 1, 1, [KEEP, 1], 1, "grow-horizontal")
    .squareSymmetries(),
  new RewriteRule([BLOCK_WAVE, EMPTY_WAVE], 1, 1, 2, [KEEP, 1], 2.4, "grow-upward"),
];

function direction(from: Point3, to: Point3): MacroDir {
  if (to.x > from.x) return 0;
  if (to.x < from.x) return 1;
  if (to.y > from.y) return 2;
  if (to.y < from.y) return 3;
  return 4;
}

/**
 * Generates one connected 3D block plan. A constrained A* spine guarantees
 * the vertical story, then ordered Markov rewrites grow optional branches.
 */
export function generateSpatialPlan(requestedCount: number, seed: number): SpatialPlan {
  const count = Math.max(1, Math.min(24, Math.round(requestedCount)));
  const mx = 9, my = 9;
  const layers = count >= 8 ? 6 : Math.min(count, Math.max(1, 1 + Math.floor(count / 2)));
  const grid = new MarkovGrid(mx, my, layers, ["E", "B"]);
  const random = mulberry32(seed ^ 0x4d4a3230);
  const start = { x: 4, y: 4, z: 0 };
  const horizontalBudget = Math.max(0, count - layers);
  const goalDistance = Math.min(4, horizontalBudget);
  const sx = random() < 0.5 ? -1 : 1;
  const sy = random() < 0.5 ? -1 : 1;
  const xDistance = goalDistance === 0 ? 0 : Math.floor(random() * (goalDistance + 1));
  const goal = {
    x: start.x + sx * xDistance,
    y: start.y + sy * (goalDistance - xDistance),
    z: layers - 1,
  };
  const spine = findPath3D({
    mx, my, mz: layers, start, goal,
    // Down is deliberately absent: the global route progresses upward, while
    // horizontal steps can occur before, between or after climbs.
    moves: [
      { dx: 1, dy: 0, dz: 0, cost: 1 }, { dx: -1, dy: 0, dz: 0, cost: 1 },
      { dx: 0, dy: 1, dz: 0, cost: 1 }, { dx: 0, dy: -1, dz: 0, cost: 1 },
      { dx: 0, dy: 0, dz: 1, cost: 1.04 },
    ],
    jitter: (x, y, z) => hash3(seed ^ 0x5350494e, x, y, z) * 0.075,
  }) ?? [start];

  const inserted: Point3[] = [];
  const parentByPoint = new Map<string, string | null>();
  for (let i = 0; i < spine.length; i++) {
    const p = spine[i];
    if (grid.get(p.x, p.y, p.z) === 1) continue;
    grid.set(p.x, p.y, p.z, 1);
    inserted.push(p);
    parentByPoint.set(pointKey(p), i > 0 ? pointKey(spine[i - 1]) : null);
  }

  // Vertical weight offsets the four horizontal orientations without making
  // a vertical column compulsory at every frontier cell.
  const program = new MarkovProgram(grid, SPATIAL_RULES);
  program.initializeAround(spine);

  while (inserted.length < count) {
    const event = program.step(random);
    if (!event) break;
    const child = event.changes.find((change) => change.from === 0 && change.to === 1);
    if (!child) continue;
    const rule = SPATIAL_RULES[event.match.rule];
    let source: Point3 | null = null;
    let at = 0;
    for (let z = 0; z < rule.mz; z++) for (let y = 0; y < rule.my; y++) for (let x = 0; x < rule.mx; x++, at++) {
      if ((rule.input[at] & BLOCK_WAVE) === 0 || rule.output[at] !== KEEP) continue;
      source = { x: event.match.x + x, y: event.match.y + y, z: event.match.z + z };
    }
    const p = { x: child.x, y: child.y, z: child.z };
    inserted.push(p);
    parentByPoint.set(pointKey(p), source ? pointKey(source) : pointKey(start));
  }

  const indexByPoint = new Map(inserted.map((p, i) => [pointKey(p), i]));
  const bareCells: Array<Omit<SpatialCell, "district" | "role" | "joinFromParent" | "landmark">> = inserted.map((p, i) => {
    const parentKey = parentByPoint.get(pointKey(p));
    const parent = parentKey === null || parentKey === undefined ? -1 : (indexByPoint.get(parentKey) ?? -1);
    return {
      mi: p.x - start.x,
      mj: p.y - start.y,
      mk: p.z,
      parent,
      dirFromParent: parent < 0 ? -1 : direction(inserted[parent], p),
    };
  });
  const cells = assignDistricts(bareCells, seed);
  return {
    cells,
    stats: {
      spineCells: spine.length,
      rewriteSteps: Math.max(0, cells.length - spine.length),
      layers: 1 + Math.max(...cells.map((cell) => cell.mk)),
      verticalLinks: cells.filter((cell) => cell.dirFromParent === 4).length,
      districts: 1 + Math.max(...cells.map((cell) => cell.district)),
      fusedLinks: cells.filter((cell) =>
        cell.joinFromParent === "causeway" || cell.joinFromParent === "gallery" || cell.joinFromParent === "court").length,
      crossBlockCourts: cells.filter((cell) => cell.joinFromParent === "court").length,
    },
  };
}

interface AnchorCandidate { x: number; y: number; dockDir: 0 | 1 | 2 | 3; weight: number }

/**
 * WFC-style domain collapse for shared stair courts. Every selected court is
 * propagated to both blocks and removes nearby candidates from their domains.
 */
export function planVerticalAnchors(cells: readonly SpatialCell[], blockN: readonly number[], seed: number): VerticalAnchor[][] {
  const result: VerticalAnchor[][] = cells.map(() => []);
  const edges = cells.map((cell, child) => ({ child, parent: cell.parent }))
    .filter(({ child, parent }) => parent >= 0 && cells[child].dirFromParent === 4);
  const used: AnchorCandidate[][] = cells.map(() => []);
  const pending = new Set(edges.map((_, i) => i));
  const random = mulberry32(seed ^ 0x414e4348);

  const domain = (edgeIndex: number, minSeparation: number): AnchorCandidate[] => {
    const edge = edges[edgeIndex];
    const radius = Math.max(1, Math.floor((Math.min(blockN[edge.parent], blockN[edge.child]) - 1) / 2) - 5);
    const tx = Math.round((hash3(seed, edge.child, 11, 3) - 0.5) * radius * 1.55);
    const ty = Math.round((hash3(seed, edge.child, 17, 5) - 0.5) * radius * 1.55);
    const candidates: AnchorCandidate[] = [];
    for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) for (let d = 0; d < 4; d++) {
      const conflict = [...used[edge.parent], ...used[edge.child]].some((other) =>
        Math.max(Math.abs(other.x - x), Math.abs(other.y - y)) < minSeparation);
      if (conflict) continue;
      const targetDistance = Math.abs(x - tx) + Math.abs(y - ty);
      const directionBias = d === ((Math.floor(hash3(seed, edge.child, 29, 7) * 4)) & 3) ? 1.6 : 1;
      const interiorBias = 1 + (radius - Math.max(Math.abs(x), Math.abs(y))) * 0.08;
      candidates.push({ x, y, dockDir: d as 0 | 1 | 2 | 3, weight: directionBias * interiorBias / (1 + targetDistance * 0.22) });
    }
    return candidates;
  };

  while (pending.size > 0) {
    let chosenEdge = -1;
    let chosenDomain: AnchorCandidate[] = [];
    // Minimum remaining values is the WFC entropy decision. Relaxation is
    // deterministic and only matters for unusually dense vertical junctions.
    for (let separation = 6; separation >= 2 && chosenEdge < 0; separation--) {
      for (const edgeIndex of pending) {
        const candidates = domain(edgeIndex, separation);
        if (candidates.length === 0) continue;
        if (chosenEdge < 0 || candidates.length < chosenDomain.length) {
          chosenEdge = edgeIndex;
          chosenDomain = candidates;
        }
      }
    }
    if (chosenEdge < 0) break;
    let total = chosenDomain.reduce((sum, candidate) => sum + candidate.weight, 0);
    let roll = random() * total;
    let selected = chosenDomain[chosenDomain.length - 1];
    for (const candidate of chosenDomain) {
      roll -= candidate.weight;
      if (roll <= 0) { selected = candidate; break; }
    }
    const edge = edges[chosenEdge];
    used[edge.parent].push(selected);
    used[edge.child].push(selected);
    const lowerN = blockN[edge.parent], upperN = blockN[edge.child];
    result[edge.parent].push({
      id: edge.child,
      x: (lowerN - 1) / 2 + selected.x,
      y: (lowerN - 1) / 2 + selected.y,
      dockDir: selected.dockDir,
    });
    result[edge.child].push({
      id: edge.child,
      x: (upperN - 1) / 2 + selected.x,
      y: (upperN - 1) / 2 + selected.y,
      dockDir: selected.dockDir,
    });
    pending.delete(chosenEdge);
  }
  return result;
}

/** Vertical anchors are identified by the child cell they join, so every id is a
 *  real cell index. The ground shaft joins nothing above it — it is the bottom
 *  of the world — so it takes an id no cell can have, and the parent/child
 *  pairing lookups in world/helpers.ts simply never match it. */
export const GROUND_ANCHOR_ID = -1;

/** Same transform the generator applies to unrotate a world-space anchor
 *  request back into grid space (`[x, y] = [N - 1 - y, x]`, rot times). */
function toGrid(x: number, y: number, rot: number, N: number): [number, number] {
  for (let i = 0; i < (rot & 3); i++) [x, y] = [N - 1 - y, x];
  return [x, y];
}

export interface GroundEntrance {
  /** spatial cell index of the block that owns the way in */
  block: number;
  /** the shaft, in that block's grid space — reserved exactly like a stair court */
  anchor: VerticalAnchor;
  /** which way the doorway at the tower's foot faces, in that block's grid space */
  doorDir: 0 | 1 | 2 | 3;
}

/**
 * Site the one place a player enters the world.
 *
 * **Which block.** The plan's root: it is always cell 0, always `mk === 0`, and
 * always carries the `threshold` role — measured across 80 seeds, no exceptions.
 * The plan already calls its origin the threshold; this puts a door there.
 *
 * The TODO asks for the lowest block *nearest the Cthulhu monument*, which
 * cannot be honoured here and should not be: the abyss landmarks are positioned
 * by `fit()` against the finished chain's bounding circle, long after this runs.
 * Ranking blocks by a distance that does not exist yet would be guesswork.
 * The dependency is better the other way round — the entrance is structural, and
 * the monument is aimed at it — which makes the establishing shot a construction
 * rather than a coincidence.
 *
 * **Where in the block.** The same domain rule as a stair court, biased south and
 * away from the block's north-centre temple, because the doorway wants open
 * ground in front of it rather than a ziggurat terrace.
 */
export function planGroundEntrance(
  cells: readonly SpatialCell[],
  blockN: readonly number[],
  seed: number,
  verticalByBlock: readonly (readonly VerticalAnchor[])[],
  /** the rot the forge will hand each block. Anchors are requested in finished
   *  (world) space and unrotated inside the generator, but the temple is stamped
   *  in grid space — so an exclusion tested in the wrong one of those two spaces
   *  silently protects the wrong quarter of the block. Indexed by block, because
   *  which block this is gets decided in here. */
  rots: readonly number[] = [],
): GroundEntrance | null {
  const block = cells.findIndex((cell) => cell.parent < 0 && cell.mk === 0);
  if (block < 0) return null;

  const N = blockN[block];
  // Same margin a stair court needs: the 7x7 reservation has to stay inside the
  // boundary wall, and the ring may not be trimmed away by the footprint.
  const radius = Math.max(1, Math.floor((N - 1) / 2) - 5);
  const taken = verticalByBlock[block] ?? [];
  const centre = (N - 1) / 2;
  const random = mulberry32(seed ^ 0x47524e44);
  const rot = rots[block] ?? 0;

  for (let separation = 6; separation >= 2; separation--) {
    const candidates: { x: number; y: number; dockDir: 0 | 1 | 2 | 3; weight: number }[] = [];
    for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
      const gx = centre + x, gy = centre + y;
      const clash = taken.some((other) =>
        Math.max(Math.abs(other.x - gx), Math.abs(other.y - gy)) < separation);
      if (clash) continue;

      // Everything below is about the temple and the centre spine, both of
      // which live in grid space, so test the grid position rather than the
      // requested one.
      const [tx, ty] = toGrid(gx, gy, rot, N);

      // Hard exclusion: the temple platform runs [centre-5, centre+5] across
      // rows 1..5 with its forecourt on row 6, and Stage 4 yields to a shaft
      // reservation when they overlap (`if (shaftReserve[...]) continue`). So a
      // shaft sited there does not fail — it punches a hole through the
      // ziggurat, which is worse than failing. The 7x7 reserve must clear it.
      if (Math.abs(tx - centre) <= 8 && ty - 3 <= 6) continue;
      // South of centre, and off the centre spine: the temple platform runs
      // across the north-centre and the spine carries the objective route.
      const south = 1 + Math.max(0, ty - centre) / Math.max(1, radius) * 1.4;
      const offSpine = 1 + Math.min(Math.abs(tx - centre), 4) * 0.12;
      const interior = 1 + (radius - Math.max(Math.abs(x), Math.abs(y))) * 0.05;
      for (let d = 0; d < 4; d++) {
        // The foot's door faces the way the interior landing docks, so arriving
        // from below and leaving on foot read as one axis.
        const outward = d === 2 ? 1.7 : d === 3 ? 0.5 : 1;
        candidates.push({
          x: gx, y: gy, dockDir: d as 0 | 1 | 2 | 3,
          weight: south * offSpine * interior * outward,
        });
      }
    }
    if (candidates.length === 0) continue;

    let roll = random() * candidates.reduce((sum, c) => sum + c.weight, 0);
    let chosen = candidates[candidates.length - 1];
    for (const candidate of candidates) {
      roll -= candidate.weight;
      if (roll <= 0) { chosen = candidate; break; }
    }
    return {
      block,
      anchor: { id: GROUND_ANCHOR_ID, x: chosen.x, y: chosen.y, dockDir: chosen.dockDir },
      doorDir: chosen.dockDir,
    };
  }
  return null;
}
