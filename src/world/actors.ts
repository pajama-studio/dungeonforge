// Lightweight dungeon population: one openable chest before every temple
// portal and a handful of deterministic sentinels on safe floor cells.
// Everything is instanced (five render objects total), so population scales
// with island count without multiplying draw calls.

import * as THREE from "three/webgpu";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { hash, instanceIndex, positionLocal, sin, time, vec3 } from "three/tsl";
import { DX, DY, FLOOR, type Layout } from "../gen/dungeon";
import { CELL, TH } from "../config";
import type { GroundSampler } from "../player/player";
import type { Origin } from "./helpers";

interface ChestActor {
  key: string;
  x: number; y: number; z: number; yaw: number;
  open: number;
  target: number;
}

interface EnemyActor {
  x: number; y: number; z: number;
  spawnX: number; spawnY: number; spawnZ: number;
  yaw: number;
  phase: number;
  baseScale: number;
  scale: number;
  bodyColor: number;
  eyeColor: number;
  hp: number;
  active: boolean;
  attackCooldown: number;
  hitFlash: number;
  slot: number;
  rank: number;
  elite: boolean;
}

export interface CombatStep {
  playerDamage: number;
  kills: number;
  eliteKills: number;
  hit: boolean;
}

const MAX_CHESTS = 64;
const MAX_ENEMIES = 256;

export class DungeonActors {
  private chests: ChestActor[] = [];
  private enemies: EnemyActor[] = [];
  private opened = new Set<string>();
  private pendingOpened: string[] = [];
  private gameFloor = 0;
  private enemyDirty = true;
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
    bodyGeo.setAttribute("color", new THREE.BufferAttribute(
      new Float32Array(bodyGeo.getAttribute("position").count * 3).fill(1), 3,
    ));
    // One shared unlit pipeline for bodies + eyes. Idle bob lives in the
    // vertex shader, so distant stationary enemies do not force matrix/color
    // buffer uploads every frame.
    const enemyMat = new THREE.MeshBasicNodeMaterial({ vertexColors: true });
    const enemyPhase = hash(instanceIndex.toFloat().add(0.417)).mul(6.2832);
    enemyMat.positionNode = positionLocal.add(vec3(0, sin(time.mul(1.7).add(enemyPhase)).mul(0.11), 0));
    this.enemyBodies = this.instanced(bodyGeo, enemyMat, MAX_ENEMIES, false);
    this.enemyBodies.name = "dungeon-sentinels";

