// Code-native abyss landmarks reconstructed from the admitted img2threejs
// references.  The hero geometry is deliberately silhouette-heavy and keeps
// the whole exterior layer to a small, fixed draw-call count: stone/cavity
// pairs for the instanced wardens, buried skull and distant oracle, plus the
// shared arch, rubble and chain batches.

import * as THREE from "three/webgpu";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { CCDIKSolver } from "three/addons/animation/CCDIKSolver.js";
import {
  color, uv, smoothstep, sin, cos, time, mix, float, vec2, vec3, positionLocal,
  length, fract, triNoise3D, positionWorld, mx_noise_float,
} from "three/tsl";
import { hash2 } from "../gen/rng";
import { ABYSS } from "../gen/dungeon";
import { TH } from "../config";
import { makeHandPaintedLandmarkStoneMaterial, makeBrambleMat } from "./kit/materials";
import { brambleClumpGeometry, scatterBrambles } from "./brambles";
import { erodeGeometry, subdivideGeometry } from "./kit/erode";

/** Layered ghost-fire for the oracle's eye sockets. The torch flame material
 *  reads fine at prop scale but falls apart on a hero close-up, so the gaze
 *  gets its own build: a breathing radial halo, two turbulence octaves that
 *  tear real licking tongues into the flame edge, and a hot core ramp. All
 *  layers emit >1 linear values so bloom finishes the effect. */
function makeEyeFireMat(
  coreHex = 0xeafff6, midHex = 0x5ef2d6, deepHex = 0x0b8071,
): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const u = uv().x;
  const v = uv().y;
  const cx = u.sub(0.5).abs().mul(2);
  const n1 = triNoise3D(vec3(u.mul(2.2), v.mul(2.7).sub(time.mul(0.6)), 0.37), 0.35, time);
  const n2 = triNoise3D(vec3(u.mul(4.9).add(3.1), v.mul(5.3).sub(time.mul(1.15)), 1.91), 0.6, time);
  const turb = n1.mul(0.66).add(n2.mul(0.34));
  // tongue mask: tall teardrop eroded by scrolling turbulence
  const shape = smoothstep(1.0, 0.08, v.add(cx.pow(1.4).mul(1.05)).add(turb.mul(0.58).sub(0.28)))
    .mul(smoothstep(0.0, 0.16, float(1).sub(cx)));
  const ramp = mix(
    color(coreHex),
    mix(color(midHex), color(deepHex), smoothstep(0.25, 0.95, v)),
    smoothstep(0.04, 0.6, v.add(turb.mul(0.2))),
  );
  const sway = sin(time.mul(6.3).add(v.mul(4.2))).mul(v).mul(0.05);
  mat.positionNode = positionLocal.add(vec3(sway, 0, sway.mul(0.7)));
  mat.colorNode = ramp.mul(shape).mul(3.4);
  mat.opacityNode = shape.clamp(0, 1);
  return mat;
}

/** Bioluminescent water for the abyss basin: flat additive discs whose
 *  radial falloff is rippled by slow noise, so the floor reads as glowing
 *  water lapping the statue base and pooling under the maze (painted ref). */
/** Viscous internal churn — the liquid rolling over inside itself.
 *
 *  Surface patterns were the wrong model. A flow map advects a texture ACROSS
 *  a surface, which is right for a river seen from above and wrong for a body
 *  of luminous liquid: what reads as "deep" is turbulence happening at
 *  several depths at once, slowly folding into itself.
 *
 *  This is Iñigo Quilez's domain warping: noise sampled at a position that
 *  has itself been displaced by noise, twice. Each warp folds the field over
 *  and the result churns rather than scrolls. Time enters as a slow drift on
 *  the warp offsets, not as a scroll on the final lookup, so the pattern
 *  rolls in place instead of sliding past.
 *
 *  Returns the field in [-1, 1] plus the warp magnitude, which says how
 *  violently a given spot is being folded — the emissive cores are hung off
 *  that, so the light lives where the liquid is actually moving. */
function liquidChurn(scale: number, speed: number, fold: number) {
  const p = positionWorld.xz.mul(scale);
  const t = time.mul(speed);

  // first displacement: two independent noise fields as an offset vector
  const q = vec2(
    mx_noise_float(p.add(vec2(float(0), t))),
    mx_noise_float(p.add(vec2(float(5.2), t.negate().add(1.3)))),
  );
  // second displacement, sampled at the already-warped position: this is the
  // fold that turns drift into churn
  const warped = p.add(q.mul(fold));
  const r = vec2(
    mx_noise_float(warped.add(vec2(t.mul(0.4).add(1.7), float(9.2)))),
    mx_noise_float(warped.add(vec2(float(8.3), t.mul(-0.3).add(2.8)))),
  );
  return {
    value: mx_noise_float(p.add(r.mul(fold))),
    turbulence: r.x.abs().add(r.y.abs()).mul(0.5),
  };
}

function makeAbyssPoolMat(): THREE.MeshBasicNodeMaterial {
  // Pure additive glow ACCENT layered on the basin water body. There must be
  // exactly ONE dark normal-blended sheet (the basin): a second one overlaps
  // it, flips transparent sort order with camera motion and flickers as a
  // big dark blob. This layer only ever adds light, so ordering is safe.
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const fall = smoothstep(1.0, 0.06, length(uv().sub(0.5)).mul(2));
  // Faster and tighter than the basin: this is the pool the statue stands in,
  // where the bloom concentrates and the liquid is most agitated.
  const churn = liquidChurn(0.06, 0.1, 2.6);
  const level = churn.value.mul(0.5).add(0.5);
  const core = smoothstep(0.52, 0.86, level);
  const spark = smoothstep(0.5, 0.92, churn.turbulence).mul(core);
  mat.colorNode = color(0x1fd4b4).mul(core).mul(1.2)
    .add(color(0x9dffe8).mul(spark).mul(2.0))
    .mul(fall.pow(1.6));
  mat.opacityNode = fall.mul(0.85);
  return mat;
}

/** The broad basin sheet under the maze: much dimmer and PATCHY — dark
 *  water with drifting glowing blooms, not a uniform lit floor. */
function makeAbyssBasinMat(): THREE.MeshBasicNodeMaterial {
  // Same normal-blended water body as the root pool: dark surface with
  // drifting emissive blooms. Near-opaque so pillars and ruins get a clean
  // waterline instead of ghosting through an additive mist.
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false,
  });
  // A contained lagoon, not an ocean. In the reference the lit water is a
  // pocket that falls off hard into black; a sheet of even brightness to the
  // horizon is what made this read as a patterned floor.
  const radial = smoothstep(1.0, 0.05, length(uv().sub(0.5)).mul(2));
  const fall = radial.pow(2.2);
  const churn = liquidChurn(0.019, 0.05, 3.4);
  const level = churn.value.mul(0.5).add(0.5);

  // Emission is gated TWICE, because a surface that glows everywhere stops
  // reading as dark water with light in it.
  //  1. a very low-frequency mask, so only some stretches of the basin are
  //     alive at all — the rest is just black water;
  //  2. a high threshold inside those stretches, so within a lit stretch the
  //     glow still sits in cores rather than washing the whole area.
  const alive = smoothstep(0.30, 0.82,
    mx_noise_float(positionWorld.xz.mul(0.0042)).mul(0.5).add(0.5));

  // The churn MODULATES brightness; it does not draw a pattern. Thresholding
  // it produced legible swirls — decorated lino, not water. In the reference
  // the surface is a luminous gradient whose detail comes from bloom and from
  // the silhouettes standing in it, so the light is driven by the radial
  // falloff and the churn only breathes over the top of it.
  const modulation = level.mul(0.55).add(0.62);
  const pool = fall.mul(alive).mul(modulation);

  // Discrete motes. The reference's water is dotted with tiny hard points,
  // and they are what sells "alive" rather than merely "lit" — a very high
  // threshold on high-frequency noise leaves only isolated specks.
  const speckNoise = mx_noise_float(positionWorld.xz.mul(0.7)).mul(0.5).add(0.5);
  const drift = mx_noise_float(positionWorld.xz.mul(0.06).add(time.mul(0.05)))
    .mul(0.5).add(0.5);
  const specks = smoothstep(0.88, 0.99, speckNoise).mul(smoothstep(0.4, 0.85, drift));

  const body = color(0x0a2e2b).mul(radial.mul(modulation))
    .add(color(0x051917));
  mat.colorNode = color(0x2ad6b2).mul(pool).mul(2.3)
    .add(color(0xd6fff5).mul(specks).mul(alive).mul(radial).mul(4.0))
    .add(body);
  mat.opacityNode = radial.mul(0.9);
  return mat;
}

/** Bright shimmering shoreline band where the glowing water meets the
 *  statue's tentacle roots — the hottest teal edge in the reference. */
function makeAbyssShoreMat(): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const r = length(uv().sub(0.5)).mul(2);
  const band = smoothstep(0.74, 0.87, r).mul(smoothstep(1.0, 0.94, r));
  // the shoreline rides the same current as the water it edges, so the two
  // never look like separate effects laid on top of each other
  const wash = liquidChurn(0.13, 0.14, 2.2).value.mul(0.35).add(0.72);
  mat.colorNode = color(0x3af2cf).mul(band).mul(wash).mul(2.8);
  mat.opacityNode = band.mul(0.9);
  return mat;
}

/** The light the water puts INTO the air above it.
 *
 *  This is the layer the reference has and a flat lit plane never can: the
 *  lagoon's glow hangs in the air as a low bank of luminous haze, which is
 *  what makes the light feel like it has a source in the world rather than
 *  being a texture on the floor. A shallow dome over the water, additive and
 *  soft, fading out both at its rim and toward its top. */
function makeWaterHazeMat(): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
  });
  // v runs 0 at the dome's rim to 1 at its top: the haze is densest just
  // above the surface and thins out with height, like real ground mist
  const height = smoothstep(0.62, 0.0, uv().y);
  const breath = mx_noise_float(positionWorld.xz.mul(0.02).add(time.mul(0.05)))
    .mul(0.35).add(0.7);
  const alive = smoothstep(0.34, 0.80,
    mx_noise_float(positionWorld.xz.mul(0.0042)).mul(0.5).add(0.5));
  mat.colorNode = color(0x1fbfa4).mul(height).mul(breath).mul(alive).mul(0.95);
  mat.opacityNode = height.mul(alive).mul(0.62);
  return mat;
}

function makeEyeGlowMat(): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const fall = smoothstep(1.0, 0.04, length(uv().sub(0.5)).mul(2));
  const breathe = sin(time.mul(2.1)).mul(0.16).add(0.84);
  mat.colorNode = color(0x2fe8c8).mul(fall.pow(1.7)).mul(breathe).mul(1.1);
  mat.opacityNode = fall;
  return mat;
}

type AddPart = (
  geometry: THREE.BufferGeometry,
  position: [number, number, number],
  scale?: [number, number, number],
  rotation?: [number, number, number],
) => void;

function mergedParts(build: (add: AddPart) => void): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  build((geometry, p, s = [1, 1, 1], r = [0, 0, 0]) => {
    let part = geometry;
    if (part.index) {
      part = part.toNonIndexed();
      geometry.dispose();
    }
    for (const key of Object.keys(part.attributes)) {
      if (key !== "position" && key !== "normal") part.deleteAttribute(key);
    }
    matrix.compose(
      position.set(...p),
      quaternion.setFromEuler(euler.set(...r)),
      scale.set(...s),
    );
    part.applyMatrix4(matrix);
    parts.push(part);
  });
  const merged = BufferGeometryUtils.mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error("failed to merge abyss landmark geometry");
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function paintFacets(geometry: THREE.BufferGeometry, dark: number, light: number, seed: number): void {
  const pos = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const colors = new Float32Array(pos.count * 3);
  const lo = new THREE.Color(dark);
  const hi = new THREE.Color(light);
  const c = new THREE.Color();
  for (let tri = 0; tri < pos.count; tri += 3) {
    const cx = (pos.getX(tri) + pos.getX(tri + 1) + pos.getX(tri + 2)) / 3;
    const cy = (pos.getY(tri) + pos.getY(tri + 1) + pos.getY(tri + 2)) / 3;
    const cz = (pos.getZ(tri) + pos.getZ(tri + 1) + pos.getZ(tri + 2)) / 3;
    const raw = Math.sin(cx * 12.9898 + cy * 78.233 + cz * 37.719 + seed * 0.173) * 43758.5453;
    const grain = raw - Math.floor(raw);
    const top = normal ? Math.max(0, (normal.getY(tri) + normal.getY(tri + 1) + normal.getY(tri + 2)) / 3) : 0;
    c.copy(lo).lerp(hi, Math.min(1, 0.18 + grain * 0.42 + top * 0.22));
    for (let n = 0; n < 3; n++) {
      colors[(tri + n) * 3] = c.r;
      colors[(tri + n) * 3 + 1] = c.g;
      colors[(tri + n) * 3 + 2] = c.b;
    }
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

/** A low-sided, tapered curve mesh. Non-uniform radii and the Catmull-Rom
 * centreline produce real three-dimensional appendages that hold from side
 * views; they are not stacked cylinders or a camera-facing relief. */
function facetedTube(
  points: Array<[number, number, number]>,
  radii: number[],
  segments = 20,
  sides = 7,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, "centripetal");
  const frames = curve.computeFrenetFrames(segments, false);
  const positions: number[] = [];
  const indices: number[] = [];
  const centre = new THREE.Vector3();
  const radial = new THREE.Vector3();
  const radiusAt = (t: number) => {
    const f = t * (radii.length - 1);
    const i = Math.min(radii.length - 2, Math.floor(f));
    return THREE.MathUtils.lerp(radii[i], radii[i + 1], f - i);
  };
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, centre);
    const radius = radiusAt(t);
    for (let j = 0; j < sides; j++) {
      const a = j / sides * Math.PI * 2;
      const facet = 1 + Math.sin((i * 17 + j * 29) * 1.731) * 0.035;
      radial.copy(frames.normals[i]).multiplyScalar(Math.cos(a));
      radial.addScaledVector(frames.binormals[i], Math.sin(a)).multiplyScalar(radius * facet);
      positions.push(centre.x + radial.x, centre.y + radial.y, centre.z + radial.z);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * sides + j;
      const b = i * sides + (j + 1) % sides;
      const c = (i + 1) * sides + j;
      const d = (i + 1) * sides + (j + 1) % sides;
      indices.push(a, c, b, b, c, d);
    }
  }
  const startCentre = positions.length / 3;
  curve.getPointAt(0, centre);
  positions.push(centre.x, centre.y, centre.z);
  const endCentre = positions.length / 3;
  curve.getPointAt(1, centre);
  positions.push(centre.x, centre.y, centre.z);
  for (let j = 0; j < sides; j++) {
    indices.push(startCentre, (j + 1) % sides, j);
    const a = segments * sides + j;
    const b = segments * sides + (j + 1) % sides;
    indices.push(endCentre, a, b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function swordBladeGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-2.3, 0);
  shape.lineTo(0, -5.4);
  shape.lineTo(2.3, 0);
  shape.lineTo(2.0, 22);
  shape.lineTo(0, 24.2);
  shape.lineTo(-2.0, 22);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 1.1,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: 0.18,
    bevelThickness: 0.16,
    curveSegments: 1,
  });
  geometry.translate(0, 0, -0.55);
  return geometry;
}

function guardianStoneGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    // Throne and rubble plinth establish side-view thickness and embed every
    // lower contact instead of leaving a freestanding mannequin.
    add(new THREE.BoxGeometry(22, 3.2, 12), [0, 1.6, -1]);
    add(new THREE.BoxGeometry(15.5, 30, 6.2), [0, 19, -5.2], [1, 1, 1], [0.03, 0, 0]);
    add(new THREE.BoxGeometry(4.8, 29, 5.2), [-10.2, 16.5, -4], [1, 1, 1], [0, 0, -0.08]);
    add(new THREE.BoxGeometry(4.8, 26, 5.2), [10.2, 15, -4], [1, 1, 1], [0, 0, 0.06]);
    for (let k = 0; k < 8; k++) {
      const side = k & 1 ? 1 : -1;
      add(new THREE.IcosahedronGeometry(1, 1), [side * (4.5 + (k % 3) * 2.2), 1.2 + (k % 2), -1 + (k % 4) * 1.8], [2.5, 1.5, 2.2]);
    }

    // Seated legs, feet and plate-like knees.
    add(new THREE.IcosahedronGeometry(1, 2), [-4.7, 10.2, 0], [4.3, 7.8, 4.1], [0.03, 0, -0.08]);
    add(new THREE.IcosahedronGeometry(1, 2), [4.7, 10.2, 0], [4.3, 7.8, 4.1], [-0.03, 0, 0.08]);
    add(new THREE.IcosahedronGeometry(1, 1), [-5.2, 4.2, 4.1], [4.7, 2.2, 5.6]);
    add(new THREE.IcosahedronGeometry(1, 1), [5.2, 4.2, 4.1], [4.7, 2.2, 5.6]);
    add(new THREE.BoxGeometry(6.2, 2.2, 5), [-4.6, 14.8, 2.2], [1, 1, 1], [0.08, 0, -0.1]);
    add(new THREE.BoxGeometry(6.2, 2.2, 5), [4.6, 14.8, 2.2], [1, 1, 1], [-0.08, 0, 0.1]);

    // Torso core and layered collar/chest plates.
    add(new THREE.IcosahedronGeometry(1, 2), [0, 29.4, -0.2], [10.2, 9.1, 4.8]);
    add(new THREE.IcosahedronGeometry(1, 1), [0, 34.2, 2.5], [6.2, 1.45, 3.4], [0.05, 0, 0]);
    add(new THREE.IcosahedronGeometry(1, 1), [0, 31.5, 3.2], [5.6, 1.35, 3.15], [-0.06, 0, 0]);
    add(new THREE.OctahedronGeometry(3.7, 0), [0, 28.8, 4.3], [1.15, 1.25, 0.42], [0, 0, Math.PI / 4]);

    // Three overlapping pauldron tiers per side; the uneven cant keeps the two
    // instances from reading as stacks of identical boxes in moonlight.
    for (const side of [-1, 1]) {
      for (let tier = 0; tier < 3; tier++) {
        add(
          new THREE.IcosahedronGeometry(1, 1),
          [side * (8.0 + tier * 0.55), 34.2 - tier * 2.15, 0.4 + tier * 0.55],
          [5.3 - tier * 0.35, 1.55 - tier * 0.08, 3.5 - tier * 0.22],
          [0.04 * tier, side * 0.06, side * (0.26 - tier * 0.055)],
        );
      }
      add(new THREE.IcosahedronGeometry(1, 1), [side * 8.3, 27.1, 1.4], [3.2, 5.8, 3.0], [0, 0, side * 0.17]);
      add(new THREE.IcosahedronGeometry(1, 1), [side * 4.9, 23.3, 4.1], [5.0, 2.6, 2.8], [0, side * 0.12, side * 0.20]);
      add(new THREE.IcosahedronGeometry(1, 1), [side * 2.6, 23.0, 5.0], [2.7, 2.1, 2.0]);
      for (let finger = 0; finger < 4; finger++) {
        add(new THREE.BoxGeometry(0.75, 1.15, 1.8), [side * (0.75 + finger * 0.58), 21.8 - finger * 0.07, 6.1], [1, 1, 1], [0, 0, side * 0.12]);
      }
    }

    // Helmet, cheek guards and an irregular broken crown.
    add(new THREE.IcosahedronGeometry(1, 2), [0, 42.2, 0.5], [4.8, 5.8, 4.0]);
    add(new THREE.CylinderGeometry(5.2, 4.8, 2.5, 9), [0, 45.3, 0.4]);
    add(new THREE.BoxGeometry(2.5, 6.2, 1.8), [-2.2, 39.6, 4.1], [1, 1, 1], [0.08, 0.12, 0.12]);
    add(new THREE.BoxGeometry(2.5, 6.2, 1.8), [2.2, 39.6, 4.1], [1, 1, 1], [0.08, -0.12, -0.12]);
    add(new THREE.OctahedronGeometry(2.0, 0), [0, 39.5, 5.0], [0.8, 1.8, 0.7]);
    add(new THREE.CylinderGeometry(5.3, 5.0, 2.2, 9), [0, 48.0, 0.3]);
    const crownHeights = [5.0, 6.6, 7.8, 6.9, 5.5, 4.7, 5.8];
    for (let k = 0; k < crownHeights.length; k++) {
      const x = (k - 3) * 1.45;
      add(new THREE.ConeGeometry(1.1, crownHeights[k] * 0.78, 4), [x, 50.0 + crownHeights[k] * 0.33, 0.2 + Math.abs(k - 3) * 0.18], [1, 1, 0.9], [0.04 * (k & 1 ? 1 : -1), 0, (k - 3) * 0.025]);
    }

    // Sword, pommel, guard and raised fuller. The blade tip penetrates the
    // plinth, while both hands overlap the pommel by more than 0.02 units.
    add(swordBladeGeometry(), [0, 1.4, 6.2]);
    add(new THREE.BoxGeometry(9.2, 1.1, 1.5), [0, 25.9, 6.2]);
    add(new THREE.CylinderGeometry(0.8, 0.8, 4.0, 7), [0, 28.0, 6.2]);
    add(new THREE.OctahedronGeometry(1.3, 0), [0, 30.2, 6.2]);
    add(new THREE.BoxGeometry(0.55, 20.2, 1.22), [0, 11.8, 6.8]);
  });
  paintFacets(geometry, 0x293950, 0x65758c, 71);
  return geometry;
}

function guardianVoidGeometry(): THREE.BufferGeometry {
  return mergedParts((add) => {
    add(new THREE.CircleGeometry(1, 9), [0, 42.7, 4.25], [3.45, 0.72, 1], [0, 0, 0]);
    add(new THREE.BoxGeometry(2.1, 5.7, 0.35), [0, 39.6, 5.25], [1, 1, 1], [0, 0, 0]);
  });
}

function dragonSkullStoneGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    // Cranium and progressively tapered muzzle volumes.
    add(new THREE.IcosahedronGeometry(1, 2), [0, 14.2, -1.5], [13.5, 9.2, 10.0], [0.02, 0, 0.02]);
    add(new THREE.IcosahedronGeometry(1, 2), [0, 11.0, 8.5], [10.5, 6.2, 7.8]);
    add(new THREE.IcosahedronGeometry(1, 1), [0, 8.4, 18.0], [7.5, 4.5, 7.3]);
    add(new THREE.IcosahedronGeometry(1, 1), [0, 7.0, 26.0], [4.9, 3.2, 6.0]);
    add(facetedTube([[0, 10.0, 24.0], [0, 13.6, 27.2], [0, 18.2, 27.8]], [1.5, 1.0, 0.08], 8, 6), [0, 0, 0]);
    add(new THREE.TorusGeometry(3.7, 1.05, 6, 12), [-5.2, 15.7, 12.05], [1.08, 0.92, 1], [0, 0, -0.10]);
    add(new THREE.TorusGeometry(3.7, 1.05, 6, 12), [5.2, 15.7, 12.05], [1.08, 0.92, 1], [0, 0, 0.10]);
    for (const side of [-1, 1]) {
      add(facetedTube([
        [side * 5.4, 8.0, 8.2], [side * 5.1, 7.1, 15.5], [side * 4.4, 6.5, 23.0], [side * 3.3, 6.0, 29.0],
      ], [1.25, 1.05, 0.85, 0.5], 14, 7), [0, 0, 0]);
      add(facetedTube([
        [side * 5.0, 2.8, 7.5], [side * 4.8, 2.0, 15.0], [side * 4.0, 1.8, 22.0], [side * 2.9, 2.0, 27.0],
      ], [1.15, 1.0, 0.75, 0.42], 13, 7), [0, 0, 0]);
    }

    // Real side arches around the orbit; these keep an open socket from front
    // and three-quarter views instead of painting a black circle on a sphere.
    for (const side of [-1, 1]) {
      add(facetedTube([
        [side * 5.2, 20.2, 2.2], [side * 9.2, 18.8, 5.8], [side * 11.0, 14.2, 10.5], [side * 8.6, 10.0, 14.2],
      ], [1.9, 1.65, 1.35, 1.1], 11, 7), [0, 0, 0]);
      add(facetedTube([
        [side * 5.0, 6.1, 8.8], [side * 6.2, 4.6, 14.6], [side * 5.8, 3.7, 21.8], [side * 4.2, 3.0, 28.0],
      ], [1.75, 1.55, 1.2, 0.72], 13, 7), [0, 0, 0]);
    }

    // One dominant swept rear horn, one damaged partner and four cheek spikes.
    add(facetedTube([[5, 20, -5], [8, 25, -10], [10, 31, -17], [9, 37, -27]], [3.0, 2.5, 1.55, 0.12], 18, 7), [0, 0, 0]);
    add(facetedTube([[-6, 20, -5], [-10, 24, -10], [-12, 28, -16], [-12, 31, -20]], [2.8, 2.2, 1.25, 0.18], 14, 7), [0, 0, 0]);
    const spikeRoots: Array<[number, number, number, number]> = [
      [-11, 15, 0, -1], [11, 15, 0, 1], [-10, 10, 10, -1], [10, 10, 10, 1],
    ];
    for (const [x, y, z, side] of spikeRoots) {
      add(facetedTube([[x, y, z], [x + side * 4, y + 3, z - 1], [x + side * 7, y + 5, z - 2]], [1.6, 0.9, 0.08], 7, 6), [0, 0, 0]);
    }

    // Broken jaw hinge blocks and a few fossil chips that bridge into rubble.
    add(new THREE.IcosahedronGeometry(1, 1), [-7.6, 5.4, 5.0], [3.2, 3.1, 3.6]);
    add(new THREE.IcosahedronGeometry(1, 1), [7.6, 5.4, 5.0], [3.2, 3.1, 3.6]);
    for (let k = 0; k < 9; k++) {
      const a = -0.45 + k * 0.46;
      add(new THREE.IcosahedronGeometry(1, 1), [Math.cos(a) * (10 + k % 3), 0.8 + k % 2, 5 + Math.sin(a) * 12], [2.2 + k % 2, 1.5 + (k % 3) * 0.4, 2.0]);
    }
  });
  paintFacets(geometry, 0x34445a, 0x758299, 113);
  return geometry;
}

function dragonSkullTeethGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    // Teeth are a separate merged colour batch. They keep the inherited fossil
    // material family but stay readable against the near-black mouth gap.
    for (let k = 0; k < 12; k++) {
      const side = k & 1 ? 1 : -1;
      const row = Math.floor(k / 2);
      const z = 8.8 + row * 3.45;
      const height = 3.0 + (row % 3) * 0.68;
      add(new THREE.ConeGeometry(0.82 + (row % 2) * 0.12, height, 7), [side * (5.1 - row * 0.36), 6.0 - height / 2, z], [1, 1, 0.82], [0, 0, Math.PI + side * 0.08]);
      if (row < 5) add(new THREE.ConeGeometry(0.68, height * 0.78, 7), [side * (4.9 - row * 0.31), 2.8 + height * 0.32, z + 0.62], [1, 1, 0.82], [0, 0, side * 0.08]);
    }
  });
  paintFacets(geometry, 0x66758b, 0xa7b1c0, 139);
  return geometry;
}

function dragonSkullVoidGeometry(): THREE.BufferGeometry {
  return mergedParts((add) => {
    add(new THREE.CircleGeometry(1, 12), [-5.2, 15.7, 11.9], [4.5, 4.15, 1], [0, 0, -0.10]);
    add(new THREE.CircleGeometry(1, 12), [5.2, 15.7, 11.9], [4.5, 4.15, 1], [0, 0, 0.10]);
    add(new THREE.CircleGeometry(1, 7), [-1.45, 8.7, 32.1], [0.72, 1.0, 1], [0, 0, -0.08]);
    add(new THREE.CircleGeometry(1, 7), [1.45, 8.7, 32.1], [0.72, 1.0, 1], [0, 0, 0.08]);
    add(new THREE.BoxGeometry(9.4, 2.9, 21), [0, 4.3, 19.0]);
  });
}

const ORACLE_TENTACLES: Array<Array<[number, number, number]>> = [
  [[-6.4, 37, 10], [-11.5, 31, 13], [-14.5, 22, 15], [-10.5, 11, 14], [-18.5, 0, 10]],
  [[-4.7, 37, 12], [-7.8, 30, 16], [-3.2, 21, 18], [-9.0, 10, 16], [-5.4, -4, 12]],
  [[-2.4, 36, 13], [0.2, 29, 18], [-5.0, 20, 19], [1.0, 9, 18], [-4.2, -6, 13]],
  [[-0.8, 36, 14], [2.2, 28, 19], [-1.8, 18, 20], [3.8, 8, 18], [0.2, -7, 13]],
  [[1.2, 36, 14], [5.2, 29, 18], [0.5, 20, 20], [6.6, 10, 17], [3.8, -4, 12]],
  [[3.2, 37, 13], [8.4, 31, 16], [4.2, 21, 19], [10.0, 12, 15], [8.2, 0, 11]],
  [[5.2, 37, 11], [11.0, 32, 14], [13.8, 24, 15], [9.0, 15, 14], [16.5, 4, 9]],
  [[7.1, 38, 9], [12.0, 34, 12], [17.2, 28, 11], [14.5, 20, 9], [21.0, 12, 6]],
];

function oracleStoneGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    // Stepped cliff throne and irregular buttresses bury every appendage end.
    add(new THREE.BoxGeometry(34, 7, 13), [0, 1.0, -4]);
    add(new THREE.BoxGeometry(28, 39, 10), [0, 23, -7]);
    for (let k = 0; k < 14; k++) {
      const side = k & 1 ? 1 : -1;
      const rank = Math.floor(k / 2);
      const h = 7 + (rank % 4) * 5 + (k % 3) * 2;
      add(new THREE.BoxGeometry(4.0 + (k % 2), h, 5.5), [side * (11 + rank * 2.15), h / 2, -2 - (rank % 2) * 2], [1, 1, 1], [0, side * 0.05, side * (k % 3 - 1) * 0.035]);
    }

    // Convex rear cap, facial mask and cheek masses have enough z thickness to
    // hold at side and orbit angles.
    add(new THREE.IcosahedronGeometry(1, 2), [0, 49, 0], [14.2, 13.8, 10.5]);
    add(new THREE.IcosahedronGeometry(1, 2), [0, 41.0, 7.0], [12.4, 10.0, 7.2]);
    add(new THREE.IcosahedronGeometry(1, 1), [-7.2, 40, 10.0], [5.4, 6.0, 4.2], [0, 0.08, -0.08]);
    add(new THREE.IcosahedronGeometry(1, 1), [7.2, 40, 10.0], [5.4, 6.0, 4.2], [0, -0.08, 0.08]);
    add(new THREE.OctahedronGeometry(3.5, 1), [0, 39.6, 14.0], [0.65, 1.25, 0.75]);
    add(new THREE.TorusGeometry(3.25, 1.05, 6, 12), [-5.1, 45.1, 15.45], [1.1, 0.75, 1], [0, 0, -0.10]);
    add(new THREE.TorusGeometry(3.25, 1.05, 6, 12), [5.1, 45.1, 15.45], [1.1, 0.75, 1], [0, 0, 0.10]);
    add(facetedTube([[-9.5, 46, 8], [-5.5, 48.5, 12.0], [0, 49.2, 13.5], [5.5, 48.5, 12], [9.5, 46, 8]], [2.2, 2.0, 2.2, 2.0, 2.2], 16, 8), [0, 0, 0]);

    // Crown band and broken vertical teeth.
    add(new THREE.CylinderGeometry(10.2, 10.6, 3.2, 11), [0, 62.5, -0.2]);
    const crown = [6.0, 8.5, 7.0, 10.0, 8.0, 6.5, 8.8];
    for (let k = 0; k < crown.length; k++) {
      const a = (k / crown.length - 0.5) * 1.8;
      add(new THREE.BoxGeometry(2.7, crown[k], 3.1), [Math.sin(a) * 9.2, 64 + crown[k] * 0.42, Math.cos(a) * 3.2 - 0.8], [1, 1, 0.86], [0.03 * (k & 1 ? 1 : -1), a * 0.12, (k - 3) * 0.025]);
    }

    // Eight different S-curves. Roots start inside the facial mask and tips
    // overlap the throne/base, satisfying the no-floating attachment contract.
    for (let k = 0; k < ORACLE_TENTACLES.length; k++) {
      const rootRadius = 2.7 - Math.abs(k - 3.5) * 0.08;
      add(facetedTube(ORACLE_TENTACLES[k], [rootRadius, 2.45, 2.05, 1.55, 0.65], 24, 9), [0, 0, 0]);
    }
    for (let k = 0; k < 12; k++) {
      const a = k / 12 * Math.PI * 2;
      add(new THREE.IcosahedronGeometry(1, 1), [Math.cos(a) * (11 + k % 3), 0.2 + k % 2, 3 + Math.sin(a) * 7], [2.2 + k % 2, 1.3 + (k % 3) * 0.3, 1.9]);
    }
  });
  paintFacets(geometry, 0x2f4159, 0x6b7c94, 191);
  return geometry;
}

