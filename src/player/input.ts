import type { PlayerInput } from "./player";

export function playerInputFromKeys(keys: ReadonlySet<string>): PlayerInput {
  return {
    f: (keys.has("w") || keys.has("arrowup") ? 1 : 0)
      - (keys.has("s") || keys.has("arrowdown") ? 1 : 0),
    // Player's positive strafe axis is camera-left for the orbit yaw basis.
    s: (keys.has("a") || keys.has("arrowleft") ? 1 : 0)
      - (keys.has("d") || keys.has("arrowright") ? 1 : 0),
  };
}
