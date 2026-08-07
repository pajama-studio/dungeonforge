// Shared world constants — the single source of truth for scale and budgets.
// Every system reads these; nothing redefines them locally.

/** world height per tier */
export const TH = 1.85;
/** world size per grid cell */
export const CELL = 2.2;
/** one masonry course = half a tier */
export const COURSE = TH / 2;
/** ravine is always 3 cells + 2×0.4-cell setback */
export const BRIDGE_SPAN = 3.2 * CELL;
/** world units of abyss between linked blocks */
export const ISLAND_GAP = 15;
/** mid-span RISE of the stone arch bridges linking blocks — one function
 *  shared by the bridge mesh, the walkmap ground sampler and nav tracing,
 *  so the drawn deck IS the surface the walker stands on */
export const linkArc = (dist: number): number => Math.min(1.5, dist * 0.055);

/** FIXED global light pool size: three's WebGPU forward path recompiles every
 *  pipeline whenever the scene's light count changes — so the count never does. */
export const LIGHT_POOL_SIZE = 28;

/** fill rate is the budget: bigger worlds render at a slightly lower ratio */
export const PR_BASE = 1.5;
export const PR_LARGE = 1.25;

/** distance LOD with hysteresis: detail turns ON nearer than LOD_NEAR and only
 *  OFF again past LOD_FAR, so a camera hovering at the boundary never thrashes
 *  geometry swaps */
export const LOD_NEAR = 95;
export const LOD_FAR = 112;

/** Square spiral staircase (old-stairwell style): flights wind around a square
 *  core with corner turns. */
export const STAIR = {
  A: 1.35,    // outer half-width of the stair square
  M: 0.95,    // mid-ring half-width (tread centerline)
  CORE: 0.5,  // solid core half-width
  STEP: 0.46, // tread run along the perimeter
  RISE: 0.27, // rise per tread
} as const;
