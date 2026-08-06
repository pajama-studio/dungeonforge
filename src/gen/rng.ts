// Deterministic RNG + hash utilities. No Math.random anywhere in the generator —
// one integer seed reproduces the fortress bit-for-bit (same doctrine as the
// pajama-studio world / gpulab generators this project grew out of).

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private next: () => number;
  constructor(seed: number) { this.next = mulberry32(seed); }
  float(a: number, b: number): number { return a + (b - a) * this.next(); }
  int(a: number, b: number): number { return a + Math.floor(this.next() * (b - a + 1)); }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  chance(p: number): boolean { return this.next() < p; }
}

/** Stateless 2D integer hash → [0,1). Used for spatial jitter so results don't
 *  depend on iteration order ("don't generate, hash"). */
export function hash2(seed: number, i: number, j: number): number {
  let h = (seed >>> 0) ^ Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function hash3(seed: number, i: number, j: number, k: number): number {
  return hash2(seed ^ Math.imul(k | 0, 2246822519), i, j);
}

/** 2-octave value noise over lattice coords (bilinear-smoothed hash2). */
export function valueNoise2(seed: number, x: number, y: number): number {
  const sample = (s: number, px: number, py: number): number => {
    const ix = Math.floor(px), iy = Math.floor(py);
    const fx = px - ix, fy = py - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hash2(s, ix, iy), b = hash2(s, ix + 1, iy);
    const c = hash2(s, ix, iy + 1), d = hash2(s, ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  return sample(seed, x, y) * 0.68 + sample(seed ^ 0x9e3779b9, x * 2.13, y * 2.13) * 0.32;
}
