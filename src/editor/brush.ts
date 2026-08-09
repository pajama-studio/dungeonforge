// Scatter brush. Placing rubble one crate at a time does not dress a
// dungeon; a stroke does.
//
// The spacing rule lives here as a pure function because it is the part that
// decides whether a stroke feels like a brush or like a stutter, and it is
// the part most likely to be wrong.

import * as THREE from "three/webgpu";

export interface BrushSettings {
  /** world-space radius of the scatter disc under the cursor */
  radius: number;
  /** how far the cursor must travel before another dab is considered */
  spacing: number;
  /** dabs dropped per qualifying step */
  density: number;
  /** hard stop, so a slow drag over a big mesh can't spawn thousands */
  maxDabs: number;
}

export const DEFAULT_BRUSH: BrushSettings = {
  radius: 4,
  spacing: 2.5,
  density: 1,
  maxDabs: 400,
};

/** Should a dab be placed at `point`, given where the last one landed?
 *
 *  Distance-gated rather than time-gated: a fast drag and a slow drag lay
 *  down the same density, which is what makes a brush feel like a brush. */
export function shouldDab(
  point: THREE.Vector3,
  lastDab: THREE.Vector3 | null,
  spacing: number,
): boolean {
  if (!lastDab) return true;
  return point.distanceToSquared(lastDab) >= spacing * spacing;
}

/** Offset a dab within the brush disc, on the plane of the surface.
 *
 *  Uses sqrt on the radius so samples spread evenly over the disc's AREA —
 *  without it every stroke crowds its own centre line. Deterministic in
 *  `seed` so a stroke replays identically. */
export function dabOffset(
  normal: THREE.Vector3,
  radius: number,
  seed: number,
  hash01: (n: number) => number,
): THREE.Vector3 {
  const angle = hash01(seed * 2654435761) * Math.PI * 2;
  const distance = Math.sqrt(hash01(seed * 40503 + 7)) * radius;
  // any vector not parallel to the normal gives us a tangent basis
  const reference = Math.abs(normal.y) > 0.9
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3().crossVectors(normal, reference).normalize();
  const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();
  return tangent.multiplyScalar(Math.cos(angle) * distance)
    .addScaledVector(bitangent, Math.sin(angle) * distance);
}
