// The atom registry and resolver.
//
// Selection is a pure function of (slot, context). No RNG stream: the caller
// passes a cell hash, so two clients rendering the same dungeon pick the same
// atoms regardless of the order they walk the grid.

import type { StoryRole } from "../gen/dungeon";
import { fittingRotation } from "./sockets";
import type { AtomContext, AtomDef, AtomSlot, SocketSet, StyleModifiers } from "./types";

const registry = new Map<string, AtomDef>();
const bySlot = new Map<AtomSlot, AtomDef[]>();

export function registerAtom(def: AtomDef): void {
  if (registry.has(def.id)) throw new Error(`duplicate atom id: ${def.id}`);
  if (def.footprint.w < 1 || def.footprint.d < 1 || def.footprint.h < 1) {
    throw new Error(`atom ${def.id}: footprint must be at least 1×1×1 module`);
  }
  registry.set(def.id, def);
  const list = bySlot.get(def.slot);
  if (list) list.push(def);
  else bySlot.set(def.slot, [def]);
}

export function registerAtoms(defs: readonly AtomDef[]): void {
  for (const def of defs) registerAtom(def);
}

/** Test seam. Production registers once at module load. */
export function clearAtoms(): void {
  registry.clear();
  bySlot.clear();
}

export function getAtom(id: string): AtomDef | undefined {
  return registry.get(id);
}

export function atomsForSlot(slot: AtomSlot): readonly AtomDef[] {
  return bySlot.get(slot) ?? [];
}

/** Is this atom appropriate for this context, ignoring geometry fit? */
export function eligible(def: AtomDef, ctx: AtomContext): boolean {
  if (def.roles && def.roles.length > 0 && !def.roles.includes(ctx.role)) return false;
  if (def.minDecay !== undefined && ctx.decay < def.minDecay) return false;
  if (def.maxDecay !== undefined && ctx.decay > def.maxDecay) return false;
  return true;
}

export interface Resolution {
  def: AtomDef;
  rotation: number;
}

/** Pick an atom for a slot.
 *
 *  Returns null when nothing fits, which is a normal outcome, not an error:
 *  the caller falls back to the procedural kit. That fallback is what lets the
 *  library grow one atom at a time without a migration — an unregistered slot
 *  renders exactly as it does today. */
export function resolve(
  slot: AtomSlot,
  ctx: AtomContext,
  required: Partial<SocketSet> = {},
): Resolution | null {
  const candidates: Array<{ def: AtomDef; rotation: number; weight: number }> = [];
  let total = 0;

  for (const def of atomsForSlot(slot)) {
    if (!eligible(def, ctx)) continue;
    const rotation = fittingRotation(def.sockets, required);
    if (rotation === null) continue;
    const weight = Math.max(0, def.weight ?? 1);
    if (weight === 0) continue;
    candidates.push({ def, rotation, weight });
    total += weight;
  }

  if (candidates.length === 0 || total === 0) return null;

  // Weighted pick from the cell hash. Sorted by id first so registration order
  // cannot change which atom a given cell gets.
  candidates.sort((a, b) => (a.def.id < b.def.id ? -1 : a.def.id > b.def.id ? 1 : 0));
  let roll = ctx.hash * total;
  for (const candidate of candidates) {
    roll -= candidate.weight;
    if (roll <= 0) return { def: candidate.def, rotation: candidate.rotation };
  }
  const last = candidates[candidates.length - 1];
  return { def: last.def, rotation: last.rotation };
}

/** Condition knobs derived from what the generator already produces.
 *
 *  Deliberately a function of existing Params rather than new authoring knobs:
 *  a parallel set of sliders would drift out of sync with `decay` the first
 *  time someone tuned one and not the other. */
export function styleModifiers(
  role: StoryRole,
  decay: number,
  ruined = false,
): StyleModifiers {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return {
    age: clamp(decay),
    damage: clamp(decay * (ruined ? 1 : 0.4)),
    moss: clamp(decay * (role === "overgrowth" ? 1 : 0.3)),
    corruption: role === "sanctum" || role === "ossuary" ? 0.7 : 0.1,
  };
}
