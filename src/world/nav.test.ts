import { describe, expect, it } from "vitest";
import { bridgeBacktrackFractions } from "./nav";
import { WalkMap } from "./walkmap";
import * as THREE from "three/webgpu";
import { fuseDistrictBoundary } from "./helpers";
import type { Layout } from "../gen/dungeon";

describe("bridge route sampling", () => {
  it("stays monotonic in either traversal direction after backtracking is reversed", () => {
    const forward = [0, ...bridgeBacktrackFractions(true).slice().reverse(), 1];
    const reverse = [1, ...bridgeBacktrackFractions(false).slice().reverse(), 0];
    expect(forward).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(reverse).toEqual([1, 0.75, 0.5, 0.25, 0]);
  });
});

describe("dynamic navigation blockers", () => {
  it("rejects the rendered support-pier volume but not adjacent floor", () => {
    const walk = new WalkMap({ towers: [] } as never);
    walk.addBlocker({ x: 4, z: -2, y0: 0, y1: 12, radius: 1.25 });
    expect(walk.isBlocked(4, 3, -2)).toBe(true);
    expect(walk.isBlocked(6.2, 3, -2)).toBe(false);
    expect(walk.isBlocked(4, 14, -2)).toBe(false);
    expect(walk.sample(4, -2, 3)).toMatchObject({ ok: false, solid: true });
  });

  it("lets a short district causeway override the rounded boundary-wall cell", () => {
    const walk = new WalkMap({ towers: [] } as never);
    const kind = new Uint8Array(9).fill(1);
    kind[4] = 2; // the seam crosses a boundary wall cell at the midpoint
    walk.addIsland({
      N: 3, kind, tier: new Int8Array(9), stairs: [], bridge: null,
    } as never, 0, 0, 0, 0);
    walk.addLink(new THREE.Vector3(-2, 0, 0), new THREE.Vector3(2, 0, 0), 0.1, 5.4);
    expect(walk.sample(0, 0, 0)).toMatchObject({ ok: true });
  });
});

describe("cross-block room aprons", () => {
  it("carves a five-cell-wide room into the real floor graph and removes stale props", () => {
    const N = 9, total = N * N;
    const kind = new Uint8Array(total).fill(2);
    const tier = new Int8Array(total);
    const support = new Int8Array(total);
    kind[4 * N + 8] = kind[4 * N + 7] = 1;
    tier[4 * N + 8] = tier[4 * N + 7] = 2;
    const zero = () => new Uint8Array(total);
    const layout = {
      N, kind, tier, support,
      wallTop: new Int8Array(total), wallBase: new Int8Array(total),
      stairMask: zero(), ruinMask: zero(), redMask: zero(), templeMask: zero(),
      plazaMask: zero(), doorMask: zero(), shaftMask: zero(), volumeMask: zero(),
      gates: [{ x: 8, y: 4, dir: 0, tier: 2 }],
      stairs: [{ x: 7, y: 3, dir: 0, tier: 2 }],
      torches: [{ x: 8, y: 5, dir: 1, tier: 2 }],
      banners: [], towers: [], braziers: [], templeCells: [],
      stats: { floor: 2, wall: total - 2, attempts: 1, genMs: 0, volumeCells: 0, volumeLevels: 0 },
    } as unknown as Layout;
    expect(fuseDistrictBoundary(layout, 0, 2, 3)).toBe(15);
    for (let y = 2; y <= 6; y++) for (let x = 6; x <= 8; x++) {
      expect(kind[y * N + x]).toBe(1);
      expect(tier[y * N + x]).toBe(2);
      expect(support[y * N + x]).toBe(2);
    }
    expect(layout.stats.floor).toBe(15);
    expect(layout.stats.wall).toBe(total - 15);
    expect(layout.stairs).toHaveLength(0);
    expect(layout.torches).toHaveLength(0);
  });
});
