// Forge-parameter panel: sliders bound to Params + the endless-mode toggle.
// Pure DOM; world consequences flow back through the hooks.

import type { Params } from "../gen/dungeon";

export interface PanelHooks {
  /** a slider moved (already debounced) — re-forge with the new params */
  onParams: () => void;
  onEndless: (on: boolean) => void;
}

const DEFS: Array<{ key: keyof Params; label: string; min: number; max: number; step: number }> = [
  { key: "islands", label: "linked blocks", min: 1, max: 24, step: 1 },
  { key: "size", label: "dungeon size", min: 9, max: 21, step: 2 },
  { key: "plazas", label: "teleport plazas", min: 0, max: 4, step: 1 },
  { key: "totems", label: "brazier totems", min: 0, max: 10, step: 1 },
  { key: "heightAmp", label: "terrain relief", min: 0, max: 4, step: 0.1 },
  { key: "mound", label: "temple mound", min: 0, max: 5, step: 0.1 },
  { key: "braid", label: "braid (open dead ends)", min: 0, max: 1, step: 0.05 },
  { key: "loops", label: "extra loops", min: 0, max: 0.3, step: 0.01 },
  { key: "newest", label: "maze: branchy ↔ river", min: 0, max: 1, step: 0.05 },
  { key: "torchSpacing", label: "torch spacing", min: 3, max: 9, step: 1 },
  { key: "wallThin", label: "wall thickness", min: 0.25, max: 1, step: 0.05 },
  { key: "decay", label: "age & decay", min: 0, max: 1, step: 0.05 },
];

export function buildPanel(genParams: Params, hooks: PanelHooks): void {
  const panel = document.getElementById("params")!;

  const endlessLabel = document.createElement("label");
  endlessLabel.textContent = "endless ∞ (roam to generate) ";
  const endlessBox = document.createElement("input");
  endlessBox.type = "checkbox";
  endlessBox.style.width = "auto";
  endlessLabel.appendChild(endlessBox);
  panel.appendChild(endlessLabel);
  endlessBox.addEventListener("change", () => hooks.onEndless(endlessBox.checked));

  let debounce = 0;
  for (const d of DEFS) {
    const label = document.createElement("label");
    label.textContent = d.label + " ";
    const val = document.createElement("span");
    val.textContent = String(genParams[d.key]);
    label.appendChild(val);
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(d.min); input.max = String(d.max); input.step = String(d.step);
    input.value = String(genParams[d.key]);
    input.addEventListener("input", () => {
      (genParams[d.key] as number) = Number(input.value);
      val.textContent = input.value;
      clearTimeout(debounce);
      debounce = window.setTimeout(hooks.onParams, 180);
    });
    panel.appendChild(label);
    panel.appendChild(input);
  }
}
