// Dungeon editor: binds the placement stage to the panel and to the host
// app's forge/camera. main.ts owns one instance and calls `toggle()`; every
// other interaction is self-contained here.

import * as THREE from "three/webgpu";
import type { Params } from "../gen/dungeon";
import { assetById } from "./catalog";
import { EditorPanel } from "./panel";
import { buildDocument, clearLocal, exportFile, importFile, loadLocal, saveLocal } from "./persist";
import { EditorStage } from "./stage";
import type { AssetDef, GizmoMode, SceneDocument } from "./types";

export interface EditorHost {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  dom: HTMLCanvasElement;
  controls: { enabled: boolean; target: THREE.Vector3; autoRotate: boolean };
  genParams: Params;
  /** current seed/mode, read when a document is written */
  state: { seed: number };
  activeMode: () => string;
  reforge: () => void;
  /** stop walk/rogue/cinematic before the editor takes the camera */
  quiesce: () => void;
  toast?: (message: string) => void;
}

export class DungeonEditor {
  private stage: EditorStage;
  private panel: EditorPanel;
  private pointerDown = new THREE.Vector2();
  private ndc = new THREE.Vector2();
  private restoring = false;

  constructor(private host: EditorHost) {
    this.stage = new EditorStage(
      host.scene, host.camera, host.dom, host.controls,
      {
        onSelect: () => this.refreshPanel(),
        onChange: () => this.refreshPanel(),
      },
    );
    this.panel = new EditorPanel(host.genParams, {
      onSpawn: (asset) => void this.spawn(asset),
      onSelect: (uid) => void this.stage.select(uid),
      onDelete: (uid) => this.stage.remove(uid),
      onDuplicate: () => void this.stage.duplicate(),
      onModeChange: (mode) => this.setMode(mode),
      onSnapChange: (snap) => this.stage.setSnap(snap),
      onTransformEdit: (axis, channel, value) => this.editTransform(axis, channel, value),
      onResetWorld: () => { this.stage.resetWorldSelection(); this.refreshPanel(); },
      onParams: () => host.reforge(),
      onReforge: () => host.reforge(),
      onSave: () => this.save(),
      onLoad: () => void this.load(),
      onExport: () => exportFile(this.document()),
      onImport: () => void this.importDocument(),
      onClear: () => {
        this.stage.clear();
        this.stage.clearOverrides();
        this.refreshPanel();
      },
    });
    this.panel.setMode(this.stage.getMode());
    this.bindPointer();
    this.bindKeys();
    this.refreshPanel();
  }

  get open(): boolean {
    return this.panel.open;
  }

  toggle(force?: boolean): void {
    const next = force ?? !this.panel.open;
    if (next) {
      this.host.quiesce();
      this.host.controls.autoRotate = false;
    } else {
      void this.stage.select(null);
    }
    this.panel.setOpen(next);
    this.stage.setGizmoVisible(next);
  }

  private setMode(mode: GizmoMode): void {
    this.stage.setMode(mode);
    this.panel.setMode(mode);
  }

  /** Spawn in front of the camera, at the orbit target's depth — the asset
   *  lands where the user is actually looking rather than at the origin. */
  private async spawn(asset: AssetDef): Promise<void> {
    const at = this.host.controls.target.clone();
    await this.stage.place(asset, at);
    this.host.toast?.(`placed ${asset.label}`);
  }

  private editTransform(axis: "x" | "y" | "z", channel: GizmoMode, value: number): void {
    const object = this.stage.selected ?? this.stage.selectedWorld;
    if (!object) return;
    if (channel === "translate") object.position[axis] = value;
    else if (channel === "rotate") object.rotation[axis] = (value * Math.PI) / 180;
    else object.scale[axis] = value === 0 ? 0.001 : value;
    object.updateMatrixWorld(true);
    // re-attaching refreshes the gizmo's cached matrix without a full reselect
    if (this.stage.selectedWorld) void this.stage.selectWorld(this.stage.selectedWorld);
    else void this.stage.select(this.stage.selectedRecord?.uid ?? null);
    this.refreshPanel();
  }

