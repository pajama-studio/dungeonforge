// Environment: night sky gradient, height fog pooling in the abyss, moonlight,
// distant cliff silhouettes, abyss floor. Everything deterministic from the seed.

import * as THREE from "three/webgpu";
import {
  color, mix, positionWorld, positionWorldDirection, time,
  fog, densityFogFactor, triNoise3D, float,
} from "three/tsl";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { hash2 } from "../gen/rng";
import { ABYSS } from "../gen/dungeon";

export const TH = 1.85;   // world height per tier
export const CELL = 2.2;  // world size per grid cell

export function buildEnvironment(scene: THREE.Scene, seed: number): {
  fit: (half: number) => void; bakeShadows: () => void; dispose: () => void;
} {
  const group = new THREE.Group();
  group.name = "environment";

  // -- Sky: deep navy zenith, faintly glowing horizon.
  const dirY = positionWorldDirection.y.clamp(-0.35, 1);
  scene.backgroundNode = mix(
    color(0x1a2340),
    color(0x05070f),
    dirY.add(0.35).div(1.35).pow(0.55),
  );

  // -- Fog: animated ground fog pooling below the fortress + gentle distance haze.
  const fogColor = color(0x132a41); // cool teal-blue mist
  const fogBase = float(ABYSS * TH - 8);
  const noise = triNoise3D(positionWorld.mul(0.014), 0.25, time).mul(5.0);
  const fogTop = float(2.2).add(noise);
  const ground = fogTop.sub(positionWorld.y).div(fogTop.sub(fogBase)).saturate().mul(0.96);
  const haze = densityFogFactor(float(0.008));
  const combined = ground.oneMinus().mul(haze.oneMinus()).oneMinus();
  scene.fogNode = fog(fogColor, combined);

  // -- Lights: cool hemisphere + one shadow-casting moon.
  const hemi = new THREE.HemisphereLight(0x3d4c78, 0x33241a, 1.05);
  group.add(hemi);

  const moon = new THREE.DirectionalLight(0x93a9e8, 1.45);
  moon.position.set(-46, 48, -22); // raking but high enough to light wall tops
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  const sc = moon.shadow.camera;
  sc.left = -52; sc.right = 52; sc.top = 52; sc.bottom = -52;
  sc.near = 8; sc.far = 150;
  moon.shadow.bias = -0.0006;
  moon.shadow.radius = 1; // r=3 blurred small-prop contact shadows into detached "floating" blobs
  moon.shadow.autoUpdate = false; // static scene — bake once per regeneration
  group.add(moon, moon.target);

  // -- Canyon walls: terraced rock mesas ringing the fortress. Each mesa is a
  //    stack of shrinking, slightly rotated strata with per-stratum vertex
  //    color (tops catch the sky) — silhouettes read as layered stone, not boxes.
  {
    const geos: THREE.BufferGeometry[] = [];
    const tint = new THREE.Color();
    const addMesa = (a: number, rad: number, baseW: number, baseD: number, nStrata: number, hMul: number, k: number) => {
      let w = baseW, d = baseD;
      let yy = ABYSS * TH - 12;
      for (let s = 0; s < nStrata; s++) {
        const hS = (2.5 + hash2(seed, k * 7 + s, 11) * 4.5) * hMul;
        const g = new THREE.BoxGeometry(w, hS, d);
        // per-stratum shading: deeper strata darker, top faces lighter still
        const lum = 0.055 + s * 0.02 + hash2(seed, k * 7 + s, 12) * 0.015;
        tint.setHSL(0.6 - s * 0.008, 0.32, lum);
        const nVerts = g.getAttribute("position").count;
        const colArr = new Float32Array(nVerts * 3);
        const nrm = g.getAttribute("normal");
        for (let i = 0; i < nVerts; i++) {
          const topBoost = nrm.getY(i) > 0.5 ? 1.7 : 1;
          colArr[i * 3] = tint.r * topBoost;
          colArr[i * 3 + 1] = tint.g * topBoost;
          colArr[i * 3 + 2] = tint.b * topBoost;
        }
        g.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
        g.rotateY(a + (hash2(seed, k * 7 + s, 13) - 0.5) * 0.35);
        const jx = (hash2(seed, k * 7 + s, 14) - 0.5) * w * 0.16;
        const jz = (hash2(seed, k * 7 + s, 15) - 0.5) * d * 0.16;
        g.translate(Math.cos(a) * rad + jx, yy + hS / 2, Math.sin(a) * rad + jz);
        geos.push(g);
        yy += hS * (0.82 + hash2(seed, k * 7 + s, 16) * 0.12);
        w *= 0.78 + hash2(seed, k * 7 + s, 17) * 0.12;
        d *= 0.78 + hash2(seed, k * 7 + s, 18) * 0.12;
      }
    };
    // near ring: broad terraced mesas
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 + hash2(seed, k, 1) * 0.55;
      addMesa(a, 62 + hash2(seed, k, 2) * 26, 14 + hash2(seed, k, 3) * 14, 10 + hash2(seed, k, 4) * 10, 3 + Math.floor(hash2(seed, k, 5) * 3), 1.6, k);
    }
    // a few gaunt spires between them
    for (let k = 12; k < 19; k++) {
      const a = (k / 7) * Math.PI * 2 + hash2(seed, k, 6) * 0.8;
      addMesa(a, 55 + hash2(seed, k, 7) * 20, 5 + hash2(seed, k, 8) * 4, 5 + hash2(seed, k, 9) * 3, 5 + Math.floor(hash2(seed, k, 10) * 3), 1.9, k);
    }
    // far ring: bigger, darker, half-swallowed by haze
    for (let k = 19; k < 29; k++) {
      const a = (k / 10) * Math.PI * 2 + hash2(seed, k, 19) * 0.5;
      addMesa(a, 105 + hash2(seed, k, 20) * 35, 26 + hash2(seed, k, 21) * 20, 18 + hash2(seed, k, 22) * 12, 3, 2.6, k);
    }
    const merged = BufferGeometryUtils.mergeGeometries(geos);
    for (const g of geos) g.dispose();
    const mat = new THREE.MeshLambertNodeMaterial({ vertexColors: true });
    const cliffs = new THREE.Mesh(merged, mat);
    cliffs.receiveShadow = false;
    group.add(cliffs);
  }

  // -- Abyss floor far below (catches fog color, hides the void).
  {
    const mat = new THREE.MeshLambertNodeMaterial({ color: 0x0a0e1a });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), mat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = ABYSS * TH - 12;
    group.add(plane);
  }

  scene.add(group);

  return {
    /** widen the shadow frustum to the current fortress half-extent */
    fit(half: number) {
      const r = half + 12;
      if (Math.abs(sc.right - r) < 1) return;
      sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r;
      sc.updateProjectionMatrix();
    },
    bakeShadows() {
      moon.shadow.needsUpdate = true;
    },
    dispose() {
      scene.remove(group);
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
      });
    },
  };
}
