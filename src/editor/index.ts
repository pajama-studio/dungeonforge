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
  /** public so the dev hook can drive placement from a script — the same
   *  surface the screenshot/verification tooling uses */
  readonly stage: EditorStage;
  private panel: EditorPanel;
  private pointerDown = new THREE.Vector2();
  private ndc = new THREE.Vector2();
  /** live cursor in NDC, so a spawn can land under the pointer */
  private hoverNdc = new THREE.Vector2();
  private pointerInViewport = false;
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
      onSelect: (uid, additive) => void this.stage.select(uid, additive),
      onDelete: (uid) => this.stage.remove(uid),
      onDuplicate: () => void this.stage.duplicate(),
      onModeChange: (mode) => this.setMode(mode),
      onSnapChange: (snap) => this.stage.setSnap(snap),
      onTransformEdit: (axis, channel, value) => this.editTransform(axis, channel, value),
      onResetWorld: () => { this.stage.resetWorldSelection(); this.refreshPanel(); },
      onSpaceChange: (space) => this.stage.setSpace(space),
      onFrame: () => this.frameSelection(),
      onArray: (count, axis, spacing) => void this.stage.duplicateArray(count, axis, spacing),
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

  /** Land the asset ON the surface under the cursor, standing it up on that
   *  face. Falls back to the orbit target when the pointer is over open sky
   *  or has not entered the viewport yet. */
  private async spawn(asset: AssetDef): Promise<void> {
    const drop = this.pointerInViewport ? this.stage.surfaceDrop(this.hoverNdc) : null;
    const at = drop?.point.clone() ?? this.host.controls.target.clone();
    await this.stage.place(asset, at, undefined, { normal: drop?.normal ?? null });
    this.host.toast?.(drop ? `placed ${asset.label} on surface` : `placed ${asset.label}`);
  }

  /** Pull the camera back until the selection fits, keeping the current view
   *  direction. Without this a landmark dropped at monument scale engulfs the
   *  camera and there is no way to find it. */
  frameSelection(): void {
    const objects = this.stage.selectedObjects();
    if (objects.length === 0) return;
    const box = new THREE.Box3();
    for (const object of objects) box.expandByObject(object);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 1);
    const camera = this.host.camera;
    const back = camera.position.clone().sub(this.host.controls.target);
    if (back.lengthSq() < 1e-6) back.set(1, 0.6, 1);
    const fov = (camera.fov * Math.PI) / 180;
    back.setLength((radius / Math.sin(fov * 0.5)) * 1.25);
    camera.position.copy(center).add(back);
    this.host.controls.target.copy(center);
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

  private toNdc(event: { clientX: number; clientY: number }, out: THREE.Vector2): THREE.Vector2 {
    const rect = this.host.dom.getBoundingClientRect();
    return out.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  private bindPointer(): void {
    this.host.dom.addEventListener("pointermove", (event) => {
      if (!this.panel.open) return;
      this.toNdc(event, this.hoverNdc);
      this.pointerInViewport = true;
    });
    this.host.dom.addEventListener("pointerleave", () => { this.pointerInViewport = false; });
    this.host.dom.addEventListener("pointerdown", (event) => {
      if (!this.panel.open || event.button !== 0) return;
      this.pointerDown.set(event.clientX, event.clientY);
    });
    this.host.dom.addEventListener("pointerup", (event) => {
      if (!this.panel.open || event.button !== 0) return;
      // a drag is an orbit, not a click — only pick on a near-stationary tap
      const moved = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y);
      if (moved > 4) return;
      this.toNdc(event, this.ndc);
      if (!this.stage.pickAt(this.ndc, event.shiftKey)) {
        if (!event.shiftKey) void this.stage.select(null);
      }
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
      else if (key === "f") {
        event.preventDefault();
        this.frameSelection();
      } else if (key === "delete" || key === "backspace") {
        if (this.stage.selectionSize() > 0) { event.preventDefault(); this.stage.removeSelected(); }
      } else if (key === "d" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void this.stage.duplicate();
      } else if (key === "z" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.stage.undo();
      } else if (key === "escape") {
        void this.stage.select(null);
      } else if (key.startsWith("arrow")) {
        // nudge along the ground plane, or vertically with shift
        const step = this.stage.getSnap() ? 0.5 : 0.1;
        const delta = new THREE.Vector3();
        if (event.shiftKey) {
          if (key === "arrowup") delta.y = step;
          else if (key === "arrowdown") delta.y = -step;
        } else if (key === "arrowleft") delta.x = -step;
        else if (key === "arrowright") delta.x = step;
        else if (key === "arrowup") delta.z = -step;
        else if (key === "arrowdown") delta.z = step;
        if (delta.lengthSq() > 0 && this.stage.selectionSize() > 0) {
          event.preventDefault();
          this.stage.nudge(delta);
        }
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
      const count = this.stage.selectionSize();
      this.panel.setSelection(record ? { ...record, label: record.assetId, count } : null);
    }
    this.panel.setOutliner(this.stage.list(), this.stage.selectedUids());
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
