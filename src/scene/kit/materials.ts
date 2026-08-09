// Shared material kit — every material is created ONCE and reused across
// regenerations (pipeline compilation only ever happens on first sight).
//
// All glow goes through unlit HDR colorNodes (linear values > 1) so the
// threshold bloom picks it up and nothing else does. Pure-glow materials are
// MeshBasicNodeMaterial: they skip the whole light loop per fragment — crucial,
// since additive quads are the overdraw.

import * as THREE from "three/webgpu";
import {
  color, vec2, vec3, uv, time, sin, cos, positionLocal, positionWorld, positionView, normalLocal,
  instanceIndex, hash, smoothstep, length, fract, abs, mix, float, floor, atan, max, step,
  triNoise3D, transformNormalToView, attribute, uniform, texture as textureNode,
  varyingProperty,
} from "three/tsl";
import { CELL, COURSE } from "../../config";

/** global flicker damping, set per frame from the camera's distance to the
 *  nearest island: up close torches dance, from afar dozens of asynchronous
 *  flickers made the whole dungeon shimmer uncomfortably — so the oscillation
 *  amplitude fades toward a steady candle glow with distance. */
export const flickerDamp = uniform(1);

/** route-beam pulse count — RoutePath.show() sets it to curveLength/spacing
 *  so the streaming pulses keep constant world-unit spacing on any tour */
export const routeFlow = uniform(400);

/** One shared local-occlusion capsule for architecture fade twins. Updating
 * three uniforms is cheaper and visually much more precise than splitting
 * tens of thousands of instances into per-frame CPU draw lists. */
export const occlusionWindow = {
  camera: uniform(new THREE.Vector3(0, -1000, 0)),
  target: uniform(new THREE.Vector3(0, -1000, 1)),
  strength: uniform(0),
};

export function setOcclusionWindow(camera: THREE.Vector3, target: THREE.Vector3, strength: number): void {
  occlusionWindow.camera.value.copy(camera);
  occlusionWindow.target.value.copy(target);
  occlusionWindow.strength.value = Math.max(0, Math.min(1, strength));
}

function applyLocalOcclusionWindow(material: THREE.MeshLambertNodeMaterial): void {
  const segment = occlusionWindow.target.sub(occlusionWindow.camera);
  const fromCamera = positionWorld.sub(occlusionWindow.camera);
  const along = fromCamera.dot(segment).div(segment.dot(segment).max(0.0001)).clamp(0, 1);
  const closest = occlusionWindow.camera.add(segment.mul(along));
  const distance = length(positionWorld.sub(closest));
  // The reveal aperture widens toward the player, with a broad feather so the
  // wall seems to dissolve locally rather than switch as an entire island.
  const radius = along.mul(1.55).add(0.85);
  const aperture = smoothstep(radius.mul(0.42), radius, distance).oneMinus();
  const segmentMask = smoothstep(0.035, 0.11, along)
    .mul(smoothstep(0.94, 0.995, along).oneMinus());
  const fade = aperture.mul(segmentMask).mul(occlusionWindow.strength);
  material.opacityNode = mix(float(1), float(0.13), fade);
  // Alpha hash keeps off-aperture masonry truly opaque/depth-writing while
  // providing stable stochastic coverage inside the reveal window. This
  // avoids whole-slot transparent sorting artifacts and the double wall look.
  material.transparent = false;
  material.depthWrite = true;
  material.alphaHash = true;
  material.side = THREE.DoubleSide;
}

/** Live masonry art-direction controls. They stay uniforms so the visual
 * feedback harness can render and score 100 real WebGPU candidates without
 * rebuilding TSL pipelines between loops. The selected values remain the
 * production defaults after the search. */
export const stoneStyle = {
  // Selected by the reproducible 100-frame image-feedback search. Keep the
  // measured values rather than visually rounding them: the JSON report can
  // recreate loop 62 exactly for future comparisons.
  // Close-range correction after the first 100-loop pass: the wide camera's
  // histogram under-weighted the peppery 4.6x band visible in gameplay. Move
  // energy into broad brush planes and edge wear instead of black speckles.
  base: uniform(0.81),
  broadGrain: uniform(0.20),
  midGrain: uniform(0.07),
  fineGrain: uniform(0.026),
  mortar: uniform(0.52),
  streak: uniform(0.19),
  wear: uniform(0.24),
  pits: uniform(0.07),
  crack: uniform(0.50),
  warmEdge: uniform(0.31),
  /** Strength of the atlas-derived surface relief. This is what separates
   *  hand-carved stone from a machined bevel. */
  paintedRelief: uniform(1.0),
  /** Contrast of the generated albedo and cavity, both centred on 1.0 so they
   *  add surface without changing overall value. */
  stoneDetail: uniform(0.85),
  /** The per-instance tint stair towers never get, because they are plain
   *  Meshes rather than instanced masonry. Matches build.ts's class-3 wall
   *  colour, setHsl(0.60, 0.22, 0.405) — luma 0.380. Live via
   *  __df.stoneStyle.stairTint.value. */
  stairTint: uniform(new THREE.Color().setHSL(0.60, 0.22, 0.405)),
  /** How pale the worn band inside a flagstone's edge goes. The paving read
   *  lives here now rather than in a texture, so this is the dial that decides
   *  whether floors look laid or poured. */
  flagWear: uniform(0.30),
  /** Depth of the tile-local brush strokes across the middle of a slab. */
  flagBrush: uniform(0.22),
  /** Floor grain frequency, in texture repeats per world unit.
   *
   *  This sets how coarse the stone *surface* reads, and nothing else. It used
   *  to set paving density too, which is why every value was wrong: the flagstone
   *  layout is not in the texture, it comes from the tile's own edges via
   *  `ex`/`ez`, so one stone always fills one cell no matter what this is.
   *
   *  Free to dial for taste — a repeat every ~2.9m at 0.35. Live via
   *  __df.stoneStyle.floorScale.value. */
  floorScale: uniform(0.35),
  stoneCavity: uniform(0.55),
  // Texture-sampled fracture, separate from the noise-based `crack` above.
  // Driven from the layout's decay so one material covers pristine to ruined.
  damage: uniform(0.5),
};

/** Point the fracture layer at the generator's decay. Called once per forge. */
export function setStoneDamage(decay: number): void {
  stoneStyle.damage.value = Math.max(0, Math.min(1, decay));
}

// One 76 KB hand-painted albedo is shared by every masonry material. A neutral
// 1×1 placeholder keeps startup I/O off the first-visible critical path; the
// real image swaps into the same texture object after first paint, so no TSL
// pipeline recompilation is required.
const handPaintedStoneTexture = new THREE.DataTexture(
  new Uint8Array([154, 154, 154, 255]), 1, 1, THREE.RGBAFormat,
);
handPaintedStoneTexture.colorSpace = THREE.SRGBColorSpace;
handPaintedStoneTexture.needsUpdate = true;
let activeHandPaintedStoneTexture: THREE.Texture = handPaintedStoneTexture;
const handPaintedStoneNodes: Array<{ value: THREE.Texture }> = [];
let handPaintedStoneLoad: Promise<void> | null = null;

// Brush texture: surface character lifted from the statue albedo, high-passed
// so it carries brushwork rather than tentacles, and made seamless so it can
// wrap in hardware. Variation comes from the per-instance UV transform, not
// from atlas tiles — an atlas addressed by fract draws mip seams.
const brushPlaceholder = new THREE.DataTexture(
  new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat,
);
brushPlaceholder.colorSpace = THREE.SRGBColorSpace;
brushPlaceholder.needsUpdate = true;
let activeBrushTexture: THREE.Texture = brushPlaceholder;
const brushNodes: Array<{ value: THREE.Texture }> = [];
let brushLoad: Promise<void> | null = null;

