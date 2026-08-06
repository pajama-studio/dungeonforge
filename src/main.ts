// Dungeonforge — procedural stone-labyrinth fortress diorama.
// three.js WebGPURenderer + TSL; MRT emissive bloom; deterministic seeds.

import * as THREE from "three/webgpu";
import { pass, mrt, output, emissive } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { generate } from "./gen/dungeon";
import { buildWorld, type WorldHandle } from "./scene/build";
import { buildEnvironment, TH } from "./scene/env";
import { mulberry32 } from "./gen/rng";

const app = document.getElementById("app")!;
const nameEl = document.getElementById("dungeonName")!;
const seedEl = document.getElementById("seedLabel")!;
const loadingEl = document.getElementById("loading")!;
const btnNew = document.getElementById("btnNew") as HTMLButtonElement;
const btnGo = document.getElementById("btnGo") as HTMLButtonElement;
const seedInput = document.getElementById("seedInput") as HTMLInputElement;

const params = new URLSearchParams(location.search);
let seed = Number(params.get("seed")) || 20260806;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.5, 400);
camera.position.set(42, 46, 64);

const renderer = new THREE.WebGPURenderer({ antialias: false });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.05;
app.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 2 * TH, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = 1.38;
controls.minDistance = 18;
controls.maxDistance = 170;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;
renderer.domElement.addEventListener("pointerdown", () => { controls.autoRotate = false; }, { once: false });

// post: MRT emissive bloom — only emissiveNode content glows.
const postProcessing = new THREE.PostProcessing(renderer);
const scenePass = pass(scene, camera);
scenePass.setMRT(mrt({ output, emissive }));
const scenePassColor = scenePass.getTextureNode();
const bloomPass = bloom(scenePass.getTextureNode("emissive"), 1.1, 0.4);
postProcessing.outputNode = scenePassColor.add(bloomPass);

const env = buildEnvironment(scene, 1); // env is seed-stable; kept across regens

let world: WorldHandle | null = null;

function forge(newSeed: number): void {
  seed = newSeed >>> 0 || 1;
  if (world) world.dispose();
  const layout = generate(seed);
  world = buildWorld(layout);
  scene.add(world.group);
  env.bakeShadows();
  nameEl.textContent = layout.name;
  seedEl.textContent = `seed ${seed} · ${layout.stats.floor} floor · ${layout.stats.wall} wall · ${layout.stats.genMs}ms`;
  const url = new URL(location.href);
  url.searchParams.set("seed", String(seed));
  history.replaceState(null, "", url);
}

const uiRng = mulberry32((Date.now() ^ 0x5f3759df) >>> 0); // UI-only randomness; the world itself is seed-pure
btnNew.addEventListener("click", () => forge((uiRng() * 0xffffffff) >>> 0));
btnGo.addEventListener("click", () => forge(Number(seedInput.value) || 1));
seedInput.addEventListener("keydown", (e) => { if (e.key === "Enter") forge(Number(seedInput.value) || 1); });

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

forge(seed);

let firstFrame = true;
renderer.setAnimationLoop(() => {
  const t = performance.now() / 1000;
  controls.update();
  world?.tick(t);
  postProcessing.render();
  if (firstFrame) {
    firstFrame = false;
    loadingEl.style.opacity = "0";
  }
});
