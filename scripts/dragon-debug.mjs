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
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
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
if (!process.argv.includes("--no-nav")) {
  const clustered = process.argv.includes("--clustered") ? "&clustered=1" : "";
  await call("Page.navigate", { url: `http://127.0.0.1:4173/?seed=359139884&gen=typescript&islands=8&dragonDebug=${Date.now()}${clustered}` });
  await new Promise((resolve) => setTimeout(resolve, 9000));
}
const result = await call("Runtime.evaluate", {
  expression: `(() => {
    const scene = window.__df?.ctx?.scene;
    const slot = scene?.getObjectByName('streamed-colossal-perched-dragon-slot');
    const dragon = scene?.getObjectByName('tripo-v3.1-colossal-perched-abyss-dragon');
    const perch = scene?.getObjectByName('colossal-dragon-perch-column');
    return {
      url: location.href,
      ready: { core: window.__df?.coreReady, decor: window.__df?.decorReady },
      slot: slot && {
        state: slot.userData.streamState,
        children: slot.children.map(child => child.name),
        visible: slot.visible,
        position: slot.position.toArray(),
        rotationY: slot.rotation.y,
        scale: slot.scale.toArray(),
      },
      dragon: dragon && { visible: dragon.visible, parent: dragon.parent?.name },
      perch: perch && { visible: perch.visible, position: perch.position.toArray() },
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
console.log(JSON.stringify({ ...result.result.value, errors, frameBlocks }, null, 2));
ws.close();
