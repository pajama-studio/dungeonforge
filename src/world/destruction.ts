// Fixed-capacity GPU masonry debris. CPU work ends after choosing a hit,
// hiding one static instance and writing spawn commands. Gravity, tumbling,
// collision and lifetime are advanced by one WebGPU compute dispatch.

import * as THREE from "three/webgpu";
import {
  Fn, If, hash, instanceIndex, instancedArray,
  smoothstep, step, uniform, vec2, vec3,
} from "three/tsl";
import { CELL, COURSE, TH } from "../config";
import { FLOOR } from "../gen/dungeon";
import type { GroundSampler } from "../player/player";
import { getKit } from "../scene/kit";
import { makeStoneMat } from "../scene/kit/materials";
import { masonryMeshes } from "../scene/slots";
import type { MasonryBreachCell, MasonryStructureData } from "../scene/build";

const DEBRIS_CAPACITY = 768;
const FRAGMENTS_PER_HIT = 10;
const BREACH_CAPACITY = 96;
const PARK_Y = -1800;

interface DestructionStats {
  impacts: number;
  spawned: number;
  capacity: number;
  breaches: number;
  computeFrames: number;
  lastRaycastMs: number;
  inheritedColors: number;
  commandCommits: number;
  uploadedCommandBytes: number;
  fullUploadEquivalentBytes: number;
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
const _patchColor = new THREE.Color(0.44, 0.39, 0.31);
const _sourceColor = new THREE.Color(1, 1, 1);
const _groundPoint = new THREE.Vector3();
const _shardPosition = new THREE.Vector3();
const _shardSide = new THREE.Vector3();
const _shardVelocity = new THREE.Vector3();
const _shardScale = new THREE.Vector3();
const _shardRotation = new THREE.Vector3();

const GROUND_PROBES = [
  [0, 0], [0.72, 0], [-0.72, 0], [0, 0.72], [0, -0.72],
  [0.72, 0.72], [0.72, -0.72], [-0.72, 0.72], [-0.72, -0.72],
] as const;

function fract(v: number): number { return v - Math.floor(v); }
function noise(seed: number): number { return fract(Math.sin(seed * 12.9898 + 78.233) * 43758.5453); }

export class GpuDestruction {
  readonly mesh: THREE.InstancedMesh;
  readonly breachMesh: THREE.InstancedMesh;
  readonly stats: DestructionStats = {
    impacts: 0, spawned: 0, capacity: DEBRIS_CAPACITY, breaches: 0,
    computeFrames: 0, lastRaycastMs: 0, inheritedColors: 0, commandCommits: 0,
    uploadedCommandBytes: 0, fullUploadEquivalentBytes: 0,
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
  private batchStart = 0;
  private batchCount = 0;
  private warmupPromise: Promise<void> | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly renderer: THREE.WebGPURenderer,
    private readonly canvas: HTMLCanvasElement,
    private readonly sampleGround: GroundSampler,
    private readonly onTopologyChanged: () => void,
    private readonly onMasonryHit: (slot: number) => void,
    private readonly renderWarmFrame: () => void,
  ) {
    const makeState = () => {
      const data = new Float32Array(DEBRIS_CAPACITY * 4);
      for (let i = 0; i < DEBRIS_CAPACITY; i++) data[i * 4 + 1] = PARK_Y;
      return instancedArray(data, "vec4");
    };
    this.statePosition = makeState();       // xyz position, w lifetime
    this.stateVelocity = instancedArray(DEBRIS_CAPACITY, "vec4"); // xyz velocity, w contact height
    this.stateRotation = instancedArray(DEBRIS_CAPACITY, "vec4"); // xyz euler, w packed patch xz
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
        const floorY = v.w;
        // Two signed 12-bit quarter-unit coordinates share r.w exactly inside
        // float32's integer mantissa. This preserves the original eight-buffer
        // bind layout (the WebGPU minimum per-stage storage-buffer limit) while
        // still retaining a finite collision neighbourhood per fragment.
        const patchZCode = r.w.div(4096).floor();
        const patchXCode = r.w.sub(patchZCode.mul(4096));
        const patchCenter = vec2(patchXCode.sub(2048), patchZCode.sub(2048)).mul(0.25);
        const patchDistance = p.xz.sub(patchCenter).length();
        // The former infinite height plane caught fragments over an abyss and
        // made high wall courses hover. Only a small real floor neighbourhood
        // now supports the shard; outside it gravity continues unimpeded.
        const overGround = step(patchDistance, CELL * 1.55);
        const moving = step(0.18, v.xyz.length());
        const grounded = step(p.y, floorY.add(0.003)).mul(overGround);
        // Test sleep before gravity so a settled piece is not woken by -g*dt.
        If(grounded.mul(moving.oneMinus()).greaterThan(0.5), () => {
          p.y.assign(floorY);
          v.xyz.assign(vec3(0));
        }).Else(() => {
          v.y.subAssign(dt.mul(19.5));
          p.xyz.addAssign(v.xyz.mul(dt));
          // Signed per-piece tumble with translation-to-roll coupling. Rotation
          // is integrated in-place; its speed decays with linear collision
          // energy and reaches the same stable sleep state as translation.
          const id = instanceIndex.toFloat();
          const spin = vec3(
            hash(id.add(0.37)).mul(7.6).sub(3.8).add(v.z.mul(0.42)),
            hash(id.add(2.71)).mul(9.2).sub(4.6),
            hash(id.add(6.13)).mul(6.8).sub(3.4).sub(v.x.mul(0.42)),
          );
          r.xyz.addAssign(spin.mul(dt).mul(moving));
          v.xz.mulAssign(dt.mul(-0.28).exp());

          If(overGround.greaterThan(0.5), () => {
            If(p.y.lessThan(floorY), () => {
              p.y.assign(floorY);
              If(v.y.lessThan(-0.48), () => {
                v.y.assign(v.y.negate().mul(0.34));
              }).Else(() => {
                v.y.assign(0);
              });
              // Coulomb-like ground loss plus a little translation-to-roll
              // coupling makes flat flakes skid, turn, and then genuinely rest.
              v.xz.mulAssign(0.62);
            });
          });
        });

        p.w.subAssign(dt);
        If(p.w.lessThanEqual(0), () => {
          p.xyz.assign(vec3(0, PARK_Y, 0));
          p.w.assign(0);
          v.xyz.assign(vec3(0));
        });
      });
    })().compute(DEBRIS_CAPACITY);

    const p = this.statePosition.toAttribute();
    const r = this.stateRotation.toAttribute();
    const s = this.stateScale.toAttribute();
    // Shrink through the floor over the final 0.28 s rather than popping.
    const alive = smoothstep(0, 0.28, p.w);
    // TSL's generated swizzle type loses its scalar component inference after
    // repeated vec3 reassignment; keep this local expression opaque just like
    // the compute node above (runtime node shape remains strongly defined).
    const rotate = (source: any): any => {
      let q: any = source;
      const cx = r.x.cos(), sx = r.x.sin();
      q = vec3(q.x, q.y.mul(cx).sub(q.z.mul(sx)), q.y.mul(sx).add(q.z.mul(cx)));
      const cy = r.y.cos(), sy = r.y.sin();
      q = vec3(q.x.mul(cy).add(q.z.mul(sy)), q.y, q.z.mul(cy).sub(q.x.mul(sy)));
      const cz = r.z.cos(), sz = r.z.sin();
      return vec3(q.x.mul(cz).sub(q.y.mul(sz)), q.x.mul(sz).add(q.y.mul(cz)), q.z);
    };
    const material = makeStoneMat({
      // Use the authored chipped brick position as the fracture source, then
      // apply the GPU simulation's scale/tumble/translation.
      position: (local) => rotate(local.mul(s.xyz).mul(alive)).add(p.xyz),
      // Non-uniform shard scale needs inverse-scale normal correction before
      // the same Euler rotation or Lambert highlights visibly stay behind.
      normal: (local) => rotate(local.div(s.xyz.max(vec3(0.001)))).normalize(),
    });
    material.name = "gpu-debris-authored-stone";

    this.mesh = new THREE.InstancedMesh(getKit().debrisGeo, material, DEBRIS_CAPACITY);
    // Allocate the final capacity up front. Growing this attribute after the
    // WebGPU render object exists reproduces the stale binding / undersized
    // buffer validation failure that previously broke regeneration.
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(DEBRIS_CAPACITY * 3).fill(1), 3,
    );
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
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

  /** Idempotently compile the optional compute pipeline on first demand. */
  async warmup(): Promise<void> {
    this.warmupPromise ??= (async () => {
      this.dtNode.value = 0;
      await this.renderer.computeAsync(this.computeNode);

      // PostProcessing's scene pass owns a different render context from a
      // plain renderer.compileAsync(scene, camera). Measured on the target
      // WebGPU backend, the latter spent 332 ms arming yet still left a 126 ms
      // first-fragment hitch. Submit one real post frame while every shard is
      // parked below the world: it compiles the exact pipeline with no visual
      // debris and moves that one-time work behind the explicit arming state.
      const oldVisible = this.mesh.visible;
      this.mesh.visible = true;
      try {
        this.renderWarmFrame();
        const queue = (this.renderer.backend as unknown as {
          device?: { queue?: { onSubmittedWorkDone?: () => Promise<void> } };
        }).device?.queue;
        await (queue?.onSubmittedWorkDone?.() ?? Promise.resolve());
      } finally {
        this.mesh.visible = oldVisible;
      }
    })();
    await this.warmupPromise;
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
    this.batchCount = 0;
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
    // Expiration rewrites every command slot. Remove any not-yet-consumed
    // partial ranges so WebGPU performs the intended full upload on reset.
    this.spawnPosition.value.clearUpdateRanges();
    this.spawnVelocity.value.clearUpdateRanges();
    this.spawnRotation.value.clearUpdateRanges();
    this.spawnScale.value.clearUpdateRanges();
    this.mesh.instanceColor!.clearUpdateRanges();
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
        // The direct hit and all auto-collapsed companion courses are one GPU
        // command transaction, so they share one set of partial uploads.
        this.commitSpawnBatch();
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
    if (mesh.instanceColor) mesh.getColorAt(instanceId, _sourceColor);
    else _sourceColor.setRGB(1, 1, 1);
    _normal.copy(hit.face?.normal ?? new THREE.Vector3(0, 1, 0)).transformDirection(_world);
    if (_normal.dot(this.raycaster.ray.direction) > 0) _normal.negate();
    _axisX.set(1, 0, 0).applyQuaternion(_quaternion);
    _axisY.set(0, 1, 0).applyQuaternion(_quaternion);
    _axisZ.set(0, 0, 1).applyQuaternion(_quaternion);

    let gone = this.destroyed.get(mesh);
    if (!gone) { gone = new Set(); this.destroyed.set(mesh, gone); }
    gone.add(instanceId);
    const slot = (mesh.parent?.userData as { slot?: number } | undefined)?.slot;
    if (slot !== undefined) this.onMasonryHit(slot);
    mesh.setMatrixAt(instanceId, _hidden);
    mesh.instanceMatrix.needsUpdate = true; // shared by high/low/faded twins
    const structure = (mesh.userData as { masonry?: MasonryStructureData }).masonry;

    // Quantize in ISLAND-LOCAL height, then transform back to world. Using a
    // global TH grid made debris hover or sink on islands with a random oy.
    this.resolveGroundPatch(mesh, localCourseY);
    const impactSeed = (++this.stats.impacts * 131 + instanceId * 17) >>> 0;
    for (let i = 0; i < FRAGMENTS_PER_HIT; i++) {
      const nx = noise(impactSeed + i * 7) - 0.5;
      const ny = noise(impactSeed + i * 11 + 1) - 0.35;
      const nz = noise(impactSeed + i * 17 + 2) - 0.5;
      const shardPos = _shardPosition.copy(_position)
        .addScaledVector(_axisX, nx * _scale.x * 1.2)
        .addScaledVector(_axisY, ny * _scale.y * 0.7)
        .addScaledVector(_axisZ, nz * _scale.z * 1.2);
      const side = _shardSide.set(nx, Math.abs(ny) + 0.22, nz).normalize();
      // One readable core, four middle flakes and five quick chips. Capacity,
      // geometry and draw count stay fixed; only the per-impact command mix
      // changes, so breakage gains scale detail without raising GPU budget.
      const classBase = i < 1 ? 0.30 : i < 5 ? 0.15 : 0.07;
      const classRange = i < 1 ? 0.11 : i < 5 ? 0.10 : 0.075;
      const speedBoost = i < 1 ? 0.74 : i < 5 ? 1 : 1.34;
      const velocity = _shardVelocity.copy(_normal).multiplyScalar((2.8 + noise(impactSeed + i * 23) * 4.5) * speedBoost)
        .addScaledVector(side, 2.5 + noise(impactSeed + i * 31) * 4.0);
      const thinX = i >= 5 && (i & 1) === 0 ? 0.36 : 1;
      const thinZ = i >= 5 && (i & 1) === 1 ? 0.36 : 1;
      const shardScale = _shardScale.set(
        Math.min(1.7, _scale.x) * (classBase + noise(impactSeed + i * 37) * classRange) * thinX,
        Math.min(1.7, _scale.y) * (classBase * 1.15 + noise(impactSeed + i * 41) * classRange),
        Math.min(1.7, _scale.z) * (classBase + noise(impactSeed + i * 43) * classRange) * thinZ,
      );
      this.spawn(
        shardPos, velocity, _groundPoint,
        _shardRotation.set(
          _rotation.x + nx * 1.8,
          _rotation.y + ny * 1.8,
          _rotation.z + nz * 1.8,
        ),
        shardScale,
        (i < 1 ? 8.0 : i < 5 ? 5.0 : 2.4) + noise(impactSeed + i * 53) * 1.8,
        _sourceColor,
      );
    }
    const breach = structure?.byInstance.get(instanceId);
    if (breach && !breach.opened) {
      breach.destroyed.add(instanceId);
      if (breach.required.every((id) => breach.destroyed.has(id))) this.openBreach(mesh, breach);
    }
  }

  /** Find the nearest actual walkable surface below the struck course. The
   * center probe is usually solid (it is the wall being broken), so the ring
   * reaches adjacent corridor cells. This is O(9) only per impact, never per
   * frame or per fragment. */
  private resolveGroundPatch(mesh: THREE.InstancedMesh, localCourseY: number): void {
    let bestScore = Infinity;
    let bestX = _position.x, bestY = 0, bestZ = _position.z;
    for (const [ox, oz] of GROUND_PROBES) {
      const x = _position.x + ox * CELL;
      const z = _position.z + oz * CELL;
      const hit = this.sampleGround(x, z, _position.y);
      if (!hit.ok) continue;
      const drop = _position.y - hit.y;
      if (drop < -0.28 || drop > TH * 5) continue;
      const score = Math.max(0, drop) + Math.hypot(ox, oz) * 0.08;
      if (score < bestScore) {
        bestScore = score;
        bestX = x; bestY = hit.y; bestZ = z;
      }
    }
    if (bestScore < Infinity) {
      _groundPoint.set(bestX, bestY, bestZ);
      return;
    }
    // Defensive fallback for decorative masonry with no registered WalkMap.
    // It remains finite in XZ, so it cannot create the former invisible shelf
    // across the void even when its height has to be estimated.
    const localGroundY = Math.floor((localCourseY + 0.12) / TH) * TH + 0.16;
    _groundPoint.set(0, localGroundY, 0).applyMatrix4(mesh.matrixWorld);
    _groundPoint.x = _position.x;
    _groundPoint.z = _position.z;
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
    ground: THREE.Vector3,
    rotation: THREE.Vector3,
    scale: THREE.Vector3,
    life: number,
    sourceColor: THREE.Color,
  ): void {
    const i = this.cursor;
    if (this.batchCount === 0) this.batchStart = i;
    this.batchCount++;
    this.cursor = (this.cursor + 1) % DEBRIS_CAPACITY;
    const version = ++this.version;
    const o = i * 4;
    const positions = this.spawnPosition.value.array as Float32Array;
    positions[o] = position.x;
    positions[o + 1] = position.y;
    positions[o + 2] = position.z;
    positions[o + 3] = life;
    // Approximate the rotating convex shard with a compact contact sphere.
    // The old center-on-plane collision buried half of every fragment.
    const contactRadius = Math.max(0.055, Math.min(0.46,
      Math.max(COURSE * scale.y * 0.5, CELL * Math.max(scale.x, scale.z) * 0.18),
    ));
    const patchX = Math.max(0, Math.min(4095, Math.round(ground.x * 4) + 2048));
    const patchZ = Math.max(0, Math.min(4095, Math.round(ground.z * 4) + 2048));
    const packedPatch = patchX + patchZ * 4096;
    const velocities = this.spawnVelocity.value.array as Float32Array;
    velocities[o] = velocity.x;
    velocities[o + 1] = velocity.y;
    velocities[o + 2] = velocity.z;
    velocities[o + 3] = ground.y + contactRadius;
    const rotations = this.spawnRotation.value.array as Float32Array;
    rotations[o] = rotation.x;
    rotations[o + 1] = rotation.y;
    rotations[o + 2] = rotation.z;
    rotations[o + 3] = packedPatch;
    const scales = this.spawnScale.value.array as Float32Array;
    scales[o] = scale.x;
    scales[o + 1] = scale.y;
    scales[o + 2] = scale.z;
    scales[o + 3] = version;
    const colorOffset = i * 3;
    const colors = this.mesh.instanceColor!.array as Float32Array;
    colors[colorOffset] = sourceColor.r;
    colors[colorOffset + 1] = sourceColor.g;
    colors[colorOffset + 2] = sourceColor.b;
    this.stats.spawned++;
    this.stats.inheritedColors++;
    this.activeUntil = Math.max(this.activeUntil, performance.now() + life * 1000 + 250);
  }

  private commitSpawnBatch(): void {
    if (this.batchCount === 0) return;
    const addWrappedRange = (attribute: THREE.BufferAttribute, itemSize: number): void => {
      const firstCount = Math.min(this.batchCount, DEBRIS_CAPACITY - this.batchStart);
      const wrappedCount = this.batchCount - firstCount;
      // Keep ranges sorted for WebGPUBindingUtils' contiguous merge path.
      if (wrappedCount > 0) attribute.addUpdateRange(0, wrappedCount * itemSize);
      attribute.addUpdateRange(this.batchStart * itemSize, firstCount * itemSize);
    };
    addWrappedRange(this.spawnPosition.value, 4);
    addWrappedRange(this.spawnVelocity.value, 4);
    addWrappedRange(this.spawnRotation.value, 4);
    addWrappedRange(this.spawnScale.value, 4);
    addWrappedRange(this.mesh.instanceColor!, 3);
    this.spawnPosition.value.needsUpdate = true;
    this.spawnVelocity.value.needsUpdate = true;
    this.spawnRotation.value.needsUpdate = true;
    this.spawnScale.value.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    this.mesh.visible = true;
    this.stats.commandCommits++;
    // Four vec4 command buffers plus one RGB instance color.
    this.stats.uploadedCommandBytes += this.batchCount * (4 * 4 * 4 + 3 * 4);
    this.stats.fullUploadEquivalentBytes += DEBRIS_CAPACITY * (4 * 4 * 4 + 3 * 4);
    this.batchCount = 0;
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
