// Editor UI. One drawer with three tabs — Library (spawn), Inspect (the
// selection's transform + outliner) and Generate (the same forge params the
// ⚙ panel exposes). Pure DOM, built once and mutated in place; the world
// consequences all flow back through EditorHooks.

import type { Params } from "../gen/dungeon";
import { GROUPS } from "../ui/panel";
import { DEFAULT_BRUSH, type BrushSettings } from "./brush";
import { assetGroups } from "./catalog";
import type { AssetDef, GizmoMode, PlacementRecord } from "./types";
import type { VarianceSettings } from "./variance";

export interface EditorHooks {
  onSpawn: (asset: AssetDef) => void;
  onSelect: (uid: string | null, additive?: boolean) => void;
  onDelete: (uid: string) => void;
  onDuplicate: () => void;
  onModeChange: (mode: GizmoMode) => void;
  onSnapChange: (snap: boolean) => void;
  onTransformEdit: (axis: "x" | "y" | "z", channel: GizmoMode, value: number) => void;
  onResetWorld: () => void;
  onSpaceChange: (space: "world" | "local") => void;
  onFrame: () => void;
  onArray: (count: number, axis: "x" | "y" | "z", spacing: number) => void;
  onBrushToggle: (asset: AssetDef | null) => void;
  onBrushSettings: (next: Partial<BrushSettings>) => void;
  onVariance: (on: boolean, next?: Partial<VarianceSettings>) => void;
  onParams: () => void;
  onReforge: () => void;
  onSave: () => void;
  onLoad: () => void;
  onExport: () => void;
  onImport: () => void;
  onClear: () => void;
}

type Tab = "library" | "inspect" | "generate";

export class EditorPanel {
  private root: HTMLElement;
  private tabBar: HTMLElement;
  private pages = new Map<Tab, HTMLElement>();
  private outliner: HTMLElement;
  private inspectorBody: HTMLElement;
  private emptyNote: HTMLElement;
  private numberInputs = new Map<string, HTMLInputElement>();
  private placementActions!: HTMLElement;
  private worldActions!: HTMLElement;
  private arrayRow!: HTMLElement;
  private transformFields!: HTMLElement;
  private brushBar!: HTMLElement;
  private brushLabel!: HTMLElement;
  private brushAssetId: string | null = null;
  private tiles: HTMLElement[] = [];
  private groupSections: HTMLElement[] = [];
  private subjectLabel!: HTMLElement;
  private activeTab: Tab = "library";
  private selectedUid: string | null = null;

  constructor(private genParams: Params, private hooks: EditorHooks) {
    this.root = document.createElement("aside");
    this.root.id = "editor";
    this.root.className = "closed";
    this.root.setAttribute("aria-hidden", "true");

    const head = document.createElement("header");
    head.innerHTML = "<strong>Dungeon editor</strong>";
    const close = document.createElement("button");
    close.className = "editor-close";
    close.textContent = "✕";
    close.title = "close editor (E)";
    close.addEventListener("click", () => this.setOpen(false));
    head.appendChild(close);
    this.root.appendChild(head);

    this.tabBar = document.createElement("nav");
    this.tabBar.className = "editor-tabs";
    this.root.appendChild(this.tabBar);

    for (const tab of ["library", "inspect", "generate"] as Tab[]) {
      const button = document.createElement("button");
      button.dataset.tab = tab;
      button.textContent = { library: "Library", inspect: "Inspect", generate: "Generate" }[tab];
      button.addEventListener("click", () => this.setTab(tab));
      this.tabBar.appendChild(button);
      const page = document.createElement("div");
      page.className = "editor-page";
      page.dataset.tab = tab;
      this.pages.set(tab, page);
      this.root.appendChild(page);
    }

    this.buildLibrary();
    const inspect = this.pages.get("inspect")!;
    this.inspectorBody = document.createElement("div");
    this.emptyNote = document.createElement("p");
    this.emptyNote.className = "editor-empty";
    this.emptyNote.textContent = "Click a placed prop in the world, or drop one from the Library.";
    inspect.append(this.emptyNote, this.inspectorBody);
    this.buildInspector();
    this.outliner = document.createElement("div");
    this.outliner.className = "editor-outliner";
    const outlinerTitle = document.createElement("h3");
    outlinerTitle.textContent = "Placed";
    inspect.append(outlinerTitle, this.outliner);
    this.buildGenerate();

    document.body.appendChild(this.root);
    this.setTab("library");
  }

