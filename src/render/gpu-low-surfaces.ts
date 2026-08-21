// Global low/middle floor-surface compaction.
//
// Masonry walls already collapse across slot boundaries. The remaining cold
// startup train was mostly the same tile, step and column geometry submitted
// once per island. Four bounded compute passes keep one geometry per indirect
// draw (required by WebGPU), preserve the exact slot/L0 authoring buffers and
// reduce those repeated low-LOD objects to four active default buckets. Two
// tiny all-LOD decor families use cheaper CPU merges in the same owner below.

import * as THREE from "three/webgpu";
import {
  Fn, If, atomicAdd, atomicStore, instanceIndex, max, storage, uniform, uint, vec4,
} from "three/tsl";
import { getKit } from "../scene/kit";
import { makeStoneFloorMat, makeStoneLoMat } from "../scene/kit/materials";
import {
  gpuSceneSlotPools, setGpuSceneManaged, setSlotLodLevel, type SlotPool,
} from "../scene/slots";
import { LOD_TIERS, packInstanceMeta, unpackInstanceMeta } from "./instance-meta";
import {
  LOW_MASONRY_ROUTE, lowMasonryBucket, type LowMasonryRoute,
} from "./low-masonry-route";

const SLOT_CAPACITY = 128;
const GROUP_COUNT = 8;
const HIDDEN_LOD = 3;
const CULL_MARGIN = 5;

type ComputeNode = any;
type Visibility = "far" | "far-middle" | "middle" | "all";
type MaterialFactory = (stableSourceId: any) => THREE.Material;

interface SurfaceSource {
  source: THREE.InstancedMesh;
  managed: THREE.InstancedMesh;
  visibility: Visibility;
}

interface SurfacePassConfig {
  name: "tiles" | "steps" | "columns" | "planks";
  capacity: number;
  geometry: THREE.BufferGeometry;
  materialFactory: MaterialFactory;
  occlusionFallback: boolean;
  collect: (pool: SlotPool) => SurfaceSource[];
}

interface StaticDecorConfig {
  name: "banners" | "redTiles";
  key: "banners" | "redTiles";
  capacity: number;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  shadows: boolean;
}

interface SurfaceBucket {
  name: "shadow" | "plain";
  mesh: THREE.InstancedMesh;
  geometry: THREE.BufferGeometry;
  matrices: THREE.StorageInstancedBufferAttribute;
  colors: THREE.StorageInstancedBufferAttribute;
  matrixNode: any;
  colorNode: any;
  indirectBase: number;
}

interface SurfaceRange {
  start: number;
  count: number;
  route: LowMasonryRoute;
  managed: THREE.InstancedMesh;
}

interface SurfaceSlot {
  pool: SlotPool;
  index: number;
  ranges: SurfaceRange[];
  level: number;
  worldMatrix: THREE.Matrix4;
}

export interface GpuLowSurfacePassStats {
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
  capacity: number;
  fallbackReason: string;
}

export interface GpuLowSurfacePassValidation {
  shadow: number;
  plain: number;
  unmatchedSourceIds: number;
  misroutedInstances: number;
}

export interface GpuLowSurfacesStats {
  enabled: boolean;
  sourceInstances: number;
  activeSourceInstances: number;
  sourceRenderObjects: number;
  submittedBuckets: number;
  tiles: GpuLowSurfacePassStats;
  steps: GpuLowSurfacePassStats;
  columns: GpuLowSurfacePassStats;
  planks: GpuLowSurfacePassStats;
  banners: GpuLowSurfacePassStats;
  redTiles: GpuLowSurfacePassStats;
}

export interface GpuLowSurfacesValidation {
  tiles: GpuLowSurfacePassValidation;
  steps: GpuLowSurfacePassValidation;
  columns: GpuLowSurfacePassValidation;
  planks: GpuLowSurfacePassValidation;
  banners: GpuLowSurfacePassValidation;
  redTiles: GpuLowSurfacePassValidation;
}

