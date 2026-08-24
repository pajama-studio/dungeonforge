// The spacing rule and the disc sampling decide whether a stroke reads as a
// brush or as a stutter, so both are checked here rather than by eye.

import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { dabOffset, shouldDab } from "./brush";
import { hash01 } from "./variance";

describe("shouldDab", () => {
  it("always places the first dab", () => {
    expect(shouldDab(new THREE.Vector3(), null, 3)).toBe(true);
  });

  it("holds off until the cursor has travelled the spacing", () => {
    const last = new THREE.Vector3(0, 0, 0);
    expect(shouldDab(new THREE.Vector3(2, 0, 0), last, 3)).toBe(false);
    expect(shouldDab(new THREE.Vector3(3, 0, 0), last, 3)).toBe(true);
    expect(shouldDab(new THREE.Vector3(0, 0, 4), last, 3)).toBe(true);
  });

  it("measures in 3D, so a stroke up a stair still spaces correctly", () => {
    const last = new THREE.Vector3(0, 0, 0);
    // 2 across and 2 up is 2.83 apart — under a spacing of 3
    expect(shouldDab(new THREE.Vector3(2, 2, 0), last, 3)).toBe(false);
  });
});

describe("dabOffset", () => {
  it("stays inside the brush radius", () => {
    const normal = new THREE.Vector3(0, 1, 0);
    for (let seed = 0; seed < 400; seed++) {
      expect(dabOffset(normal, 5, seed, hash01).length()).toBeLessThanOrEqual(5.0001);
    }
  });

  it("lies in the surface plane for any normal", () => {
    for (const normal of [
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0.3, 0.6, -0.74).normalize(),
    ]) {
      for (let seed = 0; seed < 60; seed++) {
        const offset = dabOffset(normal, 4, seed, hash01);
        expect(Math.abs(offset.dot(normal))).toBeLessThan(1e-6);
      }
    }
  });

  it("spreads by area, not crowded at the centre", () => {
    const normal = new THREE.Vector3(0, 1, 0);
    const radius = 6;
    let inner = 0;
    const samples = 3000;
    for (let seed = 0; seed < samples; seed++) {
      if (dabOffset(normal, radius, seed, hash01).length() < radius / 2) inner++;
    }
    // the inner half-radius is a quarter of the disc's area, so ~25% of dabs
    expect(inner / samples).toBeGreaterThan(0.19);
    expect(inner / samples).toBeLessThan(0.31);
  });

  it("replays identically for the same seed", () => {
    const normal = new THREE.Vector3(0, 1, 0);
    expect(dabOffset(normal, 3, 11, hash01).toArray())
      .toEqual(dabOffset(normal, 3, 11, hash01).toArray());
  });
});
