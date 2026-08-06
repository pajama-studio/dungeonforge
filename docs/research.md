# 研究:3D 石造迷宫要塞型 Dungeon 的程序化生成

> 2026-08-06 · 四路并行调研的综合(经典算法 / 3D 竖直性 / 业界管线 / 渲染技术)。
> 目标画面:夜景等距视角的多层石迷宫要塞 —— 厚墙迷宫、可走墙顶、大阶梯、
> 后方高台神殿、圆形法阵广场、高塔、火把 + 蓝旗、深渊雾气、红光密室。

## 一、结论先行

这类 dungeon 在业界**没有单一算法**,所有成熟系统都是**分层 pipeline(先抽象后细化)**:

```
宏观拓扑(图)→ 高度分层(tier 场)→ 平面布局(迷宫/房间)→
连通性保证(楼梯/桥)→ 模块化拼装(marching-squares → 3D kit)→
装饰规则(火把/旗帜/变体替换)→ 渲染(instancing + bloom + 雾)
```

针对这张图,证据最强的配方是:

- **平面**:Nystrom 式 rooms-and-mazes(growing-tree 迷宫 + braiding 环路 + 厚墙 tile 网格)——
  密集迷宫感的精确匹配;Diablo 式房间散布(TinyKeep)产出的是稀疏房间群,不是这种。
- **竖直**:高度场量化成离散 tier + 「相邻差 ≤1」平滑规则(SC2 悬崖 / Tivolt terracing),
  分层 connected-component 图 + 生成树选边放楼梯,BFS 验收(标准配方)。
- **地标**:图层面先定(Unexplored 原则)—— 神殿(weenie)、法阵、高塔、桥都是先在
  抽象图上决定位置与连接关系,再落到几何;**先挖峡谷再找桥位是反模式**。
- **拼装**:tile 网格 → 邻域 case-table(Diablo 1 的 marching-squares 思路)选 3D 模块,
  instancing 渲染;Bad North 的「tile 自带可行走性元数据」是楼梯正确性的最强保证。
- **渲染**:three.js WebGPU + TSL —— MRT emissive bloom、`scene.fogNode` 高度雾、
  billboarding TSL 火焰、AgX tone mapping、per-instance AO 染色。

## 二、算法家族对比(何时用什么)

| 家族 | 产出形态 | 连通性 | 与本图匹配度 | 角色 |
|---|---|---|---|---|
| 迷宫(growing-tree)+ braid + 房间 | 密走廊、厚墙 | 构造保证 | **精确匹配** | 平面主生成器 |
| 高度场量化 + 楼梯修复 | 台地、悬崖、坡道 | BFS 修复保证 | **精确匹配**(竖直) | 竖直主生成器 |
| TinyKeep 散布+Delaunay+MST | 有机房间群+宽走廊 | MST 保证 | 低(太稀疏) | 不用;但其「图作为一等公民」思想保留 |
| BSP | 直角楼层平面 | 树保证 | 中 | 可选做特殊房间分区 |
| 元胞自动机 | 有机洞穴 | 需修复 | 低 | 只做「坍塌区」点缀 |
| Cyclic generation(Dormans) | 有设计感的环路+锁钥 | 构造保证 | 拓扑层适用 | 简化版:直接生成 1 大环+嵌套小环 |
| WFC / Model Synthesis | 局部一致的 tile | **不保证** | 拼装层适用 | 只做 detailer,不做 designer(Caves of Qud 教训) |

