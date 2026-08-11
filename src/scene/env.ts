// Environment: night sky gradient, height fog pooling in the abyss, moonlight,
// distant cliff silhouettes, abyss floor. Everything deterministic from the seed.

import * as THREE from "three/webgpu";
import {
  color, mix, positionWorld, positionWorldDirection, time,
  fog, densityFogFactor, triNoise3D, float, floor as tslFloor, hash, smoothstep, vec3, sin,
  uv, length, uniform, vec2, fract, atan,
} from "three/tsl";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { hash2 } from "../gen/rng";
import { abyssFloorHeight, ABYSS_FLOOR, ABYSS_FLOOR_BASE_Y } from "./abyss-floor";
import { ABYSS } from "../gen/dungeon";
import { TH } from "../config";
import { buildAbyssLandmarks } from "./abyss-landmarks";
import { buildHorizonRing } from "./horizon";
import { buildAbyssCemetery } from "./abyss-cemetery";
import type { CinematicLightSpec, LightSpec } from "./build";

export type Environment = ReturnType<typeof buildEnvironment>;

/** the moon's direction — shared by the sky disc, the shadow light and the
 *  post-pass fog forward scattering (env owns it; nobody re-derives it) */
// Near-overhead rather than vertical: enough rake to expose the aperture edge
// and architecture silhouettes, while still reading as light from the cavern
// roof instead of a low exterior moon.
export const MOON_DIR = new THREE.Vector3(-0.45, 1, -0.25).normalize();

/** the ONE horizon-air color. The sky's below-horizon fog band and the post
 *  pass's aerial haze both converge to it — any mismatch between the two shows
 *  up as a hard seam along the abyss plane's edge / the far silhouette line. */
// Eldritch-green grade (chosen from the ref-C concept pass): the horizon air
// leans teal-green rather than navy, so distance reads as deep-sea murk.
export const HORIZON_FOG = 0x0d2328;

/** Author-controlled overrides for the godray shaft.
 *
 *  The aperture's size and height are derived from the layout, which is right
 *  as a default and wrong as a constraint — the shaft is the single strongest
 *  compositional element in the scene and wants to be placed by eye. These
 *  multiply or offset the computed values so a saved shape survives a re-forge
 *  onto a differently sized dungeon.
 */
export interface GodrayShape {
  /** Multiplies the computed opening radius — how wide the shaft reads. */
  radius: number;
  /** Multiplies the computed roof height — how far the light falls. */
  height: number;
  /** Shifts the aperture across the dungeon, in world units. */
  offsetX: number;
  offsetZ: number;
  /** Vertical thickness of the lid annulus. */
  thickness: number;
}

export const DEFAULT_GODRAY_SHAPE: GodrayShape = {
  radius: 1, height: 1, offsetX: 0, offsetZ: 0, thickness: 18,
};

const STORAGE_KEY = "df-godray-shape";
let godrayShape: GodrayShape = { ...DEFAULT_GODRAY_SHAPE };
let reseatGodray: (() => void) | null = null;

export function getGodrayShape(): GodrayShape {
  return { ...godrayShape };
}

/** Apply a shape and re-seat the aperture immediately — no re-forge needed,
 *  because tuning a shaft you cannot see change is guesswork. */
export function setGodrayShape(partial: Partial<GodrayShape>): GodrayShape {
  godrayShape = { ...godrayShape, ...partial };
  reseatGodray?.();
  return { ...godrayShape };
}

export function saveGodrayShape(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(godrayShape));
  } catch {
    // Private browsing or a full quota: the shape simply is not remembered.
  }
}

export function loadGodrayShape(): GodrayShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) godrayShape = { ...DEFAULT_GODRAY_SHAPE, ...JSON.parse(raw) };
  } catch {
    godrayShape = { ...DEFAULT_GODRAY_SHAPE };
  }
  return { ...godrayShape };
}

export function resetGodrayShape(): GodrayShape {
  godrayShape = { ...DEFAULT_GODRAY_SHAPE };
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  reseatGodray?.();
  return { ...godrayShape };
}

