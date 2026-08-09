// Growable instance buffers written as raw floats. Building a big island used
// to allocate one Matrix4 + one Color per instance (tens of thousands per
// forge); this writes the composed matrix straight into a flat array instead,
// so a rebuild allocates nothing but the (pooled, doubling) backing stores.
//
// Zero THREE imports on purpose — the compose math is pure and unit-testable.

export interface Rgb { r: number; g: number; b: number }

export class InstList {
  mats: Float32Array;
  cols: Float32Array;
  count = 0;
  minX = Infinity;
  minY = Infinity;
  minZ = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  maxZ = -Infinity;

  constructor(capacity = 64) {
    const cap = Math.max(1, capacity | 0);
    this.mats = new Float32Array(16 * cap);
    this.cols = new Float32Array(3 * cap);
  }

  ensureCapacity(capacity: number): void {
    if (this.mats.length >= capacity * 16) return;
    let cap = this.mats.length / 16;
    while (cap < capacity) cap *= 2;
    const m = new Float32Array(cap * 16);
    m.set(this.mats);
    this.mats = m;
    const c = new Float32Array(cap * 3);
    c.set(this.cols);
    this.cols = c;
  }

  private ensure(): void {
    const cap = this.mats.length / 16;
    if (this.count < cap) return;
    const m = new Float32Array(this.mats.length * 2);
    m.set(this.mats);
    this.mats = m;
    const c = new Float32Array(this.cols.length * 2);
    c.set(this.cols);
    this.cols = c;
  }

  /** yaw-only compose (rotation about +y, then non-uniform scale) — covers
   *  nearly every instance in the kit without a quaternion in sight */
  pushY(
    x: number, y: number, z: number, rotY: number,
    sx: number, sy: number, sz: number, c: Rgb,
  ): void {
    this.ensure();
    const o = this.count * 16;
    const m = this.mats;
    let cos = 1, sin = 0;
    if (rotY !== 0) { cos = Math.cos(rotY); sin = Math.sin(rotY); }
    // column-major, R_y(rotY) with columns scaled by (sx, sy, sz)
    m[o] = cos * sx; m[o + 1] = 0; m[o + 2] = -sin * sx; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = sin * sz; m[o + 9] = 0; m[o + 10] = cos * sz; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
    const co = this.count * 3;
    this.cols[co] = c.r; this.cols[co + 1] = c.g; this.cols[co + 2] = c.b;
    if (x < this.minX) this.minX = x; if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y; if (y > this.maxY) this.maxY = y;
    if (z < this.minZ) this.minZ = z; if (z > this.maxZ) this.maxZ = z;
    this.count++;
  }

  /** full matrix (already composed elsewhere) — for the few tilted instances */
  pushMatrix(elements: ArrayLike<number>, c: Rgb): void {
    this.ensure();
    const o = this.count * 16;
    for (let i = 0; i < 16; i++) this.mats[o + i] = elements[i];
    const co = this.count * 3;
    this.cols[co] = c.r; this.cols[co + 1] = c.g; this.cols[co + 2] = c.b;
    const x = elements[12], y = elements[13], z = elements[14];
    if (x < this.minX) this.minX = x; if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y; if (y > this.maxY) this.maxY = y;
    if (z < this.minZ) this.minZ = z; if (z > this.maxZ) this.maxZ = z;
    this.count++;
  }



  clear(): void {
    this.count = 0;
    this.minX = this.minY = this.minZ = Infinity;
    this.maxX = this.maxY = this.maxZ = -Infinity;
  }
}

/** Reuses the large typed-array backing stores between synchronous scene
 * builds. Instance data is copied into GPU attributes by putInstanced(), so
 * retaining one arena avoids rebuilding and collecting dozens of MB per
 * island without extending the lifetime of scene data. */
export class InstArena {
  private lists: InstList[] = [];
  private used = 0;

  reset(): void {
    this.used = 0;
  }

  take(capacity = 64): InstList {
    let list = this.lists[this.used];
    if (!list) {
      list = new InstList(capacity);
      this.lists.push(list);
    } else {
      list.clear();
      list.ensureCapacity(capacity);
    }
    this.used++;
    return list;
  }
}


/** Which masonry mesh a course belongs in.
 *
 *  Four shells, chosen by which faces are actually exposed:
 *    - `open`   sides only            — enclosed above and below
 *    - `top`    sides + cap           — open air above
 *    - `base`   sides + floor         — open air below
 *    - `full`   sealed box            — open air both ways, or translucent
 *
 *  The previous design assumed a course's position in the column implied its
 *  enclosure: last one gets a cap, everything else is open. That is only true
 *  while nothing else removes courses. Five things do — the occlusion cull,
 *  doorway gaps, destruction breaches, LOD tier swaps and the reveal window —
 *  and each one leaves a neighbour with a face it no longer has. Hence
 *  see-through banding that four separate patches could not fix, because the
 *  bug was the assumption rather than any single rule.
 */
export type CourseShell = "open" | "top" | "base" | "full";

export interface CoursePlan {
  /** false when the course is culled and emits nothing at all. */
  render: boolean;
  shell: CourseShell;
}

export interface ColumnSpec {
  courseCount: number;
  /** Course is removed entirely — occlusion cull, doorway gap, breach. */
  removed: (k: number) => boolean;
  /** Course must stay sealed regardless of neighbours: breach bands (they can
   *  be exposed from any side once the wall opens) and anything drawn with the
   *  translucent reveal material. */
  sealed?: (k: number) => boolean;
  /** True when a face at this course boundary could actually be seen. Lets the
   *  occlusion cull's own conclusion carry over: if a neighbour was dropped
   *  because it sits below the occlusion height, the face between them is
   *  hidden too and does not need geometry. Boundary k is below course k. */
  boundaryVisible?: (k: number) => boolean;
  /** Underside of the whole column faces the void. */
  bottomExposed?: boolean;
}

/** Decide render and shell for every course in one column.
 *
 *  Pure and total: same spec in, same plan out, and every rendered course is
 *  guaranteed a face wherever its neighbour is missing. */
export function planColumn(spec: ColumnSpec): CoursePlan[] {
  const { courseCount, removed, sealed, boundaryVisible, bottomExposed = false } = spec;
  const visible = boundaryVisible ?? (() => true);

  const rendered: boolean[] = [];
  for (let k = 0; k < courseCount; k++) rendered[k] = !removed(k);

  const plan: CoursePlan[] = [];
  for (let k = 0; k < courseCount; k++) {
    if (!rendered[k]) {
      plan.push({ render: false, shell: "open" });
      continue;
    }
    if (sealed?.(k)) {
      plan.push({ render: true, shell: "full" });
      continue;
    }
    // A cap is needed when nothing renders directly above and that boundary
    // can be seen. Same for a floor, with the column's underside as the case
    // below course zero.
    const aboveMissing = k + 1 >= courseCount || !rendered[k + 1];
    const belowMissing = k === 0 ? bottomExposed : !rendered[k - 1];
    const needCap = aboveMissing && visible(k + 1);
    const needFloor = belowMissing && (k === 0 ? bottomExposed : visible(k));

    plan.push({
      render: true,
      shell: needCap && needFloor ? "full" : needCap ? "top" : needFloor ? "base" : "open",
    });
  }
  return plan;
}