  private buildLibrary(): void {
    const page = this.pages.get("library")!;
    const hint = document.createElement("p");
    hint.className = "editor-empty";
    hint.textContent = "Click to drop under the cursor. Alt-click to load the brush.";
    page.appendChild(hint);

    const search = document.createElement("input");
    search.type = "search";
    search.className = "editor-search";
    search.placeholder = "filter assets…";
    search.addEventListener("input", () => this.filterLibrary(search.value));
    page.appendChild(search);

    this.brushBar = document.createElement("div");
    this.brushBar.className = "editor-brushbar";
    this.brushBar.style.display = "none";
    page.appendChild(this.brushBar);
    this.buildBrushControls();

    for (const group of assetGroups()) {
      const section = document.createElement("div");
      section.className = "editor-group";
      const title = document.createElement("h3");
      title.textContent = group.title;
      const grid = document.createElement("div");
      grid.className = "editor-grid";
      for (const asset of group.assets) {
        const tile = document.createElement("button");
        tile.className = "editor-tile";
        tile.dataset.assetId = asset.id;
        tile.dataset.search = `${asset.label} ${asset.group} ${asset.id}`.toLowerCase();
        tile.title = `${asset.label} — click to place, alt-click to brush`;
        const face = document.createElement("span");
        face.className = "ico";
        // real silhouette when the geometry can supply one, emoji otherwise
        const url = asset.thumbnail?.() ?? null;
        if (url) {
          const img = document.createElement("img");
          img.src = url;
          img.alt = "";
          face.appendChild(img);
        } else {
          face.textContent = asset.icon;
        }
        const cap = document.createElement("span");
        cap.className = "cap";
        cap.textContent = asset.label;
        tile.append(face, cap);
        tile.addEventListener("click", (event) => {
          if (event.altKey) this.hooks.onBrushToggle(this.brushAssetId === asset.id ? null : asset);
          else this.hooks.onSpawn(asset);
        });
        grid.appendChild(tile);
        this.tiles.push(tile);
      }
      section.append(title, grid);
      page.appendChild(section);
      this.groupSections.push(section);
    }
  }

  private filterLibrary(query: string): void {
    const needle = query.trim().toLowerCase();
    for (const tile of this.tiles) {
      const hit = !needle || (tile.dataset.search ?? "").includes(needle);
      tile.style.display = hit ? "" : "none";
    }
    // hide a whole group heading once nothing in it survives the filter
    for (const section of this.groupSections) {
      const anyVisible = Array.from(section.querySelectorAll<HTMLElement>(".editor-tile"))
        .some((tile) => tile.style.display !== "none");
      section.style.display = anyVisible ? "" : "none";
    }
  }

