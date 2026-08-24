// Post chain: single-attachment scene pass + HDR-threshold bloom + a
// depth-aware analytic atmosphere + vignette. Glow materials output
// linear values > 1, so only they (and the hottest torch-lit stone, which is
// the reference look anyway) cross the bloom threshold.

import * as THREE from "three/webgpu";
import {
  pass, screenUV, float, smoothstep, vec3, vec4, time, exp, sin,
  color, getViewPosition, cameraProjectionMatrixInverse, cameraWorldMatrix,
  cameraPosition, mrt, output, normalView, rtt, mix,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { godrays } from "three/addons/tsl/display/GodraysNode.js";
import { bilateralBlur } from "three/addons/tsl/display/BilateralBlurNode.js";
import { depthAwareBlend } from "three/addons/tsl/display/depthAwareBlend.js";
import { MOON_DIR, HORIZON_FOG } from "../scene/env";

export interface PostChain {
  post: THREE.RenderPipeline;
  /**
   * Pass-through view backed by the exact same scene pass as `post`. Rendering
   * this during progressive assembly realizes scene materials in their final
   * target context before the cinematic fullscreen effects are enabled.
   */
  preview: THREE.RenderPipeline;
  /** live bloom strength — close-up modes (the skeleton walk) dial it down */
  setBloom: (s: number) => void;
  godrays: {
    enabled: boolean;
    resolutionScale: number;
    raymarchSteps: number;
  };
}

export function createPost(
  renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera,
  options: {
    ambientOcclusion?: boolean;
    bloom?: boolean;
    cinematic?: boolean;
    godrayLight?: THREE.DirectionalLight;
    godrayVolume?: {
      bottom: THREE.Node<"vec3">;
      top: THREE.Node<"vec3">;
      params: THREE.Node<"vec3">;
      screenBottom: THREE.Node<"vec3">;
      screenTop: THREE.Node<"vec3">;
      screenParams: THREE.Node<"vec3">;
    };
  } = {},
): PostChain {
  const postProcessing = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  if (options.ambientOcclusion) scenePass.setMRT(mrt({ output, normal: normalView }));
  const scenePassColor = scenePass.getTextureNode();
  const previewProcessing = new THREE.RenderPipeline(renderer, scenePassColor);
  if (options.cinematic === false) {
    return {
      post: previewProcessing,
      preview: previewProcessing,
      setBloom: () => undefined,
      godrays: { enabled: false, resolutionScale: 0, raymarchSteps: 0 },
    };
  }
  // threshold 1.0 (was 1.1): the painted reference wants every candle/ember
  // to carry a visible halo, not only the hottest flame cores
  const bloomPass = options.bloom === false ? null : bloom(scenePassColor, 0.9, 0.4, 1.0);

  // volumetric ground fog: a depth-aware raymarch through an animated low-lying
  // density slab — walls occlude it correctly, wisps roll through corridors, and
  // looking toward the moon brightens the fog (cheap forward scattering).
  const depthTex = scenePass.getTextureNode("depth");
  // WebGPU/TSL port of the three-good-godrays technique: reconstruct the
  // camera ray from scene depth, clip it to the directional-light shadow
  // frustum, jittered-raymarch that segment, and sample the existing static
  // moon shadow map at each step. The low-resolution result is depth-aware
  // upsampled so shafts stop cleanly at masonry.
  // Reusing the one baked shadow map avoids both a second shadow render and a
  // fake translucent cone in the scene.
  const vp = getViewPosition(screenUV, depthTex, cameraProjectionMatrixInverse);
  const wp = cameraWorldMatrix.mul(vec4(vp, 1)).xyz;
  const ro = cameraPosition;
  const delta = wp.sub(ro);
  const distGeo = delta.length();
  const rd = delta.div(distGeo.max(0.001));
  let scenePassLit: THREE.Node<"vec4"> = scenePassColor;
  let godrayResolutionScale = 0;
  let godraySteps = 0;
  if (options.godrayLight) {
    const rays = godrays(depthTex, camera, options.godrayLight);
    // The shaft is the hero of the reference frame, and it was reading thin
    // and flat. More steps buy internal structure rather than a uniform cone;
    // higher density and cap make it actually present in the air; weaker
    // distance attenuation lets it stay strong all the way down to the water
    // instead of dying halfway and leaving the beam hanging in the sky.
    rays.raymarchSteps.value = 20;
    rays.density.value = 0.095;
    rays.maxDensity.value = 0.19;
    rays.distanceAttenuation.value = 0.85;
    rays.resolutionScale = 0.4;
    const rayTexture = rays.getTextureNode();
    const boundedRayTexture = (() => {
      if (!options.godrayVolume) return rayTexture;
      const shaftBottom = options.godrayVolume.screenBottom;
      const shaftTop = options.godrayVolume.screenTop;
      const aspect = options.godrayVolume.screenParams.x;
      const pixel = vec3(screenUV.x.mul(aspect), screenUV.y, 0).xy;
      const bottom = vec3(shaftBottom.x.mul(aspect), shaftBottom.y, 0).xy;
      const top = vec3(shaftTop.x.mul(aspect), shaftTop.y, 0).xy;
      const shaftDelta = top.sub(bottom);
      const rawAlong = pixel.sub(bottom).dot(shaftDelta)
        .div(shaftDelta.dot(shaftDelta).max(0.000001));
      const along = rawAlong.clamp(0, 1);
      const closest = bottom.add(shaftDelta.mul(along));
      const shaftDistance = pixel.sub(closest).length();
      const projectedRadius = mix(shaftBottom.z, shaftTop.z, along);
      // Screen-space capsule of the finite physical shaft. The shadow map
      // still carves architecture out of it; this only rejects illuminated
      // orthographic-frustum corners and all air beyond the opening.
      const shaftMask = float(1).sub(smoothstep(
        projectedRadius.mul(1.05),
        projectedRadius.mul(1.75),
        shaftDistance,
      )).mul(smoothstep(-0.04, 0.015, rawAlong))
        // Let an on-screen roof opening dissolve into airborne dust instead
        // of terminating in a bright, horizontal "cap". Wide shots usually
        // place this fade above frame; portrait cameras can see it directly.
        .mul(float(1).sub(smoothstep(0.82, 0.98, rawAlong)));
      return vec4(rayTexture.rgb.mul(shaftMask), rayTexture.a);
    })();
    // Minimal separable blur at the already-small ray resolution removes the
    // checker/dither pattern that otherwise becomes visible on near-black
    // walls. This follows the reference pipeline without paying for a full-
    // resolution blur.
    const softenedRays = bilateralBlur(boundedRayTexture, float(1), 1, 0.1);
    const softenedTexture = softenedRays.getTextureNode();
    scenePassLit = depthAwareBlend(scenePassColor, softenedTexture, depthTex, camera, {
      // Warm parchment-gold: the shaft is the warm counterpoint to the teal
      // air and must never share its hue, or it stops being a light source
      // and becomes a brighter patch of the same fog.
      blendColor: color(0xe4cf9c),
      edgeRadius: 1,
      edgeStrength: 1.25,
    });
    godrayResolutionScale = rays.resolutionScale;
    godraySteps = rays.raymarchSteps.value;
  }
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
  // ---- analytic atmosphere -------------------------------------------------
  // The previous atmosphere rendered a separate 0.4× RTT containing five
  // triNoise3D raymarch steps. Its soft result looked good once warm, but that
  // large nested TSL graph was the dominant first-use compile cost. Reconstruct
  // position once and shape a low fog bank analytically instead: depth still
  // keeps it behind masonry, one broad moving sine prevents a static flat band,
  // and the final graph becomes small enough to compile on the first post frame.
  const fogBand = smoothstep(-22, 7, wp.y).oneMinus();
  const fogDistance = smoothstep(18, 185, distGeo);
  const fogFlow = sin(wp.x.mul(0.017).add(wp.z.mul(0.011)).add(time.mul(0.025)))
    .mul(0.08).add(0.92);
  const fogAmount = fogBand.mul(fogDistance).mul(fogFlow).mul(0.42).clamp(0, 0.42);
  const fogTrans = float(1).sub(fogAmount);
  const scatter = rd.dot(vec3(MOON_DIR.x, MOON_DIR.y, MOON_DIR.z)).clamp(0, 1).pow(5).mul(0.5).add(1);

  // aerial perspective: an ANALYTIC exponential height haze over the full depth
  // (iq's closed-form integral — no extra marching). This is the "one air" that
  // ties the diorama together: far blocks sink into the same moonlit blue
  // instead of standing clean against the abyss, and the horizon grades softly.
  // Denser air, starting sooner. The reference separates near / mid / far
  // into three clearly distinct value bands; ours had the mid-ground melting
  // into the near-ground because the haze barely registered until 165 units
  // out. Depth cueing is the cheapest read of scale a scene has.
  const HAZE_A = 0.0036; // density at y = 0
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
  // Starts sooner than it did (28 → 20) so the mid-ground separates from the
  // near-ground, but the far end has to stay where it was: pulling it in to
  // 120 saturated everything past it and a wide shot went flat dark.
  const hazeGate = smoothstep(20, 165, distGeo);
  const hazeAmt = float(1).sub(exp(od.negate())).mul(hazeGate)
    .max(wpLow.mul(distF).mul(belowH).mul(0.92))
    .clamp(0, 0.92);

  // Keep the final composite tiny: atmosphere is a separate low-resolution
  // texture, but unlike the former pass it contains no loop or 3D noise. This
  // preserves the useful pipeline boundary without its shader-build cost.
  const atmosphere = rtt(vec4(fogTrans, hazeAmt, scatter, float(1)));
  atmosphere.setResolutionScale(0.4);
  const atmoTrans = atmosphere.r;
  const atmoHaze = atmosphere.g;
  const atmoScatter = atmosphere.b;
  // teal-leaning abyss fog vs blue horizon haze: the depth gradient then
  // moves through two hues (teal depths → indigo air) instead of one flat blue
  // bioluminescent floor fill (user-confirmed from the reference): the abyss
  // fog now GLOWS teal, so the underworld reads as lit water instead of void
  const fogCol = color(0x1e6b5f).mul(atmoScatter).mul(0.8);
  const hazeCol = color(HORIZON_FOG).mul(atmoScatter);

  // cinematic finish: gentle vignette pulls the eye to the lit heart of the maze
  const vig = float(1).sub(smoothstep(0.5, 1.02, screenUV.sub(0.5).length().mul(1.35)).mul(0.3));
  const composed = vec4(scenePassLit.rgb.mul(aoFactor), scenePassLit.a)
    .add(bloomPass ?? vec4(0));
  const hazed = composed.mul(float(1).sub(atmoHaze)).add(hazeCol.mul(atmoHaze));
  const fogged = hazed.mul(atmoTrans).add(fogCol.mul(float(1).sub(atmoTrans)));
  // split-tone grade: shadows lean cold indigo-cyan, highlights (torch pools,
  // moon shafts, glow crests) lean warm ivory, plus a small vibrance lift.
  // Multiplicative near-white tints keep blacks black and never clip, and the
  // whole grade is a handful of MADs — no measurable GPU cost.
  const luma = fogged.rgb.dot(vec3(0.299, 0.587, 0.114));
  const toneMixK = smoothstep(0.05, 0.55, luma);
  // ref-C (eldritch green) grade: shadows pushed green-cyan, highlights warm
  // ivory-green so torch pools stay amber while the air goes deep-sea teal
  const graded = fogged.rgb.mul(mix(vec3(0.85, 1.03, 1.06), vec3(1.16, 1.09, 0.83), toneMixK));
  const vibrant = mix(vec3(luma), graded, 1.16);
  // Painted value grouping: an S-curve pulls the low midtones down into one
  // dark mass so the lit areas separate from it — that grouping is what makes
  // the reference read as painted rather than evenly exposed. Shaped below
  // 1.0 only, so torch cores and the moon shaft keep their HDR headroom and
  // still cross the bloom threshold.
  const toe = vibrant.min(vec3(1));
  const curved = toe.mul(toe).mul(vec3(3).sub(toe.mul(2)));
  // 0.26 rather than 0.38: at a wide framing most of the maze already sits
  // in the cavern lid's shadow, and a harder toe crushed it into one
  // unreadable mass instead of grouping it.
  const shaped = vibrant.add(mix(toe, curved, 0.26)).sub(toe);
  postProcessing.outputNode = vec4(shaped.mul(vig), fogged.a);
  return {
    post: postProcessing,
    preview: previewProcessing,
    setBloom: (s: number) => { if (bloomPass) bloomPass.strength.value = s; },
    godrays: {
      enabled: Boolean(options.godrayLight),
      resolutionScale: godrayResolutionScale,
      raymarchSteps: godraySteps,
    },
  };
}
