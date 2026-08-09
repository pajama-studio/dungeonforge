import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";

import { erodeGeometry, ERODE_DEFAULTS } from "./erode";

const box = (segments = 6) => new THREE.BoxGeometry(40, 60, 24, segments, segments, segments);

describe("erodeGeometry", () => {
  it("moves coincident vertices identically, so seams cannot open", () => {
    // This is the whole reason the displacement is positional rather than along
    // normals. A box duplicates its corner vertices, one per face, each with a
    // different normal — displace along those and the box comes apart at every
    // seam. Two vertices at the same coordinate must land on the same point.
    const g = erodeGeometry(box(), { seed: 5 });
    const p = g.getAttribute("position");
    const before = new THREE.BoxGeometry(40, 60, 24, 6, 6, 6).getAttribute("position");

    const groups = new Map<string, number[]>();
    for (let i = 0; i < before.count; i++) {
      const key = `${before.getX(i)},${before.getY(i)},${before.getZ(i)}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(i);
    }
    const shared = [...groups.values()].filter((g2) => g2.length > 1);
    expect(shared.length).toBeGreaterThan(0); // the box really does duplicate

    for (const idx of shared) {
      const [first, ...rest] = idx;
      for (const j of rest) {
        expect(p.getX(j)).toBeCloseTo(p.getX(first), 10);
        expect(p.getY(j)).toBeCloseTo(p.getY(first), 10);
        expect(p.getZ(j)).toBeCloseTo(p.getZ(first), 10);
      }
    }
  });

  it("stays inside the amplitude it was given", () => {
    // An unbounded displacement on a 335-unit cliff would swing pieces of it
    // through the statue standing in front.
    const amplitude = 2.5;
    const source = box();
    const original = source.getAttribute("position").clone();
    const g = erodeGeometry(source, { seed: 9, amplitude });
    const p = g.getAttribute("position");
    let worst = 0;
    for (let i = 0; i < p.count; i++) {
      worst = Math.max(worst, Math.hypot(
        p.getX(i) - original.getX(i), p.getY(i) - original.getY(i), p.getZ(i) - original.getZ(i),
      ));
    }
    expect(worst).toBeGreaterThan(0);           // it did something
    expect(worst).toBeLessThanOrEqual(amplitude * 4); // and not more than promised
  });

  it("is deterministic for a seed and different across seeds", () => {
    const a = Array.from(erodeGeometry(box(), { seed: 3 }).getAttribute("position").array);
    const b = Array.from(erodeGeometry(box(), { seed: 3 }).getAttribute("position").array);
    const c = Array.from(erodeGeometry(box(), { seed: 4 }).getAttribute("position").array);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("leaves finite positions and normals", () => {
    const g = erodeGeometry(box(), { seed: 12 });
    for (const key of ["position", "normal"]) {
      const arr = g.getAttribute(key).array as Float32Array;
      for (let i = 0; i < arr.length; i++) expect(Number.isFinite(arr[i])).toBe(true);
    }
  });

  it("does nothing to a geometry with no positions", () => {
    const empty = new THREE.BufferGeometry();
    expect(() => erodeGeometry(empty, ERODE_DEFAULTS)).not.toThrow();
  });
});
