import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as THREE from "three/webgpu";
import { checksum, generate, type Layout, type Params } from "../src/gen/dungeon";
import { buildWorld } from "../src/scene/build";

interface Sample {
  loop: number;
  generationMs: number;
  buildMs: number;
  checksum: number;
  instances: number;
  renderObjects: number;
}

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const rounds = Math.max(1, Number(args.get("--rounds") ?? 100));
const warmup = Math.max(0, Number(args.get("--warmup") ?? 12));
const label = args.get("--label") ?? "run";
const output = args.get("--output");

// Mix the common chain footprint with large/rotated/gated layouts. Keeping the
// workload deterministic makes before/after comparisons useful and checksum
// drift immediately visible.
const CASES: ReadonlyArray<Partial<Params>> = Array.from({ length: 12 }, (_, i) => ({
  seed: (0x1234567 + Math.imul(i + 1, 0x9e3779b1)) >>> 0,
  size: i % 4 === 0 ? 23 : i % 4 === 1 ? 19 : 15,
  rot: i & 3,
  gateSides: i % 3 === 0 ? [0, 2] : i % 3 === 1 ? [1] : [3, 0],
  gateRows: i % 3 === 0 ? [9, 17] : i % 3 === 1 ? [13] : [11, 21],
  templeOn: i % 5 !== 4,
  ravineOn: i % 4 !== 3,
}));

function generateBatch(): { layouts: Layout[]; hash: number } {
  const layouts = new Array<Layout>(CASES.length);
  let hash = 0x811c9dc5;
  for (let i = 0; i < CASES.length; i++) {
    const layout = generate(CASES[i]);
    layouts[i] = layout;
    hash = Math.imul(hash ^ checksum(layout), 0x01000193) >>> 0;
  }
  return { layouts, hash };
}

const scene = new THREE.Scene();
function buildBatch(layouts: Layout[]): { instances: number; renderObjects: number } {
  // Four stable slots model the chain builder's reuse behavior while still
  // exercising buffer growth when a larger case rotates into a slot.
  for (let i = 0; i < layouts.length; i++) buildWorld(layouts[i], i & 3, scene, 1, -1);
  let instances = 0;
  let renderObjects = 0;
  scene.traverse((o) => {
    if (!(o instanceof THREE.InstancedMesh)) return;
    instances += o.count;
    renderObjects++;
  });
  return { instances, renderObjects };
}

function quantile(values: number[], q: number): number {
  const a = [...values].sort((x, y) => x - y);
  const p = (a.length - 1) * q;
  const lo = Math.floor(p), hi = Math.ceil(p);
  return a[lo] + (a[hi] - a[lo]) * (p - lo);
}

for (let i = 0; i < warmup; i++) {
  const { layouts } = generateBatch();
  buildBatch(layouts);
}

const samples: Sample[] = [];
for (let loop = 1; loop <= rounds; loop++) {
  const g0 = performance.now();
  const { layouts, hash } = generateBatch();
  const generationMs = performance.now() - g0;
  const b0 = performance.now();
  const counts = buildBatch(layouts);
  const buildMs = performance.now() - b0;
  samples.push({ loop, generationMs, buildMs, checksum: hash, ...counts });
}

const gen = samples.map((s) => s.generationMs);
const build = samples.map((s) => s.buildMs);
const result = {
  schema: 1,
  label,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  workload: { rounds, warmup, casesPerLoop: CASES.length },
  summary: {
    generationMedianMs: quantile(gen, 0.5),
    generationP95Ms: quantile(gen, 0.95),
    buildMedianMs: quantile(build, 0.5),
    buildP95Ms: quantile(build, 0.95),
    combinedMedianMs: quantile(samples.map((s) => s.generationMs + s.buildMs), 0.5),
  },
  samples,
};

if (output) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result));