function oracleVoidGeometry(): THREE.BufferGeometry {
  return mergedParts((add) => {
    add(new THREE.CircleGeometry(1, 12), [-5.1, 45.1, 15.4], [3.8, 2.25, 1], [0, 0, -0.10]);
    add(new THREE.CircleGeometry(1, 12), [5.1, 45.1, 15.4], [3.8, 2.25, 1], [0, 0, 0.10]);
    add(new THREE.BoxGeometry(0.65, 8.5, 0.45), [-1.05, 56.0, 10.0], [1, 1, 1], [0, 0, -0.22]);
    add(new THREE.BoxGeometry(0.55, 5.0, 0.45), [1.0, 54.0, 10.2], [1, 1, 1], [0, 0, 0.30]);
  });
}

function brokenArchGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    add(new THREE.BoxGeometry(2.2, 15, 2.6), [-6, 7.5, 0], [1, 1, 1], [0, 0, -0.03]);
    add(new THREE.BoxGeometry(2.2, 11, 2.6), [6, 5.5, 0], [1, 1, 1], [0, 0, 0.05]);
    add(new THREE.BoxGeometry(6.5, 2.1, 2.6), [-2.2, 14.5, 0], [1, 1, 1], [0, 0, 0.06]);
    add(new THREE.BoxGeometry(3.2, 2.1, 2.6), [4.3, 13.2, 0], [1, 1, 1], [0, 0, -0.13]);
  });
  paintFacets(geometry, 0x172238, 0x40516b, 233);
  return geometry;
}

/** One authored backing mass for the streamed oracle. It is deliberately a
 * cliff, not a statue pedestal: a broad centre shelf guarantees the model's
 * back penetrates stone, while staggered buttresses break the top/side outline
 * so it can merge into the environment's larger horseshoe wall. */
function oracleBackingCliffGeometry(): THREE.BufferGeometry {
  // Segment counts, not decoration: this wall is 335 world units across, and at
  // one quad per box face its facets were tens of units wide — folded paper, at
  // any range where you can see the oracle's hands. The masses stay authored
  // (silhouette is the point), but each carries enough vertices for the erosion
  // pass below to actually cut into it. ~14k triangles for the whole cliff, one
  // mesh, one draw.
  const SEG = 8;
  const geometry = mergedParts((add) => {
    add(new THREE.BoxGeometry(86, 92, 26, SEG, SEG, SEG), [0, 44, 0]);
    add(new THREE.BoxGeometry(62, 34, 34, SEG, SEG, SEG), [-12, 100, -2], [1, 1, 1], [0.02, 0.04, -0.04]);
    add(new THREE.BoxGeometry(44, 28, 30, SEG, SEG, SEG), [25, 116, -3], [1, 1, 1], [-0.03, -0.08, 0.08]);
    const strata = [
      [-58, 20, 18, 43, 28], [-49, 61, 24, 78, 24], [-61, 99, 16, 45, 22],
      [58, 19, 20, 41, 30], [50, 60, 25, 75, 24], [62, 101, 17, 48, 22],
      [-35, 129, 23, 30, 24], [2, 134, 29, 34, 26], [38, 132, 21, 27, 23],
    ] as const;
    for (let i = 0; i < strata.length; i++) {
      const [x, y, w, h, d] = strata[i];
      add(
        new THREE.BoxGeometry(w, h, d, SEG, SEG, SEG), [x, y, -2 - (i % 3) * 2],
        [1, 1, 1], [(i % 2 ? 1 : -1) * 0.035, (i - 4) * 0.018, (i % 3 - 1) * 0.055],
      );
    }
    // Angular foot rocks make the wall continue below the fog line rather
    // than ending at one horizontal shelf.
    for (let i = 0; i < 14; i++) {
      const x = -66 + i * 10.2;
      const h = 15 + (i * 13 % 19);
      add(new THREE.IcosahedronGeometry(1, 3), [x, h * 0.42 - 4, 7 + (i % 4) * 2], [7 + (i % 3) * 2, h * 0.72, 8 + (i % 2) * 3], [i * 0.07, i * 0.19, (i % 3 - 1) * 0.12]);
    }
  });
  // Weathering comes last. It moves vertices, so it changes which way faces
  // point — painting the face values before this would colour the old normals.
  // subdivideGeometry returns a NEW geometry rather than mutating in place, so
  // the weathered result is what gets painted and returned — painting the
  // original here would colour a mesh nobody ever sees.
  const weathered = erodeGeometry(subdivideGeometry(geometry, 1), {
    seed: 419, amplitude: 1.5, frequency: 0.055, octaves: 4, strata: 0.6,
  });
  geometry.dispose();
  paintFacets(weathered, 0x111a2b, 0x34465f, 419);
  return weathered;
}

/** A grounded fan of monumental slate blades. The dominant blade climbs from
 * a broad buried root to a broken dragon shelf while shorter, parallel blades
 * preserve the deep triangular gaps visible in the supplied concept. */
export interface DragonPerchStrataProfile {
  height: number;
  baseRadius: number;
  midRadius: number;
  platformRadiusX: number;
  platformRadiusZ: number;
  lean: number;
  layers: number;
  sides: number;
  roughness: number;
  seed: number;
}

export const DRAGON_PERCH_STRATA: DragonPerchStrataProfile = {
  height: 128,
  baseRadius: 54,
  midRadius: 26,
  platformRadiusX: 45,
  platformRadiusZ: 41,
  lean: 155,
  layers: 7,
  sides: 8,
  roughness: 0.14,
  seed: 463,
};

// Art-directed in the live TransformControls review. This remains an additive
// landmark-group placement, so the generated support/IK frame and every maze-
// size-dependent fit continue to work unchanged underneath it.
export const DRAGON_LANDMARK_DEFAULT_OFFSET = [-110.4, 58.2, -210.4] as const;
const DRAGON_RENDER_SCALE = 24.6 * 0.7;

const DRAGON_LEG_CONTACTS = [
  { name: "fore_left", forward: 0.65, lateral: 1.28 },
  { name: "fore_right", forward: 0.65, lateral: -1.28 },
  { name: "hind_left", forward: -1.55, lateral: 1.58 },
  { name: "hind_right", forward: -1.55, lateral: -1.58 },
] as const;

interface DragonPerchFrame {
  point: THREE.Vector3;
  tangent: THREE.Vector3;
  up: THREE.Vector3;
  surfaceRadius: number;
}

function dragonPerchFrameAt(profile: DragonPerchStrataProfile): DragonPerchFrame {
  return {
    point: new THREE.Vector3(0, profile.height, -profile.lean),
    // The authored dragon faces local -Z while standing on a nearly level
    // capstone. Any dramatic rake belongs to the strata below its feet.
    tangent: new THREE.Vector3(0, -0.035, -1).normalize(),
    up: new THREE.Vector3(0, 1, -0.035).normalize(),
    surfaceRadius: 0,
  };
}

interface SlateBladeSection {
  x: number;
  y: number;
  z: number;
  width: number;
  thickness: number;
}

/** Closed four-sided loft used for every slate blade. Width runs across local
 * X; thickness follows the normal of the shared Y/Z geological dip. Keeping
 * the solids closed avoids the missing end caps that plagued the old perch. */
function dragonSlateBladeGeometry(sections: SlateBladeSection[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const prev = sections[Math.max(0, i - 1)];
    const next = sections[Math.min(sections.length - 1, i + 1)];
    const dy = next.y - prev.y;
    const dz = next.z - prev.z;
    const inv = 1 / Math.max(1e-5, Math.hypot(dy, dz));
    const ny = -dz * inv;
    const nz = dy * inv;
    const halfWidth = section.width * 0.5;
    const halfThickness = section.thickness * 0.5;
    for (const side of [-1, 1]) {
      for (const face of [-1, 1]) {
        positions.push(
          section.x + side * halfWidth,
          section.y + face * ny * halfThickness,
          section.z + face * nz * halfThickness,
        );
      }
    }
  }
  const ring = 4;
  for (let i = 0; i < sections.length - 1; i++) {
    const a = i * ring;
    const b = (i + 1) * ring;
    // Four consistently wound faces connect the rectangular section rings.
    indices.push(a, b, a + 1, a + 1, b, b + 1);
    indices.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);
    indices.push(a, a + 2, b, a + 2, b + 2, b);
    indices.push(a + 1, b + 1, a + 3, a + 3, b + 1, b + 3);
  }
  const last = (sections.length - 1) * ring;
  indices.push(0, 1, 2, 1, 3, 2);
  indices.push(last, last + 2, last + 1, last + 1, last + 2, last + 3);
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  indexed.setIndex(indices);
  const geometry = indexed.toNonIndexed();
  indexed.dispose();
  geometry.computeVertexNormals();
  return geometry;
}

/** Closed irregular wedge with a deliberately near-level top. It overlaps the
 * dominant blade by more than its own thickness, so it reads as one fractured
 * geological tip rather than a floating platform or a circular pedestal. */
function dragonSlateShelfGeometry(profile: DragonPerchStrataProfile): THREE.BufferGeometry {
  const footprint: Array<[number, number]> = [
    [-45, -141], [-34, -201], [-8, -216], [29, -210],
    [47, -190], [43, -151], [18, -132], [-28, -134],
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  const top = profile.height;
  for (let i = 0; i < footprint.length; i++) {
    const [x, z] = footprint[i];
    positions.push(x, top + Math.sin(i * 2.31) * 0.34, z);
  }
  for (let i = 0; i < footprint.length; i++) {
    const [x, z] = footprint[i];
    positions.push(x * 0.84, top - 13 - (i % 3) * 1.8, z + 7);
  }
  const topCenter = positions.length / 3;
  positions.push(1, top, -173);
  const bottomCenter = positions.length / 3;
  positions.push(-1, top - 15, -168);
  const count = footprint.length;
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    indices.push(topCenter, i, next);
    indices.push(bottomCenter, count + next, count + i);
    indices.push(i, count + i, next, next, count + i, count + next);
  }
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  indexed.setIndex(indices);
  const geometry = indexed.toNonIndexed();
  indexed.dispose();
  geometry.computeVertexNormals();
  return geometry;
}

function offsetSlateSections(
  source: SlateBladeSection[],
  xOffset: number,
  surfaceLift: number,
  width: number,
  thickness: number,
): SlateBladeSection[] {
  return source.slice(1, -1).map((section, index, middle) => {
    const u = (index + 1) / (middle.length + 1);
    return {
      x: section.x + xOffset * Math.sin(u * Math.PI),
      y: section.y + surfaceLift * (0.86 + 0.14 * Math.sin(u * Math.PI)),
      z: section.z + surfaceLift * 0.46,
      width: width * Math.sin(u * Math.PI) + 0.45,
      thickness: thickness * Math.sin(u * Math.PI) + 0.35,
    };
  });
}

function slateLaminaSections(
  source: SlateBladeSection[],
  start: number,
  end: number,
  xOffset: number,
  surfaceLift: number,
  widthScale: number,
  thickness: number,
): SlateBladeSection[] {
  const slice = source.slice(start, end + 1);
  return slice.map((section, index) => {
    const edgeTaper = index === 0 || index === slice.length - 1 ? 0.62 : 1;
    const stagger = Math.sin((index + start) * 2.17) * 1.7;
    return {
      x: section.x + xOffset + Math.sin(index * 1.83) * 1.2,
      y: section.y + surfaceLift + stagger * 0.28,
      z: section.z + surfaceLift * 0.46 + stagger,
      width: section.width * widthScale * edgeTaper,
      thickness: thickness * (0.82 + Math.sin(index * 2.41 + start) * 0.12),
    };
  });
}

/** One merged draw containing closed diagonal wedge solids. The outline is
 * governed by a 34-degree dip and a 5:1 main-blade length/thickness ratio;
 * subordinate blades share the dip but stop at clearly stepped lengths. */
function dragonPerchColumnGeometry(profile: DragonPerchStrataProfile): THREE.BufferGeometry {
  const dominant: SlateBladeSection[] = [
    { x: 0, y: -3, z: 20, width: 96, thickness: 41 },
    { x: -2, y: 18, z: -8, width: 82, thickness: 35 },
    { x: 2, y: 42, z: -39, width: 70, thickness: 30 },
    { x: -1, y: 67, z: -76, width: 60, thickness: 26 },
    { x: 3, y: 91, z: -114, width: 50, thickness: 22 },
    { x: 0, y: 112, z: -151, width: 42, thickness: 18 },
    { x: 1, y: 124, z: -180, width: 33, thickness: 13 },
    { x: -1, y: 134, z: -207, width: 1.8, thickness: 1.5 },
  ];
  const blade = (
    x: number,
    endY: number,
    endZ: number,
    rootWidth: number,
    thickness: number,
    kink: number,
  ): SlateBladeSection[] => [
    { x, y: -4, z: 22 + Math.abs(x) * 0.035, width: rootWidth, thickness: thickness * 1.42 },
    { x: x - kink * 0.35, y: endY * 0.24, z: THREE.MathUtils.lerp(16, endZ, 0.22), width: rootWidth * 0.82, thickness },
    { x: x + kink, y: endY * 0.54, z: THREE.MathUtils.lerp(16, endZ, 0.52), width: rootWidth * 0.58, thickness: thickness * 0.72 },
    { x: x - kink * 0.25, y: endY * 0.82, z: THREE.MathUtils.lerp(16, endZ, 0.81), width: rootWidth * 0.31, thickness: thickness * 0.42 },
    { x: x + kink * 0.15, y: endY, z: endZ, width: 1.4, thickness: 1.2 },
  ];
  const geometry = mergedParts((add) => {
    add(dragonSlateBladeGeometry(dominant), [0, 0, 0]);
    // Two near-main carrier beds supply the bulky stacked core visible in the
    // reference instead of leaving one smooth, knife-thin central plane.
    add(dragonSlateBladeGeometry(blade(-16, 119, -166, 78, 29, 3)), [0, -4, 8], [1, 1, 1], [0.01, -0.018, -0.018]);
    add(dragonSlateBladeGeometry(blade(15, 108, -145, 69, 25, -4)), [0, -7, 13], [1, 1, 1], [-0.014, 0.022, 0.02]);
    add(dragonSlateBladeGeometry(blade(-54, 100, -126, 56, 24, -4)), [0, 0, 0], [1, 1, 1], [0.015, -0.025, -0.018]);
    add(dragonSlateBladeGeometry(blade(-84, 78, -88, 48, 21, 3)), [0, 0, 0], [1, 1, 1], [-0.02, 0.04, 0.014]);
    add(dragonSlateBladeGeometry(blade(49, 109, -139, 50, 22, 4)), [0, 0, 0], [1, 1, 1], [-0.012, 0.026, 0.018]);
    add(dragonSlateBladeGeometry(blade(78, 86, -92, 42, 19, -3)), [0, 0, 0], [1, 1, 1], [0.018, -0.035, -0.012]);
    add(dragonSlateBladeGeometry(blade(102, 64, -55, 34, 16, 2)), [0, 0, 0], [1, 1, 1], [-0.012, 0.045, 0.02]);

    // Buried counter-slabs broaden the base without creating a cylindrical
    // stump. All three point along the same thrust-fault family.
    add(dragonSlateBladeGeometry(blade(-30, 35, 6, 54, 23, -2)), [-5, -7, 22], [1.08, 1, 1.08], [0, 0.08, -0.05]);
    add(dragonSlateBladeGeometry(blade(28, 31, 14, 49, 21, 3)), [4, -8, 28], [1.12, 0.92, 1.06], [0, -0.06, 0.04]);

    add(dragonSlateShelfGeometry(profile), [0, 0, 0]);

    // Broad overlapping laminae are the middle-distance identity cue from the
    // concept. Their broken ends form large stepped ledges across the carrier
    // face; this is what prevents the long blade from reading as a runway.
    const laminae = [
      slateLaminaSections(dominant, 0, 4, -3, 7.2, 0.84, 2.8),
      slateLaminaSections(dominant, 1, 5, 2, 10.1, 0.91, 2.35),
      slateLaminaSections(dominant, 2, 6, -1, 13.0, 0.78, 1.95),
      slateLaminaSections(dominant, 1, 4, 5, 15.6, 0.57, 1.55),
    ];
    for (let i = 0; i < laminae.length; i++) {
      add(dragonSlateBladeGeometry(laminae[i]), [0, 0, 0], [1, 1, 1], [0, (i - 1.5) * 0.006, (i % 2 ? 1 : -1) * 0.006]);
    }

    // Five discontinuous longitudinal ridges make the faces read as slate at
    // middle distance. They remain closed, extremely low-poly lofts and merge
    // into the same draw call as the carrier blade.
    for (let i = 0; i < 4; i++) {
      const ridge = offsetSlateSections(dominant, -14 + i * 9.5, 17.8 + (i % 2) * 0.8, 2.2 + (i % 3) * 0.65, 1.05);
      add(dragonSlateBladeGeometry(ridge), [0, 0, 0], [1, 1, 1], [0, (i - 2) * 0.006, 0]);
    }

    // Sparse transverse fracture wedges interrupt the long planes without
    // turning the landmark into noisy rubble.
    const fissures = [
      [-14, 47, -20, 29, 1.1, 5.5, -0.98],
      [11, 70, -61, 25, 0.9, 4.8, -1.02],
      [-8, 92, -103, 20, 0.8, 4.2, -0.96],
      [6, 110, -139, 15, 0.7, 3.5, -1.04],
    ] as const;
    for (const [x, y, z, width, height, depth, rake] of fissures) {
      add(new THREE.BoxGeometry(width, height, depth), [x, y, z], [1, 1, 1], [rake, 0.04 * Math.sign(x || 1), 0.03]);
    }
  });
  paintFacets(geometry, 0x111c2d, 0x53677c, profile.seed);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.componentIds = [
    "grounded-root", "dominant-blade", "secondary-blade-left", "secondary-blade-fan",
    "landing-shelf", "lamination-ridges", "blade-edges", "blade-fissures",
  ];
  geometry.userData.fractureGroups = ["root-embed", "dominant-blade", "left-blade", "right-fan", "landing-shelf"];
  geometry.userData.closedSolids = 23;
  return geometry;
}

