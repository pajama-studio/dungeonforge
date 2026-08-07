// Rotation invariants: a rotated layout must be indistinguishable from a
// native one downstream — gates land on the WORLD-space sides the caller
// requested, the floor graph stays fully connected, and rotation is a pure
// permutation (same floor/wall counts for every k).

import { describe, it, expect } from "vitest";
import { generate, FLOOR, DX, DY } from "./dungeon";

describe("layout rotation", () => {
  it("is deterministic per (seed, rot)", () => {
    const a = generate({ seed: 77, rot: 3 });
    const b = generate({ seed: 77, rot: 3 });
    expect(Array.from(a.kind)).toEqual(Array.from(b.kind));
    expect(a.stairs).toEqual(b.stairs);
  });

  it("preserves floor/wall counts for every k (pure permutation)", () => {
    const base = generate({ seed: 41, rot: 0 });
    for (const k of [1, 2, 3]) {
      const r = generate({ seed: 41, rot: k });
      expect(r.stats.floor).toBe(base.stats.floor);
      expect(r.stats.wall).toBe(base.stats.wall);
      expect(r.stairs.length).toBe(base.stairs.length);
      expect(r.torches.length).toBe(base.torches.length);
    }
  });

  it("carves gates on the requested WORLD sides near the requested rows", () => {
    for (const k of [0, 1, 2, 3]) {
      const l = generate({ seed: 913, rot: k, size: 11, gateSides: [0, 2], gateRows: [7, 15] });
      for (const [side, row] of [[0, 7], [2, 15]] as const) {
        const g = l.gates.find((gg) => gg.dir === side);
        expect(g, `rot=${k} side=${side}`).toBeTruthy();
        const t = side === 0 ? g!.y : g!.x;
        expect(Math.abs(t - row), `rot=${k} side=${side} row=${t}`).toBeLessThanOrEqual(4);
        // the gate must sit on the correct boundary and open onto floor
        if (side === 0) expect(g!.x).toBe(l.N - 1);
        else expect(g!.y).toBe(l.N - 1);
        const ix = g!.x - DX[side], iy = g!.y - DY[side];
        expect(l.kind[iy * l.N + ix]).toBe(FLOOR);
      }
    }
  });

  it("keeps the floor graph fully connected after rotation", () => {
    for (const k of [1, 2, 3]) {
      const l = generate({ seed: 5, rot: k });
      const N = l.N;
      const comp = new Int16Array(N * N).fill(-1);
      let start = -1;
      for (let c = 0; c < N * N; c++) if (l.kind[c] === FLOOR) { start = c; break; }
      const q = [start];
      comp[start] = 0;
      let seen = 1;
      while (q.length) {
        const c = q.pop()!;
        const x = c % N, y = (c / N) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          const n = ny * N + nx;
          if (comp[n] < 0 && l.kind[n] === FLOOR && Math.abs(l.tier[n] - l.tier[c]) <= 1) {
            comp[n] = 0; seen++; q.push(n);
          }
        }
      }
      expect(seen).toBe(l.stats.floor);
    }
  });

  it("temple-less and ravine-less layouts stay valid", () => {
    const noTemple = generate({ seed: 33, templeOn: false });
    expect(noTemple.temple).toBeNull();
    expect(noTemple.door).toBeNull();
    expect(noTemple.templeCells.length).toBe(0);
    const noRavine = generate({ seed: 33, ravineOn: false });
    expect(noRavine.bridge).toBeNull();
  });
});
