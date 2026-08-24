// Instance metadata packing for the GPU-driven scene.
//
// Every managed instance carries its slot, LOD tier and geometry group packed
// into the alpha channel of its instance colour, because that is the one
// per-instance float already flowing to the compute pass. The shader unpacks it
// to decide visibility and which indirect bucket to append to.
//
// This lives in its own module, as plain arithmetic, for one reason: a mistake
// here does not throw and does not trip the GPU scene's fallback. It silently
// routes instances to the wrong bucket, and the scene renders garbage that no
// automated check would catch. Keeping the math testable is the only guard.

/** Zero means destroyed. Everything alive is offset by one. */
export const DEAD_META = 0;

/** LOD tiers per slot: 0 far, 1 middle, 2 high. Tier 0 is not drawn by the
 *  managed pools — the far tier collapses to different geometry entirely. */
export const LOD_TIERS = 4;

export interface InstanceMeta {
  slot: number;
  lod: number;
  group: number;
}

/** Pack slot + LOD + geometry group into one float.
 *
 *  Layout is (slot * LOD_TIERS + lod) * groupCount + group, then +1 so that
 *  zero stays available as the destroyed marker. Group varies fastest because
 *  it is the innermost decode in the shader.
 *
 *  Exactness matters: this rides in a float32 colour channel, so the packed
 *  value must stay inside 2^24. With 128 slots, 4 tiers and 16 groups the
 *  ceiling is 8,192 — four orders of magnitude of headroom.
 */
export function packInstanceMeta(meta: InstanceMeta, groupCount: number): number {
  if (groupCount < 1) throw new Error("groupCount must be at least 1");
  if (meta.group < 0 || meta.group >= groupCount) {
    throw new Error(`group ${meta.group} outside 0..${groupCount - 1}`);
  }
  if (meta.lod < 0 || meta.lod >= LOD_TIERS) {
    throw new Error(`lod ${meta.lod} outside 0..${LOD_TIERS - 1}`);
  }
  return (meta.slot * LOD_TIERS + meta.lod) * groupCount + meta.group + 1;
}

/** Mirror of the shader's decode. Kept beside the encoder so the two cannot
 *  drift, and exercised by round-trip tests. */
export function unpackInstanceMeta(packed: number, groupCount: number): InstanceMeta | null {
  if (packed <= DEAD_META) return null;
  const encoded = packed - 1;
  const group = encoded % groupCount;
  const rest = Math.floor(encoded / groupCount);
  return { slot: Math.floor(rest / LOD_TIERS), lod: rest % LOD_TIERS, group };
}

/** Largest packed value a configuration can produce, for capacity assertions. */
export function maxPackedMeta(slotCapacity: number, groupCount: number): number {
  return ((slotCapacity - 1) * LOD_TIERS + (LOD_TIERS - 1)) * groupCount + (groupCount - 1) + 1;
}
