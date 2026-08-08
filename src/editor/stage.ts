// The editor's scene layer: one persistent group that survives re-forge,
// click selection, a TransformControls rig and undo. This owns NOTHING about
// the DOM — the panel drives it through this small API, so the placement
// model stays testable without a browser.

import * as THREE from "three/webgpu";
import type { TransformControls } from "three/addons/controls/TransformControls.js";
import type { AssetDef, GizmoMode, PlacementRecord } from "./types";

/** Placed props live under this group. `forge()` clears slot pools and
 *  landmark groups but never touches it, so edits survive a re-forge. */
export const EDITOR_LAYER = "editor-placements";

let uidCounter = 0;
function nextUid(): string {
  uidCounter += 1;
  return `p${uidCounter.toString(36)}${Date.now().toString(36).slice(-4)}`;
}

interface Placed {
  record: PlacementRecord;
  object: THREE.Object3D;
  asset: AssetDef;
}

export interface StageEvents {
  onSelect?: (uid: string | null) => void;
  onChange?: () => void;
}

export class EditorStage {
  readonly group = new THREE.Group();
  private placed = new Map<string, Placed>();
  private transform: TransformControls | null = null;
  private transformLoad: Promise<TransformControls> | null = null;
  private selectedUid: string | null = null;
  private mode: GizmoMode = "translate";
  private snap = true;
  /** transform state captured on mouseDown, so one drag is one undo step */
  private dragStart: PlacementRecord | null = null;
  private undoStack: Array<() => void> = [];

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    private dom: HTMLElement,
    private controls: { enabled: boolean },
    private events: StageEvents = {},
  ) {
    this.group.name = EDITOR_LAYER;
    scene.add(this.group);
  }

  get selected(): THREE.Object3D | null {
    const uid = this.selectedUid;
    return uid ? this.placed.get(uid)?.object ?? null : null;
  }

  get selectedRecord(): PlacementRecord | null {
    const uid = this.selectedUid;
    return uid ? this.placed.get(uid)?.record ?? null : null;
  }

  list(): PlacementRecord[] {
    return [...this.placed.values()].map((p) => p.record);
  }

  /** Lazily import TransformControls — it is only needed once the editor is
   *  actually opened, and the module carries its own helper geometry. */
  private async ensureTransform(): Promise<TransformControls> {
    if (this.transform) return this.transform;
    this.transformLoad ??= import("three/addons/controls/TransformControls.js").then(
      ({ TransformControls }) => {
        const t = new TransformControls(this.camera, this.dom);
        t.setSize(0.78);
        t.setSpace("world");
        const helper = t.getHelper();
        helper.name = "editor-transform-gizmo";
        this.scene.add(helper);
        t.addEventListener("dragging-changed", (e) => {
          this.controls.enabled = !(e as unknown as { value: boolean }).value;
        });
        t.addEventListener("mouseDown", () => {
          const record = this.selectedRecord;
          this.dragStart = record ? { ...record } : null;
        });
        t.addEventListener("objectChange", () => {
          this.syncRecordFromObject();
          this.events.onChange?.();
        });
        t.addEventListener("mouseUp", () => {
          const before = this.dragStart;
          this.dragStart = null;
          if (before) this.pushUndo(before);
        });
        this.transform = t;
        this.applyGizmoSettings();
        return t;
      },
    );
    return this.transformLoad;
  }

  private applyGizmoSettings(): void {
    const t = this.transform;
    if (!t) return;
    t.setMode(this.mode);
    // Snapping keeps hand placement aligned with the CELL grid the generator
    // uses, so authored props sit flush against procedural masonry.
    t.setTranslationSnap(this.snap ? 0.5 : null);
    t.setRotationSnap(this.snap ? Math.PI / 12 : null);
    t.setScaleSnap(this.snap ? 0.1 : null);
  }

  setMode(mode: GizmoMode): void {
    this.mode = mode;
    this.applyGizmoSettings();
  }

  getMode(): GizmoMode {
    return this.mode;
  }

  setSnap(on: boolean): void {
    this.snap = on;
    this.applyGizmoSettings();
  }

  getSnap(): boolean {
    return this.snap;
  }

  private pushUndo(before: PlacementRecord): void {
    const uid = before.uid;
    this.undoStack.push(() => {
      const entry = this.placed.get(uid);
      if (!entry) return;
      entry.object.position.fromArray(before.position);
      entry.object.rotation.fromArray(before.rotation);
      entry.object.scale.fromArray(before.scale);
      entry.record.position = [...before.position];
      entry.record.rotation = [...before.rotation];
      entry.record.scale = [...before.scale];
    });
    if (this.undoStack.length > 64) this.undoStack.shift();
  }

  undo(): boolean {
    const step = this.undoStack.pop();
    if (!step) return false;
    step();
    this.events.onChange?.();
    return true;
  }

  private syncRecordFromObject(): void {
    const uid = this.selectedUid;
    if (!uid) return;
    const entry = this.placed.get(uid);
    if (!entry) return;
    entry.record.position = entry.object.position.toArray() as [number, number, number];
    entry.record.rotation = [
      entry.object.rotation.x, entry.object.rotation.y, entry.object.rotation.z,
    ];
    entry.record.scale = entry.object.scale.toArray() as [number, number, number];
  }

  /** Instantiate an asset and attach the gizmo to it. */
  async place(
    asset: AssetDef,
    at: THREE.Vector3,
    restore?: PlacementRecord,
  ): Promise<PlacementRecord> {
    const object = await asset.build();
    const uid = restore?.uid ?? nextUid();
    object.name = restore?.name ?? `${asset.id}-${uid}`;
    if (restore) {
      object.position.fromArray(restore.position);
      object.rotation.fromArray(restore.rotation);
      object.scale.fromArray(restore.scale);
    } else {
      object.position.copy(at);
      const s = asset.scale ?? 1;
      object.scale.setScalar(s);
    }
    object.userData.editorAsset = asset.id;
    object.userData.editorUid = uid;
    this.group.add(object);
    const record: PlacementRecord = restore ?? {
      uid,
      assetId: asset.id,
      name: object.name,
      position: object.position.toArray() as [number, number, number],
      rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
      scale: object.scale.toArray() as [number, number, number],
    };
    this.placed.set(uid, { record, object, asset });
    if (!restore) await this.select(uid);
    this.events.onChange?.();
    return record;
  }

  async select(uid: string | null): Promise<void> {
    this.selectedUid = uid;
    const entry = uid ? this.placed.get(uid) : null;
    if (!entry) {
      this.transform?.detach();
    } else {
      const t = await this.ensureTransform();
      if (this.selectedUid !== uid) return; // selection changed while loading
      t.attach(entry.object);
    }
    this.events.onSelect?.(uid);
  }

  remove(uid: string): void {
    const entry = this.placed.get(uid);
    if (!entry) return;
    if (this.selectedUid === uid) {
      this.transform?.detach();
      this.selectedUid = null;
      this.events.onSelect?.(null);
    }
    this.group.remove(entry.object);
    disposeGraph(entry.object);
    this.placed.delete(uid);
    this.events.onChange?.();
  }

  clear(): void {
    for (const uid of [...this.placed.keys()]) this.remove(uid);
    this.undoStack.length = 0;
  }

  /** Duplicate the selection, offset by one snap step so it is visible. */
  async duplicate(): Promise<void> {
    const entry = this.selectedUid ? this.placed.get(this.selectedUid) : null;
    if (!entry) return;
    const at = entry.object.position.clone().add(new THREE.Vector3(2, 0, 2));
    const clone = await this.place(entry.asset, at);
    const object = this.placed.get(clone.uid)?.object;
    if (object) {
      object.rotation.copy(entry.object.rotation);
      object.scale.copy(entry.object.scale);
      this.syncRecordFromObject();
    }
  }

  /** Click-to-select. Returns true when the ray hit a placed prop, so the
   *  caller can leave orbit/camera handling alone otherwise. */
  pickAt(ndc: THREE.Vector2): boolean {
    if (this.placed.size === 0) return false;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera as THREE.PerspectiveCamera);
    const hits = raycaster.intersectObject(this.group, true);
    const hit = hits[0];
    if (!hit) return false;
    let node: THREE.Object3D | null = hit.object;
    while (node && node.userData.editorUid === undefined) node = node.parent;
    const uid = node?.userData.editorUid as string | undefined;
    if (!uid) return false;
    void this.select(uid);
    return true;
  }

  setGizmoVisible(visible: boolean): void {
    const helper = this.scene.getObjectByName("editor-transform-gizmo");
    if (helper) helper.visible = visible;
    if (!visible) this.transform?.detach();
    else if (this.selectedUid) void this.select(this.selectedUid);
  }

  dispose(): void {
    this.clear();
    this.transform?.detach();
    this.transform?.dispose();
    this.scene.remove(this.group);
  }
}

function disposeGraph(root: THREE.Object3D): void {
  // Kit assets draw with the SHARED geometry/material singletons the whole
  // world uses. Disposing those when a placement is deleted would blank the
  // generated dungeon too, so shared graphs are dropped by reference only.
  if (root.userData.editorShared) return;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
}