  private buildBrushControls(): void {
    const label = document.createElement("div");
    label.className = "editor-brush-label";
    this.brushLabel = label;
    const stop = document.createElement("button");
    stop.className = "editor-mini";
    stop.textContent = "✕";
    stop.title = "put the brush down";
    stop.addEventListener("click", () => this.hooks.onBrushToggle(null));
    const head = document.createElement("div");
    head.className = "editor-brush-head";
    head.append(label, stop);

    const grid = document.createElement("div");
    grid.className = "editor-brush-grid";
    const number = (
      text: string, value: number, step: number, apply: (n: number) => void,
    ) => {
      const wrap = document.createElement("label");
      const input = document.createElement("input");
      input.type = "number";
      input.value = String(value);
      input.step = String(step);
      input.min = "0";
      input.addEventListener("change", () => apply(Number(input.value) || 0));
      wrap.append(document.createTextNode(text), input);
      grid.appendChild(wrap);
    };
    number("radius", DEFAULT_BRUSH.radius, 0.5, (n) => this.hooks.onBrushSettings({ radius: n }));
    number("spacing", DEFAULT_BRUSH.spacing, 0.5, (n) => this.hooks.onBrushSettings({ spacing: n }));
    number("per step", DEFAULT_BRUSH.density, 1, (n) => this.hooks.onBrushSettings({ density: Math.max(1, n) }));
    number("max", DEFAULT_BRUSH.maxDabs, 50, (n) => this.hooks.onBrushSettings({ maxDabs: Math.max(1, n) }));

    const varianceRow = document.createElement("label");
    varianceRow.className = "editor-check";
    const varianceOn = document.createElement("input");
    varianceOn.type = "checkbox";
    varianceOn.checked = true;
    varianceOn.addEventListener("change", () => this.hooks.onVariance(varianceOn.checked));
    varianceRow.append(varianceOn, document.createTextNode(" vary rotation & scale"));

    this.brushBar.append(head, grid, varianceRow);
  }

  setBrush(assetId: string | null): void {
    this.brushAssetId = assetId;
    this.brushBar.style.display = assetId ? "" : "none";
    if (assetId) this.brushLabel.textContent = `Brush · ${assetId}`;
    for (const tile of this.tiles) {
      tile.classList.toggle("brushing", tile.dataset.assetId === assetId);
    }
  }

