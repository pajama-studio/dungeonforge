// Asset thumbnails, drawn from the geometry itself onto a 2D canvas.
//
// The obvious approach — render each asset with the app's renderer into a
// small target — is the wrong trade here. Every asset/camera/lights
// combination is a fresh WebGPU render object (~7 ms of node-graph build
// each, per the slot-pool notes), and this project has already been bitten
// once by an innocuous-looking change that triggered a full pipeline
// rebuild. A CPU rasteriser costs nothing at runtime, needs no device, and
// still shows the one thing a palette tile has to show: the silhouette.

import type * as THREE from "three/webgpu";

const CANVAS = 44;
const cache = new Map<string, string>();

/** Flat-shade the geometry through a fixed three-quarter orthographic view.
 *  Returns a data URL, cached per asset id. */
export function thumbnailFor(id: string, geometry: THREE.BufferGeometry): string | null {
  const cached = cache.get(id);
  if (cached) return cached;

  const position = geometry.getAttribute("position");
  if (!position || position.count === 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS;
  canvas.height = CANVAS;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // A fixed three-quarter view: rotate 35° about Y then tip 25° down, so
  // boxes read as boxes and a column reads as a column.
  const ay = 0.61, ax = 0.44;
  const cosY = Math.cos(ay), sinY = Math.sin(ay);
  const cosX = Math.cos(ax), sinX = Math.sin(ax);
  const project = (x: number, y: number, z: number) => {
    const rx = x * cosY + z * sinY;
    const rz = -x * sinY + z * cosY;
    const ry = y * cosX - rz * sinX;
    const depth = y * sinX + rz * cosX;
    return { x: rx, y: -ry, depth };
  };

  const count = position.count;
  const points = new Array<{ x: number; y: number; depth: number }>(count);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const p = project(position.getX(i), position.getY(i), position.getZ(i));
    points[i] = p;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const spanX = maxX - minX, spanY = maxY - minY;
  const span = Math.max(spanX, spanY, 1e-6);
  const pad = 5;
  const scale = (CANVAS - pad * 2) / span;
  const offsetX = pad + (CANVAS - pad * 2 - spanX * scale) / 2 - minX * scale;
  const offsetY = pad + (CANVAS - pad * 2 - spanY * scale) / 2 - minY * scale;

  // Painter's algorithm: sort faces back-to-front, then fill. At 44px this
  // is indistinguishable from a depth buffer and needs no allocation.
  const index = geometry.getIndex();
  const faceCount = index ? index.count / 3 : count / 3;
  const faces: Array<{ a: number; b: number; c: number; depth: number; shade: number }> = [];
  for (let f = 0; f < faceCount; f++) {
    const a = index ? index.getX(f * 3) : f * 3;
    const b = index ? index.getX(f * 3 + 1) : f * 3 + 1;
    const c = index ? index.getX(f * 3 + 2) : f * 3 + 2;
    const pa = points[a], pb = points[b], pc = points[c];
    if (!pa || !pb || !pc) continue;
    // screen-space winding gives us a free facing term for shading
    const cross = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
    faces.push({
      a, b, c,
      depth: (pa.depth + pb.depth + pc.depth) / 3,
      shade: cross > 0 ? 1 : 0.62,
    });
  }
  if (faces.length === 0) return null;
  faces.sort((l, r) => l.depth - r.depth);

  for (const face of faces) {
    const pa = points[face.a], pb = points[face.b], pc = points[face.c];
    // parchment-on-navy, matching the palette the panel is drawn in
    const tone = Math.round(120 + face.shade * 100);
    ctx.fillStyle = `rgb(${tone}, ${Math.round(tone * 0.94)}, ${Math.round(tone * 0.78)})`;
    ctx.beginPath();
    ctx.moveTo(pa.x * scale + offsetX, pa.y * scale + offsetY);
    ctx.lineTo(pb.x * scale + offsetX, pb.y * scale + offsetY);
    ctx.lineTo(pc.x * scale + offsetX, pc.y * scale + offsetY);
    ctx.closePath();
    ctx.fill();
  }

  const url = canvas.toDataURL("image/png");
  cache.set(id, url);
  return url;
}
