// The abyss floor's height field.
//
// This was written inline inside buildEnvironment(), straight into the bedrock
// plane's vertex buffer, which made the floor's shape knowable only by reading a
// vertex back or raycasting the mesh. CLAUDE.md principle 8 rules the raycast
// out and names a pure function that did not exist:
//
//   Analytic over raycast. Ground height is a pure function (terrainHeight(x,z)),
//   used for grounding, placement and scatter — never a mesh raycast.
//
// So here it is. The mesh now asks the same question every other consumer asks —
// the entrance tower's footing, the bedrock piers, prop grounding, first-person
// gravity — and there is one answer instead of one per caller.
//
// COORDINATES ARE BEDROCK-LOCAL. The plane spans ±450 about its own origin and
// lives in ringGroup, which fit() recentres and rescales with the chain, so a
// world position must be taken into that space before asking. Callers that have
// a world position want `worldToAbyssFloor()` in the environment handle rather
// than passing world x/z straight in.
import { valueNoise2 } from "../gen/rng";
import { TH } from "../config";
import { ABYSS } from "../gen/dungeon";

/** Shape of the field. Broad low-frequency terraces establish the geological
 *  masses, a short eased ramp connects each plateau, and a restrained fBM pass
 *  weathers the otherwise mathematical steps. */
export const ABYSS_FLOOR = {
  /** plateaus per unit of macro noise */
  terraceSteps: 7,
  /** fraction of each step spent on the connecting ramp */
  terraceRamp: 0.2,
  /** peak-to-peak height of the terraced masses */
  plateauAmplitude: 18,
  /** mid-frequency weathering that breaks the step edges */
  weatherAmplitude: 3.6,
  /** high-frequency grain, below the mesh's own resolution at range */
  microAmplitude: 0.85,
  /** the plane is 900 units square, so it stays past the fog convergence */
  extent: 900,
  /** 72² cells: enough for the slow terraces, one static 10,368-triangle draw */
  segments: 72,
} as const;

/** World Y the bedrock mesh's own origin sits at. Height queries return relief
 *  about this plane, not about zero. */
export const ABYSS_FLOOR_BASE_Y = ABYSS * TH - 14;

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

/** Quantise a 0..1 height into plateaus joined by short smoothstep ramps. */
function terraced(height: number): number {
  const { terraceSteps, terraceRamp } = ABYSS_FLOOR;
  const scaled = clamp(height, 0, 0.999999) * terraceSteps;
  const level = Math.floor(scaled);
  const local = scaled - level;
  const ramp = clamp((local - (1 - terraceRamp)) / terraceRamp, 0, 1);
  const easedRamp = ramp * ramp * (3 - 2 * ramp);
  return (level + easedRamp) / terraceSteps;
}

/**
 * Relief of the abyss floor at a bedrock-local (x, z), about ABYSS_FLOOR_BASE_Y.
 *
 * Deterministic in `seed` alone — no Math.random, no cached state — so every
 * client computes the same floor and nothing about it is ever synced.
 */
export function abyssFloorHeight(seed: number, x: number, z: number): number {
  const macro = valueNoise2(seed ^ 0x6f4a12d9, x / 155, z / 155);
  const plateau = (terraced(macro) - 0.5) * ABYSS_FLOOR.plateauAmplitude;
  const weather = (valueNoise2(seed ^ 0x2c1b3a57, x / 31, z / 31) - 0.5) * ABYSS_FLOOR.weatherAmplitude;
  const micro = (valueNoise2(seed ^ 0x71e5b90d, x / 13, z / 13) - 0.5) * ABYSS_FLOOR.microAmplitude;
  return plateau + weather + micro;
}
