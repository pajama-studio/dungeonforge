import { describe, expect, it } from "vitest";
import { generateSpatialPlan, planVerticalAnchors, planGroundEntrance, GROUND_ANCHOR_ID } from "./spatial-plan";

const SEEDS = Array.from({ length: 40 }, (_, i) => 1 + i * 17);

/** Same block sizing the forge uses, so the margins under test are the real ones. */
function sizesFor(count: number, seed: number): number[] {
  return Array.from({ length: count }, (_, i) => 2 * (11 + ((seed + i * 7) % 5)) + 1);
}

describe("ground entrance siting", () => {
  it("always finds exactly one way into the world", () => {
    for (const seed of SEEDS) {
      const cells = generateSpatialPlan(seed, 20).cells;
      const sizes = sizesFor(cells.length, seed);
      const entrance = planGroundEntrance(cells, sizes, seed, planVerticalAnchors(cells, sizes, seed));
      expect(entrance, `seed ${seed}`).not.toBeNull();
    }
  });

  it("puts it on a block that has open abyss beneath it", () => {
    for (const seed of SEEDS) {
      const cells = generateSpatialPlan(seed, 20).cells;
      const sizes = sizesFor(cells.length, seed);
      const entrance = planGroundEntrance(cells, sizes, seed, planVerticalAnchors(cells, sizes, seed))!;
      // mk 0 is the floor of the plan, so nothing can be under this block —
      // that is what makes the descent to the terrain unobstructed by
      // construction rather than by a check.
      expect(cells[entrance.block].mk).toBe(0);
      expect(Math.min(...cells.map((c) => c.mk))).toBe(0);
    }
  });

  it("keeps the 7x7 reservation inside the boundary wall", () => {
    for (const seed of SEEDS) {
      const cells = generateSpatialPlan(seed, 20).cells;
      const sizes = sizesFor(cells.length, seed);
      const entrance = planGroundEntrance(cells, sizes, seed, planVerticalAnchors(cells, sizes, seed))!;
      const N = sizes[entrance.block];
      // Stage 4 clamps an anchor to [2, N-3]; for the ground shaft a clamp would
      // silently move a position the plan promised, so it must never be needed.
      expect(entrance.anchor.x).toBeGreaterThanOrEqual(3);
      expect(entrance.anchor.y).toBeGreaterThanOrEqual(3);
      expect(entrance.anchor.x).toBeLessThanOrEqual(N - 4);
      expect(entrance.anchor.y).toBeLessThanOrEqual(N - 4);
    }
  });

  it("does not collide with a stair court in the same block", () => {
    for (const seed of SEEDS) {
      const cells = generateSpatialPlan(seed, 20).cells;
      const sizes = sizesFor(cells.length, seed);
      const vertical = planVerticalAnchors(cells, sizes, seed);
      const entrance = planGroundEntrance(cells, sizes, seed, vertical)!;
      for (const court of vertical[entrance.block] ?? []) {
        const gap = Math.max(
          Math.abs(court.x - entrance.anchor.x),
          Math.abs(court.y - entrance.anchor.y),
        );
        expect(gap, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("takes an id no cell can claim, so court pairing never matches it", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const cells = generateSpatialPlan(seed, 20).cells;
      const sizes = sizesFor(cells.length, seed);
      const entrance = planGroundEntrance(cells, sizes, seed, planVerticalAnchors(cells, sizes, seed))!;
      expect(entrance.anchor.id).toBe(GROUND_ANCHOR_ID);
      expect(cells.some((_, i) => i === GROUND_ANCHOR_ID)).toBe(false);
    }
  });

  it("is deterministic — same seed, same door", () => {
    for (const seed of SEEDS.slice(0, 12)) {
      const runs = Array.from({ length: 3 }, () => {
        const cells = generateSpatialPlan(seed, 20).cells;
        const sizes = sizesFor(cells.length, seed);
        return planGroundEntrance(cells, sizes, seed, planVerticalAnchors(cells, sizes, seed))!;
      });
      expect(runs[1]).toEqual(runs[0]);
      expect(runs[2]).toEqual(runs[0]);
    }
  });

  it("never reserves into the temple platform", () => {
    // Stage 4 lets a shaft reservation win over the ziggurat rather than
    // rejecting the layout, so an entrance sited here would quietly bore a hole
    // through the monument. This is the constraint that actually matters; the
    // southward lean below is only the preference that falls out of it.
    for (const seed of SEEDS) {
      const cells = generateSpatialPlan(seed, 20).cells;
      const sizes = sizesFor(cells.length, seed);
      const entrance = planGroundEntrance(cells, sizes, seed, planVerticalAnchors(cells, sizes, seed))!;
      const centre = (sizes[entrance.block] - 1) / 2;
      const reserveClearsTempleX = Math.abs(entrance.anchor.x - centre) > 8;
      const reserveClearsTempleY = entrance.anchor.y - 3 > 6;
      expect(reserveClearsTempleX || reserveClearsTempleY, `seed ${seed}`).toBe(true);
    }
  });

  it("leans south of centre", () => {
    let south = 0;
    for (const seed of SEEDS) {
      const cells = generateSpatialPlan(seed, 20).cells;
      const sizes = sizesFor(cells.length, seed);
      const entrance = planGroundEntrance(cells, sizes, seed, planVerticalAnchors(cells, sizes, seed))!;
      if (entrance.anchor.y >= (sizes[entrance.block] - 1) / 2) south++;
    }
    // A preference, not a rule: the siting still has to dodge stair courts, and
    // the temple exclusion above already removes most of the north.
    expect(south / SEEDS.length).toBeGreaterThan(0.5);
  });
});
