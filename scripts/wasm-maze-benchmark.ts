import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initSync, generate_maze_core } from "../src/gen/wasm-pkg/dungeon_core.js";
import { generateMazeCoreTs, mazeCoreChecksum, type MazeCoreParams } from "../src/gen/maze-core";
import { Rng } from "../src/gen/rng";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const rounds = Math.max(1, Number(args.get("--rounds") ?? 100));
const output = args.get("--output");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
initSync({ module: readFileSync(resolve(root, "src/gen/wasm-pkg/dungeon_core_bg.wasm")) });

const params: MazeCoreParams = { newest: 0.7, braid: 0.45, loops: 0.08, heightAmp: 3, mound: 3.7 };
const cases = Array.from({ length: 24 }, (_, i) => ({
  size: [9, 11, 13, 15, 19, 23][i % 6],
  seed: (0x1234567 + Math.imul(i + 1, 0x9e3779b1)) >>> 0,
}));
const biases = cases.map(({ size, seed }) => {
  const bias = new Int8Array(size * size);
  for (let i = 0; i < bias.length; i++) {
    const h = Math.imul(seed ^ i, 0x85ebca6b) >>> 0;
    bias[i] = h % 13 === 0 ? 1 : h % 29 === 0 ? -1 : 0;
  }
  return bias;
});

let semanticMismatches = 0;
let quality = { deadEnds: 0, cycleRank: 0, verticalEdges: 0, tierSpan: 0 };
for (let i = 0; i < cases.length; i++) {
  const c = cases[i], bias = biases[i];
  const ts = generateMazeCoreTs(c.size, c.seed, params, bias, new Rng(c.seed));
  const wasm = generate_maze_core(c.size, c.seed, params.newest, params.braid, params.loops, params.heightAmp, params.mound, bias);
  const wr = { tiers: wasm.tiers, open: wasm.open, rngDraws: wasm.rng_draws };
  if (mazeCoreChecksum(ts) !== mazeCoreChecksum(wr)) semanticMismatches++;
  quality.deadEnds += wasm.dead_ends;
  quality.cycleRank += wasm.cycle_rank;
  quality.verticalEdges += wasm.vertical_edges;
  quality.tierSpan += wasm.tier_span;
  wasm.free();
}

const quantile = (values: number[], q: number) => {
  const a = [...values].sort((x, y) => x - y);
  const p = (a.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return a[lo] + (a[hi] - a[lo]) * (p - lo);
};
const tsMs: number[] = [], wasmMs: number[] = [];
for (let loop = 0; loop < rounds + 12; loop++) {
  let t = performance.now();
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    generateMazeCoreTs(c.size, c.seed, params, biases[i], new Rng(c.seed));
  }
  const ts = performance.now() - t;
  t = performance.now();
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const result = generate_maze_core(c.size, c.seed, params.newest, params.braid, params.loops, params.heightAmp, params.mound, biases[i]);
    // Include the real boundary cost: both typed arrays are copied into JS.
    void result.tiers; void result.open;
    result.free();
  }
  const wasm = performance.now() - t;
  if (loop >= 12) { tsMs.push(ts); wasmMs.push(wasm); }
}
const tsMedian = quantile(tsMs, 0.5), wasmMedian = quantile(wasmMs, 0.5);
const report = {
  schema: 1,
  rounds,
  casesPerRound: cases.length,
  wasmBytes: readFileSync(resolve(root, "src/gen/wasm-pkg/dungeon_core_bg.wasm")).byteLength,
  semanticMismatches,
  qualityAverage: Object.fromEntries(Object.entries(quality).map(([k, v]) => [k, v / cases.length])),
  typescript: { medianMs: tsMedian, p95Ms: quantile(tsMs, 0.95) },
  wasm: { medianMs: wasmMedian, p95Ms: quantile(wasmMs, 0.95) },
  speedup: tsMedian / wasmMedian,
};
if (output) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report));
if (semanticMismatches > 0) process.exitCode = 1;
