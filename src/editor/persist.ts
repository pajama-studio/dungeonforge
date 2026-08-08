// Save / load / export for an edited dungeon. The document is deliberately
// tiny: an asset id plus a transform per placement, and the generator params.
// Geometry is never serialized — it is rebuilt from the same catalog, so a
// save stays valid as long as the asset ids do.

import type { Params } from "../gen/dungeon";
import type { PlacementRecord, SceneDocument } from "./types";

const STORAGE_KEY = "dungeonforge.editor.scene.v1";

export function buildDocument(
  seed: number,
  mode: string,
  params: Params,
  placements: PlacementRecord[],
): SceneDocument {
  // Only plain scalars: the optional half of Params is per-block state owned
  // by the orchestrator and must not be frozen into a user's save.
  const plain: Record<string, number | string | boolean> = {};
  for (const [key, value] of Object.entries(params)) {
    const t = typeof value;
    if (t === "number" || t === "string" || t === "boolean") {
      plain[key] = value as number | string | boolean;
    }
  }
  return { version: 1, seed, mode, params: plain, placements };
}

export function saveLocal(doc: SceneDocument): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
  } catch (error) {
    console.warn("[editor] could not persist scene", error);
  }
}

export function loadLocal(): SceneDocument | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SceneDocument;
    return isDocument(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearLocal(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function exportFile(doc: SceneDocument): void {
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `dungeon-${doc.seed}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function importFile(): Promise<SceneDocument | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      file.text()
        .then((text) => {
          const parsed = JSON.parse(text) as SceneDocument;
          resolve(isDocument(parsed) ? parsed : null);
        })
        .catch(() => resolve(null));
    });
    input.click();
  });
}

function isDocument(value: unknown): value is SceneDocument {
  if (!value || typeof value !== "object") return false;
  const doc = value as Partial<SceneDocument>;
  return doc.version === 1
    && typeof doc.seed === "number"
    && Array.isArray(doc.placements)
    && doc.placements.every(isPlacement);
}

function isPlacement(value: unknown): value is PlacementRecord {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<PlacementRecord>;
  return typeof p.uid === "string"
    && typeof p.assetId === "string"
    && isTriple(p.position) && isTriple(p.rotation) && isTriple(p.scale);
}

function isTriple(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((n) => Number.isFinite(n));
}