const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _color = new THREE.Color(1, 1, 1);

class GpuLowSurfacePass {
  readonly group = new THREE.Group();
  readonly stats: GpuLowSurfacePassStats;

  private readonly sourceMatrices: THREE.StorageBufferAttribute;
  private readonly sourceColors: THREE.StorageBufferAttribute;
  private readonly slotMatrices = new THREE.StorageBufferAttribute(SLOT_CAPACITY, 16);
  private readonly indirect = new THREE.IndirectStorageBufferAttribute(new Uint32Array(10), 1);
  private readonly indirectNode = storage(this.indirect, "uint", 10).toAtomic();
  private readonly planeNodes = Array.from({ length: 6 }, () => uniform(new THREE.Vector4()));
  private readonly projection = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly buckets: [SurfaceBucket, SurfaceBucket];
  private readonly resetNode: ComputeNode;
  private readonly cullNode: ComputeNode;
  private managedMeshes: THREE.InstancedMesh[] = [];
  private compactSlots: SurfaceSlot[] = [];
  private readonly lastCameraPosition = new THREE.Vector3(Infinity, Infinity, Infinity);
  private readonly lastCameraQuaternion = new THREE.Quaternion();
  private readonly occludingSlots = new Set<number>();
  private sourceCount = 0;
  private bucketSources: [number, number] = [0, 0];
  private active = false;
  private failed = false;
  private indirectHasDraws = false;
  private dirty = true;
  private shadowsEnabled = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGPURenderer,
    private readonly config: SurfacePassConfig,
    private readonly requested: boolean,
  ) {
    this.group.name = `gpu-scene-low-surface-${config.name}`;
    this.group.visible = false;
    this.scene.add(this.group);
    this.sourceMatrices = new THREE.StorageBufferAttribute(config.capacity, 16);
    this.sourceColors = new THREE.StorageBufferAttribute(config.capacity, 4);
    this.buckets = [
      this.makeBucket("shadow", 0),
      this.makeBucket("plain", 5),
    ];

    const sourceMatrices = storage(this.sourceMatrices, "mat4", config.capacity).toReadOnly();
    const sourceColors = storage(this.sourceColors, "vec4", config.capacity).toReadOnly();
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
      capacity: config.capacity,
      fallbackReason: requested ? "not built" : "disabled by ?gpuscene=0",
    };
  }

  private makeBucket(name: "shadow" | "plain", indirectBase: number): SurfaceBucket {
    const geometry = this.config.geometry.clone();
    if (!geometry.index) {
      const vertexCount = geometry.getAttribute("position").count;
      geometry.setIndex(Array.from({ length: vertexCount }, (_, i) => i));
    }
    geometry.setIndirect(this.indirect, indirectBase * Uint32Array.BYTES_PER_ELEMENT);
    const matrices = new THREE.StorageInstancedBufferAttribute(this.config.capacity, 16);
    const colors = new THREE.StorageInstancedBufferAttribute(this.config.capacity, 4);
    const stableSourceId = storage(colors, "vec4", this.config.capacity)
      .toReadOnly().element(instanceIndex).w;
    const material = this.config.materialFactory(stableSourceId);
    const mesh = new THREE.InstancedMesh(geometry, material, this.config.capacity);
    mesh.name = `${this.group.name}-${name}`;
    mesh.instanceMatrix = matrices;
    mesh.instanceColor = colors;
    mesh.count = this.config.capacity;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    this.group.add(mesh);
    return {
      name,
      mesh,
      geometry,
      matrices,
      colors,
      matrixNode: storage(matrices, "mat4", this.config.capacity),
      colorNode: storage(colors, "vec4", this.config.capacity),
      indirectBase,
    };
  }

  private append(bucket: SurfaceBucket, sourceIndex: any, worldMatrix: any, sourceColor: any): void {
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
    this.bucketSources = [0, 0];
    this.compactSlots = [];
    this.indirectHasDraws = false;
    this.dirty = true;
    this.lastCameraPosition.set(Infinity, Infinity, Infinity);
    Object.assign(this.stats, {
      enabled: false,
      sourceInstances: 0,
      activeSourceInstances: 0,
      sourceRenderObjects: 0,
      submittedBuckets: 0,
      slotCount: 0,
    });
    if (!this.requested || this.failed) return false;

    const pools = gpuSceneSlotPools()
      .filter((pool) => this.config.collect(pool).length > 0);
    if (pools.length > SLOT_CAPACITY) return this.fail(`slot capacity ${pools.length}/${SLOT_CAPACITY}`);
    const matrices = this.sourceMatrices.array as Float32Array;
    const colors = this.sourceColors.array as Float32Array;
    const slotMatrices = this.slotMatrices.array as Float32Array;
    let cursor = 0;
    let managedRenderObjects = 0;
    let overflowReason = "";

    for (let slotIndex = 0; slotIndex < pools.length; slotIndex++) {
      const pool = pools[slotIndex];
      const ranges: SurfaceRange[] = [];
      pool.group.updateWorldMatrix(true, false);
      pool.group.matrixWorld.toArray(slotMatrices, slotIndex * 16);
      for (const candidate of this.config.collect(pool)) {
        if (overflowReason) break;
        const count = (candidate.source.userData as { n?: number }).n ?? 0;
        if (count <= 0) continue;
        if (cursor + count > this.config.capacity) {
          overflowReason = `instance capacity ${cursor + count}/${this.config.capacity}`;
          break;
        }
        const shadow = candidate.managed.castShadow === true;
        const route: LowMasonryRoute = candidate.visibility === "far"
          ? (shadow ? LOW_MASONRY_ROUTE.farShadow : LOW_MASONRY_ROUTE.farPlain)
          : candidate.visibility === "far-middle"
            ? (shadow ? LOW_MASONRY_ROUTE.farMiddleShadow : LOW_MASONRY_ROUTE.farMiddlePlain)
            : candidate.visibility === "middle"
              ? (shadow ? LOW_MASONRY_ROUTE.middleShadow : LOW_MASONRY_ROUTE.middlePlain)
              : (shadow ? LOW_MASONRY_ROUTE.allShadow : LOW_MASONRY_ROUTE.allPlain);
        const start = cursor;
        candidate.source.updateMatrix();
        for (let localIndex = 0; localIndex < count; localIndex++) {
          candidate.source.getMatrixAt(localIndex, _local);
          _world.multiplyMatrices(candidate.source.matrix, _local);
          _world.toArray(matrices, cursor * 16);
          if (candidate.source.instanceColor) candidate.source.getColorAt(localIndex, _color);
          else _color.setRGB(1, 1, 1);
          const colorOffset = cursor * 4;
          colors[colorOffset] = _color.r;
          colors[colorOffset + 1] = _color.g;
          colors[colorOffset + 2] = _color.b;
          colors[colorOffset + 3] = packInstanceMeta(
            { slot: slotIndex, lod: pool.lodLevel, group: route }, GROUP_COUNT,
          );
          cursor++;
        }
        ranges.push({ start, count, route, managed: candidate.managed });
        this.bucketSources[shadow ? 0 : 1] += count;
        setGpuSceneManaged(candidate.managed, true);
        this.managedMeshes.push(candidate.managed);
        managedRenderObjects++;
      }
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
    this.applyBucketVisibility();
    this.stats.enabled = this.active;
    this.stats.sourceInstances = cursor;
    this.stats.activeSourceInstances = this.countActiveInstances();
    this.stats.sourceRenderObjects = managedRenderObjects;
    this.stats.submittedBuckets = this.bucketSources.filter((count) => count > 0).length;
    this.stats.slotCount = this.compactSlots.length;
    this.stats.rebuilds++;
    this.stats.lastRebuildMs = performance.now() - started;
    this.stats.fallbackReason = this.active ? "" : `no low ${this.config.name}`;
    return this.active;
  }

  private applyBucketVisibility(): void {
    this.buckets[0].mesh.visible = this.active && this.bucketSources[0] > 0;
    this.buckets[0].mesh.receiveShadow = this.bucketSources[0] > 0;
    this.buckets[0].mesh.castShadow = this.shadowsEnabled && this.bucketSources[0] > 0;
    this.buckets[1].mesh.visible = this.active && this.bucketSources[1] > 0;
    this.buckets[1].mesh.receiveShadow = false;
    this.buckets[1].mesh.castShadow = false;
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
    console.warn(`[gpu-low-surface:${this.config.name}] fallback: ${reason}`);
    this.releaseManagedMeshes();
    return false;
  }

  private releaseManagedMeshes(): void {
    const poolBySlot = new Map(gpuSceneSlotPools().map((pool) => [pool.slot, pool]));
    const affected = new Set<SlotPool>();
    for (const mesh of this.managedMeshes) {
      setGpuSceneManaged(mesh, false);
      const count = (mesh.userData as { n?: number }).n ?? 0;
      mesh.count = count;
      mesh.visible = count > 0;
      const slot = (mesh.parent?.userData as { slot?: number } | undefined)?.slot;
      const pool = slot === undefined ? undefined : poolBySlot.get(slot);
      if (pool) affected.add(pool);
    }
    this.managedMeshes = [];
    for (const pool of affected) setSlotLodLevel(pool.slot, pool.lodLevel);
  }

  setOccludingSlots(next: ReadonlySet<number>): void {
    if (!this.config.occlusionFallback) return;
    let changed = next.size !== this.occludingSlots.size;
    if (!changed) for (const slot of next) if (!this.occludingSlots.has(slot)) { changed = true; break; }
    if (!changed) return;
    this.occludingSlots.clear();
    for (const slot of next) this.occludingSlots.add(slot);
    for (const compact of this.compactSlots) {
      const managed = !this.occludingSlots.has(compact.pool.slot);
      for (const range of compact.ranges) setGpuSceneManaged(range.managed, managed);
      setSlotLodLevel(compact.pool.slot, compact.pool.lodLevel);
    }
    this.dirty = true;
  }

  enableShadows(): boolean {
    if (!this.active || this.shadowsEnabled || this.bucketSources[0] === 0) return false;
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
      const next = slot.pool.group.visible
        && (!this.config.occlusionFallback || !this.occludingSlots.has(slot.pool.slot))
        ? slot.pool.lodLevel
        : HIDDEN_LOD;
      for (const range of slot.ranges) {
        if (lowMasonryBucket(range.route, next)) activeSourceInstances += range.count;
      }
      if (slot.level === next) continue;
      slot.level = next;
      for (const range of slot.ranges) {
        for (let i = range.start; i < range.start + range.count; i++) {
          colors[i * 4 + 3] = packInstanceMeta(
            { slot: slot.index, lod: next, group: range.route }, GROUP_COUNT,
          );
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

  async readbackValidation(): Promise<GpuLowSurfacePassValidation> {
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

/** Banners and red ritual tiles survive every public LOD and never take part
 * in local occlusion fading. A fixed CPU merge is therefore cheaper than a
 * sixth/seventh compute pass: 38 per-slot render objects become two ordinary
 * global InstancedMeshes, while source meshes remain available as rebuild
 * authority exactly like the compute-compacted surfaces. */
class GpuStaticDecorPass {
  readonly group = new THREE.Group();
  readonly stats: GpuLowSurfacePassStats;

  private readonly mesh: THREE.InstancedMesh;
  private managedMeshes: THREE.InstancedMesh[] = [];
  private active = false;
  private shadowsEnabled = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly config: StaticDecorConfig,
    private readonly requested: boolean,
  ) {
    this.group.name = `gpu-scene-global-decor-${config.name}`;
    this.group.visible = false;
    this.scene.add(this.group);
    this.mesh = new THREE.InstancedMesh(config.geometry, config.material, config.capacity);
    this.mesh.name = this.group.name;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(config.capacity * 3), 3,
    );
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = config.shadows;
    this.group.add(this.mesh);
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
      capacity: config.capacity,
      fallbackReason: requested ? "not built" : "disabled by ?gpuscene=0",
    };
  }

  rebuild(): boolean {
    const started = performance.now();
    this.releaseManagedMeshes();
    this.active = false;
    this.group.visible = false;
    this.mesh.visible = false;
    this.mesh.count = 0;
    Object.assign(this.stats, {
      enabled: false,
      sourceInstances: 0,
      activeSourceInstances: 0,
      sourceRenderObjects: 0,
      submittedBuckets: 0,
      slotCount: 0,
    });
    if (!this.requested) return false;

    const pools = gpuSceneSlotPools();
    const matrices = this.mesh.instanceMatrix.array as Float32Array;
    const colors = this.mesh.instanceColor!.array as Float32Array;
    let cursor = 0;
    let sourceRenderObjects = 0;
    let slotCount = 0;
    for (const pool of pools) {
      const source = pool.meshes.get(this.config.key);
      const count = (source?.userData as { n?: number } | undefined)?.n ?? 0;
      if (!source || count <= 0) continue;
      if (cursor + count > this.config.capacity) {
        this.stats.fallbackReason = `instance capacity ${cursor + count}/${this.config.capacity}`;
        this.releaseManagedMeshes();
        console.warn(`[gpu-global-decor:${this.config.name}] fallback: ${this.stats.fallbackReason}`);
        return false;
      }
      source.updateWorldMatrix(true, false);
      for (let localIndex = 0; localIndex < count; localIndex++) {
        source.getMatrixAt(localIndex, _local);
        _world.multiplyMatrices(source.matrixWorld, _local);
        _world.toArray(matrices, cursor * 16);
        if (source.instanceColor) source.getColorAt(localIndex, _color);
        else _color.setRGB(1, 1, 1);
        colors[cursor * 3] = _color.r;
        colors[cursor * 3 + 1] = _color.g;
        colors[cursor * 3 + 2] = _color.b;
        cursor++;
      }
      setGpuSceneManaged(source, true);
      this.managedMeshes.push(source);
      sourceRenderObjects++;
      slotCount++;
    }

    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceColor!.clearUpdateRanges();
    if (cursor > 0) {
      this.mesh.instanceMatrix.addUpdateRange(0, cursor * 16);
      this.mesh.instanceColor!.addUpdateRange(0, cursor * 3);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    this.mesh.count = cursor;
    this.mesh.visible = cursor > 0;
    if (cursor > 0) this.mesh.computeBoundingSphere();
    this.active = cursor > 0;
    this.group.visible = this.active;
    Object.assign(this.stats, {
      enabled: this.active,
      sourceInstances: cursor,
      activeSourceInstances: cursor,
      sourceRenderObjects,
      submittedBuckets: this.active ? 1 : 0,
      slotCount,
      rebuilds: this.stats.rebuilds + 1,
      lastRebuildMs: performance.now() - started,
      fallbackReason: this.active ? "" : `no ${this.config.name}`,
    });
    return this.active;
  }

  setVisible(visible: boolean): boolean {
    const wasVisible = this.group.visible;
    this.group.visible = visible && this.active;
    return !wasVisible && this.group.visible && this.config.shadows;
  }

  enableShadows(): boolean {
    if (!this.active || !this.config.shadows || this.shadowsEnabled) return false;
    this.shadowsEnabled = true;
    this.mesh.castShadow = true;
    return true;
  }

  readbackValidation(): GpuLowSurfacePassValidation {
    const count = this.active ? this.mesh.count : 0;
    return {
      shadow: this.config.shadows ? count : 0,
      plain: this.config.shadows ? 0 : count,
      unmatchedSourceIds: 0,
      misroutedInstances: 0,
    };
  }

  dispose(): void {
    this.releaseManagedMeshes();
    this.group.removeFromParent();
    this.mesh.dispose();
  }

  private releaseManagedMeshes(): void {
    const poolBySlot = new Map(gpuSceneSlotPools().map((pool) => [pool.slot, pool]));
    const affected = new Set<SlotPool>();
    for (const mesh of this.managedMeshes) {
      setGpuSceneManaged(mesh, false);
      const count = (mesh.userData as { n?: number }).n ?? 0;
      mesh.count = count;
      mesh.visible = count > 0;
      const slot = (mesh.parent?.userData as { slot?: number } | undefined)?.slot;
      const pool = slot === undefined ? undefined : poolBySlot.get(slot);
      if (pool) affected.add(pool);
    }
    this.managedMeshes = [];
    for (const pool of affected) setSlotLodLevel(pool.slot, pool.lodLevel);
  }
}

export class GpuLowSurfaces {
  readonly stats: GpuLowSurfacesStats;
  private readonly tiles: GpuLowSurfacePass;
  private readonly steps: GpuLowSurfacePass;
  private readonly columns: GpuLowSurfacePass;
  private readonly planks: GpuLowSurfacePass;
  private readonly banners: GpuStaticDecorPass;
  private readonly redTiles: GpuStaticDecorPass;
  private readonly passes: readonly GpuLowSurfacePass[];
  private readonly decorPasses: readonly GpuStaticDecorPass[];

  constructor(scene: THREE.Scene, renderer: THREE.WebGPURenderer, requested = true) {
    const R = getKit();
    this.tiles = new GpuLowSurfacePass(scene, renderer, {
      name: "tiles",
      capacity: 32_768,
      geometry: R.tileGeoLo,
      materialFactory: (stableId) => makeStoneFloorMat(stableId),
      occlusionFallback: false,
      collect: (pool) => {
        const sources: SurfaceSource[] = [];
        const far = pool.meshes.get("tilesLo");
        if (far) sources.push({
          source: far,
          managed: far,
          visibility: pool.meshes.has("tilesMidLo") ? "far" : "far-middle",
        });
        const source = pool.meshes.get("tiles");
        const middle = pool.meshes.get("tilesMidLo");
        if (source && middle) sources.push({ source, managed: middle, visibility: "middle" });
        return sources;
      },
    }, requested);
    this.steps = new GpuLowSurfacePass(scene, renderer, {
      name: "steps",
      capacity: 32_768,
      geometry: R.stepGeo,
      materialFactory: (stableId) => makeStoneFloorMat(stableId),
      occlusionFallback: false,
      collect: (pool) => {
        const source = pool.meshes.get("steps");
        const managed = pool.meshes.get("stepsLo");
        return source && managed ? [{ source, managed, visibility: "far-middle" }] : [];
      },
    }, requested);
    this.columns = new GpuLowSurfacePass(scene, renderer, {
      name: "columns",
      capacity: 8_192,
      geometry: R.colGeo,
      materialFactory: (stableId) => makeStoneLoMat(stableId),
      occlusionFallback: true,
      collect: (pool) => {
        const source = pool.meshes.get("cols");
        const managed = pool.meshes.get("colsLo");
        return source && managed ? [{ source, managed, visibility: "far-middle" }] : [];
      },
    }, requested);
    this.planks = new GpuLowSurfacePass(scene, renderer, {
      name: "planks",
      capacity: 2_048,
      geometry: R.plankGeo,
      materialFactory: () => new THREE.MeshLambertNodeMaterial(),
      occlusionFallback: false,
      collect: (pool) => {
        const planks = pool.meshes.get("ravinePlanks");
        return planks ? [{ source: planks, managed: planks, visibility: "all" }] : [];
      },
    }, requested);
    this.banners = new GpuStaticDecorPass(scene, {
      name: "banners",
      key: "banners",
      capacity: 512,
      geometry: R.bannerGeo,
      material: R.bannerMat,
      shadows: false,
    }, requested);
    this.redTiles = new GpuStaticDecorPass(scene, {
      name: "redTiles",
      key: "redTiles",
      capacity: 2_048,
      geometry: R.tileGeo,
      material: R.redMat,
      shadows: true,
    }, requested);
    this.passes = [this.tiles, this.steps, this.columns, this.planks];
    this.decorPasses = [this.banners, this.redTiles];
    this.stats = {
      enabled: false,
      sourceInstances: 0,
      activeSourceInstances: 0,
      sourceRenderObjects: 0,
      submittedBuckets: 0,
      tiles: this.tiles.stats,
      steps: this.steps.stats,
      columns: this.columns.stats,
      planks: this.planks.stats,
      banners: this.banners.stats,
      redTiles: this.redTiles.stats,
    };
  }

  private updateStats(): void {
    const all = [...this.passes, ...this.decorPasses];
    this.stats.enabled = all.some((pass) => pass.stats.enabled);
    this.stats.sourceInstances = all.reduce((sum, pass) => sum + pass.stats.sourceInstances, 0);
    this.stats.activeSourceInstances = all.reduce((sum, pass) => sum + pass.stats.activeSourceInstances, 0);
    this.stats.sourceRenderObjects = all.reduce((sum, pass) => sum + pass.stats.sourceRenderObjects, 0);
    this.stats.submittedBuckets = all.reduce((sum, pass) => sum + pass.stats.submittedBuckets, 0);
  }

  rebuild(): boolean {
    const active = [...this.passes, ...this.decorPasses].map((pass) => pass.rebuild()).some(Boolean);
    this.updateStats();
    return active;
  }

  tick(camera: THREE.Camera): void {
    for (const pass of this.passes) pass.tick(camera);
    this.updateStats();
  }

  setOccludingSlots(next: ReadonlySet<number>): void {
    for (const pass of this.passes) pass.setOccludingSlots(next);
  }

  /** Startup-only presentation gate. Compute/storage state stays resident;
   * only the four final-context surface render objects wait for their own
   * shared-ScenePass preview frame. */
  setVisible(visible: boolean): void {
    for (const pass of this.passes) {
      pass.group.visible = visible && pass.stats.enabled;
    }
  }

  /** Startup keeps all-LOD decor out of the shared ScenePass previews. It is
   * revealed in one dedicated two-object frame before the remaining detail
   * queue; return whether that frame adds a static shadow caster. */
  setDecorVisible(visible: boolean): boolean {
    return this.decorPasses.map((pass) => pass.setVisible(visible)).some(Boolean);
  }

  hasDecor(): boolean {
    return this.decorPasses.some((pass) => pass.stats.enabled);
  }

  enableShadows(): boolean {
    return [...this.passes, ...this.decorPasses].map((pass) => pass.enableShadows()).some(Boolean);
  }

  async readbackValidation(): Promise<GpuLowSurfacesValidation> {
    const [tiles, steps, columns, planks, banners, redTiles] = await Promise.all([
      this.tiles.readbackValidation(),
      this.steps.readbackValidation(),
      this.columns.readbackValidation(),
      this.planks.readbackValidation(),
      this.banners.readbackValidation(),
      this.redTiles.readbackValidation(),
    ]);
    return { tiles, steps, columns, planks, banners, redTiles };
  }

  dispose(): void {
    for (const pass of [...this.passes, ...this.decorPasses]) pass.dispose();
  }
}
