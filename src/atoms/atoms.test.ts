import { describe, expect, it, beforeEach } from "vitest";

import { generate } from "../gen/dungeon";
import { canMate, fits, fittingRotation, rotateSockets, uniformSockets } from "./sockets";
import { clearAtoms, registerAtom, resolve, styleModifiers } from "./registry";
import { deadEnds, planRoleDressing, requiredSockets } from "./placement";
import type { AtomDef, SocketSet } from "./types";

const sockets = (px: string, nx: string, py: string, ny: string): SocketSet =>
  ({ px, nx, py, ny } as SocketSet);

function def(over: Partial<AtomDef> & { id: string }): AtomDef {
  return {
    slot: "role-dressing",
    footprint: { w: 1, d: 1, h: 1 },
    sockets: uniformSockets("WALL"),
    source: { kit: "rubbleGeo" },
    ...over,
  };
}

describe("socket rules", () => {
  it("lets a wall face anything solid or walkable", () => {
    for (const other of ["FLOOR", "WALL", "ABYSS", "STAIR"] as const) {
      expect(canMate("WALL", other)).toBe(true);
      expect(canMate(other, "WALL")).toBe(true);
    }
  });

  it("refuses a doorway that opens into rock or onto the void", () => {
    // Both are modelling errors, not style choices. WALL mates with everything
    // else, so this rule has to be checked before that shortcut — otherwise a
    // piece with a doorway passes in any orientation.
    expect(canMate("OPEN", "WALL")).toBe(false);
    expect(canMate("OPEN", "ABYSS")).toBe(false);
    expect(canMate("OPEN", "FLOOR")).toBe(true);
    expect(canMate("OPEN", "OPEN")).toBe(true);
  });

  it("only lets the void meet the void", () => {
    expect(canMate("ABYSS", "ABYSS")).toBe(true);
    expect(canMate("ABYSS", "FLOOR")).toBe(false);
  });

  it("lands stairs on floor", () => {
    expect(canMate("STAIR", "FLOOR")).toBe(true);
    expect(canMate("STAIR", "ABYSS")).toBe(false);
  });
});

describe("rotation", () => {
  it("turns pieces rather than mirroring them", () => {
    // Dir order is +x,-x,+y,-y, which is NOT a rotation cycle. Shifting the
    // array instead of walking the geometric cycle mirrors the piece.
    const s = sockets("OPEN", "WALL", "WALL", "WALL"); // opening faces +x
    const turned = rotateSockets(s, 1);
    expect(turned.py).toBe("OPEN"); // +x rotates to +y
    expect(turned.px).toBe("WALL");
  });

  it("returns to the original after four steps", () => {
    const s = sockets("OPEN", "FLOOR", "WALL", "ABYSS");
    expect(rotateSockets(s, 4)).toEqual(s);
    expect(rotateSockets(s, -1)).toEqual(rotateSockets(s, 3));
  });

  it("finds an orientation that fits, or reports none", () => {
    const facing = sockets("OPEN", "WALL", "WALL", "WALL");
    // A cell whose only walkable neighbour is to the south (+y).
    expect(fittingRotation(facing, { px: "WALL", nx: "WALL", py: "FLOOR", ny: "WALL" })).toBe(1);
    // Boxed in on every side: the opening can never be satisfied.
    expect(fittingRotation(facing, { px: "ABYSS", nx: "ABYSS", py: "ABYSS", ny: "ABYSS" })).toBeNull();
  });

  it("treats an absent requirement as don't-care", () => {
    expect(fits(uniformSockets("FLOOR"), {})).toBe(true);
  });
});

describe("resolver", () => {
  beforeEach(clearAtoms);

  it("returns null when nothing is registered, so the caller can fall back", () => {
    expect(resolve("role-dressing", { role: "archive", decay: 0.5, tier: 0, hash: 0.5 })).toBeNull();
  });

  it("honours role restrictions", () => {
    registerAtom(def({ id: "bone-rack", roles: ["ossuary"] }));
    const ctx = { decay: 0.5, tier: 0, hash: 0.5 };
    expect(resolve("role-dressing", { ...ctx, role: "ossuary" })?.def.id).toBe("bone-rack");
    expect(resolve("role-dressing", { ...ctx, role: "forge" })).toBeNull();
  });

  it("honours the condition window", () => {
    registerAtom(def({ id: "pristine-altar", maxDecay: 0.3 }));
    registerAtom(def({ id: "collapsed-rubble", minDecay: 0.7 }));
    const ctx = { role: "sanctum" as const, tier: 0, hash: 0.5 };
    expect(resolve("role-dressing", { ...ctx, decay: 0.1 })?.def.id).toBe("pristine-altar");
    expect(resolve("role-dressing", { ...ctx, decay: 0.9 })?.def.id).toBe("collapsed-rubble");
    expect(resolve("role-dressing", { ...ctx, decay: 0.5 })).toBeNull();
  });

  it("is deterministic and independent of registration order", () => {
    const ids = ["a-atom", "b-atom", "c-atom"];
    const ctx = { role: "archive" as const, decay: 0.5, tier: 0, hash: 0.72 };

    clearAtoms();
    for (const id of ids) registerAtom(def({ id }));
    const first = resolve("role-dressing", ctx)?.def.id;

    clearAtoms();
    for (const id of [...ids].reverse()) registerAtom(def({ id }));
    const second = resolve("role-dressing", ctx)?.def.id;

    expect(first).toBe(second);
  });

  it("skips zero-weight atoms entirely", () => {
    registerAtom(def({ id: "never", weight: 0 }));
    expect(resolve("role-dressing", { role: "forge", decay: 0.5, tier: 0, hash: 0.5 })).toBeNull();
  });

  it("rejects a duplicate id rather than silently shadowing", () => {
    registerAtom(def({ id: "dup" }));
    expect(() => registerAtom(def({ id: "dup" }))).toThrow(/duplicate/);
  });

  it("rejects a sub-module footprint", () => {
    expect(() => registerAtom(def({ id: "tiny", footprint: { w: 0, d: 1, h: 1 } }))).toThrow(/module/);
  });
});

