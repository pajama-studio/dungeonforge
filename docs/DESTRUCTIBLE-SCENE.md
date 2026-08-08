# Dungeonforge 全场景可破坏架构

## 结论

不要为每块砖、每根柱、每件装饰常驻一个刚体。性能最好的方案是混合架构：

1. 完整场景继续用分区实例化与表面剔除渲染。
2. 每个可破坏元素只有轻量 `DestructibleId + damage/support metadata`。
3. 命中后只把受影响的局部结构从静态实例池“激活”为少量刚体簇。
4. Rapier/WASM 负责会影响玩法的刚体簇；WebGPU compute 负责数量大但不影响玩法的视觉碎片。
5. 休眠的刚体重新烘焙成静态 rubble 实例，释放物理对象。

这意味着“全场景都可破坏”，但不是“全场景每一帧都在跑物理”。

## 数据分层

### 1. 静态 GPU Scene

每个 streaming slot 划分为约 `16×16×8` 个结构单元，保存：

- 可见表面实例；内部砖仍不提交。
- 稳定的 `DestructibleId = slot/type/localIndex/generation`。
- alive bit、damage、fracture template、material strength。
- 紧凑的 collider occupancy/height atlas。
- 结构支撑节点与相邻边。

完整状态继续使用当前 InstancedMesh/固定容量池。后续若绕开 Three 的提交层，可升级为 GPU compaction + indirect draw，但数据模型不需要重做。

### 2. 结构支撑图

墙、柱、楼板、桥、楼梯和大型道具是结构节点；“由下方承重”“侧向咬合”“吊挂”是带强度的边。一次破坏只从受损节点做有界 flood-fill：

- 仍连接 foundation/anchor 的分量保持静态。
- 失去支撑的小分量激活为一个 compound rigid body。
- 过大的失稳分量按预制 fracture seam 分割，不逐砖激活。

节点删除不适合只用 union-find；采用按 chunk 的局部 BFS/DFS，Rust/WASM 很适合做这部分确定性计算。

### 3. 双层物理

玩法物理使用 Rapier/WASM：

- 门、箱子、敌人、断桥、大块墙体和可压伤角色的碎块。
- 只保留相机/玩家附近的 active islands。
- 大块使用 convex hull 或 compound boxes，不使用动态 triangle mesh。
- 硬上限建议 256–512 个 awake body；每帧最多激活 16–32 个 cluster。

视觉物理使用 WebGPU compute：

- 砖屑、木屑、灰尘、叶片、火星和小石子。
- 查询静态 occupancy/height texture；不与每一片碎屑做两两碰撞。
- 固定容量 2K–8K，环形复用；越过预算优先减少寿命与小碎片。
- 睡眠后写入静态 rubble 实例，或在不可见时回收。

不建议把全部刚体物理放 GPU：支撑图、角色伤害、导航和存档都需要 CPU 权威状态，GPU readback 会抵消收益，而且浏览器 WebGPU 的 binding/设备上限差异明显。

## 一次命中的数据流

1. BVH/instance ray query 得到 `DestructibleId`。
2. damage event 修改局部 damage field，并隐藏或替换完整实例。
3. Rust/WASM 只重算该 chunk 的支撑分量。
4. 失稳 cluster 从静态池移出，创建少量 Rapier body。
5. 同一事件向固定 GPU debris pool 写入视觉碎片命令。
6. 立即添加保守 nav blocker；后台重建受影响的 nav tile。
7. 刚体休眠后烘焙为静态 rubble，销毁 body/collider。
8. 保存时只记录 seed + destruction event log/bitset，不序列化整个场景。

## “所有元素”的破坏语义

- 墙/柱/楼板/桥/楼梯：结构 damage、支撑坍塌、局部 nav 重建。
- 门/箱子/祭坛：预制 fracture state + 少量 gameplay rigid bodies。
- 敌人：角色物理和受击系统，不进入建筑支撑图。
- 植被/旗帜/绳索：切断 attachment 后使用简化链或直接 GPU 碎片。
- 火焰/光束/烟雾：破坏对应 emitter/anchor，不生成刚体。
- 血迹/苔藓/污痕：擦除、烧焦或被瓦砾覆盖，只修改 decal alive bit。
- 地板：先生成洞口 blocker，再局部重建导航；关键路径可由游戏规则限制承重完全失效。

## 当前实现与下一阶段

当前 GPU debris 已有固定 768 容量、真实 WalkMap 地面采样、尺寸接触、有限地面区域、重力、反弹、摩擦与休眠。碎片与原砖共用同一个程序化石材工厂（手绘噪声、灰浆、磨损、坑蚀、裂纹、浮雕法线与 Lambert 光照），并复制被击中实例的实际颜色；非均匀缩放和翻滚会同步修正法线。

浏览器 24 次破坏回归得到 270 个碎片、22 组继承色、2 个真实通路破口，材质/颜色继承率 100%，GPU validation error 与实例缓冲越界均为 0。同一次点击的直击和联动倒塌会合并成一个 command transaction，并只上传环形池的修改范围：本次样本从整 buffer 等价的 1,400,832 B 降至 20,520 B，减少 98.54%。按碎片逐次 dirty 的旧路径等价 1,350 次标记，当前为 120 次。

建议按以下顺序施工：

1. 建立统一 `DestructibleRegistry`，让建筑、道具、植被和 emitter 都有稳定 ID。
2. 引入 Rapier，只激活箱子、门和一个墙体 cluster，验证双层物理生命周期。
3. 为每个 slot 生成支撑图和 occupancy atlas，先覆盖墙、柱、桥与楼板。
4. 加入 active-body budget、休眠烘焙、事件日志和局部 nav tile。
5. 最后再做大范围连锁坍塌、火焰/酸液材质 damage 和敌人物理交互。
