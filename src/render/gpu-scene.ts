// GPU-driven masonry scene, phase 1.
//
// CPU slot pools remain the authoring, picking and destruction authority. The
// renderer-facing middle-course bricks are copied once into stable global SoA
// buffers. A compute pass rejects dead/offscreen/far instances, compacts the
// survivors into two LOD buckets and writes drawIndexedIndirect counts.

import * as THREE from "three/webgpu";
import {
  Fn, If, atomicAdd, atomicStore, instanceIndex, max, storage, uniform, uint, vec4,
} from "three/tsl";
import { getKit } from "../scene/kit";
import { makeStoneLoMat, makeStoneMat } from "../scene/kit/materials";
import {
  gpuSceneSlotPools, setGpuSceneManaged, setSlotLodLevel,
  type SlotPool,
} from "../scene/slots";

const CAPACITY = 65_536;
const SLOT_CAPACITY = 128;
const DEAD_ID = 0xffff_ffff;
const CULL_MARGIN = 5;
const MANAGED_KEYS = [
  "blockMids", "blockMidsLo", "blockMidsFade", "blockMidsLoFade",
] as const;

type ComputeNode = any;

interface GpuBucket {
  mesh: THREE.InstancedMesh;
  geometry: THREE.BufferGeometry;
  matrices: THREE.StorageInstancedBufferAttribute;
  colors: THREE.StorageInstancedBufferAttribute;
  matrixNode: any;
  colorNode: any;
  indirectBase: number;
}

type CompactedMaterialFactory = (stableSourceId: any) => THREE.Material;

interface CompactSlot {
  pool: SlotPool;
  index: number;
  start: number;
  count: number;
  level: number;
  worldMatrix: THREE.Matrix4;
}

export interface GpuSceneStats {
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

export interface GpuSceneReadbackValidation {
  high: number;
  middle: number;
  unmatchedMatrices: number;
  nonFiniteMatrices: number;
  authoritativeMismatches: number;
  maxAuthoritativeTranslationDelta: number;
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
}

const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _color = new THREE.Color(1, 1, 1);

export class GpuMasonryScene {
  readonly group = new THREE.Group();
  readonly stats: GpuSceneStats;

