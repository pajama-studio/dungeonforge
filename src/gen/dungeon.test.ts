import { describe, expect, it } from "vitest";
import {
  generate, checksum, FLOOR, WALL, VOID, DX, DY, FOOTPRINT_KINDS,
  type Layout,
} from "./dungeon";

function bfsReachAll(l: Layout): boolean {
  const gi = (x: number, y: number) => y * l.N + x;
  const seen = new Uint8Array(l.N * l.N);
  const start = gi(l.entrance.x, l.entrance.y);
  const q = [start];
  seen[start] = 1;
  for (let h = 0; h < q.length; h++) {
    const c = q[h], x = c % l.N, y = (c / l.N) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= l.N || ny >= l.N) continue;
      const n = gi(nx, ny);
      if (seen[n] || l.kind[n] !== FLOOR) continue;
      if (Math.abs(l.tier[n] - l.tier[c]) > 1) continue;
      seen[n] = 1;
      q.push(n);
    }
  }
  for (let c = 0; c < l.N * l.N; c++) if (l.kind[c] === FLOOR && !seen[c]) return false;
  return true;
}

describe("dungeon generator", () => {
  it("is deterministic per seed", () => {
    const a = generate(12345), b = generate(12345);
    expect(checksum(a)).toBe(checksum(b));
    expect(a.name).toBe(b.name);
  });

  it("different seeds differ", () => {
    expect(checksum(generate(1))).not.toBe(checksum(generate(2)));
  });

  it("embeds a partial multi-level Markov volume inside each block", () => {
    for (const seed of [4, 19, 88, 501]) {
      const l = generate(seed);
      expect(l.stats.volumeCells).toBeGreaterThanOrEqual(10);
      expect(l.stats.volumeLevels).toBeGreaterThanOrEqual(2);
      expect(l.volumeMask.reduce((sum, value) => sum + value, 0)).toBeGreaterThanOrEqual(l.stats.volumeCells);
    }
  });

  it("every floor cell is reachable from the entrance (Δtier ≤ 1 moves)", () => {
    for (const seed of [1, 7, 42, 999, 20260806]) {
      expect(bfsReachAll(generate(seed)), `seed ${seed}`).toBe(true);
    }
  });

  it("stairs always rise into a floor cell exactly one tier up", () => {
    for (const seed of [3, 77, 4321]) {
      const l = generate(seed);
      const gi = (x: number, y: number) => y * l.N + x;
      for (const s of l.stairs) {
        const n = gi(s.x + DX[s.dir], s.y + DY[s.dir]);
        expect(l.kind[n]).toBe(FLOOR);
        expect(l.tier[n]).toBe(s.tier + 1);
        expect(l.tier[gi(s.x, s.y)]).toBe(s.tier);
      }
    }
  });

  it("wall tops clear their tallest adjacent floor", () => {
    const l = generate(5);
    const gi = (x: number, y: number) => y * l.N + x;
    for (let y = 1; y < l.N - 1; y++) {
      for (let x = 1; x < l.N - 1; x++) {
        const c = gi(x, y);
        if (l.kind[c] !== WALL || l.doorMask[c]) continue;
        for (let d = 0; d < 4; d++) {
          const n = gi(x + DX[d], y + DY[d]);
          if (l.kind[n] === FLOOR) expect(l.wallTop[c]).toBeGreaterThanOrEqual(l.tier[n] + 1);
        }
      }
    }
  });

  it("reserves vertical stair cores and connected level courts during generation", () => {
    const request = { id: 91, x: 11, y: 17, dockDir: 0 as const };
    const l = generate({ seed: 808, size: 13, verticalAnchors: [request] });
    const a = l.verticalAnchors.find((v) => v.id === request.id)!;
    const core = a.y * l.N + a.x;
    expect(l.kind[core]).toBe(WALL);
    expect(l.shaftMask[core]).toBe(1);
    const courtTiers = new Set<number>();
    for (let y = a.y - 1; y <= a.y + 1; y++) for (let x = a.x - 1; x <= a.x + 1; x++) {
      if (x === a.x && y === a.y) continue;
      const c = y * l.N + x;
      expect(l.kind[c], `${x},${y}`).toBe(FLOOR);
      expect(l.stairMask[c], `${x},${y}`).toBe(0);
      courtTiers.add(l.tier[c]);
    }
    expect(courtTiers.size).toBe(1);
    expect(bfsReachAll(l)).toBe(true);
    expect(checksum(l)).not.toBe(checksum(generate({ seed: 808, size: 13 })));
  });

  it("grades a vertical court into adjacent landmark floors instead of disconnecting it", () => {
    // Reliquary regression: after inverse rotation this court meets a raised
    // landmark edge by more than two tiers. It must get a stairable grade,
    // not be rejected or silently moved back to the outer wall.
    const request = { id: 30_005, x: 21, y: 19, dockDir: 0 as const };
    const l = generate({
      seed: 1_308_394_102, size: 13, rot: 3,
      verticalAnchors: [request], templeOn: true,
      decay: 0.4315, mound: 0, plazas: 1, totems: 3,
    });
    expect(l.verticalAnchors).toContainEqual(request);
    expect(l.shaftMask[request.y * l.N + request.x]).toBe(1);
    expect(bfsReachAll(l)).toBe(true);
  });

  it("holds invariants across sizes, plaza and totem counts", () => {
    for (const size of [9, 13, 21]) {
      for (const plazas of [0, 3]) {
        const l = generate({ seed: 11, size, plazas, totems: 8 });
        expect(l.N).toBe(2 * size + 1);
        expect(bfsReachAll(l), `size ${size} plazas ${plazas}`).toBe(true);
        expect(l.medallions.length).toBeLessThanOrEqual(plazas);
        if (plazas === 0) expect(l.medallions.length).toBe(0);
      }
    }
  });

  it("solves every non-square footprint with gates and vertical courts intact", () => {
    for (let i = 0; i < FOOTPRINT_KINDS.length; i++) {
      const footprint = FOOTPRINT_KINDS[i];
      const l = generate({
        seed: 7_000 + i, size: 13, footprint,
        gateSides: [0, 2], gateRows: [7, 19],
        verticalAnchors: [{ id: 700 + i, x: 8, y: 15, dockDir: 0 }],
      });
      expect(l.footprint).toBe(footprint);
      expect(bfsReachAll(l), footprint).toBe(true);
      expect(l.gates.map((g) => g.dir)).toEqual(expect.arrayContaining([0, 2]));
      expect(l.kind.reduce((sum, cell) => sum + Number(cell === VOID), 0)).toBeGreaterThan(l.N);
      const anchor = l.verticalAnchors.find((a) => a.id === 700 + i)!;
      expect(l.shaftMask[anchor.y * l.N + anchor.x], footprint).toBe(1);
    }
  });

  it("survives 100 arbitrary shape-varying seeds without throwing, few attempts", () => {
    const seen = new Set<string>();
    for (let s = 100; s < 200; s++) {
      const l = generate(s);
      seen.add(l.footprint);
      expect(l.stats.attempts).toBeLessThanOrEqual(6);
      expect(l.stairs.length).toBeGreaterThanOrEqual(6);
      expect(l.torches.length).toBeGreaterThan(8);
      expect(bfsReachAll(l), `seed ${s} (${l.footprint})`).toBe(true);
    }
    expect(seen).toEqual(new Set(FOOTPRINT_KINDS));
  });
});