    const eyeParts: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const eye = new THREE.SphereGeometry(0.055, 6, 4);
      eye.translate(side * 0.115, 1.68, 0.285);
      eyeParts.push(eye);
    }
    const eyeGeo = BufferGeometryUtils.mergeGeometries(eyeParts);
    for (const g of eyeParts) g.dispose();
    eyeGeo.setAttribute("color", new THREE.BufferAttribute(
      new Float32Array(eyeGeo.getAttribute("position").count * 3).fill(1), 3,
    ));
    this.enemyEyes = this.instanced(eyeGeo, enemyMat, MAX_ENEMIES, false);
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
    this.enemyDirty = true;
    this.syncCounts();
  }

  resetLoot(): void {
    this.opened.clear();
    this.pendingOpened.length = 0;
    for (const chest of this.chests) chest.open = chest.target = 0;
  }

  /** Reset deterministic sentinels for one roguelike floor. Returns the live
   * count so the pure run state and render adapter share one source of truth. */
  beginFloor(floor: number): number {
    this.gameFloor = Math.max(1, floor | 0);
    const desired = Math.min(this.enemies.length, 12 + this.gameFloor * 4);
    const selected = new Set<EnemyActor>();
    const ranked = [...this.enemies].sort((a, b) => a.rank - b.rank);
    const usedSlots = new Set<number>();
    // One encounter per block first, then fill the remaining budget by rank.
    // This keeps exploration spatially broad without requiring 70+ kills.
    for (const e of ranked) {
      if (selected.size >= desired) break;
      if (usedSlots.has(e.slot)) continue;
      selected.add(e); usedSlots.add(e.slot);
    }
    for (const e of ranked) {
      if (selected.size >= desired) break;
      selected.add(e);
    }
    const eliteActor = this.gameFloor % 3 === 0
      ? ranked.find((candidate) => selected.has(candidate))
      : undefined;
    for (const e of this.enemies) {
      const elite = e === eliteActor;
      e.x = e.spawnX; e.y = e.spawnY; e.z = e.spawnZ;
      e.elite = elite;
      e.scale = e.baseScale * (elite ? 1.5 : 1);
      e.hp = (1.6 + this.gameFloor * 0.65 + e.baseScale * 0.35) * (elite ? 2.75 : 1);
      e.active = selected.has(e);
      e.attackCooldown = 0.35 + e.phase % 0.55;
      e.hitFlash = 0;
    }
    this.enemyDirty = true;
    this.updateMatrices(0);
    return this.aliveCount;
  }

  get aliveCount(): number {
    let n = 0;
    for (const e of this.enemies) if (e.active) n++;
    return n;
  }

  get enemyCount(): number { return this.enemies.length; }

  /** Fixed render-object inventory used by startup pacing. Returning the
   * meshes rather than their mutable actor data lets the boot stream hide and
   * reveal one shared batch at a time; gameplay updates keep writing the same
   * instance buffers while a batch is temporarily invisible. */
  startupRenderables(): readonly THREE.Object3D[] {
    return [
      this.chestBase,
      this.chestLid,
      this.chestBands,
      this.enemyBodies,
      this.enemyEyes,
    ];
  }

  get eliteCount(): number {
    let n = 0;
    for (const e of this.enemies) if (e.active && e.elite) n++;
    return n;
  }

  /** One allocation-free enemy AI/combat step. Attack is an edge-triggered
   * player swing; movement uses the same analytic ground sampler as the hero,
   * so sentinels cannot chase through walls, pillars or into the void. */
  stepCombat(
    dt: number,
    player: THREE.Vector3,
    ground: GroundSampler,
    attackDamage: number,
    attack: boolean,
  ): CombatStep {
    const result: CombatStep = { playerDamage: 0, kills: 0, eliteKills: 0, hit: false };
    if (attack) {
      let target: EnemyActor | null = null;
      let targetD = 2.65;
      for (const e of this.enemies) {
        if (!e.active || Math.abs(e.y - player.y) > 1.8) continue;
        const d = Math.hypot(e.x - player.x, e.z - player.z);
        if (d < targetD) { targetD = d; target = e; }
      }
      if (target) {
        target.hp -= Math.max(0.25, attackDamage);
        target.hitFlash = 0.16;
        this.enemyDirty = true;
        result.hit = true;
        if (target.hp <= 0) {
          target.active = false;
          result.kills = 1;
          result.eliteKills = target.elite ? 1 : 0;
          this.enemyDirty = true;
        }
      }
    }

    const speed = Math.min(3.8, 1.65 + this.gameFloor * 0.14);
    for (const e of this.enemies) {
      if (!e.active) continue;
      e.attackCooldown -= dt;
      if (e.hitFlash > 0) {
        e.hitFlash = Math.max(0, e.hitFlash - dt);
        this.enemyDirty = true;
      }
      const dx = player.x - e.x, dz = player.z - e.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 9.5 || Math.abs(player.y - e.y) > 2.0) continue;
      if (dist > 1.35) {
        const step = Math.min(dist - 1.2, speed * dt);
        const nx = e.x + dx / dist * step, nz = e.z + dz / dist * step;
        const g = ground(nx, nz, e.y);
        if (g.ok && Math.abs(g.y - e.y) < 1.35) {
          e.x = nx; e.z = nz; e.y += (g.y - e.y) * Math.min(1, dt * 12);
          e.yaw = Math.atan2(dx, dz);
          this.enemyDirty = true;
        }
      } else if (e.attackCooldown <= 0) {
        result.playerDamage += (5 + this.gameFloor * 1.25) * (e.elite ? 1.6 : 1);
        e.attackCooldown = Math.max(0.52, 1.02 - this.gameFloor * 0.025);
      }
    }
    return result;
  }

  /** Open the closest chest with E. Pointer opening uses the same queue, so
   * rewards are granted exactly once regardless of input method. */
  interact(player: THREE.Vector3, radius = 2.8): string | null {
    let nearest: ChestActor | null = null;
    let best = radius;
    for (const chest of this.chests) {
      if (chest.target > 0 || Math.abs(chest.y - player.y) > 1.8) continue;
      const d = Math.hypot(chest.x - player.x, chest.z - player.z);
      if (d < best) { best = d; nearest = chest; }
    }
    return nearest ? this.openChest(nearest) : null;
  }

  consumeOpenedChests(): string[] {
    if (this.pendingOpened.length === 0) return [];
    return this.pendingOpened.splice(0);
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
      const x = o.ox + (c.x - center) * CELL;
      const y = o.oy + l.tier[idx] * TH + 0.12;
      const z = o.oz + (c.y - center) * CELL;
      const scale = 0.86 + this.hash(l.seed, idx, 0x75) * 0.25;
      this.enemies.push({
        x, y, z, spawnX: x, spawnY: y, spawnZ: z,
        yaw: this.hash(l.seed, idx, 0x73) * Math.PI * 2,
        phase: this.hash(l.seed, idx, 0x74) * Math.PI * 2,
        baseScale: scale,
        scale,
        bodyColor,
        eyeColor,
        hp: 1,
        active: true,
        attackCooldown: 0,
        hitFlash: 0,
        slot,
        rank: this.hash(l.seed, idx, 0x76),
        elite: false,
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
    this.updateMatrices(t, chestChanged, this.enemyDirty);
    this.enemyDirty = false;
  }

  private updateMatrices(t: number, forceChests = true, forceEnemies = true): void {
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
    if (forceEnemies) {
      let renderedEnemies = 0;
      for (const e of this.enemies) {
        if (!e.active) continue;
        this.pos.set(e.x, e.y, e.z);
        this.q.setFromAxisAngle(this.axisY, e.yaw);
        this.scale.setScalar(e.scale);
        this.m.compose(this.pos, this.q, this.scale);
        this.enemyBodies.setMatrixAt(renderedEnemies, this.m);
        this.enemyEyes.setMatrixAt(renderedEnemies, this.m);
        this.enemyBodies.setColorAt(renderedEnemies, this.color.setHex(
          e.hitFlash > 0 ? 0xffe0a6 : e.elite ? 0x8b7044 : e.bodyColor,
        ));
        this.enemyEyes.setColorAt(renderedEnemies, this.color.setHex(e.elite ? 0xffd35a : e.eyeColor));
        renderedEnemies++;
      }
      this.enemyBodies.count = this.enemyEyes.count = renderedEnemies;
      this.scale.set(1, 1, 1);
      this.enemyBodies.instanceMatrix.needsUpdate = true;
      this.enemyEyes.instanceMatrix.needsUpdate = true;
      if (this.enemyBodies.instanceColor) this.enemyBodies.instanceColor.needsUpdate = true;
      if (this.enemyEyes.instanceColor) this.enemyEyes.instanceColor.needsUpdate = true;
    }
  }

  private syncCounts(): void {
    this.chestBase.count = this.chestLid.count = this.chestBands.count = this.chests.length;
    this.enemyBodies.count = this.enemyEyes.count = this.aliveCount;
  }

  private openChest(chest: ChestActor): string | null {
    if (chest.target > 0 || this.opened.has(chest.key)) return null;
    chest.target = 1;
    this.opened.add(chest.key);
    this.pendingOpened.push(chest.key);
    return chest.key;
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
    this.openChest(this.chests[id]);
  };

  private hash(seed: number, a: number, salt: number): number {
    let x = (seed ^ Math.imul(a + 1, 0x9e3779b1) ^ salt) >>> 0;
    x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16;
    return (x >>> 0) / 0x100000000;
  }
}