  private readonly sourceMatrices = new THREE.StorageBufferAttribute(CAPACITY, 16);
  // RGB tint + packed alive/slot/LOD metadata. Packing removes a separate
  // storage binding; LOD changes upload only that slot's contiguous range.
  private readonly sourceColors = new THREE.StorageBufferAttribute(CAPACITY, 4);
  // Per-island world transforms keep source instances in stable local space.
  // Rise animations/streaming then upload at most SLOT_CAPACITY matrices rather
  // than rewriting every brick transform.
  private readonly slotMatrices = new THREE.StorageBufferAttribute(SLOT_CAPACITY, 16);
  // Both five-u32 drawIndexedIndirect commands share one binding.
  private readonly indirect = new THREE.IndirectStorageBufferAttribute(new Uint32Array(10), 1);
  private readonly indirectNode = storage(this.indirect, "uint", 10).toAtomic();
  private readonly planeNodes = Array.from({ length: 6 }, () => uniform(new THREE.Vector4()));
  private readonly projection = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly buckets: [GpuBucket, GpuBucket];
  private readonly resetNode: ComputeNode;
  private readonly cullNode: ComputeNode;
  private readonly sourceToGlobal = new WeakMap<THREE.InstancedMesh, Uint32Array>();
  private managedMeshes: THREE.InstancedMesh[] = [];
  private compactSlots: CompactSlot[] = [];
  private readonly lastCameraPosition = new THREE.Vector3(Infinity, Infinity, Infinity);
  private readonly lastCameraQuaternion = new THREE.Quaternion();
  private sourceCount = 0;
  private active = false;
  private readonly occludingSlots = new Set<number>();
  private indirectHasDraws = false;
  private dirty = true;
  private requested: boolean;
  private failed = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGPURenderer,
    requested = true,
  ) {
    this.requested = requested;
    this.group.name = "gpu-scene-masonry";
    this.group.visible = false;
    this.scene.add(this.group);

    const R = getKit();
    this.buckets = [
      this.makeBucket(
        "gpu-scene-masonry-high", R.blockMiddleGeo,
        (stableSourceId) => makeStoneMat(undefined, stableSourceId), 0,
      ),
      this.makeBucket(
        "gpu-scene-masonry-mid", R.blockGeoLo,
        (stableSourceId) => makeStoneLoMat(stableSourceId), 5,
      ),
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

    // Exactly eight storage bindings: 3 source + 4 output + 1 indirect. This
    // deliberately targets WebGPU's portable minimum instead of the author's
    // GPU. One scan fills both LOD buckets.
    this.cullNode = Fn(() => {
      const sourceIndex = instanceIndex;
      const sourceColor = sourceColors.element(sourceIndex);
      // Destroyed items encode zero. Clamp before unsigned subtraction so a
      // dead item can never form an out-of-bounds slot index, even though its
      // final visibility predicate is false.
      const encoded = uint(max(sourceColor.w, 1)).sub(uint(1));
      const slotIndex = encoded.div(uint(4));
      const lod = encoded.mod(uint(4));
      const worldMatrix = slotMatrices.element(slotIndex).mul(sourceMatrices.element(sourceIndex));
      const center = worldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
      let visible: any = sourceColor.w.greaterThan(0.5).and(lod.greaterThan(uint(0)));
      for (const plane of this.planeNodes) {
        visible = visible.and(
          plane.xyz.dot(center).add(plane.w).greaterThanEqual(-CULL_MARGIN),
        );
      }
      If(visible, () => {
        If(lod.greaterThan(uint(1)), () => {
          this.append(this.buckets[0], sourceIndex, worldMatrix, sourceColor);
        }).Else(() => {
          this.append(this.buckets[1], sourceIndex, worldMatrix, sourceColor);
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

  private append(bucket: GpuBucket, sourceIndex: any, worldMatrix: any, sourceColor: any): void {
    const destination = atomicAdd(this.indirectNode.element(bucket.indirectBase + 1), uint(1)).toVar();
    bucket.matrixNode.element(destination).assign(worldMatrix);
    // RGB remains the authored tint. W is ignored by Three's vec3 instance
    // color path, so retain the stable source id there for debug readback and
    // the future GPU-picking/destruction event stream.
    bucket.colorNode.element(destination).assign(vec4(sourceColor.xyz, sourceIndex));
  }

  private makeBucket(
    name: string,
    sourceGeometry: THREE.BufferGeometry,
    materialFactory: CompactedMaterialFactory,
    indirectBase: number,
  ): GpuBucket {
    const geometry = sourceGeometry.clone();
    // Keep one five-u32 command layout. A trivial sequential index is cheaper
    // than a divergent non-indexed indirect pipeline for this tiny geometry.
    if (!geometry.index) {
      const vertexCount = geometry.getAttribute("position").count;
      geometry.setIndex(Array.from({ length: vertexCount }, (_, i) => i));
    }
    geometry.setIndirect(this.indirect, indirectBase * Uint32Array.BYTES_PER_ELEMENT);
    const matrices = new THREE.StorageInstancedBufferAttribute(CAPACITY, 16);
    // vec4 gives storage arrays a natural 16-byte stride; the render path reads
    // xyz through Three's standard instanceColor varying.
    const colors = new THREE.StorageInstancedBufferAttribute(CAPACITY, 4);
    // The compute pass stores immutable sourceIndex in color.w. Read the same
    // storage attribute directly in the render graph: `instanceColor`'s public
    // varying is vec3 and intentionally discards w, while attribute() only
    // searches geometry and therefore cannot address InstancedMesh buffers.
    const stableSourceId = storage(colors, "vec4", CAPACITY)
      .toReadOnly().element(instanceIndex).w;
    const material = materialFactory(stableSourceId);
    const mesh = new THREE.InstancedMesh(geometry, material, CAPACITY);
    mesh.name = name;
    mesh.instanceMatrix = matrices;
    mesh.instanceColor = colors;
    mesh.count = CAPACITY; // GPU-written indirect instanceCount is authoritative
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.visible = false;
    this.group.add(mesh);
    return {
      mesh,
      geometry,
      matrices,
      colors,
      matrixNode: storage(matrices, "mat4", CAPACITY),
      colorNode: storage(colors, "vec4", CAPACITY),
      indirectBase,
    };
  }

  /** Repack immutable source data after a forge. This is the only O(N) CPU
   * path; normal active frames update six planes and dispatch one kernel. */
  rebuild(): boolean {
    const started = performance.now();
    this.releaseManagedMeshes();
    this.active = false;
    this.indirectHasDraws = false;
    this.dirty = true;
    this.lastCameraPosition.set(Infinity, Infinity, Infinity);
    this.group.visible = false;
    this.sourceCount = 0;
    this.compactSlots = [];
    this.stats.sourceInstances = 0;
    this.stats.activeSourceInstances = 0;
    this.stats.sourceRenderObjects = 0;
    this.stats.submittedBuckets = 0;
    this.stats.hiddenInstances = 0;

    if (!this.requested || this.failed) return false;
    const pools = gpuSceneSlotPools().filter((pool) => pool.meshes.has("blockMids"));
    if (pools.length > SLOT_CAPACITY) return this.fail(`slot capacity ${pools.length}/${SLOT_CAPACITY}`);

    const matrices = this.sourceMatrices.array as Float32Array;
    const colors = this.sourceColors.array as Float32Array;
    const slotMatrices = this.slotMatrices.array as Float32Array;
    let cursor = 0;
    let activeSourceInstances = 0;

    for (let slotIndex = 0; slotIndex < pools.length; slotIndex++) {
      const pool = pools[slotIndex];
      const source = pool.meshes.get("blockMids")!;
      const count = (source.userData as { n?: number }).n ?? 0;
      if (cursor + count > CAPACITY) return this.fail(`instance capacity ${cursor + count}/${CAPACITY}`);
      pool.group.updateWorldMatrix(true, true);
      source.updateWorldMatrix(true, false);
      const mapping = new Uint32Array(count);
      mapping.fill(DEAD_ID);
      const start = cursor;
      const level = pool.group.visible ? pool.lodLevel : 0;
      pool.group.updateWorldMatrix(true, false);
      pool.group.matrixWorld.toArray(slotMatrices, slotIndex * 16);
      const cachedWorldMatrix = pool.group.matrixWorld.clone();

      for (let localIndex = 0; localIndex < count; localIndex++) {
        source.getMatrixAt(localIndex, _local);
        // blockMids is a direct pool child. Keep this transform pool-local so
        // one slot matrix can move every authored brick on the GPU.
        source.updateMatrix();
        _world.multiplyMatrices(source.matrix, _local);
        _world.toArray(matrices, cursor * 16);
        if (source.instanceColor) source.getColorAt(localIndex, _color);
        else _color.setRGB(1, 1, 1);
        const colorOffset = cursor * 4;
        colors[colorOffset] = _color.r;
        colors[colorOffset + 1] = _color.g;
        colors[colorOffset + 2] = _color.b;
        // 0 is destroyed. Alive metadata packs slot + two-bit LOD in one float
        // and remains exact far beyond SLOT_CAPACITY.
        colors[colorOffset + 3] = slotIndex * 4 + level + 1;
        mapping[localIndex] = cursor++;
      }

      this.sourceToGlobal.set(source, mapping);
      this.compactSlots.push({
        pool, index: slotIndex, start, count, level, worldMatrix: cachedWorldMatrix,
      });
      if (level > 0) activeSourceInstances += count;
      for (const key of MANAGED_KEYS) {
        const mesh = pool.meshes.get(key);
        if (!mesh) continue;
        setGpuSceneManaged(mesh, true);
        this.managedMeshes.push(mesh);
      }
    }

    this.sourceCount = cursor;
    this.markFullUpload(this.sourceMatrices, cursor * 16);
    this.markFullUpload(this.sourceColors, cursor * 4);
    this.markFullUpload(this.slotMatrices, pools.length * 16);

    this.active = cursor > 0;
    this.group.visible = this.active;
    this.applyBucketVisibility();
    this.stats.enabled = this.active;
    this.stats.sourceInstances = cursor;
    this.stats.activeSourceInstances = activeSourceInstances;
    this.stats.sourceRenderObjects = pools.length;
    this.stats.submittedBuckets = this.active ? 2 : 0;
    this.stats.slotCount = pools.length;
    this.stats.rebuilds++;
    this.stats.lastRebuildMs = performance.now() - started;
    this.stats.fallbackReason = this.active ? "" : "no middle-course masonry";
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
    console.warn(`[gpu-scene] fallback: ${reason}`);
    this.releaseManagedMeshes();
    return false;
  }

  private releaseManagedMeshes(): void {
    const poolBySlot = new Map(gpuSceneSlotPools().map((pool) => [pool.slot, pool]));
    const affected = new Set<SlotPool>();
    for (const mesh of this.managedMeshes) {
      setGpuSceneManaged(mesh, false);
      const slot = (mesh.parent?.userData as { slot?: number } | undefined)?.slot;
      if (slot !== undefined) {
        const owner = poolBySlot.get(slot);
        if (owner) affected.add(owner);
      }
    }
    this.managedMeshes = [];
    for (const pool of affected) setSlotLodLevel(pool.slot, pool.lodLevel);
  }

  /** CPU-authoritative destruction clears packed metadata. The next cull
   * naturally excludes that stable id from both buckets. */
  hideSourceInstance(source: THREE.InstancedMesh, localIndex: number): void {
    if (!this.active) return;
    const globalIndex = this.sourceToGlobal.get(source)?.[localIndex] ?? DEAD_ID;
    if (globalIndex === DEAD_ID || globalIndex >= this.sourceCount) return;
    const colors = this.sourceColors.array as Float32Array;
    const metadataOffset = globalIndex * 4 + 3;
    if (colors[metadataOffset] <= 0) return;
    colors[metadataOffset] = 0;
    this.sourceColors.addUpdateRange(metadataOffset, 1);
    this.sourceColors.needsUpdate = true;
    this.stats.hiddenInstances++;
    this.dirty = true;
  }

  /** Debug/benchmark only: never call from the frame loop because GPU readback
   * introduces a synchronization point. */
  async readbackDrawCounts(): Promise<{ high: number; middle: number }> {
    const bytes = await this.renderer.getArrayBufferAsync(this.indirect);
    const args = new Uint32Array(bytes);
    return { high: args[1] ?? 0, middle: args[6] ?? 0 };
  }

  /** Benchmark-only integrity probe. It checks stable source IDs and authored
   * transforms within GPU float tolerance; never used by the live path. */
  async readbackValidation(): Promise<GpuSceneReadbackValidation> {
    const counts = await this.readbackDrawCounts();
    const [highBytes, middleBytes, highColorBytes, middleColorBytes] = await Promise.all([
      this.renderer.getArrayBufferAsync(this.buckets[0].matrices),
      this.renderer.getArrayBufferAsync(this.buckets[1].matrices),
      this.renderer.getArrayBufferAsync(this.buckets[0].colors),
      this.renderer.getArrayBufferAsync(this.buckets[1].colors),
    ]);
    const authored = this.sourceMatrices.array as Float32Array;
    const expected = new Float32Array(this.sourceCount * 16);
    for (const slot of this.compactSlots) {
      slot.pool.group.updateWorldMatrix(true, false);
      for (let localIndex = 0; localIndex < slot.count; localIndex++) {
        _local.fromArray(authored, (slot.start + localIndex) * 16);
        _world.multiplyMatrices(slot.pool.group.matrixWorld, _local);
        _world.toArray(expected, (slot.start + localIndex) * 16);
      }
    }
    let unmatchedMatrices = 0;
    let nonFiniteMatrices = 0;
    let authoritativeMismatches = 0;
    let maxAuthoritativeTranslationDelta = 0;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const validate = (bytes: ArrayBuffer, colorBytes: ArrayBuffer, count: number) => {
      const values = new Float32Array(bytes);
      const outputColors = new Float32Array(colorBytes);
      for (let i = 0; i < count; i++) {
        const sourceIndex = Math.round(outputColors[i * 4 + 3]);
        if (sourceIndex < 0 || sourceIndex >= this.sourceCount) {
          unmatchedMatrices++;
        } else {
          for (let component = 0; component < 16; component++) {
            if (Math.abs(
              values[i * 16 + component] - expected[sourceIndex * 16 + component],
            ) > 0.005) {
              unmatchedMatrices++;
              break;
            }
          }
        }
        const x = values[i * 16 + 12], y = values[i * 16 + 13], z = values[i * 16 + 14];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          nonFiniteMatrices++;
          continue;
        }
        min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z);
        max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z);
      }
    };
    validate(highBytes, highColorBytes, counts.high);
    validate(middleBytes, middleColorBytes, counts.middle);
    for (const slot of this.compactSlots) {
      const mesh = slot.pool.meshes.get("blockMids");
      if (!mesh) continue;
      mesh.updateWorldMatrix(true, false);
      for (let localIndex = 0; localIndex < slot.count; localIndex++) {
        mesh.getMatrixAt(localIndex, _local);
        _world.multiplyMatrices(mesh.matrix, _local);
        const elements = _world.elements;
        const sourceOffset = (slot.start + localIndex) * 16;
        let differs = false;
        for (let component = 0; component < 16; component++) {
          if (Math.abs(elements[component] - authored[sourceOffset + component]) > 1e-4) {
            differs = true;
            break;
          }
        }
        if (!differs) continue;
        authoritativeMismatches++;
        const dx = elements[12] - authored[sourceOffset + 12];
        const dy = elements[13] - authored[sourceOffset + 13];
        const dz = elements[14] - authored[sourceOffset + 14];
        maxAuthoritativeTranslationDelta = Math.max(
          maxAuthoritativeTranslationDelta,
          Math.sqrt(dx * dx + dy * dy + dz * dz),
        );
      }
    }
    const total = counts.high + counts.middle;
    return {
      ...counts,
      unmatchedMatrices,
      nonFiniteMatrices,
      authoritativeMismatches,
      maxAuthoritativeTranslationDelta,
      bounds: total > 0
        ? { min: min as [number, number, number], max: max as [number, number, number] }
        : null,
    };
  }

  /** Keep ordinary slots globally compacted, but hand the one architecture
   * actually obscuring the player back to its per-slot fade twin. This avoids
   * fading the whole dungeon just because one wall crosses the sight line. */
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
      // slots.ts owns the exact high/mid/fade visibility mapping.
      setSlotLodLevel(compact.pool.slot, compact.pool.lodLevel);
    }
    this.dirty = true;
  }

  private applyBucketVisibility(): void {
    for (const bucket of this.buckets) bucket.mesh.visible = this.active;
  }

  /** Must run after CPU LOD decisions and before the render pass. */
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

  /** LOD changes are already rate-limited to one island per frame. Updating
   * the fourth color component then is much cheaper than binding a ninth
   * storage buffer on every culling dispatch. */
  private syncSlotLevels(): { activeSourceInstances: number; changed: boolean } {
    const colors = this.sourceColors.array as Float32Array;
    let active = 0;
    let changed = false;
    for (const slot of this.compactSlots) {
      const next = slot.pool.group.visible && !this.occludingSlots.has(slot.pool.slot)
        ? slot.pool.lodLevel : 0;
      if (next > 0) active += slot.count;
      if (slot.level === next) continue;
      slot.level = next;
      for (let i = slot.start; i < slot.start + slot.count; i++) {
        if (colors[i * 4 + 3] > 0) colors[i * 4 + 3] = slot.index * 4 + next + 1;
      }
      this.sourceColors.addUpdateRange(slot.start * 4, slot.count * 4);
      changed = true;
    }
    if (changed) this.sourceColors.needsUpdate = true;
    if (changed) this.dirty = true;
    return { activeSourceInstances: active, changed };
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

  dispose(): void {
    this.releaseManagedMeshes();
    this.group.removeFromParent();
    for (const bucket of this.buckets) {
      bucket.mesh.dispose();
      bucket.geometry.dispose();
      bucket.mesh.material.dispose();
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