describe("ground shaft", () => {
  const request = { id: -1, x: 9, y: 19, dockDir: 2 as const };

  it("is reserved, reachable, and reported on the layout", () => {
    const l = generate({ seed: 4242, size: 13, verticalAnchors: [request], groundAnchorId: -1 });
    expect(l.groundAnchorId).toBe(-1);
    const anchor = l.verticalAnchors.find((a) => a.id === -1)!;
    expect(anchor).toBeDefined();
    // core is the solid navigation column, not a walkable cell
    expect(l.shaftMask[anchor.y * l.N + anchor.x]).toBe(1);
    // the landing it docks to is floor, and joins the same world as the entrance
    const lx = anchor.x + DX[anchor.dockDir], ly = anchor.y + DY[anchor.dockDir];
    expect(l.kind[ly * l.N + lx]).toBe(FLOOR);
  });

  it("survives rotation as an id, with its anchor moved", () => {
    const base = generate({ seed: 4242, size: 13, verticalAnchors: [request], groundAnchorId: -1 });
    for (const rot of [1, 2, 3]) {
      const turned = generate({ seed: 4242, size: 13, verticalAnchors: [request], groundAnchorId: -1, rot });
      expect(turned.groundAnchorId).toBe(-1);
      expect(turned.verticalAnchors.some((a) => a.id === -1)).toBe(true);
      expect(turned.N).toBe(base.N);
    }
  });

  it("stays deterministic for a seed", () => {
    const a = generate({ seed: 909, size: 13, verticalAnchors: [request], groundAnchorId: -1 });
    const b = generate({ seed: 909, size: 13, verticalAnchors: [request], groundAnchorId: -1 });
    expect(checksum(a)).toBe(checksum(b));
    expect(a.verticalAnchors).toEqual(b.verticalAnchors);
  });

  it("refuses to be quietly re-sited when the request is out of bounds", () => {
    // Stage 4 clamps a stair court inward; for the ground shaft that would break
    // the agreement with the plinth and door sited under it, so it must fail
    // through the re-roll path instead of moving. Six attempts all fail => throw.
    expect(() => generate({
      seed: 77, size: 13, groundAnchorId: -1,
      verticalAnchors: [{ id: -1, x: 0, y: 0, dockDir: 2 }],
    })).toThrow(/ground shaft outside footprint/);
  });
});
