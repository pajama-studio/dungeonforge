// Build the runtime player asset from the untouched CC0 source GLB. KayKit's
// distribution contains 95 clips; Dungeonforge uses four. Removing the other
// ~10k animation accessors cuts both transfer and, more importantly, GLTF JSON
// parse/normalization work on the browser main thread.

import { readFileSync, writeFileSync } from "node:fs";

const sourcePath = "public/assets/skeleton.glb";
const outputPath = "public/assets/skeleton-game.glb";
const keepClips = new Set([
  "Idle",
  "Running_A",
  "Walking_A",
  "1H_Melee_Attack_Slice_Horizontal",
]);

const source = readFileSync(sourcePath);
if (source.readUInt32LE(0) !== 0x46546c67 || source.readUInt32LE(4) !== 2) {
  throw new Error(`${sourcePath} is not a glTF 2.0 binary`);
}
const jsonLength = source.readUInt32LE(12);
const json = JSON.parse(source.subarray(20, 20 + jsonLength).toString("utf8").trim());
const binHeader = 20 + jsonLength;
if (source.readUInt32LE(binHeader + 4) !== 0x004e4942) throw new Error("GLB has no BIN chunk");
const binLength = source.readUInt32LE(binHeader);
const bin = source.subarray(binHeader + 8, binHeader + 8 + binLength);

json.animations = (json.animations ?? []).filter((animation) => keepClips.has(animation.name));
if (json.animations.length !== keepClips.size) {
  throw new Error(`Expected ${keepClips.size} runtime clips, found ${json.animations.length}`);
}

const componentCount = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const readAccessor = (accessorIndex) => {
  const accessor = json.accessors[accessorIndex];
  if (accessor.componentType !== 5126 || accessor.sparse) return null;
  const view = json.bufferViews[accessor.bufferView];
  const components = componentCount[accessor.type];
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? components * 4;
  const rows = [];
  for (let index = 0; index < accessor.count; index++) {
    const row = [];
    for (let component = 0; component < components; component++) {
      row.push(bin.readFloatLE(offset + index * stride + component * 4));
    }
    rows.push(row);
  }
  return rows;
};
const bindValue = (channel) => {
  const node = json.nodes[channel.target.node] ?? {};
  if (channel.target.path === "translation") return node.translation ?? [0, 0, 0];
  if (channel.target.path === "rotation") return node.rotation ?? [0, 0, 0, 1];
  if (channel.target.path === "scale") return node.scale ?? [1, 1, 1];
  return null;
};
const equals = (a, b, epsilon = 1e-5) =>
  a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) <= epsilon);
let removedBindPoseChannels = 0;
for (const animation of json.animations) {
  const samplers = [];
  const samplerMap = new Map();
  const channels = [];
  for (const channel of animation.channels ?? []) {
    const sampler = animation.samplers[channel.sampler];
    const output = readAccessor(sampler.output);
    const bind = bindValue(channel);
    if (output && bind && output.every((row) => equals(row, bind))) {
      removedBindPoseChannels++;
      continue;
    }
    let samplerIndex = samplerMap.get(channel.sampler);
    if (samplerIndex === undefined) {
      samplerIndex = samplers.length;
      samplerMap.set(channel.sampler, samplerIndex);
      samplers.push(sampler);
    }
    channels.push({ ...channel, sampler: samplerIndex });
  }
  animation.samplers = samplers;
  animation.channels = channels;
}

const usedAccessors = new Set();
for (const mesh of json.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
  if (primitive.indices !== undefined) usedAccessors.add(primitive.indices);
  for (const accessor of Object.values(primitive.attributes ?? {})) usedAccessors.add(accessor);
  for (const target of primitive.targets ?? []) {
    for (const accessor of Object.values(target)) usedAccessors.add(accessor);
  }
}
for (const skin of json.skins ?? []) {
  if (skin.inverseBindMatrices !== undefined) usedAccessors.add(skin.inverseBindMatrices);
}
for (const animation of json.animations) for (const sampler of animation.samplers ?? []) {
  usedAccessors.add(sampler.input);
  usedAccessors.add(sampler.output);
}

