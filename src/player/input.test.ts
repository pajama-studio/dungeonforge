import { describe, expect, it } from "vitest";
import { playerInputFromKeys } from "./input";

describe("playerInputFromKeys", () => {
  it("maps A to camera-left and D to camera-right", () => {
    expect(playerInputFromKeys(new Set(["a"]))).toEqual({ f: 0, s: 1 });
    expect(playerInputFromKeys(new Set(["d"]))).toEqual({ f: 0, s: -1 });
  });

  it("cancels opposing keys without changing forward input", () => {
    expect(playerInputFromKeys(new Set(["w", "a", "d"]))).toEqual({ f: 1, s: 0 });
  });
});
