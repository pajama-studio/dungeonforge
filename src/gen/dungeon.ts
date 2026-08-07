// Procedural stone-labyrinth fortress generator — pure data, zero THREE imports.
//
// Pipeline (see docs/research.md for the evidence behind each stage):
//   1. growing-tree maze over M×M cells, carving tiers clamped to ±1 per passage
//      (tier targets = value noise + a "mound" rising toward the temple)
//   2. braiding: knock through a fraction of dead ends → loops
//   3. landmarks stamped graph-first: temple ziggurat (north), two medallion
//      plazas, a sunken red chamber, a ravine biting in from the south + bridge
//   4. rasterize to a (2M+1)² grid of FLOOR/WALL/VOID with per-cell tiers
//   5. connectivity repair: BFS over floor cells (passable iff Δtier ≤ 1),
//      open stair-legal walls between components until fully connected
//   6. stairs pass, wall top/base heights, towers, torches (min-spacing walk),
//      banners, braziers — all deterministic, all validated
//
// On validation failure the whole attempt re-rolls with a derived seed (≤ 6
// attempts), so a broken layout never ships.

import { Rng, hash2, valueNoise2 } from "./rng";

export const VOID = 0;
export const FLOOR = 1;
export const WALL = 2;

export const ABYSS = -7; // tier that abyss-facing masonry drops to

export type Dir = 0 | 1 | 2 | 3; // +x, -x, +y, -y (grid space; +y = south/front)
export const DX = [1, -1, 0, 0] as const;
export const DY = [0, 0, 1, -1] as const;

export interface Stair { x: number; y: number; dir: Dir; tier: number } // sits in lower cell, rises toward dir
export interface Torch { x: number; y: number; dir: Dir; tier: number } // wall cell, faces dir into a floor cell
export interface Banner { x: number; y: number; dir: Dir; tier: number; top: number }
export interface Tower { x: number; y: number; top: number; beacon: boolean; scale: number }
export interface Medallion { x: number; y: number; r: number; tier: number; kind: "blue" | "gold" }
export interface Brazier { x: number; y: number; tier: number; kind: "blue" | "gold" | "red"; totem?: boolean }
/** rope bridge across the ravine: spans s0..s1 (bank cells) along `axis`
 *  (0 = x-span at row `at`, 1 = y-span at column `at`) */
export interface Bridge { axis: 0 | 1; at: number; s0: number; s1: number; tier: number }
export interface Gate { x: number; y: number; dir: Dir; tier: number }

export interface Params {
  seed: number;
  /** growing-tree pick-newest bias: 1 = winding rivers (DFS), 0 = branchy (Prim-ish) */
  newest: number;
  /** fraction of dead ends knocked open into loops */
  braid: number;
  /** extra loop chance anywhere tiers allow */
  loops: number;
  /** tier noise amplitude (0 = flat plain, 4 = broken highlands) */
  heightAmp: number;
  /** temple mound height added toward the north-center */
  mound: number;
  /** min Chebyshev spacing between torches (smaller = more torches) */
  torchSpacing: number;
  /** interior maze wall thickness in cells (ramparts/towers stay full width) */
  wallThin: number;
  /** maze cells per side (grid is 2·size+1) — the dungeon's footprint */
  size: number;
  /** number of medallion teleport plazas (0-4, alternating blue/gold) */
  plazas: number;
  /** freestanding brazier totems scattered at corridor dead ends */
  totems: number;
  /** age of the ruin: scales crumbled walls, rubble, moss and vines (0-1) */
  decay: number;
  /** how many linked dungeon blocks the orchestrator builds (generator ignores it) */
  islands: number;
  /** boundary sides that get a gate opening (bridge dock): dirs 0=+x 1=-x 2=+y 3=-y */
  gateSides?: number[];
  /** requested boundary row per gate side (streaming: neighbors agree on the
   *  row via a shared edge hash, so independently-generated blocks line up) */
  gateRows?: number[];
  /** rotate the finished layout by rot×90° — orientation variety. Gates are
   *  requested in WORLD space; the request is unrotated internally so carved
   *  gates land on the requested sides/rows regardless of rot. */
  rot?: number;
  /** stamp the temple ziggurat + doorway (default true) */
  templeOn?: boolean;
  /** carve the ravine + rope bridge (default true) */
  ravineOn?: boolean;
}

export const DEFAULT_PARAMS: Params = {
  seed: 1,
  newest: 0.7,
  braid: 0.45,
  loops: 0.08,
  heightAmp: 3.0,
  mound: 3.7,
  torchSpacing: 5,
  wallThin: 0.45,
  size: 15,
  plazas: 2,
  totems: 4,
  decay: 0.5,
  islands: 20,
};