const accessorMap = new Map();
const accessors = [];
for (let oldIndex = 0; oldIndex < (json.accessors ?? []).length; oldIndex++) {
  if (!usedAccessors.has(oldIndex)) continue;
  accessorMap.set(oldIndex, accessors.length);
  accessors.push(json.accessors[oldIndex]);
}
const remapAccessor = (index) => {
  const mapped = accessorMap.get(index);
  if (mapped === undefined) throw new Error(`Dropped live accessor ${index}`);
  return mapped;
};
for (const mesh of json.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
  if (primitive.indices !== undefined) primitive.indices = remapAccessor(primitive.indices);
  for (const key of Object.keys(primitive.attributes ?? {})) {
    primitive.attributes[key] = remapAccessor(primitive.attributes[key]);
  }
  for (const target of primitive.targets ?? []) for (const key of Object.keys(target)) {
    target[key] = remapAccessor(target[key]);
  }
}
for (const skin of json.skins ?? []) {
  if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = remapAccessor(skin.inverseBindMatrices);
}
for (const animation of json.animations) for (const sampler of animation.samplers ?? []) {
  sampler.input = remapAccessor(sampler.input);
  sampler.output = remapAccessor(sampler.output);
}
json.accessors = accessors;

const usedViews = new Set();
for (const accessor of accessors) {
  if (accessor.bufferView !== undefined) usedViews.add(accessor.bufferView);
  if (accessor.sparse) {
    usedViews.add(accessor.sparse.indices.bufferView);
    usedViews.add(accessor.sparse.values.bufferView);
  }
}
for (const image of json.images ?? []) {
  if (image.bufferView !== undefined) usedViews.add(image.bufferView);
}

const viewMap = new Map();
const bufferViews = [];
const chunks = [];
let byteOffset = 0;
for (let oldIndex = 0; oldIndex < (json.bufferViews ?? []).length; oldIndex++) {
  if (!usedViews.has(oldIndex)) continue;
  const old = json.bufferViews[oldIndex];
  const padding = (4 - (byteOffset & 3)) & 3;
  if (padding) { chunks.push(Buffer.alloc(padding)); byteOffset += padding; }
  const start = old.byteOffset ?? 0;
  const data = bin.subarray(start, start + old.byteLength);
  const next = { ...old, buffer: 0, byteOffset };
  viewMap.set(oldIndex, bufferViews.length);
  bufferViews.push(next);
  chunks.push(data);
  byteOffset += data.length;
}
const remapView = (index) => {
  const mapped = viewMap.get(index);
  if (mapped === undefined) throw new Error(`Dropped live bufferView ${index}`);
  return mapped;
};
for (const accessor of accessors) {
  if (accessor.bufferView !== undefined) accessor.bufferView = remapView(accessor.bufferView);
  if (accessor.sparse) {
    accessor.sparse.indices.bufferView = remapView(accessor.sparse.indices.bufferView);
    accessor.sparse.values.bufferView = remapView(accessor.sparse.values.bufferView);
  }
}
for (const image of json.images ?? []) {
  if (image.bufferView !== undefined) image.bufferView = remapView(image.bufferView);
}
json.bufferViews = bufferViews;

let packedBin = Buffer.concat(chunks);
const binPadding = (4 - (packedBin.length & 3)) & 3;
if (binPadding) packedBin = Buffer.concat([packedBin, Buffer.alloc(binPadding)]);
json.buffers = [{ byteLength: packedBin.length }];

let packedJson = Buffer.from(JSON.stringify(json));
const jsonPadding = (4 - (packedJson.length & 3)) & 3;
if (jsonPadding) packedJson = Buffer.concat([packedJson, Buffer.alloc(jsonPadding, 0x20)]);
const totalLength = 12 + 8 + packedJson.length + 8 + packedBin.length;
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(totalLength, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(packedJson.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4);
const binaryHeader = Buffer.alloc(8);
binaryHeader.writeUInt32LE(packedBin.length, 0);
binaryHeader.writeUInt32LE(0x004e4942, 4);
writeFileSync(outputPath, Buffer.concat([header, jsonHeader, packedJson, binaryHeader, packedBin]));

console.log(JSON.stringify({
  sourcePath,
  outputPath,
  sourceBytes: source.length,
  outputBytes: totalLength,
  reductionPercent: +(100 * (1 - totalLength / source.length)).toFixed(1),
  animations: json.animations.map((animation) => animation.name),
  animationChannels: json.animations.reduce((sum, animation) => sum + animation.channels.length, 0),
  removedBindPoseChannels,
  accessors: json.accessors.length,
  bufferViews: json.bufferViews.length,
}, null, 2));
