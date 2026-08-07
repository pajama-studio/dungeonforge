// Fixed-capacity GPU masonry debris. CPU work ends after choosing a hit,
// hiding one static instance and writing spawn commands. Gravity, tumbling,
// collision and lifetime are advanced by one WebGPU compute dispatch.

import * as THREE from "three/webgpu";
import {
  Fn, If, color, hash, instanceIndex, instancedArray, positionGeometry,
  step, uniform, vec3,
} from "three/tsl";
import { CELL, COURSE, TH } from "../config";
import { FLOOR } from "../gen/dungeon";
import { getKit } from "../scene/kit";
import { masonryMeshes } from "../scene/slots";
import type { MasonryBreachCell, MasonryStructureData } from "../scene/build";

const DEBRIS_CAPACITY = 768;
const FRAGMENTS_PER_HIT = 8;
const BREACH_CAPACITY = 96;
const PARK_Y = -1800;

interface DestructionStats {
  impacts: number;
  spawned: number;
  capacity: number;
  breaches: number;
  computeFrames: number;
  lastRaycastMs: number;
}

const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _hidden = new THREE.Matrix4().makeScale(0.001, 0.001, 0.001).setPosition(0, PARK_Y, 0);
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _rotation = new THREE.Euler();
const _scale = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _axisX = new THREE.Vector3();
const _axisY = new THREE.Vector3();
const _axisZ = new THREE.Vector3();
const _color = new THREE.Color();
const _patchColor = new THREE.Color(0.44, 0.39, 0.31);
const _groundPoint = new THREE.Vector3();

function fract(v: number): number { return v - Math.floor(v); }
function noise(seed: number): number { return fract(Math.sin(seed * 12.9898 + 78.233) * 43758.5453); }

export class GpuDestruction {
  readonly mesh: THREE.InstancedMesh;
  readonly breachMesh: THREE.InstancedMesh;
  readonly stats: DestructionStats = {
    impacts: 0, spawned: 0, capacity: DEBRIS_CAPACITY, breaches: 0,
    computeFrames: 0, lastRaycastMs: 0,
  };