export interface Layout {
  seed: number;
  name: string;
  N: number;
  params: Params;
  kind: Uint8Array;      // VOID | FLOOR | WALL
  tier: Int8Array;       // floor cells: floor tier. walls/void: 0 (unused)
  wallTop: Int8Array;    // wall cells: top tier
  wallBase: Int8Array;   // wall cells: base tier (ABYSS when facing the void)
  support: Int8Array;    // floor cells: tier to fill masonry down to (== tier when flush)
  stairMask: Uint8Array;
  ruinMask: Uint8Array;  // wall cells with a crumbled top
  redMask: Uint8Array;
  templeMask: Uint8Array;
  plazaMask: Uint8Array;
  doorMask: Uint8Array;  // temple doorway wall cell (rendered with a gap + portal)
  stairs: Stair[];
  gates: Gate[];
  torches: Torch[];
  banners: Banner[];
  towers: Tower[];
  medallions: Medallion[];
  braziers: Brazier[];
  bridge: Bridge | null;
  door: { x: number; y: number; tier: number; top: number } | null;
  /** which way the temple doorway faces (into the forecourt) — rotates with the layout */
  doorDir: Dir;
  /** grid indices of the temple-building wall cells (facade/warm-tint lookups) */
  templeCells: number[];
  entrance: { x: number; y: number };
  temple: { platformTier: number; buildTop: number } | null;
  stats: { floor: number; wall: number; attempts: number; genMs: number };
}

// ---------------------------------------------------------------------------

// maze size comes from Params.size; the grid is (2·size+1)² — see Layout.N

const ADJ = "Sunken Gilded Hollow Ashen Silent Weeping Forgotten Blackened Endless Broken Molten Pale".split(" ");
const NOUN = "Labyrinth Bastion Vaults Ramparts Warrens Sanctum Threshold Crucible Gallery Undercroft".split(" ");
const SYL_A = "Vor Mal Kar Ul Dra Neth Or Bel Gor Sha Zar Mor".split(" ");
const SYL_B = "'gul eth 'zar oth ak 'mor ith un 'dun eks".split(" ");

function makeName(rng: Rng): string {
  return `The ${rng.pick(ADJ)} ${rng.pick(NOUN)} of ${rng.pick(SYL_A)}${rng.pick(SYL_B)}`;
}

