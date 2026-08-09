// The asset library. Every entry builds a fresh scene object on demand.
//
// Two families:
//  - KIT assets reuse the shared geometry/material singletons the generator
//    itself draws with, so a hand-placed column is pixel-identical to a
//    generated one and costs no new pipeline. They are flagged `editorShared`
//    so removing a placement never disposes resources the world still uses.
//  - STREAMED assets pull the same Draco GLBs the landmarks use. They are
//    cached per URL, then cloned, so placing five wardens is one download.

import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { getKit } from "../scene/kit";
import { thumbnailFor } from "./thumbs";
import type { AssetDef } from "./types";

const draco = new DRACOLoader();
draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
const gltf = new GLTFLoader();
gltf.setDRACOLoader(draco);

const glbCache = new Map<string, Promise<THREE.Group>>();

function loadGlb(url: string): Promise<THREE.Group> {
  let pending = glbCache.get(url);
  if (!pending) {
    pending = gltf.loadAsync(url).then((result) => result.scene);
    glbCache.set(url, pending);
  }
  return pending;
}

/** Streamed landmark shells are authored dark for the cinematic key light.
 *  Editor copies get the same treatment the landmark loader applies. */
function prepareStreamed(source: THREE.Group, scale: number): THREE.Object3D {
  const clone = source.clone(true);
  clone.scale.setScalar(scale);
  clone.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const prepare = (material: THREE.Material) => {
      const cloned = material.clone();
      const stone = cloned as THREE.MeshStandardMaterial;
      if (stone.isMeshStandardMaterial) {
        stone.color.multiplyScalar(1.35);
        stone.metalness = 0;
        stone.roughness = Math.max(0.86, stone.roughness);
      }
      return cloned;
    };
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(prepare)
      : prepare(mesh.material);
  });
  return clone;
}

/** A kit mesh: shared geometry + shared material, never disposed by the
 *  editor. The wrapper group gives the gizmo a clean pivot at the base. */
function kitMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  lift = 0,
): THREE.Object3D {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = lift;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const holder = new THREE.Group();
  holder.add(mesh);
  holder.userData.editorShared = true; // do not dispose kit singletons
  return holder;
}

type KitEntry = Omit<AssetDef, "build"> & {
  pick: (kit: ReturnType<typeof getKit>) => [THREE.BufferGeometry, THREE.Material, number?];
};

const KIT_ENTRIES: KitEntry[] = [
  // ---- masonry ------------------------------------------------------------
  { id: "block", label: "Stone block", group: "Masonry", icon: "🧱", pick: (k) => [k.blockGeo, k.stoneMat] },
  { id: "block-top", label: "Block cap", group: "Masonry", icon: "⬜", pick: (k) => [k.blockTopGeo, k.stoneMat] },
  { id: "tile", label: "Floor tile", group: "Masonry", icon: "▫️", pick: (k) => [k.tileGeo, k.stoneMat] },
  { id: "red-tile", label: "Red tile", group: "Masonry", icon: "🟥", pick: (k) => [k.tileGeo, k.redMat] },
  { id: "column", label: "Column", group: "Masonry", icon: "🏛", pick: (k) => [k.colGeo, k.stoneMat] },
  { id: "step", label: "Stair step", group: "Masonry", icon: "📶", pick: (k) => [k.stepGeo, k.stairMat] },
  { id: "merlon", label: "Merlon", group: "Masonry", icon: "🔺", pick: (k) => [k.merlonGeo, k.stoneMat] },
  { id: "bay", label: "Arcade bay", group: "Masonry", icon: "🏗", pick: (k) => [k.architecturalBayGeo, k.stoneMat] },
  { id: "tower-roof", label: "Tower roof", group: "Masonry", icon: "⛺", pick: (k) => [k.towerRoofGeo, k.stoneMat] },
  { id: "debris", label: "Debris chunk", group: "Masonry", icon: "🪨", pick: (k) => [k.debrisGeo, k.stoneMat] },

  // ---- props --------------------------------------------------------------
  { id: "crate", label: "Crate", group: "Props", icon: "📦", pick: (k) => [k.crateGeo, k.woodMat] },
  { id: "rubble", label: "Rubble", group: "Props", icon: "🧿", pick: (k) => [k.rubbleGeo, k.stoneMat] },
  { id: "banner", label: "Banner", group: "Props", icon: "🎏", pick: (k) => [k.bannerGeo, k.bannerMat] },
  { id: "bracket", label: "Torch bracket", group: "Props", icon: "🕯", pick: (k) => [k.bracketGeo, k.stoneMat] },
  { id: "bowl", label: "Brazier bowl", group: "Props", icon: "🥣", pick: (k) => [k.bowlGeo, k.stoneMat] },
  { id: "post", label: "Wooden post", group: "Props", icon: "🪵", pick: (k) => [k.postGeo, k.woodMat] },
  { id: "plank", label: "Plank", group: "Props", icon: "🪚", pick: (k) => [k.plankGeo, k.woodMat] },
  { id: "medallion", label: "Plaza medallion", group: "Props", icon: "🥇", pick: (k) => [k.circleGeo, k.medallionMat] },

  // ---- growth -------------------------------------------------------------
  { id: "vine", label: "Vine", group: "Growth", icon: "🌿", pick: (k) => [k.vineGeo, k.vineMat] },
  { id: "leaf", label: "Leaves", group: "Growth", icon: "🍃", pick: (k) => [k.leafGeo, k.leafMat] },
  { id: "moss", label: "Moss patch", group: "Growth", icon: "🟩", pick: (k) => [k.mossGeo, k.mossMat] },
  { id: "bramble", label: "Bramble", group: "Growth", icon: "🌾", pick: (k) => [k.brambleGeoA, k.brambleMat] },
  { id: "root", label: "Root", group: "Growth", icon: "🪱", pick: (k) => [k.rootGeo, k.brambleMat] },
  { id: "creeper", label: "Creeper", group: "Growth", icon: "🍀", pick: (k) => [k.creeperGeo, k.vineMat] },

  // ---- light & fx ---------------------------------------------------------
  { id: "flame-warm", label: "Warm flame", group: "Light & FX", icon: "🔥", pick: (k) => [k.flameGeo, k.flameWarm] },
  { id: "flame-blue", label: "Blue flame", group: "Light & FX", icon: "💙", pick: (k) => [k.flameGeo, k.flameBlue] },
  { id: "flame-red", label: "Red flame", group: "Light & FX", icon: "🩸", pick: (k) => [k.flameGeo, k.flameRed] },
  { id: "wisp", label: "Wisp", group: "Light & FX", icon: "✨", pick: (k) => [k.wispGeo, k.wispMat] },
  { id: "ember", label: "Ember", group: "Light & FX", icon: "🟠", pick: (k) => [k.emberGeo, k.emberMat] },
  { id: "rune", label: "Rune", group: "Light & FX", icon: "🔯", pick: (k) => [k.runeGeo, k.runeMat] },
  { id: "portal", label: "Portal", group: "Light & FX", icon: "🌀", pick: (k) => [k.portalGeo, k.portalMat] },
  { id: "beacon", label: "Beacon", group: "Light & FX", icon: "🔆", pick: (k) => [k.beaconGeo, k.beaconMat] },
  { id: "beam-blue", label: "Blue beam", group: "Light & FX", icon: "🔷", pick: (k) => [k.beamGeo, k.beamMatBlue] },
  { id: "beam-warm", label: "Warm beam", group: "Light & FX", icon: "🔶", pick: (k) => [k.beamGeo, k.beamMatWarm] },
  { id: "wall-glow", label: "Wall glow", group: "Light & FX", icon: "🟡", pick: (k) => [k.wallGlowGeo, k.wallGlowMat] },
  { id: "floor-glow", label: "Floor glow", group: "Light & FX", icon: "🟨", pick: (k) => [k.floorGlowGeo, k.floorGlowMat] },
];