/** Reusable one-draw arch bay. Local +Z follows the path tangent, so a row of
 * instances becomes a readable arcade rather than unrelated portal props. */
function abyssArcadeBayGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    add(new THREE.BoxGeometry(7.4, 0.55, 5.4), [0, 0.15, 0]);
    for (const side of [-1, 1]) {
      add(new THREE.BoxGeometry(1.25, 7.4, 1.55), [side * 3.0, 3.8, 0]);
      add(new THREE.BoxGeometry(2.05, 0.8, 2.25), [side * 3.0, 0.45, 0]);
      add(new THREE.BoxGeometry(1.65, 0.65, 1.95), [side * 3.0, 7.45, 0]);
    }
    // Nine chunky voussoirs form a real semicircular crown. Their tangential
    // cant and overlap remove the flat-lintel/box-gate read from a distance.
    for (let i = 0; i < 9; i++) {
      const a = i / 8 * Math.PI;
      const x = Math.cos(a) * 3.0;
      const y = 7.2 + Math.sin(a) * 3.0;
      add(new THREE.BoxGeometry(1.15, 1.55, 1.65), [x, y, 0], [1, 1, 1], [0, 0, a - Math.PI / 2]);
    }
    // Shallow side rubble ties each repeated bay into the bedrock while
    // preserving a wide clear visual centreline.
    for (const side of [-1, 1]) {
      add(new THREE.IcosahedronGeometry(1, 1), [side * 3.9, 0.6, 0.9], [1.4, 0.85, 1.7], [0.2, side * 0.4, side * 0.12]);
      add(new THREE.IcosahedronGeometry(1, 0), [side * 3.65, 0.45, -1.3], [1.0, 0.7, 1.25], [-0.1, side * 0.25, -side * 0.09]);
    }
  });
  paintFacets(geometry, 0x162236, 0x4a5b72, 487);
  return geometry;
}

/** Dragon-side narrative kit: the slate spire is treated as an ancient treasure
 * barrow rather than a generic monster pedestal.  The vocabulary is the
 * western hoard-guardian tradition (burial mound, oath stones and captured
 * arms), kept deliberately separate from pearl/cloud/water dragon motifs. */
function dragonHoardGateGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    // A rough cairn facade overlaps the buried slate roots, so the gate
    // reads as an excavation in the rock rather than a freestanding prop.
    for (let i = 0; i < 13; i++) {
      const side = i & 1 ? 1 : -1;
      add(
        new THREE.IcosahedronGeometry(1, i % 3 ? 1 : 0),
        [side * (6.4 + (i % 4) * 2.3), 2.1 + (i % 5) * 2.1, 1.2 + (i % 3)],
        [3.6 + (i % 3), 2.5 + (i % 4), 3.2 + (i % 2)],
        [i * 0.13, side * i * 0.06, side * (i % 3 - 1) * 0.08],
      );
    }
    // Corbelled entrance stones and nine wedge-like crown blocks. The clear
    // black opening is supplied by a separate cavity mesh below.
    for (const side of [-1, 1]) {
      add(new THREE.BoxGeometry(3.1, 12.5, 4.2), [side * 6.15, 6.25, 0], [1, 1, 1], [0, 0, side * 0.04]);
      add(new THREE.BoxGeometry(4.2, 1.4, 5.0), [side * 6.15, 0.7, 0.15]);
    }
    for (let i = 0; i < 9; i++) {
      const a = i / 8 * Math.PI;
      add(
        new THREE.BoxGeometry(2.45, 3.0, 4.5),
        [Math.cos(a) * 6.05, 11.9 + Math.sin(a) * 5.8, 0],
        [1, 1, 1],
        [0, 0, a - Math.PI / 2],
      );
    }
    // Broken royal torque/threshold: readable treasure-language without a
    // costly glittering coin pile.
    add(new THREE.TorusGeometry(3.2, 0.42, 5, 13, Math.PI * 1.55), [0, 1.15, -2.35], [1, 0.62, 1], [Math.PI / 2, 0, -0.28]);
    add(new THREE.OctahedronGeometry(0.72, 0), [-3.1, 1.25, -2.35]);
    add(new THREE.OctahedronGeometry(0.72, 0), [3.1, 1.25, -2.35]);
  });
  paintFacets(geometry, 0x111a2b, 0x46566c, 503);
  return geometry;
}

function dragonHoardVoidGeometry(): THREE.BufferGeometry {
  return mergedParts((add) => {
    add(new THREE.BoxGeometry(8.8, 8.4, 0.5), [0, 5.0, 2.3]);
    add(new THREE.CircleGeometry(4.4, 12), [0, 9.2, 2.3], [1, 1, 1]);
  });
}

/** A single tribute/trophy marker. Seven GPU instances turn the arcade's last
 * approach into a procession without placing gameplay obstacles in the maze. */
function dragonOathStelaGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    add(new THREE.BoxGeometry(4.8, 1.0, 3.6), [0, 0.5, 0]);
    add(new THREE.BoxGeometry(3.45, 9.2, 1.45), [0, 5.2, 0], [1, 1, 1], [0.015, 0, -0.025]);
    add(new THREE.ConeGeometry(2.35, 3.5, 4), [0, 11.25, 0], [1, 1, 0.68], [0, Math.PI / 4, 0]);
    // Shield and inverted sword are sculptural silhouettes, not text decals.
    add(new THREE.CylinderGeometry(1.55, 1.55, 0.48, 9), [0, 6.0, -0.95], [1, 1.15, 1], [Math.PI / 2, 0, 0]);
    add(new THREE.BoxGeometry(0.36, 5.7, 0.55), [0, 5.8, -1.32]);
    add(new THREE.BoxGeometry(2.6, 0.34, 0.62), [0, 7.65, -1.32]);
    add(new THREE.ConeGeometry(0.55, 1.4, 4), [0, 2.25, -1.32], [1, 1, 0.72], [0, Math.PI / 4, Math.PI]);
  });
  paintFacets(geometry, 0x182338, 0x526176, 521);
  return geometry;
}

function dragonWardStoneGeometry(): THREE.BufferGeometry {
  const geometry = mergedParts((add) => {
    add(new THREE.BoxGeometry(2.8, 4.6, 1.4), [0, 2.3, 0], [1, 1, 1], [0.04, 0, -0.025]);
    add(new THREE.ConeGeometry(1.75, 2.5, 5), [0, 5.65, 0], [1, 1, 0.78]);
    add(new THREE.BoxGeometry(3.8, 0.65, 2.2), [0, 0.32, 0]);
  });
  paintFacets(geometry, 0x131e30, 0x3e5068, 541);
  return geometry;
}

/** Three thick strokes form a deliberately invented dragon-ward rune. It is
 * fantasy iconography rather than a claimed historical alphabet. */
function dragonWardRuneGeometry(): THREE.BufferGeometry {
  return mergedParts((add) => {
    add(new THREE.BoxGeometry(0.34, 3.15, 0.16), [0, 2.75, -0.79], [1, 1, 1], [0, 0, 0.48]);
    add(new THREE.BoxGeometry(0.34, 3.15, 0.16), [0, 2.75, -0.80], [1, 1, 1], [0, 0, -0.48]);
    add(new THREE.BoxGeometry(2.2, 0.32, 0.17), [0, 2.25, -0.82]);
  });
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  return geometry.index ? geometry.index.count / 3 : geometry.getAttribute("position").count / 3;
}

const TRIPO_ORACLE_RENDER = "/assets/abyss/oracle/oracle-render-30k.glb";
const TRIPO_ORACLE_DESTRUCTION_PROXY = "/assets/abyss/oracle/oracle-destruction-proxy-2500.glb";
const TRIPO_WARDEN_RENDER = "/assets/abyss/warden/warden-render-30k.glb";
const TRIPO_WARDEN_RANK_RENDER = "/assets/abyss/warden/warden-rank-render-8k.glb";
const TRIPO_WARDEN_DESTRUCTION_PROXY = "/assets/abyss/warden/warden-destruction-proxy-2500.glb";
const TRIPO_DRAGON_RENDER = "/assets/abyss/dragon/dragon-render-45k-rigged-runtime.glb";
const TRIPO_DRAGON_PERCH_RENDER = "/assets/abyss/dragon/dragon-slate-perch-qr1k.glb?v=adaptive100-scale70-contact-6";

// Neural landmark shells are Draco-compressed and streamed only after the
// first visible frame. Keeping one shared decoder avoids three independent
// WASM compilations while preserving the no-I/O startup path.
const tripoDracoLoader = new DRACOLoader();
// The decoder path is not optional. DRACOLoader defaults to '', which resolves
// against the site root, so it asked for /draco_wasm_wrapper.js — a path the SPA
// answers with index.html. The loader then evaluates HTML as JavaScript, throws
// "Unexpected token '<'" with no error callback anywhere to catch it, and every
// Draco landmark silently never arrives: the oracle, the wardens and the dragon
// all had their slots in the scene and nothing inside them.
//
// Vendored under public/draco rather than a CDN so the scene still forges with
// no network, and so the decoder cannot drift from the bundled three version.
tripoDracoLoader.setDecoderPath("/draco/gltf/");
/** Every landmark stream, and what became of it.
 *
 *  None of the `load()` calls below passed an error callback, so three's
 *  default did the only thing it can — nothing. A decoder that answered with
 *  HTML took out the oracle, both warden ranks and the dragon at once, and the
 *  scene reported no problem at all: the slots were in the graph, just empty.
 *  Wrapping `load` once here means a failure can never be silent again, and
 *  `__df.landmarkStreams()` says whether a request was even made. */
const landmarkStreamLog: Array<{ label: string; url: string; state: string; detail?: string }> = [];

export function landmarkStreamStatus(): Array<{ label: string; url: string; state: string; detail?: string }> {
  return landmarkStreamLog.map((entry) => ({ ...entry }));
}

function traceStreams(loader: GLTFLoader, label: string): GLTFLoader {
  const original = loader.load.bind(loader);
  loader.load = (url, onLoad, onProgress, onError) => {
    const entry = { label, url: String(url), state: "requested" as string, detail: undefined as string | undefined };
    landmarkStreamLog.push(entry);
    original(
      url,
      (gltf) => { entry.state = "loaded"; onLoad?.(gltf); },
      onProgress,
      (error) => {
        entry.state = "failed";
        entry.detail = String((error as Error)?.message ?? error);
        console.error(`[landmark] ${label} failed to stream ${url}`, error);
        onError?.(error);
      },
    );
  };
  return loader;
}

const tripoGltfLoader = traceStreams(new GLTFLoader(), "tripo");
tripoGltfLoader.setDRACOLoader(tripoDracoLoader);
// Dragon carries four leg chains plus a restrained neck-look chain.
// A dedicated loader prevents the other streamed landmarks from starving its
// decode or coupling their cancellation state.
const dragonGltfLoader = traceStreams(new GLTFLoader(), "dragon");
dragonGltfLoader.setDRACOLoader(tripoDracoLoader);

function disposeLoadedGraph(group: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>();
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    for (const material of materials) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      material.dispose();
    }
  });
  for (const texture of textures) texture.dispose();
}

interface PerchSurfaceHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  triangle: number;
}

/** Highest upward-facing triangle under a local X/Z query. The retopologized
 * perch is only 2,386 triangles, so four exact CPU samples when fit() changes
 * are cheaper and more reliable than maintaining a second collision mesh. */
function samplePerchSurfaceXZ(
  geometry: THREE.BufferGeometry,
  x: number,
  z: number,
): PerchSurfaceHit | null {
  const position = geometry.getAttribute("position");
  if (!position) return null;
  const normal = geometry.getAttribute("normal");
  const index = geometry.index;
  const triangleCount = (index ? index.count : position.count) / 3;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const edgeA = new THREE.Vector3();
  const edgeB = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();
  const interpolatedNormal = new THREE.Vector3();
  let best: PerchSurfaceHit | null = null;

  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const ia = index ? index.getX(triangle * 3) : triangle * 3;
    const ib = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1;
    const ic = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2;
    a.fromBufferAttribute(position, ia);
    b.fromBufferAttribute(position, ib);
    c.fromBufferAttribute(position, ic);

    const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(denominator) < 1e-6) continue;
    const wa = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / denominator;
    const wb = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / denominator;
    const wc = 1 - wa - wb;
    if (wa < -1e-4 || wb < -1e-4 || wc < -1e-4) continue;

    edgeA.subVectors(b, a);
    edgeB.subVectors(c, a);
    faceNormal.crossVectors(edgeA, edgeB).normalize();
    if (faceNormal.y < 0.08) continue;
    const y = a.y * wa + b.y * wb + c.y * wc;
    if (best && y <= best.point.y) continue;

    if (normal) {
      interpolatedNormal.set(
        normal.getX(ia) * wa + normal.getX(ib) * wb + normal.getX(ic) * wc,
        normal.getY(ia) * wa + normal.getY(ib) * wb + normal.getY(ic) * wc,
        normal.getZ(ia) * wa + normal.getZ(ib) * wb + normal.getZ(ic) * wc,
      ).normalize();
      if (interpolatedNormal.y < 0.08) interpolatedNormal.copy(faceNormal);
    } else {
      interpolatedNormal.copy(faceNormal);
    }
    best = {
      point: new THREE.Vector3(x, y, z),
      normal: interpolatedNormal.clone(),
      triangle,
    };
  }
  return best;
}

function paintPerchStone(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  if (!position) return;
  const colors = new Float32Array(position.count * 3);
  const dark = new THREE.Color(0x111c2d);
  const light = new THREE.Color(0x53677c);
  const value = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const raw = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + DRAGON_PERCH_STRATA.seed * 0.173) * 43758.5453;
    const grain = raw - Math.floor(raw);
    const strata = Math.sin(y * 0.19 + x * 0.035 + Math.sin(z * 0.05) * 0.9) * 0.5 + 0.5;
    const top = normal ? Math.max(0, normal.getY(i)) : 0;
    value.copy(dark).lerp(light, THREE.MathUtils.clamp(0.12 + grain * 0.28 + strata * 0.24 + top * 0.2, 0, 1));
    colors[i * 3] = value.r;
    colors[i * 3 + 1] = value.g;
    colors[i * 3 + 2] = value.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

/** Replace the zero-I/O procedural first-frame proxy with the watertight
 * QuadRemesher shell. It reuses the resident hand-painted stone material, so
 * the swap adds no texture upload or shader/material permutation. */
