import { describe, expect, it } from "vitest";

import {
  ASSET_HEIGHT, HORIZON_PIECES, arcAngle, arcEnvelope, placeHorizonPiece,
} from "./horizon";

const SEED = 4211;
const BASE_Y = -100;

describe("horizon arc", () => {
  it("leaves a clear vista toward +Z", () => {
    // The default camera comes in over +Z and the dragon perch needs the
    // sightline. None of the detached back-country clusters may leak into that
    // approach wedge.
    const angles = HORIZON_PIECES.flatMap((spec) =>
      Array.from({ length: spec.count }, (_, k) => arcAngle(SEED, k, spec.count, spec.salt)));
    const towardCamera = Math.PI / 2; // +Z
    // Angular distance from each piece to the approach direction. Wrapping via
    // (x + 3PI) mod 2PI - PI keeps it signed-safe across the seam; the absolute
    // value of that IS the distance, so do not subtract it from PI — that
    // measures the distance to the back wall, which is always large and makes
    // the assertion pass for the wrong reason.
    const nearest = Math.min(...angles.map((a) =>
      Math.abs(((a - towardCamera + Math.PI * 3) % (Math.PI * 2)) - Math.PI)));
    // The gap spans both sides of the approach, so the vista is twice that.
    expect(nearest * 2).toBeGreaterThan(Math.PI / 2); // at least 90 degrees clear
  });

  it("has real gaps between the back-country clusters", () => {
    const angles = HORIZON_PIECES.flatMap((spec) =>
      Array.from({ length: spec.count }, (_, k) => arcAngle(SEED, k, spec.count, spec.salt)))
      .sort((a, b) => a - b);
    const gaps = angles.slice(1).map((angle, index) => angle - angles[index]);
    // Two large internal gaps distinguish three geological masses from a
    // thinned-out horseshoe. Instance jitter must never close either one.
    expect(gaps.filter((gap) => gap > 0.65)).toHaveLength(2);
  });

  it("is tallest in the middle and thins to nothing at both ends", () => {
    const n = 12;
    const env = Array.from({ length: n }, (_, k) => arcEnvelope(k, n));
    expect(env[0]).toBeCloseTo(0, 5);
    expect(env[n - 1]).toBeCloseTo(0, 5);
    expect(Math.max(...env)).toBeGreaterThan(0.95);
    // Monotonic up to the crown, so the wall does not dip and rise again.
    const crown = env.indexOf(Math.max(...env));
    for (let k = 1; k <= crown; k++) expect(env[k]).toBeGreaterThanOrEqual(env[k - 1]);
  });

  it("handles a single piece without dividing by zero", () => {
    expect(Number.isFinite(arcAngle(SEED, 0, 1, 3))).toBe(true);
    expect(arcEnvelope(0, 1)).toBeCloseTo(1, 5);
  });
});

describe("horizon placement", () => {
  it("stays a sparse distant backdrop instead of closing into a rock ring", () => {
    const total = HORIZON_PIECES.reduce((sum, spec) => sum + spec.count, 0);
    expect(total).toBeLessThanOrEqual(12);
    expect(Math.min(...HORIZON_PIECES.map((spec) => spec.radius[0]))).toBeGreaterThanOrEqual(140);
    expect(Math.max(...HORIZON_PIECES.map((spec) => spec.height[1]))).toBeLessThanOrEqual(60);
  });

  it("is deterministic for a seed", () => {
    const once = HORIZON_PIECES.flatMap((s) =>
      Array.from({ length: s.count }, (_, k) => JSON.stringify(placeHorizonPiece(SEED, s, k, BASE_Y))));
    const twice = HORIZON_PIECES.flatMap((s) =>
      Array.from({ length: s.count }, (_, k) => JSON.stringify(placeHorizonPiece(SEED, s, k, BASE_Y))));
    expect(once).toEqual(twice);
    expect(once).not.toEqual(HORIZON_PIECES.flatMap((s) =>
      Array.from({ length: s.count }, (_, k) => JSON.stringify(placeHorizonPiece(SEED + 1, s, k, BASE_Y)))));
  });

  it("keeps every piece inside its declared radius band", () => {
    for (const spec of HORIZON_PIECES) {
      for (let k = 0; k < spec.count; k++) {
        const p = placeHorizonPiece(SEED, spec, k, BASE_Y);
        const r = Math.hypot(p.x, p.z);
        expect(r).toBeGreaterThanOrEqual(spec.radius[0] - 1e-6);
        expect(r).toBeLessThanOrEqual(spec.radius[1] + 1e-6);
      }
    }
  });

  it("scales from the optimiser's normalised height, not the asset's own", () => {
    // Every model this loads was normalised to ASSET_HEIGHT by
    // blender-optimize-tripo.py. Scaling by anything else silently puts a
    // 10-unit cliff on a 90-unit horizon, which is the mistake the perch made.
    for (const spec of HORIZON_PIECES) {
      for (let k = 0; k < spec.count; k++) {
        const p = placeHorizonPiece(SEED, spec, k, BASE_Y);
        const height = p.scale * ASSET_HEIGHT;
        expect(height).toBeGreaterThanOrEqual(spec.height[0] - 1e-6);
        expect(height).toBeLessThanOrEqual(spec.height[1] + 1e-6);
      }
    }
  });

  it("seats every piece at or just below the ground line", () => {
    for (const spec of HORIZON_PIECES) {
      for (let k = 0; k < spec.count; k++) {
        const p = placeHorizonPiece(SEED, spec, k, BASE_Y);
        expect(p.y).toBeLessThanOrEqual(BASE_Y);
        expect(p.y).toBeGreaterThan(BASE_Y - spec.height[1]); // sunk, not buried
      }
    }
  });

  it("does not stand every piece square to the centre", () => {
    // A ring all facing inward reads as a fence. The yaw jitter is what breaks
    // that, so assert the spread actually survives.
    const spec = HORIZON_PIECES[0];
    const offsets = Array.from({ length: spec.count }, (_, k) => {
      const p = placeHorizonPiece(SEED, spec, k, BASE_Y);
      const inward = Math.atan2(-p.z, -p.x);
      return Math.abs(((p.yaw - inward + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    });
    const spread = Math.max(...offsets) - Math.min(...offsets);
    expect(spread).toBeGreaterThan(0.4);
  });
});
