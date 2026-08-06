// Third-person adventurer. Character model: KayKit Adventurers (CC0) — see
// LICENSES.md. Movement queries a ground sampler supplied by the orchestrator
// (island grids + bridge spans); the camera is a smoothed chase rig.

import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { color, uv, length, smoothstep } from "three/tsl";

export interface GroundHit { y: number; ok: boolean }
export type GroundSampler = (x: number, z: number) => GroundHit;

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
  private running = false;
  private heading = 0;
  readonly lantern: THREE.PointLight;

  constructor() {
    // warm lantern so the hero carries their own pool of light through the maze
    this.lantern = new THREE.PointLight(0xffa050, 26, 11, 2);
    this.lantern.position.set(0, 2.2, 0);
    this.group.add(this.lantern);
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
    this.model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) { o.castShadow = false; o.receiveShadow = false; }
    });
    this.group.add(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);
    const clips = gltf.animations;
    const find = (re: RegExp) => clips.find((c) => re.test(c.name));
    const idle = find(/^idle$/i) ?? find(/idle/i);
    const run = find(/^running_a$/i) ?? find(/run/i) ?? find(/walk/i);
    if (idle) { this.idleAction = this.mixer.clipAction(idle); this.idleAction.play(); }
    if (run) { this.runAction = this.mixer.clipAction(run); }
  }

  place(x: number, z: number, ground: GroundSampler): void {
    const g = ground(x, z);
    this.group.position.set(x, g.ok ? g.y : 0, z);
  }

  update(dt: number, input: PlayerInput, camYaw: number, ground: GroundSampler): void {
    const p = this.group.position;
    const mag = Math.hypot(input.f, input.s);
    if (mag > 0.05) {
      const inv = 1 / Math.max(1, mag);
      // camera-relative movement
      const dx = (Math.sin(camYaw) * input.f + Math.cos(camYaw) * input.s) * inv;
      const dz = (Math.cos(camYaw) * input.f - Math.sin(camYaw) * input.s) * inv;
      const step = SPEED * dt;
      const tryMove = (mx: number, mz: number): boolean => {
        const g = ground(p.x + mx, p.z + mz);
        if (!g.ok || Math.abs(g.y - p.y) > STEP_LIMIT) return false;
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
      const g = ground(p.x, p.z);
      if (g.ok) p.y += (g.y - p.y) * Math.min(1, dt * 14);
    }
    this.mixer?.update(dt);
  }

  private setRunning(run: boolean): void {
    if (run === this.running) return;
    this.running = run;
    const fadeIn = run ? this.runAction : this.idleAction;
    const fadeOut = run ? this.idleAction : this.runAction;
    if (fadeIn) { fadeIn.reset().fadeIn(0.15).play(); }
    if (fadeOut) { fadeOut.fadeOut(0.15); }
  }

  dispose(): void {
    this.group.removeFromParent();
  }
}
