import { DRACO_GLTF_CONFIG, DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

/** Three r185 ships content-hashed decoder URLs with the loader itself. Select
 * its smaller glTF-only build explicitly: a string decoder path falls back to
 * a second, manually copied public directory and duplicates 1.8 MB in dist. */
export function createGltfDracoLoader(): DRACOLoader {
  const loader = new DRACOLoader();
  // Vite 6's dependency optimiser currently rewrites Three's relative asset
  // URL to /node_modules/.vite/libs/... in dev, where the SPA fallback returns
  // HTML. Keep the known-good public path for HMR, while production uses the
  // emitted content hash and can omit that public copy from dist.
  return import.meta.env.DEV
    ? loader.setDecoderPath("/draco/gltf/")
    : loader.setDecoderPath(DRACO_GLTF_CONFIG);
}
