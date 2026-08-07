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
import { MOON_DIR } from "../scene/env";

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
    const hFall = smoothstep(2.8, -5.5, p.y); // slab: dense below the fortress floor, gone above
    const n = triNoise3D(p.mul(0.021).add(vec3(time.mul(0.009), 0, time.mul(0.006))), 0.3, time);
    const dens = hFall.mul(n.mul(0.8).add(0.2)).mul(0.07);
    trans.mulAssign(exp(dens.mul(stepLen).negate()));
  });
  const scatter = rd.dot(vec3(MOON_DIR.x, MOON_DIR.y, MOON_DIR.z)).clamp(0, 1).pow(5).mul(0.5).add(1);
  const fogCol = color(0x27476b).mul(scatter).mul(0.85);

  // cinematic finish: gentle vignette pulls the eye to the lit heart of the maze
  const vig = float(1).sub(smoothstep(0.5, 1.02, screenUV.sub(0.5).length().mul(1.35)).mul(0.45));
  const composed = scenePassColor.add(bloomPass);
  postProcessing.outputNode = composed.mul(trans).add(fogCol.mul(float(1).sub(trans))).mul(vig);
  return {
    post: postProcessing,
    setBloom: (s: number) => { bloomPass.strength.value = s; },
  };
}
