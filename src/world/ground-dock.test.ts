import { describe, expect, it } from "vitest";
import { generate, FLOOR } from "../gen/dungeon";
import { groundStairDock, GROUND_CLIMB } from "./helpers";
import { CELL, TH } from "../config";

const ANCHOR = { id: -1, x: 9, y: 19, dockDir: 2 as const };
const origin = { ox: 120, oy: 8, oz: -40 };

function layoutWithShaft(seed: number) {
  return generate({ seed, size: 13, verticalAnchors: [ANCHOR], groundAnchorId: -1 });
}

describe("ground stair dock", () => {
  it("descends the authored climb from the landing, not from the terrain", () => {
    const l = layoutWithShaft(4242);
    const dock = groundStairDock({ l, ...origin }, -1)!;
    expect(dock).not.toBeNull();
    // The whole point of §5.1: the height is a constant the design owns, so it
    // cannot drift with the seed or with fit()'s rescaling of the bedrock.
    expect(dock.y1 - dock.y0).toBeCloseTo(GROUND_CLIMB, 6);
  });

  it("puts the tower on the shaft core and the landing on real floor", () => {
    const l = layoutWithShaft(4242);
    const anchor = l.verticalAnchors.find((a) => a.id === -1)!;
    const dock = groundStairDock({ l, ...origin }, -1)!;

    const expectedX = origin.ox + (anchor.x - (l.N - 1) / 2) * CELL;
    const expectedZ = origin.oz + (anchor.y - (l.N - 1) / 2) * CELL;
    expect(dock.x).toBeCloseTo(expectedX, 6);
    expect(dock.z).toBeCloseTo(expectedZ, 6);

    const lx = anchor.x + [1, -1, 0, 0][anchor.dockDir];
    const ly = anchor.y + [0, 0, 1, -1][anchor.dockDir];
    const cell = ly * l.N + lx;
    expect(l.kind[cell]).toBe(FLOOR);
    expect(dock.upper.y).toBeCloseTo(origin.oy + l.tier[cell] * TH + 0.16, 6);
  });

  it("faces the doorway the way the landing docks", () => {
    const l = layoutWithShaft(4242);
    const anchor = l.verticalAnchors.find((a) => a.id === -1)!;
    const dock = groundStairDock({ l, ...origin }, -1)!;
    expect(dock.side).toBe(anchor.dockDir ^ 1);
    // The foot sits under the core, so arriving and leaving share an axis.
    expect(dock.lower.x).toBeCloseTo(dock.x, 6);
    expect(dock.lower.z).toBeCloseTo(dock.z, 6);
  });

  it("returns null when asked for an anchor the block does not own", () => {
    const l = layoutWithShaft(4242);
    expect(groundStairDock({ l, ...origin }, 77)).toBeNull();
  });

  it("holds across seeds and rotations", () => {
    for (const seed of [1, 77, 909, 4242, 20260811]) {
      for (const rot of [0, 1, 2, 3]) {
        const l = generate({ seed, size: 13, verticalAnchors: [ANCHOR], groundAnchorId: -1, rot });
        const dock = groundStairDock({ l, ...origin }, -1);
        expect(dock, `seed ${seed} rot ${rot}`).not.toBeNull();
        expect(dock!.y1 - dock!.y0).toBeCloseTo(GROUND_CLIMB, 6);
        expect(dock!.y0).toBeLessThan(dock!.y1);
      }
    }
  });
});
