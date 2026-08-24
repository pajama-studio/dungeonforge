// Global low/middle masonry compaction.
//
// Slot pools remain the CPU/L0 authoring authority. This pass copies only the
// cheap box-shell representations into stable storage, applies each slot's
// animated world transform in compute, and emits two indirect draws (shadowed
// far walls + unshadowed bridges/middle twins). The high-detail sources stay in
// their original per-slot meshes, so near LOD warm-up and picking are unchanged.

import * as THREE from "three/webgpu";
import {
  Fn, If, atomicAdd, atomicStore, instanceIndex, max, storage, uniform, uint, vec4,
} from "three/tsl";
import { getKit } from "../scene/kit";
import {
  gpuSceneSlotPools, setGpuSceneManaged, setSlotLodLevel, type SlotPool,
} from "../scene/slots";
import { LOD_TIERS, packInstanceMeta, unpackInstanceMeta } from "./instance-meta";
import { makeStoneLoMat } from "../scene/kit/materials";
import {
  LOW_MASONRY_ROUTE, lowMasonryBucket, type LowMasonryRoute,
} from "./low-masonry-route";

const CAPACITY = 65_536;
const SLOT_CAPACITY = 128;
const GROUP_COUNT = 8;
const HIDDEN_LOD = 3;
const CULL_MARGIN = 5;
const MANAGED_KEYS = ["blocksLo", "blocksMidLo", "blockTopsLo", "linkStonesLo"] as const;

type ComputeNode = any;

interface LowBucket {
  name: "shadow" | "plain";
  mesh: THREE.InstancedMesh;
  geometry: THREE.BufferGeometry;
  matrices: THREE.StorageInstancedBufferAttribute;
  colors: THREE.StorageInstancedBufferAttribute;
  matrixNode: any;
  colorNode: any;
  indirectBase: number;
}

interface CompactRange {
  start: number;
  count: number;
  route: LowMasonryRoute;
}

interface CompactSlot {
  pool: SlotPool;
  index: number;
  ranges: CompactRange[];
  level: number;
  worldMatrix: THREE.Matrix4;
}

export interface GpuLowMasonryStats {
  enabled: boolean;
  sourceInstances: number;
  activeSourceInstances: number;
  sourceRenderObjects: number;
  submittedBuckets: number;
  slotCount: number;
  computeFrames: number;
  cullFrames: number;
  rebuilds: number;
  lastRebuildMs: number;
  hiddenInstances: number;
  capacity: number;
  fallbackReason: string;
}

export interface GpuLowMasonryValidation {
  shadow: number;
  plain: number;
  unmatchedSourceIds: number;
  misroutedInstances: number;
}

const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _color = new THREE.Color(1, 1, 1);

export class GpuLowMasonryScene {
  readonly group = new THREE.Group();
  readonly stats: GpuLowMasonryStats;

