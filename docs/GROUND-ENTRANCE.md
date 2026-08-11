# The ground entrance — design

**Status:** design, not built. Implements the P0 TODO item
*"将地面定义为真正的游戏起点"*.

The world currently has no way in. Blocks float, the abyss floor is scenery, and
`Layout.entrance` is a cell nothing arrives at. This designs the one place a
player enters the world, and — more importantly — the order the generator has to
solve in for that place to be real rather than decorated on afterwards.

---

## 1. What is wrong now

`generate()` solves in this order:

```
maze  →  rasterise  →  landmarks  →  footprint trim  →  connectivity  →  validate
```

and `entrance` is a fixed cell on the south centre spine:

```ts
const entrance = { x: gcx, y: N - 2 };
if (kind[gi(entrance.x, entrance.y)] !== FLOOR) return "entrance cell not floor";
```

That is a **post-hoc assertion**. The maze is solved without knowing an entrance
exists; if the cell lands on wall the entire layout is thrown away and re-rolled.
The entrance has no say in the block outline, no approach, no vertical extent,
and nothing below it. It is a label on a cell.

Two consequences:

- **The player has no start.** There is no route from the abyss floor into the
  fortress; the lowest floor's underside is closed masonry.
- **Anything the entrance needs, it must beg for.** A landing, a clear approach,
  an unobstructed column down to the terrain — each would have to be repaired
  after the fact, which is how the stair courts used to work before they became a
  generation constraint.

## 2. The precedent to copy

The vertical stair courts already solved exactly this problem, and their comment
says so:

> Vertical courts are a generation constraint, not a renderer repair. Each core
> replaces one maze wall/floor cell; its 3×3 ring and short approach are
> flattened and carved **before** landmarks and **before** connectivity repair.
> Consequently the final maze must route around and through the court.

The mechanism has three parts worth reusing wholesale:

| Piece | What it does |
| --- | --- |
| `planVerticalAnchors()` in `src/markov/spatial-plan.ts` | Picks a **shared** `(x, y, dockDir)` for each parent↔child vertical edge, by WFC minimum-remaining-values, so both stacked blocks reserve the same court. |
| `Params.verticalAnchors` → Stage 4 | Carves a 3×3 walkable ring + a 2-cell approach, marks the core `WALL` + `shaftMask`, and reserves 7×7 in `shaftReserve` so no landmark can land on it. |
| `shaftMask` → `StairTowers` + `src/world/spiral.ts` | Renders the solid core and the square spiral around it (`StairSpan {y0, y1, m, rise, phase}`). |

**The ground entrance is a vertical court whose lower end is the terrain instead
of a parent block.** Nothing about the shaft, the ring, the reservation or the
spiral needs inventing — only the choice of where it may exist, and one new
constraint that has no analogue between two stacked blocks.

## 3. The shape

### 3.1 In plan (block grid space)

Identical to a stair court, because it is one:

```
 · · · · · · ·         ·  shaftReserve 7×7 — no landmark, plaza,
 ·           ·            temple terrace or ravine may claim these
 ·   ▓ ▓ ▓   ·
 ·   ▓ ◎ ▓   ·         ◎  shaft core: kind=WALL, shaftMask=1
 ·   ▓ ┼ ▓   ·         ▓  3×3 ring, carved FLOOR at tier P
 ·     ┼     ·         ┼  approach, 2 cells along dockDir
 · · · ┼ · · ·
       ╽                  the maze must now solve around this
```

### 3.2 In section (the part that is new)

```
        ┌───────────────────────┐   mk = 1   (a block above, if any)
        └───────────────────────┘
                  ╎ ╎
   ┌──────────────╫─╫──────────────┐   mk = 0   lowest block
   │ maze floor   ║◎║   ← upper port: the 3×3 ring IS the arrival
   └──────────────╫─╫──────────────┘              landing on the first
                  ║ ║                             walkable floor
                  ║ ║   tower shaft, continues DOWN through the
                  ║ ║   block underside instead of stopping at it
                  ║ ║
                  ║ ║   square spiral around the core
                  ║ ║   (StairSpan y0 = terrainY, y1 = floorY)
        ╔═════════╩═╩═════════╗
        ║  ▄▄▄  door  ▄▄▄     ║   ← lower port, at terrain level
   ─────╨──────╥──────────────╨─────   terrainHeight(x, z)
               │
          spawn point (a few cells out, facing the door)
```

The block's outer boundary is **not** pierced. The lower door is at the foot of
the tower, at terrain height, far below the block. This is why the entrance does
not interact with `gates` (Stage 5.5) at all — those are bridge docks in the
boundary wall, a different thing at a different altitude.

### 3.3 On the ground

The ground plan is small and authored, not generated:

