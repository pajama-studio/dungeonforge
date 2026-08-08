import { generateSpatialPlan } from "../src/markov/spatial-plan";
import { generateInteriorVolumePlan } from "../src/markov/volume-plan";

const rounds = Math.max(1, Number(process.argv[2] ?? 10_000));
const measure = (label: string, fn: (seed: number) => unknown) => {
  for (let i = 0; i < 200; i++) fn(i + 1);
  const start = performance.now();
  for (let i = 0; i < rounds; i++) fn(i + 1);
  const elapsed = performance.now() - start;
  console.log(`${label}: ${elapsed.toFixed(2)} ms total · ${(elapsed * 1000 / rounds).toFixed(2)} µs/call`);
};

measure("interior-volume", (seed) => generateInteriorVolumePlan(15, seed));
measure("spatial-plan", (seed) => generateSpatialPlan(20, seed));

const samples = Math.min(rounds, 1_000);
let blocks = 0, districts = 0, horizontal = 0, fused = 0, galleries = 0, courts = 0;
for (let seed = 1; seed <= samples; seed++) {
  const plan = generateSpatialPlan(20, seed);
  blocks += plan.cells.length;
  districts += plan.stats.districts;
  fused += plan.stats.fusedLinks;
  horizontal += plan.cells.filter((cell) => cell.parent >= 0 && cell.dirFromParent < 4).length;
  galleries += plan.cells.filter((cell) => cell.joinFromParent === "gallery").length;
  courts += plan.stats.crossBlockCourts;
}
console.log(JSON.stringify({
  samples,
  blocksPerDistrict: blocks / districts,
  districtDensity: districts / blocks,
  fusedHorizontalRate: fused / horizontal,
  galleryRate: galleries / horizontal,
  crossBlockCourtRate: courts / horizontal,
}, null, 2));
