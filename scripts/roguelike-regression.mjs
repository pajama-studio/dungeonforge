// Real-browser roguelike smoke test: enter a run, move, claim a chest relic,
// kill one sentinel, clear/descend a floor and die. Also watches WebGPU errors.

import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const port = Number(args.get("--port") ?? 9337);
const needle = args.get("--url") ?? "127.0.0.1:4173";
const screenshot = args.get("--screenshot");
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((entry) => entry.type === "page" && entry.url.includes(needle));
if (!target) throw new Error(`No page containing ${needle}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let id = 0;
const pending = new Map();
let pageLoadResolve = null;
const gpuErrors = [];
const failures = [];
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Page.loadEventFired") {
    pageLoadResolve?.();
    return;
  }
  if (message.method === "Runtime.consoleAPICalled") {
    const line = message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
    if (/GPUValidationError|Invalid CommandBuffer|Instance range|binding size/i.test(line)) gpuErrors.push(line);
  } else if (message.method === "Log.entryAdded") {
    const line = message.params.entry.text;
    if (/GPUValidationError|Invalid CommandBuffer|Instance range|binding size/i.test(line)) gpuErrors.push(line);
  } else if (message.method === "Runtime.exceptionThrown") failures.push(message.params.exceptionDetails.text);
  if (!message.id) return;
  const job = pending.get(message.id);
  if (!job) return;
  pending.delete(message.id);
  message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const callId = ++id;
  pending.set(callId, { resolve, reject });
  ws.send(JSON.stringify({ id: callId, method, params }));
});

await call("Runtime.enable");
await call("Log.enable");
await call("Page.enable");
const pageLoaded = new Promise((resolve) => { pageLoadResolve = resolve; });
await call("Page.reload", { ignoreCache: true });
await Promise.race([
  pageLoaded,
  new Promise((_, reject) => setTimeout(() => reject(new Error("Page reload timed out")), 15000)),
]);
pageLoadResolve = null;
await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
const evaluated = await call("Runtime.evaluate", {
  expression: `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const press=async(key,code,ms=80)=>{
      dispatchEvent(new KeyboardEvent('keydown',{key,code,bubbles:true}));
      await sleep(ms);
      dispatchEvent(new KeyboardEvent('keyup',{key,code,bubbles:true}));
    };
    const deadline=performance.now()+45000;
    while((!window.__df?.decorReady)&&performance.now()<deadline) await sleep(100);
    if(!window.__df?.decorReady) throw new Error('render did not become ready');
    const df=window.__df;
    await df.startRogueRun();
    const player=df.player;
    if(!player || !df.rogueMode) throw new Error('roguelike did not start');
    const start=player.group.position.clone();
    await press('w','KeyW',500);
    await press('d','KeyD',350);
    dispatchEvent(new KeyboardEvent('keydown',{key:'w',code:'KeyW',bubbles:true}));
    await press('Shift','ShiftLeft',260);
    dispatchEvent(new KeyboardEvent('keyup',{key:'w',code:'KeyW',bubbles:true}));
    const moved=start.distanceTo(player.group.position);

    const actors=df.ctx.actors;
    const chest=actors.chests[0];
    if(!chest) throw new Error('no chest spawned');
    player.group.position.set(chest.x,chest.y,chest.z+0.4);
    const beforeRelic={hp:df.rogue.state.hp,maxHp:df.rogue.state.maxHp,attack:df.rogue.state.attack,shards:df.rogue.state.shards};
    await press('e','KeyE'); await sleep(250);
    const afterRelic={hp:df.rogue.state.hp,maxHp:df.rogue.state.maxHp,attack:df.rogue.state.attack,shards:df.rogue.state.shards};

    const enemy=actors.enemies.find(e=>e.active);
    if(!enemy) throw new Error('no enemy spawned');
    player.group.position.set(enemy.x+0.7,enemy.y,enemy.z);
    const kills0=df.rogue.state.kills;
    for(let i=0;i<6 && df.rogue.state.kills===kills0;i++){ await press(' ','Space'); await sleep(380); }
    const killed=df.rogue.state.kills-kills0;

    const remaining=df.rogue.state.enemiesAlive;
    for(const e of actors.enemies) e.active=false;
    df.rogue.defeat(remaining);
    const reward1=df.rogue.floorChoices()[0];
    df.chooseRogueReward(reward1.kind);
    const exit=df.rogueExit;
    player.group.position.copy(exit);
    await press('e','KeyE');
    const floorDeadline=performance.now()+45000;
    while(df.rogue.state.floor<2 && performance.now()<floorDeadline) await sleep(100);
    const descended=df.rogue.state.floor;
    const floor2Enemies=df.rogue.state.enemiesAlive;
    const remaining2=df.rogue.state.enemiesAlive;
    for(const e of actors.enemies) e.active=false;
    df.rogue.defeat(remaining2);
    const reward2=df.rogue.floorChoices()[1];
    df.chooseRogueReward(reward2.kind);
    const exit2=df.rogueExit;
    player.group.position.copy(exit2);
    await press('e','KeyE');
    const floor3Deadline=performance.now()+45000;
    while(df.rogue.state.floor<3 && performance.now()<floor3Deadline) await sleep(100);
    const floor3Enemies=df.rogue.state.enemiesAlive;
    const floor3Elites=actors.eliteCount;
    const elite=actors.enemies.find(e=>e.active&&e.elite);
    if(!elite) throw new Error('depth 3 Warden not found');
    const wardenShards0=df.rogue.state.shards;
    elite.hp=0.25;
    player.group.position.set(elite.x+0.7,elite.y,elite.z);
    await press(' ','Space'); await sleep(420);
    const wardenBounty=df.rogue.state.shards-wardenShards0;
    const wardensDefeated=df.rogue.state.wardensDefeated;
    df.rogue.takeDamage(9999);
    await sleep(150);
    return {
      moved, relicChanged:JSON.stringify(beforeRelic)!==JSON.stringify(afterRelic),
      beforeRelic, afterRelic, killed, descended, floor2Enemies, floor3Enemies, floor3Elites,
      rewardsChosen:df.rogue.state.rewardsChosen, awaitingReward:df.rogue.state.awaitingReward,
      wardenBounty, wardensDefeated,
      dead:df.rogue.state.dead, hp:df.rogue.state.hp,
      attacksPlayed:player.attacksPlayed,
      playerVisible:player.group.position.y>-500,
      dashes:df.rogueDashes,
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
  timeout: 180000,
});
if (evaluated.exceptionDetails) failures.push(evaluated.exceptionDetails.text);
const result = evaluated.result?.value ?? null;
if (screenshot) {
  const captured = await call("Page.captureScreenshot", { format: "png" });
  mkdirSync(dirname(screenshot), { recursive: true });
  writeFileSync(screenshot, Buffer.from(captured.data, "base64"));
}
const report = { gpuErrors, failures, result };
console.log(JSON.stringify(report));
ws.close();
if (
  gpuErrors.length || failures.length || !result || result.moved < 0.15 ||
  !result.relicChanged || result.killed < 1 || result.descended < 2 ||
  result.floor2Enemies < 1 || result.floor3Enemies < 1 || result.floor3Elites < 1 ||
  result.rewardsChosen < 2 || result.awaitingReward ||
  result.wardenBounty < 1 || result.wardensDefeated < 1 ||
  !result.dead || result.attacksPlayed < 1
  || result.dashes < 1
) process.exitCode = 1;