// Procedural stone set: albedo, normal and AO generated by
// scripts/make-stone-atlas.py from one height field, so the three agree by
// construction. Roughness and the mask maps are generated too but unused —
// masonry is MeshLambert, diffuse only, and switching to Standard for a
// roughness map would cost more per fragment than the look is worth here.
type StoneMaps = { albedo: THREE.Texture; normal: THREE.Texture; ao: THREE.Texture };
type StoneSet = "wall" | "floor";
const stonePlaceholder = (rgb: number[]) => {
  const tex = new THREE.DataTexture(new Uint8Array([...rgb, 255]), 1, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
};
const makeSet = (): StoneMaps => ({
  albedo: stonePlaceholder([128, 128, 128]),
  normal: stonePlaceholder([128, 128, 255]),
  ao: stonePlaceholder([128, 128, 128]),
});
// Walls and floors need different stone counts, not just different UVs. A wall
// brick is 2.2 x 0.925 and reads as ONE face; a floor slab is 2.2 x 2.2 and
// reads as flagstones. Sampling one texture for both stamps a 2x2 grid of
// stones onto every floor tile, which is exactly what it looked like.
const stoneSets: Record<StoneSet, StoneMaps> = { wall: makeSet(), floor: makeSet() };
const stoneMapNodes: Array<{ set: StoneSet; key: keyof StoneMaps; node: { value: THREE.Texture } }> = [];
let stoneSetLoad: Promise<void> | null = null;

// Both sets are `face`: a JOINTLESS stone surface, generated with
// --joint-depth 0.
//
// Painted joints cannot be made to land on the model's seams. The texture does
// not know where the block ends, so every scale change slides its mortar to a
// new wrong place — through the middle of a brick, or doubled up beside the
// real edge. Chasing that alignment is what produced the cross through every
// brick and the eight courses stamped on one 2.4m face.
//
// The joints are already derived from the geometry a few hundred lines below:
// `ex`/`ez` fade in at the block's own half-extents and `line` follows the
// world course grid, so they sit exactly on the seam by construction. The
// texture only has to carry stone — grain and mineral mottle — and it can be
// scaled freely because nothing about it needs to line up with anything.
//
// Generated from `clean`, not `ruined`:
//
//     python3 scripts/make-stone-atlas.py --style clean --seed 21 \
//         --cells 1 --bond irregular --joint-depth 0 --out-dir ...
//
// With the joints gone, whatever is left owns the whole height field, and
// ruined's crack=0.85 ridged noise turned into winding worm veins across every
// wall — mean normal deviation 0.017 against clean's 0.008. The painted joints
// had been hiding it.
export function loadStoneSet(style = "face"): Promise<void> {
  if (stoneSetLoad) return stoneSetLoad;
  const loader = new THREE.TextureLoader();
  const one = (set: StoneSet, map: keyof StoneMaps, srgb: boolean) => new Promise<void>((resolve) => {
    // Both sets are the same jointless surface. This used to pick `floor-*`,
    // a running-bond lattice, which is why the paving kept tiling wrong however
    // the scale was dialled — the lattice is in the image, so no UV can put its
    // joints on the tile seams.
    const name = style;
    loader.load(`/assets/textures/stone/${name}-${map}-1024.webp`, (tex) => {
      // Only albedo is colour; normal and AO are data and must not be
      // gamma-decoded or the relief comes out wrong.
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = 4;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      stoneSets[set][map] = tex;
      for (const entry of stoneMapNodes) {
        if (entry.set === set && entry.key === map) entry.node.value = tex;
      }
      resolve();
    }, undefined, () => resolve());
  });
  const sets: StoneSet[] = ["wall", "floor"];
  stoneSetLoad = Promise.all(sets.flatMap((set) => [
    one(set, "albedo", true), one(set, "normal", false), one(set, "ao", false),
  ])).then(() => undefined);
  return stoneSetLoad;
}

function sampleStone(set: StoneSet, map: keyof StoneMaps, uvNode: any): any {
  const node = textureNode(stoneSets[set][map], uvNode);
  stoneMapNodes.push({ set, key: map, node: node as unknown as { value: THREE.Texture } });
  return node;
}

export function loadBrushAtlas(): Promise<void> {
  if (brushLoad) return brushLoad;
  brushLoad = new Promise((resolve, reject) => {
    new THREE.TextureLoader().load("/assets/textures/hand-painted-brush-1024.webp", (loaded) => {
      loaded.colorSpace = THREE.SRGBColorSpace;
      loaded.wrapS = loaded.wrapT = THREE.RepeatWrapping;
      loaded.minFilter = THREE.LinearMipmapLinearFilter;
      loaded.magFilter = THREE.LinearFilter;
      loaded.anisotropy = 4;
      loaded.generateMipmaps = true;
      loaded.needsUpdate = true;
      activeBrushTexture = loaded;
      for (const node of brushNodes) node.value = loaded;
      resolve();
    }, undefined, reject);
  });
  return brushLoad;
}

export function loadHandPaintedStoneTexture(): Promise<void> {
  if (handPaintedStoneLoad) return handPaintedStoneLoad;
  handPaintedStoneLoad = new Promise((resolve, reject) => {
    new THREE.TextureLoader().load("/assets/textures/hand-painted-stone-1024.webp", (loaded) => {
      loaded.colorSpace = THREE.SRGBColorSpace;
      loaded.wrapS = THREE.RepeatWrapping;
      loaded.wrapT = THREE.RepeatWrapping;
      loaded.minFilter = THREE.LinearMipmapLinearFilter;
      loaded.magFilter = THREE.LinearFilter;
      loaded.anisotropy = 4;
      loaded.generateMipmaps = true;
      loaded.needsUpdate = true;
      activeHandPaintedStoneTexture = loaded;
      for (const node of handPaintedStoneNodes) node.value = loaded;
      resolve();
    }, undefined, reject);
  });
  return handPaintedStoneLoad;
}

/** Eight dihedral UV variants plus continuous scale/offset jitter make a
 * single texture read differently on adjacent instances. One texture sample
 * replaces adding an atlas, per-brick material, or extra draw call. */
/** The per-instance projected UV every masonry sample shares.
 *
 *  Dominant-axis local projection: tops use XZ, X-facing sides ZY, Z-facing
 *  sides XY. Works on blocks, rubble and columns with no UV attribute, and
 *  costs one sample rather than full triplanar three. `salt` picks a different
 *  hash family so grain, fracture and relief decorrelate. */
function paintedUv(stableId: any, scale: number, salt: number): any {
  const id = stableId;
  const an = abs(normalLocal);
  const useX = step(an.y, an.x).mul(step(an.z, an.x));
  const useY = step(an.x, an.y).mul(step(an.z, an.y));
  const xy = vec2(positionLocal.x, positionLocal.y);
  const zy = vec2(positionLocal.z, positionLocal.y);
  const xz = vec2(positionLocal.x, positionLocal.z);
  const projected = mix(mix(xy, zy, useX), xz, useY).mul(scale);
  const swap = step(0.5, hash(id.add(salt + 1.17)));
  const swapped = mix(projected, vec2(projected.y, projected.x), swap);
  const flipX = step(0.5, hash(id.add(salt + 11.71))).mul(2).sub(1);
  const flipY = step(0.5, hash(id.add(salt + 27.03))).mul(2).sub(1);
  const scaleJitter = hash(id.add(salt + 38.91)).mul(0.42).add(0.82);
  const offset = vec2(hash(id.add(salt + 47.13)), hash(id.add(salt + 59.37)));
  return swapped.mul(vec2(flipX, flipY)).mul(scaleJitter).add(offset);
}

function sampleAtlas(uvNode: any): any {
  const sampled = textureNode(activeHandPaintedStoneTexture, uvNode);
  handPaintedStoneNodes.push(sampled as unknown as { value: THREE.Texture });
  return sampled;
}

/** Relief taken from the painted atlas rather than from analytic bands.
 *
 *  The masonry already had a normal — mortar joints and a ripple, both
 *  analytic, which is exactly why it read as machined bevels next to the
 *  statues. The statues look hand-carved because their normal map was baked
 *  off a real sculpt: irregular, chunky, chiselled. Deriving a bump from the
 *  same image that paints the albedo gives the bricks that character, and the
 *  two agree because they are the same texture.
 *
 *  Two extra samples for a finite-difference gradient. Cheaper than a second
 *  texture and it needs no tangents, which instanced masonry does not carry.
 */
function paintedRelief(stableId: any, strength: any): any {
  // One seamless tile with hardware REPEAT, not an atlas addressed by fract.
  //
  // The atlas version drew a dark lattice across every wall: the GPU takes
  // texture derivatives across the fract discontinuity, reads them as an
  // enormous UV step, and drops to the lowest mip along that line. It repeated
  // in world space every 1/0.55 units, which is what gave it away. Hardware
  // wrapping has no discontinuity to trip over, and the per-instance
  // swap/flip/scale/offset already supplies the variation the atlas was for.
  const uvBase = paintedUv(stableId, 0.55, 91);

  const step0 = 0.0035;
  const sampleBrush = (at: any) => {
    const node = textureNode(activeBrushTexture, at);
    brushNodes.push(node as unknown as { value: THREE.Texture });
    return node;
  };
  const here = sampleBrush(uvBase);
  const right = sampleBrush(uvBase.add(vec2(step0, 0)));
  const down = sampleBrush(uvBase.add(vec2(0, step0)));
  const luma = (n: any) => n.r.mul(0.34).add(n.g.mul(0.5)).add(n.b.mul(0.16));
  const gain = float(0.0016 / step0);
  const dx = luma(right).sub(luma(here)).mul(gain).mul(strength);
  const dy = luma(down).sub(luma(here)).mul(gain).mul(strength);

  // Rebuild the gradient in local space along whichever axes the projection
  // used, so relief follows the painted planes on every face.
  const an = abs(normalLocal);
  const useX = step(an.y, an.x).mul(step(an.z, an.x));
  const useY = step(an.x, an.y).mul(step(an.z, an.y));
  const gXY = vec3(dx, dy, 0);
  const gZY = vec3(0, dy, dx);
  const gXZ = vec3(dx, 0, dy);
  return mix(mix(gXY, gZY, useX), gXZ, useY);
}

function handPaintedStoneFactor(stableId = instanceIndex.toFloat()): any {
  const id = stableId;
  // Dominant-axis local projection: tops use XZ, X-facing sides use ZY and
  // Z-facing sides use XY. This works on blocks, rubble and columns without a
  // UV attribute and still costs one sample rather than full triplanar three.
  const an = abs(normalLocal);
  const useX = step(an.y, an.x).mul(step(an.z, an.x));
  const useY = step(an.x, an.y).mul(step(an.z, an.y));
  const xy = vec2(positionLocal.x, positionLocal.y);
  const zy = vec2(positionLocal.z, positionLocal.y);
  const xz = vec2(positionLocal.x, positionLocal.z);
  const projected = mix(mix(xy, zy, useX), xz, useY).mul(0.55);
  const swap = step(0.5, hash(id.add(21.17)));
  const swapped = mix(projected, vec2(projected.y, projected.x), swap);
  const flipX = step(0.5, hash(id.add(31.71))).mul(2).sub(1);
  const flipY = step(0.5, hash(id.add(47.03))).mul(2).sub(1);
  const scaleJitter = hash(id.add(58.91)).mul(0.42).add(0.82);
  const offset = vec2(hash(id.add(67.13)), hash(id.add(79.37)));
  const randomizedUv = swapped.mul(vec2(flipX, flipY)).mul(scaleJitter).add(offset);
  // Normalize the dark authored albedo around unity; instance colors and the
  // existing mortar/wear shader remain responsible for value and palette.
  const painted = textureNode(activeHandPaintedStoneTexture, randomizedUv);
  handPaintedStoneNodes.push(painted as unknown as { value: THREE.Texture });
  return painted.rgb.mul(1.35).add(0.58);
}

/** Cracks and chipping, sampled from the same authored atlas at a much higher
 *  frequency and thresholded to its dark veins.
 *
 *  The point is unlimited variation from one texture: each instance gets its
 *  own swap/flip/scale/offset, exactly like handPaintedStoneFactor, but from a
 *  different hash family so the crack pattern is uncorrelated with the stone
 *  grain underneath. No crack atlas to author or ship, and no per-variant
 *  geometry — a thousand blocks share one mesh and never repeat visibly.
 *
 *  `damage` is the generator's decay, so a pristine sanctum stays clean and a
 *  collapsed ossuary shatters, from the same material.
 */
function crackFactor(stableId: any, damage: any): any {
  const id = stableId;
  const an = abs(normalLocal);
  const useX = step(an.y, an.x).mul(step(an.z, an.x));
  const useY = step(an.x, an.y).mul(step(an.z, an.y));
  const xy = vec2(positionLocal.x, positionLocal.y);
  const zy = vec2(positionLocal.z, positionLocal.y);
  const xz = vec2(positionLocal.x, positionLocal.z);
  // 3.1x the grain frequency: cracks are a finer feature than the brush planes,
  // and the higher rate also decorrelates the two samples of the same image.
  const projected = mix(mix(xy, zy, useX), xz, useY).mul(1.7);
  const swap = step(0.5, hash(id.add(113.29)));
  const swapped = mix(projected, vec2(projected.y, projected.x), swap);
  const flipX = step(0.5, hash(id.add(127.41))).mul(2).sub(1);
  const flipY = step(0.5, hash(id.add(151.07))).mul(2).sub(1);
  const scaleJitter = hash(id.add(163.93)).mul(0.55).add(0.75);
  const offset = vec2(hash(id.add(179.11)), hash(id.add(191.57)));
  const uv = swapped.mul(vec2(flipX, flipY)).mul(scaleJitter).add(offset);

  const sampled = textureNode(activeHandPaintedStoneTexture, uv);
  handPaintedStoneNodes.push(sampled as unknown as { value: THREE.Texture });

  // Keep only the dark tail of the atlas as fracture. smoothstep's edges set
  // how much of the image counts as a crack; widening them with damage is what
  // makes the same block read as chipped or shattered.
  const luma = sampled.r.mul(0.34).add(sampled.g.mul(0.5)).add(sampled.b.mul(0.16));
  // Thresholds must come from the atlas's real distribution, not from taste.
  // Measured over hand-painted-stone-1024.webp: luma is tightly clustered at
  // 0.244 +/- 0.024, spanning 0.150 to 0.475, with p5 = 0.214 and p10 = 0.219.
  //
  // Two earlier guesses both failed for the same reason — they sat outside that
  // band. 0.38/0.56 is entirely above it, so every pixel read as fracture and
  // whole faces dimmed; 0.085/0.165 is entirely below it, so nothing did.
  // A 0.024 standard deviation leaves very little room, so the window has to be
  // narrow and centred just under the median.
  const bite = damage.mul(0.016).add(0.206); // p5 at rest, ~p20 fully ruined
  const crack = smoothstep(bite.add(0.012), bite.sub(0.014), luma);
  // Darken into the fracture rather than lightening: a crack is a shadow.
  // Deeper per-pixel than before precisely because it now covers far less area.
  return float(1).sub(crack.mul(damage).mul(0.8));
}

/** Hero-landmark version of the same authored surface. It avoids instanceIndex
 * so streamed single meshes (dragon now, future statues later) share the exact
 * brush texture without pretending to be masonry blocks. */
export function makeHandPaintedLandmarkStoneMaterial(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff,
    vertexColors: true,
    flatShading: true,
    side: THREE.DoubleSide,
    metalness: 0,
    roughness: 0.97,
  });
  const an = abs(normalLocal);
  const useX = step(an.y, an.x).mul(step(an.z, an.x));
  const useY = step(an.x, an.y).mul(step(an.z, an.y));
  const xy = vec2(positionLocal.x, positionLocal.y);
  const zy = vec2(positionLocal.z, positionLocal.y);
  const xz = vec2(positionLocal.x, positionLocal.z);
  const projected = mix(mix(xy, zy, useX), xz, useY).mul(0.34).add(vec2(0.17, 0.43));
  const painted = textureNode(activeHandPaintedStoneTexture, projected);
  handPaintedStoneNodes.push(painted as unknown as { value: THREE.Texture });
  // Keep hero stone neutral enough for authored lights to establish hierarchy.
  // The previous strong blue multiplier made the dragon, oracle and fog share
  // one value/hue family before lighting was even evaluated.
  const stoneColor = painted.rgb.mul(1.48).add(0.22).mul(vec3(0.88, 0.93, 0.99));
  material.colorNode = stoneColor;
  return material;
}