  private buildInspector(): void {
    this.subjectLabel = document.createElement("p");
    this.subjectLabel.className = "editor-subject";
    this.inspectorBody.appendChild(this.subjectLabel);
    const modes = document.createElement("div");
    modes.className = "editor-seg";
    for (const [mode, glyph] of [
      ["translate", "✥ Move"], ["rotate", "⟳ Rotate"], ["scale", "⤢ Scale"],
    ] as Array<[GizmoMode, string]>) {
      const button = document.createElement("button");
      button.dataset.mode = mode;
      button.textContent = glyph;
      button.addEventListener("click", () => this.hooks.onModeChange(mode));
      modes.appendChild(button);
    }
    this.inspectorBody.appendChild(modes);

    const options = document.createElement("div");
    options.className = "editor-opts";
    const snapRow = document.createElement("label");
    snapRow.className = "editor-check";
    const snap = document.createElement("input");
    snap.type = "checkbox";
    snap.checked = true;
    snap.addEventListener("change", () => this.hooks.onSnapChange(snap.checked));
    snapRow.append(snap, document.createTextNode(" snap"));
    const spaceRow = document.createElement("label");
    spaceRow.className = "editor-check";
    const localSpace = document.createElement("input");
    localSpace.type = "checkbox";
    localSpace.addEventListener("change", () => {
      this.hooks.onSpaceChange(localSpace.checked ? "local" : "world");
    });
    spaceRow.append(localSpace, document.createTextNode(" local axes"));
    const frame = document.createElement("button");
    frame.className = "editor-mini";
    frame.textContent = "⌖ Frame";
    frame.title = "frame the selection (F)";
    frame.addEventListener("click", () => this.hooks.onFrame());
    options.append(snapRow, spaceRow, frame);
    this.inspectorBody.appendChild(options);

    this.transformFields = document.createElement("div");
    this.inspectorBody.appendChild(this.transformFields);
    for (const channel of ["translate", "rotate", "scale"] as GizmoMode[]) {
      const title = document.createElement("h3");
      title.textContent = { translate: "Position", rotate: "Rotation°", scale: "Scale" }[channel];
      this.transformFields.appendChild(title);
      const row = document.createElement("div");
      row.className = "editor-vec";
      for (const axis of ["x", "y", "z"] as const) {
        const field = document.createElement("input");
        field.type = "number";
        field.step = channel === "scale" ? "0.05" : channel === "rotate" ? "5" : "0.5";
        field.dataset.axis = axis;
        field.addEventListener("change", () => {
          this.hooks.onTransformEdit(axis, channel, Number(field.value));
        });
        this.numberInputs.set(`${channel}.${axis}`, field);
        const wrap = document.createElement("label");
        wrap.append(document.createTextNode(axis.toUpperCase()), field);
        row.appendChild(wrap);
      }
      this.transformFields.appendChild(row);
    }

    this.placementActions = document.createElement("div");
    this.placementActions.className = "editor-actions";
    const duplicate = document.createElement("button");
    duplicate.textContent = "⧉ Duplicate";
    duplicate.addEventListener("click", () => this.hooks.onDuplicate());
    const remove = document.createElement("button");
    remove.className = "danger";
    remove.textContent = "🗑 Delete";
    remove.addEventListener("click", () => {
      if (this.selectedUid) this.hooks.onDelete(this.selectedUid);
    });
    this.placementActions.append(duplicate, remove);
    this.inspectorBody.appendChild(this.placementActions);

    // Array duplicate: the one gesture that turns a single column into a
    // colonnade, which is most of what dressing a corridor actually is.
    this.arrayRow = document.createElement("div");
    this.arrayRow.className = "editor-array";
    const arrayTitle = document.createElement("h3");
    arrayTitle.textContent = "Repeat along axis";
    const controls = document.createElement("div");
    controls.className = "editor-array-row";
    const count = document.createElement("input");
    count.type = "number";
    count.value = "3";
    count.min = "1";
    count.max = "64";
    count.title = "copies";
    const axis = document.createElement("select");
    for (const value of ["x", "y", "z"] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value.toUpperCase();
      axis.appendChild(option);
    }
    const spacing = document.createElement("input");
    spacing.type = "number";
    spacing.value = "4";
    spacing.step = "0.5";
    spacing.title = "spacing";
    const go = document.createElement("button");
    go.textContent = "Repeat";
    go.addEventListener("click", () => {
      this.hooks.onArray(
        Math.max(1, Math.min(64, Number(count.value) || 1)),
        axis.value as "x" | "y" | "z",
        Number(spacing.value) || 1,
      );
    });
    controls.append(count, axis, spacing, go);
    this.arrayRow.append(arrayTitle, controls);
    this.inspectorBody.appendChild(this.arrayRow);

    // A generated object can't be deleted (the forge owns it) — it can only
    // be moved and put back, so it gets its own action row.
    this.worldActions = document.createElement("div");
    this.worldActions.className = "editor-actions";
    const reset = document.createElement("button");
    reset.textContent = "↺ Reset to generated";
    reset.addEventListener("click", () => this.hooks.onResetWorld());
    this.worldActions.appendChild(reset);
    this.inspectorBody.appendChild(this.worldActions);
  }

  private buildGenerate(): void {
    const page = this.pages.get("generate")!;
    let debounce = 0;
    for (const group of GROUPS) {
      const title = document.createElement("h3");
      title.textContent = group.title;
      page.appendChild(title);
      for (const def of group.defs) {
        const label = document.createElement("label");
        label.textContent = `${def.label} `;
        const value = document.createElement("span");
        value.textContent = String(this.genParams[def.key]);
        label.appendChild(value);
        const input = document.createElement("input");
        input.type = "range";
        input.min = String(def.min);
        input.max = String(def.max);
        input.step = String(def.step);
        input.value = String(this.genParams[def.key]);
        input.addEventListener("input", () => {
          (this.genParams[def.key] as number) = Number(input.value);
          value.textContent = input.value;
          clearTimeout(debounce);
          debounce = window.setTimeout(this.hooks.onParams, 180);
        });
        page.append(label, input);
      }
    }
    const reforge = document.createElement("button");
    reforge.className = "editor-wide";
    reforge.textContent = "⚒ Re-forge now";
    reforge.addEventListener("click", () => this.hooks.onReforge());
    page.appendChild(reforge);

    const title = document.createElement("h3");
    title.textContent = "Scene";
    page.appendChild(title);
    const io = document.createElement("div");
    io.className = "editor-actions wrap";
    for (const [text, handler] of [
      ["💾 Save", this.hooks.onSave],
      ["↩ Load", this.hooks.onLoad],
      ["⇩ Export", this.hooks.onExport],
      ["⇧ Import", this.hooks.onImport],
    ] as Array<[string, () => void]>) {
      const button = document.createElement("button");
      button.textContent = text;
      button.addEventListener("click", () => handler());
      io.appendChild(button);
    }
    const clear = document.createElement("button");
    clear.className = "danger";
    clear.textContent = "✖ Clear placements";
    clear.addEventListener("click", () => this.hooks.onClear());
    io.appendChild(clear);
    page.appendChild(io);
  }

