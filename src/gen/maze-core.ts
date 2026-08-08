// Hot, self-contained maze kernel. Keeping the contract to two flat typed
// arrays makes it suitable for both the current TypeScript worker and a
// Rust/WASM implementation without serializing the full Layout object.

import { Rng, valueNoise2 } from "./rng";

const MX = [1, -1, 0, 0] as const;
const MY = [0, 0, 1, -1] as const;

export interface MazeCoreParams {
  newest: number;
  braid: number;
  loops: number;
  heightAmp: number;
  mound: number;
}

export interface MazeCoreResult {
  tiers: Int8Array;
  open: Uint8Array;
  rngDraws: number;
  quality?: {
    deadEnds: number;
    cycleRank: number;
    verticalEdges: number;
    tierSpan: number;
  };
}

export type MazeCoreGenerator = typeof generateMazeCoreTs;

/** Reference kernel. Rust mirrors this exactly; tests use its checksum as the
 * semantic oracle so switching backend cannot silently change a seed. */
export function generateMazeCoreTs(
  size: number,
  seed: number,
  p: MazeCoreParams,
  volumeBias: Int8Array,
  rng = new Rng(seed),
): MazeCoreResult {
  const M = Math.max(7, Math.min(23, Math.round(size))) | 0;
  const ci = M >> 1;
  const mi = (i: number, j: number) => j * M + i;
  const tierTarget = (i: number, j: number): number => {
    const n = valueNoise2(seed ^ 0x51ab, i * 0.46, j * 0.46) * p.heightAmp;
    const dx = i - ci, dy = j - 1.2;
    const dTemple = Math.sqrt(dx * dx + dy * dy);
    const mound = Math.max(0, p.mound - dTemple * 0.48);
    return Math.max(0, Math.min(7, Math.round(n + mound - 0.4 + volumeBias[mi(i, j)])));
  };
  const tiers = new Int8Array(M * M).fill(-1);
  const open = new Uint8Array(M * M * 4);
  const connect = (i: number, j: number, d: number) => {
    open[mi(i, j) * 4 + d] = 1;
    open[mi(i + MX[d], j + MY[d]) * 4 + (d ^ 1)] = 1;
  };

  const start = mi(ci, M - 1);
  tiers[start] = Math.min(2, tierTarget(ci, M - 1));
  const active: number[] = [start];
  while (active.length > 0) {
    const pickIdx = rng.chance(p.newest) ? active.length - 1 : rng.int(0, active.length - 1);
    const cur = active[pickIdx];
    const cx = cur % M, cy = (cur / M) | 0;
    const dirs: number[] = [];
    for (let d = 0; d < 4; d++) {
      const nx = cx + MX[d], ny = cy + MY[d];
      if (nx < 0 || ny < 0 || nx >= M || ny >= M) continue;
      if (tiers[mi(nx, ny)] < 0) dirs.push(d);
    }
    if (dirs.length === 0) {
      active.splice(pickIdx, 1);
      continue;
    }
    const d = rng.pick(dirs);
    const nx = cx + MX[d], ny = cy + MY[d];
    const t = tiers[cur];
    tiers[mi(nx, ny)] = Math.max(0, Math.min(7,
      Math.max(t - 1, Math.min(t + 1, tierTarget(nx, ny))),
    ));
    connect(cx, cy, d);
    active.push(mi(nx, ny));
  }

  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
    const c = mi(i, j);
    let deg = 0;
    for (let d = 0; d < 4; d++) deg += open[c * 4 + d];
    if (deg !== 1 || !rng.chance(p.braid)) continue;
    const options: number[] = [];
    for (let d = 0; d < 4; d++) {
      if (open[c * 4 + d]) continue;
      const nx = i + MX[d], ny = j + MY[d];
      if (nx < 0 || ny < 0 || nx >= M || ny >= M) continue;
      if (Math.abs(tiers[mi(nx, ny)] - tiers[c]) <= 1) options.push(d);
    }
    if (options.length > 0) connect(i, j, rng.pick(options));
  }
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
    for (const d of [0, 2]) {
      const nx = i + MX[d], ny = j + MY[d];
      if (nx >= M || ny >= M) continue;
      if (open[mi(i, j) * 4 + d]) continue;
      if (Math.abs(tiers[mi(nx, ny)] - tiers[mi(i, j)]) <= 1 && rng.chance(p.loops)) connect(i, j, d);
    }
  }
  return { tiers, open, rngDraws: rng.draws };
}

export function mazeCoreChecksum(core: MazeCoreResult): number {
  let h = 0x811c9dc5;
  for (const a of [core.tiers, core.open]) for (let i = 0; i < a.length; i++) {
    h ^= a[i] & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  h ^= core.rngDraws;
  return Math.imul(h, 0x01000193) >>> 0;
}