function makeFlameMat(cA: number, cB: number, cCore: number): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const ph = hash(instanceIndex.toFloat().add(0.317)).mul(6.2832);
  const flick = sin(time.mul(10.7).add(ph)).mul(0.55).add(sin(time.mul(16.3).add(ph.mul(2.7))).mul(0.45))
    .mul(flickerDamp);
  const h = uv().y;
  const cx = uv().x.sub(0.5).abs().mul(2);
  const sway = sin(time.mul(9.1).add(ph)).mul(h).mul(0.06);
  mat.positionNode = positionLocal.add(vec3(sway, flick.mul(0.05).mul(h), sway.mul(0.6)));
  const shape = smoothstep(1.0, 0.22, h.add(cx.mul(0.85)).add(flick.mul(0.08)))
    .mul(smoothstep(0.0, 0.1, float(1).sub(cx)));
  const ramp = mix(color(cCore), mix(color(cA), color(cB), h), smoothstep(0.0, 0.55, h.add(cx.mul(0.3))));
  mat.colorNode = ramp.mul(shape).mul(flick.mul(0.4).add(3.2));
  mat.opacityNode = shape;
  return mat;
}

/** Carved-masonry stone: mortar seams at block borders, a fake running-bond
 *  vertical seam per course (so one instance reads as 2-3 hand-laid blocks),
 *  and low-frequency grain — all procedural, multiplied under the per-instance
 *  hue/AO color and the per-face shading vertex color. */
