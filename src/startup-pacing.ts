export function parseStartupBatch(
  value: string | null,
  fallback: number,
  max: number,
  min = 1,
): number {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, Math.round(parsed)))
    : fallback;
}

/** Three.js keeps `visible` local to each Object3D. A drawable child can still
 * report `visible === true` while a hidden parent makes it impossible to reach
 * any render pass. Startup streaming must use the composed state or it wastes
 * cold WebGPU render-object work on dormant subtrees. */
export interface VisibilityNode {
  visible: boolean;
  parent: VisibilityNode | null;
}

export function isEffectivelyVisible(object: VisibilityNode): boolean {
  let current: VisibilityNode | null = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

export interface RenderWorkMaterial {
  type: string;
  isMeshStandardMaterial?: boolean;
}

export interface RenderWorkNode {
  visible?: boolean;
  castShadow?: boolean;
  material?: RenderWorkMaterial | RenderWorkMaterial[];
  children?: RenderWorkNode[];
}

/** Approximate cold WebGPU realization work, not visual complexity. Standard
 * node materials create a materially larger graph than unlit batches, shadow
 * casters need a second path, and a group is charged for its visible subtree
 * instead of pretending that an oracle shell plus three eye batches is one
 * object. The result is deliberately small/integer so URL pacing remains easy
 * to reason about. */
export function startupRenderWork(object: RenderWorkNode): number {
  const materials = object.material
    ? (Array.isArray(object.material) ? object.material : [object.material])
    : [];
  if (materials.length > 0) {
    const standard = materials.some((material) => (
      material.type === "MeshStandardNodeMaterial"
      || material.type === "MeshPhysicalNodeMaterial"
      || material.isMeshStandardMaterial === true
    ));
    return 1 + Number(standard) + Number(object.castShadow === true);
  }
  const childWork = object.children?.reduce((sum, child) => (
    child.visible === false ? sum : sum + startupRenderWork(child)
  ), 0) ?? 0;
  return Math.max(1, childWork);
}
