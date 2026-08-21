# Dungeonforge performance work: 100-loop final report

Date: 2026-08-07  
CPU: Apple Silicon / Node v22.22.2 (arm64)  
GPU: Apple M1 Max / Chrome WebGPU Metal  

## Conclusion

| Metric | Before | Current final | Improvement |
|---|---:|---:|---:|
| dungeon generation median (12 layouts per loop) | 12.07 ms | 9.65 ms | 20.0% |
| dungeon generation P95 | 17.28 ms | 12.56 ms | 27.3% |
| scene build median (12 layouts per loop) | 50.35 ms | 38.84 ms | 22.9% |
| scene build P95 | 70.82 ms | 44.48 ms | 37.2% |
| generation + build median | 62.63 ms | 48.48 ms | 22.6% |
| GPU frame median | 21.45 ms | 19.85 ms | 7.5% |
| GPU frame P95 | 23.81 ms | 22.59 ms | 5.1% |
| GPU median throughput | 46.62 FPS | 50.38 FPS | 8.1% faster |

Both CPU and GPU ran 100 consecutive loops on the current code. The GPU scene is fixed at 1280×720 with 8 islands; it currently includes randomized courtyard shafts, chests, enemies, occlusion silhouettes and dual LOD instances, for 39,999 visible instances, 337 visible render objects and 3,645,792 triangles. Each GPU loop submits 6 consecutive frames and waits for the WebGPU queue to actually finish.

LOD got a separate 100-round far→near→far stress regression: toggle CPU median 0.00 ms, first completed close-up frame median 1.35 ms, P95 20.20 ms, max 26.60 ms. The first pull-in hitch originally measured 403.3 ms; there is no longer a 200–400 ms shader/binding-creation spike.

## What this round implemented

- Vertical junction points are chosen from the seed before the worker generates, and fed into the generator as a `VerticalAnchor`. The maze first reserves a solid stair core and carves the 3×3 platform and entrance, then generates landmarks and runs whole-map connectivity repair. Stair positions therefore genuinely change the maze route rather than being pasted on after rendering.
- Ordinary chained dungeons pick a random point in the interior safe area of the two overlapping floors and maximize the spacing between multiple shafts on the same floor; they are no longer all attached to the outer wall. Upper and lower floors hold the same link id, the landing world coordinates align exactly, and walkable stone landings fill the gap from the floor to the first/last tread.
- When a random platform hits the height discontinuity of a temple/plaza, the generator produces a stepped transition at the landmark boundary instead of moving the shaft or emitting a broken route; a fixed regression test for the Reliquary's original failing seed was added.
- The navigation cache key includes the live counts of islands, bridges, stairs and blockers, so opening a route midway through generating a large scene will not freeze a half-built portal graph.
- The route map excludes support-pillar blockers; bridge reverse-backtrack points are ordered by the actual direction of travel, eliminating the mid-bridge spin-around.
- Far and near LOD pre-warm real WebGPU render objects, and the high/low models share an instance buffer; at runtime only `count` is switched, and render objects are no longer invalidated.
- When a skeleton is occluded by architecture, a cyan transparent silhouette that only passes the occlusion depth test is added; LOS uses the existing mesh/pillar data and runs at 12 Hz.
- A chest that can be clicked open is placed in front of every portal; 2–4 enemies are deterministically scattered per island. All population systems are fixed at five instanced render objects.

## Correctness guardrails

- The layout checksum across the current 100 loops is 2390378026 throughout, with no per-loop drift.
- The CPU benchmark reports 39,822 instances and 126 render objects every loop.
- Vitest: 28/28 passing; TypeScript `--noEmit` and the production build pass.
- The 8-block chained dungeon on seed 20260806: all 6 shaft positions differ, paired upper/lower landing x/z error is 0; 761 route points pass through 0 pillars, and all 8 blocks are reachable.
- Cube: 27 blocks, all 18 interior shaft positions differ, 142 directed portals; 2,564 route points pass through 0 pillars, all reachable.
- Reliquary: 19 blocks, 18 random vertical junctions, 112 directed portals; 2,352 route points pass through 0 pillars, all reachable.

## Performance experiments kept and rejected

- Kept: the typed-array BFS queue, merged rotated-grid traversal, squared-distance hot paths, the instance arena / accumulated bounding box, wall neighbourhood precomputation and the fixed 24-light pool.
- Volumetric fog raymarch 5 → 4 steps gave a GPU median of 15.08 ms, no improvement, so it was reverted.

