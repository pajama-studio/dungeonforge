const REFERENCE_ASPECT = 4 / 3;
const BASE_VERTICAL_FOV = 36;

function portraitProgress(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0 || aspect >= REFERENCE_ASPECT) return 0;
  return Math.min(1, Math.max(0, (REFERENCE_ASPECT - aspect) / (REFERENCE_ASPECT - 0.75)));
}

/**
 * Preserve the authored two-subject establishing shot on narrow canvases.
 * PerspectiveCamera's vertical FOV is fixed, so portrait layouts otherwise
 * lose the dungeon and oracle beyond the right edge. The cap deliberately
 * keeps the dragon/skull large enough to remain the primary read on phones.
 */
export function establishingDistanceScale(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return 1;
  return 1 + portraitProgress(aspect) * 0.15;
}

/** A wider portrait FOV supplies most of the missing horizontal coverage
 * without pushing the landmarks deep enough into the distance haze. */
export function establishingVerticalFov(aspect: number): number {
  return BASE_VERTICAL_FOV + portraitProgress(aspect) * 10;
}

/** Shift the narrow shot slightly back toward the dungeon while retaining the
 * dragon-weighted composition used at 4:3 and wider. */
export function establishingLandmarkWeight(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect >= REFERENCE_ASPECT) return 0.78;
  return 0.78 - portraitProgress(aspect) * 0.1;
}