function attempt(p: Params, seed: number): Layout | string {
  const rng = new Rng(seed);
  const M = Math.max(7, Math.min(23, Math.round(p.size))) | 0;
  const N = 2 * M + 1;

  // -- Stage 1: growing-tree maze over maze-cell space, tiers carved alongside.
  const ci = M >> 1; // temple column (maze coords)
  const tierTarget = (i: number, j: number): number => {
    const n = valueNoise2(seed ^ 0x51ab, i * 0.46, j * 0.46) * p.heightAmp;
    const dTemple = Math.hypot(i - ci, j - 1.2);
    const mound = Math.max(0, p.mound - dTemple * 0.48);
    return Math.max(0, Math.min(7, Math.round(n + mound - 0.4)));
  };

  const mTier = new Int8Array(M * M).fill(-1);
  // open[cell*4+dir] — passage between maze cells (dir in maze space, same DX/DY)
  const open = new Uint8Array(M * M * 4);
  const mi = (i: number, j: number) => j * M + i;
  const connect = (i: number, j: number, d: Dir) => {
    open[mi(i, j) * 4 + d] = 1;
    open[mi(i + DX[d], j + DY[d]) * 4 + (d ^ 1)] = 1;
  };

  {
    const start = mi(ci, M - 1);
    mTier[start] = Math.min(2, tierTarget(ci, M - 1));
    // growing tree: 70% newest (river-y like recursive backtracker), 30% random (branchy)
    const active: number[] = [start];
    while (active.length > 0) {
      const pickIdx = rng.chance(p.newest) ? active.length - 1 : rng.int(0, active.length - 1);
      const cur = active[pickIdx];
      const cx = cur % M, cy = (cur / M) | 0;
      const dirs: Dir[] = [];
      for (let d = 0 as Dir; d < 4; d++) {
        const nx = cx + DX[d], ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= M || ny >= M) continue;
        if (mTier[mi(nx, ny)] < 0) dirs.push(d as Dir);
      }
      if (dirs.length === 0) {
        active.splice(pickIdx, 1);
        continue;
      }
      const d = rng.pick(dirs);
      const nx = cx + DX[d], ny = cy + DY[d];
      const t = mTier[cur];
      mTier[mi(nx, ny)] = Math.max(0, Math.min(7, Math.max(t - 1, Math.min(t + 1, tierTarget(nx, ny)))));
      connect(cx, cy, d);
      active.push(mi(nx, ny));
    }
  }

  // -- Stage 2: braiding — open a fraction of dead ends into loops.
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < M; i++) {
      const c = mi(i, j);
      let deg = 0;
      for (let d = 0; d < 4; d++) deg += open[c * 4 + d];
      if (deg !== 1 || !rng.chance(p.braid)) continue;
      const options: Dir[] = [];
      for (let d = 0 as Dir; d < 4; d++) {
        if (open[c * 4 + d]) continue;
        const nx = i + DX[d], ny = j + DY[d];
        if (nx < 0 || ny < 0 || nx >= M || ny >= M) continue;
        if (Math.abs(mTier[mi(nx, ny)] - mTier[c]) <= 1) options.push(d as Dir);
      }
      if (options.length > 0) connect(i, j, rng.pick(options));
    }
  }
  // a few extra loops anywhere the tiers allow
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < M; i++) {
      for (const d of [0, 2] as Dir[]) {
        const nx = i + DX[d], ny = j + DY[d];
        if (nx >= M || ny >= M) continue;
        if (open[mi(i, j) * 4 + d]) continue;
        if (Math.abs(mTier[mi(nx, ny)] - mTier[mi(i, j)]) <= 1 && rng.chance(p.loops)) connect(i, j, d);
      }
    }
  }

  // -- Stage 3: rasterize maze → grid.
  const kind = new Uint8Array(N * N).fill(WALL);
  const tier = new Int8Array(N * N);
  const gi = (x: number, y: number) => y * N + x;
  const setFloor = (x: number, y: number, t: number) => {
    kind[gi(x, y)] = FLOOR;
    tier[gi(x, y)] = t;
  };
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < M; i++) {
      const gx = 2 * i + 1, gy = 2 * j + 1;
      setFloor(gx, gy, mTier[mi(i, j)]);
      if (open[mi(i, j) * 4 + 0]) setFloor(gx + 1, gy, Math.min(mTier[mi(i, j)], mTier[mi(i + 1, j)]));
      if (open[mi(i, j) * 4 + 2]) setFloor(gx, gy + 1, Math.min(mTier[mi(i, j)], mTier[mi(i, j + 1)]));
    }
  }

  // -- Stage 4: landmarks (grid space from here on).
  const gcx = 2 * ci + 1;
  const templeMask = new Uint8Array(N * N);
  const plazaMask = new Uint8Array(N * N);
  const redMask = new Uint8Array(N * N);
  const doorMask = new Uint8Array(N * N);

  // Temple ziggurat (optional): stepped platform across the north-center,
  // building on top. Satellites without a temple get a very different skyline.
  const templeOn = p.templeOn !== false;
  let door: { x: number; y: number; tier: number; top: number } | null = null;
  let temple: { platformTier: number; buildTop: number } | null = null;
  const templeCells: number[] = [];
  if (templeOn) {
    let B = 0;
    for (let j = 0; j <= 3; j++) for (let i = ci - 3; i <= ci + 3; i++) {
      if (i >= 0 && i < M) B = Math.max(B, mTier[mi(i, j)]);
    }
    B = Math.max(3, Math.min(5, B));
    const platformTier = B + 2;
    const tX0 = gcx - 5, tX1 = gcx + 5; // 11 cells wide
    for (let gy = 1; gy <= 5; gy++) {
      for (let gx = tX0; gx <= tX1; gx++) {
        const t = gy <= 1 ? B + 2 : gy <= 3 ? B + 1 : B;
        setFloor(gx, gy, t);
        templeMask[gi(gx, gy)] = 1;
      }
    }
    // forecourt link: make sure the row south of the platform can reach tier B
    for (let gx = tX0; gx <= tX1; gx++) {
      if (kind[gi(gx, 6)] === FLOOR && Math.abs(tier[gi(gx, 6)] - B) > 1) tier[gi(gx, 6)] = B;
    }
    // building: 5 wall cells on the top terrace, doorway at center
    const buildTop = platformTier + 4;
    for (let gx = gcx - 2; gx <= gcx + 2; gx++) {
      kind[gi(gx, 1)] = WALL;
      templeMask[gi(gx, 1)] = 0;
      templeCells.push(gi(gx, 1));
    }
    doorMask[gi(gcx, 1)] = 1;
    door = { x: gcx, y: 1, tier: platformTier, top: buildTop };
    temple = { platformTier, buildTop };
  }

  // Medallion plazas: circular clearings flattened to one tier.
  const medallions: Medallion[] = [];
  const stampPlaza = (pi: number, pj: number, kindName: "blue" | "gold") => {
    const px = 2 * pi + 1, py = 2 * pj + 1;
    const P = mTier[mi(pi, pj)];
    const R = Math.min(4.4, M * 0.29);
    for (let gy = Math.max(1, Math.floor(py - R)); gy <= Math.min(N - 2, Math.ceil(py + R)); gy++) {
      for (let gx = Math.max(1, Math.floor(px - R)); gx <= Math.min(N - 2, Math.ceil(px + R)); gx++) {
        if (Math.hypot(gx - px, gy - py) > R) continue;
        if (templeMask[gi(gx, gy)] || doorMask[gi(gx, gy)]) continue;
        setFloor(gx, gy, P);
        plazaMask[gi(gx, gy)] = 1;
      }
    }
    medallions.push({ x: px, y: py, r: R - 0.9, tier: P, kind: kindName });
  };
  {
    const anchors: Array<[number, number]> = [[0.18, 0.72], [0.82, 0.45], [0.22, 0.32], [0.78, 0.8]];
    const kinds: Array<"blue" | "gold"> = ["blue", "gold", "gold", "blue"];
    const nPlazas = Math.max(0, Math.min(4, Math.round(p.plazas)));
    const jit = (k: number, salt: number) => (hash2(seed, k, salt) - 0.5) * 0.16;
    for (let k = 0; k < nPlazas; k++) {
      // anchors drift per seed so plazas don't sit in the same spot every time
      const ax = Math.min(0.86, Math.max(0.14, anchors[k][0] + jit(k, 210)));
      const ay = Math.min(0.86, Math.max(0.2, anchors[k][1] + jit(k, 211)));
      stampPlaza(Math.round(M * ax), Math.round(M * ay), kinds[k]);
    }
  }

  // Red chamber: sunken 2×2 maze cells, dropped one tier — position drifts per seed.
  {
    const ri = Math.max(1, Math.min(M - 3, Math.round(M * (0.6 + (hash2(seed, 1, 212) - 0.5) * 0.3))));
    const rj = Math.max(Math.round(M * 0.42), Math.min(M - 3, Math.round(M * (0.78 + (hash2(seed, 2, 213) - 0.5) * 0.24))));
    let lo = 9;
    for (let j = rj; j <= rj + 1; j++) for (let i = ri; i <= ri + 1; i++) lo = Math.min(lo, mTier[mi(i, j)]);
    const rt = Math.max(0, lo - 1);
    for (let gy = 2 * rj + 1; gy <= 2 * rj + 3; gy++) {
      for (let gx = 2 * ri + 1; gx <= 2 * ri + 3; gx++) {
        if (plazaMask[gi(gx, gy)]) continue;
        setFloor(gx, gy, rt);
        redMask[gi(gx, gy)] = 1;
      }
    }
  }

  // Ravine (optional): a void band biting in from the south edge, west of center.
  let bridge: Bridge | null = null;
  if (p.ravineOn !== false) {
    const rvX = 2 * Math.round(M * 0.3); // wall-lattice column → band [rvX, rvX+2]
    const rvYEnd = Math.round(N * 0.55);
    for (let gy = N - 1; gy >= rvYEnd; gy--) {
      for (let gx = rvX; gx <= rvX + 2; gx++) {
        if (templeMask[gi(gx, gy)] || plazaMask[gi(gx, gy)] || redMask[gi(gx, gy)]) continue;
        kind[gi(gx, gy)] = VOID;
      }
    }
    // Bridge: northernmost ravine row where both banks are floor at equal tier.
    for (let gy = rvYEnd; gy < N - 1 && !bridge; gy++) {
      const a = gi(rvX - 1, gy), b = gi(rvX + 3, gy);
      if (kind[a] === FLOOR && kind[b] === FLOOR && tier[a] === tier[b]) {
        let clear = true;
        for (let gx = rvX; gx <= rvX + 2; gx++) if (kind[gi(gx, gy)] !== VOID) clear = false;
        if (clear) bridge = { axis: 0, at: gy, s0: rvX - 1, s1: rvX + 3, tier: tier[a] };
      }
    }
  }

  // Outer boundary stays wall unless the ravine already voided it.
  for (let k = 0; k < N; k++) {
    for (const c of [gi(k, 0), gi(k, N - 1), gi(0, k), gi(N - 1, k)]) {
      if (kind[c] !== VOID) { kind[c] = WALL; templeMask[c] = 0; }
    }
  }
  // (re-assert the door — boundary pass must not eat it; door sits at gy=1 so it survives.)

  // -- Stage 5: connectivity repair over the final floor graph.
  const entrance = { x: gcx, y: N - 2 };
  if (kind[gi(entrance.x, entrance.y)] !== FLOOR) return "entrance cell not floor";

  const passable = (a: number, b: number) =>
    kind[a] === FLOOR && kind[b] === FLOOR && Math.abs(tier[a] - tier[b]) <= 1;

  const comp = new Int16Array(N * N).fill(-1);
  const bfsComponents = (): number => {
    comp.fill(-1);
    let nc = 0;
    for (let s = 0; s < N * N; s++) {
      if (kind[s] !== FLOOR || comp[s] >= 0) continue;
      const q = [s];
      comp[s] = nc;
      for (let h = 0; h < q.length; h++) {
        const c = q[h], x = c % N, y = (c / N) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          const n = gi(nx, ny);
          if (comp[n] < 0 && passable(c, n)) { comp[n] = nc; q.push(n); }
        }
      }
      nc++;
    }
    return nc;
  };

  for (let guard = 0; guard < 60; guard++) {
    const nc = bfsComponents();
    if (nc <= 1) break;
    // find a wall (or blocked floor-floor edge) joining two components with Δtier ≤ 1
    let fixed = false;
    for (let y = 1; y < N - 1 && !fixed; y++) {
      for (let x = 1; x < N - 1 && !fixed; x++) {
        const c = gi(x, y);
        if (kind[c] === WALL && !doorMask[c]) {
          // opening a wall between two floor cells on opposite sides
          for (const [dA, dB] of [[0, 1], [2, 3]] as const) {
            const a = gi(x + DX[dA], y + DY[dA]), b = gi(x + DX[dB], y + DY[dB]);
            if (kind[a] !== FLOOR || kind[b] !== FLOOR) continue;
            if (comp[a] === comp[b] || comp[a] < 0 || comp[b] < 0) continue;
            if (Math.abs(tier[a] - tier[b]) > 2) continue;
            const t = Math.min(tier[a], tier[b]);
            kind[c] = FLOOR; tier[c] = t;
            if (Math.abs(tier[a] - tier[b]) === 2) tier[a] > tier[b] ? (tier[a] = t + 1) : (tier[b] = t + 1);
            fixed = true;
            break;
          }
        } else if (kind[c] === FLOOR) {
          // floor-floor edge blocked only by a tier cliff: relax the higher side
          for (const d of [0, 2] as Dir[]) {
            const nx = x + DX[d], ny = y + DY[d];
            if (nx >= N || ny >= N) continue;
            const n = gi(nx, ny);
            if (kind[n] !== FLOOR || comp[c] === comp[n] || comp[n] < 0) continue;
            const dt = tier[n] - tier[c];
            if (Math.abs(dt) !== 2) continue;
            if (templeMask[c] || templeMask[n] || plazaMask[c] || plazaMask[n]) continue;
            dt > 0 ? (tier[n] = tier[c] + 1) : (tier[c] = tier[n] + 1);
            fixed = true;
            break;
          }
        }
      }
    }
    if (!fixed) return "disconnected floor graph, no legal repair";
  }
  if (bfsComponents() > 1) return "still disconnected after repair budget";

  // reachability of the temple terrace from the entrance is implied by nc==1,
  // but assert it explicitly (it's the whole point of the fortress):
  if (templeOn && comp[gi(entrance.x, entrance.y)] !== comp[gi(gcx, 2)]) return "temple unreachable";

  // -- Stage 5.5: gates — openings in the outer wall where bridges dock.
  const gates: Gate[] = [];
  for (let gIdx = 0; gIdx < (p.gateSides ?? []).length; gIdx++) {
    const side = (p.gateSides ?? [])[gIdx] as Dir;
    const wantRow = p.gateRows?.[gIdx];
    let best = -1, bestScore = Infinity;
    for (let t = 1; t < N - 1; t++) {
      const bx = side === 0 ? N - 1 : side === 1 ? 0 : t;
      const by = side === 2 ? N - 1 : side === 3 ? 0 : t;
      const ix = side === 0 ? N - 2 : side === 1 ? 1 : t;
      const iy = side === 2 ? N - 2 : side === 3 ? 1 : t;
      const b = gi(bx, by), inn = gi(ix, iy);
      if (kind[b] !== WALL || kind[inn] !== FLOOR) continue;
      if (side === 3 && Math.abs(bx - gcx) < 5) continue; // never punch through the temple backdrop
      const score = wantRow !== undefined
        ? Math.abs(t - wantRow) * 3 + hash2(seed, b, 121)
        : Math.abs(t - (N - 1) / 2) + hash2(seed, b, 121) * 4;
      if (score < bestScore) { bestScore = score; best = t; }
    }
    if (best < 0) continue;
    const bx = side === 0 ? N - 1 : side === 1 ? 0 : best;
    const by = side === 2 ? N - 1 : side === 3 ? 0 : best;
    const ix = side === 0 ? N - 2 : side === 1 ? 1 : best;
    const iy = side === 2 ? N - 2 : side === 3 ? 1 : best;
    const b = gi(bx, by);
    kind[b] = FLOOR;
    tier[b] = tier[gi(ix, iy)];
    gates.push({ x: bx, y: by, dir: side, tier: tier[b] });
  }

  // -- Stage 6: stairs (in the lower cell of every Δtier=1 adjacency).
  const stairMask = new Uint8Array(N * N);
  const stairs: Stair[] = [];
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      const c = gi(x, y);
      if (kind[c] !== FLOOR || stairMask[c]) continue;
      if (medallionCenter(medallions, x, y)) continue;
      for (let d = 0 as Dir; d < 4; d++) {
        const n = gi(x + DX[d], y + DY[d]);
        if (kind[n] === FLOOR && tier[n] === tier[c] + 1) {
          stairs.push({ x, y, dir: d as Dir, tier: tier[c] });
          stairMask[c] = 1;
          break;
        }
      }
    }
  }

  // -- Stage 7: wall heights.
  const wallTop = new Int8Array(N * N);
  const wallBase = new Int8Array(N * N);
  {
    const done = new Uint8Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const c = gi(x, y);
        if (kind[c] !== WALL) continue;
        let hi = -99, lo = 99, voidAdj = false;
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) { voidAdj = true; continue; }
          const n = gi(nx, ny);
          if (kind[n] === FLOOR) { hi = Math.max(hi, tier[n]); lo = Math.min(lo, tier[n]); }
          if (kind[n] === VOID) voidAdj = true;
        }
        if (hi > -99) {
          wallTop[c] = hi + 2;
          wallBase[c] = voidAdj ? ABYSS : lo;
          done[c] = 1;
        }
      }
    }
    // interior wall mass (lattice crossings with no 4-adjacent floor): copy neighbors
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const c = gi(x, y);
          if (kind[c] !== WALL || done[c]) continue;
          let top = -99, base = 99;
          for (let d = 0; d < 4; d++) {
            const nx = x + DX[d], ny = y + DY[d];
            if (nx < 0 || ny < 0 || nx >= N || ny >= N) { base = Math.min(base, ABYSS); continue; }
            const n = gi(nx, ny);
            if (kind[n] === WALL && done[n]) { top = Math.max(top, wallTop[n]); base = Math.min(base, wallBase[n]); }
            if (kind[n] === VOID) base = Math.min(base, ABYSS);
          }
          if (top > -99) { wallTop[c] = top; wallBase[c] = Math.min(base, top - 1); done[c] = 1; }
        }
      }
    }
    // stragglers (fully enclosed): flat default
    for (let c = 0; c < N * N; c++) if (kind[c] === WALL && !done[c]) { wallTop[c] = 3; wallBase[c] = 0; }
    // temple building override
    if (temple) {
      for (let gx = gcx - 2; gx <= gcx + 2; gx++) {
        const c = gi(gx, 1);
        wallTop[c] = temple.buildTop;
        wallBase[c] = temple.platformTier - 1;
      }
      // north backdrop behind the building
      for (let gx = gcx - 3; gx <= gcx + 3; gx++) {
        const c = gi(gx, 0);
        if (kind[c] === WALL) { wallTop[c] = Math.max(wallTop[c], temple.buildTop - 1); }
      }
    }
    // silhouette variety on long outer walls
    for (let k = 1; k < N - 1; k++) {
      for (const c of [gi(k, 0), gi(0, k), gi(N - 1, k)]) {
        if (kind[c] === WALL && hash2(seed, c, 77) < 0.32) wallTop[c] += hash2(seed, c, 78) < 0.3 ? 2 : 1;
      }
    }
  }

  // -- Stage 8: support masonry under raised floors.
  const support = new Int8Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const c = gi(x, y);
      if (kind[c] !== FLOOR) continue;
      let base = tier[c];
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) { base = Math.min(base, ABYSS); continue; }
        const n = gi(nx, ny);
        if (kind[n] === FLOOR) base = Math.min(base, tier[n]);
        if (kind[n] === VOID) base = Math.min(base, ABYSS);
      }
      support[c] = base;
    }
  }

  // -- Stage 8.5: ruin — some walls have crumbled over the centuries.
  const ruinMask = new Uint8Array(N * N);
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      const c = gi(x, y);
      if (kind[c] !== WALL || doorMask[c]) continue;
      if (y === 1 && Math.abs(x - gcx) <= 2) continue; // never ruin the temple
      if (hash2(seed, c, 33) > 0.16 * p.decay) continue;
      let hi = -99;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx >= 0 && ny >= 0 && nx < N && ny < N && kind[gi(nx, ny)] === FLOOR) hi = Math.max(hi, tier[gi(nx, ny)]);
      }
      if (hi < -90) continue;
      const drop = 1 + (hash2(seed, c, 34) < 0.4 ? 1 : 0);
      const newTop = Math.max(hi + 1, wallTop[c] - drop);
      if (newTop < wallTop[c]) { wallTop[c] = newTop; ruinMask[c] = 1; }
    }
  }

  // -- Stage 9: towers.
  const towers: Tower[] = [];
  for (const [tx, ty] of [[0, 0], [N - 1, 0], [0, N - 1], [N - 1, N - 1]] as const) {
    const c = gi(tx, ty);
    if (kind[c] !== WALL) continue;
    wallTop[c] += 3;
    towers.push({ x: tx, y: ty, top: wallTop[c], beacon: false, scale: 1.45 });
  }
  {
    // one tall beacon tower on the east side, at the highest local wall
    let best = -1, bestTop = -1;
    for (let y = Math.round(N * 0.2); y < Math.round(N * 0.55); y++) {
      for (let x = Math.round(N * 0.72); x < N - 1; x++) {
        const c = gi(x, y);
        if (kind[c] !== WALL || doorMask[c]) continue;
        if (wallTop[c] > bestTop) { bestTop = wallTop[c]; best = c; }
      }
    }
    if (best >= 0) {
      const bx = best % N, by = (best / N) | 0;
      wallTop[best] += 8;
      towers.push({ x: bx, y: by, top: wallTop[best], beacon: true, scale: 1.6 });
    }
  }

  // -- Stage 10: torches along walls (min Chebyshev spacing via buckets).
  const torches: Torch[] = [];
  const TSPACE = Math.max(3, Math.round(p.torchSpacing));
  const tbw = Math.ceil(N / TSPACE);
  const buckets = new Map<number, Array<{ x: number; y: number }>>();
  const near = (x: number, y: number, space: number): boolean => {
    const bx = (x / TSPACE) | 0, by = (y / TSPACE) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const list = buckets.get((by + dy) * tbw + (bx + dx));
      if (!list) continue;
      for (const t of list) if (Math.max(Math.abs(t.x - x), Math.abs(t.y - y)) < space) return true;
    }
    return false;
  };
  const claim = (x: number, y: number) => {
    const bk = ((y / TSPACE) | 0) * tbw + ((x / TSPACE) | 0);
    let list = buckets.get(bk);
    if (!list) { list = []; buckets.set(bk, list); }
    list.push({ x, y });
  };
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      const c = gi(x, y);
      if (kind[c] !== WALL || doorMask[c]) continue;
      let dir: Dir | null = null, best = -99;
      for (let d = 0 as Dir; d < 4; d++) {
        const n = gi(x + DX[d], y + DY[d]);
        if (kind[n] === FLOOR && tier[n] > best) { best = tier[n]; dir = d as Dir; }
      }
      if (dir === null || near(x, y, TSPACE)) continue;
      claim(x, y);
      torches.push({ x, y, dir, tier: best });
    }
  }
  // temple doorway sconces
  if (temple) for (const gx of [gcx - 1, gcx + 1]) {
    torches.push({ x: gx, y: 1, dir: 2, tier: temple.platformTier });
  }

  // -- Stage 11: banners on tall wall faces (their own spacing lattice).
  const banners: Banner[] = [];
  const torchKeys = new Set(torches.map((t) => t.y * N + t.x));
  {
    const chosen: Array<{ x: number; y: number }> = [];
    for (let y = 1; y < N - 1; y++) {
      for (let x = 1; x < N - 1; x++) {
        const c = gi(x, y);
        if (kind[c] !== WALL || doorMask[c] || torchKeys.has(c)) continue;
        let dir: Dir | null = null, ft = -99;
        for (let d = 0 as Dir; d < 4; d++) {
          const n = gi(x + DX[d], y + DY[d]);
          if (kind[n] === FLOOR && tier[n] > ft) { ft = tier[n]; dir = d as Dir; }
        }
        if (dir === null || wallTop[c] - ft < 3) continue;
        if (chosen.some((q) => Math.max(Math.abs(q.x - x), Math.abs(q.y - y)) < 5)) continue;
        if (hash2(seed, c, 913) > 0.85) continue;
        chosen.push({ x, y });
        banners.push({ x, y, dir, tier: ft, top: wallTop[c] });
      }
    }
    // forced pair flanking the temple door
    if (temple) for (const gx of [gcx - 2, gcx + 2]) {
      banners.push({ x: gx, y: 1, dir: 2, tier: temple.platformTier, top: temple.buildTop });
    }
  }

  // -- Stage 12: braziers around medallions + temple terrace.
  const braziers: Brazier[] = [];
  for (const m of medallions) {
    for (let k = 0; k < 4; k++) {
      const a = Math.PI * 0.25 + (k * Math.PI) / 2;
      const bx = Math.round(m.x + Math.cos(a) * (m.r + 0.2));
      const by = Math.round(m.y + Math.sin(a) * (m.r + 0.2));
      const c = gi(bx, by);
      if (kind[c] === FLOOR && !stairMask[c]) braziers.push({ x: bx, y: by, tier: tier[c], kind: m.kind });
    }
  }
  if (temple) for (const rx of [gcx - 3, gcx + 3]) braziers.push({ x: rx, y: 2, tier: temple.platformTier, kind: "gold" });
  {
    // one red brazier at the heart of the red chamber
    let cx = 0, cy = 0, n = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (redMask[gi(x, y)]) { cx += x; cy += y; n++; }
    if (n > 0) {
      const bx = Math.round(cx / n), by = Math.round(cy / n);
      if (kind[gi(bx, by)] === FLOOR) braziers.push({ x: bx, y: by, tier: tier[gi(bx, by)], kind: "red" });
    }
  }

  // -- Stage 13: brazier totems at corridor dead ends (deterministic pick).
  {
    const nTotems = Math.max(0, Math.min(10, Math.round(p.totems)));
    if (nTotems > 0) {
      const cands: Array<{ x: number; y: number; h: number }> = [];
      for (let y = 1; y < N - 1; y++) {
        for (let x = 1; x < N - 1; x++) {
          const c = gi(x, y);
          if (kind[c] !== FLOOR || stairMask[c] || plazaMask[c] || templeMask[c] || redMask[c]) continue;
          if (x === entrance.x && y === entrance.y) continue;
          let deg = 0;
          for (let d = 0; d < 4; d++) if (kind[gi(x + DX[d], y + DY[d])] === FLOOR) deg++;
          if (deg !== 1) continue; // dead end — a shrine-worthy alcove
          cands.push({ x, y, h: hash2(seed, c, 55) });
        }
      }
      cands.sort((a, b) => a.h - b.h);
      const taken: Array<{ x: number; y: number }> = [];
      for (const t of cands) {
        if (taken.length >= nTotems) break;
        if (taken.some((q) => Math.max(Math.abs(q.x - t.x), Math.abs(q.y - t.y)) < 5)) continue;
        if (medallions.some((m) => Math.hypot(m.x - t.x, m.y - t.y) < m.r + 2)) continue;
        taken.push(t);
        braziers.push({ x: t.x, y: t.y, tier: tier[gi(t.x, t.y)], kind: "gold", totem: true });
      }
    }
  }

  // -- Final validation + stats.
  let floor = 0, wall = 0;
  for (let c = 0; c < N * N; c++) {
    if (kind[c] === FLOOR) floor++;
    else if (kind[c] === WALL) wall++;
  }
  if (floor < N * N * 0.28) return "too little floor";
  if (stairs.length < 6) return "too flat (no stairs)";

  return {
    seed, name: makeName(rng), N, params: p,
    kind, tier, wallTop, wallBase, support,
    stairMask, ruinMask, redMask, templeMask, plazaMask, doorMask,
    stairs, gates, torches, banners, towers, medallions, braziers, bridge, door,
    doorDir: 2, templeCells,
    entrance,
    temple,
    stats: { floor, wall, attempts: 1, genMs: 0 },
  };
}

