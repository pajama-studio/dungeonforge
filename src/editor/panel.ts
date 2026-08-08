// Editor UI. One drawer with three tabs — Library (spawn), Inspect (the
// selection's transform + outliner) and Generate (the same forge params the
// ⚙ panel exposes). Pure DOM, built once and mutated in place; the world
// consequences all flow back through EditorHooks.

import type { Params } from "../gen/dungeon";
import { GROUPS } from "../ui/panel";
import { assetGroups } from "./catalog";
import type { AssetDef, GizmoMode, PlacementRecord } from "./types";

export interface EditorHooks {
  onSpawn: (asset: AssetDef) => void;
  onSelect: (uid: string | null) => void;
  onDelete: (uid: string) => void;
  onDuplicate: () => void;
  onModeChange: (mode: GizmoMode) => void;
  onSnapChange: (snap: boolean) => void;
  onTransformEdit: (axis: "x" | "y" | "z", channel: GizmoMode, value: number) => void;
  onResetWorld: () => void;
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
    hint.textContent = "Click an asset to drop it at the view centre.";
    page.appendChild(hint);
    for (const group of assetGroups()) {
      const title = document.createElement("h3");
      title.textContent = group.title;
      page.appendChild(title);
      const grid = document.createElement("div");
      grid.className = "editor-grid";
      for (const asset of group.assets) {
        const tile = document.createElement("button");
        tile.className = "editor-tile";
        tile.title = asset.label;
        tile.innerHTML = `<span class="ico">${asset.icon}</span><span class="cap">${asset.label}</span>`;
        tile.addEventListener("click", () => this.hooks.onSpawn(asset));
        grid.appendChild(tile);
      }
      page.appendChild(grid);
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

    const snapRow = document.createElement("label");
    snapRow.className = "editor-check";
    const snap = document.createElement("input");
    snap.type = "checkbox";
    snap.checked = true;
    snap.addEventListener("change", () => this.hooks.onSnapChange(snap.checked));
    snapRow.append(snap, document.createTextNode(" snap to grid"));
    this.inspectorBody.appendChild(snapRow);

    for (const channel of ["translate", "rotate", "scale"] as GizmoMode[]) {
      const title = document.createElement("h3");
      title.textContent = { translate: "Position", rotate: "Rotation°", scale: "Scale" }[channel];
      this.inspectorBody.appendChild(title);
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
      this.inspectorBody.appendChild(row);
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
    subject: { label: string; position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number]; uid?: string } | null,
    world = false,
  ): void {
    this.selectedUid = subject?.uid ?? null;
    this.emptyNote.style.display = subject ? "none" : "";
    this.inspectorBody.style.display = subject ? "" : "none";
    this.placementActions.style.display = subject && !world ? "" : "none";
    this.worldActions.style.display = subject && world ? "" : "none";
    if (!subject) return;
    this.subjectLabel.textContent = world ? `⛰ ${subject.label} (generated)` : `◆ ${subject.label}`;
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

  setOutliner(records: PlacementRecord[], selectedUid: string | null): void {
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
      row.classList.toggle("active", record.uid === selectedUid);
      row.textContent = record.assetId;
      row.addEventListener("click", () => this.hooks.onSelect(record.uid));
      this.outliner.appendChild(row);
    }
  }
}
