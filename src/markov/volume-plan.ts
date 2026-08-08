// Local 3D structural grammar: a small Markov volume is projected into the
// existing heightfield layout as connected split-level rooms and galleries.

import { hash3, mulberry32 } from "../gen/rng";
import { KEEP, MarkovGrid, MarkovProgram, RewriteRule, type RewriteMatch } from "./grid";

export interface VolumeExclusion { x: number; y: number; radius: number }

export interface InteriorVolumePlan {
  /** Per maze cell height contribution in tiers (-1..2). */
  bias: Int8Array;
  /** Cells directly authored by the 3D grammar. */
  mask: Uint8Array;
  occupied: number;
  levels: number;
  rewriteSteps: number;
}

const E = 1 << 0, F = 1 << 1, ANY = E | F;
const VOLUME_RULES = [
  ...new RewriteRule([F, E], 2, 1, 1, [KEEP, 1], 1.15, "room-grow").squareSymmetries(),
  ...new RewriteRule(
    [F, ANY, ANY, E], 2, 1, 2,
    [KEEP, KEEP, KEEP, 1], 2.1, "room-step-up",
  ).squareSymmetries(),
  ...new RewriteRule(
    [ANY, E, F, ANY], 2, 1, 2,
    [KEEP, 1, KEEP, KEEP], 1.65, "room-step-down",
  ).squareSymmetries(),
];
const VOLUME_TARGET_OFFSETS = VOLUME_RULES.map((rule) => {
  let p = 0;
  for (let z = 0; z < rule.mz; z++) for (let y = 0; y < rule.my; y++) for (let x = 0; x < rule.mx; x++, p++) {
    if (rule.output[p] === 1 && (rule.input[p] & E) !== 0) return { x, y, z };
  }
  return null;
});

/**
 * Grows a connected set of room-floor voxels. Step-up/step-down rewrite
 * patterns move sideways and vertically together, so the projection remains
 * navigable instead of becoming disconnected piles of voxels.
 */
export function generateInteriorVolumePlan(
  size: number,
  seed: number,
  exclusions: readonly VolumeExclusion[] = [],
): InteriorVolumePlan {
  const M = Math.max(7, Math.round(size));
  const mz = 4;
  const grid = new MarkovGrid(M, M, mz, ["E", "F"]);
  const random = mulberry32(seed ^ 0x564f4c33);
  const reserved = (x: number, y: number) => exclusions.some((e) => Math.max(Math.abs(x - e.x), Math.abs(y - e.y)) <= e.radius);

  let sx = Math.max(2, Math.min(M - 3, Math.round(M * (0.3 + random() * 0.4))));
  let sy = Math.max(3, Math.min(M - 3, Math.round(M * (0.34 + random() * 0.48))));
  for (let attempt = 0; attempt < 16 && reserved(sx, sy); attempt++) {
    sx = 2 + Math.floor(random() * Math.max(1, M - 4));
    sy = 3 + Math.floor(random() * Math.max(1, M - 5));
  }
  grid.set(sx, sy, 1, 1);

  // Flattened rule order is x, then y, then z. Step rules move laterally and
  // vertically together, like StairsPath's stair rewrites.
  const program = new MarkovProgram(grid, VOLUME_RULES);
  program.initializeAround([{ x: sx, y: sy, z: 1 }]);
  const usedColumns = new Uint8Array(M * M);
  usedColumns[sy * M + sx] = 1;
  const targetOf = (match: RewriteMatch) => {
    const offset = VOLUME_TARGET_OFFSETS[match.rule];
    return offset ? { x: match.x + offset.x, y: match.y + offset.y, z: match.z + offset.z } : null;
  };
  const accept = (match: RewriteMatch, _rule: RewriteRule) => {
    const target = targetOf(match);
    if (!target) return false;
    if (target.x < 2 || target.y < 3 || target.x >= M - 2 || target.y >= M - 2) return false;
    if (reserved(target.x, target.y) || usedColumns[target.y * M + target.x]) return false;
    // A small spatial field prevents one grammar from filling every block in
    // exactly the same round blob while keeping the accepted region compact.
    return hash3(seed ^ 0x4649454c, target.x, target.y, target.z) > 0.08;
  };

  const targetCells = Math.max(10, Math.min(42, Math.round(M * 1.7)));
  const events = [];
  for (let step = 1; step < targetCells; step++) {
    const event = program.step(random, accept);
    if (!event) break;
    events.push(event);
    const target = targetOf(event.match);
    if (target) usedColumns[target.y * M + target.x] = 1;
  }
  const bias = new Int8Array(M * M);
  const mask = new Uint8Array(M * M);
  let minLevel = mz, maxLevel = -1, occupied = 0;
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    let level = -1;
    for (let z = 0; z < mz; z++) if (grid.get(x, y, z) === 1) level = Math.max(level, z);
    if (level < 0) continue;
    const c = y * M + x;
    mask[c] = 1;
    bias[c] = level - 1;
    minLevel = Math.min(minLevel, level);
    maxLevel = Math.max(maxLevel, level);
    occupied++;
  }
  return {
    bias, mask, occupied,
    levels: maxLevel < 0 ? 0 : maxLevel - minLevel + 1,
    rewriteSteps: events.length,
  };
}
