const pages = await (await fetch("http://127.0.0.1:9337/json/list")).json();
const page = pages.find((entry) => entry.type === "page" && entry.url.includes("127.0.0.1:4173"));
if (!page) throw new Error("Dungeonforge page not found");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let id = 0;
const pending = new Map();
const errors = [];
const frameBlocks = [];
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Runtime.exceptionThrown") {
    const details = message.params.exceptionDetails;
    errors.push(details.exception?.description ?? details.text);
  }
  if (message.method === "Runtime.consoleAPICalled") {
    const text = message.params.args.map((arg) => arg.value ?? arg.description).join(" ");
    if (["error", "warning"].includes(message.params.type)) errors.push(text);
    if (text.includes("[frame] render() blocked")) frameBlocks.push(text);
  }
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const requestId = ++id;
  pending.set(requestId, { resolve, reject });
  ws.send(JSON.stringify({ id: requestId, method, params }));
});
await call("Runtime.enable");
await call("Page.enable");
await call("Page.bringToFront");
if (!process.argv.includes("--no-nav")) {
  const clustered = process.argv.includes("--clustered") ? "&clustered=1" : "";
  await call("Page.navigate", { url: `http://127.0.0.1:4173/?seed=359139884&gen=typescript&islands=8&dragonDebug=${Date.now()}${clustered}` });
  await new Promise((resolve) => setTimeout(resolve, 14500));
  errors.length = 0;
  frameBlocks.length = 0;
}
let gizmoSmoke = null;
if (process.argv.includes("--gizmo-smoke")) {
  const smoke = await call("Runtime.evaluate", {
    expression: `(async () => {
      const api = window.__df?.dragonPlacement;
      if (!api) return { available: false };
      const before = api.getOffset();
      await api.setActive(true);
      api.setOffset(before.x + 2, before.y + 1, before.z - 3);
      const moved = api.getOffset().toArray();
      api.setOffset(before.x, before.y, before.z);
      return {
        available: true,
        before: before.toArray(),
        moved,
        restored: api.getOffset().toArray(),
        attached: api.controls.object?.name,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  gizmoSmoke = smoke.result.value;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const result = await call("Runtime.evaluate", {
  expression: `(() => {
    const scene = window.__df?.ctx?.scene;
    const slot = scene?.getObjectByName('streamed-colossal-perched-dragon-slot');
    const dragon = scene?.getObjectByName('tripo-v3.1-colossal-perched-abyss-dragon');
    const perch = scene?.getObjectByName('colossal-dragon-slate-spire')
      ?? scene?.getObjectByName('colossal-dragon-perch-column');
    const skinned = dragon?.getObjectByProperty('isSkinnedMesh', true);
    const legNames = ['fore_left','fore_right','hind_left','hind_right'];
    const bonePositions = skinned && Object.fromEntries(legNames.map(name => {
      const foot = skinned.skeleton.bones.find(bone => bone.name === name + '_foot');
      const upper = skinned.skeleton.bones.find(bone => bone.name === name + '_upper');
      const lower = skinned.skeleton.bones.find(bone => bone.name === name + '_lower');
      const target = skinned.skeleton.bones.find(bone => bone.name === 'ik_' + name + '_target');
      const fp = foot?.getWorldPosition(foot.position.clone());
      const hp = upper?.getWorldPosition(upper.position.clone());
      const kp = lower?.getWorldPosition(lower.position.clone());
      const tp = target?.getWorldPosition(target.position.clone());
      return [name, {
        hip: hp?.toArray(), knee: kp?.toArray(), foot: fp?.toArray(), target: tp?.toArray(),
        hipTarget: hp && tp ? hp.distanceTo(tp) : null,
        chainReach: hp && kp && fp ? hp.distanceTo(kp) + kp.distanceTo(fp) : null,
        error: fp && tp ? fp.distanceTo(tp) : null,
      }];
    }));
    const neckTip = skinned?.skeleton?.bones?.find(bone => bone.name === 'neck_tip');
    const neckTarget = skinned?.skeleton?.bones?.find(bone => bone.name === 'ik_neck_target');
    const neckTipWorld = neckTip?.getWorldPosition(neckTip.position.clone());
    const neckTargetWorld = neckTarget?.getWorldPosition(neckTarget.position.clone());
    return {
      url: location.href,
      ready: { core: window.__df?.coreReady, decor: window.__df?.decorReady },
      gizmo: window.__df?.dragonPlacement && {
        active: document.getElementById('btnDragonGizmo')?.classList.contains('active'),
        panelVisible: document.getElementById('dragonGizmoPanel')?.classList.contains('show'),
        attached: window.__df.dragonPlacement.controls?.object?.name,
        offset: window.__df.dragonPlacement.getOffset().toArray(),
      },
      slot: slot && {
        state: slot.userData.streamState,
        children: slot.children.map(child => child.name),
        visible: slot.visible,
        position: slot.position.toArray(),
        rotationY: slot.rotation.y,
        scale: slot.scale.toArray(),
        ikState: slot.userData.legIkState,
        ikTargets: slot.userData.legIkTargets,
        ikBones: slot.userData.legIkBones,
      },
      dragon: dragon && {
        visible: dragon.visible,
        parent: dragon.parent?.name,
        skinned: Boolean(skinned),
        bounds: (() => {
          const min = [Infinity, Infinity, Infinity];
          const max = [-Infinity, -Infinity, -Infinity];
          dragon.updateWorldMatrix(true, true);
          dragon.traverse((object) => {
            if (!object.isMesh) return;
            if (object.isSkinnedMesh) object.computeBoundingBox();
            else if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
            const box = object.isSkinnedMesh ? object.boundingBox : object.geometry.boundingBox;
            if (!box) return;
            for (let corner = 0; corner < 8; corner++) {
              const point = object.position.clone().set(
                corner & 1 ? box.max.x : box.min.x,
                corner & 2 ? box.max.y : box.min.y,
                corner & 4 ? box.max.z : box.min.z,
              ).applyMatrix4(object.matrixWorld);
              for (let axis = 0; axis < 3; axis++) {
                min[axis] = Math.min(min[axis], point.getComponent(axis));
                max[axis] = Math.max(max[axis], point.getComponent(axis));
              }
            }
          });
          return { min, max };
        })(),
        bones: skinned?.skeleton?.bones?.map(bone => bone.name),
        triangles: skinned?.geometry?.index
          ? skinned.geometry.index.count / 3
          : skinned?.geometry?.getAttribute('position')?.count / 3,
        bonePositions,
        neck: {
          tip: neckTipWorld?.toArray(),
          target: neckTargetWorld?.toArray(),
          error: neckTipWorld && neckTargetWorld ? neckTipWorld.distanceTo(neckTargetWorld) : null,
          authoredTarget: slot?.userData.neckIkTarget,
        },
      },
      perch: perch && {
        visible: perch.visible,
        position: perch.position.toArray(),
        scale: perch.scale.toArray(),
        streamState: perch.userData.streamState,
        renderTriangles: perch.userData.renderTriangles,
        renderVertices: perch.userData.renderVertices,
        surfaceSampler: perch.userData.surfaceSampler,
        geometrySource: perch.geometry?.userData?.source,
        geometryBounds: (() => {
          perch.geometry.computeBoundingBox();
          return {
            min: perch.geometry.boundingBox?.min.toArray(),
            max: perch.geometry.boundingBox?.max.toArray(),
          };
        })(),
        profile: perch.userData.perch,
      },
      resources: performance.getEntriesByType('resource')
        .filter(entry => /dragon|draco/.test(entry.name))
        .map(entry => ({ name: entry.name, duration: entry.duration, transferSize: entry.transferSize })),
      missingColor: (() => {
        const rows = [];
        scene?.traverse(object => {
          if (!object.isMesh || object.geometry?.getAttribute('color')) return;
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          if (materials.some(material => material?.vertexColors)) rows.push(object.name || object.type);
        });
        return rows;
      })(),
    };
  })()`,
  returnByValue: true,
});
console.log(JSON.stringify({ ...result.result.value, gizmoSmoke, errors, frameBlocks }, null, 2));
ws.close();
