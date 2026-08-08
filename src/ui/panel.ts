// Forge-parameter panel: grouped sliders bound to Params. Pure DOM; world
// consequences flow back through the hooks. Mode switching (incl. endless)
// lives in the segmented control in main.ts — this panel is tuning only.

import type { Params } from "../gen/dungeon";

export interface PanelHooks {
  /** a slider moved (already debounced) — re-forge with the new params */
  onParams: () => void;
}

export interface Def { key: keyof Params; label: string; min: number; max: number; step: number }

/** Shared with the editor's Generate tab so both surfaces expose exactly the
 *  same tunables — a slider added here shows up in both. */
export const GROUPS: Array<{ title: string; defs: Def[] }> = [
  {
    title: "Layout",
    defs: [
      { key: "islands", label: "linked blocks", min: 1, max: 24, step: 1 },
      { key: "size", label: "dungeon size", min: 9, max: 21, step: 2 },
      { key: "plazas", label: "teleport plazas", min: 0, max: 4, step: 1 },
      { key: "totems", label: "brazier totems", min: 0, max: 10, step: 1 },
    ],
  },
  {
    title: "Terrain",
    defs: [
      { key: "heightAmp", label: "terrain relief", min: 0, max: 4, step: 0.1 },
      { key: "mound", label: "temple mound", min: 0, max: 5, step: 0.1 },
    ],
  },
  {
    title: "Maze",
    defs: [
      { key: "braid", label: "open dead ends", min: 0, max: 1, step: 0.05 },
      { key: "loops", label: "extra loops", min: 0, max: 0.3, step: 0.01 },
      { key: "newest", label: "branchy ↔ river", min: 0, max: 1, step: 0.05 },
    ],
  },
  {
    title: "Dressing",
    defs: [
      { key: "torchSpacing", label: "torch spacing", min: 3, max: 9, step: 1 },
      { key: "wallThin", label: "wall thickness", min: 0.25, max: 1, step: 0.05 },
      { key: "decay", label: "age & decay", min: 0, max: 1, step: 0.05 },
    ],
  },
];

export function buildPanel(genParams: Params, hooks: PanelHooks): void {
  const body = document.getElementById("params-body")!;
  let debounce = 0;
  for (const g of GROUPS) {
    const h = document.createElement("h3");
    h.textContent = g.title;
    body.appendChild(h);
    for (const d of g.defs) {
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
      body.appendChild(label);
      body.appendChild(input);
    }
  }
}
