import { describe, expect, it } from "vitest";
import { RogueRun } from "./roguelike";

describe("RogueRun", () => {
  it("requires a cleared floor before deterministic descent", () => {
    const run = new RogueRun();
    run.start(359139884, 3);
    expect(() => run.descend(4)).toThrow();
    run.defeat(3);
    expect(run.state.awaitingReward).toBe(true);
    expect(run.canDescend()).toBe(false);
    expect(run.floorChoices()).toHaveLength(3);
    expect(run.chooseFloorReward("edge")?.kind).toBe("edge");
    expect(run.state.attack).toBe(2);
    expect(run.canDescend()).toBe(true);
    const nextSeed = run.floorSeed(2);
    run.descend(4);
    expect(run.state.floor).toBe(2);
    expect(run.state.enemiesAlive).toBe(4);
    expect(run.floorSeed()).toBe(nextSeed);
    expect(run.state.rewardsChosen).toBe(1);
  });

  it("makes the clear reward one-shot and turns full renewal into shards", () => {
    const run = new RogueRun();
    run.start(19, 1);
    run.defeat();
    const before = run.state.shards;
    expect(run.chooseFloorReward("renewal")?.kind).toBe("renewal");
    expect(run.state.shards).toBeGreaterThan(before);
    expect(run.chooseFloorReward("edge")).toBeNull();
  });

  it("makes chest rewards reproducible and one-shot", () => {
    const a = new RogueRun(), b = new RogueRun();
    a.start(7, 0); b.start(7, 0);
    expect(a.openChest("vault:3")).toEqual(b.openChest("vault:3"));
    expect(a.state).toEqual(b.state);
    expect(a.openChest("vault:3")).toBeNull();
  });

  it("ends the run at zero health", () => {
    const run = new RogueRun();
    run.start(1, 1);
    expect(run.takeDamage(150)).toBe(true);
    expect(run.state.dead).toBe(true);
    expect(run.state.active).toBe(false);
  });

  it("pays a deterministic Warden bounty inside the same encounter budget", () => {
    const run = new RogueRun();
    run.start(31, 2);
    run.defeat(1, 1);
    expect(run.state.wardensDefeated).toBe(1);
    expect(run.state.shards).toBe(10); // floor-1 kill 2 + Warden bounty 8
    expect(run.state.enemiesAlive).toBe(1);
  });
});