describe("style modifiers", () => {
  it("derives from decay rather than new knobs", () => {
    expect(styleModifiers("archive", 0).age).toBe(0);
    expect(styleModifiers("archive", 1).age).toBe(1);
  });

  it("gives overgrowth all the moss and ruin all the damage", () => {
    expect(styleModifiers("overgrowth", 1).moss).toBe(1);
    expect(styleModifiers("archive", 1).moss).toBeCloseTo(0.3);
    expect(styleModifiers("archive", 1, true).damage).toBe(1);
    expect(styleModifiers("archive", 1, false).damage).toBeCloseTo(0.4);
  });

  it("stays inside 0..1 for out-of-range decay", () => {
    const m = styleModifiers("sanctum", 5);
    expect(m.age).toBe(1);
    expect(m.damage).toBeLessThanOrEqual(1);
  });
});

describe("placement against a real layout", () => {
  beforeEach(() => {
    clearAtoms();
    registerAtom(def({ id: "waystone" }));
  });

  it("reads neighbour sockets off the grid", () => {
    const l = generate({ seed: 7, size: 9 });
    const required = requiredSockets(l, 0, 0);
    // A corner cell faces outside the grid on two sides.
    expect(Object.values(required)).toContain("ABYSS");
  });

  it("finds dead ends and faces them back down the corridor", () => {
    const l = generate({ seed: 7, size: 12, braid: 0 }); // no braiding = many dead ends
    const ends = deadEnds(l);
    expect(ends.length).toBeGreaterThan(0);
    for (const end of ends.slice(0, 20)) {
      const nx = end.x + [1, -1, 0, 0][end.facing];
      const ny = end.y + [0, 0, 1, -1][end.facing];
      expect(l.kind[ny * l.N + nx]).toBe(1); // FLOOR — the way out
    }
  });

  it("is deterministic for a given seed", () => {
    const a = planRoleDressing(generate({ seed: 42, size: 12, braid: 0 }));
    const b = planRoleDressing(generate({ seed: 42, size: 12, braid: 0 }));
    expect(a).toEqual(b);
  });

  it("respects minimum spacing", () => {
    const l = generate({ seed: 42, size: 14, braid: 0 });
    const placed = planRoleDressing(l, { density: 1, spacing: 4 });
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const d = Math.max(Math.abs(placed[i].x - placed[j].x), Math.abs(placed[i].y - placed[j].y));
        expect(d).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it("places nothing when no atom suits the role", () => {
    clearAtoms();
    registerAtom(def({ id: "forge-anvil", roles: ["forge"] }));
    const l = generate({ seed: 42, size: 12, braid: 0, narrativeRole: "archive" });
    expect(planRoleDressing(l)).toEqual([]);
  });

  it("changing density does not reshuffle which atom a kept cell gets", () => {
    // Two hashes, not one: coupling them would make a density tweak rewrite
    // every existing choice, which is miserable to art-direct against.
    clearAtoms();
    for (const id of ["alpha", "beta", "gamma"]) registerAtom(def({ id }));
    const l = generate({ seed: 9, size: 14, braid: 0 });
    const sparse = planRoleDressing(l, { density: 0.4, spacing: 1 });
    const dense = planRoleDressing(l, { density: 0.9, spacing: 1 });
    for (const cell of sparse) {
      const same = dense.find((d) => d.x === cell.x && d.y === cell.y);
      expect(same?.atomId).toBe(cell.atomId);
    }
  });
});

describe("the shipped library", () => {
  beforeEach(clearAtoms);

  it("installs without duplicate ids and covers every StoryRole", async () => {
    const { ATOMS, installAtoms } = await import("./catalog");
    installAtoms();

    const roles = ["threshold", "archive", "ossuary", "forge", "pilgrim", "overgrowth", "sanctum"] as const;
    for (const role of roles) {
      const picked = resolve("role-dressing", { role, decay: 0.5, tier: 0, hash: 0.5 });
      expect(picked, `no atom for role ${role}`).not.toBeNull();
      expect(picked!.def.roles).toContain(role);
    }
    expect(ATOMS.length).toBeGreaterThanOrEqual(roles.length * 2);
  });

  it("is idempotent, so hot reload does not take the scene down", async () => {
    const { installAtoms } = await import("./catalog");
    installAtoms();
    expect(() => installAtoms()).not.toThrow();
  });

  it("still dresses a pristine dungeon, where decay-gated atoms drop out", async () => {
    const { installAtoms } = await import("./catalog");
    installAtoms();
    // decay 0 excludes the collapsed bookcase and the slag heap; every role
    // must still have something to place or those districts render bare.
    for (const role of ["archive", "forge"] as const) {
      expect(resolve("role-dressing", { role, decay: 0, tier: 0, hash: 0.5 })).not.toBeNull();
    }
  });
});
