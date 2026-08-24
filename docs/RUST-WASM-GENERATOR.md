# Rust/WASM maze core A/B

Rust takes over only the growing-tree, tier height, braid and extra-loop hot spots. It
outputs an `Int8Array tiers` and a `Uint8Array open`; all the remaining landmark, narrative,
rotation, validation and Layout assembly work stays in the TypeScript worker.

The reasons for doing it this way:

- The WASM boundary copies only two small arrays per block.
- The production worker never downloads or compiles WASM; the experimental module is
  loaded only by the standalone benchmark.
- Any failure can fall back to the TypeScript backend.
- Rust returns the RNG draw count, so the TS side's subsequent RNG state stays exactly
  consistent.

## 100-round result

The workload is 24 different seeds/sizes per round, including the real typed-array
boundary copies:

| Metric | TypeScript | Rust/WASM |
|---|---:|---:|
| median | 2.137 ms | 1.135 ms |
| P95 | 5.760 ms | 2.857 ms |
| core speedup | 1.00× | 1.88× |
| semantic checksum mismatch | — | 0 / 24 |
| release WASM | — | 24,919 bytes |

A faster core does not mean a faster page cold start. In a cache-cleared, same-seed,
20-island comparison, plain TS reached first visible in 416.6ms; even compiling the module
once and handing it to the worker ahead of time, the WASM A/B still took about 1.31s. The
generation time recorded inside each layout is still only about 5–14ms — the extra time
comes mostly from several workers instantiating WASM while the first WebGPU pipeline
compile contends for the same cold-start CPU.

So the current conclusion is: pull the runtime WASM wiring out of the demo and keep only
the reproducible crate, artifacts and benchmark; the normal path has been confirmed to
issue no `.wasm` resource request. Rust does not automatically improve map quality by
itself; the roughly 1.9× kernel budget it provides should be spent in the next phase on
generating 4–8 candidates in parallel, or on support-graph computation, then scoring them
by path diameter, loop distribution, bottlenecks, vertical variation and narrative
constraints and picking the best. Reconnecting it to the production generation pool is
worth reconsidering once a single-worker / shared-memory lifecycle scheme passes the full
forge regression.

Reproduce:

```sh
npm run build:wasm
npm run bench:wasm -- --rounds 100 --output artifacts/wasm-maze-100.json
```

The page always uses the stable TypeScript worker pool; `npm run bench:wasm` is the only
entry point that enables Rust/WASM.