function streamTripoDragonPerch(target: THREE.Mesh, onReady: () => void): () => void {
  let cancelled = false;
  let timeoutId = 0;
  let deferFrameId = 0;

  const start = () => {
    if (cancelled) return;
    target.userData.streamState = "loading";
    tripoGltfLoader.load(TRIPO_DRAGON_PERCH_RENDER, (gltf) => {
      if (cancelled) {
        disposeLoadedGraph(gltf.scene);
        return;
      }
      gltf.scene.updateMatrixWorld(true);
      let source: THREE.Mesh | null = null;
      gltf.scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!source && mesh.isMesh) source = mesh;
      });
      if (!source) {
        target.userData.streamState = "fallback";
        disposeLoadedGraph(gltf.scene);
        return;
      }

      const sourceMesh = source as THREE.Mesh;
      let geometry = sourceMesh.geometry.clone();
      geometry.applyMatrix4(sourceMesh.matrixWorld);
      for (const attribute of Object.keys(geometry.attributes)) {
        if (attribute !== "position" && attribute !== "normal") geometry.deleteAttribute(attribute);
      }
      if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
      // The shipped perch is a 986-quad remesh — about a thousand triangles
      // holding up a spire 128 units tall, so its facets are ten units across.
      // That is fine for a thing on the horizon and wrong for the one rock a
      // dragon sits on, which the camera gets right up against. Subdividing
      // twice and weathering the result gives it a surface; the silhouette the
      // remesh was chosen for is untouched, because midpoint subdivision never
      // leaves the original hull.
      const before = geometry.getAttribute("position").count / 3;
      geometry = erodeGeometry(subdivideGeometry(geometry, 3), {
        seed: DRAGON_PERCH_STRATA.seed, amplitude: 0.8, frequency: 0.06, octaves: 4, strata: 0.7,
      });
      geometry.userData.weathered = { from: before, to: geometry.getAttribute("position").count / 3 };
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      paintPerchStone(geometry);
      geometry.userData.source = "tripo-v3.1-quadremesher-1k";
      geometry.userData.quadFaces = 986;
      geometry.userData.triangles = triangleCount(geometry);

      const fallbackGeometry = target.geometry;
      target.geometry = geometry;
      fallbackGeometry.dispose();
      target.userData.streamState = "ready";
      target.userData.renderUrl = TRIPO_DRAGON_PERCH_RENDER;
      target.userData.renderTriangles = triangleCount(geometry);
      target.userData.renderVertices = geometry.getAttribute("position").count;
      target.userData.surfaceSampler = "highest-upward-triangle-xz";
      disposeLoadedGraph(gltf.scene);
      onReady();
    }, undefined, (error) => {
      target.userData.streamState = "fallback";
      console.warn("Deferred Tripo dragon perch load failed; retaining procedural fallback", error);
    });
  };

  target.userData.streamState = "deferred";
  target.userData.renderUrl = TRIPO_DRAGON_PERCH_RENDER;
  deferFrameId = requestAnimationFrame(() => {
    deferFrameId = requestAnimationFrame(() => {
      timeoutId = window.setTimeout(start, 120);
    });
  });

  return () => {
    cancelled = true;
    if (timeoutId) clearTimeout(timeoutId);
    if (deferFrameId) cancelAnimationFrame(deferFrameId);
  };
}

function paintDragonStone(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute("position");
  if (!position) return;
  const colors = new Float32Array(position.count * 3);
  const dark = new THREE.Color(0x18263a);
  const light = new THREE.Color(0x53677e);
  const value = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const raw = Math.sin(x * 5.71 + y * 2.93 + z * 4.17) * 43758.5453;
    const chip = raw - Math.floor(raw);
    const strata = Math.sin(y * 2.45 + Math.sin(x * 0.7) * 0.8) * 0.5 + 0.5;
    const shade = THREE.MathUtils.clamp(0.18 + chip * 0.28 + strata * 0.24, 0, 1);
    value.copy(dark).lerp(light, shade);
    colors[i * 3] = value.r;
    colors[i * 3 + 1] = value.g;
    colors[i * 3 + 2] = value.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

interface DragonLegTarget {
  name: typeof DRAGON_LEG_CONTACTS[number]["name"];
  point: [number, number, number];
  normal: [number, number, number];
  surfacePoint?: [number, number, number];
  surfaceHit?: boolean;
  surfaceTriangle?: number;
}

/** Bind four leg chains to the live rock and the neck to the oracle sightline.
 * CCD runs only when fit() changes the landmark, not every frame: the perch is
 * static and the solved skeleton remains one skinned draw call. */
function configureDragonLegIk(slot: THREE.Group, loaded: THREE.Group): () => void {
  let skinned: THREE.SkinnedMesh | null = null;
  loaded.traverse((object) => {
    if (!skinned && (object as THREE.SkinnedMesh).isSkinnedMesh) skinned = object as THREE.SkinnedMesh;
  });
  if (!skinned) {
    slot.userData.legIkState = "missing-skinned-mesh";
    return () => {};
  }
  const mesh: THREE.SkinnedMesh = skinned;
  const bones = mesh.skeleton.bones;
  const indexOf = (name: string): number => bones.findIndex((bone) => bone.name === name);
  const legIks = DRAGON_LEG_CONTACTS.map(({ name }) => ({
    target: indexOf(`ik_${name}_target`),
    effector: indexOf(`${name}_foot`),
    links: [
      { index: indexOf(`${name}_lower`) },
      { index: indexOf(`${name}_upper`) },
    ],
    iteration: 24,
    minAngle: 0.001,
    maxAngle: 0.72,
    blendFactor: 1,
  }));
  const neckIk = {
    target: indexOf("ik_neck_target"),
    effector: indexOf("neck_tip"),
    links: [
      { index: indexOf("neck_head") },
      { index: indexOf("neck_mid") },
      { index: indexOf("neck_base") },
    ],
    iteration: 12,
    minAngle: 0.0005,
    maxAngle: 0.12,
    // A partial solve preserves the authored S-curve instead of turning the
    // neck into a perfectly straight mechanical pointer.
    blendFactor: 0.56,
  };
  const iks = [...legIks, neckIk];
  if (iks.some((ik) => ik.target < 0 || ik.effector < 0 || ik.links.some((link) => link.index < 0))) {
    slot.userData.legIkState = "missing-bones";
    slot.userData.legIkBones = bones.map((bone) => bone.name);
    return () => {};
  }
  const solver = new CCDIKSolver(mesh, iks);
  const point = new THREE.Vector3();
  const sync = () => {
    const contacts = slot.userData.legIkTargets as DragonLegTarget[] | undefined;
    if (!contacts || !slot.parent) return;
    mesh.skeleton.pose();
    slot.parent.updateWorldMatrix(true, true);
    loaded.updateWorldMatrix(true, true);
    for (const contact of contacts) {
      const target = bones[indexOf(`ik_${contact.name}_target`)];
      if (!target?.parent) continue;
      point.fromArray(contact.point);
      slot.parent.localToWorld(point);
      target.parent.worldToLocal(point);
      target.position.copy(point);
    }
    const neckTargetPoint = slot.userData.neckIkTarget as [number, number, number] | undefined;
    const neckTarget = bones[indexOf("ik_neck_target")];
    if (neckTargetPoint && neckTarget?.parent) {
      point.fromArray(neckTargetPoint);
      slot.parent.localToWorld(point);
      neckTarget.parent.worldToLocal(point);
      neckTarget.position.copy(point);
    }
    loaded.updateWorldMatrix(true, true);
    solver.update();
    slot.userData.legIkState = "solved";
  };
  slot.userData.syncLegIK = sync;
  slot.userData.legIkState = "ready";
  sync();
  return () => {
    if (slot.userData.syncLegIK === sync) delete slot.userData.syncLegIK;
  };
}

/** Stream the neural render shell only after the browser has produced its
 * first frame. The code-native oracle remains a zero-I/O fallback and is
 * swapped out with a short material fade; the closed QuadRemesher proxy stays
 * unloaded until destruction/physics asks for it. */
function streamTripoOracle(
  slot: THREE.Group,
  fallback: THREE.Group | null,
  onLoaded?: (loaded: THREE.Group) => void,
): () => void {
  let cancelled = false;
  let timeoutId = 0;
  let deferFrameId = 0;
  let loaded: THREE.Group | null = null;
  let frameId = 0;

  const start = () => {
    if (cancelled) return;
    tripoGltfLoader.load(TRIPO_ORACLE_RENDER, (gltf) => {
      loaded = gltf.scene;
      if (cancelled) {
        disposeLoadedGraph(loaded);
        loaded = null;
        return;
      }
      loaded.name = "tripo-v3.1-abyssal-oracle-render-shell";
      // Blender export is 10 units tall and faces +X. At 10.2×, the streamed
      // shell is a true environment-scale monument (102 local units before
      // the adaptive world fit), not a normal gameplay prop.
      loaded.scale.setScalar(10.2);
      loaded.rotation.y = -Math.PI / 2;
      loaded.userData.source = "tripo-v3.1-20260211";
      loaded.userData.renderTriangles = 30_000;
      loaded.userData.destructionProxyUrl = TRIPO_ORACLE_DESTRUCTION_PROXY;

      const faded: Array<{
        material: THREE.Material;
        opacity: number;
        transparent: boolean;
        depthWrite: boolean;
      }> = [];
      loaded.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.frustumCulled = true;
        const prepare = (source: THREE.Material) => {
          const material = source.clone();
          const stoneMaterial = material as THREE.MeshStandardMaterial;
          if (stoneMaterial.isMeshStandardMaterial) {
            // Tripo's baked stone is intentionally dark. The face is revealed
            // by the fixed cinematic spotlight, never by self-illumination.
            stoneMaterial.color.multiplyScalar(1.35);
            stoneMaterial.metalness = 0;
            stoneMaterial.roughness = Math.max(0.86, stoneMaterial.roughness);
            stoneMaterial.emissive.set(0x000000);
            stoneMaterial.emissiveIntensity = 0;
          }
          faded.push({
            material,
            opacity: material.opacity,
            transparent: material.transparent,
            depthWrite: material.depthWrite,
          });
          material.transparent = true;
          material.opacity = 0;
          material.depthWrite = false;
          return material;
        };
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map(prepare)
          : prepare(mesh.material);
      });
      slot.add(loaded);
      onLoaded?.(loaded);

      const fadeStart = performance.now();
      const fade = (now: number) => {
        if (cancelled || !loaded) return;
        const alpha = THREE.MathUtils.smoothstep((now - fadeStart) / 520, 0, 1);
        for (const entry of faded) entry.material.opacity = entry.opacity * alpha;
        if (alpha < 1) {
          frameId = requestAnimationFrame(fade);
          return;
        }
        if (fallback) {
          fallback.visible = false;
          slot.remove(fallback);
          fallback.traverse((object) => {
            const mesh = object as THREE.Mesh;
            mesh.geometry?.dispose();
          });
        }
        for (const entry of faded) {
          entry.material.opacity = entry.opacity;
          entry.material.transparent = entry.transparent;
          entry.material.depthWrite = entry.depthWrite;
          entry.material.needsUpdate = true;
        }
        slot.userData.streamState = "ready";
      };
      slot.userData.streamState = "fading";
      frameId = requestAnimationFrame(fade);
    }, undefined, (error) => {
      slot.userData.streamState = "fallback";
      console.warn("Deferred Tripo oracle load failed; retaining procedural fallback", error);
    });
  };

  slot.userData.streamState = "deferred";
  slot.userData.destructionProxyUrl = TRIPO_ORACLE_DESTRUCTION_PROXY;
  // requestIdleCallback may fire while the GPU is still compiling the first
  // scene. Two painted frames plus a short delay make the stream provably
  // post-first-visible instead of competing with startup for CPU/GPU time.
  // The stamps below are load-bearing diagnostics, not scaffolding: they are
  // the difference between "the stream was never scheduled", "it is waiting out
  // the delay" and "it was cancelled". Stuck on "deferred" means neither frame
  // ever ran — which is what a hidden tab looks like, since requestAnimationFrame
  // does not fire there at all.
  deferFrameId = requestAnimationFrame(() => {
    slot.userData.streamState = "frame-1";
    deferFrameId = requestAnimationFrame(() => {
      slot.userData.streamState = "waiting";
      timeoutId = window.setTimeout(start, 2200);
    });
  });

  return () => {
    cancelled = true;
    if (timeoutId) clearTimeout(timeoutId);
    if (deferFrameId) cancelAnimationFrame(deferFrameId);
    if (frameId) cancelAnimationFrame(frameId);
    if (loaded) disposeLoadedGraph(loaded);
    loaded = null;
  };
}

interface WardenStream {
  sync: () => void;
  dispose: () => void;
}

/** One neural mesh, two GPU instances. No procedural fallback is constructed:
 * a failed/late network request leaves the reserved exterior positions empty
 * rather than showing the rejected code-native mannequins. */
function streamTripoWardens(
  slot: THREE.Group,
  matrices: THREE.Matrix4[],
  options: { url: string; name: string; triangles: number; delay: number },
): WardenStream {
  let cancelled = false;
  let timeoutId = 0;
  let deferFrameId = 0;
  let frameId = 0;
  let instances: THREE.InstancedMesh | null = null;
  const ownedTextures = new Set<THREE.Texture>();

  const sync = () => {
    if (!instances) return;
    // Fill every allocated row before the mesh can enter a render list. This
    // is the invariant that prevents the prior WebGPU instance-range overrun.
    for (let i = 0; i < matrices.length; i++) instances.setMatrixAt(i, matrices[i]);
    instances.instanceMatrix.needsUpdate = true;
    instances.computeBoundingSphere();
  };

  const start = () => {
    if (cancelled) return;
    tripoGltfLoader.load(options.url, (gltf) => {
      if (cancelled) {
        disposeLoadedGraph(gltf.scene);
        return;
      }
      gltf.scene.updateMatrixWorld(true);
      let source: THREE.Mesh | null = null;
      gltf.scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!source && mesh.isMesh) source = mesh;
      });
      if (!source) {
        disposeLoadedGraph(gltf.scene);
        slot.userData.streamState = "failed";
        return;
      }
      const sourceMesh = source as THREE.Mesh;
      const geometry = sourceMesh.geometry.clone();
      geometry.applyMatrix4(sourceMesh.matrixWorld);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();

      const prepareMaterial = (original: THREE.Material) => {
        const material = original.clone();
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) ownedTextures.add(value);
        const stoneMaterial = material as THREE.MeshStandardMaterial;
        if (stoneMaterial.isMeshStandardMaterial) {
          // Cool the baked neutral-grey albedo into the same blue-black family
          // as the oracle while retaining the authored edge/value texture.
          stoneMaterial.color.multiply(new THREE.Color(0.76, 0.9, 1.08));
          stoneMaterial.metalness = 0;
          stoneMaterial.roughness = Math.max(0.88, stoneMaterial.roughness);
          stoneMaterial.emissive.set(0x0c1a2d);
          stoneMaterial.emissiveIntensity = 0.64;
        }
        material.transparent = true;
        material.opacity = 0;
        material.depthWrite = false;
        return material;
      };
      const materials = Array.isArray(sourceMesh.material)
        ? sourceMesh.material.map(prepareMaterial)
        : prepareMaterial(sourceMesh.material);
      instances = new THREE.InstancedMesh(geometry, materials, matrices.length);
      instances.name = options.name;
      instances.castShadow = false;
      instances.receiveShadow = false;
      instances.frustumCulled = true;
      instances.userData.source = "tripo-v3.1-20260211";
      instances.userData.renderTrianglesPerInstance = options.triangles;
      instances.userData.destructionProxyUrl = TRIPO_WARDEN_DESTRUCTION_PROXY;
      sync();
      slot.add(instances);

      // Source geometry/material wrappers are no longer needed. Texture data
      // remains owned by the cloned render material above.
      gltf.scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of sourceMaterials) material.dispose();
      });

      const fadeStart = performance.now();
      const fade = (now: number) => {
        if (cancelled || !instances) return;
        const alpha = THREE.MathUtils.smoothstep((now - fadeStart) / 520, 0, 1);
        const liveMaterials = Array.isArray(instances.material) ? instances.material : [instances.material];
        for (const material of liveMaterials) material.opacity = alpha;
        if (alpha < 1) {
          frameId = requestAnimationFrame(fade);
          return;
        }
        for (const material of liveMaterials) {
          material.opacity = 1;
          material.transparent = false;
          material.depthWrite = true;
          material.needsUpdate = true;
        }
        slot.userData.streamState = "ready";
      };
      slot.userData.streamState = "fading";
      frameId = requestAnimationFrame(fade);
    }, undefined, (error) => {
      slot.userData.streamState = "failed";
      console.warn("Deferred Tripo warden load failed; leaving rejected procedural guards absent", error);
    });
  };

  slot.userData.streamState = "deferred";
  slot.userData.destructionProxyUrl = TRIPO_WARDEN_DESTRUCTION_PROXY;
  deferFrameId = requestAnimationFrame(() => {
    deferFrameId = requestAnimationFrame(() => {
      timeoutId = window.setTimeout(start, options.delay);
    });
  });

  return {
    sync,
    dispose() {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (deferFrameId) cancelAnimationFrame(deferFrameId);
      if (frameId) cancelAnimationFrame(frameId);
      if (instances) {
        instances.removeFromParent();
        instances.geometry.dispose();
        const materials = Array.isArray(instances.material) ? instances.material : [instances.material];
        for (const material of materials) material.dispose();
      }
      for (const texture of ownedTextures) texture.dispose();
      instances = null;
    },
  };
}

