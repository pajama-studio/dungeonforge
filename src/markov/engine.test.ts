import { describe, expect, it } from "vitest";
import { mulberry32 } from "../gen/rng";
import { KEEP, MarkovGrid, MarkovProgram, RewriteRule } from "./grid";
import { generateSpatialPlan, planVerticalAnchors } from "./spatial-plan";
import { generateInteriorVolumePlan } from "./volume-plan";

describe("Markov rewrite core", () => {
  it("updates its cached match set after every local rewrite", () => {
    const grid = new MarkovGrid(9, 9, 1, ["E", "F"]);
    grid.set(4, 4, 0, 1);
    const rule = new RewriteRule([grid.wave("F"), grid.wave("E")], 2, 1, 1, [KEEP, 1]);
    const program = new MarkovProgram(grid, rule.squareSymmetries());
    const random = mulberry32(7);
    for (let step = 0; step < 20; step++) {
      program.step(random);
      let bruteForce = 0;
      for (const r of program.rules) for (let z = 0; z <= grid.mz - r.mz; z++) {
        for (let y = 0; y <= grid.my - r.my; y++) for (let x = 0; x <= grid.mx - r.mx; x++) {
          if (grid.matches(r, x, y, z)) bruteForce++;
        }
      }
      expect(program.matchCount).toBe(bruteForce);
    }
  });
});

describe("3D spatial plan", () => {
  it("is deterministic, connected and reaches six layers across 100 seeds", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const a = generateSpatialPlan(20, seed), b = generateSpatialPlan(20, seed);
      expect(a).toEqual(b);
      expect(a.cells).toHaveLength(20);
      expect(a.stats.layers).toBe(6);
      const occupied = new Set<string>();
      a.cells.forEach((cell, i) => {
        const key = `${cell.mi},${cell.mj},${cell.mk}`;
        expect(occupied.has(key)).toBe(false);
        occupied.add(key);
        if (i === 0) expect(cell.parent).toBe(-1);
        else {
          expect(cell.parent).toBeGreaterThanOrEqual(0);
          expect(cell.parent).toBeLessThan(i);
          const parent = a.cells[cell.parent];
          expect(Math.abs(parent.mi - cell.mi) + Math.abs(parent.mj - cell.mj) + Math.abs(parent.mk - cell.mk)).toBe(1);
          expect(cell.mk).toBeGreaterThanOrEqual(parent.mk);
        }
      });
    }
  });

  it("propagates every vertical court to exactly matching block coordinates", () => {
    const plan = generateSpatialPlan(24, 808);
    const sizes = plan.cells.map((_, i) => 19 + (i % 3) * 4);
    const anchors = planVerticalAnchors(plan.cells, sizes, 808);
    plan.cells.forEach((cell, child) => {
      if (cell.dirFromParent !== 4) return;
      const lower = anchors[cell.parent].find((a) => a.id === child);
      const upper = anchors[child].find((a) => a.id === child);
      expect(lower).toBeDefined();
      expect(upper).toBeDefined();
      expect(lower!.x - (sizes[cell.parent] - 1) / 2).toBe(upper!.x - (sizes[child] - 1) / 2);
      expect(lower!.y - (sizes[cell.parent] - 1) / 2).toBe(upper!.y - (sizes[child] - 1) / 2);
      expect(lower!.dockDir).toBe(upper!.dockDir);
    });
  });

  it("groups storage blocks into narrative districts with fused seams across 100 seeds", () => {
    let cells = 0, districts = 0, fused = 0, horizontal = 0, courts = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const plan = generateSpatialPlan(20, seed);
      const roles = new Set(plan.cells.map((cell) => cell.role));
      expect(roles.has("threshold")).toBe(true);
      expect(roles.has("sanctum")).toBe(true);
      expect(plan.cells.filter((cell) => cell.landmark)).toHaveLength(1);
      expect(plan.stats.districts).toBeLessThan(plan.cells.length);
      expect(plan.stats.fusedLinks).toBeGreaterThanOrEqual(4);
      for (const cell of plan.cells) {
        if (cell.joinFromParent !== "causeway" && cell.joinFromParent !== "gallery" && cell.joinFromParent !== "court") continue;
        expect(cell.parent).toBeGreaterThanOrEqual(0);
        expect(cell.district).toBe(plan.cells[cell.parent].district);
      expect(cell.dirFromParent).toBeLessThan(4);
      }
      cells += plan.cells.length;
      districts += plan.stats.districts;
      fused += plan.stats.fusedLinks;
      courts += plan.stats.crossBlockCourts;
      horizontal += plan.cells.filter((cell) => cell.parent >= 0 && cell.dirFromParent < 4).length;
    }
    // These aggregate guards make the "one block after another" reduction
    // measurable instead of relying on screenshots alone.
    expect(districts / cells).toBeLessThan(0.58);
    expect(fused / horizontal).toBeGreaterThan(0.62);
    expect(courts / horizontal).toBeGreaterThan(0.1);
  });
});

describe("block-local 3D volume", () => {
  it("builds a connected multi-level region across 100 seeds", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const plan = generateInteriorVolumePlan(15, seed);
      expect(plan.occupied).toBeGreaterThanOrEqual(10);
      expect(plan.levels).toBeGreaterThanOrEqual(2);
      expect(plan.rewriteSteps).toBe(plan.occupied - 1);
    }
  });

  it("does not consume an excluded stair-court volume", () => {
    const plan = generateInteriorVolumePlan(15, 12, [{ x: 7, y: 7, radius: 3 }]);
    for (let y = 4; y <= 10; y++) for (let x = 4; x <= 10; x++) {
      expect(plan.mask[y * 15 + x], `${x},${y}`).toBe(0);
    }
  });
});
