// Post chain: single-attachment scene pass + HDR-threshold bloom + a
// depth-aware volumetric ground-fog raymarch + vignette. Glow materials output
// linear values > 1, so only they (and the hottest torch-lit stone, which is
// the reference look anyway) cross the bloom threshold.

import * as THREE from "three/webgpu";
import {
  pass, screenUV, float, smoothstep, vec3, vec4, Loop, hash, time, exp,
  color, getViewPosition, cameraProjectionMatrixInverse, cameraWorldMatrix,
  cameraPosition, triNoise3D,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { MOON_DIR, HORIZON_FOG } from "../scene/env";

export interface PostChain {
  post: THREE.PostProcessing;
  /** live bloom strength — close-up modes (the skeleton walk) dial it down */
  setBloom: (s: number) => void;
}

export function createPost(
  renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera,
): PostChain {
  const postProcessing = new THREE.PostProcessing(renderer);
  const scenePass = pass(scene, camera);
  const scenePassColor = scenePass.getTextureNode();
  const bloomPass = bloom(scenePassColor, 0.9, 0.4, 1.1);

  // volumetric ground fog: a depth-aware raymarch through an animated low-lying
  // density slab — walls occlude it correctly, wisps roll through corridors, and
  // looking toward the moon brightens the fog (cheap forward scattering).
  const depthTex = scenePass.getTextureNode("depth");
  const vp = getViewPosition(screenUV, depthTex, cameraProjectionMatrixInverse);
  const wp = cameraWorldMatrix.mul(vec4(vp, 1)).xyz;
  const ro = cameraPosition;
  const delta = wp.sub(ro);
  const distGeo = delta.length();
  const maxDist = distGeo.min(110);
  const rd = delta.div(distGeo);
  // 5 steps (was 7): the raymarch is a fixed full-screen cost — three noise
  // octaves per step — and the jittered dither hides the coarser sampling.
  // Density is scaled by 7/5 so the fog itself doesn't thin.
  const STEPS = 5;
  const stepLen = maxDist.div(STEPS);
  const jitter = hash(screenUV.x.mul(1213.7).add(screenUV.y.mul(771.1))); // static dither hides banding
  const trans = float(1).toVar();
  Loop({ type: "int", start: 0, end: STEPS, condition: "<" }, ({ i }) => {
    const t = float(i).add(jitter).mul(stepLen);
    const p = ro.add(rd.mul(t));
    const hFall = smoothstep(4.5, -6.5, p.y); // slab: dense below the fortress floor, gone above
    // one BROAD octave, drifting slowly: reads as rolling banks, not crumbs —
    // high base (0.55) keeps the slab连绵 with the noise only shaping its edges
    const n = triNoise3D(p.mul(0.008).add(vec3(time.mul(0.005), 0, time.mul(0.0035))), 0.1, time);
    const dens = hFall.mul(n.mul(0.45).add(0.55)).mul(0.085);
    trans.mulAssign(exp(dens.mul(stepLen).negate()));
  });
  const scatter = rd.dot(vec3(MOON_DIR.x, MOON_DIR.y, MOON_DIR.z)).clamp(0, 1).pow(5).mul(0.5).add(1);
  const fogCol = color(0x27476b).mul(scatter).mul(0.85);

  // aerial perspective: an ANALYTIC exponential height haze over the full depth
  // (iq's closed-form integral — no extra marching). This is the "one air" that
  // ties the diorama together: far blocks sink into the same moonlit blue
  // instead of standing clean against the abyss, and the horizon grades softly.
  const HAZE_A = 0.0042; // density at y = 0
  const HAZE_B = 0.028; // height falloff
  const dFar = distGeo.min(320);
  const dy = rd.y.sign().mul(rd.y.abs().max(0.02)); // guard the horizon singularity
  const od = float(HAZE_A / HAZE_B)
    .mul(exp(ro.y.mul(-HAZE_B)))
    .mul(float(1).sub(exp(dy.mul(dFar).mul(-HAZE_B))))
    .div(dy);
  // convergence floor: everything FAR and BELOW the horizon — abyss plane, its
  // far-plane cut, the mesa silhouette belt, the sky behind them — is pushed to
  // ≥97% haze, i.e. to HORIZON_FOG itself. The sky's fog band is the SAME
  // color, so no boundary between geometry and background can render as a
  // seam. The exp integral alone stalls near 40% at glancing angles, which
  // left the dark silhouette belt meeting a brighter sky band as a hard line.
  // The floor must select the ABYSS LAYER only — low world height, at range,
  // below the horizon. A pure distance test drowned the whole fortress once
  // the camera stood 250+ units out: fortress tops must stay crisp at ANY
  // distance, while mesas/plane/underworld sink into the fog sea.
  // belowH ramps over the same dir.y range as the sky's fog band (env.ts) so
  // silhouettes poking above the horizon can't render as a dark belt.
  const wpLow = smoothstep(26, 5, wp.y);
  const distF = smoothstep(120, 230, distGeo);
  const belowH = smoothstep(0.2, -0.03, rd.y);
  const hazeAmt = float(1).sub(exp(od.negate()))
    .max(wpLow.mul(distF).mul(belowH).mul(0.95))
    .clamp(0, 0.95);
  const hazeCol = color(HORIZON_FOG).mul(scatter);

  // cinematic finish: gentle vignette pulls the eye to the lit heart of the maze
  const vig = float(1).sub(smoothstep(0.5, 1.02, screenUV.sub(0.5).length().mul(1.35)).mul(0.45));
  const composed = scenePassColor.add(bloomPass);
  const hazed = composed.mul(float(1).sub(hazeAmt)).add(hazeCol.mul(hazeAmt));
  postProcessing.outputNode = hazed.mul(trans).add(fogCol.mul(float(1).sub(trans))).mul(vig);
  return {
    post: postProcessing,
    setBloom: (s: number) => { bloomPass.strength.value = s; },
  };
}