  private readonly sourceMatrices = new THREE.StorageBufferAttribute(CAPACITY, 16);
  private readonly sourceColors = new THREE.StorageBufferAttribute(CAPACITY, 4);
  private readonly slotMatrices = new THREE.StorageBufferAttribute(SLOT_CAPACITY, 16);
  private readonly indirect = new THREE.IndirectStorageBufferAttribute(new Uint32Array(10), 1);
  private readonly indirectNode = storage(this.indirect, "uint", 10).toAtomic();
  private readonly planeNodes = Array.from({ length: 6 }, () => uniform(new THREE.Vector4()));
  private readonly projection = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly buckets: [LowBucket, LowBucket];
  private readonly resetNode: ComputeNode;
  private readonly cullNode: ComputeNode;
  private readonly sourceToGlobal = new WeakMap<THREE.InstancedMesh, Uint32Array>();
  private managedMeshes: THREE.InstancedMesh[] = [];
  private compactSlots: CompactSlot[] = [];
  private readonly lastCameraPosition = new THREE.Vector3(Infinity, Infinity, Infinity);
  private readonly lastCameraQuaternion = new THREE.Quaternion();
  private readonly occludingSlots = new Set<number>();
  private sourceCount = 0;
  private active = false;
  private failed = false;
  private indirectHasDraws = false;
  private dirty = true;
  private shadowsEnabled = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGPURenderer,
    private readonly requested = true,
  ) {
    this.group.name = "gpu-scene-low-masonry";
    this.group.visible = false;
    this.scene.add(this.group);

    this.buckets = [
      // The colour bucket joins the first cinematic frame; its static shadow
      // pass is armed immediately after that submission so one extra concrete
      // WebGPU shadow render object does not inflate the startup peak.
      this.makeBucket("shadow", "gpu-scene-low-masonry-shadow", 0, false),
      this.makeBucket("plain", "gpu-scene-low-masonry-plain", 5, false),
    ];

    const sourceMatrices = storage(this.sourceMatrices, "mat4", CAPACITY).toReadOnly();
    const sourceColors = storage(this.sourceColors, "vec4", CAPACITY).toReadOnly();
    const slotMatrices = storage(this.slotMatrices, "mat4", SLOT_CAPACITY).toReadOnly();

    this.resetNode = Fn(() => {
      for (const bucket of this.buckets) {
        const base = bucket.indirectBase;
        atomicStore(this.indirectNode.element(base), uint(bucket.geometry.index!.count));
        atomicStore(this.indirectNode.element(base + 1), uint(0));
        atomicStore(this.indirectNode.element(base + 2), uint(0));
        atomicStore(this.indirectNode.element(base + 3), uint(0));
        atomicStore(this.indirectNode.element(base + 4), uint(0));
      }
    })().compute(1);

    this.cullNode = Fn(() => {
      const sourceIndex = instanceIndex;
      const sourceColor = sourceColors.element(sourceIndex);
      const encoded = uint(max(sourceColor.w, 1)).sub(uint(1));
      const withoutGroup = encoded.div(uint(GROUP_COUNT));
      const route = encoded.mod(uint(GROUP_COUNT));
      const slotIndex = withoutGroup.div(uint(LOD_TIERS));
      const lod = withoutGroup.mod(uint(LOD_TIERS));
      const worldMatrix = slotMatrices.element(slotIndex).mul(sourceMatrices.element(sourceIndex));
      const center = worldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
      let inside: any = sourceColor.w.greaterThan(0.5);
      for (const plane of this.planeNodes) {
        inside = inside.and(plane.xyz.dot(center).add(plane.w).greaterThanEqual(-CULL_MARGIN));
      }
      If(inside, () => {
        If(route.equal(uint(LOW_MASONRY_ROUTE.farShadow)), () => {
          If(lod.equal(uint(0)), () => this.append(this.buckets[0], sourceIndex, worldMatrix, sourceColor));
        }).ElseIf(route.equal(uint(LOW_MASONRY_ROUTE.farPlain)), () => {
          If(lod.equal(uint(0)), () => this.append(this.buckets[1], sourceIndex, worldMatrix, sourceColor));
        }).ElseIf(route.equal(uint(LOW_MASONRY_ROUTE.farMiddleShadow)), () => {
          If(lod.lessThan(uint(2)), () => this.append(this.buckets[0], sourceIndex, worldMatrix, sourceColor));
        }).ElseIf(route.equal(uint(LOW_MASONRY_ROUTE.farMiddlePlain)), () => {
          If(lod.lessThan(uint(2)), () => this.append(this.buckets[1], sourceIndex, worldMatrix, sourceColor));
        }).ElseIf(route.equal(uint(LOW_MASONRY_ROUTE.middleShadow)), () => {
          If(lod.equal(uint(1)), () => this.append(this.buckets[0], sourceIndex, worldMatrix, sourceColor));
        }).ElseIf(route.equal(uint(LOW_MASONRY_ROUTE.middlePlain)), () => {
          If(lod.equal(uint(1)), () => this.append(this.buckets[1], sourceIndex, worldMatrix, sourceColor));
        }).ElseIf(route.equal(uint(LOW_MASONRY_ROUTE.allShadow)), () => {
          If(lod.lessThan(uint(3)), () => this.append(this.buckets[0], sourceIndex, worldMatrix, sourceColor));
        }).Else(() => {
          If(lod.lessThan(uint(3)), () => this.append(this.buckets[1], sourceIndex, worldMatrix, sourceColor));
        });
      });
    })().compute(1);

    this.stats = {
      enabled: false,
      sourceInstances: 0,
      activeSourceInstances: 0,
      sourceRenderObjects: 0,
      submittedBuckets: 0,
      slotCount: 0,
      computeFrames: 0,
      cullFrames: 0,
      rebuilds: 0,
      lastRebuildMs: 0,
      hiddenInstances: 0,
      capacity: CAPACITY,
      fallbackReason: requested ? "not built" : "disabled by ?gpuscene=0",
    };
  }

  private makeBucket(
    bucketName: "shadow" | "plain",
    objectName: string,
    indirectBase: number,
    shadows: boolean,
  ): LowBucket {
    const geometry = getKit().blockGeoLo.clone();
    if (!geometry.index) {
      const vertexCount = geometry.getAttribute("position").count;
      geometry.setIndex(Array.from({ length: vertexCount }, (_, i) => i));
    }
    geometry.setIndirect(this.indirect, indirectBase * Uint32Array.BYTES_PER_ELEMENT);
    const matrices = new THREE.StorageInstancedBufferAttribute(CAPACITY, 16);
    const colors = new THREE.StorageInstancedBufferAttribute(CAPACITY, 4);
    const stableSourceId = storage(colors, "vec4", CAPACITY).toReadOnly().element(instanceIndex).w;
    const material = makeStoneLoMat(stableSourceId as any);
    const mesh = new THREE.InstancedMesh(geometry, material, CAPACITY);
    mesh.name = objectName;
    mesh.instanceMatrix = matrices;
    mesh.instanceColor = colors;
    mesh.count = CAPACITY;
    mesh.frustumCulled = false;
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.visible = false;
    this.group.add(mesh);
    return {
      name: bucketName,
      mesh,
      geometry,
      matrices,
      colors,
      matrixNode: storage(matrices, "mat4", CAPACITY),
      colorNode: storage(colors, "vec4", CAPACITY),
      indirectBase,
    };
  }

  private append(bucket: LowBucket, sourceIndex: any, worldMatrix: any, sourceColor: any): void {
    const destination = atomicAdd(this.indirectNode.element(bucket.indirectBase + 1), uint(1)).toVar();
    bucket.matrixNode.element(destination).assign(worldMatrix);
    bucket.colorNode.element(destination).assign(vec4(sourceColor.xyz, sourceIndex));
  }

  rebuild(): boolean {
    const started = performance.now();
    this.releaseManagedMeshes();
    this.active = false;
    this.group.visible = false;
    this.sourceCount = 0;
    this.compactSlots = [];
    this.indirectHasDraws = false;
    this.dirty = true;
    this.lastCameraPosition.set(Infinity, Infinity, Infinity);
    this.stats.sourceInstances = 0;
    this.stats.activeSourceInstances = 0;
    this.stats.sourceRenderObjects = 0;
    this.stats.submittedBuckets = 0;
    this.stats.hiddenInstances = 0;

    if (!this.requested || this.failed) return false;
    const pools = gpuSceneSlotPools().filter((pool) => MANAGED_KEYS.some((key) => pool.meshes.has(key)));
    if (pools.length > SLOT_CAPACITY) return this.fail(`slot capacity ${pools.length}/${SLOT_CAPACITY}`);

    const matrices = this.sourceMatrices.array as Float32Array;
    const colors = this.sourceColors.array as Float32Array;
    const slotMatrices = this.slotMatrices.array as Float32Array;
    let cursor = 0;
    let managedRenderObjects = 0;
    let overflowReason = "";

    for (let slotIndex = 0; slotIndex < pools.length; slotIndex++) {
      const pool = pools[slotIndex];
      const ranges: CompactRange[] = [];
      pool.group.updateWorldMatrix(true, false);
      pool.group.matrixWorld.toArray(slotMatrices, slotIndex * 16);

      const addSource = (
        sourceKey: string,
        lowKey: typeof MANAGED_KEYS[number],
        visibility: "far" | "far-middle" | "middle",
      ) => {
        if (overflowReason) return;
        const source = pool.meshes.get(sourceKey);
        const lowMesh = pool.meshes.get(lowKey);
        if (!source || !lowMesh) return;
        const count = (source.userData as { n?: number }).n ?? 0;
        if (count <= 0) return;
        if (cursor + count > CAPACITY) {
          overflowReason = `instance capacity ${cursor + count}/${CAPACITY}`;
          return;
        }
        const shadow = lowMesh.castShadow === true;
        const route: LowMasonryRoute = visibility === "far"
          ? (shadow ? LOW_MASONRY_ROUTE.farShadow : LOW_MASONRY_ROUTE.farPlain)
          : visibility === "far-middle"
            ? (shadow ? LOW_MASONRY_ROUTE.farMiddleShadow : LOW_MASONRY_ROUTE.farMiddlePlain)
            : (shadow ? LOW_MASONRY_ROUTE.middleShadow : LOW_MASONRY_ROUTE.middlePlain);
        const start = cursor;
        const mapping = new Uint32Array(count);
        source.updateMatrix();
        for (let localIndex = 0; localIndex < count; localIndex++) {
          source.getMatrixAt(localIndex, _local);
          _world.multiplyMatrices(source.matrix, _local);
          _world.toArray(matrices, cursor * 16);
          if (source.instanceColor) source.getColorAt(localIndex, _color);
          else _color.setRGB(1, 1, 1);
          const colorOffset = cursor * 4;
          colors[colorOffset] = _color.r;
          colors[colorOffset + 1] = _color.g;
          colors[colorOffset + 2] = _color.b;
          colors[colorOffset + 3] = packInstanceMeta(
            { slot: slotIndex, lod: pool.lodLevel, group: route }, GROUP_COUNT,
          );
          mapping[localIndex] = cursor++;
        }
        this.sourceToGlobal.set(source, mapping);
        ranges.push({ start, count, route });
        setGpuSceneManaged(lowMesh, true);
        this.managedMeshes.push(lowMesh);
        managedRenderObjects++;
      };

      const blocksLo = pool.meshes.get("blocksLo");
      if (blocksLo) {
        addSource("blocksLo", "blocksLo", pool.meshes.has("blocksMidLo") ? "far" : "far-middle");
      }
      if (pool.meshes.has("blocksMidLo")) addSource("blocks", "blocksMidLo", "middle");
      if (pool.meshes.has("blockTopsLo")) addSource("blockTops", "blockTopsLo", "middle");
      if (pool.meshes.has("linkStonesLo")) addSource("linkStones", "linkStonesLo", "far-middle");

      if (ranges.length > 0) {
        this.compactSlots.push({
          pool,
          index: slotIndex,
          ranges,
          level: pool.group.visible ? pool.lodLevel : HIDDEN_LOD,
          worldMatrix: pool.group.matrixWorld.clone(),
        });
      }
    }

    if (overflowReason) return this.fail(overflowReason);

    this.sourceCount = cursor;
    this.markFullUpload(this.sourceMatrices, cursor * 16);
    this.markFullUpload(this.sourceColors, cursor * 4);
    this.markFullUpload(this.slotMatrices, pools.length * 16);
    this.active = cursor > 0;
    this.group.visible = this.active;
    for (const bucket of this.buckets) bucket.mesh.visible = this.active;
    this.stats.enabled = this.active;
    this.stats.sourceInstances = cursor;
    this.stats.activeSourceInstances = this.countActiveInstances();
    this.stats.sourceRenderObjects = managedRenderObjects;
    this.stats.submittedBuckets = this.active ? this.buckets.length : 0;
    this.stats.slotCount = this.compactSlots.length;
    this.stats.rebuilds++;
    this.stats.lastRebuildMs = performance.now() - started;
    this.stats.fallbackReason = this.active ? "" : "no low masonry";
    return this.active;
  }

  private markFullUpload(attribute: THREE.BufferAttribute, components: number): void {
    attribute.clearUpdateRanges();
    if (components > 0) attribute.addUpdateRange(0, components);
    attribute.needsUpdate = true;
  }

  private fail(reason: string): false {
    this.failed = true;
    this.active = false;
    this.group.visible = false;
    this.stats.enabled = false;
    this.stats.fallbackReason = reason;
    console.warn(`[gpu-low-masonry] fallback: ${reason}`);
    this.releaseManagedMeshes();
    return false;
  }

  private releaseManagedMeshes(): void {
    const poolBySlot = new Map(gpuSceneSlotPools().map((pool) => [pool.slot, pool]));
    const affected = new Set<SlotPool>();
    for (const mesh of this.managedMeshes) {
      setGpuSceneManaged(mesh, false);
      const slot = (mesh.parent?.userData as { slot?: number } | undefined)?.slot;
      const pool = slot === undefined ? undefined : poolBySlot.get(slot);
      if (pool) affected.add(pool);
    }
    this.managedMeshes = [];
    for (const pool of affected) setSlotLodLevel(pool.slot, pool.lodLevel);
  }

  hideSourceInstance(source: THREE.InstancedMesh, localIndex: number): void {
    if (!this.active) return;
    const globalIndex = this.sourceToGlobal.get(source)?.[localIndex];
    if (globalIndex === undefined || globalIndex >= this.sourceCount) return;
    const colors = this.sourceColors.array as Float32Array;
    const metadataOffset = globalIndex * 4 + 3;
    if (colors[metadataOffset] <= 0) return;
    colors[metadataOffset] = 0;
    this.sourceColors.addUpdateRange(metadataOffset, 1);
    this.sourceColors.needsUpdate = true;
    this.stats.hiddenInstances++;
    this.dirty = true;
  }

  setOccludingSlots(next: ReadonlySet<number>): void {
    let changed = next.size !== this.occludingSlots.size;
    if (!changed) for (const slot of next) if (!this.occludingSlots.has(slot)) { changed = true; break; }
    if (!changed) return;
    this.occludingSlots.clear();
    for (const slot of next) this.occludingSlots.add(slot);
    for (const compact of this.compactSlots) {
      const managed = !this.occludingSlots.has(compact.pool.slot);
      for (const key of MANAGED_KEYS) {
        const mesh = compact.pool.meshes.get(key);
        if (mesh) setGpuSceneManaged(mesh, managed);
      }
      setSlotLodLevel(compact.pool.slot, compact.pool.lodLevel);
    }
    this.dirty = true;
  }

  /** Arm the one static shadow bucket after the first complete colour frame.
   * Returns true once so the environment can request exactly one shadow bake. */
  enableShadows(): boolean {
    if (!this.active || this.shadowsEnabled) return false;
    this.shadowsEnabled = true;
    this.buckets[0].mesh.castShadow = true;
    return true;
  }

  tick(camera: THREE.Camera): void {
    if (!this.active) return;
    try {
      const { activeSourceInstances, changed: lodChanged } = this.syncSlotLevels();
      const transformsChanged = this.syncSlotTransforms();
      this.stats.activeSourceInstances = activeSourceInstances;
      if (activeSourceInstances === 0) {
        if (this.indirectHasDraws) {
          this.renderer.compute(this.resetNode);
          this.stats.computeFrames++;
          this.indirectHasDraws = false;
        }
        return;
      }

      const cameraMoved = camera.position.distanceToSquared(this.lastCameraPosition) > 0.75 * 0.75
        || 1 - Math.abs(camera.quaternion.dot(this.lastCameraQuaternion)) > 0.00008;
      if (!this.dirty && !lodChanged && !transformsChanged && !cameraMoved) return;

      camera.updateMatrixWorld();
      this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(
        this.projection,
        camera.coordinateSystem,
        camera.reversedDepth,
      );
      for (let i = 0; i < 6; i++) {
        const plane = this.frustum.planes[i];
        this.planeNodes[i].value.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
      }
      this.cullNode.count = this.sourceCount;
      this.renderer.compute([this.resetNode, this.cullNode]);
      this.stats.computeFrames++;
      this.stats.cullFrames++;
      this.indirectHasDraws = true;
      this.dirty = false;
      this.lastCameraPosition.copy(camera.position);
      this.lastCameraQuaternion.copy(camera.quaternion);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private syncSlotLevels(): { activeSourceInstances: number; changed: boolean } {
    const colors = this.sourceColors.array as Float32Array;
    let activeSourceInstances = 0;
    let changed = false;
    for (const slot of this.compactSlots) {
      const next = slot.pool.group.visible && !this.occludingSlots.has(slot.pool.slot)
        ? slot.pool.lodLevel : HIDDEN_LOD;
      for (const range of slot.ranges) {
        if (lowMasonryBucket(range.route, next)) activeSourceInstances += range.count;
      }
      if (slot.level === next) continue;
      slot.level = next;
      for (const range of slot.ranges) {
        for (let i = range.start; i < range.start + range.count; i++) {
          if (colors[i * 4 + 3] > 0) {
            colors[i * 4 + 3] = packInstanceMeta(
              { slot: slot.index, lod: next, group: range.route }, GROUP_COUNT,
            );
          }
        }
        this.sourceColors.addUpdateRange(range.start * 4, range.count * 4);
      }
      changed = true;
    }
    if (changed) {
      this.sourceColors.needsUpdate = true;
      this.dirty = true;
    }
    return { activeSourceInstances, changed };
  }

  private countActiveInstances(): number {
    let active = 0;
    for (const slot of this.compactSlots) {
      for (const range of slot.ranges) {
        if (lowMasonryBucket(range.route, slot.level)) active += range.count;
      }
    }
    return active;
  }

  private syncSlotTransforms(): boolean {
    const matrices = this.slotMatrices.array as Float32Array;
    let changed = false;
    for (const slot of this.compactSlots) {
      slot.pool.group.updateWorldMatrix(true, false);
      if (slot.worldMatrix.equals(slot.pool.group.matrixWorld)) continue;
      slot.worldMatrix.copy(slot.pool.group.matrixWorld);
      slot.worldMatrix.toArray(matrices, slot.index * 16);
      this.slotMatrices.addUpdateRange(slot.index * 16, 16);
      changed = true;
    }
    if (changed) {
      this.slotMatrices.needsUpdate = true;
      this.dirty = true;
    }
    return changed;
  }

  async readbackValidation(): Promise<GpuLowMasonryValidation> {
    const args = new Uint32Array(await this.renderer.getArrayBufferAsync(this.indirect));
    const shadow = args[1] ?? 0;
    const plain = args[6] ?? 0;
    const [shadowColors, plainColors] = await Promise.all([
      this.renderer.getArrayBufferAsync(this.buckets[0].colors),
      this.renderer.getArrayBufferAsync(this.buckets[1].colors),
    ]);
    let unmatchedSourceIds = 0;
    let misroutedInstances = 0;
    const sourceColors = this.sourceColors.array as Float32Array;
    const validate = (bytes: ArrayBuffer, count: number, expected: "shadow" | "plain") => {
      const colors = new Float32Array(bytes);
      for (let i = 0; i < count; i++) {
        const sourceIndex = Math.round(colors[i * 4 + 3]);
        if (sourceIndex < 0 || sourceIndex >= this.sourceCount) {
          unmatchedSourceIds++;
          continue;
        }
        const meta = unpackInstanceMeta(sourceColors[sourceIndex * 4 + 3], GROUP_COUNT);
        if (!meta || lowMasonryBucket(meta.group as LowMasonryRoute, meta.lod) !== expected) {
          misroutedInstances++;
        }
      }
    };
    validate(shadowColors, shadow, "shadow");
    validate(plainColors, plain, "plain");
    return { shadow, plain, unmatchedSourceIds, misroutedInstances };
  }

  dispose(): void {
    this.releaseManagedMeshes();
    this.group.removeFromParent();
    for (const bucket of this.buckets) {
      bucket.mesh.dispose();
      bucket.geometry.dispose();
      const material = bucket.mesh.material;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material.dispose();
      bucket.matrices.dispose();
      bucket.colors.dispose();
    }
    this.indirect.dispose();
    this.sourceMatrices.dispose();
    this.sourceColors.dispose();
    this.slotMatrices.dispose();
    this.resetNode.dispose?.();
    this.cullNode.dispose?.();
  }
}