```
        ╔═══╗  tower foot
        ║ ◎ ║
        ╚═╥═╝
          ║  door, facing doorDir
      ····║····          ···· approach apron: terrain flattened to
      ·   ║   ·               a walkable shelf, 3–4 cells wide
      ·   ●   ·          ●    spawn point
      ·········
              ↘ sightline to the Cthulhu monument
```

Three requirements, in priority order:

1. **The door is visible from the spawn.** The player must not have to search.
2. **The monument is visible from the spawn.** The first frame should establish
   what the place is. This is why the block is chosen by nearness to it.
3. **The apron is walkable without a navmesh.** The apron is a local flatten,
   consistent with how medallion plazas already flatten to one tier — but see
   §4.5, because the height it flattens *from* does not currently exist as
   anything you can call.

## 4. The order, inverted

For the chosen ground block only, the solve order becomes:

```
                      ┌─ 1. ground contact   (macro: which block, terrain height)
   locked first ──────┼─ 2. shaft column     (clear descent to terrain)
                      ├─ 3. upper port       (3×3 ring + approach, tier P)
                      ├─ 4. lower port       (door dir at the foot)
                      └─ 5. spawn + apron    (world space, on the terrain)
                              │
   then solved around it ─────┼─ 6. footprint domain
                              ├─ 7. maze
                              ├─ 8. landmarks (already excluded by shaftReserve)
                              ├─ 9. connectivity repair
                              └─ 10. main route / navmesh
```

Steps 1–5 produce constraints; 6–10 must satisfy them. No step after 5 may move
anything decided in 1–5 — if it cannot be satisfied, the block re-rolls its
derived seed, exactly as a failed connectivity check does today.

## 4.5 Prerequisite: the abyss floor has no height function

Everything above assumes the generator can ask *"how high is the ground at
(x, z)?"*. **It cannot.** The abyss bedrock is built inside `buildEnvironment()`
in `src/scene/env.ts` as a 900×900 plane with 72² cells, and its relief is
written straight into the vertex buffer:

```ts
const macro   = valueNoise2(seed ^ 0x6f4a12d9, x / 155, z / 155);
const plateau = (terraced(macro) - 0.5) * 18;
const weather = (valueNoise2(seed ^ 0x2c1b3a57, x / 31,  z / 31)  - 0.5) * 3.6;
const micro   = (valueNoise2(seed ^ 0x71e5b90d, x / 13,  z / 13)  - 0.5) * 0.85;
bedrockPosition.setY(i, plateau + weather + micro);
```

`terraced()` is a closure local to that function. There is no exported height
field, so today the only way to know the floor's height is to read a vertex or
raycast the mesh — and `CLAUDE.md` principle 8 forbids the raycast:

> **Analytic over raycast.** Ground height is a pure function
> (`terrainHeight(x,z)`), used for grounding, placement and scatter — never a
> mesh raycast.

The principle names a function that does not exist here. So step 0 of this work
is to extract it:

```ts
// src/scene/abyss-floor.ts
export function abyssFloorHeight(seed: number, x: number, z: number): number;
```

with `buildEnvironment()` calling it per vertex instead of inlining the maths.
That is a pure refactor with an exact test — the rebuilt mesh must be
vertex-for-vertex identical to the current one — and it is worth doing on its own
merits: the bedrock piers, the apron, prop grounding and any first-person
gravity all need the same answer, and every one of them would otherwise invent
its own.

It is listed as a prerequisite rather than folded into the entrance work because
it is independently useful and independently verifiable.

## 5. The one genuinely new constraint

Between two stacked blocks, a court's column is trivially clear: the parent is
directly below the child by construction. The ground shaft has no such guarantee.
It descends from `mk = 0` through open abyss to the terrain, and **that column
must not intersect any other block's footprint**, on any layer, at any point.

```
   ok                        rejected
   ┌────┐                    ┌────┐
   │  ◎ │  mk=0              │  ◎ │  mk=0
   └──╫─┘                    └──╫─┘
      ║                    ┌────╫───┐   another block's
      ║                    │    ║   │   footprint is in the way
   ───╨───  terrain        └────╫───┘
                           ─────╨──   terrain
```

This is a macro-level fact, so it is decided in `spatial-plan.ts` where the full
set of cells and their footprints is known — the same reason `planVerticalAnchors`
lives there rather than in the block generator.

It also pays a second debt. The TODO asks separately for *"为没有下层投影承重的
最低 maze block 求解 3–5 个基岩支点"* — bedrock piers under lowest blocks that
nothing supports. **The entrance tower is one of those piers**, and the most
legible one: a load path the player walks up. The pier solver should treat it as
a fixed, already-placed support and solve the remaining 2–4 around it.

## 6. Proposed types

Deliberately additive. `VerticalAnchor` is unchanged — it is load-bearing in
`rotateOnce`, `unrotateVerticalAnchors`, and two test files.