export function buildEnvironment(
  scene: THREE.Scene,
  seed: number,
  applyCinematicLights?: (specs: CinematicLightSpec[]) => void,
  applyLandmarkLights?: (specs: LightSpec[]) => void,
): {
  godrayLight: THREE.DirectionalLight;
  fit: (half: number, centerX?: number, centerZ?: number, top?: number) => void;
  bakeShadows: () => void;
  tick: (camera: THREE.Camera) => void;
  dispose: () => void;
} {
  const group = new THREE.Group();
  group.name = "environment";

  // -- Sky: deep navy zenith, faintly glowing horizon, salted with stars and
  //    crowned by the moon (HDR values — the bloom pass gives it its halo).
  {
    const dir = positionWorldDirection;
    const dirY = dir.y.clamp(-0.35, 1);
    const base = mix(color(0x17233d), color(0x030711), dirY.add(0.35).div(1.35).pow(0.62));
    // Build actual round stars inside a longitude/height grid. The old
    // floor(direction*170) painted entire Cartesian cells and exposed rows /
    // cubic sampling seams. Two independent layers give a dense sub-pixel
    // field plus a handful of readable navigation stars.
    const skyUv = vec2(atan(dir.z, dir.x).div(6.283185).add(0.5), dir.y.mul(0.5).add(0.5));
    const microGrid = skyUv.mul(vec2(420, 190));
    const microCell = tslFloor(microGrid);
    const microId = microCell.x.mul(17.17).add(microCell.y.mul(91.73));
    const microOffset = vec2(hash(microId.add(3.1)), hash(microId.add(19.7))).sub(0.5).mul(0.64);
    const microDistance = length(fract(microGrid).sub(0.5).sub(microOffset));
    const microSpawn = smoothstep(0.982, 0.999, hash(microId.add(41.3)));
    const microStars = smoothstep(0.095, 0.018, microDistance).mul(microSpawn).mul(0.72);

    const heroGrid = skyUv.mul(vec2(132, 62));
    const heroCell = tslFloor(heroGrid);
    const heroId = heroCell.x.mul(53.41).add(heroCell.y.mul(137.9));
    const heroOffset = vec2(hash(heroId.add(7.7)), hash(heroId.add(29.2))).sub(0.5).mul(0.58);
    const heroDistance = length(fract(heroGrid).sub(0.5).sub(heroOffset));
    const heroSpawn = smoothstep(0.992, 0.9997, hash(heroId.add(63.8)));
    const heroCore = smoothstep(0.09, 0.018, heroDistance).mul(heroSpawn);
    const heroHalo = smoothstep(0.19, 0.055, heroDistance).mul(heroSpawn).mul(0.18);
    const twinkle = sin(hash(heroId.mul(0.73)).mul(6.2832).add(time.mul(0.65))).mul(0.17).add(0.83);
    const starAltitude = smoothstep(0.01, 0.18, dir.y);
    const microRaw = microStars.mul(starAltitude);
    const heroRaw = heroCore.mul(twinkle).add(heroHalo).mul(starAltitude);
    // milky way: a faint patchy band along the great circle whose pole is bandN —
    // gives the upper sky some structure without competing with the moon
    const bandN = vec3(0.62, 0.33, -0.71);
    const band = smoothstep(0.04, 0.32, dir.dot(bandN).abs()).oneMinus();
    const patch = triNoise3D(dir.mul(2.6), 0, 0).mul(0.75).add(triNoise3D(dir.mul(7.3), 0, 0).mul(0.25));
    const milky = band.mul(patch).mul(dir.y.clamp(0, 1).pow(0.35)).mul(0.16);
    // Reuse the same two sky-noise samples as a broad, low-contrast storm
    // ceiling. Clouds occlude stars and break the empty navy field without a
    // texture fetch or another noise octave.
    const storm = smoothstep(0.18, 0.43, patch)
      .mul(smoothstep(0.04, 0.92, dirY).oneMinus())
      .mul(dir.y.add(0.08).clamp(0, 1));
    const starVisibility = float(1).sub(storm.mul(0.9));
    const microVisible = microRaw.mul(starVisibility);
    const heroVisible = heroRaw.mul(starVisibility);
    const heroTemperature = mix(color(0x9abce8), color(0xffdfb0), hash(heroId.add(88.2)));
    const stormColor = mix(color(0x08111f), color(0x314b6b), patch).mul(storm.mul(0.42));
    const md = dir.dot(vec3(MOON_DIR.x, MOON_DIR.y, MOON_DIR.z)).clamp(0, 1);
    const disc = smoothstep(0.99955, 0.99985, md).mul(2.6);
    const halo = md.pow(220).mul(0.5);
    const broadHalo = md.pow(28).mul(0.14).mul(float(1).sub(storm.mul(0.55)));
    // one warm meteor scratch high in the sky (painted-reference garnish):
    // a thin bright arc segment, head hot and tail fading
    const meteorA = new THREE.Vector3(-0.55, 0.6, -0.58).normalize();
    const meteorB = new THREE.Vector3(-0.38, 0.72, -0.58).normalize();
    const meteorN = new THREE.Vector3().crossVectors(meteorA, meteorB).normalize();
    const meteorMid = new THREE.Vector3().addVectors(meteorA, meteorB).normalize();
    const meteorHead = new THREE.Vector3().subVectors(meteorB, meteorA).normalize();
    const meteor = smoothstep(0.005, 0.0012, dir.dot(vec3(meteorN.x, meteorN.y, meteorN.z)).abs())
      .mul(smoothstep(0.9952, 0.9995, dir.dot(vec3(meteorMid.x, meteorMid.y, meteorMid.z))))
      .mul(smoothstep(-0.1, 0.14, dir.dot(vec3(meteorHead.x, meteorHead.y, meteorHead.z))))
      .mul(1.8);
    const skyRaw = base.mul(float(1).sub(storm.mul(0.2)))
      .add(stormColor)
      .add(color(0xb9d2f2).mul(microVisible))
      .add(heroTemperature.mul(heroVisible).mul(2.1))
      .add(color(0x8fa3d8).mul(milky))
      .add(color(0xffc9a0).mul(meteor))
      .add(color(0xdfe8ff).mul(disc.add(halo).add(broadHalo)));
    // horizon fog band: below the true horizon the sky settles into the same
    // hazy air the post-pass paints on far geometry. Without this the abyss
    // plane's far edge meets a FLAT navy below-horizon sky as a hard straight
    // seam — the two sides must converge to one color so no edge can show.
    // smoothstep requires ascending edges. The former reversed call produced
    // backend-dependent interpolation and exposed a ruler-straight horizon.
    // Fade across a deliberately broad angular band so the lower sky reaches
    // the exact same air colour as distant fog before it meets the abyss.
    const hband = smoothstep(-0.08, 0.24, dir.y).oneMinus();
    scene.backgroundNode = mix(skyRaw, color(HORIZON_FOG), hband.mul(0.96));
  }

  // -- Fog: animated ground fog pooling below the fortress + gentle distance haze.
  const fogColor = color(HORIZON_FOG); // one shared horizon-air colour; no seam
  const fogBase = float(ABYSS * TH - 8);
  // Three offset sines replace the former per-fragment triNoise3D (~36 tri()
  // evaluations on every scene fragment). The wobble only sways the fog-top
  // height of the dialed-back material fog — the post-pass volumetric owns the
  // visible mist detail — so smooth low-frequency motion reads the same.
  const noise = sin(positionWorld.x.mul(0.021).add(time.mul(0.14)))
    .add(sin(positionWorld.z.mul(0.017).sub(time.mul(0.1))))
    .add(sin(positionWorld.x.mul(0.006).add(positionWorld.z.mul(0.008)).add(time.mul(0.05))))
    .add(3); // [-3,3] → [0,6], matching the old triNoise3D×5 range
  const fogTop = float(2.2).add(noise);
  // material-level ground fog dialed back — the post-pass volumetric raymarch
  // now owns the low mist; this only keeps distant aerial perspective coherent
  const ground = fogTop.sub(positionWorld.y).div(fogTop.sub(fogBase)).saturate().mul(0.42);
  const hazeU = uniform(0.008); // adapts to view extent — multi-block chains need thinner air
  const haze = densityFogFactor(hazeU);
  const combined = ground.oneMinus().mul(haze.oneMinus()).oneMinus();
  scene.fogNode = fog(fogColor, combined);

  // -- Lights, staged like a night exterior: a cool moon KEY with shadows, a
  //    dimmer ambient FILL so darks actually go dark (contrast is what makes
  //    the torch pools feel warm), and a faint counter-directional RIM that
  //    lifts silhouettes off the abyss. All created here, before the first
  //    compile — a changing scene light count recompiles every pipeline.
  // Keep occluded masonry readable enough for the painted value planes to
  // survive. 0.72 crushed bridge undersides and deep courts to near-black;
  // the modest fill lift preserves the night key while exposing bevel work.
  // Hue-separated night palette that stays inside one blue family: an icy
  // cyan moon KEY, a steel-blue counter-RIM barely warmer than the sky, and a
  // warm earthen ground bounce. The variation comes from cyan↔teal↔amber —
  // violet pulled the frame apart, so the rim keeps only a whisper of it.
  // Ground colour is a TEAL bounce, not earth: the thing below this world is
  // a luminous basin, so masonry undersides should catch its light. In the
  // painted reference every block soffit reads cool while warmth appears only
  // where a torch actually is — an earthy ground colour smeared that warmth
  // everywhere and flattened the whole value structure.
  const hemi = new THREE.HemisphereLight(0x36586e, 0x1d4a45, 1.35);
  group.add(hemi);

  const rim = new THREE.DirectionalLight(0x568fa0, 0.75);
  rim.position.set(52, 20, 34); // low, opposite the moon — silhouette kisser
  group.add(rim, rim.target);

  // warm ivory moonbeam (per the painted reference): beam-lit stone tops go
  // gold while unlit masonry stays in the cool teal ambient
  // THE missing key. The cavern lid shadows everything outside the aperture —
  // that is what makes the shaft exist — but it also meant the only real key
  // in the scene lit one narrow column and the other 95% of the world had
  // nothing but fill. This is the light bouncing back down off the lit lid
  // and the cavern walls: same broad direction, no shadow map, so masonry
  // everywhere catches a top light without touching the beam. Created HERE,
  // before the first compile, so the extra light costs no pipeline rebuild.
  const caveFill = new THREE.DirectionalLight(0x9ab3c6, 1.9);
  caveFill.castShadow = false;
  group.add(caveFill, caveFill.target);

  const moon = new THREE.DirectionalLight(0xd4cfae, 1.75);
  moon.position.copy(MOON_DIR).multiplyScalar(80);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  const sc = moon.shadow.camera;
  sc.left = -52; sc.right = 52; sc.top = 52; sc.bottom = -52;
  sc.near = 8; sc.far = 150;
  moon.shadow.bias = -0.0006;
  moon.shadow.radius = 1; // r=3 blurred small-prop contact shadows into detached "floating" blobs
  moon.shadow.autoUpdate = false; // static scene — bake once per regeneration
  group.add(moon, moon.target);

  // -- Cavern roof aperture. This is the missing physical cause of the
  // godrays: a single closed, irregular annulus sits above every landmark and
  // casts into the SAME moon shadow map sampled by the post raymarch. Only the
  // hole remains lit, so the volume resolves into one authored shaft instead
  // of a uniform blue wash. The entire roof is one tiny procedural draw.
  const apertureSegments = 24;
  const aperturePositions: number[] = [];
  const apertureColors: number[] = [];
  const apertureIndices: number[] = [];
  const apertureInner: number[] = [];
  const apertureOuter: number[] = [];
  const apertureBottom: number[] = [];
  const apertureTop: number[] = [];
  const apertureColor = new THREE.Color();
  for (let i = 0; i < apertureSegments; i++) {
    apertureInner.push(0.88 + hash2(seed, i, 910) * 0.28);
    apertureOuter.push(6.7 + hash2(seed, i, 911) * 0.7);
    apertureBottom.push(-0.54 + hash2(seed, i, 912) * 0.16);
    apertureTop.push(0.42 + hash2(seed, i, 913) * 0.2);
  }
  for (let i = 0; i < apertureSegments; i++) {
    const angle = i / apertureSegments * Math.PI * 2;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const values = [
      [apertureInner[i], apertureBottom[i], 0.13],
      [apertureOuter[i], apertureBottom[i], 0.055],
      [apertureInner[i], apertureTop[i], 0.18],
      [apertureOuter[i], apertureTop[i], 0.075],
    ];
    for (const [radius, y, luminance] of values) {
      aperturePositions.push(c * radius, y, s * radius);
      apertureColor.setHSL(0.59, 0.3, luminance);
      apertureColors.push(apertureColor.r, apertureColor.g, apertureColor.b);
    }
  }
  for (let i = 0; i < apertureSegments; i++) {
    const n = (i + 1) % apertureSegments;
    const ib = i * 4;
    const ob = ib + 1;
    const it = ib + 2;
    const ot = ib + 3;
    const nib = n * 4;
    const nob = nib + 1;
    const nit = nib + 2;
    const not = nib + 3;
    // underside, top, inner reveal and distant outer rim
    apertureIndices.push(ib, nob, ob, ib, nib, nob);
    apertureIndices.push(it, ot, not, it, not, nit);
    apertureIndices.push(ib, it, nit, ib, nit, nib);
    apertureIndices.push(ob, nob, not, ob, not, ot);
  }
  const indexedAperture = new THREE.BufferGeometry();
  indexedAperture.setAttribute("position", new THREE.Float32BufferAttribute(aperturePositions, 3));
  indexedAperture.setAttribute("color", new THREE.Float32BufferAttribute(apertureColors, 3));
  indexedAperture.setIndex(apertureIndices);
  const apertureGeometry = indexedAperture.toNonIndexed();
  indexedAperture.dispose();
  apertureGeometry.computeVertexNormals();
  apertureGeometry.computeBoundingSphere();
  // Invisible to the camera, still a shadow caster. This lid's entire job is
  // to block the moon everywhere except the hole — it is the physical cause
  // of the shaft, not scenery. Rendered opaque it is a 600-unit slab at
  // y≈400 that swings across frame whenever the camera rises, which is
  // exactly the "big thing blocking the view" the orbit hits.
  //
  // DEPENDENCY: three still draws this into the shadow map despite opacity 0
  // (the shadow pass uses its own depth material). Verified by forcing a
  // fresh bake with the lid hidden and confirming the shaft survived — if a
  // future three drops fully-transparent casters, the shaft vanishing is the
  // symptom, and this is the line to look at.
  const apertureMaterial = new THREE.MeshLambertNodeMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const cavernAperture = new THREE.Mesh(apertureGeometry, apertureMaterial);
  cavernAperture.name = "procedural-overhead-cavern-godray-aperture";
  cavernAperture.castShadow = true;
  cavernAperture.receiveShadow = false;
  cavernAperture.frustumCulled = false;
  cavernAperture.userData.aperture = {
    segments: apertureSegments,
    triangles: apertureIndices.length / 3,
    draws: 1,
    shadowSource: "shared-static-moon-map",
  };
  group.add(cavernAperture);

  // Dust curtain inside the godray shaft: two crossed additive quads spanning
  // aperture→maze with slow-sinking noise, so the beam carries drifting motes
  // like the painted reference instead of being an optically empty cone.
  const shaftDustMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  {
    const u = uv().x;
    const v = uv().y;
    const drift = triNoise3D(vec3(u.mul(2.6), v.mul(5.4).add(time.mul(0.05)), 2.7), 0.12, time);
    const core = float(1).sub(u.sub(0.5).abs().mul(2)).clamp(0, 1).pow(1.6);
    const ends = smoothstep(0.02, 0.3, v).mul(smoothstep(1.0, 0.7, v));
    shaftDustMat.colorNode = color(0xd8c491).mul(drift).mul(core).mul(ends).mul(0.5);
    shaftDustMat.opacityNode = drift.mul(core).mul(ends).mul(0.5);
  }
  const shaftDust = new THREE.Group();
  shaftDust.name = "godray-dust-curtain";
  for (let cross = 0; cross < 2; cross++) {
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shaftDustMat);
    quad.rotation.y = cross * Math.PI / 2;
    shaftDust.add(quad);
  }
  group.add(shaftDust);

  // One simple instanced low-poly draw supplies both cold dust motes and sparse
  // warm embers. This intentionally uses the already-hot Basic pipeline: the
  // wider SpriteNodeMaterial path added a ~20s cold WebGPU compile on this Mac.
  const particleCount = 420;
  const particlePositions = new Float32Array(particleCount * 3);
  const particleKinds = new Uint8Array(particleCount);
  for (let i = 0; i < particleCount; i++) {
    const ember = i >= 348;
    const radius = Math.sqrt(hash2(seed, i, 801)) * (ember ? 0.62 : 1.08);
    const angle = hash2(seed, i, 802) * Math.PI * 2;
    particlePositions[i * 3] = Math.cos(angle) * radius;
    particlePositions[i * 3 + 1] = ember
      ? 0.12 + hash2(seed, i, 803) * 0.22
      : 0.08 + hash2(seed, i, 803) * 0.78;
    particlePositions[i * 3 + 2] = Math.sin(angle) * radius;
    particleKinds[i] = ember ? 1 : 0;
  }
  const particleGeometry = new THREE.IcosahedronGeometry(1, 0);
  const particleColor = new Float32Array(particleGeometry.getAttribute("position").count * 3).fill(1);
  particleGeometry.setAttribute("color", new THREE.Float32BufferAttribute(particleColor, 3));
  const particleMaterial = new THREE.MeshBasicNodeMaterial({ vertexColors: true });
  const atmosphereParticles = new THREE.InstancedMesh(particleGeometry, particleMaterial, particleCount);
  atmosphereParticles.name = "gpu-instanced-abyss-dust-and-embers";
  atmosphereParticles.frustumCulled = false;
  atmosphereParticles.userData.atmosphereParticles = true;
  const particleMatrix = new THREE.Matrix4();
  const particlePosition = new THREE.Vector3();
  const particleQuaternion = new THREE.Quaternion();
  const particleScale = new THREE.Vector3();
  const dustColor = new THREE.Color(0x27384a);
  const emberColor = new THREE.Color(0xff7430);
  for (let i = 0; i < particleCount; i++) atmosphereParticles.setColorAt(i, particleKinds[i] ? emberColor : dustColor);
  if (atmosphereParticles.instanceColor) atmosphereParticles.instanceColor.needsUpdate = true;
  group.add(atmosphereParticles);

  // -- The horizon is generated rock now. It used to be 31 mesas and three ruin
  //    clusters built from raw BoxGeometry, which is exactly what they read as
  //    once a camera got near them. buildHorizonRing keeps the arc those had —
  //    a horseshoe closed across the narrative back and open toward the default
  //    approach — and hangs Tripo cliffs, spires and ruins on it instead, five
  //    draw calls for the whole skyline.
  //    Everything ring-shaped lives in ringGroup so fit() can recentre/rescale
  //    it around a multi-block chain.
  const ringGroup = new THREE.Group();
  group.add(ringGroup);
  const horizon = buildHorizonRing(seed);
  ringGroup.add(horizon.group);
  const cemetery = buildAbyssCemetery(seed);
  ringGroup.add(cemetery.group);
  const landmarkGroup = buildAbyssLandmarks(seed);
  group.add(landmarkGroup);
  {
    // mist curtain: a ring of broad fog banks that swallows the horizon seam
    {
      const mist = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
      mist.colorNode = color(0x27415f);
      const mistEdge = length(uv().sub(0.5))
        .add(sin(uv().x.mul(15).add(time.mul(0.035))).mul(0.028));
      mist.opacityNode = smoothstep(0.08, 0.52, mistEdge).oneMinus().mul(0.17);
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2 + hash2(seed, k, 33) * 0.4;
        const s = new THREE.Sprite(mist);
        const rad = 96 + hash2(seed, k, 34) * 26;
        s.position.set(Math.cos(a) * rad, -2 + hash2(seed, k, 36) * 6, Math.sin(a) * rad);
        const sc = 46 + hash2(seed, k, 37) * 26;
        s.scale.set(sc, sc * 0.4, 1);
        ringGroup.add(s);
      }

      // Eight horizontal billow islands fill the otherwise empty inner abyss.
      // One InstancedMesh = one draw call; the true depth-aware volume remains
      // the post raymarch, while these broad silhouettes make bank boundaries
      // readable from high cameras.
      const islandGeo = new THREE.PlaneGeometry(1, 1);
      islandGeo.rotateX(-Math.PI / 2);
      const islandMat = new THREE.MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const islandUv = uv().sub(0.5);
      const islandEdge = length(islandUv)
        .add(sin(islandUv.x.mul(17).add(islandUv.y.mul(11)).add(time.mul(0.02))).mul(0.035));
      islandMat.colorNode = color(0x38597b);
      islandMat.opacityNode = smoothstep(0.12, 0.54, islandEdge).oneMinus().mul(0.12);
      const fogIslands = new THREE.InstancedMesh(islandGeo, islandMat, 8);
      fogIslands.name = "instanced-volumetric-fog-bank-proxies";
      fogIslands.castShadow = false;
      fogIslands.receiveShadow = false;
      const fm = new THREE.Matrix4();
      const fp = new THREE.Vector3();
      const fq = new THREE.Quaternion();
      const fs = new THREE.Vector3();
      for (let k = 0; k < fogIslands.count; k++) {
        const a = k / fogIslands.count * Math.PI * 2 + hash2(seed, k, 71) * 0.62;
        const rad = 38 + hash2(seed, k, 72) * 48;
        const sc = 34 + hash2(seed, k, 73) * 28;
        fp.set(Math.cos(a) * rad, -5.5 + hash2(seed, k, 74) * 5.5, Math.sin(a) * rad);
        fq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a + hash2(seed, k, 75));
        fs.set(sc * (1.15 + hash2(seed, k, 76) * 0.65), 1, sc * (0.48 + hash2(seed, k, 77) * 0.28));
        fogIslands.setMatrixAt(k, fm.compose(fp, fq, fs));
      }
      fogIslands.instanceMatrix.needsUpdate = true;
      fogIslands.computeBoundingSphere();
      ringGroup.add(fogIslands);
    }
  }

  // -- Abyss bedrock far below. Broad low-frequency terraces establish the
  //    geological masses, a short eased ramp connects each plateau, and a
  //    restrained fBM pass weathers the otherwise mathematical steps.
  //    Lives in ringGroup so fit() recentres/rescales it with the chain.
  {
    // The relief itself lives in abyss-floor.ts as a pure function, because the
    // mesh is not the only thing that needs to know where the ground is — the
    // entrance tower's footing, the bedrock piers and prop grounding all ask
    // the same question, and a vertex buffer is not answerable.
    //
    // extent 900: the far edge must sit past the fog-band convergence distance
    // even under big chains (ringGroup scales it further) — a visible edge reads
    // as a hard diagonal across the horizon. 72² cells are enough for the
    // slow terraces and remain one cheap, static 10,368-triangle draw.
    const bedrockGeometry = new THREE.PlaneGeometry(
      ABYSS_FLOOR.extent, ABYSS_FLOOR.extent, ABYSS_FLOOR.segments, ABYSS_FLOOR.segments,
    );
    bedrockGeometry.rotateX(-Math.PI / 2);
    const bedrockPosition = bedrockGeometry.getAttribute("position");
    const bedrockColors = new Float32Array(bedrockPosition.count * 3);
    const low = new THREE.Color(0x07111c);
    const high = new THREE.Color(0x172b3c);
    const tint = new THREE.Color();
    let minRelief = Infinity;
    let maxRelief = -Infinity;
    for (let i = 0; i < bedrockPosition.count; i++) {
      const x = bedrockPosition.getX(i);
      const z = bedrockPosition.getZ(i);
      const relief = abyssFloorHeight(seed, x, z);
      bedrockPosition.setY(i, relief);
      minRelief = Math.min(minRelief, relief);
      maxRelief = Math.max(maxRelief, relief);
      const value = THREE.MathUtils.clamp((relief + 10) / 22, 0, 1);
      tint.copy(low).lerp(high, 0.18 + value * 0.62);
      bedrockColors[i * 3] = tint.r;
      bedrockColors[i * 3 + 1] = tint.g;
      bedrockColors[i * 3 + 2] = tint.b;
    }
    bedrockPosition.needsUpdate = true;
    bedrockGeometry.setAttribute("color", new THREE.BufferAttribute(bedrockColors, 3));
    bedrockGeometry.computeVertexNormals();
    bedrockGeometry.computeBoundingBox();
    bedrockGeometry.computeBoundingSphere();
    // Reuse the cliff Lambert+vertex-color pipeline: no new shader topology.
    const bedrockMaterial = new THREE.MeshLambertNodeMaterial({ vertexColors: true });
    const bedrock = new THREE.Mesh(bedrockGeometry, bedrockMaterial);
    bedrock.name = "terraced-weathered-abyss-bedrock";
    bedrock.position.y = ABYSS_FLOOR_BASE_Y;
    bedrock.receiveShadow = false;
    bedrock.userData.terrain = {
      navigation: false,
      collision: false,
      terraces: ABYSS_FLOOR.terraceSteps,
      rampFraction: ABYSS_FLOOR.terraceRamp,
      relief: [minRelief, maxRelief],
      triangles: ABYSS_FLOOR.segments * ABYSS_FLOOR.segments * 2,
      noise: "low-frequency-terraces-plus-weathered-fbm",
    };
    ringGroup.add(bedrock);
  }

  scene.add(group);

  return {
    // The post chain samples this light's already-baked shadow depth to build
    // true occluded shafts; no duplicate light or shadow map is allocated.
    godrayLight: moon,
    /** refit shadows, canyon ring and haze to the current chain extent/centre.
     *  `top` = world height of the tallest stack: the moon backs off along its
     *  own direction and the shadow volume grows so sky-spires stay inside the
     *  light frustum instead of silently losing their shadows. */
    fit(half: number, centerX = 0, centerZ = 0, top = 0) {
      const k = Math.max(1, (top + 26) / 60);
      const r = half + 12 + top * 0.35;
      if (Math.abs(sc.right - r) >= 1) {
        sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r;
        sc.updateProjectionMatrix();
      }
      // Put the geological lid above the tallest generated architecture and
      // the streamed landmarks. Its hole is shifted upstream along the light
      // vector so the parallel shaft lands back on the maze centre at y=0.
      const roofY = top + 260;
      const openingRadius = THREE.MathUtils.clamp(half * 0.32, 24, 58);
      // upstream-shift ratios derived from MOON_DIR so the shaft angle is
      // tuned in one place; per unit of height the shaft drifts by tilt*height
      const tiltX = MOON_DIR.x / MOON_DIR.y;
      const tiltZ = MOON_DIR.z / MOON_DIR.y;
      // Re-seatable so the editor can drag the shaft without a re-forge.
      const seat = () => {
        const shape = godrayShape;
        const roof = roofY * shape.height;
        cavernAperture.position.set(
          centerX + roof * tiltX + shape.offsetX,
          roof,
          centerZ + roof * tiltZ + shape.offsetZ,
        );
        const radius = openingRadius * shape.radius;
        cavernAperture.scale.set(radius, shape.thickness, radius);
        cavernAperture.updateMatrixWorld();
        cavernAperture.userData.aperture = {
          ...cavernAperture.userData.aperture,
          openingRadius: radius,
          roofY: roof,
          center: cavernAperture.position.toArray(),
        };
      };
      seat();
      reseatGodray = seat;
      // seat the dust curtain along the aperture→maze shaft axis
      const shaftBottom = new THREE.Vector3(centerX, 4, centerZ);
      const shaftAxis = cavernAperture.position.clone().sub(shaftBottom);
      const shaftLength = shaftAxis.length();
      shaftDust.position.copy(shaftBottom).addScaledVector(shaftAxis, 0.5);
      shaftDust.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0), shaftAxis.normalize());
      shaftDust.scale.set(openingRadius * 2.1, shaftLength, openingRadius * 2.1);
      const lightHeight = roofY + 130;
      moon.position.set(
        centerX + lightHeight * tiltX,
        lightHeight,
        centerZ + lightHeight * tiltZ,
      );
      moon.target.position.set(centerX, 0, centerZ);
      // slanted light travels lightHeight / MOON_DIR.y to reach the target
      sc.far = Math.max(150 * k, lightHeight / MOON_DIR.y + 70);
      sc.updateProjectionMatrix();
      rim.position.set(centerX + 52, 20 * k, centerZ + 34);
      rim.target.position.set(centerX, 0, centerZ);
      // the bounced cave key comes down from the opposite rake to the moon,
      // so lit tops read as two overlapping directions rather than one flat wash
      caveFill.position.set(centerX + 90, top + 190, centerZ + 130);
      caveFill.target.position.set(centerX, 0, centerZ);
      // the mesa/mist/ruin ring was authored around a ~40-unit island — recentre
      // on the chain and push it outward so cliffs never intersect the blocks
      const s = Math.max(1, (half + 26) / 72);
      ringGroup.position.set(centerX, 0, centerZ);
      ringGroup.scale.set(s, 1, s);
      atmosphereParticles.position.set(centerX, 0, centerZ);
      const particleRadius = Math.max(68, half * 1.28);
      const particleHeight = Math.max(84, top + 54);
      for (let i = 0; i < particleCount; i++) {
        const ember = particleKinds[i] === 1;
        const size = ember
          ? 0.09 + hash2(seed, i, 806) * 0.09
          : 0.045 + hash2(seed, i, 806) * 0.055;
        particlePosition.set(
          particlePositions[i * 3] * particleRadius,
          ABYSS * TH - 9 + particlePositions[i * 3 + 1] * particleHeight,
          particlePositions[i * 3 + 2] * particleRadius,
        );
        particleQuaternion.setFromEuler(new THREE.Euler(
          hash2(seed, i, 807) * Math.PI,
          hash2(seed, i, 808) * Math.PI,
          hash2(seed, i, 809) * Math.PI,
        ));
        particleScale.setScalar(size);
        atmosphereParticles.setMatrixAt(i, particleMatrix.compose(particlePosition, particleQuaternion, particleScale));
      }
      atmosphereParticles.instanceMatrix.needsUpdate = true;
      atmosphereParticles.computeBoundingSphere();
      cemetery.invalidate();
      landmarkGroup.position.set(centerX, 0, centerZ);
      (landmarkGroup.userData as { fit?: (half: number, top: number) => void }).fit?.(half, top);
      const localLights = (landmarkGroup.userData as { cinematicLights?: CinematicLightSpec[] }).cinematicLights ?? [];
      applyCinematicLights?.(localLights.map((light) => ({
        ...light,
        x: light.x + centerX,
        z: light.z + centerZ,
        targetX: light.targetX === undefined ? undefined : light.targetX + centerX,
        targetZ: light.targetZ === undefined ? undefined : light.targetZ + centerZ,
      })));
      const bounce = (landmarkGroup.userData as { basinLights?: LightSpec[] }).basinLights ?? [];
      applyLandmarkLights?.(bounce.map((light) => ({
        ...light, x: light.x + centerX, z: light.z + centerZ,
      })));
      // longer sightlines need thinner air or the far blocks drown in haze
      hazeU.value = Math.min(0.008, Math.max(0.002, 0.5 / (half * 2.4)));
    },
    bakeShadows() {
      moon.shadow.needsUpdate = true;
    },
    tick(camera: THREE.Camera) {
      cemetery.tick(camera);
      (landmarkGroup.userData as { clearCamera?: (c: THREE.Camera) => void })
        .clearCamera?.(camera);
      atmosphereParticles.rotation.y = performance.now() * 0.000003;
    },
    dispose() {
      (landmarkGroup.userData as { dispose?: () => void }).dispose?.();
      horizon.dispose();
      cemetery.dispose();
      scene.remove(group);
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
      });
    },
  };
}
