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
  private attackAction: THREE.AnimationAction | null = null;
  private torchFlameAnchor: THREE.Object3D | null = null;
  private gait: "idle" | "walk" | "run" = "idle";
  private attacking = false;
  private heading = 0;
  private vy = 0;
  falling = false;
  climbing = false;
  attacksPlayed = 0;
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
    this.model.scale.setScalar(0.72); // a touch smaller than the corridors suggest
    const playerMaterials = new Map<string, THREE.Material>();
    this.model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
        // Old bone must receive the cold moon key and the warm hand torch. The
        // former unlit Basic material flattened every value into plastic grey.
        // Clustered forward lighting keeps this one skinned Lambert pipeline
        // independent of the scene's torch count; it remains demand-loaded.
        const mesh = o as THREE.Mesh;
        const source = mesh.material as THREE.MeshStandardMaterial;
        const kind = /eyes/i.test(mesh.name) ? "eyes" : /cloak/i.test(mesh.name) ? "cloak" : "bone";
        let material = playerMaterials.get(kind);
        if (!material) {
          if (kind === "eyes") {
            material = new THREE.MeshBasicNodeMaterial({ color: 0xff7a2b });
          } else {
            material = new THREE.MeshLambertNodeMaterial({
              color: kind === "cloak" ? 0x414958 : 0xd2c39f,
              map: source.map,
              transparent: source.transparent,
              opacity: source.opacity,
              alphaTest: source.alphaTest,
              side: source.side,
            });
          }
          material.name = `player-${kind}-matte`;
          playerMaterials.set(kind, material);
        }
        mesh.material = material;
        // never culled: compileAsync only compiles what survives the frustum
        // test, and the player preloads PARKED off-world — culling him there
        // would defer the skinned-pipeline compile to the first Enter (a
        // visible ~1s hitch). A handful of meshes, negligible to keep live.
        mesh.frustumCulled = false;
      }
    });
    this.attachTorch();
    this.group.add(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);
    const clips = gltf.animations;
    const find = (re: RegExp) => clips.find((c) => re.test(c.name));
    const idle = find(/^idle$/i) ?? find(/idle/i);
    const run = find(/^running_a$/i) ?? find(/run/i) ?? find(/walk/i);
    const wk = find(/^walking_a$/i) ?? find(/walk/i);
    const attack = find(/^1H_Melee_Attack_Slice_Horizontal$/i)
      ?? find(/melee.*attack.*slice/i) ?? find(/attack/i);
    if (idle) { this.idleAction = this.mixer.clipAction(idle); this.idleAction.play(); }
    if (run) { this.runAction = this.mixer.clipAction(run); }
    if (wk) { this.walkAction = this.mixer.clipAction(wk); }
    if (attack) {
      this.attackAction = this.mixer.clipAction(attack);
      this.attackAction.setLoop(THREE.LoopOnce, 1);
      this.attackAction.clampWhenFinished = false;
      this.mixer.addEventListener("finished", (event) => {
        if (event.action !== this.attackAction) return;
        this.attacking = false;
        this.attackAction?.fadeOut(0.08);
        this.actionFor(this.gait)?.reset().fadeIn(0.1).play();
      });
    }
  }

  /** Position of the actual flame, used by the one permanent scene light. */
  getTorchWorldPosition(target: THREE.Vector3): THREE.Vector3 {
    if (!this.torchFlameAnchor) return target.copy(this.group.position).add(new THREE.Vector3(0, 2.4, 0));
    this.torchFlameAnchor.updateWorldMatrix(true, false);
    return this.torchFlameAnchor.getWorldPosition(target);
  }

  private attachTorch(): void {
    if (!this.model) return;
    // GLTFLoader sanitizes punctuation in bone names (`handslot.l` ->
    // `handslotl`) to make animation track paths addressable.
    const leftHand = this.model.getObjectByName("handslot.l")
      ?? this.model.getObjectByName("handslotl")
      ?? this.model.getObjectByName("hand.l")
      ?? this.model.getObjectByName("handl");
    if (!leftHand) return;
    const torch = new THREE.Group();
    torch.name = "left-hand-dungeon-torch";
    // KayKit's left hand slot points its local +X upward in the authored idle
    // pose. Rotate our +Y-authored torch into that grip so it is carried
    // upright instead of projecting horizontally through the wrist.
    torch.rotation.z = -Math.PI / 2;
    const wood = new THREE.MeshLambertNodeMaterial({ color: 0x3a2116 });
    const iron = new THREE.MeshLambertNodeMaterial({ color: 0x2b2c31 });
    const outerFire = new THREE.MeshBasicNodeMaterial({ color: 0xff6a20 });
    const innerFire = new THREE.MeshBasicNodeMaterial({ color: 0xffd36a });
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.052, 0.72, 6), wood);
    handle.position.y = 0.29;
    const basket = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.062, 0.17, 6), iron);
    basket.position.y = 0.68;
    const flame = new THREE.Mesh(new THREE.OctahedronGeometry(0.14, 0), outerFire);
    flame.name = "torch-flame-outer";
    flame.position.y = 0.84;
    flame.scale.set(0.72, 1.45, 0.72);
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.085, 0), innerFire);
    core.name = "torch-flame-core";
    core.position.y = 0.81;
    core.scale.set(0.62, 1.3, 0.62);
    this.torchFlameAnchor = new THREE.Object3D();
    this.torchFlameAnchor.name = "torch-flame-light-anchor";
    this.torchFlameAnchor.position.y = 0.84;
    torch.add(handle, basket, flame, core, this.torchFlameAnchor);
    leftHand.add(torch);
  }

  place(x: number, z: number, ground: GroundSampler): void {
    const g = ground(x, z);
    this.group.position.set(x, g.ok ? g.y : 0, z);
    this.falling = false;
    this.vy = 0;
  }

  update(dt: number, input: PlayerInput, camYaw: number, ground: GroundSampler, speedScale = 1): void {
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
      const step = SPEED * Math.max(0.1, Math.min(2.4, speedScale)) * dt;
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

  /** Play the authored melee clip without allocating a new action. Movement
   * can continue; the current gait resumes when the one-shot finishes. */
  attack(): boolean {
    if (!this.attackAction) return false;
    this.actionFor(this.gait)?.fadeOut(0.04);
    this.attackAction.reset().setEffectiveWeight(1).fadeIn(0.035).play();
    this.attacking = true;
    this.attacksPlayed++;
    return true;
  }

  /** scripted locomotion (route walker): position/heading driven externally.
   *  gait "walk" is used on stairs/steep ramps (the pack has no dedicated
   *  climb clip — a slower walk cycle is the standard-issue stand-in). */
  driveTo(p: THREE.Vector3, heading: number, dt: number, gait: "idle" | "walk" | "run"): void {
    this.group.position.copy(p);
    if (this.model) {
      // shortest-arc smoothing: the body TURNS toward its travel direction
      // instead of snapping — on spiral stairs it leans through the curve
      let d = heading - this.model.rotation.y;
      d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      this.model.rotation.y += d * Math.min(1, dt * 9);
    }
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
    if (this.attacking) return;
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