Final data: [CPU 100 loops](results/final-randomized-vertical-cpu.json), [GPU 100 loops](results/gpu-randomized-vertical-final.json), [LOD 100 loops](results/lod-transition-100-random-vertical-final.json). Baselines: [CPU](results/baseline.json), [GPU](results/gpu-lights28-final.json). Final screenshots: [8-level chained dungeon](final-randomized-vertical.png), [Reliquary](reliquary-final.png).

## Per-loop data

Each CPU loop is the same set of 12 fixed layouts; each GPU loop is the average of 6 consecutive frames. Aligning the two independent runs by index only shows the raw variance — the final judgement uses the 100-loop median/P95.

| Loop | Gen before ms | Gen now ms | Build before ms | Build now ms | CPU total before ms | CPU total now ms | CPU row change | GPU before ms | GPU now ms | GPU row change |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 11.76 | 11.03 | 46.62 | 37.02 | 58.38 | 48.04 | 17.7% | 20.63 | 22.72 | -10.1% |
| 2 | 12.34 | 9.27 | 45.61 | 38.63 | 57.95 | 47.90 | 17.3% | 20.00 | 20.73 | -3.7% |
| 3 | 9.40 | 10.35 | 45.58 | 38.75 | 54.98 | 49.10 | 10.7% | 22.38 | 19.08 | 14.7% |
| 4 | 10.95 | 7.71 | 46.84 | 39.47 | 57.79 | 47.17 | 18.4% | 22.72 | 18.88 | 16.9% |
| 5 | 9.83 | 8.94 | 45.54 | 39.34 | 55.38 | 48.28 | 12.8% | 20.95 | 18.97 | 9.5% |
| 6 | 10.56 | 8.87 | 44.55 | 41.25 | 55.11 | 50.12 | 9.1% | 21.02 | 23.63 | -12.5% |
| 7 | 12.34 | 9.50 | 47.94 | 38.20 | 60.28 | 47.71 | 20.9% | 22.10 | 18.22 | 17.6% |
| 8 | 9.30 | 8.41 | 44.50 | 38.30 | 53.79 | 46.71 | 13.2% | 21.80 | 19.50 | 10.6% |
| 9 | 11.55 | 11.03 | 45.20 | 38.91 | 56.75 | 49.94 | 12.0% | 22.42 | 19.53 | 12.9% |
| 10 | 10.30 | 10.75 | 45.81 | 36.92 | 56.11 | 47.67 | 15.0% | 21.17 | 19.25 | 9.1% |
| 11 | 9.45 | 10.03 | 46.81 | 38.40 | 56.26 | 48.43 | 13.9% | 22.05 | 18.87 | 14.4% |
| 12 | 11.81 | 9.43 | 48.60 | 37.54 | 60.40 | 46.96 | 22.2% | 22.62 | 19.93 | 11.9% |
| 13 | 9.51 | 7.84 | 46.68 | 43.82 | 56.20 | 51.66 | 8.1% | 22.25 | 19.88 | 10.6% |
| 14 | 10.76 | 9.85 | 45.46 | 37.48 | 56.22 | 47.33 | 15.8% | 22.15 | 22.93 | -3.5% |
| 15 | 9.86 | 8.39 | 46.22 | 38.68 | 56.08 | 47.06 | 16.1% | 20.40 | 22.23 | -9.0% |
| 16 | 11.20 | 8.90 | 44.74 | 39.18 | 55.94 | 48.09 | 14.0% | 19.72 | 21.25 | -7.8% |
| 17 | 12.20 | 8.58 | 46.39 | 40.10 | 58.59 | 48.68 | 16.9% | 20.53 | 19.78 | 3.7% |
| 18 | 11.42 | 8.81 | 45.32 | 38.45 | 56.74 | 47.26 | 16.7% | 24.47 | 20.25 | 17.2% |
| 19 | 9.96 | 11.98 | 47.32 | 37.60 | 57.27 | 49.58 | 13.4% | 23.17 | 20.92 | 9.7% |
| 20 | 10.03 | 9.82 | 47.50 | 37.00 | 57.53 | 46.82 | 18.6% | 21.22 | 21.33 | -0.5% |
| 21 | 10.27 | 10.97 | 47.75 | 36.08 | 58.03 | 47.05 | 18.9% | 20.40 | 17.52 | 14.1% |
| 22 | 10.12 | 9.58 | 49.85 | 36.89 | 59.97 | 46.47 | 22.5% | 21.28 | 18.97 | 10.9% |
| 23 | 11.36 | 9.36 | 45.35 | 39.56 | 56.71 | 48.91 | 13.8% | 24.18 | 19.30 | 20.2% |
| 24 | 9.64 | 9.48 | 46.93 | 37.84 | 56.57 | 47.32 | 16.3% | 22.20 | 19.12 | 13.9% |
| 25 | 12.63 | 9.42 | 45.96 | 41.73 | 58.59 | 51.16 | 12.7% | 23.03 | 17.70 | 23.2% |
| 26 | 10.58 | 9.03 | 48.36 | 37.97 | 58.94 | 47.00 | 20.2% | 20.45 | 20.12 | 1.6% |
| 27 | 10.46 | 9.76 | 46.36 | 38.04 | 56.82 | 47.80 | 15.9% | 20.30 | 19.43 | 4.3% |
| 28 | 10.60 | 10.37 | 48.24 | 39.19 | 58.84 | 49.56 | 15.8% | 20.50 | 21.27 | -3.7% |
| 29 | 10.59 | 9.76 | 47.79 | 36.99 | 58.38 | 46.75 | 19.9% | 21.43 | 20.20 | 5.8% |
| 30 | 9.79 | 11.67 | 47.46 | 41.92 | 57.26 | 53.59 | 6.4% | 22.78 | 18.13 | 20.4% |
| 31 | 11.07 | 11.49 | 47.83 | 44.44 | 58.90 | 55.93 | 5.0% | 21.55 | 19.28 | 10.5% |
| 32 | 10.54 | 8.48 | 47.04 | 39.35 | 57.59 | 47.83 | 16.9% | 24.55 | 22.43 | 8.6% |
| 33 | 11.36 | 8.92 | 56.52 | 38.56 | 67.88 | 47.48 | 30.1% | 21.50 | 17.85 | 17.0% |
| 34 | 15.22 | 11.28 | 47.00 | 36.27 | 62.22 | 47.56 | 23.6% | 21.73 | 20.58 | 5.3% |
| 35 | 12.85 | 9.79 | 47.95 | 36.02 | 60.79 | 45.81 | 24.7% | 22.23 | 21.45 | 3.5% |
| 36 | 11.36 | 10.80 | 49.93 | 37.39 | 61.29 | 48.19 | 21.4% | 22.58 | 21.45 | 5.0% |
| 37 | 11.44 | 9.60 | 49.85 | 36.81 | 61.29 | 46.40 | 24.3% | 21.53 | 19.38 | 10.0% |
| 38 | 10.34 | 9.09 | 46.31 | 38.18 | 56.65 | 47.27 | 16.6% | 21.43 | 19.90 | 7.2% |
| 39 | 12.21 | 16.47 | 50.67 | 35.71 | 62.88 | 52.18 | 17.0% | 21.32 | 19.82 | 7.0% |
| 40 | 11.15 | 8.89 | 46.00 | 37.73 | 57.16 | 46.61 | 18.4% | 22.32 | 18.52 | 17.0% |
| 41 | 12.35 | 9.30 | 50.36 | 36.91 | 62.72 | 46.21 | 26.3% | 23.13 | 19.72 | 14.8% |
| 42 | 11.61 | 9.00 | 48.51 | 37.30 | 60.12 | 46.30 | 23.0% | 21.35 | 20.68 | 3.1% |
| 43 | 10.73 | 10.77 | 47.28 | 39.53 | 58.01 | 50.30 | 13.3% | 22.03 | 20.13 | 8.6% |
| 44 | 13.60 | 9.00 | 47.27 | 40.00 | 60.86 | 49.00 | 19.5% | 22.13 | 19.70 | 11.0% |
| 45 | 11.00 | 10.00 | 44.78 | 38.83 | 55.77 | 48.82 | 12.5% | 22.03 | 22.82 | -3.6% |
| 46 | 14.23 | 8.33 | 48.64 | 39.76 | 62.87 | 48.09 | 23.5% | 20.88 | 18.75 | 10.2% |
| 47 | 11.99 | 9.02 | 46.73 | 42.13 | 58.72 | 51.16 | 12.9% | 21.25 | 19.30 | 9.2% |
| 48 | 13.58 | 8.26 | 71.11 | 38.98 | 84.69 | 47.24 | 44.2% | 20.77 | 20.50 | 1.3% |
| 49 | 18.45 | 9.38 | 63.69 | 40.60 | 82.14 | 49.98 | 39.1% | 21.93 | 23.58 | -7.5% |
| 50 | 33.21 | 9.42 | 60.13 | 39.40 | 93.35 | 48.81 | 47.7% | 22.97 | 20.37 | 11.3% |
| 51 | 12.73 | 9.67 | 52.86 | 40.10 | 65.59 | 49.77 | 24.1% | 23.08 | 18.00 | 22.0% |
| 52 | 13.25 | 10.20 | 68.71 | 36.74 | 81.97 | 46.94 | 42.7% | 23.58 | 18.87 | 20.0% |
| 53 | 15.96 | 10.38 | 86.26 | 36.97 | 102.22 | 47.35 | 53.7% | 22.60 | 20.73 | 8.3% |
| 54 | 13.51 | 10.49 | 73.65 | 37.43 | 87.16 | 47.92 | 45.0% | 20.05 | 21.65 | -8.0% |
| 55 | 16.75 | 9.25 | 96.33 | 37.18 | 113.08 | 46.43 | 58.9% | 21.90 | 22.40 | -2.3% |
| 56 | 13.62 | 8.58 | 98.27 | 39.88 | 111.89 | 48.46 | 56.7% | 21.85 | 21.28 | 2.6% |
| 57 | 12.42 | 8.48 | 69.32 | 40.77 | 81.73 | 49.25 | 39.7% | 20.40 | 19.30 | 5.4% |
| 58 | 15.61 | 8.75 | 57.89 | 39.78 | 73.50 | 48.53 | 34.0% | 21.07 | 19.35 | 8.1% |
| 59 | 17.21 | 8.56 | 62.65 | 37.13 | 79.87 | 45.70 | 42.8% | 21.95 | 19.37 | 11.8% |
| 60 | 52.71 | 9.55 | 60.82 | 38.09 | 113.53 | 47.64 | 58.0% | 23.32 | 18.40 | 21.1% |
| 61 | 13.87 | 10.68 | 57.69 | 37.02 | 71.56 | 47.70 | 33.3% | 21.65 | 19.22 | 11.2% |
| 62 | 14.11 | 8.83 | 50.34 | 37.96 | 64.45 | 46.80 | 27.4% | 21.45 | 20.10 | 6.3% |
| 63 | 14.82 | 9.63 | 54.64 | 38.86 | 69.46 | 48.50 | 30.2% | 18.68 | 19.50 | -4.4% |
| 64 | 11.89 | 8.58 | 59.58 | 37.64 | 71.46 | 46.21 | 35.3% | 21.02 | 20.48 | 2.5% |
| 65 | 32.16 | 9.39 | 70.81 | 37.22 | 102.96 | 46.61 | 54.7% | 20.73 | 17.95 | 13.4% |
| 66 | 11.22 | 11.47 | 50.46 | 40.24 | 61.68 | 51.71 | 16.2% | 20.60 | 17.65 | 14.3% |
| 67 | 14.61 | 9.60 | 52.31 | 38.34 | 66.92 | 47.95 | 28.3% | 20.67 | 22.17 | -7.3% |
| 68 | 12.67 | 12.10 | 52.59 | 37.48 | 65.26 | 49.58 | 24.0% | 21.92 | 19.90 | 9.2% |
| 69 | 12.52 | 10.90 | 51.01 | 46.12 | 63.53 | 57.02 | 10.3% | 20.13 | 21.73 | -7.9% |
| 70 | 13.73 | 12.66 | 54.63 | 40.04 | 68.36 | 52.70 | 22.9% | 22.78 | 19.65 | 13.8% |
| 71 | 12.81 | 11.06 | 52.22 | 40.99 | 65.03 | 52.06 | 19.9% | 23.80 | 20.08 | 15.6% |
| 72 | 13.98 | 9.37 | 49.81 | 39.45 | 63.79 | 48.82 | 23.5% | 25.63 | 19.03 | 25.7% |
| 73 | 12.59 | 11.45 | 50.51 | 38.71 | 63.10 | 50.16 | 20.5% | 21.70 | 20.47 | 5.7% |
| 74 | 12.06 | 9.97 | 52.11 | 41.32 | 64.17 | 51.30 | 20.1% | 21.30 | 20.48 | 3.8% |
| 75 | 11.00 | 13.39 | 48.61 | 37.79 | 59.61 | 51.18 | 14.1% | 20.57 | 19.75 | 4.0% |
| 76 | 13.15 | 10.01 | 53.42 | 38.25 | 66.57 | 48.26 | 27.5% | 20.60 | 20.05 | 2.7% |
| 77 | 12.14 | 11.69 | 52.69 | 39.61 | 64.82 | 51.30 | 20.9% | 20.52 | 21.77 | -6.1% |
| 78 | 12.21 | 9.55 | 50.44 | 40.08 | 62.65 | 49.63 | 20.8% | 22.25 | 19.62 | 11.8% |
| 79 | 10.64 | 12.41 | 49.44 | 40.80 | 60.08 | 53.21 | 11.4% | 23.80 | 19.18 | 19.4% |
| 80 | 11.35 | 11.37 | 54.91 | 40.04 | 66.27 | 51.41 | 22.4% | 24.05 | 22.38 | 6.9% |
| 81 | 12.98 | 10.87 | 51.07 | 37.92 | 64.04 | 48.78 | 23.8% | 18.97 | 18.82 | 0.8% |
| 82 | 14.08 | 10.46 | 54.09 | 39.88 | 68.17 | 50.34 | 26.1% | 20.08 | 18.98 | 5.5% |
| 83 | 11.40 | 11.96 | 51.20 | 41.25 | 62.60 | 53.21 | 15.0% | 23.23 | 21.87 | 5.9% |
| 84 | 12.19 | 9.63 | 49.38 | 42.21 | 61.58 | 51.84 | 15.8% | 21.45 | 21.00 | 2.1% |
| 85 | 10.86 | 10.24 | 55.53 | 44.40 | 66.39 | 54.63 | 17.7% | 20.03 | 19.07 | 4.8% |
| 86 | 11.92 | 17.94 | 57.58 | 39.91 | 69.50 | 57.85 | 16.8% | 19.92 | 20.57 | -3.3% |
| 87 | 12.37 | 10.51 | 49.71 | 44.84 | 62.08 | 55.35 | 10.8% | 19.02 | 20.88 | -9.8% |
| 88 | 11.48 | 9.72 | 57.21 | 50.61 | 68.69 | 60.33 | 12.2% | 19.57 | 18.73 | 4.3% |
| 89 | 10.90 | 12.56 | 57.18 | 40.90 | 68.07 | 53.46 | 21.5% | 20.95 | 21.93 | -4.7% |
| 90 | 14.17 | 9.67 | 51.01 | 45.27 | 65.18 | 54.94 | 15.7% | 19.58 | 20.68 | -5.6% |
| 91 | 10.49 | 8.50 | 50.39 | 41.83 | 60.88 | 50.33 | 17.3% | 20.57 | 20.12 | 2.2% |
| 92 | 12.99 | 8.97 | 57.78 | 41.99 | 70.76 | 50.96 | 28.0% | 21.75 | 19.57 | 10.0% |
| 93 | 11.75 | 9.23 | 52.42 | 38.90 | 64.18 | 48.14 | 25.0% | 20.53 | 20.85 | -1.5% |
| 94 | 12.65 | 9.34 | 57.59 | 46.76 | 70.24 | 56.10 | 20.1% | 20.73 | 17.22 | 17.0% |
| 95 | 12.07 | 14.16 | 57.12 | 41.60 | 69.19 | 55.76 | 19.4% | 21.85 | 18.40 | 15.8% |
| 96 | 14.52 | 10.25 | 60.87 | 37.67 | 75.39 | 47.92 | 36.4% | 22.65 | 17.55 | 22.5% |
| 97 | 14.23 | 12.36 | 62.53 | 44.46 | 76.75 | 56.82 | 26.0% | 20.83 | 22.58 | -8.4% |
| 98 | 14.69 | 9.53 | 53.09 | 37.20 | 67.78 | 46.73 | 31.1% | 19.65 | 19.80 | -0.8% |
| 99 | 50.84 | 9.63 | 66.84 | 38.79 | 117.68 | 48.42 | 58.9% | 19.17 | 20.80 | -8.5% |
| 100 | 14.42 | 9.79 | 57.67 | 35.89 | 72.10 | 45.68 | 36.6% | 21.30 | 19.65 | 7.7% |
