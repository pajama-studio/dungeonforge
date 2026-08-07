// Third-person adventurer. Character model: KayKit Skeletons (CC0) — see
// LICENSES.md. Movement queries a ground sampler supplied by the orchestrator
// (island grids + bridge spans); the camera is a smoothed chase rig.

import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { color, uv, length, smoothstep } from "three/tsl";

export interface GroundHit { y: number; ok: boolean; solid?: boolean }
export type GroundSampler = (x: number, z: number, refY?: number) => GroundHit;

export interface PlayerInput { f: number; s: number } // forward, strafe in [-1,1]

const SPEED = 5.2;
const TURN_LERP = 10;
const STEP_LIMIT = 1.45; // max climbable height difference per step

export class Player {
  readonly group = new THREE.Group();
  private model: THREE.Group | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private idleAction: THREE.AnimationAction | null = null;
  private runAction: THREE.AnimationAction | null = null;
  private walkAction: THREE.AnimationAction | null = null;
  private gait: "idle" | "walk" | "run" = "idle";
  private heading = 0;
  private vy = 0;
  falling = false;
  climbing = false;
  lastSafeX = 0;
  lastSafeZ = 0;

  /** first-person: hide the body (the orchestrator's lantern stays with you) */
  setFirstPerson(fp: boolean): void {
    if (this.model) this.model.visible = !fp;
    for (const c of this.group.children) {
      if ((c as THREE.Mesh).geometry instanceof THREE.CircleGeometry) c.visible = !fp;
    }
  }

  constructor() {
    // NOTE: the warm lantern light lives permanently in the SCENE (owned by
    // main.ts), not in this group — adding/removing a light recompiles every
    // pipeline in three's WebGPU forward path, which made ⚔ Enter hitch.
    // soft blob contact shadow (baked moon shadows can't follow a moving actor)
    const blobMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    blobMat.colorNode = color(0x000000);
    blobMat.opacityNode = smoothstep(0.5, 0.05, length(uv().sub(0.5))).mul(0.45);
    const blob = new THREE.Mesh(new THREE.CircleGeometry(0.62, 20), blobMat);
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.02;
    this.group.add(blob);
  }

  async load(url: string): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(url);
    this.model = gltf.scene;
    this.model.scale.setScalar(0.85); // a touch smaller than the corridors suggest
    this.model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
        // no self-glow: some pack materials ship with emissive set
        const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (mat && "emissive" in mat) { mat.emissive.setRGB(0, 0, 0); mat.emissiveIntensity = 0; }
        // never culled: compileAsync only compiles what survives the frustum
        // test, and the player preloads PARKED off-world — culling him there
        // would defer the skinned-pipeline compile to the first Enter (a
        // visible ~1s hitch). A handful of meshes, negligible to keep live.
        o.frustumCulled = false;
      }
    });
    this.group.add(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);
    const clips = gltf.animations;
    const find = (re: RegExp) => clips.find((c) => re.test(c.name));
    const idle = find(/^idle$/i) ?? find(/idle/i);
    const run = find(/^running_a$/i) ?? find(/run/i) ?? find(/walk/i);
    const wk = find(/^walking_a$/i) ?? find(/walk/i);
    if (idle) { this.idleAction = this.mixer.clipAction(idle); this.idleAction.play(); }
    if (run) { this.runAction = this.mixer.clipAction(run); }
    if (wk) { this.walkAction = this.mixer.clipAction(wk); }
  }

  place(x: number, z: number, ground: GroundSampler): void {
    const g = ground(x, z);
    this.group.position.set(x, g.ok ? g.y : 0, z);
    this.falling = false;
    this.vy = 0;
  }

  update(dt: number, input: PlayerInput, camYaw: number, ground: GroundSampler): void {
    const p = this.group.position;
    if (this.climbing) {
      // the ladder owns vertical motion; just keep the animation alive
      this.mixer?.update(dt);
      return;
    }
    if (this.falling) {
      // stepped through a broken sky-door — the abyss takes it from here
      this.vy -= 30 * dt;
      p.y += this.vy * dt;
      this.mixer?.update(dt);
      return;
    }
    const mag = Math.hypot(input.f, input.s);
    if (mag > 0.05) {
      const inv = 1 / Math.max(1, mag);
      // camera-relative movement
      const dx = (Math.sin(camYaw) * input.f + Math.cos(camYaw) * input.s) * inv;
      const dz = (Math.cos(camYaw) * input.f - Math.sin(camYaw) * input.s) * inv;
      const step = SPEED * dt;
      const tryMove = (mx: number, mz: number): boolean => {
        const g = ground(p.x + mx, p.z + mz, p.y);
        if (!g.ok) {
          if (g.solid) return false; // a wall blocks
          p.x += mx; p.z += mz;      // open void: walk out — and drop
          this.falling = true;
          this.vy = 0;
          return true;
        }
        if (Math.abs(g.y - p.y) > STEP_LIMIT) return false;
        p.x += mx; p.z += mz;
        p.y += (g.y - p.y) * Math.min(1, dt * 14);
        return true;
      };
      const moved = tryMove(dx * step, dz * step) || tryMove(dx * step, 0) || tryMove(0, dz * step);
      if (moved) {
        const target = Math.atan2(dx, dz);
        let d = target - this.heading;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this.heading += d * Math.min(1, dt * TURN_LERP);
        if (this.model) this.model.rotation.y = this.heading;
      }
      this.setRunning(moved);
    } else {
      this.setRunning(false);
      const g = ground(p.x, p.z, p.y);
      if (g.ok) {
        p.y += (g.y - p.y) * Math.min(1, dt * 14);
        this.lastSafeX = p.x;
        this.lastSafeZ = p.z;
      }
    }
    this.mixer?.update(dt);
  }

  /** scripted locomotion (route walker): position/heading driven externally.
   *  gait "walk" is used on stairs/steep ramps (the pack has no dedicated
   *  climb clip — a slower walk cycle is the standard-issue stand-in). */
  driveTo(p: THREE.Vector3, heading: number, dt: number, gait: "idle" | "walk" | "run"): void {
    this.group.position.copy(p);
    if (this.model) this.model.rotation.y = heading;
    this.setGait(gait);
    this.mixer?.update(dt);
  }

  private actionFor(g: "idle" | "walk" | "run"): THREE.AnimationAction | null {
    if (g === "run") return this.runAction ?? this.walkAction;
    if (g === "walk") return this.walkAction ?? this.runAction;
    return this.idleAction;
  }

  private setGait(g: "idle" | "walk" | "run"): void {
    if (g === this.gait) return;
    const fadeOut = this.actionFor(this.gait);
    const fadeIn = this.actionFor(g);
    this.gait = g;
    if (fadeIn && fadeIn !== fadeOut) { fadeIn.reset().fadeIn(0.18).play(); }
    if (fadeOut && fadeIn !== fadeOut) { fadeOut.fadeOut(0.18); }
  }

  private setRunning(run: boolean): void {
    this.setGait(run ? "run" : "idle");
  }

  dispose(): void {
    this.group.removeFromParent();
  }
}