interface StreamEntry extends Omit<AssetDef, "build"> {
  url: string;
  glbScale: number;
}

const STREAM_ENTRIES: StreamEntry[] = [
  {
    id: "oracle", label: "Cephalopod oracle", group: "Landmarks", icon: "🐙",
    url: "/assets/abyss/oracle/oracle-render-30k.glb", glbScale: 10.2, scale: 1,
  },
  {
    id: "warden", label: "Oathbound warden", group: "Landmarks", icon: "🗿",
    url: "/assets/abyss/warden/warden-render-30k.glb", glbScale: 9.5, scale: 1,
  },
  {
    id: "warden-rank", label: "Warden (low)", group: "Landmarks", icon: "🪧",
    url: "/assets/abyss/warden/warden-rank-render-8k.glb", glbScale: 6.4, scale: 1,
  },
  {
    id: "dragon-perch", label: "Slate perch", group: "Landmarks", icon: "⛰",
    url: "/assets/abyss/dragon/dragon-slate-perch-qr1k.glb", glbScale: 1, scale: 1,
  },
  {
    id: "dragon", label: "Colossal dragon", group: "Landmarks", icon: "🐉",
    url: "/assets/abyss/dragon/dragon-render-45k-rigged-runtime.glb", glbScale: 8.4, scale: 1,
  },
  {
    id: "sentinel-spear", label: "Sentinel · spear", group: "Landmarks", icon: "🗡",
    url: "/assets/abyss/sentinel/sentinel-spear-render-30k.glb", glbScale: 5.2, scale: 1,
  },
  {
    id: "sentinel-sword", label: "Sentinel · sword", group: "Landmarks", icon: "⚔",
    url: "/assets/abyss/sentinel/sentinel-sword-render-30k.glb", glbScale: 5.2, scale: 1,
  },
];

let catalog: AssetDef[] | null = null;

export function assetCatalog(): AssetDef[] {
  if (catalog) return catalog;
  const kitAssets: AssetDef[] = KIT_ENTRIES.map((entry) => ({
    id: entry.id,
    label: entry.label,
    group: entry.group,
    icon: entry.icon,
    scale: entry.scale ?? 1,
    // Silhouette drawn from the real geometry. Deferred until the palette
    // asks, so the kit is not forced to build during startup.
    thumbnail: () => thumbnailFor(entry.id, entry.pick(getKit())[0]),
    build: () => {
      const [geometry, material, lift] = entry.pick(getKit());
      return kitMesh(geometry, material, lift ?? 0);
    },
  }));
  const streamAssets: AssetDef[] = STREAM_ENTRIES.map((entry) => ({
    id: entry.id,
    label: entry.label,
    group: entry.group,
    icon: entry.icon,
    scale: entry.scale ?? 1,
    build: async () => {
      const source = await loadGlb(entry.url);
      const holder = new THREE.Group();
      holder.add(prepareStreamed(source, entry.glbScale));
      return holder;
    },
  }));
  catalog = [...kitAssets, ...streamAssets];
  return catalog;
}

export function assetById(id: string): AssetDef | undefined {
  return assetCatalog().find((asset) => asset.id === id);
}

/** Palette groups in display order. */
export function assetGroups(): Array<{ title: string; assets: AssetDef[] }> {
  const order = ["Masonry", "Props", "Growth", "Light & FX", "Landmarks"];
  return order.map((title) => ({
    title,
    assets: assetCatalog().filter((asset) => asset.group === title),
  })).filter((entry) => entry.assets.length > 0);
}
