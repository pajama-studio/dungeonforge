// Per-placement variance. A row of crates placed by hand should not read as
// a row of clones, and a scattered rubble field least of all.
//
// The jitter is a pure function of a seed, never Math.random: a scatter
// stroke has to reproduce exactly when a saved scene is reloaded, and the
// project's whole generation model is "same seed, same world".

/** 32-bit integer hash → [0,1). Same mulberry-ish mixing the generator uses. */
export function hash01(seed: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface VarianceSettings {
  /** full rotation about Y, in radians — 0 disables yaw jitter */
  yaw: number;
  /** ± fraction of the base scale, e.g. 0.25 for ±25% */
  scale: number;
  /** ± radians of random tilt away from the surface normal */
  tilt: number;
}

export const NO_VARIANCE: VarianceSettings = { yaw: 0, scale: 0, tilt: 0 };

export interface VarianceSample {
  yaw: number;
  tiltX: number;
  tiltZ: number;
  scale: number;
}

/** Draw one deterministic sample. `seed` should be unique per placement —
 *  the scatter brush passes a running index so a stroke is reproducible. */
export function sampleVariance(settings: VarianceSettings, seed: number): VarianceSample {
  const centred = (n: number) => hash01(seed * 7919 + n) * 2 - 1;
  return {
    yaw: settings.yaw > 0 ? hash01(seed * 7919 + 1) * settings.yaw : 0,
    tiltX: settings.tilt > 0 ? centred(2) * settings.tilt : 0,
    tiltZ: settings.tilt > 0 ? centred(3) * settings.tilt : 0,
    scale: 1 + centred(4) * settings.scale,
  };
}