/** Optional vertex-space hooks let dynamic masonry (currently GPU debris)
 * reuse the exact authored stone surface while supplying its own transform.
 * Keeping this here is important: duplicating the procedural graph made the
 * fragments drift away from the parent blocks whenever art direction moved. */
export interface StoneMaterialTransform {
  position?: (localPosition: any) => any;
  normal?: (localNormal: any) => any;
}

export function makeStoneMat(
  transform?: StoneMaterialTransform,
  stableInstanceId = instanceIndex.toFloat(),
  set: StoneSet = "wall",
): THREE.MeshLambertNodeMaterial {
  // Lambert = diffuse-only lighting: matte stone doesn't need GGX, and it
  // halves the per-light fragment cost across the entire masonry fill.
  const mat = new THREE.MeshLambertNodeMaterial({ vertexColors: true });
  const pl = positionLocal;
  const nl = normalLocal;
  const hw = (CELL * 1.02) / 2;
  const hh = (COURSE * 1.02) / 2;

  // CHIPPED CORNERS — vertex-only, the cheapest possible break-up: pick one
  // corners per instance by hash and crush their bevel vertices inward along
  // the corner diagonal. No new geometry, no extra
  // draw calls, and the shadow pass shares positionNode so silhouettes match.
  // Tiles/steps/merlons share this material but their vertices never reach
  // blockGeo's corner zone, so they opt out automatically.
  // GPU-compacted buckets supply their immutable source id here. Their output
  // instanceIndex is allocated through atomics and may reorder every cull;
  // using it as an art seed made chips, cracks and UVs visibly shimmer.
  const idf = stableInstanceId;
  {
    const cornerW = smoothstep(0.6, 0.97, abs(pl.x).div(hw))
      .mul(smoothstep(0.6, 0.97, abs(pl.y).div(hh)))
      .mul(smoothstep(0.6, 0.97, abs(pl.z).div(hw)));
    const cornerId = step(0, pl.x).add(step(0, pl.y).mul(2)).add(step(0, pl.z).mul(4));
    const pick = hash(idf.add(0.53)).mul(7.99).floor();
    const isPicked = float(1).sub(abs(cornerId.sub(pick)).min(1));
    const shapeSeed = hash(idf.add(4.13));
    const depth = smoothstep(0.48, 1.0, shapeSeed).mul(0.42);
    // Reuse the chip seed for a subtle whole-brick inset. The earlier
    // per-corner hash plus second picked corner cost ~4% in the 100-loop high
    // detail benchmark; broad CPU scale/jitter already supplies asymmetry, so
    // one readable chip gives the same silhouette at the original vertex cost.
    const handCut = shapeSeed.mul(0.045).add(0.012);
    const inset = handCut.add(isPicked.mul(depth));
    const chipped = pl.sub(pl.normalize().mul(cornerW.mul(inset)));
    mat.positionNode = transform?.position ? transform.position(chipped) : chipped;
  }
  const sideMask = smoothstep(0.6, 0.35, abs(nl.y)); // 1 on side faces, 0 on tops
  // vertical mortar at block x/z borders (only on faces not normal to that axis)
  const ex = smoothstep(hw - 0.12, hw - 0.02, abs(pl.x)).mul(float(1).sub(abs(nl.x)));
  const ez = smoothstep(hw - 0.12, hw - 0.02, abs(pl.z)).mul(float(1).sub(abs(nl.z)));
  // horizontal course seams: world-space y is course-aligned (bases sit on tier
  // multiples and courses aren't y-jittered), so one fract does every course
  const fy = fract(positionWorld.y.div(COURSE));
  const dSeam = fy.min(float(1).sub(fy));
  const line = smoothstep(0.11, 0.02, dSeam).mul(sideMask);
  // No fake running-bond seam here. It drew a joint at a random offset across
  // the middle of a brick, which is a seam the geometry does not have — the
  // cross through the centre of a block. Bond variation is the layout's job.
  // FLAGSTONE SURFACE, from the tile's own coordinates.
  //
  // Trying to map a paving image onto floors never worked: the texture does not
  // know where a tile begins, so every scale slid its joints somewhere new. This
  // takes the layout out of the image entirely — wear is a function of distance
  // to the tile's own edge, and the middle is brushed with noise in tile-local
  // space. Nothing repeats, so nothing can repeat wrongly.
  //
  const topMask = smoothstep(0.35, 0.62, abs(nl.y)); // 1 on tops and floors
  // Distance in metres from this fragment to each of the tile's own borders.
  const dEdgeX = float(hw).sub(abs(pl.x));
  const dEdgeZ = float(hw).sub(abs(pl.z));
  // Abraded arris: a worn band just inside the joint, doubled at the corners
  // where two edges meet and traffic cuts the angle off. This is the paving
  // read — a slab you can tell is a slab because its edges are rounded off,
  // not because an image drew a line there.
  const flagWear = smoothstep(0.34, 0.02, dEdgeX.min(dEdgeZ))
    .add(smoothstep(0.52, 0.06, dEdgeX).mul(smoothstep(0.52, 0.06, dEdgeZ)).mul(0.8))
    .clamp(0, 1)
    .mul(topMask);
  // Procedural brush for the middle: noise stretched hard along one axis makes
  // strokes rather than clouds, and rotating that axis per instance gives every
  // slab its own direction. Tile-local, so there is no repeat at all.
  const brushAngle = hash(idf.add(3.77)).mul(Math.PI * 2);
  const bc = cos(brushAngle), bs = sin(brushAngle);
  const brushU = pl.x.mul(bc).sub(pl.z.mul(bs));
  const brushV = pl.x.mul(bs).add(pl.z.mul(bc));
  const flagBrush = triNoise3D(
    vec3(brushU.mul(stoneStyle.floorScale.mul(9)), 0, brushV.mul(stoneStyle.floorScale.mul(1.5))), 0, 0,
  ).sub(0.5).mul(topMask);
  // hand-cut seams: modulate the mortar so joints vary in depth along their run
  const cutRaw = triNoise3D(positionWorld.mul(2.2), 0, 0);
  const cut = cutRaw.mul(0.5).add(0.65);
  const mortar = ex.add(ez).add(line).clamp(0, 1).mul(cut);
  // weathered grain: three FINE scales only — a macro (low-frequency) term just
  // smears meaningless light/dark clouds across whole walls
  const g46 = triNoise3D(positionWorld.mul(4.6), 0, 0);
  const g06 = triNoise3D(positionWorld.mul(0.6), 0, 0);
  const grain = g06.mul(stoneStyle.broadGrain)
    // cutRaw is already a four-octave field at 2.2×. The former second
    // four-octave call at 1.8× was visually redundant but ran for every stone
    // fragment (including depth/bloom passes). Reuse the existing nearby band.
    .add(cutRaw.mul(stoneStyle.midGrain))
    .add(g46.mul(stoneStyle.fineGrain));
  // Per-brick WEAR — every arris abraded a little differently. Edge proximity
  // in LOCAL space (sized to blockGeo; floor tiles & steps catch their
  // vertical corners, small props opt out naturally) × the world-noise breakup
  // × a per-instance severity hash: some bricks stay near-pristine while their
  // neighbors are battered. Worn arrises read LIGHTER (bruised stone) and
  // their normals round off; sparse pits pock the faces. Reuses the noise
  // samples above — no extra fragment cost to speak of.
  const dEdge = vec3(hw, (COURSE * 1.02) / 2, hw).sub(abs(pl));
  const nx2 = smoothstep(0.14, 0.02, dEdge.x);
  const ny2 = smoothstep(0.14, 0.02, dEdge.y);
  const nz2 = smoothstep(0.14, 0.02, dEdge.z);
  const arris = nx2.mul(ny2).add(ny2.mul(nz2)).add(nx2.mul(nz2)).clamp(0, 1);
  const severity = hash(idf.add(0.91)).mul(0.85).add(0.3);
  const wear = arris.mul(smoothstep(0.4, 0.78, cutRaw)).mul(severity);
  const pits = smoothstep(0.78, 0.92, g46).mul(severity);
  // RANDOM CRACKS — iso-contours of the cut noise already sampled above, so
  // this costs pure arithmetic. Each cracked brick (~1/3) picks its OWN iso
  // value, which is why a crack never continues across the mortar joint onto
  // the neighbor; the fine grain octave jags the path and the macro octave
  // fades strands out mid-face so cracks terminate instead of wrapping.
  const crackOn = smoothstep(0.5, 0.62, hash(idf.add(7.31)));
  const iso = hash(idf.add(9.17)).mul(0.22).add(0.34); // stay near the field median so the contour actually crosses the brick
  const dLine = abs(cutRaw.sub(iso)).add(g46.sub(0.5).mul(0.07)).max(0);
  const strand = float(1).sub(smoothstep(0.008, 0.06, dLine));
  const crack = strand.mul(smoothstep(0.18, 0.45, g06)).mul(crackOn);
  // Carved relief — pure math, no textures. An analytic height field whose
  // gradient perturbs the normal: a chiselled egg-crate frieze band every 5th
  // course + a faint tool-mark ripple everywhere. h is differentiable, so the
  // normal offset is the exact tangential gradient (no tangent frame needed).
  const fc = fract(positionWorld.y.div(COURSE * 8));
  const band = smoothstep(0.44, 0.5, fc).mul(float(1).sub(smoothstep(0.56, 0.62, fc)))
    .mul(sideMask); // carve SIDE faces only — on tops the tangential gradient
                    // survives projection at full strength and reads as a
                    // diagonal crosshatch smeared across walkways and floors
  const kx = 5.6, kq = 9.0;
  const sx = sin(pl.x.mul(kx)), sz = sin(pl.z.mul(kx));
  const cxn = cos(pl.x.mul(kx)), czn = cos(pl.z.mul(kx));
  const ripple = cos(pl.x.add(pl.z).mul(kq)).mul(0.10).mul(sideMask);
  const dhdx = band.mul(cxn.mul(sz).mul(kx * 0.13)).add(ripple.mul(-kq * 0.012));
  const dhdz = band.mul(sx.mul(czn).mul(kx * 0.13)).add(ripple.mul(-kq * 0.012));
  const g = vec3(dhdx, 0, dhdz);
  const gT = g.sub(nl.mul(g.dot(nl)));
  // worn edges round toward the corner direction — under raking moonlight the
  // arris softens instead of staying a machine-crisp bevel
  // Relief from the generated normal map. It was a finite difference over a
  // brush image, which is a bump approximation; this is a real tangent-space
  // normal baked from the same height field that produced the albedo and AO,
  // so the three agree instead of merely coexisting.
  //
  // One stone per brick face: each brick is already its own instance, so a
  // texture full of stones would put dozens on a single 2.2m face.
  // Walls project per instance: a brick IS one stone, so every brick sampling
  // the same UV range is correct and the per-instance transform breaks up the
  // repeat.
  //
  // Floors must not. Paving runs continuously under your feet, and projecting
  // per instance stamps an identical layout onto every tile — visible as the
  // same brick pattern repeating slab after slab. World XZ makes the courses
  // flow across the floor, and neighbouring tiles line up because they share
  // the same coordinate frame rather than each restarting at zero.
  const stoneUv = set === "floor"
    ? vec2(positionWorld.x, positionWorld.z).mul(stoneStyle.floorScale)
    : paintedUv(idf, 0.42, 91);
  const stoneNormal = sampleStone(set, "normal", stoneUv).xyz.mul(2).sub(1);
  const reliefLocal = vec3(
    stoneNormal.x.mul(stoneStyle.paintedRelief),
    float(0),
    stoneNormal.y.mul(stoneStyle.paintedRelief),
  );
  const reliefT = reliefLocal.sub(nl.mul(reliefLocal.dot(nl)));
  const carvedNormal = nl.sub(gT).sub(reliefT)
    .add(pl.normalize().mul(wear.mul(0.55))).normalize();
  mat.normalNode = transformNormalToView(
    transform?.normal ? transform.normal(carvedNormal).normalize() : carvedNormal,
  );

  const cavity = band.mul(sx.mul(sz)).mul(0.5).add(0.5);
  // rain streaks: columnar (y-independent) noise → dark weathering runs down
  // the side faces, like water has been bleeding off the walkways for ages
  const streak = smoothstep(0.58, 0.78, triNoise3D(vec3(positionWorld.x.mul(0.9), 0, positionWorld.z.mul(0.9)), 0, 0))
    .mul(sideMask);
  // Keep the ruin grounded under moonlight. The previous 0.86 base plus a
  // pure-white low-LOD multiplier pushed broad exterior walls toward chalky
  // grey and weakened the warm torch pools.
  const albedo = stoneStyle.base.add(grain)
    .mul(float(1).sub(mortar.mul(stoneStyle.mortar)))
    .mul(cavity.mul(0.09).add(0.955))
    .mul(float(1).sub(streak.mul(stoneStyle.streak)))
    .add(wear.mul(stoneStyle.wear))          // abraded arrises go pale
    .mul(float(1).sub(pits.mul(stoneStyle.pits)))
    .mul(float(1).sub(crack.mul(stoneStyle.crack)));
  // Course-level cool/warm pigment and value grouping are baked into instance
  // colors in build.ts. Keep only the tactile grain / wear here: doing the
  // palette quantisation per pixel cost 8% in the 100-loop high-detail median.
  // The generated target used a restrained ochre dry-brush on worn arrises.
  // A single tunable vector accent captures that cue without a texture fetch.
  const warmEdge = vec3(0.11, 0.045, -0.018).mul(wear).mul(stoneStyle.warmEdge);
  // The generated set replaces the fine-grain image for surface character and
  // supplies its own cavity. handPaintedStoneFactor stays for the per-instance
  // value break-up that keeps a wall of identical bricks from reading as one.
  // Modulate around 1.0, never below it on average. The maps are written
  // centred on 0.5, so (s - 0.5) * k + 1 keeps the mean at unity whatever the
  // style is, and the contrast is the only thing being chosen here.
  const stoneAlbedo = sampleStone(set, "albedo", stoneUv).rgb.sub(0.5).mul(stoneStyle.stoneDetail).add(1);
  const stoneAo = sampleStone(set, "ao", stoneUv).r.sub(0.5).mul(stoneStyle.stoneCavity).add(1);
  mat.colorNode = vec3(albedo)
    .mul(handPaintedStoneFactor(idf))
    .mul(stoneAlbedo)
    .mul(stoneAo)
    .mul(float(1).add(flagWear.mul(stoneStyle.flagWear)))
    .mul(float(1).add(flagBrush.mul(stoneStyle.flagBrush)))
    .mul(crackFactor(idf, stoneStyle.damage))
    .add(warmEdge);
  return mat;
}