function medallionCenter(meds: Medallion[], x: number, y: number): boolean {
  return meds.some((m) => Math.hypot(m.x - x, m.y - y) < 1.5);
}

// ---------------------------------------------------------------------------
// Rotation — orientation variety. One application of R maps (x,y) → (y, N-1-x);
// every grid, feature position and direction maps through it, so a rotated
// Layout is indistinguishable from a natively-generated one downstream.

const DIR_MAP: readonly Dir[] = [3, 2, 0, 1]; // where dir d points after one R

function rotateOnce(l: Layout): Layout {
  const N = l.N;
  const gi = (x: number, y: number) => y * N + x;
  const mapGrid = <T extends Uint8Array | Int8Array>(g: T): T => {
    const out = new (g.constructor as new (n: number) => T)(g.length);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) out[gi(y, N - 1 - x)] = g[gi(x, y)];
    return out;
  };
  const mp = <F extends { x: number; y: number }>(f: F): F => ({ ...f, x: f.y, y: N - 1 - f.x });
  const md = (d: Dir): Dir => DIR_MAP[d];
  const bridge: Bridge | null = l.bridge === null ? null
    : l.bridge.axis === 0
      ? { axis: 1, at: l.bridge.at, s0: N - 1 - l.bridge.s1, s1: N - 1 - l.bridge.s0, tier: l.bridge.tier }
      : { axis: 0, at: N - 1 - l.bridge.at, s0: l.bridge.s0, s1: l.bridge.s1, tier: l.bridge.tier };
  return {
    ...l,
    kind: mapGrid(l.kind), tier: mapGrid(l.tier), wallTop: mapGrid(l.wallTop),
    wallBase: mapGrid(l.wallBase), support: mapGrid(l.support),
    stairMask: mapGrid(l.stairMask), ruinMask: mapGrid(l.ruinMask), redMask: mapGrid(l.redMask),
    templeMask: mapGrid(l.templeMask), plazaMask: mapGrid(l.plazaMask), doorMask: mapGrid(l.doorMask),
    stairs: l.stairs.map((s) => ({ ...mp(s), dir: md(s.dir) })),
    gates: l.gates.map((g) => ({ ...mp(g), dir: md(g.dir) })),
    torches: l.torches.map((t) => ({ ...mp(t), dir: md(t.dir) })),
    banners: l.banners.map((b) => ({ ...mp(b), dir: md(b.dir) })),
    towers: l.towers.map(mp),
    medallions: l.medallions.map(mp),
    braziers: l.braziers.map(mp),
    bridge,
    door: l.door === null ? null : mp(l.door),
    doorDir: md(l.doorDir),
    templeCells: l.templeCells.map((c) => {
      const x = c % N, y = Math.floor(c / N);
      return gi(y, N - 1 - x);
    }),
    entrance: mp(l.entrance),
  };
}

