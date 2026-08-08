export type RelicKind = "vitality" | "edge" | "renewal";

export interface RelicReward {
  kind: RelicKind;
  label: string;
  detail: string;
}

export interface RogueSnapshot {
  active: boolean;
  dead: boolean;
  baseSeed: number;
  floor: number;
  hp: number;
  maxHp: number;
  attack: number;
  shards: number;
  kills: number;
  enemiesAlive: number;
  enemiesTotal: number;
  awaitingReward: boolean;
  rewardsChosen: number;
  wardensDefeated: number;
}

/** Pure deterministic run state. Rendering, movement and AI remain adapters;
 * this owns the roguelike contract so death/reward/floor rules can be tested
 * without THREE or a browser. */
export class RogueRun {
  readonly state: RogueSnapshot = {
    active: false, dead: false, baseSeed: 1, floor: 1,
    hp: 100, maxHp: 100, attack: 1, shards: 0, kills: 0,
    enemiesAlive: 0, enemiesTotal: 0, awaitingReward: false, rewardsChosen: 0,
    wardensDefeated: 0,
  };
  private opened = new Set<string>();

  start(seed: number, enemies: number): void {
    Object.assign(this.state, {
      active: true,
      dead: false,
      baseSeed: seed >>> 0 || 1,
      floor: 1,
      hp: 100,
      maxHp: 100,
      attack: 1,
      shards: 0,
      kills: 0,
      enemiesAlive: Math.max(0, enemies | 0),
      enemiesTotal: Math.max(0, enemies | 0),
      awaitingReward: false,
      rewardsChosen: 0,
      wardensDefeated: 0,
    });
    this.opened.clear();
  }

  stop(): void { this.state.active = false; }

  takeDamage(amount: number): boolean {
    if (!this.state.active || this.state.dead || amount <= 0) return false;
    this.state.hp = Math.max(0, this.state.hp - amount);
    if (this.state.hp === 0) {
      this.state.dead = true;
      this.state.active = false;
    }
    return this.state.dead;
  }

  defeat(count = 1, eliteCount = 0): void {
    const before = this.state.enemiesAlive;
    const n = Math.min(this.state.enemiesAlive, Math.max(0, count | 0));
    this.state.enemiesAlive -= n;
    this.state.kills += n;
    this.state.shards += n * (2 + Math.floor(this.state.floor / 2));
    const elites = Math.min(n, Math.max(0, eliteCount | 0));
    this.state.wardensDefeated += elites;
    this.state.shards += elites * (6 + this.state.floor * 2);
    if (before > 0 && this.state.enemiesAlive === 0) this.state.awaitingReward = true;
  }

  canDescend(): boolean {
    return this.state.active && !this.state.dead
      && this.state.enemiesAlive === 0 && !this.state.awaitingReward;
  }

  descend(enemies: number): void {
    if (!this.canDescend()) throw new Error("Cannot descend while enemies remain");
    this.state.floor++;
    this.state.hp = Math.min(this.state.maxHp, this.state.hp + Math.ceil(this.state.maxHp * 0.2));
    this.state.enemiesAlive = this.state.enemiesTotal = Math.max(0, enemies | 0);
    this.state.awaitingReward = false;
  }

  floorSeed(floor = this.state.floor): number {
    let x = (this.state.baseSeed ^ Math.imul(floor, 0x9e3779b1)) >>> 0;
    x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b); x ^= x >>> 16;
    return x >>> 0 || 1;
  }

  /** Every clear offers all three build axes in a seed-rotated order. The
   * player always has agency, while deterministic ordering keeps runs and
   * browser regressions reproducible. */
  floorChoices(): RelicReward[] {
    const vitality = 10 + this.state.floor * 2;
    const renewal = Math.ceil(this.state.maxHp * 0.4);
    const choices: RelicReward[] = [
      { kind: "vitality", label: "Titan's Marrow", detail: `+${vitality} max health` },
      { kind: "edge", label: "Predator Sigil", detail: "+1 attack" },
      { kind: "renewal", label: "Ash Communion", detail: `restore ${renewal} health · full HP becomes shards` },
    ];
    const shift = this.floorSeed() % choices.length;
    return choices.map((_, index) => choices[(index + shift) % choices.length]);
  }

  chooseFloorReward(kind: RelicKind): RelicReward | null {
    if (!this.state.active || this.state.dead || !this.state.awaitingReward) return null;
    const reward = this.floorChoices().find((choice) => choice.kind === kind);
    if (!reward) return null;
    if (kind === "vitality") {
      const gain = 10 + this.state.floor * 2;
      this.state.maxHp += gain;
      this.state.hp = Math.min(this.state.maxHp, this.state.hp + gain);
    } else if (kind === "edge") {
      this.state.attack++;
    } else {
      const before = this.state.hp;
      this.state.hp = Math.min(this.state.maxHp, this.state.hp + Math.ceil(this.state.maxHp * 0.4));
      if (this.state.hp === before) this.state.shards += 6 + this.state.floor * 2;
    }
    this.state.awaitingReward = false;
    this.state.rewardsChosen++;
    return reward;
  }

  openChest(key: string): RelicReward | null {
    if (!this.state.active || this.state.dead || this.opened.has(key)) return null;
    this.opened.add(key);
    const roll = this.hashText(`${this.state.baseSeed}:${this.state.floor}:${key}`) % 3;
    if (roll === 0) {
      this.state.maxHp += 12;
      this.state.hp = Math.min(this.state.maxHp, this.state.hp + 20);
      return { kind: "vitality", label: "Stone Heart", detail: "+12 max health" };
    }
    if (roll === 1) {
      this.state.attack++;
      return { kind: "edge", label: "Runed Edge", detail: "+1 attack" };
    }
    const before = this.state.hp;
    this.state.hp = Math.min(this.state.maxHp, this.state.hp + 32);
    if (this.state.hp === before) this.state.shards += 8;
    return { kind: "renewal", label: "Ember Phial", detail: before === this.state.hp ? "+8 shards" : "+32 health" };
  }

  private hashText(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return h >>> 0;
  }
}
