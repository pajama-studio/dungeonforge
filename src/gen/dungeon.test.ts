import { describe, expect, it } from "vitest";
import { generate, checksum, FLOOR, WALL, DX, DY, N, type Layout } from "./dungeon";

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
    for (let y = 1; y < N - 1; y++) {
      for (let x = 1; x < N - 1; x++) {
        const c = gi(x, y);
        if (l.kind[c] !== WALL || l.doorMask[c]) continue;
        for (let d = 0; d < 4; d++) {
          const n = gi(x + DX[d], y + DY[d]);
          if (l.kind[n] === FLOOR) expect(l.wallTop[c]).toBeGreaterThanOrEqual(l.tier[n] + 1);
        }
      }
    }
  });

  it("survives 40 arbitrary seeds without throwing, few attempts", () => {
    for (let s = 100; s < 140; s++) {
      const l = generate(s);
      expect(l.stats.attempts).toBeLessThanOrEqual(6);
      expect(l.stairs.length).toBeGreaterThanOrEqual(6);
      expect(l.torches.length).toBeGreaterThan(8);
    }
  });
});
