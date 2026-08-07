// Core ideas and data layout are ported from MarkovJunior's Grid/RuleNode.
// Copyright (c) 2022 Maxim Gumin — MIT License. See third_party/MarkovJunior-LICENSE.

export const KEEP = 0xff;

export interface Point3 { x: number; y: number; z: number }

/** Compact symbol grid. Input patterns use bit waves, matching MarkovJunior. */
export class MarkovGrid {
  readonly state: Uint8Array;
  readonly values = new Map<string, number>();
  readonly symbols: readonly string[];
  readonly all: number;

  constructor(
    readonly mx: number,
    readonly my: number,
    readonly mz: number,
    symbols: readonly string[],
    fill = 0,
  ) {
    if (mx < 1 || my < 1 || mz < 1) throw new Error("MarkovGrid dimensions must be positive");
    if (symbols.length < 1 || symbols.length > 30) throw new Error("MarkovGrid supports 1..30 symbols");
    this.symbols = [...symbols];
    symbols.forEach((symbol, value) => {
      if (this.values.has(symbol)) throw new Error(`duplicate Markov symbol ${symbol}`);
      this.values.set(symbol, value);
    });
    this.all = (1 << symbols.length) - 1;
    this.state = new Uint8Array(mx * my * mz).fill(fill);
  }

  index(x: number, y: number, z: number): number { return x + y * this.mx + z * this.mx * this.my; }

  point(index: number): Point3 {
    const z = Math.floor(index / (this.mx * this.my));
    const yz = index - z * this.mx * this.my;
    return { x: yz % this.mx, y: Math.floor(yz / this.mx), z };
  }

  contains(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.mx && y < this.my && z < this.mz;
  }

  get(x: number, y: number, z: number): number {
    return this.contains(x, y, z) ? this.state[this.index(x, y, z)] : -1;
  }

  set(x: number, y: number, z: number, value: number): void {
    if (!this.contains(x, y, z)) throw new Error(`MarkovGrid write outside ${x},${y},${z}`);
    this.state[this.index(x, y, z)] = value;
  }

  wave(symbols: string): number {
    if (symbols === "*") return this.all;
    let wave = 0;
    for (const symbol of symbols) {
      const value = this.values.get(symbol);
      if (value === undefined) throw new Error(`unknown Markov symbol ${symbol}`);
      wave |= 1 << value;
    }
    return wave;
  }

  matches(rule: RewriteRule, x: number, y: number, z: number): boolean {
    if (x < 0 || y < 0 || z < 0 || x + rule.mx > this.mx || y + rule.my > this.my || z + rule.mz > this.mz) {
      return false;
    }
    let p = 0;
    for (let dz = 0; dz < rule.mz; dz++) for (let dy = 0; dy < rule.my; dy++) {
      let i = this.index(x, y + dy, z + dz);
      for (let dx = 0; dx < rule.mx; dx++, i++, p++) {
        if ((rule.input[p] & (1 << this.state[i])) === 0) return false;
      }
    }
    return true;
  }
}

export class RewriteRule {
  readonly input: Uint32Array;
  readonly output: Uint8Array;

  constructor(
    input: ArrayLike<number>,
    readonly mx: number,
    readonly my: number,
    readonly mz: number,
    output: ArrayLike<number>,
    readonly weight = 1,
    readonly name = "rule",
  ) {
    const size = mx * my * mz;
    if (input.length !== size || output.length !== size) throw new Error(`${name}: pattern dimensions do not match data`);
    this.input = Uint32Array.from(input);
    this.output = Uint8Array.from(output);
  }

  zRotated(): RewriteRule {
    const input = new Uint32Array(this.input.length);
    const output = new Uint8Array(this.output.length);
    for (let z = 0; z < this.mz; z++) for (let y = 0; y < this.mx; y++) for (let x = 0; x < this.my; x++) {
      const dst = x + y * this.my + z * this.my * this.mx;
      const src = this.mx - 1 - y + x * this.mx + z * this.mx * this.my;
      input[dst] = this.input[src];
      output[dst] = this.output[src];
    }
    return new RewriteRule(input, this.my, this.mx, this.mz, output, this.weight, this.name);
  }

  reflected(): RewriteRule {
    const input = new Uint32Array(this.input.length);
    const output = new Uint8Array(this.output.length);
    for (let z = 0; z < this.mz; z++) for (let y = 0; y < this.my; y++) for (let x = 0; x < this.mx; x++) {
      const dst = x + y * this.mx + z * this.mx * this.my;
      const src = this.mx - 1 - x + y * this.mx + z * this.mx * this.my;
      input[dst] = this.input[src];
      output[dst] = this.output[src];
    }
    return new RewriteRule(input, this.mx, this.my, this.mz, output, this.weight, this.name);
  }

  equals(other: RewriteRule): boolean {
    if (this.mx !== other.mx || this.my !== other.my || this.mz !== other.mz) return false;
    for (let i = 0; i < this.input.length; i++) {
      if (this.input[i] !== other.input[i] || this.output[i] !== other.output[i]) return false;
    }
    return true;
  }

  /** Unique square symmetries around z, matching the common 2D-in-3D MJ case. */
  squareSymmetries(reflect = false): RewriteRule[] {
    const result: RewriteRule[] = [];
    let rule: RewriteRule = this;
    for (let i = 0; i < 4; i++) {
      for (const candidate of reflect ? [rule, rule.reflected()] : [rule]) {
        if (!result.some((r) => r.equals(candidate))) result.push(candidate);
      }
      rule = rule.zRotated();
    }
    return result;
  }
}