/** Deferred one-shell dragon. We intentionally keep one stable 45k topology
 * instead of a distance LOD ladder: for a single hero silhouette the saved
 * triangles are not worth wing/head pop. The ~320 KB Draco+skin artifact is
 * retained for deployment experiments, but Three's decoder worker could be
 * starved for seconds under WebGPU load. The 2.2 MB uncompressed runtime shell
 * parses immediately and is streamed only after first paint. */
function streamTripoDragon(slot: THREE.Group): () => void {
  let cancelled = false;
  let timeoutId = 0;
  let deferFrameId = 0;
  let frameId = 0;
  let loaded: THREE.Group | null = null;
  let disposeLegIk: () => void = () => {};

  const start = () => {
    if (cancelled) return;
    slot.userData.streamState = "loading";
    dragonGltfLoader.load(TRIPO_DRAGON_RENDER, (gltf) => {
      if (cancelled) {
        disposeLoadedGraph(gltf.scene);
        return;
      }
      loaded = gltf.scene;
      loaded.name = "tripo-v3.1-colossal-perched-abyss-dragon";
      // Blender-normalized shell is ten units high. Keep the landmark giant,
      // but at 70% of the former 24.6× treatment so the rock reads as a
      // deliberate perch instead of disappearing under the wings.
      loaded.scale.setScalar(DRAGON_RENDER_SCALE);
      // Local +X is the verified head/forward axis. The parent slot now owns
      // the exact capstone frame, so only a small anatomical bias is needed;
      // the former +64 world-unit shove detached the feet from their support.
      // Bring the torso into the perch's reachable envelope. At the admitted
      // The widened rock shoulder raises the rear contacts, so the body only
      // needs a restrained settling offset. This keeps the front knees near
      // their authored pose instead of splaying them sideways to absorb the
      // former 44-unit body drop.
      loaded.position.set(5.6, -25, 0);
      loaded.userData.source = "tripo-v3.1-20260211";
      loaded.userData.renderTriangles = 45_000;
      loaded.userData.lodPolicy = "stable-hero-shell-no-pop";
      loaded.userData.rigPolicy = "four-leg-contact-plus-neck-look-ccd-ik";
      loaded.userData.rigBones = 22;
      loaded.userData.compressionPolicy = "uncompressed-runtime-fast-parse";
      const dragonStone = makeHandPaintedLandmarkStoneMaterial();
      dragonStone.transparent = true;
      dragonStone.opacity = 0;
      dragonStone.depthWrite = false;
      const sourceTextures = new Set<THREE.Texture>();
      const sourceMaterials = new Set<THREE.Material>();
      loaded.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        const originals = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of originals) {
          sourceMaterials.add(material);
          for (const entry of Object.values(material)) if (entry instanceof THREE.Texture) sourceTextures.add(entry);
        }
        paintDragonStone(mesh.geometry);
        mesh.material = dragonStone;
      });
      for (const material of sourceMaterials) material.dispose();
      for (const texture of sourceTextures) texture.dispose();
      slot.add(loaded);
      disposeLegIk = configureDragonLegIk(slot, loaded);
      const fadeStart = performance.now();
      const fade = (now: number) => {
        if (cancelled || !loaded) return;
        const alpha = THREE.MathUtils.smoothstep((now - fadeStart) / 620, 0, 1);
        dragonStone.opacity = alpha;
        if (alpha < 1) {
          frameId = requestAnimationFrame(fade);
          return;
        }
        dragonStone.opacity = 1;
        dragonStone.transparent = false;
        dragonStone.depthWrite = true;
        dragonStone.needsUpdate = true;
        slot.userData.streamState = "ready";
      };
      slot.userData.streamState = "fading";
      frameId = requestAnimationFrame(fade);
    }, undefined, (error) => {
      slot.userData.streamState = "failed";
      console.warn("Deferred Tripo dragon load failed", error);
    });
  };

  slot.userData.streamState = "deferred";
  slot.userData.renderUrl = TRIPO_DRAGON_RENDER;
  deferFrameId = requestAnimationFrame(() => {
    deferFrameId = requestAnimationFrame(() => {
      // Load during the direct-render warm window. The shell then realizes its
      // one skinned draw before bloom/AO takes over instead of introducing a
      // cold hero render object into the expensive cinematic graph.
      timeoutId = window.setTimeout(start, 350);
    });
  });
  return () => {
    cancelled = true;
    if (timeoutId) clearTimeout(timeoutId);
    if (deferFrameId) cancelAnimationFrame(deferFrameId);
    if (frameId) cancelAnimationFrame(frameId);
    disposeLegIk();
    if (loaded) {
      loaded.removeFromParent();
      disposeLoadedGraph(loaded);
    }
    loaded = null;
  };
}

