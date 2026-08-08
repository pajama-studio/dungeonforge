// Post chain: single-attachment scene pass + HDR-threshold bloom + a
// depth-aware volumetric ground-fog raymarch + vignette. Glow materials output
// linear values > 1, so only they (and the hottest torch-lit stone, which is
// the reference look anyway) cross the bloom threshold.

import * as THREE from "three/webgpu";
import {
  pass, screenUV, float, smoothstep, vec3, vec4, Loop, hash, time, exp,
  color, getViewPosition, cameraProjectionMatrixInverse, cameraWorldMatrix,
  cameraPosition, triNoise3D, mrt, output, normalView,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { MOON_DIR, HORIZON_FOG } from "../scene/env";

export interface PostChain {
  post: THREE.RenderPipeline;
  /** live bloom strength — close-up modes (the skeleton walk) dial it down */
  setBloom: (s: number) => void;
}

export function createPost(
  renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera,
  options: { ambientOcclusion?: boolean } = {},
): PostChain {
  const postProcessing = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  if (options.ambientOcclusion) scenePass.setMRT(mrt({ output, normal: normalView }));
  const scenePassColor = scenePass.getTextureNode();
  const bloomPass = bloom(scenePassColor, 0.9, 0.4, 1.1);

  // volumetric ground fog: a depth-aware raymarch through an animated low-lying
  // density slab — walls occlude it correctly, wisps roll through corridors, and
  // looking toward the moon brightens the fog (cheap forward scattering).
  const depthTex = scenePass.getTextureNode("depth");
  const aoFactor = (() => {
    if (!options.ambientOcclusion) return float(1);
    const normalTex = scenePass.getTextureNode("normal");
    const aoPass = ao(depthTex, normalTex, camera);
    aoPass.resolutionScale = 0.5;
    aoPass.samples.value = 8;
    // r185 reaches wider/darker than earlier releases. Keep it contact-scale
    // and blend only 35% so hand-painted value grouping survives.
    aoPass.radius.value = 0.18;
    aoPass.scale.value = 0.72;
    aoPass.distanceFallOff.value = 0.88;
    return aoPass.getTextureNode().r.mul(0.35).add(0.65);
  })();
  const vp = getViewPosition(screenUV, depthTex, cameraProjectionMatrixInverse);
  const wp = cameraWorldMatrix.mul(vec4(vp, 1)).xyz;
  const ro = cameraPosition;
  const delta = wp.sub(ro);
  const distGeo = delta.length();
  const rd = delta.div(distGeo);
  // Analytically intersect the view ray with the actual ground-fog slab. The
  // former camera-relative max distance never reached y≈0 from high overview
  // shots, so all five samples ran through clear air. Concentrating the same
  // sample count between the slab entry/exit makes it volumetric at any camera
  // height without increasing shader work.
  const safeRy = rd.y.sign().mul(rd.y.abs().max(0.015));
  const slabA = float(5).sub(ro.y).div(safeRy);
  const slabB = float(-24).sub(ro.y).div(safeRy);
  const fogEnter = slabA.min(slabB).max(0);
  const fogExit = slabA.max(slabB).min(distGeo);
  const fogSpan = fogExit.sub(fogEnter).max(0);
  // 5 steps (was 7): the raymarch is a fixed full-screen cost — three noise
  // octaves per step — and the jittered dither hides the coarser sampling.
  // Density is scaled by 7/5 so the fog itself doesn't thin.
  const STEPS = 5;
  const stepLen = fogSpan.div(STEPS);
  const jitter = hash(screenUV.x.mul(1213.7).add(screenUV.y.mul(771.1))); // static dither hides banding
  const trans = float(1).toVar();
  Loop({ type: "int", start: 0, end: STEPS, condition: "<" }, ({ i }) => {
    const t = fogEnter.add(float(i).add(jitter).mul(stepLen));
    const p = ro.add(rd.mul(t));
    const hFall = smoothstep(-5.5, 3.5, p.y).oneMinus(); // dense below the fortress floor, gone above
    // One broad 3D octave stays within the old sample budget. A very cheap
    // warped sine supplies continent-scale motion, then thresholding opens
    // true negative-space channels. The old `0.55 + noise` had a 55% density
    // floor, which inevitably rendered the abyss as one uniform blue slab.
    const n = triNoise3D(p.mul(0.008).add(vec3(time.mul(0.005), 0, time.mul(0.0035))), 0.1, time);
    const flow = sin(p.x.mul(0.019).add(p.z.mul(0.013)).add(time.mul(0.025))).mul(0.5).add(0.5);
    const bankField = n.mul(0.76).add(flow.mul(0.24));
    const billow = smoothstep(0.22, 0.48, bankField);
    const crest = smoothstep(0.43, 0.59, bankField);
    // Fade again below the abyss floor so distant rays do not integrate a
    // bottomless column. This creates floating fog banks with dark void under.
    const floorFade = smoothstep(-23, -12, p.y);
    const dens = hFall.mul(floorFade).mul(billow.mul(0.072).add(crest.mul(0.022)));
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
  const wpLow = smoothstep(5, 26, wp.y).oneMinus();
  const distF = smoothstep(120, 230, distGeo);
  const belowH = smoothstep(-0.03, 0.2, rd.y).oneMinus();
  const hazeAmt = float(1).sub(exp(od.negate()))
    .max(wpLow.mul(distF).mul(belowH).mul(0.95))
    .clamp(0, 0.95);
  const hazeCol = color(HORIZON_FOG).mul(scatter);

  // cinematic finish: gentle vignette pulls the eye to the lit heart of the maze
  const vig = float(1).sub(smoothstep(0.5, 1.02, screenUV.sub(0.5).length().mul(1.35)).mul(0.45));
  const composed = vec4(scenePassColor.rgb.mul(aoFactor), scenePassColor.a).add(bloomPass);
  const hazed = composed.mul(float(1).sub(hazeAmt)).add(hazeCol.mul(hazeAmt));
  postProcessing.outputNode = hazed.mul(trans).add(fogCol.mul(float(1).sub(trans))).mul(vig);
  return {
    post: postProcessing,
    setBloom: (s: number) => { bloomPass.strength.value = s; },
  };
}