/** unrotate a world-space gate request so that after `k` rotations the carved
 *  gate lands on the requested side (and near the requested row) */
function unrotateGates(sides: number[], rows: number[] | undefined, k: number, N: number):
{ gateSides: number[]; gateRows?: number[] } {
  const inv = (x: number, y: number): [number, number] => [N - 1 - y, x]; // R⁻¹
  const outS: number[] = [], outR: number[] = [];
  sides.forEach((side, idx) => {
    const t = rows?.[idx] ?? Math.floor(N / 2);
    let x = side === 0 ? N - 1 : side === 1 ? 0 : t;
    let y = side === 2 ? N - 1 : side === 3 ? 0 : t;
    for (let i = 0; i < k; i++) [x, y] = inv(x, y);
    const s0 = x === N - 1 ? 0 : x === 0 ? 1 : y === N - 1 ? 2 : 3;
    outS.push(s0);
    outR.push(s0 <= 1 ? y : x);
  });
  return { gateSides: outS, gateRows: rows ? outR : undefined };
}

export function generate(input: number | Partial<Params>): Layout {
  const p: Params = typeof input === "number"
    ? { ...DEFAULT_PARAMS, seed: input }
    : { ...DEFAULT_PARAMS, ...input };
  const t0 = performance.now();
  const k = ((Math.round(p.rot ?? 0) % 4) + 4) % 4;
  // gates are requested in world space — unrotate the request before the
  // pipeline so post-rotation gates land where the caller asked
  const N = 2 * (Math.max(7, Math.min(23, Math.round(p.size))) | 0) + 1;
  const pGen = k > 0 && p.gateSides
    ? { ...p, ...unrotateGates(p.gateSides, p.gateRows, k, N) }
    : p;
  const reasons: string[] = [];
  for (let a = 0; a < 6; a++) {
    const s = (Math.imul(p.seed + a, 0x9e3779b1) ^ Math.imul(a, 0x85ebca6b)) >>> 0;
    let r = attempt(pGen, s === 0 ? 1 : s);
    if (typeof r === "string") { reasons.push(r); continue; }
    for (let i = 0; i < k; i++) r = rotateOnce(r);
    r.params = p; // report the world-space params
    r.stats.attempts = a + 1;
    r.stats.genMs = Math.round((performance.now() - t0) * 100) / 100;
    (r as { seed: number }).seed = p.seed; // report the user-facing seed
    return r;
  }
  throw new Error(`dungeon generation failed after 6 attempts (seed=${p.seed}): ${reasons.join("; ")}`);
}

/** FNV-1a over the structural arrays — determinism tests + HUD. */
export function checksum(l: Layout): number {
  let h = 0x811c9dc5;
  const mix = (v: number) => { h ^= v & 0xff; h = Math.imul(h, 0x01000193); };
  for (let i = 0; i < l.kind.length; i++) { mix(l.kind[i]); mix(l.tier[i] + 16); mix(l.wallTop[i] + 16); }
  for (const s of l.stairs) { mix(s.x); mix(s.y); mix(s.dir); }
  for (const t of l.torches) { mix(t.x); mix(t.y); }
  return h >>> 0;
}
