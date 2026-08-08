// Path/observation-inspired constrained path solver for the Markov port.
// Copyright (c) 2022 Maxim Gumin — MIT License. See third_party/MarkovJunior-LICENSE.

import type { Point3 } from "./grid";

export interface PathMove { dx: number; dy: number; dz: number; cost: number }
export interface PathOptions {
  mx: number; my: number; mz: number;
  start: Point3; goal: Point3;
  moves: readonly PathMove[];
  blocked?: (x: number, y: number, z: number) => boolean;
  jitter?: (x: number, y: number, z: number) => number;
}

/** Small deterministic A* used for stairy macro spines and local connectors. */
export function findPath3D(options: PathOptions): Point3[] | null {
  const { mx, my, mz, start, goal, moves } = options;
  const size = mx * my * mz;
  const index = (x: number, y: number, z: number) => x + y * mx + z * mx * my;
  const point = (i: number): Point3 => {
    const z = Math.floor(i / (mx * my)), p = i - z * mx * my;
    return { x: p % mx, y: Math.floor(p / mx), z };
  };
  const heuristic = (x: number, y: number, z: number) =>
    Math.abs(goal.x - x) + Math.abs(goal.y - y) + Math.abs(goal.z - z);
  const startI = index(start.x, start.y, start.z), goalI = index(goal.x, goal.y, goal.z);
  const g = new Float64Array(size).fill(Infinity);
  const previous = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const open: Array<{ i: number; f: number; tie: number }> = [{ i: startI, f: heuristic(start.x, start.y, start.z), tie: 0 }];
  g[startI] = 0;

  while (open.length > 0) {
    let best = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[best].f || (open[i].f === open[best].f && open[i].tie < open[best].tie)) best = i;
    }
    const current = open[best];
    open.splice(best, 1);
    if (closed[current.i]) continue;
    if (current.i === goalI) {
      const result: Point3[] = [];
      for (let at = goalI; at >= 0; at = previous[at]) {
        result.push(point(at));
        if (at === startI) break;
      }
      result.reverse();
      return result[0] && index(result[0].x, result[0].y, result[0].z) === startI ? result : null;
    }
    closed[current.i] = 1;
    const p = point(current.i);
    for (const move of moves) {
      const x = p.x + move.dx, y = p.y + move.dy, z = p.z + move.dz;
      if (x < 0 || y < 0 || z < 0 || x >= mx || y >= my || z >= mz || options.blocked?.(x, y, z)) continue;
      const ni = index(x, y, z);
      if (closed[ni]) continue;
      const tentative = g[current.i] + move.cost + (options.jitter?.(x, y, z) ?? 0);
      if (tentative >= g[ni]) continue;
      g[ni] = tentative;
      previous[ni] = current.i;
      open.push({ i: ni, f: tentative + heuristic(x, y, z), tie: options.jitter?.(x, y, z) ?? 0 });
    }
  }
  return null;
}