关键参考:
- 迷宫 braiding:死胡同按比例打通(p≈0.3–0.6),是「烦人迷宫 ↔ 有墙竞技场」的调节旋钮
- Bob Nystrom [Rooms and Mazes](http://journal.stuffwithstuff.com/2014/12/21/rooms-and-mazes/):
  先放房间→迷宫填缝→区域间开门→剪死胡同,正是「石造要塞房间嵌在密迷宫里」
- Boris the Brave 的 [Diablo 1](https://www.boristhebrave.com/2019/07/14/dungeon-generation-in-diablo-1/) /
  [Unexplored](https://www.boristhebrave.com/2021/04/10/dungeon-generation-in-unexplored/) /
  [Gungeon](https://www.boristhebrave.com/2019/07/28/dungeon-generation-in-enter-the-gungeon/) 三篇是必读
- 竖直性圣经:Bad North(EPC2018 talk)—— 每个 tile 携带「可从哪进哪出」元数据,
  WFC collapse 过程中始终保持已观察区域可导航;楼梯只是「低边可走↔高边可走」的普通 tile
- 楼梯修复标准配方:flood-fill 分 tier 组件 → 组件图 → 生成树(+环边)→ 沿 tier 差=1 的
  边界放楼梯(**两端都要验证落在可走格上**)→ 从入口 BFS 全图验收,失败重掷派生 seed

## 三、业界管线的共同收敛点

1. **先抽象后艺术**(Diablo 的 predungeon → tile 选择两段式;Gungeon 的 flow 图 → 房间模板)
2. **随机组合、手工授权件**(D3/D4 大势:tile 是手作的,算法只负责摆放;装饰是可切换的
   数据层 —— theme = data, geometry = shared)
3. **变体替换防平铺感**(Diablo 1:同款变体禁止相邻;LDtk auto-layer 规则式贴花)
4. **火把 = 沿墙走格 + 最小间距(Chebyshev ≥4~5)+ 跳过门口**;gpulab dungeon 已实现过
   空间哈希版本(`src/gpulab/dungeon/generate.ts`),直接复用思路
5. **Weenie 原则**(迪士尼):一座比一切都高、灯光独特的地标统摄构图 —— 即本图的神殿;
   生成时最特殊节点最先定,装饰密度向它爬升
6. 距离场(BFS from entrance)同时服务:难度曲线、语义房间(入口/宝藏/boss)、装饰密度

## 四、渲染配方(three.js 0.185 WebGPU + TSL)

- **Bloom**:MRT emissive bloom(`scenePass.setMRT({output, emissive})` → `bloom(emissiveTex)`)——
  只有 emissive 通道进 bloom,火焰/法阵/门户发光,沙岩石墙不发光,无需调阈值
- **雾**:`scene.fogNode` = 高度雾 + `triNoise3D` 扰动(官方 `webgpu_custom_fog` 例子就是
  「低洼积雾」),零 draw call 覆盖全场景;峡谷再叠 2–3 层滚动噪声雾面片 + 少量 billboard 雾团
- **火焰**:官方 `webgpu_tsl_vfx_flames` 配方 —— sprite + `billboarding()` + cellular 噪声上滚
  + 梯度 ramp(夜火把橙:`#1a0500→#7a2000→#ff7b24→#ffd9a0→#fff6e0`),颜色走 emissiveNode
- **灯光预算**:1 盏投影方向光(冷月光)+ 火把用 nearest-N 真实 PointLight 池(6–12 盏,
  不投影)+ 其余纯 emissive;进阶可用 `ClusteredLightsNode`(Forward+,上千盏)
- **闪烁**:2–3 个互质频率正弦 + 噪声,per-torch 相位 = `hash(instanceIndex)`
- **Instancing**:同一几何 → InstancedMesh;多几何共材质(整套石件 kit)→ BatchedMesh 一次
  draw;per-instance 色用 `setColorAt`(WebGPU 下可用)或 TSL `hash(instanceIndex)`
- **AO**:方块场景最优解是**构建期烘焙 per-instance AO 染色**(Minecraft 式邻域遮蔽分数
  乘进 colorNode)—— 比 GTAO 稳定且更「手绘」;GTAO+TRAA 可后期再加
- **调色**:AgX tone mapping(蓝色高光不偏紫,优于 ACES)+ 夜景曝光 ~0.5;emissive 强度
  10×+ 当作光照数据;暖近冷远双色雾;vignette
- **旗帜**:平面 20×30 段,TSL positionNode 双正弦位移,`uv.y` 权重钉住挂杆边
- **法阵**:极坐标 SDF(同心环 smoothstep + 角向分段 hash 断环 + 倒数辉光),emissiveNode 蓝/金

## 五、值得研究的开源参照

- [majidmanzarpour/threejs-procedural-dungeon](https://github.com/majidmanzarpour/threejs-procedural-dungeon) — 最接近的现成参照(确定性 seed、五主题、instancing、bloom+tilt-shift)
- [felixturner hex-map-wfc](https://felixturner.github.io/hex-map-wfc/article/) — three.js WFC 生产级写作:BatchedMesh 2 draw call、WebGPU/TSL、分块求解
- [marian42 infinite WFC city](https://marian42.de/article/wfc/) — 3D WFC 垂直 connector 机制 + 分块无限生成
- [Vazgriz 3D dungeon](https://vazgriz.com/119/procedurally-generated-dungeons/) — TinyKeep 3D 化 + A* 楼梯
- [BorisTheBrave/DeBroglie](https://github.com/BorisTheBrave/DeBroglie) — 带全局路径约束的 WFC(C#,思路可移植)
- 本 repo 内:`src/gpulab/dungeon/generate.ts` — 已有的确定性平面 dungeon 生成器(RNG/火把间距/BFS 距离场可复用)

## 六、针对本图的推荐架构(dungeonforge v1)

```
seed
 └─ 1. 宏观图:入口(南)→ 神殿(北,最高)critical path + 1-2 环;
        地标节点:神殿、法阵×2(蓝/金)、高塔、红光密室、峡谷+桥
 └─ 2. tier 场:fbm 噪声量化 0..4 + 神殿方向 mound(+2..3,ziggurat 台阶式)
        + 「相邻 maze cell 差 ≤1」钳制(BFS 携带式赋值)
 └─ 3. 平面:growing-tree 迷宫(newest/random ≈ 0.7/0.3)铺满 → braid p≈0.4
        → 地标区域清墙(法阵圆、神殿平台、红房)→ 峡谷按图挖 + 桥先定后挖
 └─ 4. 连通:楼梯 = tier 差 1 的开口格(两端验证);flood-fill 全图 BFS 验收,
        断连则在组件边界开楼梯修复;失败 re-roll 派生 seed(≤5 次)
 └─ 5. 拼装:邻域 case-table → 石块砌层(墙体/垛口/楼梯/塔/ziggurat)
        → 变体替换(色相/亮度抖动,禁相邻同款)→ 火把/旗帜/braziers 规则布置
 └─ 6. 渲染:BatchedMesh/InstancedMesh + baked per-instance AO
        + MRT emissive bloom + fogNode 高度雾 + TSL 火焰/旗帜/法阵 + AgX
```

纯数据生成器(零 THREE 依赖)+ 确定性 seed + vitest 不变量测试(连通性/楼梯合法/checksum),
与 repo 现有 gpulab dungeon 的工程风格一致。
