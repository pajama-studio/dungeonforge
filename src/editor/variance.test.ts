// Variance must be reproducible: a scattered field is saved as a list of
// transforms, but the brush that made it has to produce the same field twice
// or "same seed, same world" stops being true for authored content.

import { describe, expect, it } from "vitest";
import { NO_VARIANCE, hash01, sampleVariance } from "./variance";

describe("hash01", () => {
  it("stays inside [0,1)", () => {
    for (let i = 0; i < 500; i++) {
      const v = hash01(i * 977);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("spreads across the range rather than clustering", () => {
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 2000; i++) buckets[Math.floor(hash01(i) * 10)]++;
    // a flat-ish spread: no decile empty, none hogging a third of the draws
    for (const count of buckets) {
      expect(count).toBeGreaterThan(80);
      expect(count).toBeLessThan(400);
    }
  });

  it("is a pure function of the seed", () => {
    expect(hash01(42)).toBe(hash01(42));
    expect(hash01(42)).not.toBe(hash01(43));
  });
});

describe("sampleVariance", () => {
  const settings = { yaw: Math.PI * 2, scale: 0.3, tilt: 0.2 };

  it("reproduces exactly for the same seed", () => {
    expect(sampleVariance(settings, 17)).toEqual(sampleVariance(settings, 17));
  });

  it("differs between seeds", () => {
    expect(sampleVariance(settings, 17)).not.toEqual(sampleVariance(settings, 18));
  });

  it("respects the configured bounds", () => {
    for (let seed = 0; seed < 300; seed++) {
      const s = sampleVariance(settings, seed);
      expect(s.yaw).toBeGreaterThanOrEqual(0);
      expect(s.yaw).toBeLessThan(Math.PI * 2);
      expect(Math.abs(s.tiltX)).toBeLessThanOrEqual(0.2);
      expect(Math.abs(s.tiltZ)).toBeLessThanOrEqual(0.2);
      expect(s.scale).toBeGreaterThanOrEqual(0.7);
      expect(s.scale).toBeLessThanOrEqual(1.3);
    }
  });

  it("is a no-op when disabled, so placement stays exact", () => {
    const s = sampleVariance(NO_VARIANCE, 5);
    expect(s).toEqual({ yaw: 0, tiltX: 0, tiltZ: 0, scale: 1 });
  });

  it("never produces a zero or negative scale at full strength", () => {
    const extreme = { yaw: 0, scale: 0.9, tilt: 0 };
    for (let seed = 0; seed < 500; seed++) {
      expect(sampleVariance(extreme, seed).scale).toBeGreaterThan(0);
    }
  });
});
