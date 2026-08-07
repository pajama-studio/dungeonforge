// Environment: night sky gradient, height fog pooling in the abyss, moonlight,
// distant cliff silhouettes, abyss floor. Everything deterministic from the seed.

import * as THREE from "three/webgpu";
import {
  color, mix, positionWorld, positionWorldDirection, time,
  fog, densityFogFactor, triNoise3D, float, floor as tslFloor, hash, smoothstep, vec3, sin,
  uv, length, uniform,
} from "three/tsl";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { hash2 } from "../gen/rng";
import { ABYSS } from "../gen/dungeon";
import { TH } from "../config";

export type Environment = ReturnType<typeof buildEnvironment>;

/** the moon's direction — shared by the sky disc, the shadow light and the
 *  post-pass fog forward scattering (env owns it; nobody re-derives it) */
export const MOON_DIR = new THREE.Vector3(-46, 48, -22).normalize();

/** the ONE horizon-air color. The sky's below-horizon fog band and the post
 *  pass's aerial haze both converge to it — any mismatch between the two shows
 *  up as a hard seam along the abyss plane's edge / the far silhouette line. */
export const HORIZON_FOG = 0x102841;

export function buildEnvironment(scene: THREE.Scene, seed: number): {
  fit: (half: number, centerX?: number, centerZ?: number, top?: number) => void;
  bakeShadows: () => void;
  dispose: () => void;
} {
  const group = new THREE.Group();
  group.name = "environment";

  // -- Sky: deep navy zenith, faintly glowing horizon, salted with stars and
  //    crowned by the moon (HDR values — the bloom pass gives it its halo).
  {
    const dir = positionWorldDirection;
    const dirY = dir.y.clamp(-0.35, 1);
    const base = mix(color(0x1a2340), color(0x05070f), dirY.add(0.35).div(1.35).pow(0.55));
    const cell = tslFloor(dir.mul(170));
    const starH = hash(cell.x.mul(7.91).add(cell.y.mul(37.7)).add(cell.z.mul(113.3)));
    const twinkle = sin(hash(starH.mul(97.3)).mul(6.2832).add(time.mul(0.9))).mul(0.3).add(0.7);
    const stars = smoothstep(0.9962, 0.9995, starH).mul(twinkle).mul(dir.y.clamp(0, 1).pow(0.4)).mul(1.4);
    // milky way: a faint patchy band along the great circle whose pole is bandN —
    // gives the upper sky some structure without competing with the moon
    const bandN = vec3(0.62, 0.33, -0.71);
    const band = smoothstep(0.32, 0.04, dir.dot(bandN).abs());
    const patch = triNoise3D(dir.mul(2.6), 0, 0).mul(0.75).add(triNoise3D(dir.mul(7.3), 0, 0).mul(0.25));
    const milky = band.mul(patch).mul(dir.y.clamp(0, 1).pow(0.35)).mul(0.16);
    const md = dir.dot(vec3(MOON_DIR.x, MOON_DIR.y, MOON_DIR.z)).clamp(0, 1);
    const disc = smoothstep(0.99955, 0.99985, md).mul(2.6);
    const halo = md.pow(220).mul(0.5);
    const skyRaw = base
      .add(vec3(stars))
      .add(color(0x8fa3d8).mul(milky))
      .add(color(0xdfe8ff).mul(disc.add(halo)));
    // horizon fog band: below the true horizon the sky settles into the same
    // hazy air the post-pass paints on far geometry. Without this the abyss
    // plane's far edge meets a FLAT navy below-horizon sky as a hard straight
    // seam — the two sides must converge to one color so no edge can show.
    const hband = smoothstep(0.2, -0.03, dir.y);
    scene.backgroundNode = mix(skyRaw, color(HORIZON_FOG), hband.mul(0.96));
  }

  // -- Fog: animated ground fog pooling below the fortress + gentle distance haze.
  const fogColor = color(0x132a41); // cool teal-blue mist
  const fogBase = float(ABYSS * TH - 8);
  const noise = triNoise3D(positionWorld.mul(0.014), 0.25, time).mul(5.0);
  const fogTop = float(2.2).add(noise);
  // material-level ground fog dialed back — the post-pass volumetric raymarch
  // now owns the low mist; this only keeps distant aerial perspective coherent
  const ground = fogTop.sub(positionWorld.y).div(fogTop.sub(fogBase)).saturate().mul(0.55);
  const hazeU = uniform(0.008); // adapts to view extent — multi-block chains need thinner air
  const haze = densityFogFactor(hazeU);
  const combined = ground.oneMinus().mul(haze.oneMinus()).oneMinus();
  scene.fogNode = fog(fogColor, combined);

  // -- Lights, staged like a night exterior: a cool moon KEY with shadows, a
  //    dimmer ambient FILL so darks actually go dark (contrast is what makes
  //    the torch pools feel warm), and a faint counter-directional RIM that
  //    lifts silhouettes off the abyss. All created here, before the first
  //    compile — a changing scene light count recompiles every pipeline.
  const hemi = new THREE.HemisphereLight(0x39497e, 0x2e2018, 0.72);
  group.add(hemi);

  const rim = new THREE.DirectionalLight(0x4f689f, 0.55);
  rim.position.set(52, 20, 34); // low, opposite the moon — silhouette kisser
  group.add(rim, rim.target);

  const moon = new THREE.DirectionalLight(0x9db2ef, 1.75);
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
  //    Everything ring-shaped lives in ringGroup so fit() can recentre/rescale
  //    it around a multi-block chain.
  const ringGroup = new THREE.Group();
  group.add(ringGroup);
  {
    const geos: THREE.BufferGeometry[] = [];
    const tint = new THREE.Color();
    // Each stratum is a CLUSTER of jittered rock chunks, not one big box —
    // up close the cliffs read as craggy stone, not furniture.
    const addMesa = (a: number, rad: number, baseW: number, baseD: number, nStrata: number, hMul: number, k: number, silhouette = false) => {
      let w = baseW, d = baseD;
      let yy = ABYSS * TH - 12;
      for (let s = 0; s < nStrata; s++) {
        const hS = (2.5 + hash2(seed, k * 7 + s, 11) * 4.5) * hMul;
        const cx0 = Math.cos(a) * rad, cz0 = Math.sin(a) * rad;
        const nChunks = silhouette ? 2 : 3 + Math.floor(hash2(seed, k * 7 + s, 40) * 3);
        for (let c = 0; c < nChunks; c++) {
          const q = k * 131 + s * 17 + c;
          const cw = w * (0.45 + hash2(seed, q, 41) * 0.5);
          const cd = d * (0.45 + hash2(seed, q, 42) * 0.5);
          const ch = hS * (0.75 + hash2(seed, q, 43) * 0.55);
          const g = new THREE.BoxGeometry(cw, ch, cd);
          const lum = (silhouette ? 0.045 + s * 0.008 : 0.055 + s * 0.02) + hash2(seed, q, 44) * 0.02;
          tint.setHSL(0.6 - s * 0.008, silhouette ? 0.38 : 0.32, lum);
          const nVerts = g.getAttribute("position").count;
          const colArr = new Float32Array(nVerts * 3);
          const nrm = g.getAttribute("normal");
          for (let i = 0; i < nVerts; i++) {
            const topBoost = nrm.getY(i) > 0.5 ? (silhouette ? 1.12 : 1.38) : 1;
            colArr[i * 3] = tint.r * topBoost;
            colArr[i * 3 + 1] = tint.g * topBoost;
            colArr[i * 3 + 2] = tint.b * topBoost;
          }
          g.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
          g.rotateY(a + (hash2(seed, q, 45) - 0.5) * 0.9);
          g.translate(
            cx0 + (hash2(seed, q, 46) - 0.5) * w * 0.55,
            yy + ch / 2 - hS * 0.15,
            cz0 + (hash2(seed, q, 47) - 0.5) * d * 0.55,
          );
          geos.push(g);
        }
        yy += hS * (0.8 + hash2(seed, k * 7 + s, 16) * 0.12);
        w *= 0.7 + hash2(seed, k * 7 + s, 17) * 0.12;
        d *= 0.7 + hash2(seed, k * 7 + s, 18) * 0.12;
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
    // far ring: jagged dark silhouettes, wildly uneven heights — no shelf line
    for (let k = 19; k < 31; k++) {
      const a = (k / 12) * Math.PI * 2 + hash2(seed, k, 19) * 0.7;
      const hVar = 1.4 + hash2(seed, k, 23) * 2.6; // some low, some looming
      addMesa(a, 100 + hash2(seed, k, 20) * 45, 16 + hash2(seed, k, 21) * 22, 14 + hash2(seed, k, 22) * 12, 3 + Math.floor(hash2(seed, k, 24) * 3), hVar, k, true);
    }
    // distant sister ruins: dark tower clusters with one or two living lights —
    // the labyrinth does not end at this canyon
    {
      const ruinMat = new THREE.MeshLambertNodeMaterial({ color: 0x0e1526 });
      const lightMat = new THREE.MeshBasicNodeMaterial();
      lightMat.colorNode = color(0xffb35c).mul(2.2);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + 0.9 + hash2(seed, k, 25) * 0.6;
        const rad = 92 + hash2(seed, k, 26) * 30;
        const cx2 = Math.cos(a) * rad, cz2 = Math.sin(a) * rad;
        const cluster = new THREE.Group();
        const nT = 4 + Math.floor(hash2(seed, k, 27) * 4);
        for (let t = 0; t < nT; t++) {
          const hT = 6 + hash2(seed, k * 9 + t, 28) * 20;
          const wT = 2.2 + hash2(seed, k * 9 + t, 29) * 4;
          const tower = new THREE.Mesh(new THREE.BoxGeometry(wT, hT, wT), ruinMat);
          tower.position.set(
            cx2 + (hash2(seed, k * 9 + t, 30) - 0.5) * 16,
            ABYSS * TH - 8 + hT / 2,
            cz2 + (hash2(seed, k * 9 + t, 31) - 0.5) * 16,
          );
          tower.rotation.y = hash2(seed, k * 9 + t, 32) * 0.8;
          cluster.add(tower);
          // a lit window or two on the tallest towers
          if (hT > 18 && hash2(seed, k * 9 + t, 35) < 0.8) {
            const win = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.7), lightMat);
            const wa = Math.atan2(-cz2, -cx2); // face roughly toward the fortress
            win.position.set(
              tower.position.x + Math.cos(wa) * (wT / 2 + 0.05),
              tower.position.y + hT * 0.28,
              tower.position.z + Math.sin(wa) * (wT / 2 + 0.05),
            );
            win.rotation.y = wa + Math.PI / 2;
            cluster.add(win);
          }
        }
        ringGroup.add(cluster);
      }
    }
    // mist curtain: a ring of broad fog banks that swallows the horizon seam
    {
      const mist = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
      mist.colorNode = color(0x27415f);
      mist.opacityNode = smoothstep(0.5, 0.06, length(uv().sub(0.5))).mul(0.1);
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2 + hash2(seed, k, 33) * 0.4;
        const s = new THREE.Sprite(mist);
        const rad = 96 + hash2(seed, k, 34) * 26;
        s.position.set(Math.cos(a) * rad, -2 + hash2(seed, k, 36) * 6, Math.sin(a) * rad);
        const sc = 46 + hash2(seed, k, 37) * 26;
        s.scale.set(sc, sc * 0.4, 1);
        ringGroup.add(s);
      }
    }
    const merged = BufferGeometryUtils.mergeGeometries(geos);
    for (const g of geos) g.dispose();
    const mat = new THREE.MeshLambertNodeMaterial({ vertexColors: true });
    const cliffs = new THREE.Mesh(merged, mat);
    cliffs.receiveShadow = false;
    ringGroup.add(cliffs);
  }

  // -- Abyss floor far below (catches fog color, hides the void). Lives in
  //    ringGroup so fit() recentres/rescales it with the chain — a fixed plane
  //    at the origin showed its edge as a hard diagonal under big chains.
  {
    const mat = new THREE.MeshLambertNodeMaterial({ color: 0x0a0e1a });
    // 900: the far edge must sit past the fog-band convergence distance even
    // under big chains (ringGroup scales it further) — a visible edge reads
    // as a hard diagonal across the horizon
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), mat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = ABYSS * TH - 12;
    ringGroup.add(plane);
  }

  scene.add(group);

  return {
    /** refit shadows, canyon ring and haze to the current chain extent/centre.
     *  `top` = world height of the tallest stack: the moon backs off along its
     *  own direction and the shadow volume grows so sky-spires stay inside the
     *  light frustum instead of silently losing their shadows. */
    fit(half: number, centerX = 0, centerZ = 0, top = 0) {
      const k = Math.max(1, (top + 26) / 60);
      const r = half + 12 + top * 0.35;
      if (Math.abs(sc.right - r) >= 1) {
        sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r;
        sc.far = 150 * k;
        sc.updateProjectionMatrix();
        moon.position.set(-46 * k + centerX, 48 * k, -22 * k + centerZ);
        moon.target.position.set(centerX, 0, centerZ);
        rim.position.set(centerX + 52, 20 * k, centerZ + 34);
        rim.target.position.set(centerX, 0, centerZ);
      }
      // the mesa/mist/ruin ring was authored around a ~40-unit island — recentre
      // on the chain and push it outward so cliffs never intersect the blocks
      const s = Math.max(1, (half + 26) / 72);
      ringGroup.position.set(centerX, 0, centerZ);
      ringGroup.scale.set(s, 1, s);
      // longer sightlines need thinner air or the far blocks drown in haze
      hazeU.value = Math.min(0.008, Math.max(0.002, 0.5 / (half * 2.4)));
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
