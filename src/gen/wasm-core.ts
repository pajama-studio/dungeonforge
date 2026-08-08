import type { Rng } from "./rng";
import type { MazeCoreParams, MazeCoreResult } from "./maze-core";
import initWasm, * as wasmModule from "./wasm-pkg/dungeon_core.js";

let modulePromise: Promise<typeof wasmModule> | null = null;

/** Lazy by design: ordinary startup never downloads or compiles WASM unless
 * `?gen=wasm` or the benchmark explicitly requests it. */
export function loadWasmMazeCore(precompiled?: WebAssembly.Module): Promise<typeof wasmModule> {
  modulePromise ??= initWasm(precompiled ? { module_or_path: precompiled } : undefined).then(() => wasmModule);
  return modulePromise;
}

export async function makeWasmMazeCoreGenerator(precompiled?: WebAssembly.Module) {
  const module = await loadWasmMazeCore(precompiled);
  return (
    size: number,
    seed: number,
    p: MazeCoreParams,
    volumeBias: Int8Array,
    rng: Rng,
  ): MazeCoreResult => {
    const raw = module.generate_maze_core(
      size, seed, p.newest, p.braid, p.loops, p.heightAmp, p.mound, volumeBias,
    );
    try {
      const rngDraws = raw.rng_draws;
      // Downstream landmarks use the same Rng object. Advance it by exactly
      // the draws consumed inside Rust so the full Layout stays seed-identical.
      rng.discard(rngDraws);
      return {
        tiers: raw.tiers,
        open: raw.open,
        rngDraws,
        quality: {
          deadEnds: raw.dead_ends,
          cycleRank: raw.cycle_rank,
          verticalEdges: raw.vertical_edges,
          tierSpan: raw.tier_span,
        },
      };
    } finally {
      raw.free();
    }
  };
}