  setTab(tab: Tab): void {
    this.activeTab = tab;
    for (const [key, page] of this.pages) page.classList.toggle("show", key === tab);
    for (const button of Array.from(this.tabBar.children)) {
      button.classList.toggle("active", (button as HTMLElement).dataset.tab === tab);
    }
  }

  setOpen(open: boolean): void {
    this.root.classList.toggle("closed", !open);
    this.root.setAttribute("aria-hidden", open ? "false" : "true");
    document.body.classList.toggle("editing", open);
  }

  get open(): boolean {
    return !this.root.classList.contains("closed");
  }

  setMode(mode: GizmoMode): void {
    for (const button of Array.from(this.inspectorBody.querySelectorAll("[data-mode]"))) {
      button.classList.toggle("active", (button as HTMLElement).dataset.mode === mode);
    }
  }

  /** Mirror the live transform into the numeric fields (called while the
   *  gizmo drags, so typing and dragging agree). `world` marks a generated
   *  object, which swaps Duplicate/Delete for Reset. */
  setSelection(
    subject: {
      label: string;
      position: [number, number, number];
      rotation: [number, number, number];
      scale: [number, number, number];
      uid?: string;
      count?: number;
    } | null,
    world = false,
  ): void {
    this.selectedUid = subject?.uid ?? null;
    this.emptyNote.style.display = subject ? "none" : "";
    this.inspectorBody.style.display = subject ? "" : "none";
    this.placementActions.style.display = subject && !world ? "" : "none";
    this.worldActions.style.display = subject && world ? "" : "none";
    this.arrayRow.style.display = subject && !world ? "" : "none";
    if (!subject) return;
    this.subjectLabel.textContent = world
      ? `⛰ ${subject.label} (generated)`
      : subject.count && subject.count > 1
        ? `◆ ${subject.count} selected`
        : `◆ ${subject.label}`;
    // a multi-selection has no single transform to show
    this.transformFields.style.display = subject.count && subject.count > 1 ? "none" : "";
    const write = (channel: GizmoMode, values: [number, number, number], scale = 1) => {
      (["x", "y", "z"] as const).forEach((axis, index) => {
        const field = this.numberInputs.get(`${channel}.${axis}`);
        if (field && document.activeElement !== field) {
          field.value = (values[index] * scale).toFixed(channel === "scale" ? 3 : 2);
        }
      });
    };
    write("translate", subject.position);
    write("rotate", subject.rotation, 180 / Math.PI);
    write("scale", subject.scale);
    if (this.activeTab === "library") this.setTab("inspect");
  }

  setOutliner(records: PlacementRecord[], selectedUids: string[]): void {
    const selected = new Set(selectedUids);
    this.outliner.textContent = "";
    if (records.length === 0) {
      const none = document.createElement("p");
      none.className = "editor-empty";
      none.textContent = "Nothing placed yet.";
      this.outliner.appendChild(none);
      return;
    }
    for (const record of records) {
      const row = document.createElement("button");
      row.className = "editor-row";
      row.classList.toggle("active", selected.has(record.uid));
      row.textContent = record.assetId;
      row.addEventListener("click", (event) => this.hooks.onSelect(record.uid, event.shiftKey));
      this.outliner.appendChild(row);
    }
  }
}
