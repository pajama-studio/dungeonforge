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
  instanceIndex, hash, smoothstep, length, fract, abs, mix, float, atan, max, step,
  triNoise3D, transformNormalToView, attribute, uniform,
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
function makeStoneMat(): THREE.MeshLambertNodeMaterial {
  // Lambert = diffuse-only lighting: matte stone doesn't need GGX, and it
  // halves the per-light fragment cost across the entire masonry fill.
  const mat = new THREE.MeshLambertNodeMaterial({ vertexColors: true });
  const pl = positionLocal;
  const nl = normalLocal;
  const hw = (CELL * 1.02) / 2;
  const hh = (COURSE * 1.02) / 2;

  // CHIPPED CORNERS — vertex-only, the cheapest possible break-up: pick one
  // corner per instance by hash and crush its bevel vertices inward along the
  // corner diagonal (~45% of bricks, varying depth). No new geometry, no extra
  // draw calls, and the shadow pass shares positionNode so silhouettes match.
  // Tiles/steps/merlons share this material but their vertices never reach
  // blockGeo's corner zone, so they opt out automatically.
  const idf = instanceIndex.toFloat();
  {
    const cornerW = smoothstep(0.6, 0.97, abs(pl.x).div(hw))
      .mul(smoothstep(0.6, 0.97, abs(pl.y).div(hh)))
      .mul(smoothstep(0.6, 0.97, abs(pl.z).div(hw)));
    const cornerId = step(0, pl.x).add(step(0, pl.y).mul(2)).add(step(0, pl.z).mul(4));
    const pick = hash(idf.add(0.53)).mul(7.99).floor();
    const isPicked = float(1).sub(abs(cornerId.sub(pick)).min(1));
    const depth = smoothstep(0.55, 1.0, hash(idf.add(4.13))).mul(0.34);
    mat.positionNode = pl.sub(pl.normalize().mul(cornerW.mul(isPicked).mul(depth)));
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
  // fake running-bond: an extra vertical seam at a per-instance offset
  const off = hash(instanceIndex.toFloat().add(0.13)).sub(0.5).mul(1.3);
  const vseam = smoothstep(0.06, 0.015, abs(pl.x.sub(off)))
    .add(smoothstep(0.06, 0.015, abs(pl.z.sub(off.mul(-0.7)))))
    .mul(sideMask);
  // hand-cut seams: modulate the mortar so joints vary in depth along their run
  const cutRaw = triNoise3D(positionWorld.mul(2.2), 0, 0);
  const cut = cutRaw.mul(0.5).add(0.65);
  const mortar = ex.add(ez).add(line).add(vseam).clamp(0, 1).mul(cut);
  // weathered grain: three FINE scales only — a macro (low-frequency) term just
  // smears meaningless light/dark clouds across whole walls
  const g46 = triNoise3D(positionWorld.mul(4.6), 0, 0);
  const g06 = triNoise3D(positionWorld.mul(0.6), 0, 0);
  const grain = g06.mul(0.16)
    .add(triNoise3D(positionWorld.mul(1.8), 0, 0).mul(0.13))
    .add(g46.mul(0.09));
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
  mat.normalNode = transformNormalToView(nl.sub(gT).add(pl.normalize().mul(wear.mul(0.55))).normalize());

  const cavity = band.mul(sx.mul(sz)).mul(0.5).add(0.5);
  // rain streaks: columnar (y-independent) noise → dark weathering runs down
  // the side faces, like water has been bleeding off the walkways for ages
  const streak = smoothstep(0.58, 0.78, triNoise3D(vec3(positionWorld.x.mul(0.9), 0, positionWorld.z.mul(0.9)), 0, 0))
    .mul(sideMask);
  const albedo = float(0.86).add(grain)
    .mul(float(1).sub(mortar.mul(0.42)))
    .mul(cavity.mul(0.09).add(0.955))
    .mul(float(1).sub(streak.mul(0.22)))
    .add(wear.mul(0.16))                     // abraded arrises go pale
    .mul(float(1).sub(pits.mul(0.4)))        // pockmarks go dark
    .mul(float(1).sub(crack.mul(0.55)));     // crack shadow line
  mat.colorNode = vec3(albedo);
  return mat;
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
  stairMat: THREE.MeshLambertNodeMaterial;
  redMat: THREE.MeshStandardNodeMaterial;
  woodMat: THREE.MeshLambertNodeMaterial;
  ropeMat: THREE.MeshLambertNodeMaterial;
  plugMat: THREE.MeshLambertNodeMaterial;
  brambleMat: THREE.MeshLambertNodeMaterial;
  vineMat: THREE.MeshLambertNodeMaterial;
  mossMat: THREE.MeshLambertNodeMaterial;
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
    wallGlowMat.colorNode = color(0xff8a35).mul(fall).mul(flick).mul(0.42);
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
    floorGlowMat.colorNode = color(0xff9440).mul(fall).mul(flick).mul(0.5);
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
    stoneMat: makeStoneMat(),
    // spiral stair towers share the masonry face-shading via vertex colors
    stairMat: new THREE.MeshLambertNodeMaterial({ color: 0x8a7a62, vertexColors: true }),
    redMat,
    woodMat: new THREE.MeshLambertNodeMaterial(),
    // ropes are plain Meshes — no per-instance color to darken them, so the
    // material itself carries the tarred-hemp brown (shared woodMat is white)
    ropeMat: new THREE.MeshLambertNodeMaterial({ color: 0x3b2b1a }),
    plugMat: new THREE.MeshLambertNodeMaterial({ color: 0x10141f }),
    brambleMat: new THREE.MeshLambertNodeMaterial(),
    vineMat,
    mossMat,
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