```ts
/** The one place the world lets a player in.
 *
 *  Planned at macro level: choosing it needs the terrain height, the monument's
 *  position and every block's footprint, none of which a single block knows.
 *  The shaft itself is an ordinary VerticalAnchor — the entrance is what is
 *  underneath it. */
export interface GroundEntrance {
  /** spatial cell index; always a cell with mk === 0 */
  block: number;
  /** the shaft, in that block's grid space — reserved exactly like a court */
  anchor: VerticalAnchor;
  /** which way the doorway at the foot faces */
  doorDir: Dir;
  /** world Y of the tower foot, from abyssFloorHeight() at the shaft's centre
   *  — see §4.5, that function has to be extracted first */
  baseY: number;
  /** world-space spawn, on the apron, outside the door */
  spawn: { x: number; z: number };
}
```

Threaded into the block generator as one extra param:

```ts
export interface Params {
  // …
  /** id of the verticalAnchor that is the ground shaft, if this block has it.
   *  Its reservation is identical; what differs is that it may not be re-sited
   *  and that the layout fails rather than re-siting it. */
  groundAnchorId?: number;
}
```

and surfaced on the layout so the renderer, nav and spawn logic can find it:

```ts
export interface Layout {
  // …
  /** set only on the block that owns the way in */
  groundEntrance: { anchorId: number; doorDir: Dir } | null;
}
```

## 7. New failure modes

The generator already re-rolls on a returned string. Three to add, all cheap to
check and all checked **before** the expensive maze work where possible:

| Check | When | Message |
| --- | --- | --- |
| Descent column clear of every other block | macro plan, before any block generates | `ground shaft column blocked` |
| Shaft ring survives the footprint trim | Stage 4.5 | `ground shaft outside footprint` |
| Ring landing in the main component | Stage 5 | `ground shaft unreachable` |

The first is the important one: catching it in the macro plan means no block is
generated for a plan that cannot admit a player. The macro planner should pick a
different `mk === 0` cell and retry rather than failing the world.

## 8. Choosing the block

Among cells with `mk === 0`, ranked:

1. **clear descent** — hard filter (§5)
2. **nearest the monument** — the TODO's requirement, and the reason the first
   frame reads as an establishing shot
3. **largest clear interior** — the shaft needs 7×7 of reservation without
   fighting the temple or a plaza
4. **deterministic tiebreak** — `hash3(seed, cell, …)`, never `Math.random`

All four are functions of the spatial plan and the seed, so the choice is
reproducible on every client with no sync — the invariant the whole world rests
on (`CLAUDE.md` principle 7).

## 9. What this unblocks

- **First-person exploration** (P1). The controller's spawn is no longer a
  question — it is `GroundEntrance.spawn`, and there is a continuous walkable
  path from it to the first maze floor. That P1 item is currently blocked on
  precisely this.
- **The 💀 route walker.** Its 3D BFS gains a real start; today it begins inside
  the fortress because there is nowhere outside to begin.
- **The bedrock piers** (§5) get their first fixed support.

## 10. Build order

Each step is independently verifiable, and the first two are useful even if the
rest is never built.

| # | Step | Verified by |
| --- | --- | --- |
| 0 | Extract `abyssFloorHeight()` (§4.5) | rebuilt bedrock mesh is vertex-identical |
| 1 | `planGroundEntrance()` in `spatial-plan.ts`: choose the block, site the shaft, prove the descent is clear | unit test over many seeds — always exactly one entrance, column never intersects a footprint |
| 2 | `Params.groundAnchorId` → reserve in Stage 4, fail rather than re-site | generator test: ring survives footprint trim and lands in the main component |
| 3 | Extend the shaft below the block underside; spiral from `baseY` | visual — the tower reaches the floor and the spiral is climbable |
| 4 | Apron flatten + spawn point | visual, plus the spawn is on the walkmap |
| 5 | Point the 💀 route walker at the spawn | it walks in from outside |

Steps 3–5 need a real browser: this scene does not render headless
(`docs/` sibling note, and the existing shot-based checks).

## 11. Open questions

1. **Ramp or lift?** The TODO says *"螺旋坡道/升降平台"*. A spiral reuses
   `StairSpan` and costs nothing new; a lift is less climbing but needs new
   interaction and animation. Recommend spiral for v1, on reuse grounds alone.
2. **How tall?** The drop from the lowest floor to the terrain is currently
   whatever the abyss terrain happens to be under that block. If that is 60+
   units the climb is tedious. Options: clamp the block choice to a shallow
   spot, or raise the terrain locally into a plinth under the tower. The plinth
   is more controllable and reads as intentional.
3. **One way in, or one per district?** One is a stronger read and less work.
   Endless mode may want one per streamed window — deferred until endless mode
   has a player in it.
