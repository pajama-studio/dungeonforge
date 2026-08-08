import { describe, expect, it } from "vitest";
import { chamferBoxGeometry, fracturedBlockGeometry, openChamferSlabGeometry, openCourseGeometry } from "./geometries";

describe("chamferBoxGeometry", () => {
  it("keeps the requested bounds with 68 outward-facing triangles", () => {
    const geo = chamferBoxGeometry(4, 2, 6, 0.1);
    const position = geo.getAttribute("position");
    const normal = geo.getAttribute("normal");
    expect(position.count / 3).toBe(68);
    expect(normal.count).toBe(position.count);
    expect(geo.boundingBox?.min.toArray()).toEqual([-2, -1, -3]);
    expect(geo.boundingBox?.max.toArray()).toEqual([2, 1, 3]);
    for (let i = 0; i < normal.count; i++) {
      expect(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i))).toBeCloseTo(1, 6);
    }
    geo.dispose();
  });

  it("builds asymmetric hard-faced debris without increasing box triangles", () => {
    const geo = fracturedBlockGeometry(4, 2, 6);
    const position = geo.getAttribute("position");
    expect(position.count / 3).toBe(12);
    expect(geo.index).toBeNull();
    expect(geo.getAttribute("color").count).toBe(position.count);
    expect(geo.boundingBox!.max.x).toBeLessThanOrEqual(2);
    expect(geo.boundingBox!.max.x).toBeGreaterThan(1.5);
    geo.dispose();
  });

  it("omits hidden course caps while retaining chamfered wall sides", () => {
    const high = openCourseGeometry(2, 1, 2, 0.1);
    const low = openCourseGeometry(2, 1, 2, 0);
    expect(high.getAttribute("position").count / 3).toBe(16);
    expect(low.getAttribute("position").count / 3).toBe(8);
    const position = high.getAttribute("position");
    const normal = high.getAttribute("normal");
    for (let i = 0; i < position.count; i += 3) {
      const ax = position.getX(i), ay = position.getY(i), az = position.getZ(i);
      const bx = position.getX(i + 1), by = position.getY(i + 1), bz = position.getZ(i + 1);
      const cx = position.getX(i + 2), cy = position.getY(i + 2), cz = position.getZ(i + 2);
      const abx = bx - ax, aby = by - ay, abz = bz - az;
      const acx = cx - ax, acy = cy - ay, acz = cz - az;
      const wx = aby * acz - abz * acy;
      const wy = abz * acx - abx * acz;
      const wz = abx * acy - aby * acx;
      const nx = normal.getX(i), ny = normal.getY(i), nz = normal.getZ(i);
      // Vertex normals and triangle winding must agree, and the side normal
      // must point away from the centered course instead of into it.
      expect(wx * nx + wy * ny + wz * nz).toBeGreaterThan(0);
      const mx = (ax + bx + cx) / 3, mz = (az + bz + cz) / 3;
      expect(mx * nx + mz * nz).toBeGreaterThan(0);
    }
    high.dispose(); low.dispose();
  });

  it("builds an open chamfer slab with no hidden bottom cap", () => {
    const geo = openChamferSlabGeometry(4, 0.15, 4, 0.05);
    expect(geo.getAttribute("position").count / 3).toBe(22);
    expect(geo.boundingBox).not.toBeNull();
    geo.dispose();
  });
});