/** Drowned briar on the basin bed. */
export const brambleStyle = {
  /** Lateral drift at the crown, in world units. Standing water, not wind —
   *  this is a slow lean, and anything springy reads as grass. */
  sway: uniform(0.055),
  swaySpeed: uniform(0.33),
  /** Multiplies the baked cane ramp. Cold and desaturated so the briar stays a
   *  silhouette against the teal water rather than competing with it. */
  tint: uniform(new THREE.Color(0.46, 0.52, 0.50)),
};

/** Thorn thicket material: baked value ramp, drift in the vertex shader.
 *
 *  Amplitude squares with height above the root, so the base stays planted in
 *  the silt and only the crown moves. A linear falloff lets the roots skate,
 *  which is the tell that a plant is a shader trick. */
export function makeBrambleMat(
  stableInstanceId = instanceIndex.toFloat(),
): THREE.MeshLambertNodeMaterial {
  const mat = new THREE.MeshLambertNodeMaterial({ vertexColors: true });
  const pl = positionLocal;
  const phase = hash(stableInstanceId.add(5.19)).mul(Math.PI * 2);
  const h = pl.y.max(0);
  const amp = h.mul(h).mul(brambleStyle.sway);
  const t = time.mul(brambleStyle.swaySpeed).add(phase);
  mat.positionNode = pl.add(vec3(sin(t).mul(amp), float(0), cos(t.mul(0.77)).mul(amp)));
  mat.colorNode = brambleStyle.tint;
  mat.name = "drowned-briar";
  return mat;
}