  enabled = false;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly dtNode = uniform(0);
  // Compute nodes are intentionally stored as opaque nodes. three/tsl's
  // generated node type is very large and is not part of its stable TS API.
  private readonly computeNode: any;
  private readonly statePosition: any;
  private readonly stateVelocity: any;
  private readonly stateRotation: any;
  private readonly stateScale: any;
  private readonly spawnPosition: any;
  private readonly spawnVelocity: any;
  private readonly spawnRotation: any;
  private readonly spawnScale: any;
  private destroyed = new WeakMap<THREE.InstancedMesh, Set<number>>();
  private readonly down = new THREE.Vector2();
  private downAt = 0;
  private cursor = 0;
  private version = 0;
  private breachCursor = 0;
  private activeUntil = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly renderer: THREE.WebGPURenderer,
    private readonly canvas: HTMLCanvasElement,
    private readonly onTopologyChanged: () => void,
  ) {
    const makeState = () => {
      const data = new Float32Array(DEBRIS_CAPACITY * 4);
      for (let i = 0; i < DEBRIS_CAPACITY; i++) data[i * 4 + 1] = PARK_Y;
      return instancedArray(data, "vec4");
    };
    this.statePosition = makeState();       // xyz position, w lifetime
    this.stateVelocity = instancedArray(DEBRIS_CAPACITY, "vec4"); // xyz velocity, w ground
    this.stateRotation = instancedArray(DEBRIS_CAPACITY, "vec4"); // xyz euler, w stone tone
    this.stateScale = instancedArray(DEBRIS_CAPACITY, "vec4");    // xyz size, w command version
    this.spawnPosition = instancedArray(DEBRIS_CAPACITY, "vec4");
    this.spawnVelocity = instancedArray(DEBRIS_CAPACITY, "vec4");
    this.spawnRotation = instancedArray(DEBRIS_CAPACITY, "vec4");
    this.spawnScale = instancedArray(DEBRIS_CAPACITY, "vec4");

    const dt = this.dtNode;
    const statePosition = this.statePosition;
    const stateVelocity = this.stateVelocity;
    const stateRotation = this.stateRotation;
    const stateScale = this.stateScale;
    const spawnPosition = this.spawnPosition;
    const spawnVelocity = this.spawnVelocity;
    const spawnRotation = this.spawnRotation;
    const spawnScale = this.spawnScale;

    this.computeNode = Fn(() => {
      const p = statePosition.element(instanceIndex);
      const v = stateVelocity.element(instanceIndex);
      const r = stateRotation.element(instanceIndex);
      const s = stateScale.element(instanceIndex);
      const spawnS = spawnScale.element(instanceIndex);

      If(spawnS.w.greaterThan(s.w), () => {
        p.assign(spawnPosition.element(instanceIndex));
        v.assign(spawnVelocity.element(instanceIndex));
        r.assign(spawnRotation.element(instanceIndex));
        s.assign(spawnS);
      }).ElseIf(p.w.greaterThan(0), () => {
        v.y.subAssign(dt.mul(19.5));
        p.xyz.addAssign(v.xyz.mul(dt));
        // A stable per-slot angular vector removes another writable buffer.
        const spin = hash(instanceIndex.toFloat().add(0.37)).mul(2).add(0.55);
        r.xyz.addAssign(vec3(spin.mul(1.7), spin.mul(2.3), spin.mul(1.1)).mul(dt));
        v.xz.mulAssign(dt.mul(-0.35).exp());

        If(p.y.lessThan(v.w), () => {
          p.y.assign(v.w);
          If(v.y.lessThan(-0.5), () => {
            v.y.assign(v.y.negate().mul(0.36));
          }).Else(() => {
            v.y.assign(0);
          });
          v.xz.mulAssign(0.7);
        });

        p.w.subAssign(dt);
        If(p.w.lessThanEqual(0), () => {
          p.xyz.assign(vec3(0, PARK_Y, 0));
          p.w.assign(0);
          v.xyz.assign(vec3(0));
        });
      });
    })().compute(DEBRIS_CAPACITY);

    const material = new THREE.MeshBasicNodeMaterial({ vertexColors: true });
    const p = this.statePosition.toAttribute();
    const r = this.stateRotation.toAttribute();
    const s = this.stateScale.toAttribute();
    const alive = step(0.001, p.w);
    let q = positionGeometry.mul(s.xyz).mul(alive);
    const cx = r.x.cos(), sx = r.x.sin();
    q = vec3(q.x, q.y.mul(cx).sub(q.z.mul(sx)), q.y.mul(sx).add(q.z.mul(cx)));
    const cy = r.y.cos(), sy = r.y.sin();
    q = vec3(q.x.mul(cy).add(q.z.mul(sy)), q.y, q.z.mul(cy).sub(q.x.mul(sy)));
    const cz = r.z.cos(), sz = r.z.sin();
    q = vec3(q.x.mul(cz).sub(q.y.mul(sz)), q.x.mul(sz).add(q.y.mul(cz)), q.z);
    material.positionNode = q.add(p.xyz);
    material.colorNode = color(0xa89168)
      .mul(hash(instanceIndex.toFloat().add(4.7)).mul(0.18).add(0.82))
      .mul(r.w);

    this.mesh = new THREE.InstancedMesh(getKit().blockGeoLo, material, DEBRIS_CAPACITY);
    this.mesh.name = "gpu-masonry-debris";
    this.mesh.count = DEBRIS_CAPACITY;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 2;
    this.scene.add(this.mesh);

    // A breached wall becomes a real floor cell. This fixed patch pool gives
    // it a visible stone surface without allocating or growing GPU buffers.
    this.breachMesh = new THREE.InstancedMesh(getKit().tileGeoLo, getKit().stoneMat, BREACH_CAPACITY);
    this.breachMesh.name = "destruction-breach-floors";
    this.breachMesh.setMatrixAt(0, _hidden);
    this.breachMesh.setColorAt(0, _patchColor);
    this.breachMesh.count = 1; // parked warm-up instance; reset on first token
    this.breachMesh.frustumCulled = false;
    this.breachMesh.castShadow = false;
    this.breachMesh.receiveShadow = true;
    this.scene.add(this.breachMesh);

    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.canvas.classList.toggle("break-mode", on);
  }

  toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  /** Compile the compute pipeline before the loading veil lifts. */
  async warmup(): Promise<void> {
    this.dtNode.value = 0;
    await this.renderer.computeAsync(this.computeNode);
  }

  tick(dt: number): void {
    if (!this.mesh.visible) return;
    if (performance.now() > this.activeUntil) {
      this.queueExpireAll();
      this.mesh.visible = false;
      return;
    }
    this.dtNode.value = Math.min(dt, 1 / 30);
    this.renderer.compute(this.computeNode);
    this.stats.computeFrames++;
  }

  /** A re-forge rewrites all static instance buffers. Expire every live GPU
   * fragment and forget the old instance ids in the same generation turn. */
  reset(): void {
    this.destroyed = new WeakMap<THREE.InstancedMesh, Set<number>>();
    this.queueExpireAll();
    this.cursor = 0;
    this.breachCursor = 0;
    this.activeUntil = 0;
    this.mesh.visible = false;
    this.breachMesh.count = 0;
    this.breachMesh.visible = false;
  }

  private queueExpireAll(): void {
    const version = ++this.version;
    const pos = this.spawnPosition.value.array as Float32Array;
    const scale = this.spawnScale.value.array as Float32Array;
    for (let i = 0; i < DEBRIS_CAPACITY; i++) {
      pos[i * 4 + 3] = 0;
      scale[i * 4 + 3] = version;
    }
    this.spawnPosition.value.needsUpdate = true;
    this.spawnScale.value.needsUpdate = true;
  }

  blastClientPoint(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.scene.updateMatrixWorld(true);

    const targets = masonryMeshes();
    const savedCounts = targets.map((mesh) => mesh.count);
    const start = performance.now();
    try {
      // The visible twin may currently be low-detail or transparent. Raycast
      // the source's full logical count without changing any GPU capacity.
      for (const mesh of targets) mesh.count = (mesh.userData as { n?: number }).n ?? 0;
      const hits = this.raycaster.intersectObjects(targets, false);
      for (const hit of hits) {
        if (hit.instanceId === undefined) continue;
        const mesh = hit.object as THREE.InstancedMesh;
        const gone = this.destroyed.get(mesh);
        if (gone?.has(hit.instanceId)) continue;
        const structure = (mesh.userData as { masonry?: MasonryStructureData }).masonry;
        const breach = structure?.byInstance.get(hit.instanceId);
        this.breakInstance(mesh, hit.instanceId, hit);
        // One impact into a legitimate passage band collapses the remaining
        // head-height courses in that same cell. It reads as a local breach,
        // not as three unrelated precision clicks.
        if (breach && !breach.opened) {
          for (const companionId of breach.required) {
            if (companionId === hit.instanceId || this.destroyed.get(mesh)?.has(companionId)) continue;
            mesh.getMatrixAt(companionId, _local);
            _world.multiplyMatrices(mesh.matrixWorld, _local);
            const companionPoint = new THREE.Vector3().setFromMatrixPosition(_world);
            this.breakInstance(mesh, companionId, {
              ...hit, instanceId: companionId, point: companionPoint,
            });
          }
        }
        this.stats.lastRaycastMs = performance.now() - start;
        return true;
      }
    } finally {
      for (let i = 0; i < targets.length; i++) targets[i].count = savedCounts[i];
    }
    this.stats.lastRaycastMs = performance.now() - start;
    return false;
  }

  private breakInstance(
    mesh: THREE.InstancedMesh,
    instanceId: number,
    hit: THREE.Intersection,
  ): void {
    mesh.getMatrixAt(instanceId, _local);
    const localCourseY = _local.elements[13];
    _world.multiplyMatrices(mesh.matrixWorld, _local);
    _world.decompose(_position, _quaternion, _scale);
    _rotation.setFromQuaternion(_quaternion, "XYZ");
    mesh.getColorAt(instanceId, _color);

    _normal.copy(hit.face?.normal ?? new THREE.Vector3(0, 1, 0)).transformDirection(_world);
    if (_normal.dot(this.raycaster.ray.direction) > 0) _normal.negate();
    _axisX.set(1, 0, 0).applyQuaternion(_quaternion);
    _axisY.set(0, 1, 0).applyQuaternion(_quaternion);
    _axisZ.set(0, 0, 1).applyQuaternion(_quaternion);

    let gone = this.destroyed.get(mesh);
    if (!gone) { gone = new Set(); this.destroyed.set(mesh, gone); }
    gone.add(instanceId);
    mesh.setMatrixAt(instanceId, _hidden);
    mesh.instanceMatrix.needsUpdate = true; // shared by high/low/faded twins

    // Quantize in ISLAND-LOCAL height, then transform back to world. Using a
    // global TH grid made debris hover or sink on islands with a random oy.
    const localGroundY = Math.floor((localCourseY + 0.12) / TH) * TH + COURSE * 0.22;
    const groundY = _groundPoint.set(0, localGroundY, 0).applyMatrix4(mesh.matrixWorld).y;
    const tone = Math.max(0.62, Math.min(1.25, (_color.r + _color.g + _color.b) / 1.65));
    const impactSeed = (++this.stats.impacts * 131 + instanceId * 17) >>> 0;
    for (let i = 0; i < FRAGMENTS_PER_HIT; i++) {
      const nx = noise(impactSeed + i * 7) - 0.5;
      const ny = noise(impactSeed + i * 11 + 1) - 0.35;
      const nz = noise(impactSeed + i * 17 + 2) - 0.5;
      const shardPos = _position.clone()
        .addScaledVector(_axisX, nx * _scale.x * 1.2)
        .addScaledVector(_axisY, ny * _scale.y * 0.7)
        .addScaledVector(_axisZ, nz * _scale.z * 1.2);
      const side = new THREE.Vector3(nx, Math.abs(ny) + 0.22, nz).normalize();
      const velocity = _normal.clone().multiplyScalar(2.8 + noise(impactSeed + i * 23) * 4.5)
        .addScaledVector(side, 2.5 + noise(impactSeed + i * 31) * 4.0);
      const shardScale = new THREE.Vector3(
        Math.min(1.7, _scale.x) * (0.22 + noise(impactSeed + i * 37) * 0.2),
        Math.min(1.7, _scale.y) * (0.28 + noise(impactSeed + i * 41) * 0.22),
        Math.min(1.7, _scale.z) * (0.22 + noise(impactSeed + i * 43) * 0.2),
      );
      this.spawn(
        shardPos, velocity, groundY,
        new THREE.Vector3(
          _rotation.x + nx * 1.8,
          _rotation.y + ny * 1.8,
          _rotation.z + nz * 1.8,
        ),
        shardScale,
        tone * (0.88 + noise(impactSeed + i * 47) * 0.2),
        5.5 + noise(impactSeed + i * 53) * 3.0,
      );
    }

    const structure = (mesh.userData as { masonry?: MasonryStructureData }).masonry;
    const breach = structure?.byInstance.get(instanceId);
    if (breach && !breach.opened) {
      breach.destroyed.add(instanceId);
      if (breach.required.every((id) => breach.destroyed.has(id))) this.openBreach(mesh, breach);
    }
  }

  private openBreach(mesh: THREE.InstancedMesh, breach: MasonryBreachCell): void {
    breach.opened = true;
    const { layout: l, cell } = breach;
    l.kind[cell] = FLOOR;
    l.tier[cell] = breach.floorTier;
    l.support[cell] = breach.floorTier;
    l.stats.floor++;
    l.stats.wall = Math.max(0, l.stats.wall - 1);

    const center = (l.N - 1) / 2;
    _local.makeTranslation(
      (breach.gx - center) * CELL,
      breach.floorTier * TH + 0.075,
      (breach.gy - center) * CELL,
    );
    _world.multiplyMatrices(mesh.matrixWorld, _local);
    const i = this.breachCursor;
    this.breachCursor = (this.breachCursor + 1) % BREACH_CAPACITY;
    this.breachMesh.setMatrixAt(i, _world);
    this.breachMesh.setColorAt(i, _patchColor);
    this.breachMesh.count = Math.min(BREACH_CAPACITY, Math.max(this.breachMesh.count, i + 1));
    this.breachMesh.visible = true;
    this.breachMesh.instanceMatrix.needsUpdate = true;
    if (this.breachMesh.instanceColor) this.breachMesh.instanceColor.needsUpdate = true;
    this.stats.breaches++;
    this.onTopologyChanged();
  }

  private spawn(
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    ground: number,
    rotation: THREE.Vector3,
    scale: THREE.Vector3,
    tone: number,
    life: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % DEBRIS_CAPACITY;
    const version = ++this.version;
    const o = i * 4;
    (this.spawnPosition.value.array as Float32Array).set([position.x, position.y, position.z, life], o);
    (this.spawnVelocity.value.array as Float32Array).set([velocity.x, velocity.y, velocity.z, ground], o);
    (this.spawnRotation.value.array as Float32Array).set([rotation.x, rotation.y, rotation.z, tone], o);
    (this.spawnScale.value.array as Float32Array).set([scale.x, scale.y, scale.z, version], o);
    this.spawnPosition.value.needsUpdate = true;
    this.spawnVelocity.value.needsUpdate = true;
    this.spawnRotation.value.needsUpdate = true;
    this.spawnScale.value.needsUpdate = true;
    this.stats.spawned++;
    this.activeUntil = Math.max(this.activeUntil, performance.now() + life * 1000 + 250);
    this.mesh.visible = true;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.down.set(event.clientX, event.clientY);
    this.downAt = performance.now();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.enabled && !event.shiftKey) return;
    if (performance.now() - this.downAt > 450) return;
    if (this.down.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 6) return;
    if (this.blastClientPoint(event.clientX, event.clientY)) event.preventDefault();
  };
}
