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

export function buildEnvironment(scene: THREE.Scene, seed: number): { bakeShadows: () => void; dispose: () => void } {
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
  const fogColor = color(0x111a2f);
  const fogBase = float(ABYSS * TH - 8);
  const noise = triNoise3D(positionWorld.mul(0.014), 0.25, time).mul(5.0);
  const fogTop = float(2.2).add(noise);
  const ground = fogTop.sub(positionWorld.y).div(fogTop.sub(fogBase)).saturate().mul(0.96);
  const haze = densityFogFactor(float(0.0095));
  const combined = ground.oneMinus().mul(haze.oneMinus()).oneMinus();
  scene.fogNode = fog(fogColor, combined);

  // -- Lights: cool hemisphere + one shadow-casting moon.
  const hemi = new THREE.HemisphereLight(0x3a4a72, 0x2a1e14, 0.85);
  group.add(hemi);

  const moon = new THREE.DirectionalLight(0x93a9e8, 1.3);
  moon.position.set(-52, 38, -20); // grazing angle — long raking shadows sell the height
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  const sc = moon.shadow.camera;
  sc.left = -52; sc.right = 52; sc.top = 52; sc.bottom = -52;
  sc.near = 8; sc.far = 150;
  moon.shadow.bias = -0.0006;
  moon.shadow.radius = 3;
  moon.shadow.autoUpdate = false; // static scene — bake once per regeneration
  group.add(moon, moon.target);

  // -- Distant cliff silhouettes ringing the fortress.
  {
    const geos: THREE.BufferGeometry[] = [];
    const count = 14;
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + hash2(seed, k, 1) * 0.5;
      const rad = 58 + hash2(seed, k, 2) * 34;
      const w = 10 + hash2(seed, k, 3) * 16;
      const h = 10 + hash2(seed, k, 4) * 24;
      const g = new THREE.BoxGeometry(w, h, 8 + hash2(seed, k, 5) * 10);
      g.rotateY(a + (hash2(seed, k, 6) - 0.5) * 0.8);
      g.translate(Math.cos(a) * rad, ABYSS * TH - 10 + h / 2, Math.sin(a) * rad);
      geos.push(g);
    }
    const merged = BufferGeometryUtils.mergeGeometries(geos);
    for (const g of geos) g.dispose();
    const mat = new THREE.MeshStandardNodeMaterial({ color: 0x141b2c, roughness: 1 });
    const cliffs = new THREE.Mesh(merged, mat);
    cliffs.receiveShadow = false;
    group.add(cliffs);
  }

  // -- Abyss floor far below (catches fog color, hides the void).
  {
    const mat = new THREE.MeshStandardNodeMaterial({ color: 0x0a0e1a, roughness: 1 });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), mat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = ABYSS * TH - 12;
    group.add(plane);
  }

  scene.add(group);

  return {
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