/** Floors and steps: same shader, flagstone-scaled stone set. */
export function makeStoneFloorMat(
  stableInstanceId = instanceIndex.toFloat(),
): THREE.MeshLambertNodeMaterial {
  const material = makeStoneMat(undefined, stableInstanceId, "floor");
  material.name = "masonry-floor";
  return material;
}

export function makeStoneLoMat(stableInstanceId = instanceIndex.toFloat()): THREE.MeshLambertNodeMaterial {
  // Same graph as the near shader, deliberately.
  //
  // The LOD system does two separable things: it collapses geometry, which
  // saves real draw calls, and it swapped the shader, which bought nothing
  // measurable and cost a visible value pop on every zoom — 16% at the
  // high-to-middle switch before any of today's tuning.
  //
  // Measuring the shader alone is awkward because the frame is vsync-bound at
  // 16.67ms in this scene, so frame time cannot see it either way. What is not
  // in doubt is the pop, and no amount of matching constants fixes it properly:
  // the two shaders perturb normals differently, so they respond to light
  // differently, and only agreeing on the graph makes them agree.
  //
  // One graph also means one pipeline to compile rather than two, which was the
  // original argument for keeping this material minimal.
  const material = makeStoneMat(undefined, stableInstanceId);
  material.name = "distant-masonry-painted";
  return material;
}


/** ONE material for every teleport plaza — per-plaza identity rides in two
 *  constant geometry attributes ('color' + 'plazaSeed', see build.ts), so a
 *  hundred different medallions still share a single compiled pipeline.
 *  The seed reshapes the sigil: ring radii, segment counts, spin speed and
 *  direction, and whether the inner band is solid or dashed. */
function makeMedallionMat(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.8 });
  // (attribute() types don't carry the node type through — the casts are inert)
  const tint = vec3(attribute("color", "vec3") as never);
  const s = float(attribute("plazaSeed", "float") as never);
  const s1 = fract(s.mul(7.13).add(0.17));
  const s2 = fract(s.mul(13.7).add(0.71));
  const s3 = fract(s.mul(29.3).add(0.37));
  const p = uv().sub(0.5).mul(2);
  const r = length(p);
  const ang = atan(p.y, p.x);
  // ring radii drift per plaza; the middle band's tick count and spin vary too
  const r1 = float(0.84).add(s2.mul(0.1));
  const r2 = float(0.52).add(s1.mul(0.2));
  const r3 = float(0.26).add(s3.mul(0.16));
  const nSeg = s1.mul(10).floor().add(6);
  const spin = s2.sub(0.5).mul(0.08);
  const segs = smoothstep(0.28, 0.34, fract(ang.mul(nSeg.div(6.2832)).add(time.mul(spin))).sub(0.5).abs());
  // inner band: solid on some plazas, counter-rotating dashes on others
  const nDash = s3.mul(8).floor().add(4);
  const dash = smoothstep(0.3, 0.36, fract(ang.mul(nDash.div(6.2832)).sub(time.mul(spin))).sub(0.5).abs());
  const inner = mix(float(1), dash, smoothstep(0.45, 0.55, s3));
  const pattern = smoothstep(0.05, 0.02, abs(r.sub(r1)))
    .add(smoothstep(0.045, 0.018, abs(r.sub(r2))).mul(segs))
    .add(smoothstep(0.05, 0.02, abs(r.sub(r3))).mul(inner))
    .add(smoothstep(0.2, 0.03, r).mul(1.7));
  const pulse = sin(time.mul(1.25).add(s.mul(6.2832))).mul(0.22).add(0.78);
  mat.colorNode = color(0x27221c).mul(float(1).sub(pattern.clamp(0, 1).mul(0.5)));
  mat.emissiveNode = tint.mul(pattern).mul(pulse).mul(1.6);
  return mat;
}

function makeBeamMat(c: number, strength: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const v = uv().y; // 0 bottom → 1 top on the open cylinder
  const shimmer = sin(time.mul(1.3).add(uv().x.mul(12.56))).mul(0.15).add(0.85);
  m.colorNode = color(c).mul(float(1).sub(v).pow(1.8)).mul(shimmer).mul(strength);
  m.opacityNode = float(1).sub(v).pow(2).mul(0.16);
  return m;
}

export interface MatKit {
  stoneMat: THREE.MeshLambertNodeMaterial;
  stoneFadeMat: THREE.MeshLambertNodeMaterial;
  stoneLoMat: THREE.MeshLambertNodeMaterial;
  stoneLoFadeMat: THREE.MeshLambertNodeMaterial;
  stoneFloorMat: THREE.MeshLambertNodeMaterial;
  stairMat: THREE.MeshLambertNodeMaterial;
  stairFadeMat: THREE.MeshLambertNodeMaterial;
  redMat: THREE.MeshStandardNodeMaterial;
  woodMat: THREE.MeshLambertNodeMaterial;
  ropeMat: THREE.MeshLambertNodeMaterial;
  plugMat: THREE.MeshLambertNodeMaterial;
  brambleMat: THREE.MeshLambertNodeMaterial;
  vineMat: THREE.MeshLambertNodeMaterial;
  mossMat: THREE.MeshLambertNodeMaterial;
  stainMat: THREE.MeshBasicNodeMaterial;
  leafMat: THREE.MeshLambertNodeMaterial;
  flameWarm: THREE.MeshBasicNodeMaterial;
  flameBlue: THREE.MeshBasicNodeMaterial;
  flameRed: THREE.MeshBasicNodeMaterial;
  flameNeutral: THREE.MeshBasicNodeMaterial;
  wallGlowMat: THREE.MeshBasicNodeMaterial;
  floorGlowMat: THREE.MeshBasicNodeMaterial;
  wispMat: THREE.MeshBasicNodeMaterial;
  emberMat: THREE.MeshBasicNodeMaterial;
  runeMat: THREE.MeshBasicNodeMaterial;
  portalMat: THREE.MeshBasicNodeMaterial;
  beaconMat: THREE.MeshBasicNodeMaterial;
  beamMatBlue: THREE.MeshBasicNodeMaterial;
  beamMatWarm: THREE.MeshBasicNodeMaterial;
  bannerMat: THREE.MeshStandardNodeMaterial;
  medallionMat: THREE.MeshStandardNodeMaterial;
  smokeMat: THREE.SpriteNodeMaterial;
  arrowMat: THREE.MeshBasicNodeMaterial;
  routeBeamMat: THREE.MeshBasicNodeMaterial;
  navMat: THREE.MeshBasicNodeMaterial;
}

