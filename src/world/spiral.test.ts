// The spiral staircase surface is analytic — pin its invariants so tuning the
// tread constants can't silently break walkability.

import { describe, it, expect } from "vitest";
import { STAIR } from "../config";
import { stairPerimeterS, stairXZAtHeight, stairXZAtS, spiralHeight } from "./spiral";

const P = 8 * STAIR.M;
const SLOPE = STAIR.RISE / STAIR.STEP;

describe("stairPerimeterS", () => {
  it("round-trips perimeter distance through x/z", () => {
    for (let i = 0; i < 160; i++) {
      const s = i / 160 * P;
      const p = stairXZAtS(s);
      expect(stairPerimeterS(p.x, p.z)).toBeCloseTo(s, 5);
    }
  });

  it("covers the full perimeter continuously walking the mid-ring", () => {
    // walk the square mid-ring; s must be continuous (mod P) and monotonic
    const m = STAIR.M;
    let prev = stairPerimeterS(0, -m);
    let total = 0;
    const steps = 400;
    for (let i = 1; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      // parametrize the square by clamping a circle onto it
      const cx = Math.sin(a), cz = -Math.cos(a);
      const k = m / Math.max(Math.abs(cx), Math.abs(cz));
      const s = stairPerimeterS(cx * k, cz * k);
      let d = s - prev;
      if (d < -P / 2) d += P; // wrap
      expect(d).toBeGreaterThanOrEqual(-1e-9);
      expect(d).toBeLessThan(P / 4);
      total += d;
      prev = s;
    }
    expect(total).toBeCloseTo(P, 4);
  });
});

describe("spiralHeight", () => {
  const tower = { y0: 2, y1: 12, m: STAIR.M, rise: STAIR.RISE };

  it("is clamped to the tower span", () => {
    expect(spiralHeight(tower, 0, -STAIR.M, -50)).toBeGreaterThanOrEqual(tower.y0);
    expect(spiralHeight(tower, 0, -STAIR.M, 50)).toBeLessThanOrEqual(tower.y1);
  });

  it("resolves the loop nearest to refY", () => {
    // same xz, two different reference heights → two different loops, one
    // full revolution (P × slope) apart
    const dx = 0, dz = -STAIR.M;
    const y0 = spiralHeight(tower, dx, dz, tower.y0);
    const y1 = spiralHeight(tower, dx, dz, tower.y0 + P * SLOPE);
    expect(y1 - y0).toBeCloseTo(P * SLOPE, 5);
  });

  it("rises smoothly along a flight (no step bigger than the ground clamp)", () => {
    // follow the mid-ring for one revolution starting at the entry corner;
    // consecutive samples must rise gently (walkable without jumping)
    const m = STAIR.M;
    let refY = tower.y0;
    let prevY = spiralHeight(tower, 0, -m, refY);
    const firstY = prevY;
    const steps = 200;
    for (let i = 1; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const cx = Math.sin(a), cz = -Math.cos(a);
      const k = m / Math.max(Math.abs(cx), Math.abs(cz));
      const y = spiralHeight(tower, cx * k, cz * k, refY);
      expect(y - prevY).toBeGreaterThanOrEqual(-1e-6);
      expect(y - prevY).toBeLessThan(0.5); // well under the player STEP_LIMIT
      prevY = y;
      refY = y;
    }
    expect(prevY - firstY).toBeCloseTo(P * SLOPE, 4);
  });

  it("variant towers (different diameter/pitch) keep the walkability invariants", () => {
    const v = { y0: 0, y1: 15, m: STAIR.M * 1.27, rise: STAIR.RISE * 0.9 };
    const Pv = 8 * v.m, slope = v.rise / STAIR.STEP;
    let refY = v.y0;
    let prevY = spiralHeight(v, 0, -v.m, refY);
    const firstY = prevY;
    for (let i = 1; i <= 200; i++) {
      const a = (i / 200) * Math.PI * 2;
      const cx = Math.sin(a), cz = -Math.cos(a);
      const k = v.m / Math.max(Math.abs(cx), Math.abs(cz));
      const y = spiralHeight(v, cx * k, cz * k, refY);
      expect(y - prevY).toBeGreaterThanOrEqual(-1e-6);
      expect(y - prevY).toBeLessThan(0.5);
      prevY = y; refY = y;
    }
    expect(prevY - firstY).toBeCloseTo(Pv * slope, 4);
  });

  it("honours a landing phase and closes on the same face after whole loops", () => {
    const m = STAIR.M * 1.1;
    const loops = 6;
    const tower = { y0: 3, y1: 33, m, phase: 7 * m, rise: (30 * STAIR.STEP) / (loops * 8 * m) };
    const lo = stairXZAtHeight(tower, tower.y0);
    const hi = stairXZAtHeight(tower, tower.y1);
    expect(hi.x).toBeCloseTo(lo.x, 5);
    expect(hi.z).toBeCloseTo(lo.z, 5);
    expect(spiralHeight(tower, lo.x, lo.z, tower.y0)).toBeCloseTo(tower.y0, 5);
    expect(spiralHeight(tower, hi.x, hi.z, tower.y1)).toBeCloseTo(tower.y1, 5);
  });
});
