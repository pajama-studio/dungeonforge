// Lightweight dungeon population: one openable chest before every temple
// portal and a handful of deterministic sentinels on safe floor cells.
// Everything is instanced (five render objects total), so population scales
// with island count without multiplying draw calls.

import * as THREE from "three/webgpu";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { DX, DY, FLOOR, type Layout } from "../gen/dungeon";
import { CELL, TH } from "../config";
import type { Origin } from "./helpers";

interface ChestActor {
  key: string;
  x: number; y: number; z: number; yaw: number;
  open: number;
  target: number;
}

interface EnemyActor {
  x: number; y: number; z: number;
  yaw: number;
  phase: number;
  scale: number;
  bodyColor: number;
  eyeColor: number;
}

const MAX_CHESTS = 64;
const MAX_ENEMIES = 256;

export class DungeonActors {
  private chests: ChestActor[] = [];
  private enemies: EnemyActor[] = [];
  private opened = new Set<string>();
  private ray = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private m = new THREE.Matrix4();
  private m2 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private pos = new THREE.Vector3();
  private scale = new THREE.Vector3(1, 1, 1);
  private color = new THREE.Color();
  private axisX = new THREE.Vector3(1, 0, 0);
  private axisY = new THREE.Vector3(0, 1, 0);

  private chestBase: THREE.InstancedMesh;
  private chestLid: THREE.InstancedMesh;
  private chestBands: THREE.InstancedMesh;
  private enemyBodies: THREE.InstancedMesh;
  private enemyEyes: THREE.InstancedMesh;

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    private dom: HTMLElement,
  ) {
    // Pre-lit palette: these small props do not need the global 24-light
    // shader loop or shadow pass. That saves four forward-light pipelines.
    const wood = new THREE.MeshBasicMaterial({ color: 0x8a5129 });
    const iron = new THREE.MeshBasicMaterial({ color: 0xe0b65e });
    const baseGeo = new THREE.BoxGeometry(1.28, 0.66, 0.86);
    const lidGeo = new THREE.BoxGeometry(1.32, 0.3, 0.9);
    lidGeo.translate(0, 0, 0.45); // rear-edge hinge at local origin
    const bandGeo = new THREE.BoxGeometry(0.2, 0.72, 0.92);
    this.chestBase = this.instanced(baseGeo, wood, MAX_CHESTS, false);
    this.chestLid = this.instanced(lidGeo, wood, MAX_CHESTS, false);
    this.chestBands = this.instanced(bandGeo, iron, MAX_CHESTS, false);
    this.chestBase.name = "portal-chests";
    this.chestLid.name = "portal-chest-lids";

    const bodyParts: THREE.BufferGeometry[] = [];
    const cloak = new THREE.ConeGeometry(0.5, 1.5, 7);
    cloak.translate(0, 0.78, 0);
    bodyParts.push(cloak);
    const head = new THREE.SphereGeometry(0.32, 8, 6);
    head.translate(0, 1.63, 0);
    bodyParts.push(head);
    for (const side of [-1, 1]) {
      const horn = new THREE.ConeGeometry(0.1, 0.5, 5);
      horn.rotateZ(side * 0.45);
      horn.translate(side * 0.25, 1.98, 0);
      bodyParts.push(horn);
    }
    const bodyGeo = BufferGeometryUtils.mergeGeometries(bodyParts);
    for (const g of bodyParts) g.dispose();
    const bodyMat = new THREE.MeshBasicMaterial({ color: 0x20383e });
    this.enemyBodies = this.instanced(bodyGeo, bodyMat, MAX_ENEMIES, false);
    this.enemyBodies.name = "dungeon-sentinels";

    const eyeParts: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const eye = new THREE.SphereGeometry(0.055, 6, 4);
      eye.translate(side * 0.115, 1.68, 0.285);
      eyeParts.push(eye);
    }
    const eyeGeo = BufferGeometryUtils.mergeGeometries(eyeParts);
    for (const g of eyeParts) g.dispose();
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff5a32, toneMapped: false });
    this.enemyEyes = this.instanced(eyeGeo, eyeMat, MAX_ENEMIES, false);
    this.enemyEyes.name = "dungeon-sentinel-eyes";

    dom.addEventListener("pointerdown", this.onPointerDown);
  }

  private instanced(
    geo: THREE.BufferGeometry, mat: THREE.Material, capacity: number, shadows = true,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, mat, capacity);
    mesh.count = 0;
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    return mesh;
  }

  clear(): void {
    this.chests.length = 0;
    this.enemies.length = 0;
    this.syncCounts();
  }

  addIsland(l: Layout, o: Origin, slot: number): void {
    const center = (l.N - 1) / 2;
    if (l.door && this.chests.length < MAX_CHESTS) {
      const d = l.doorDir;
      const fx = DX[d], fz = DY[d], px = -fz, pz = fx;
      // Offset from the doorway centerline so it reads as a reward before the
      // portal without becoming a route blocker.
      const x = o.ox + (l.door.x - center + fx * 1.55 + px * 1.02) * CELL;
      const z = o.oz + (l.door.y - center + fz * 1.55 + pz * 1.02) * CELL;
      const y = o.oy + l.door.tier * TH + 0.16;
      const key = `${l.seed}:${slot}:${x.toFixed(2)}:${z.toFixed(2)}`;
      this.chests.push({ key, x, y, z, yaw: Math.atan2(fx, fz), open: this.opened.has(key) ? 1 : 0, target: this.opened.has(key) ? 1 : 0 });
    }

    const candidates: Array<{ x: number; y: number; h: number }> = [];
    for (let y = 2; y < l.N - 2; y++) for (let x = 2; x < l.N - 2; x++) {
      const c = y * l.N + x;
      if (l.kind[c] !== FLOOR || l.stairMask[c] || l.templeMask[c] || l.plazaMask[c]) continue;
      if (l.support[c] !== l.tier[c]) continue;
      if (Math.max(Math.abs(x - l.entrance.x), Math.abs(y - l.entrance.y)) < 5) continue;
      if (l.verticalAnchors.some((a) => Math.max(Math.abs(a.x - x), Math.abs(a.y - y)) < 5)) continue;
      if (l.medallions.some((m) => Math.hypot(m.x - x, m.y - y) < m.r + 3)) continue;
      if (l.door && Math.max(Math.abs(l.door.x - x), Math.abs(l.door.y - y)) < 6) continue;
      const h = this.hash(l.seed, c, 0x71);
      candidates.push({ x, y, h });
    }
    candidates.sort((a, b) => a.h - b.h);
    const role = l.params.narrativeRole;
    const roleCount = role === "ossuary" || role === "forge" ? 4
      : role === "sanctum" ? 3 : role === "archive" ? 2 : 3;
    const count = Math.min(5, roleCount + Math.floor(this.hash(l.seed, slot, 0x72) * 2));
    const palette: Record<string, [number, number]> = {
      threshold: [0x334247, 0xff6a32], archive: [0x29434d, 0x59cfff],
      ossuary: [0x77786b, 0xff4938], forge: [0x352b29, 0xff8a24],
      pilgrim: [0x514633, 0xffc95b], overgrowth: [0x284236, 0x82e05d],
      sanctum: [0x43546a, 0x62a7ff],
    };
    const [bodyColor, eyeColor] = palette[role ?? "threshold"];
    const chosen: typeof candidates = [];
    for (const c of candidates) {
      if (chosen.length >= count || this.enemies.length >= MAX_ENEMIES) break;
      if (chosen.some((p) => Math.max(Math.abs(p.x - c.x), Math.abs(p.y - c.y)) < 6)) continue;
      chosen.push(c);
      const idx = c.y * l.N + c.x;
      this.enemies.push({
        x: o.ox + (c.x - center) * CELL,
        y: o.oy + l.tier[idx] * TH + 0.12,
        z: o.oz + (c.y - center) * CELL,
        yaw: this.hash(l.seed, idx, 0x73) * Math.PI * 2,
        phase: this.hash(l.seed, idx, 0x74) * Math.PI * 2,
        scale: 0.86 + this.hash(l.seed, idx, 0x75) * 0.25,
        bodyColor,
        eyeColor,
      });
    }
    this.syncCounts();
    this.updateMatrices(0);
  }

  tick(t: number, dt: number): void {
    let chestChanged = false;
    for (const c of this.chests) {
      const next = c.open + (c.target - c.open) * Math.min(1, dt * 8);
      if (Math.abs(next - c.open) > 0.0001) chestChanged = true;
      c.open = next;
    }
    this.updateMatrices(t, chestChanged);
  }

  private updateMatrices(t: number, forceChests = true): void {
    if (forceChests) {
      for (let i = 0; i < this.chests.length; i++) {
        const c = this.chests[i];
        this.q.setFromAxisAngle(this.axisY, c.yaw);
        this.pos.set(c.x, c.y + 0.34, c.z);
        this.m.compose(this.pos, this.q, this.scale);
        this.chestBase.setMatrixAt(i, this.m);
        this.chestBands.setMatrixAt(i, this.m);

        // T * yaw * hinge-rotation. Lid geometry is translated from its rear
        // edge, so opening is a real pivot rather than a floating box.
        const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
        this.m.makeTranslation(c.x - fx * 0.45, c.y + 0.67, c.z - fz * 0.45);
        this.m2.makeRotationY(c.yaw);
        this.m.multiply(this.m2);
        this.m2.makeRotationX(-c.open * 1.28);
        this.m.multiply(this.m2);
        this.chestLid.setMatrixAt(i, this.m);
      }
      this.chestBase.instanceMatrix.needsUpdate = true;
      this.chestBands.instanceMatrix.needsUpdate = true;
      this.chestLid.instanceMatrix.needsUpdate = true;
    }
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      const bob = Math.sin(t * 1.7 + e.phase) * 0.11;
      this.pos.set(e.x, e.y + bob, e.z);
      this.q.setFromAxisAngle(this.axisY, e.yaw + Math.sin(t * 0.42 + e.phase) * 0.24);
      this.scale.setScalar(e.scale);
      this.m.compose(this.pos, this.q, this.scale);
      this.enemyBodies.setMatrixAt(i, this.m);
      this.enemyEyes.setMatrixAt(i, this.m);
      this.enemyBodies.setColorAt(i, this.color.setHex(e.bodyColor));
      this.enemyEyes.setColorAt(i, this.color.setHex(e.eyeColor));
    }
    this.scale.set(1, 1, 1);
    this.enemyBodies.instanceMatrix.needsUpdate = true;
    this.enemyEyes.instanceMatrix.needsUpdate = true;
    if (this.enemyBodies.instanceColor) this.enemyBodies.instanceColor.needsUpdate = true;
    if (this.enemyEyes.instanceColor) this.enemyEyes.instanceColor.needsUpdate = true;
  }

  private syncCounts(): void {
    this.chestBase.count = this.chestLid.count = this.chestBands.count = this.chests.length;
    this.enemyBodies.count = this.enemyEyes.count = this.enemies.length;
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.chests.length === 0) return;
    const rect = this.dom.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.ray.setFromCamera(this.pointer, this.camera);
    const hits = this.ray.intersectObjects([this.chestLid, this.chestBase], false);
    const id = hits[0]?.instanceId;
    if (id === undefined || !this.chests[id]) return;
    const chest = this.chests[id];
    chest.target = 1;
    this.opened.add(chest.key);
  };

  private hash(seed: number, a: number, salt: number): number {
    let x = (seed ^ Math.imul(a + 1, 0x9e3779b1) ^ salt) >>> 0;
    x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16;
    return (x >>> 0) / 0x100000000;
  }
}