export function makeMaterials(): MatKit {
  const stoneMat = makeStoneMat();
  const stoneFloorMat = makeStoneFloorMat();
  const stoneFadeMat = stoneMat.clone();
  applyLocalOcclusionWindow(stoneFadeMat);
  stoneFadeMat.name = "occluding-architecture-fade";
  // The low mesh is only shown beyond the detail radius, where mortar,
  // cracks, relief normals and four-octave weathering are sub-pixel. Keep the
  // exact same instance tint + baked face shading, but use a minimal Lambert
  // graph so tens of thousands of distant blocks do not run the near shader.
  // Far spans receive their brush/palette variation in CPU-baked instance
  // colors. Keep this shader minimal so first paint does not compile a second
  // procedural stone graph.
  const stoneLoMat = makeStoneLoMat();
  const stoneLoFadeMat = stoneLoMat.clone();
  applyLocalOcclusionWindow(stoneLoFadeMat);
  stoneLoFadeMat.name = "distant-occluding-architecture-fade";
  const stairMat = new THREE.MeshLambertNodeMaterial({ color: 0xffffff, vertexColors: true });
  // Stair towers are regular Meshes, so unlike the instanced masonry they do
  // not receive a per-instance tint. The former near-white multiplier also
  // replaced their material color, producing chalk-white debug-looking
  // spirals. Bake the face value back in and keep the same cool slate family.
  // Stair towers are cut from the same rock as everything else, and two things
  // were stopping them from looking it.
  //
  // First, the baked face colour was applied twice: NodeMaterial multiplies the
  // geometry's vertex colour on top of colorNode whenever vertexColors is set,
  // so the explicit .mul(stairFace) here was redundant.
  //
  // Second — and this is why the spiral read chalk-white against blue walls —
  // a tower is a plain Mesh, so it never receives the per-instance tint that
  // puts every masonry block in the cool slate family. It carried only the
  // neutral shadeFaces value, mean 0.763 against the wall tint's 0.380 luma,
  // and with no hue at all. stairTint is that missing tint, taken from the
  // masonry's own class-3 wall colour rather than picked by eye.
  stairMat.colorNode = handPaintedStoneFactor()
    .mul(stoneStyle.stairTint)
    .mul(stoneStyle.base);
  const stairFadeMat = stairMat.clone();
  applyLocalOcclusionWindow(stairFadeMat);
  stairFadeMat.name = "occluding-stair-fade";
  const bannerMat = new THREE.MeshStandardNodeMaterial({
    side: THREE.DoubleSide, roughness: 0.9, transparent: true, alphaTest: 0.4,
  });
  {
    const ph = hash(instanceIndex.toFloat().add(0.71)).mul(6.2832);
    const w = uv().y.oneMinus(); // 0 at the rod, 1 at the free bottom edge
    const sway = sin(time.mul(1.9).add(ph).add(w.mul(2.6))).mul(w).mul(0.16);
    bannerMat.positionNode = positionLocal.add(vec3(sway.mul(0.4), 0, sway));
    const u = uv().x, v = uv().y;
    const edge = u.min(u.oneMinus()).min(v);
    const border = smoothstep(0.11, 0.075, edge);
    const du = u.sub(0.5).abs(), dv = v.sub(0.42).abs();
    const diamond = du.mul(2.3).add(dv.mul(1.2));
    const sig = smoothstep(0.31, 0.26, diamond).sub(smoothstep(0.19, 0.14, diamond)).clamp(0, 1);
    const circ = smoothstep(0.075, 0.05, length(vec2(du, v.sub(0.14))));
    const gold = color(0xc9973a);
    const base = color(0x2a55c8).mul(v.mul(0.45).add(0.62));
    bannerMat.colorNode = mix(base, gold, max(border.mul(0.85), sig.add(circ).clamp(0, 1)));
    bannerMat.emissiveNode = gold.mul(sig.add(circ)).mul(0.4);
    // centuries of wind: a ragged, per-banner torn bottom edge
    const tear = triNoise3D(vec3(u.mul(4.2), ph, 0), 0, 0).mul(0.2);
    bannerMat.opacityNode = smoothstep(0.0, 0.1, v.sub(tear));
  }

  const wallGlowMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  {
    const ph = hash(instanceIndex.toFloat().add(0.83)).mul(6.2832);
    const flick = sin(time.mul(8.9).add(ph)).mul(0.1).add(sin(time.mul(14.7).add(ph.mul(1.9))).mul(0.06))
      .mul(flickerDamp).add(0.86);
    const fall = smoothstep(0.5, 0.04, length(uv().sub(vec2(0.5, 0.42))));
    // Carries the "lit city" read at wide framings. The cavern lid shadows
    // everything outside the beam, so at distance a point light has fallen
    // off to nothing and these emissive cards are the ONLY thing saying the
    // maze is inhabited — they have to be generous.
    wallGlowMat.colorNode = color(0xff8a35).mul(fall).mul(flick).mul(0.9);
    wallGlowMat.opacityNode = fall;
  }

  const floorGlowMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  {
    const ph = hash(instanceIndex.toFloat().add(0.59)).mul(6.2832);
    const flick = sin(time.mul(8.3).add(ph)).mul(0.09).add(sin(time.mul(13.9).add(ph.mul(2.3))).mul(0.05))
      .mul(flickerDamp).add(0.88);
    const fall = smoothstep(0.5, 0.03, length(uv().sub(0.5)));
    floorGlowMat.colorNode = color(0xff9440).mul(fall).mul(flick).mul(1.05);
    floorGlowMat.opacityNode = fall;
  }

  const portalMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  {
    const p = uv().sub(vec2(0.5, 0.42));
    const r = length(p);
    const swirl = sin(r.mul(22).sub(time.mul(2.1)).add(atan(p.y, p.x).mul(3)));
    const glow = float(0.3).div(r.add(0.16));
    portalMat.colorNode = color(0x3e7bff).mul(glow.mul(swirl.mul(0.22).add(1))).mul(1.6);
    portalMat.opacityNode = smoothstep(0.62, 0.12, r);
  }

  const beaconMat = new THREE.MeshBasicNodeMaterial();
  beaconMat.colorNode = color(0xffe4a0).mul(sin(time.mul(2.2)).mul(0.2).add(1)).mul(4.5);

  const redMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, vertexColors: true });
  redMat.emissiveNode = color(0xff2a08).mul(sin(time.mul(1.7)).mul(0.25).add(0.85)).mul(0.55);

  const smokeMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  smokeMat.colorNode = color(0x3a587a); // cool-tinted mist banks
  // banks are now ~3× wider and overlap — lower peak opacity, softer edge
  smokeMat.opacityNode = smoothstep(0.52, 0.02, length(uv().sub(0.5))).mul(0.085);

  // hanging vines: pinned at the top, swaying tip, dark→mossy green gradient
  const vineMat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false });
  {
    const ph = hash(instanceIndex.toFloat().add(0.47)).mul(6.2832);
    const w = uv().y.oneMinus(); // 0 at the anchored top, 1 at the tip
    const sway = sin(time.mul(1.3).add(ph).add(w.mul(2.1))).mul(w).mul(0.1);
    vineMat.positionNode = positionLocal.add(vec3(sway.mul(0.5), 0, sway));
    vineMat.colorNode = mix(color(0x39522c), color(0x17240f), uv().y.oneMinus());
    vineMat.opacityNode = float(1).sub(smoothstep(0.8, 1.0, w)); // tip fades out
  }

  // moss patches: flat blobs with noise-eaten irregular edges — the detail
  // layer that actually reads from a top-down camera
  const mossMat = new THREE.MeshLambertNodeMaterial({ transparent: true, depthWrite: false });
  {
    const r = length(uv().sub(0.5)).mul(2);
    const n = triNoise3D(positionWorld.mul(0.85), 0, 0);
    mossMat.colorNode = mix(color(0x2c4520), color(0x18280f), r);
    mossMat.opacityNode = float(1).sub(smoothstep(0.45, 1.0, r.add(n.mul(0.55)))).mul(0.9);
  }

  // Projector-free floor decals. Geometry supplies a few detached drops and
  // the procedural alpha roughens every circular boundary. Basic shading is
  // deliberate: these are pigment on stone, so they must remain legible in
  // the dungeon's very dark indirect light without ever reaching bloom.
  const stainMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  {
    const radial = length(uv().sub(0.5)).mul(2);
    const grain = triNoise3D(positionWorld.mul(1.7), 0, 0);
    const body = float(1).sub(smoothstep(0.63, 1.02, radial.add(grain.mul(0.34))));
    const tint = vec3(varyingProperty("vec3", "vInstanceColor"));
    stainMat.colorNode = tint.mul(float(1.08).sub(radial.mul(0.52)).sub(grain.mul(0.14)).clamp(0.3, 1.08));
    stainMat.opacityNode = body.mul(0.86);
  }
  stainMat.name = "instanced-blood-and-grime";

  const leafMat = new THREE.MeshLambertNodeMaterial({
    side: THREE.DoubleSide, transparent: true, alphaTest: 0.4,
  });
  {
    const ph = hash(instanceIndex.toFloat().add(0.61)).mul(6.2832);
    const w = uv().y.oneMinus();
    const sway = sin(time.mul(1.4).add(ph).add(w.mul(1.8))).mul(0.08);
    leafMat.positionNode = positionLocal.add(vec3(sway.mul(0.6), 0, sway));
    // rounded-diamond leaf mask + darker center vein
    const du = uv().x.sub(0.5).abs(), dv = uv().y.sub(0.5).abs();
    const dm = du.mul(2.1).add(dv.mul(1.7));
    leafMat.opacityNode = float(1).sub(smoothstep(0.75, 0.95, dm));
    const vein = smoothstep(0.05, 0.12, du);
    leafMat.colorNode = mix(color(0x6f9447), color(0x3d5c2a), dv.mul(1.6).clamp(0, 1))
      .mul(vein.mul(0.2).add(0.8));
    // moonlit sheen so ivy doesn't collapse to silhouette at night
    leafMat.emissive = new THREE.Color(0x101a0b);
  }

  const wispMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  {
    const ph = hash(instanceIndex.toFloat().add(0.29)).mul(6.2832);
    const v = uv().y, cx = uv().x.sub(0.5).abs().mul(2);
    const drift = sin(time.mul(0.7).add(ph).add(v.mul(2.6))).mul(v).mul(0.35);
    wispMat.positionNode = positionLocal.add(vec3(drift, 0, drift.mul(0.5)));
    const puff = triNoise3D(vec3(uv().x.mul(2.2), v.mul(1.9).sub(time.mul(0.22)), ph), 0, 0);
    wispMat.colorNode = mix(color(0x3a2c1d), color(0x151a24), v.clamp(0, 1));
    wispMat.opacityNode = float(1).sub(cx).clamp(0, 1).pow(1.6)
      .mul(float(1).sub(v)).mul(puff.mul(0.75).add(0.25)).mul(0.34)
      .mul(smoothstep(0.0, 0.1, v));
  }

  // drifting embers: a looping rise, sine-wobbling, fading in and out
  const emberMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  {
    const ph = hash(instanceIndex.toFloat().add(0.157)).mul(6.2832);
    const life = fract(time.mul(0.055).add(hash(instanceIndex.toFloat().add(0.31))));
    const rise = life.mul(5.5);
    const wob = vec3(
      sin(time.mul(0.9).add(ph)).mul(0.6),
      rise,
      sin(time.mul(0.7).add(ph.mul(1.7))).mul(0.6),
    );
    emberMat.positionNode = positionLocal.add(wob);
    const fadeIO = sin(life.mul(3.1416));
    const rad = float(1).sub(uv().sub(0.5).length().mul(2)).clamp(0, 1);
    emberMat.colorNode = mix(color(0xff9a3a), color(0xffd9a0), hash(ph)).mul(rad).mul(fadeIO).mul(2.2);
    emberMat.opacityNode = rad.mul(fadeIO);
  }

  const runeMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  {
    const u = uv().x, v = uv().y;
    const cellIdx = u.mul(9).floor();
    const fu = fract(u.mul(9));
    const gh = hash(cellIdx.add(3.7));
    // each cell draws a distinct dash-glyph: width/height gated by its hash
    const glyph = smoothstep(0.18, 0.24, fu).mul(float(1).sub(smoothstep(0.76, 0.82, fu)))
      .mul(smoothstep(0.16, 0.28, v.sub(gh.mul(0.28)))).mul(float(1).sub(smoothstep(0.72, 0.84, v.add(gh.mul(0.2)))));
    const pulse = sin(time.mul(1.1).add(u.mul(4))).mul(0.25).add(0.75);
    runeMat.colorNode = color(0x4d86ff).mul(glyph).mul(pulse).mul(2.4);
    runeMat.opacityNode = glyph;
  }

  // navigation chevrons: flat, LDR (deliberately BELOW the bloom threshold —
  // wayfinding, not a light source). A gentle brightness wave runs along the
  // instance sequence toward the goal.
  const arrowMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  {
    const wave = sin(time.mul(2.6).sub(instanceIndex.toFloat().mul(0.8))).mul(0.5).add(0.5);
    arrowMat.colorNode = color(0xe8c98d).mul(wave.mul(0.35).add(0.55));
    arrowMat.opacityNode = wave.mul(0.35).add(0.5);
  }

  // navmesh overlay: flat translucent cells, tinted per instance (walkable /
  // stair / portal). LDR and additive-free — a debug layer, not a light.
  const navMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, opacity: 0.3, side: THREE.DoubleSide,
  });

  // route beam: one thin glowing filament along the whole tour. Soft gold
  // base below the bloom threshold; short bright pulses stream toward the
  // goal (tube uv.x is the along-length coordinate) and are the only part
  // hot enough to bloom — the beam reads as living light, not a laser.
  const routeBeamMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  {
    const u = uv().x.mul(routeFlow).sub(time.mul(1.35));
    const t = u.fract();
    const pulse = smoothstep(0.0, 0.2, t).mul(smoothstep(0.55, 0.25, t));
    // distance-adaptive: beside the walking skeleton the filament stays a
    // quiet thread (below bloom), while from a panorama it burns bright
    // enough for its halo to carry the sub-pixel line
    const distBoost = smoothstep(12, 110, positionView.z.negate()).mul(1.5).add(0.55);
    routeBeamMat.colorNode = color(0xffd48a).mul(pulse.mul(1.7).add(0.75)).mul(distBoost);
    routeBeamMat.opacityNode = pulse.mul(0.25).add(0.62);
  }

  return {
    stoneMat,
    stoneFadeMat,
    stoneLoMat,
    stoneLoFadeMat,
    // spiral stair towers share the masonry face-shading via vertex colors
    stoneFloorMat,
    stairMat,
    stairFadeMat,
    redMat,
    woodMat: new THREE.MeshLambertNodeMaterial(),
    // ropes are plain Meshes — no per-instance color to darken them, so the
    // material itself carries the tarred-hemp brown (shared woodMat is white)
    ropeMat: new THREE.MeshLambertNodeMaterial({ color: 0x3b2b1a }),
    plugMat: new THREE.MeshLambertNodeMaterial({ color: 0x10141f }),
    brambleMat: new THREE.MeshLambertNodeMaterial(),
    vineMat,
    mossMat,
    stainMat,
    leafMat,
    flameWarm: makeFlameMat(0xffdd84, 0xff6a1a, 0xffeab0),
    flameBlue: makeFlameMat(0x9fd0ff, 0x2456ff, 0xeaf4ff),
    flameRed: makeFlameMat(0xffb08a, 0xff2410, 0xffe0c8),
    // grayscale ramp — NodeMaterial multiplies in the per-instance color, so
    // one material yields plaza flames of any hue
    flameNeutral: makeFlameMat(0xd8d8d8, 0x6a6a6a, 0xffffff),
    wallGlowMat,
    floorGlowMat,
    wispMat,
    emberMat,
    runeMat,
    portalMat,
    beaconMat,
    beamMatBlue: makeBeamMat(0x3e7bff, 0.9),
    beamMatWarm: makeBeamMat(0xffc26a, 0.7),
    bannerMat,
    medallionMat: makeMedallionMat(),
    smokeMat,
    arrowMat,
    routeBeamMat,
    navMat,
  };
}
