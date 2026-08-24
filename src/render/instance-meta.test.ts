import { describe, expect, it } from "vitest";

import {
  DEAD_META, LOD_TIERS, maxPackedMeta, packInstanceMeta, unpackInstanceMeta,
} from "./instance-meta";

describe("instance metadata packing", () => {
  it("round-trips every combination the renderer can produce", () => {
    // Exhaustive rather than sampled: a decode error here does not throw and
    // does not trip the GPU fallback, it silently draws the wrong geometry.
    for (const groupCount of [1, 2, 3, 8, 16]) {
      for (let slot = 0; slot < 128; slot++) {
        for (let lod = 0; lod < LOD_TIERS; lod++) {
          for (let group = 0; group < groupCount; group++) {
            const packed = packInstanceMeta({ slot, lod, group }, groupCount);
            expect(unpackInstanceMeta(packed, groupCount)).toEqual({ slot, lod, group });
          }
        }
      }
    }
  });

  it("keeps zero reserved for destroyed instances", () => {
    // Slot 0, LOD 0, group 0 is a real instance and must not encode as dead.
    expect(packInstanceMeta({ slot: 0, lod: 0, group: 0 }, 1)).toBeGreaterThan(DEAD_META);
    expect(unpackInstanceMeta(DEAD_META, 1)).toBeNull();
  });

  it("stays exact in a float32 channel", () => {
    // The packed value rides in an instance colour alpha. Beyond 2^24 floats
    // stop representing consecutive integers and the decode starts aliasing.
    const worst = maxPackedMeta(128, 16);
    expect(worst).toBeLessThan(2 ** 24);
    expect(Math.fround(worst)).toBe(worst);
  });

  it("rejects out-of-range input rather than aliasing onto another instance", () => {
    expect(() => packInstanceMeta({ slot: 0, lod: 0, group: 2 }, 2)).toThrow(/group/);
    expect(() => packInstanceMeta({ slot: 0, lod: LOD_TIERS, group: 0 }, 1)).toThrow(/lod/);
    expect(() => packInstanceMeta({ slot: 0, lod: 0, group: 0 }, 0)).toThrow(/groupCount/);
  });

  it("is injective — no two distinct instances share a code", () => {
    const seen = new Set<number>();
    const groupCount = 4;
    for (let slot = 0; slot < 64; slot++) {
      for (let lod = 0; lod < LOD_TIERS; lod++) {
        for (let group = 0; group < groupCount; group++) {
          const packed = packInstanceMeta({ slot, lod, group }, groupCount);
          expect(seen.has(packed)).toBe(false);
          seen.add(packed);
        }
      }
    }
  });

  it("matches the previous single-group layout exactly", () => {
    // The old encoding was slot * 4 + lod + 1. With one group the new scheme
    // must reproduce it byte for byte, so this refactor cannot move anything.
    for (let slot = 0; slot < 128; slot++) {
      for (let lod = 0; lod < LOD_TIERS; lod++) {
        expect(packInstanceMeta({ slot, lod, group: 0 }, 1)).toBe(slot * 4 + lod + 1);
      }
    }
  });
});