export interface RewriteMatch { rule: number; x: number; y: number; z: number }
export interface RewriteChange extends Point3 { index: number; from: number; to: number }
export interface RewriteEvent { match: RewriteMatch; changes: RewriteChange[] }

/**
 * Markov "one" executor with an incrementally maintained match set. After a
 * rewrite it only revisits rule origins whose patterns overlap changed cells.
 */
export class MarkovProgram {
  private readonly matches = new Map<number, RewriteMatch>();
  private readonly eligible: RewriteMatch[] = [];
  private ready = false;

  constructor(readonly grid: MarkovGrid, readonly rules: readonly RewriteRule[]) {}

  private key(rule: number, x: number, y: number, z: number): number {
    return rule * this.grid.state.length + this.grid.index(x, y, z);
  }

  private refresh(ruleIndex: number, x: number, y: number, z: number): void {
    const key = this.key(ruleIndex, x, y, z);
    const rule = this.rules[ruleIndex];
    if (this.grid.matches(rule, x, y, z)) {
      if (!this.matches.has(key)) this.matches.set(key, { rule: ruleIndex, x, y, z });
    } else this.matches.delete(key);
  }

  initialize(): void {
    this.matches.clear();
    for (let r = 0; r < this.rules.length; r++) {
      const rule = this.rules[r];
      for (let z = 0; z <= this.grid.mz - rule.mz; z++) {
        for (let y = 0; y <= this.grid.my - rule.my; y++) {
          for (let x = 0; x <= this.grid.mx - rule.mx; x++) this.refresh(r, x, y, z);
        }
      }
    }
    this.ready = true;
  }

  /**
   * Exact sparse initialization for programs whose rules must overlap one of
   * the supplied non-default cells. Growth grammars avoid scanning the whole
   * empty volume, mirroring MarkovJunior's symbol-shift initialization.
   */
  initializeAround(points: readonly Point3[]): void {
    this.matches.clear();
    for (let r = 0; r < this.rules.length; r++) {
      const rule = this.rules[r];
      for (const point of points) {
        for (let z = Math.max(0, point.z - rule.mz + 1); z <= Math.min(point.z, this.grid.mz - rule.mz); z++) {
          for (let y = Math.max(0, point.y - rule.my + 1); y <= Math.min(point.y, this.grid.my - rule.my); y++) {
            for (let x = Math.max(0, point.x - rule.mx + 1); x <= Math.min(point.x, this.grid.mx - rule.mx); x++) {
              this.refresh(r, x, y, z);
            }
          }
        }
      }
    }
    this.ready = true;
  }

  private updateAround(changes: readonly RewriteChange[]): void {
    for (let r = 0; r < this.rules.length; r++) {
      const rule = this.rules[r];
      for (const change of changes) {
        for (let z = Math.max(0, change.z - rule.mz + 1); z <= Math.min(change.z, this.grid.mz - rule.mz); z++) {
          for (let y = Math.max(0, change.y - rule.my + 1); y <= Math.min(change.y, this.grid.my - rule.my); y++) {
            for (let x = Math.max(0, change.x - rule.mx + 1); x <= Math.min(change.x, this.grid.mx - rule.mx); x++) {
              this.refresh(r, x, y, z);
            }
          }
        }
      }
    }
  }

  step(random: () => number, accept?: (match: RewriteMatch, rule: RewriteRule) => boolean): RewriteEvent | null {
    if (!this.ready) this.initialize();
    this.eligible.length = 0;
    let total = 0;
    for (const match of this.matches.values()) {
      const rule = this.rules[match.rule];
      if (accept && !accept(match, rule)) continue;
      this.eligible.push(match);
      total += Math.max(0, rule.weight);
    }
    if (total <= 0) return null;
    let roll = random() * total;
    let chosen: RewriteMatch | null = null;
    for (const candidate of this.eligible) {
      const candidateRule = this.rules[candidate.rule];
      chosen = candidate;
      roll -= Math.max(0, candidateRule.weight);
      if (roll <= 0) break;
    }
    if (!chosen) return null;
    const rule = this.rules[chosen.rule];
    const changes: RewriteChange[] = [];
    let p = 0;
    for (let dz = 0; dz < rule.mz; dz++) for (let dy = 0; dy < rule.my; dy++) for (let dx = 0; dx < rule.mx; dx++, p++) {
      const to = rule.output[p];
      if (to === KEEP) continue;
      const x = chosen.x + dx, y = chosen.y + dy, z = chosen.z + dz;
      const index = this.grid.index(x, y, z), from = this.grid.state[index];
      if (from === to) continue;
      this.grid.state[index] = to;
      changes.push({ x, y, z, index, from, to });
    }
    if (changes.length === 0) {
      this.matches.delete(this.key(chosen.rule, chosen.x, chosen.y, chosen.z));
      return null;
    }
    this.updateAround(changes);
    return { match: chosen, changes };
  }

  run(maxSteps: number, random: () => number, accept?: (match: RewriteMatch, rule: RewriteRule) => boolean): RewriteEvent[] {
    const events: RewriteEvent[] = [];
    for (let i = 0; i < maxSteps; i++) {
      const event = this.step(random, accept);
      if (!event) break;
      events.push(event);
    }
    return events;
  }

  /** Test/diagnostic hook: number of currently valid cached origins. */
  get matchCount(): number { if (!this.ready) this.initialize(); return this.matches.size; }
}