export function buildAbyssLandmarks(seed: number): THREE.Group {
  const root = new THREE.Group();
  root.name = "abyss-landmarks-img2three";
  const stone = new THREE.MeshLambertNodeMaterial({ vertexColors: true, flatShading: true, emissive: 0x09111f });
  const abyss = new THREE.MeshBasicNodeMaterial();
  abyss.colorNode = color(0x010308);
  const wardGlow = new THREE.MeshBasicNodeMaterial({ color: 0x6a8da8, transparent: true, opacity: 0.78 });

  const wardenSlot = new THREE.Group();
  wardenSlot.name = "streamed-oathbound-warden-slot";
  root.add(wardenSlot);
  const wardenMatrices = [new THREE.Matrix4(), new THREE.Matrix4()];
  const wardenRankMatrices = Array.from({ length: 6 }, () => new THREE.Matrix4());
  const wardenStream = streamTripoWardens(wardenSlot, wardenMatrices, {
    url: TRIPO_WARDEN_RENDER,
    name: "tripo-v3.1-colossal-oathbound-wardens",
    triangles: 29_999,
    delay: 4200,
  });
  const wardenRankStream = streamTripoWardens(wardenSlot, wardenRankMatrices, {
    url: TRIPO_WARDEN_RANK_RENDER,
    name: "tripo-v3.1-oathbound-warden-rank",
    triangles: 8_000,
    delay: 6000,
  });

  const skullStoneGeo = dragonSkullStoneGeometry();
  const skullTeethGeo = dragonSkullTeethGeometry();
  const skullVoidGeo = dragonSkullVoidGeometry();
  const skull = new THREE.Group();
  skull.name = "buried-dragon-skull";
  const skullMesh = new THREE.Mesh(skullStoneGeo, stone);
  const skullTeeth = new THREE.Mesh(skullTeethGeo, stone);
  const skullVoid = new THREE.Mesh(skullVoidGeo, abyss);
  skullMesh.castShadow = false;
  skullTeeth.castShadow = false;
  skullVoid.renderOrder = 1;
  skull.add(skullMesh, skullTeeth, skullVoid);
  root.add(skull);

  const oracle = new THREE.Group();
  oracle.name = "abyssal-cephalopod-oracle";
  const oracleWallGeo = oracleBackingCliffGeometry();
  const oracleWall = new THREE.Mesh(oracleWallGeo, stone);
  oracleWall.name = "oracle-backing-horseshoe-cliff";
  oracleWall.castShadow = false;
  oracleWall.receiveShadow = false;
  root.add(oracleWall, oracle);
  // Abyssal gaze: teal ghost-fire burning INSIDE the oracle's eye sockets.
  // The rig (two crossed-quad flame pairs + one teal point light) is created
  // HERE, before the first compile — a light added later would change the
  // scene light count and recompile every pipeline. It stays invisible until
  // the streamed Tripo shell arrives; then a raycast finds the actual socket
  // surface on the loaded mesh and the rig is attached INTO the model, so it
  // inherits every later transform. Flame quads output >1 linear values so
  // bloom halos the gaze exactly like the torch flames.
  const oracleEyeFlameMat = makeEyeFireMat();
  const oracleEyeGlowMat = makeEyeGlowMat();
  const oracleEyePlane = new THREE.PlaneGeometry(0.34, 0.52);
  oracleEyePlane.translate(0, 0.2, 0); // flame base sits at the anchor point
  const oracleEyeGlowPlane = new THREE.PlaneGeometry(0.62, 0.62);
  oracleEyeGlowPlane.translate(0, 0.14, 0);
  const oracleEyeCoreGeo = new THREE.SphereGeometry(0.085, 12, 10);
  const oracleEyeCoreMat = new THREE.MeshBasicNodeMaterial();
  oracleEyeCoreMat.colorNode = color(0xd9fff4).mul(sin(time.mul(2.1)).mul(0.3).add(3.0));
  const oracleEyes = new THREE.Group();
  oracleEyes.name = "oracle-abyssal-gaze";
  oracleEyes.visible = false;
  for (let side = 0; side < 2; side++) {
    const socket = new THREE.Group();
    for (let cross = 0; cross < 2; cross++) {
      const halo = new THREE.Mesh(oracleEyeGlowPlane, oracleEyeGlowMat);
      halo.rotation.y = cross * Math.PI / 2;
      const tongue = new THREE.Mesh(oracleEyePlane, oracleEyeFlameMat);
      tongue.rotation.y = cross * Math.PI / 2;
      for (const quad of [halo, tongue]) {
        quad.castShadow = false;
        quad.receiveShadow = false;
      }
      socket.add(halo, tongue);
    }
    const core = new THREE.Mesh(oracleEyeCoreGeo, oracleEyeCoreMat);
    core.position.y = 0.11;
    core.castShadow = false;
    core.receiveShadow = false;
    socket.add(core);
    oracleEyes.add(socket);
  }
  const oracleGaze = new THREE.PointLight(0x3fe6c6, 0, 95, 2);
  oracleGaze.name = "oracle-abyssal-gaze-light";
  oracleGaze.castShadow = false;
  oracleEyes.add(oracleGaze);
  root.add(oracleEyes);
  const abyssPoolGeo = new THREE.CircleGeometry(1, 40);
  abyssPoolGeo.rotateX(-Math.PI / 2);
  const abyssPoolMat = makeAbyssPoolMat();
  const abyssPool = new THREE.Mesh(abyssPoolGeo, abyssPoolMat);
  // Drowned briar carpeting the basin bed. Four clump variants keep the
  // silhouette from repeating; one InstancedMesh keeps it to one draw call.
  // Capacity is a hard cap, not a target — the scatter fills what the basin
  // radius supports and the rest stay off-screen behind the bounding sphere.
  const brambleGeos = [0, 1, 2, 3].map((v) => brambleClumpGeometry(seed, v));
  const brambleGeo = BufferGeometryUtils.mergeGeometries(brambleGeos);
  for (const g of brambleGeos) g.dispose();
  const brambleMat = makeBrambleMat();
  const brambles = new THREE.InstancedMesh(brambleGeo, brambleMat, 1500);
  brambles.name = "basin-drowned-briar";
  brambles.castShadow = false;      // a thicket of thin canes costs more in the
  brambles.receiveShadow = false;   // shadow pass than it returns on screen
  brambles.frustumCulled = true;
  root.add(brambles);

  abyssPool.name = "oracle-bioluminescent-pool";
  const abyssBasinPool = new THREE.Mesh(abyssPoolGeo, makeAbyssBasinMat());
  abyssBasinPool.name = "maze-basin-bioluminescent-pool";
  const abyssRingGeo = new THREE.RingGeometry(0.74, 1, 48);
  abyssRingGeo.rotateX(-Math.PI / 2);
  const abyssShoreRing = new THREE.Mesh(abyssRingGeo, makeAbyssShoreMat());
  abyssShoreRing.name = "oracle-shoreline-glow-ring";
  // shallow dome of luminous air over the basin — one draw, no lights
  const hazeGeo = new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  const abyssHaze = new THREE.Mesh(hazeGeo, makeWaterHazeMat());
  abyssHaze.name = "basin-luminous-haze";
  const abyssDabGeo = new THREE.PlaneGeometry(1, 1);
  abyssDabGeo.rotateX(-Math.PI / 2);
  const abyssDabs = new THREE.InstancedMesh(abyssDabGeo, makeEyeGlowMat(), 16);
  abyssDabs.name = "bioluminescent-algae-dabs";
  abyssDabs.frustumCulled = false; // one tiny draw; scattered by fit below
  // explicit draw order: the one dark water body first, then the additive
  // accents — distance sorting between coplanar transparent sheets flips
  // with camera motion and reads as flicker
  const glowLayers: Array<[THREE.Object3D, number]> = [
    [abyssBasinPool, 1], [abyssPool, 2], [abyssShoreRing, 3], [abyssDabs, 4],
    [abyssHaze, 5],
  ];
  for (const [glowMesh, order] of glowLayers) {
    glowMesh.castShadow = false;
    glowMesh.receiveShadow = false;
    glowMesh.renderOrder = order;
    root.add(glowMesh);
  }

  // Warm brazier fires at the warden ranks' feet: the painted reference dots
  // the outer ruins with small warm lights so the teal basin has counter-
  // sparks. Same layered fire shader as the gaze, ember-orange ramp; one
  // shared material, twelve tiny quads, no lights.
  const brazierMat = makeEyeFireMat(0xfff3d8, 0xffb054, 0x9c4a12);
  const brazierPlane = new THREE.PlaneGeometry(0.34, 0.52);
  brazierPlane.translate(0, 0.2, 0);
  const wardenBraziers = new THREE.Group();
  wardenBraziers.name = "warden-rank-braziers";
  for (let i = 0; i < 6; i++) {
    const brazier = new THREE.Group();
    for (let cross = 0; cross < 2; cross++) {
      const quad = new THREE.Mesh(brazierPlane, brazierMat);
      quad.rotation.y = cross * Math.PI / 2;
      quad.castShadow = false;
      quad.receiveShadow = false;
      brazier.add(quad);
    }
    wardenBraziers.add(brazier);
  }
  root.add(wardenBraziers);
  const attachOracleGaze = (loaded: THREE.Group) => {
    // Socket anchors hand-tuned with the in-page gizmo (2026-08-08), in the
    // streamed GLB's local frame (10 units tall, faces +X before the parent
    // -π/2 yaw). The model and its import transform are fixed, so these local
    // coordinates land in the eye hollows for every seed and every fit.
    loaded.add(oracleEyes);
    for (let side = 0; side < 2; side++) {
      const socket = oracleEyes.children[side];
      socket.position.set(1.051, 7.586, side === 0 ? -0.542 : 0.542);
      socket.scale.set(1.25, 0.55, 1.25);
    }
    oracleGaze.position.set(1.3, 7.586, 0);
    oracleGaze.intensity = 320;
    oracleEyes.visible = true;
  };
  const cancelOracleStream = streamTripoOracle(oracle, null, attachOracleGaze);

  const dragonLandmark = new THREE.Group();
  dragonLandmark.name = "dragon-slate-spire-landmark";
  dragonLandmark.position.fromArray(DRAGON_LANDMARK_DEFAULT_OFFSET);
  dragonLandmark.userData.generatedPlacement = [...DRAGON_LANDMARK_DEFAULT_OFFSET];
  root.add(dragonLandmark);
  const dragonPerchGeo = erodeGeometry(
    subdivideGeometry(dragonPerchColumnGeometry(DRAGON_PERCH_STRATA), 3),
    { seed: DRAGON_PERCH_STRATA.seed, amplitude: 0.8, frequency: 0.06, octaves: 4, strata: 0.7 },
  );
  const dragonPerch = new THREE.Mesh(dragonPerchGeo, stone);
  dragonPerch.name = "colossal-dragon-slate-spire";
  dragonPerch.castShadow = false;
  dragonPerch.receiveShadow = false;
  dragonPerch.userData.destructible = true;
  dragonPerch.userData.fractureGroups = dragonPerchGeo.userData.fractureGroups;
  dragonPerch.userData.componentIds = dragonPerchGeo.userData.componentIds;
  dragonPerch.userData.collider = {
    type: "compound-convex-wedges",
    proxyParts: ["grounded-root", "dominant-blade", "secondary-blade-left", "secondary-blade-fan", "landing-shelf"],
  };
  dragonLandmark.userData.sculptRuntime = {
    targetId: "dragon-slate-spire",
    root: dragonLandmark.name,
    visualMesh: dragonPerch.name,
    sockets: ["dragon-support"],
    breakable: true,
    mergedVisualDraws: 1,
    semanticParts: dragonPerchGeo.userData.componentIds,
  };
  dragonLandmark.add(dragonPerch);
  let refitDragonPerchContact = () => {};
  const cancelDragonPerchStream = streamTripoDragonPerch(dragonPerch, () => refitDragonPerchContact());

  // Camera clearance. The perch is deliberately pulled in so the dragon
  // overhangs the maze silhouette — good composition, but it means one arc of
  // the orbit puts the camera INSIDE a 325-unit rock, and measuring the sweep
  // showed it covering 100% of frame at one bearing. Hide it while the camera
  // is in it: by then nothing is visible anyway, so the pop costs nothing,
  // and toggling `visible` avoids the pipeline rebuild that flipping
  // `material.transparent` at runtime would trigger.
  const perchBounds = new THREE.Box3();
  let perchBoundsFresh = false;
  const clearCamera = (camera: THREE.Camera) => {
    if (!perchBoundsFresh) {
      // Bound the PERCH, not the landmark. The landmark also holds the rigged
      // dragon, and Box3.setFromObject on a skinned mesh returns its bind-pose
      // extent — measured at 7322 × 3938 × 7398 here, which put the camera
      // permanently "inside" and hid the dragon even from a 500-unit wide
      // shot. The rock is the thing the camera actually collides with.
      dragonPerch.updateWorldMatrix(true, true);
      perchBounds.setFromObject(dragonPerch);
      perchBoundsFresh = true;
    }
    // The box is an axis-aligned superset of an elongated rock, so its
    // distance is only a LOWER bound on the distance to real geometry — a
    // tight threshold (14) still left the rock filling 72% of frame at one
    // bearing. 30 covers it, and is far inside the ~500 units the wide
    // framings keep between camera and dragon, so those still show it.
    const distance = perchBounds.distanceToPoint(camera.position);
    // hysteresis band so a camera hovering on the boundary can't strobe
    const wanted = distance < 30 ? false : distance > 42 ? true : dragonLandmark.visible;
    if (dragonLandmark.visible !== wanted) dragonLandmark.visible = wanted;
  };
  const invalidatePerchBounds = () => { perchBoundsFresh = false; };
  const dragonSlot = new THREE.Group();
  dragonSlot.name = "streamed-colossal-perched-dragon-slot";
  dragonLandmark.add(dragonSlot);
  const cancelDragonStream = streamTripoDragon(dragonSlot);

  const hoardGateGeo = dragonHoardGateGeometry();
  const hoardGateVoidGeo = dragonHoardVoidGeometry();
  const hoardGate = new THREE.Mesh(hoardGateGeo, stone);
  const hoardGateVoid = new THREE.Mesh(hoardGateVoidGeo, abyss);
  hoardGate.name = "dragon-hoard-barrow-gate";
  hoardGateVoid.name = "dragon-hoard-barrow-cavity";
  hoardGate.castShadow = false;
  hoardGateVoid.renderOrder = 1;
  dragonLandmark.add(hoardGate, hoardGateVoid);

  const oathStelaGeo = dragonOathStelaGeometry();
  const oathStelae = new THREE.InstancedMesh(oathStelaGeo, stone, 7);
  oathStelae.name = "dragon-hoard-oath-stelae";
  oathStelae.castShadow = false;
  oathStelae.receiveShadow = false;
  dragonLandmark.add(oathStelae);

  const wardStoneGeo = dragonWardStoneGeometry();
  const wardRuneGeo = dragonWardRuneGeometry();
  const wardStones = new THREE.InstancedMesh(wardStoneGeo, stone, 8);
  const wardRunes = new THREE.InstancedMesh(wardRuneGeo, wardGlow, 8);
  wardStones.name = "dragon-hoard-ward-stones";
  wardRunes.name = "dragon-hoard-ward-runes";
  wardStones.castShadow = false;
  wardRunes.castShadow = false;
  dragonLandmark.add(wardStones, wardRunes);

  const arcadeGeo = abyssArcadeBayGeometry();
  const arcade = new THREE.InstancedMesh(arcadeGeo, stone, 17);
  arcade.name = "oracle-to-dragon-bedrock-arcade";
  arcade.castShadow = false;
  arcade.receiveShadow = false;
  root.add(arcade);

  const matrix = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();

  // Sparse exterior ruins remain instanced and are never navigation/collision.
  const archGeo = brokenArchGeometry();
  const arches = new THREE.InstancedMesh(archGeo, stone, 7);
  for (let k = 0; k < arches.count; k++) {
    const side = k & 1 ? 1 : -1;
    const x = side * (42 + hash2(seed, k, 320) * 44);
    const z = -4 - hash2(seed, k, 321) * 100;
    const y = ABYSS * TH - 14 + hash2(seed, k, 322) * 13;
    const sc = 0.6 + hash2(seed, k, 323) * 0.75;
    arches.setMatrixAt(k, matrix.compose(
      p.set(x, y, z),
      q.setFromEuler(new THREE.Euler(0, hash2(seed, k, 324) * Math.PI, (hash2(seed, k, 325) - 0.5) * 0.18)),
      s.set(sc, sc, sc),
    ));
  }
  arches.castShadow = false;
  arches.receiveShadow = false;
  arches.name = "distant-broken-arches";
  root.add(arches);

  // IcosahedronGeometry detail 0 is already non-indexed in this Three build.
  const cragGeo = new THREE.IcosahedronGeometry(1, 0);
  paintFacets(cragGeo, 0x172238, 0x40516b, 271);
  // Only the eight grounded burial rocks remain. The former 26 randomly
  // suspended chunks read as generator debris and had no structural support.
  const crags = new THREE.InstancedMesh(cragGeo, stone, 8);
  crags.castShadow = false;
  crags.name = "floating-abyss-rubble";
  root.add(crags);

  const chainPoints: number[] = [];
  for (let k = 0; k < 10; k++) {
    const x = (hash2(seed, k, 340) - 0.5) * 180;
    const z = -15 - hash2(seed, k, 341) * 105;
    const top = 22 + hash2(seed, k, 342) * 28;
    const bottom = ABYSS * TH - 14 + hash2(seed, k, 343) * 10;
    for (let n = 0; n < 8; n++) {
      const y0 = top + (bottom - top) * (n / 8);
      const y1 = top + (bottom - top) * ((n + 0.62) / 8);
      chainPoints.push(x + Math.sin(n * 0.8 + k) * 0.65, y0, z, x + Math.sin((n + 0.62) * 0.8 + k) * 0.65, y1, z);
    }
  }
  const chainGeo = new THREE.BufferGeometry();
  chainGeo.setAttribute("position", new THREE.Float32BufferAttribute(chainPoints, 3));
  const chainMat = new THREE.LineBasicNodeMaterial({ color: 0x1b2638, transparent: true, opacity: 0.72 });
  const chains = new THREE.LineSegments(chainGeo, chainMat);
  chains.name = "distant-hanging-chains";
  root.add(chains);

  let lastFitHalf = 42;
  let lastFitTop = 42;
  const fit = (half: number, top: number) => {
    lastFitHalf = half;
    lastFitTop = top;
    // Blender-normalized neural source is 10 units tall. The 8.8–12.2 scale
    // makes each guardian a 88–122 unit monument while preserving one shared
    // draw call for both sides.
    const guardianScale = Math.max(8.8, Math.min(12.2, 8.2 + top / 28));
    const guardianX = half + 34 + guardianScale * 2.4;
    const guardianZ = -Math.min(48, half * 0.22);
    wardenMatrices[0].compose(
      p.set(-guardianX, ABYSS * TH - 11, guardianZ),
      q.setFromEuler(new THREE.Euler(0, -0.12, 0)),
      s.setScalar(guardianScale),
    );
    wardenMatrices[1].compose(
      p.set(guardianX, ABYSS * TH - 11, guardianZ),
      q.setFromEuler(new THREE.Euler(0, Math.PI + 0.12, 0)),
      s.setScalar(guardianScale),
    );
    wardenStream.sync();
    // Six lower-LOD wardens form two ceremonial ranks along the closed arc.
    // The central gap belongs to the oracle, and every base is embedded in the
    // procedural wall outside the complete maze bounding radius.
    const rankAngles = [-2.76, -2.42, -2.08, -1.06, -0.72, -0.38];
    for (let i = 0; i < wardenRankMatrices.length; i++) {
      const sideDepth = i % 3;
      const radius = half + 54 + sideDepth * 7;
      const angle = rankAngles[i];
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const rankScale = Math.max(5.8, Math.min(7.4, guardianScale * (0.59 + sideDepth * 0.025)));
      wardenRankMatrices[i].compose(
        p.set(x, ABYSS * TH - 11 - rankScale * 0.34, z),
        q.setFromEuler(new THREE.Euler(0, Math.atan2(z, -x), 0)),
        s.setScalar(rankScale),
      );
      // ember brazier in front of each warden's pedestal: inset by the
      // pedestal depth (~2.6× the warden scale) so the fire sits on open
      // floor at their feet instead of inside the base rock
      const brazier = wardenBraziers.children[i];
      const inset = (radius - rankScale * 2.6 - 4) / radius;
      brazier.position.set(x * inset, ABYSS * TH - 6, z * inset);
      brazier.scale.setScalar(5);
    }
    wardenRankStream.sync();

    const skullScale = Math.max(1.2, Math.min(2.2, 1.08 + top / 145));
    const burialY = ABYSS * TH - 12;
    skull.scale.setScalar(skullScale);
    skull.position.set(-half * 0.32, burialY - skullScale * 4.4, -(half + 52));
    skull.rotation.set(-0.28, 0.22, -0.54);

    // Dedicated burial rubble wraps the lower jaw/rear cranium after each fit.
    for (let k = 0; k < crags.count; k++) {
      const qk = k + 20;
      const u = k / 7;
      const a = -0.35 + u * Math.PI * 1.3;
      const radius = skullScale * (9 + hash2(seed, qk, 350) * 8);
      const sc = skullScale * (1.5 + hash2(seed, qk, 351) * 2.1);
      crags.setMatrixAt(k, matrix.compose(
        p.set(skull.position.x + Math.cos(a) * radius, burialY - sc * 0.45 + hash2(seed, qk, 352), skull.position.z + Math.sin(a) * radius),
        q.setFromEuler(new THREE.Euler(hash2(seed, qk, 353) * 2, hash2(seed, qk, 354) * 3, hash2(seed, qk, 355) * 2)),
        s.set(sc * 1.35, sc * 0.7, sc),
      ));
    }

    // The gigantic oracle occupies the highest, closed side of the horseshoe
    // wall (-Z). Local +Z faces the maze; the separate cliff overlaps its back
    // and swallows the lower body/tentacle roots so it never reads as a prop
    // floating in the abyss.
    const oracleScale = Math.max(1.85, Math.min(2.75, 1.55 + top / 105));
    oracle.scale.setScalar(oracleScale);
    oracle.position.set(half * 0.08, burialY - oracleScale * 2.4, -(half + 86));
    // Local +Z is the face direction for both fallback and streamed shell.
    oracle.rotation.y = Math.atan2(-oracle.position.x, -oracle.position.z);
    oracleWall.scale.set(oracleScale * 1.05, oracleScale, oracleScale);
    oracleWall.position.set(
      oracle.position.x,
      burialY - oracleScale * 8,
      oracle.position.z - oracleScale * 30,
    );
    oracleWall.rotation.y = oracle.rotation.y;

    // Landmark light rig: a cold, oblique face key comes from the maze side
    // and grazes across the oracle's brow/tentacle roots. The offset prevents
    // the backing cliff from flattening into the same value as the face.
    const oracleForward = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), oracle.rotation.y);
    const oracleRight = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), oracle.rotation.y);
    const oracleFace = oracle.position.clone()
      .addScaledVector(oracleForward, oracleScale * 12)
      .add(new THREE.Vector3(0, oracleScale * 58, 0));
    const oracleLight = oracleFace.clone()
      .addScaledVector(oracleForward, oracleScale * 36)
      .addScaledVector(oracleRight, -oracleScale * 24)
      .add(new THREE.Vector3(0, oracleScale * 10, 0));
    // glowing water: a tight pool lapping the tentacle roots, a broad basin
    // sheet reaching under the maze, a hot shoreline band where water meets
    // the statue, and scattered algae dabs breaking the perfect circles
    const floorY = oracle.position.y;
    // glow accent floats just above the basin surface near the statue
    abyssPool.position.copy(oracle.position)
      .addScaledVector(oracleForward, oracleScale * 5)
      .add(new THREE.Vector3(0, 1.3, 0));
    abyssPool.scale.setScalar(oracleScale * 26);
    // the single dark water body sits slightly ABOVE the flat abyss plane so
    // plane-seated ruins (graves, arches) get their feet wet instead of
    // hovering, while bedrock relief still pierces it as shores
    abyssBasinPool.position.set(
      oracle.position.x * 0.3, floorY + 0.6, oracle.position.z * 0.3);
    const basinRadius = Math.max(oracleScale * 40, half * 1.25);
    abyssBasinPool.scale.setScalar(basinRadius);
    // the haze sits ON the water and is deliberately shallow: a tall dome
    // reads as a bubble, a flat one as a layer of lit air
    // Seat the briar on the bed, just under the water sheet — the basin sits at
    // floorY + 0.6, so the canes break the surface at their crowns and stay
    // rooted below it.
    scatterBrambles(
      brambles, seed,
      new THREE.Vector3(abyssBasinPool.position.x, floorY, abyssBasinPool.position.z),
      basinRadius * 0.85,
    );
    abyssHaze.position.copy(abyssBasinPool.position).add(new THREE.Vector3(0, -1, 0));
    abyssHaze.scale.set(basinRadius * 0.92, basinRadius * 0.16, basinRadius * 0.92);

    // The basin lights the world back. In the reference the statue's roots
    // and the surrounding rock are visibly washed from BELOW by the water —
    // an emissive plane can never do that on its own, because emission is not
    // illumination. Two upward point lights, claimed from the shared pool so
    // the scene's light count never changes.
    root.userData.basinLights = [
      {
        x: abyssBasinPool.position.x, y: floorY + 12, z: abyssBasinPool.position.z,
        color: 0x2fd8b4, dist: basinRadius * 1.15, base: 46, ph: 0.4,
      },
      {
        x: oracle.position.x, y: floorY + 16,
        z: oracle.position.z + oracleForward.z * oracleScale * 8,
        color: 0x39e6c2, dist: oracleScale * 62, base: 34, ph: 2.1,
      },
    ];
    abyssShoreRing.position.copy(oracle.position)
      .addScaledVector(oracleForward, oracleScale * 4)
      .add(new THREE.Vector3(0, 2.9, 0));
    abyssShoreRing.scale.setScalar(oracleScale * 15);
    const dabMatrix = new THREE.Matrix4();
    for (let i = 0; i < 16; i++) {
      const angle = hash2(11, i, 931) * Math.PI * 2;
      const radius = oracleScale * (9 + hash2(11, i, 932) * 13);
      const size = 2.5 + hash2(11, i, 933) * 4.5;
      dabMatrix.makeScale(size, 1, size);
      dabMatrix.setPosition(
        oracle.position.x + Math.cos(angle) * radius + oracleForward.x * oracleScale * 4,
        floorY + 1.9,
        oracle.position.z + Math.sin(angle) * radius + oracleForward.z * oracleScale * 4,
      );
      abyssDabs.setMatrixAt(i, dabMatrix);
    }
    abyssDabs.instanceMatrix.needsUpdate = true;

    // Counter-landmark at the open (+Z) side: a monumental fan of diagonal
    // slate blades rises into one broken dragon shelf outside the maze.
    const perchBaseY = ABYSS * TH - 12;
    const mazeClearance = Math.max(70, Math.min(124, top * 0.24));
    const unloweredPerchHeight = Math.max(118, top + mazeClearance - perchBaseY);
    // Follow the generated skyline, but do not let one unusually high stacked
    // district turn the support into a foreground wall taller than the frame.
    const perchHeight = THREE.MathUtils.clamp(unloweredPerchHeight * 0.58, 108, 168);
    const perchScaleY = perchHeight / DRAGON_PERCH_STRATA.height;
    const perchNarrativeScale = Math.max(0.9, Math.min(1.32, 0.82 + half / 260));
    // Keep the ledge broad enough for four planted feet while remaining one
    // merged low-poly draw call.
    const perchScaleXZ = perchNarrativeScale * 1.38;
    dragonPerch.scale.set(perchScaleXZ, perchScaleY, perchScaleXZ);
    const perchFootRadius = DRAGON_PERCH_STRATA.baseRadius * (1 + DRAGON_PERCH_STRATA.roughness) * perchScaleXZ;
    // Pull the landmark close enough that the distal slate and the dragon's
    // head overlap the maze silhouette slightly. The broad geological root
    // remains outside the playable boundary, so this is a visual overhang and
    // never becomes an unplanned navigation/collision obstacle.
    const dragonStandOff = THREE.MathUtils.clamp(half * 0.72 + 70, 132, 182);
    const mazeVisualOverlap = THREE.MathUtils.clamp(half * 0.14, 14, 24);
    // Turn the geological run across the player's view instead of pointing it
    // straight down the camera axis. The support point is solved explicitly,
    // so this silhouette rotation never drags the dragon back over the maze.
    const platformBoundaryInset = 18 * perchScaleXZ;
    const localFrame = dragonPerchFrameAt(DRAGON_PERCH_STRATA);
    const perchYaw = -0.54;
    dragonPerch.rotation.y = perchYaw;
    const supportOffset = localFrame.point.clone()
      .multiply(dragonPerch.scale)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), perchYaw);
    const desiredSupportX = -half * 0.14;
    const desiredSupportZ = half + perchFootRadius + dragonStandOff
      - platformBoundaryInset - mazeVisualOverlap;
    dragonPerch.position.set(
      desiredSupportX - supportOffset.x,
      perchBaseY,
      desiredSupportZ - supportOffset.z,
    );
    dragonPerch.updateMatrix();

    // Transform the platform frame into root space. Tangents use the scaled
    // linear matrix; normals use inverse-transpose.
    const linear = new THREE.Matrix3().setFromMatrix4(dragonPerch.matrix);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(dragonPerch.matrix);
    const dragonForward = localFrame.tangent.clone().applyMatrix3(linear).normalize();
    const dragonUp = localFrame.up.clone().applyMatrix3(normalMatrix).normalize();
    const dragonRight = new THREE.Vector3().crossVectors(dragonForward, dragonUp).normalize();
    dragonUp.crossVectors(dragonRight, dragonForward).normalize();
    const supportLocal = localFrame.point.clone().addScaledVector(localFrame.up, localFrame.surfaceRadius);
    const supportPoint = supportLocal.applyMatrix4(dragonPerch.matrix);
    dragonSlot.position.copy(supportPoint).addScaledVector(dragonUp, 0.8);
    dragonSlot.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(dragonForward, dragonUp, dragonRight));
    dragonSlot.scale.setScalar(Math.max(0.88, Math.min(1.12, 0.82 + half / 240)));
    const oracleInDragonLandmark = oracle.position.clone().sub(dragonLandmark.position);
    dragonSlot.userData.faceTarget = oracleInDragonLandmark.toArray();
    dragonSlot.userData.faceAxis = "local-positive-x";
    dragonSlot.userData.supportMode = "slate-spear-distal-shelf";
    const perchTopY = supportPoint.y;
    const footForward = 18 * perchNarrativeScale;
    const footSide = 15 * perchNarrativeScale;
    const footAnchors = [
      supportPoint.clone().addScaledVector(dragonForward, -footForward).addScaledVector(dragonRight, -footSide),
      supportPoint.clone().addScaledVector(dragonForward, footForward).addScaledVector(dragonRight, -footSide),
      supportPoint.clone().addScaledVector(dragonForward, -footForward).addScaledVector(dragonRight, footSide),
      supportPoint.clone().addScaledVector(dragonForward, footForward).addScaledVector(dragonRight, footSide),
    ];
    // Project each anatomical fore/aft contact onto the actual streamed rock.
    // The old shared plane made a solved ankle look suspended whenever Tripo's
    // asymmetric strata dipped under one foot.
    const inversePerchMatrix = dragonPerch.matrix.clone().invert();
    const legIkTargets: DragonLegTarget[] = DRAGON_LEG_CONTACTS.map((contact) => {
      const plannedSurfaceRoot = supportPoint.clone()
        .addScaledVector(dragonForward, contact.forward * DRAGON_RENDER_SCALE * dragonSlot.scale.x)
        .addScaledVector(dragonRight, -contact.lateral * DRAGON_RENDER_SCALE * dragonSlot.scale.x);
      const queryLocal = plannedSurfaceRoot.clone().applyMatrix4(inversePerchMatrix);
      const surfaceHit = samplePerchSurfaceXZ(dragonPerch.geometry, queryLocal.x, queryLocal.z);
      const surfacePoint = surfaceHit
        ? surfaceHit.point.clone().applyMatrix4(dragonPerch.matrix)
        : plannedSurfaceRoot;
      const surfaceNormal = surfaceHit
        ? surfaceHit.normal.clone().applyMatrix3(normalMatrix).normalize()
        : dragonUp.clone();
      const ankleTarget = surfacePoint.clone()
        .addScaledVector(surfaceNormal, 0.72 * DRAGON_RENDER_SCALE * dragonSlot.scale.x);
      return {
        name: contact.name,
        point: ankleTarget.toArray() as [number, number, number],
        normal: surfaceNormal.toArray() as [number, number, number],
        surfacePoint: surfacePoint.toArray() as [number, number, number],
        surfaceHit: Boolean(surfaceHit),
        surfaceTriangle: surfaceHit?.triangle,
      };
    });
    dragonSlot.userData.legIkTargets = legIkTargets;
    const neckIkTarget = oracleFace.clone().sub(dragonLandmark.position);
    dragonSlot.userData.neckIkTarget = neckIkTarget.toArray();
    (dragonSlot.userData.syncLegIK as (() => void) | undefined)?.();
    dragonPerch.userData.perch = {
      shape: "monumental-diagonal-slate-blade-fan",
      profile: { ...DRAGON_PERCH_STRATA },
      mazeTopY: top,
      adaptiveClearance: mazeClearance,
      boundaryStandOff: dragonStandOff,
      intendedMazeVisualOverlap: mazeVisualOverlap,
      supportBeyondMaze: supportPoint.z - half,
      unloweredHeight: unloweredPerchHeight,
      finalHeight: perchHeight,
      topY: perchTopY,
      radius: DRAGON_PERCH_STRATA.platformRadiusX * perchScaleXZ,
      supportPoint: supportPoint.toArray(),
      supportTangent: dragonForward.toArray(),
      supportNormal: dragonUp.toArray(),
      downwardPitchDegrees: THREE.MathUtils.radToDeg(Math.asin(dragonForward.y)),
      headTarget: oracleInDragonLandmark.toArray(),
      neckIkTarget: neckIkTarget.toArray(),
      footAnchors: footAnchors.map((anchor) => anchor.toArray()),
      legIkTargets,
    };

    // The dragon-side cultural grammar is an ancient hoard barrow. Its gate
    // and oath stones stay around the grounded root; no decorative piece is
    // allowed to float around the overhanging crown.
    const dragonX = dragonPerch.position.x;
    const dragonZ = dragonPerch.position.z;
    const gateScale = 1.28 * perchNarrativeScale;
    hoardGate.scale.set(gateScale, gateScale, gateScale);
    hoardGateVoid.scale.copy(hoardGate.scale);
    hoardGate.position.set(dragonX, perchBaseY + 0.45, dragonZ - 33 * perchScaleXZ);
    hoardGateVoid.position.copy(hoardGate.position);
    hoardGate.rotation.y = -0.08;
    hoardGateVoid.rotation.y = hoardGate.rotation.y;

    // The dragon stays non-emissive. A restrained warm focus grazes the face
    // and chest, while a broad cold spotlight comes from the maze side to cut
    // the horns/wings out of the abyss. Both are fixed LightPool slots.
    const dragonFocus = supportPoint.clone()
      .add(dragonLandmark.position)
      .addScaledVector(dragonForward, 72 * perchNarrativeScale)
      .addScaledVector(dragonUp, 86 * perchNarrativeScale);
    const hoardBounce = dragonFocus.clone()
      .addScaledVector(dragonRight, -18 * perchNarrativeScale)
      .addScaledVector(dragonForward, -18 * perchNarrativeScale);
    const dragonRimPosition = dragonFocus.clone()
      .addScaledVector(dragonForward, 168 * perchNarrativeScale)
      .addScaledVector(dragonRight, 54 * perchNarrativeScale)
      .addScaledVector(dragonUp, 74 * perchNarrativeScale);

    root.userData.cinematicLights = [
      {
        kind: "spot",
        role: "oracle-key",
        x: oracleLight.x,
        y: oracleLight.y,
        z: oracleLight.z,
        targetX: oracleFace.x,
        targetY: oracleFace.y,
        targetZ: oracleFace.z,
        color: 0x66c2b8,
        base: 7200,
        dist: Math.max(220, oracleScale * 132),
        ph: 0,
        angle: Math.PI / 7.5,
        penumbra: 0.78,
      },
      {
        kind: "point",
        role: "dragon-focus",
        x: hoardBounce.x,
        y: hoardBounce.y,
        z: hoardBounce.z,
        color: 0xc86f3f,
        base: 2850,
        dist: Math.max(175, perchNarrativeScale * 205),
        ph: 0,
      },
      {
        kind: "point",
        role: "dragon-rim",
        x: dragonRimPosition.x,
        y: dragonRimPosition.y,
        z: dragonRimPosition.z,
        color: 0x6f9fe8,
        base: 4300,
        dist: Math.max(340, perchNarrativeScale * 390),
        ph: 0,
      },
    ];
    root.userData.dragonLightPlacement = dragonLandmark.position.toArray();

    for (let i = 0; i < oathStelae.count; i++) {
      const u = i / (oathStelae.count - 1);
      const angle = THREE.MathUtils.lerp(-Math.PI / 2, 0.08, u);
      const radius = (DRAGON_PERCH_STRATA.baseRadius + 6 + Math.sin(u * Math.PI) * 4.5) * perchScaleXZ;
      const stelaScale = (0.92 + hash2(seed, i, 551) * 0.17) * perchNarrativeScale;
      oathStelae.setMatrixAt(i, matrix.compose(
        p.set(dragonX + Math.cos(angle) * radius, perchBaseY + 0.5, dragonZ + Math.sin(angle) * radius),
        q.setFromEuler(new THREE.Euler(0, -angle - Math.PI / 2 + (hash2(seed, i, 552) - 0.5) * 0.08, (hash2(seed, i, 553) - 0.5) * 0.035)),
        s.set(stelaScale, stelaScale * (0.96 + hash2(seed, i, 554) * 0.12), stelaScale),
      ));
    }
    oathStelae.instanceMatrix.needsUpdate = true;
    oathStelae.computeBoundingSphere();

    for (let i = 0; i < wardStones.count; i++) {
      const angle = i / wardStones.count * Math.PI * 2 + 0.16;
      const radius = (DRAGON_PERCH_STRATA.baseRadius + 2.5) * perchScaleXZ;
      const runeScale = 0.92 * perchNarrativeScale;
      const wardMatrix = matrix.compose(
        p.set(dragonX + Math.cos(angle) * radius, perchBaseY + 0.5, dragonZ + Math.sin(angle) * radius),
        q.setFromEuler(new THREE.Euler(0, -angle - Math.PI / 2, 0)),
        s.set(runeScale, runeScale * (0.92 + hash2(seed, i, 556) * 0.1), runeScale),
      );
      wardStones.setMatrixAt(i, wardMatrix);
      wardRunes.setMatrixAt(i, wardMatrix);
    }
    wardStones.instanceMatrix.needsUpdate = true;
    wardRunes.instanceMatrix.needsUpdate = true;
    wardStones.computeBoundingSphere();
    wardRunes.computeBoundingSphere();

    // A half-ellipse links the asymmetric endpoints exactly: the oracle stays
    // close to the closed wall while the greatly widened dragon column moves
    // farther out. The +X bow remains beyond the complete maze bound.
    const dragonEndpointX = dragonPerch.position.x + dragonLandmark.position.x;
    const dragonEndpointZ = dragonPerch.position.z + dragonLandmark.position.z;
    const arcadeCenterZ = (oracle.position.z + dragonEndpointZ) * 0.5;
    const arcadeRadiusZ = (dragonEndpointZ - oracle.position.z) * 0.5;
    const arcadeRadiusX = Math.max(half + 76, arcadeRadiusZ * 0.72);
    for (let i = 0; i < arcade.count; i++) {
      const u = i / (arcade.count - 1);
      const angle = -Math.PI / 2 + u * Math.PI;
      const bow = Math.sin(u * Math.PI) * 9 + (hash2(seed, i, 491) - 0.5) * 3;
      const x = THREE.MathUtils.lerp(oracle.position.x, dragonEndpointX, u)
        + Math.cos(angle) * (arcadeRadiusX + bow);
      const z = arcadeCenterZ + Math.sin(angle) * arcadeRadiusZ;
      const tangentX = -Math.sin(angle) * arcadeRadiusX;
      const tangentZ = Math.cos(angle) * arcadeRadiusZ;
      const bayScale = 1.02 + Math.sin(u * Math.PI) * 0.18 + hash2(seed, i, 492) * 0.06;
      arcade.setMatrixAt(i, matrix.compose(
        p.set(x, perchBaseY + 0.6 + hash2(seed, i, 493) * 0.7, z),
        q.setFromEuler(new THREE.Euler(0, Math.atan2(tangentX, tangentZ), (hash2(seed, i, 494) - 0.5) * 0.025)),
        s.set(bayScale, bayScale * (0.96 + hash2(seed, i, 495) * 0.08), bayScale),
      ));
    }
    arcade.instanceMatrix.needsUpdate = true;
    arcade.computeBoundingSphere();

    crags.instanceMatrix.needsUpdate = true;
    crags.computeBoundingSphere();
  };
  refitDragonPerchContact = () => fit(lastFitHalf, lastFitTop);
  (root.userData as { fit?: (half: number, top: number) => void }).fit = (half, top) => {
    fit(half, top);
    invalidatePerchBounds(); // the perch just moved; its bounds are stale
  };
  (root.userData as { clearCamera?: (camera: THREE.Camera) => void }).clearCamera = clearCamera;
  (root.userData as { dispose?: () => void }).dispose = () => {
    cancelOracleStream();
    cancelDragonStream();
    cancelDragonPerchStream();
    wardenStream.dispose();
    wardenRankStream.dispose();
  };
  root.userData.modelStats = {
    guardianTrianglesPerInstance: 29_999,
    guardianStreamedBytes: 1_235_916,
    guardianDestructionProxyTriangles: 2_500,
    guardianDestructionProxyBytes: 45_356,
    guardianHeroInstances: 2,
    guardianRankTrianglesPerInstance: 8_000,
    guardianRankInstances: 6,
    guardianRankStreamedBytes: 369_540,
    dragonSkullTriangles: triangleCount(skullStoneGeo) + triangleCount(skullTeethGeo) + triangleCount(skullVoidGeo),
    oracleTriangles: 0,
    oracleStreamedTriangles: 30_000,
    oracleDestructionProxyTriangles: 2_500,
    oracleStreamedBytes: 1_138_856,
    oracleDestructionProxyBytes: 45_356,
    oracleBackingCliffTriangles: triangleCount(oracleWallGeo),
    dragonPerchColumnTriangles: triangleCount(dragonPerchGeo),
    dragonSlateSpireTriangles: triangleCount(dragonPerchGeo),
    dragonSlateSpireStreamedTriangles: 1_976,
    dragonSlateSpireStreamedVertices: 990,
    dragonSlateSpireStreamedBytes: 36_000,
    dragonSlateSpireQuadFaces: 986,
    dragonSlateSpireClosedSolids: dragonPerchGeo.userData.closedSolids,
    dragonSlateSpireVisualDraws: 1,
    dragonStreamedTriangles: 45_000,
    dragonStreamedBytes: 2_197_956,
    dragonDracoArchiveBytes: 326_948,
    dragonRigBones: 22,
    dragonIkChains: 5,
    dragonNeckWeightedVertices: 2_237,
    dragonLodPolicy: "stable-hero-shell-no-pop",
    dragonHoardGateTriangles: triangleCount(hoardGateGeo) + triangleCount(hoardGateVoidGeo),
    dragonOathStelaTrianglesPerInstance: triangleCount(oathStelaGeo),
    dragonOathStelaInstances: oathStelae.count,
    dragonWardTrianglesPerInstance: triangleCount(wardStoneGeo) + triangleCount(wardRuneGeo),
    dragonWardInstances: wardStones.count,
    arcadeTrianglesPerBay: triangleCount(arcadeGeo),
    arcadeInstances: arcade.count,
    drawObjects: 18,
    navigation: false,
    collision: false,
  };
  fit(42, 42);
  return root;
}