  private bindPointer(): void {
    this.host.dom.addEventListener("pointerdown", (event) => {
      if (!this.panel.open || event.button !== 0) return;
      this.pointerDown.set(event.clientX, event.clientY);
    });
    this.host.dom.addEventListener("pointerup", (event) => {
      if (!this.panel.open || event.button !== 0) return;
      // a drag is an orbit, not a click — only pick on a near-stationary tap
      const moved = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y);
      if (moved > 4) return;
      const rect = this.host.dom.getBoundingClientRect();
      this.ndc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      if (!this.stage.pickAt(this.ndc)) void this.stage.select(null);
    });
  }

  private bindKeys(): void {
    addEventListener("keydown", (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      // `E` (open/close) is owned by main.ts: the editor is lazily imported,
      // so the toggle has to work before this module exists.
      if (!this.panel.open) return;
      const key = event.key.toLowerCase();
      if (key === "1") this.setMode("translate");
      else if (key === "2") this.setMode("rotate");
      else if (key === "3") this.setMode("scale");
      else if (key === "delete" || key === "backspace") {
        const uid = this.stage.selectedRecord?.uid;
        if (uid) { event.preventDefault(); this.stage.remove(uid); }
      } else if (key === "d" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void this.stage.duplicate();
      } else if (key === "z" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.stage.undo();
      } else if (key === "escape") {
        void this.stage.select(null);
      }
    });
  }

  private refreshPanel(): void {
    if (this.restoring) return;
    const world = this.stage.selectedWorld;
    if (world) {
      this.panel.setSelection({
        label: world.name,
        position: world.position.toArray() as [number, number, number],
        rotation: [world.rotation.x, world.rotation.y, world.rotation.z],
        scale: world.scale.toArray() as [number, number, number],
      }, true);
    } else {
      const record = this.stage.selectedRecord;
      this.panel.setSelection(record ? { ...record, label: record.assetId } : null);
    }
    this.panel.setOutliner(this.stage.list(), this.stage.selectedRecord?.uid ?? null);
  }

  /** Called by the host after a forge: generated objects were rebuilt or had
   *  their transforms reset, so every override has to be stamped back on. */
  reapplyOverrides(): void {
    this.stage.reapplyOverrides();
    this.refreshPanel();
  }

  private document(): SceneDocument {
    return {
      ...buildDocument(
        this.host.state.seed,
        this.host.activeMode(),
        this.host.genParams,
        this.stage.list(),
      ),
      overrides: this.stage.worldOverrides(),
    };
  }

  private save(): void {
    saveLocal(this.document());
    this.host.toast?.("scene saved");
  }

  private async load(): Promise<void> {
    const doc = loadLocal();
    if (!doc) {
      this.host.toast?.("no saved scene");
      return;
    }
    await this.applyDocument(doc);
    this.host.toast?.("scene restored");
  }

  private async importDocument(): Promise<void> {
    const doc = await importFile();
    if (!doc) {
      this.host.toast?.("import failed");
      return;
    }
    await this.applyDocument(doc);
    this.host.toast?.("scene imported");
  }

  /** Rebuild every placement from ids. Unknown ids are skipped rather than
   *  aborting the load, so a save from a newer catalog still mostly works. */
  private async applyDocument(doc: SceneDocument): Promise<void> {
    this.restoring = true;
    this.stage.clear();
    const origin = new THREE.Vector3();
    let missing = 0;
    for (const record of doc.placements) {
      const asset = assetById(record.assetId);
      if (!asset) { missing += 1; continue; }
      await this.stage.place(asset, origin, record);
    }
    if (doc.overrides) this.stage.loadOverrides(doc.overrides);
    this.restoring = false;
    this.refreshPanel();
    if (missing > 0) console.warn(`[editor] skipped ${missing} unknown asset(s)`);
  }

  /** Restore the last session's placements without touching the camera. */
  async restoreSaved(): Promise<void> {
    const doc = loadLocal();
    if (doc && doc.placements.length > 0) await this.applyDocument(doc);
  }

  clearSaved(): void {
    clearLocal();
  }

  dispose(): void {
    this.stage.dispose();
  }
}
