# 会话档生命周期快照冻结（ctx-snap）设计

日期：2026-10-31　分支：dev1　状态：已裁定（用户确认）

## 0. 背景与实测病灶

会话常量快照（SUNSHINE.md 段 + 技能清单 + 记忆引导，`ContextManager.contextSnapshot`）的冻结语义目前只覆盖「同一个运行时存活」窗口。但 GUI 侧会话**没有常驻运行时**：daemon 打开会话 = newSession + attach，运行时本体外每次都新铸（journalId 才是稳定身份，serve/session.ts 装配注释明载）。ContextManager **构造函数是快照刷新点**（重读磁盘）——于是：

- 用户从另一会话往项目里加 skills，切回本会话：重读的快照把新技能清单**烘进前缀**（实测技能段 226→569 token），改动点之后缓存全量失效，命中率 75%→68% 一次性跌落；
- 同口子覆盖 SUNSHINE.md 与**记忆索引**（会话中自动记忆写入后，每次重开该会话前缀即变一次——最高频病灶）；
- serve setMode（plan→acceptEdits 批准续段）中途换运行时同病：快照重读，期间磁盘变更烘进前缀。

这与 2026-10-30 已裁定的「追尾」设计（drift-detector 尾追 `[skills] added` 等 notice 行，前缀零击穿）直接冲突：恢复路径绕过了追尾——变更没走链尾说明行，而是直接重写了前缀清单本体。

## 1. 不变量（唯一裁决规则）

> **同一会话档（journalId）的前缀快照字节，跨运行时重建逐位稳定。**

磁盘上的会话常量变更只能以链尾 notice 追尾进入模型上下文，永远不重写前缀——除非：

- 用户显式刷新：`/init`（写盘者自刷新，现状保留）；
- 压缩成功：本就全量重写 wire，快照同步重建无额外损失（现状保留）。

## 2. journal 行型：`ctx-snap`

```jsonc
{ "t": "ctx-snap",
  "items": [ { "kind": "system", "content": "…" } ],   // 快照条目原样序列化（kind+content 两字段足矣——快照段恒 system/instruction 纯文本）
  "sig": { "skills": "…", "memory": "…", "sunshine": "…" } // 漂移基线签名（与快照同出生、同更新）
}
```

- **单一事实源**：随会话档 journal 同文件落盘，TUI resume 与 daemon attach 同读面；无旁车文件、无孤儿档。
- **出生写**：真新会话构造重建快照后落一条 ctx-snap 行（daemon attach 出生路径 / TUI 出生路径）。
- **更新写（append-only，末行为准）**：`reloadContext()`（压缩成功、`/init`）之后追加新行，旧行自然作废。
- **读面**：journal 归约取**末条** ctx-snap；无行/坏行 = 无档（回退，见 §4）。
- ContextManager 不直接碰 journal：暴露只读观测面 `contextSnapshotView(): ContextItem[]` 与 `snapshotSig()`（或打包为一个 `snapshotExport()`），落行由持有 journal 的宿主（daemon/TUI）经既有接线完成——上下文门面与持久化层零反向依赖（D25 接缝纪律）。

## 3. 基线随快照走（DriftDetector）

- `DriftDetector` 基线改为**可注入**：恢复路径用落档 `sig`；缺省（真新会话构造）维持从磁盘取（现行为）。
- 追尾消费点**全部不变**：`appendInstructionLine` 每条消息检出磁盘 vs 基线 diff → notice 行落链尾 → 基线前进。恢复后首次提交一次性检出全部离场变更；「切回只看不发消息」零模型调用零成本。
- sig 内容与现基线逐一同构：skills=id+name+description JSON 行排序串；memory=索引文本；sunshine=现基线口径（sunshine 段文本或其 hash，随现实现）。

## 4. 恢复路径收口（三个口子一个闸）

统一闸门：**运行时换铸后拿到落档快照就走「回种」而非「重读」**。

- `ContextManager.restoreSnapshot(items, sig)`：直注入快照条目与基线，不触发订阅——与 `restoreSession`/`restoreCompacted` 同族同构（回种期日志是读方）。
- **daemon attach**：读末条 ctx-snap → `restoreSnapshot`；无行/坏行/条目形态不合法 → 回退现行为（磁盘重读 + 出生写新行）——坏档永不阻断恢复。
- **TUI `--continue` / resume**：同款（同 journal 文件）。
- **serve setMode / planFlow 批准续段**：换运行时后从**旧运行时** `contextSnapshotView()` 内存直取回种（不经 journal 一圈）——同一会话中途换铸字节稳定。

## 5. 场景影响裁定

| 场景 | 裁定 |
|---|---|
| GUI 切回/重开（attach） | 复用落档快照；首条提交追尾离场变更 |
| TUI `--continue` / resume | 同上 |
| 压缩成功 | `reloadContext()` 现状保留；重建后追加新 ctx-snap 行（基线随之对齐——drift 不重复报已进快照的改动） |
| `/init` | 写盘者显式刷新现状保留；同上落新行 |
| fork / 子智能体（spawn） | **零基线推进**（钉死防回归）：子 Reactor 走 seedHistory 装配，不触 `appendInstructionLine`、不消费 drift、不改基线——现状已如此，spec 化 + 测试钉 |
| teammate（taskboard） | 自有 ContextManager 独立出生快照，独立会话独立缓存；若其接 journal 则同款落行，无 journal 维持内存态（现状） |
| `/new` | 真新会话：清空快照+重新出生写（现 resetSession 路径自然覆盖） |
| `/init` 之外的盘中改盘 | 不重读、不追尾时机前移；等下次 `appendInstructionLine` 检出 |

## 6. 明确不做（YAGNI）

- 不做「attach 时刻立即追尾」——不发消息就没有模型调用，追尾无收益；首条提交才检出（现机制天然如此）。
- 不做快照版本迁移——journal v3 零兼容口径沿用，无行即回退磁盘重读。
- 不改 GUI——纯 daemon/TUI 侧语义，前端零感知。
- 不动 MCP 漂移（mcpReady 每轮读盘落 notice，本就是追尾面，与本设计正交）。

## 7. 验证口径

**单测**（全部离线、`node --test`）：
1. 出生写行 → 会话中改 skills → 新铸运行时 attach 恢复 → 快照字节与前缀逐位相等（不重读磁盘）→ 首条提交链尾出 `[skills] added`（且仅一次）；
2. 无 ctx-snap 行（旧档/被 truncate）→ 回退磁盘重读 + 出生写新行；
3. 坏行（items 非/条目形态不合法）→ 同上回退，不阻断恢复；
4. setMode 换铸：旧运行时快照回种，前缀字节稳定；
5. 压缩成功后新行覆盖末条语义（归约取末条）；
6. `/init` 后新行落档、基线对齐（不重复报已进快照的改动）;
7. fork 全程零基线推进（子链跑完父基线不变）。

**实测验收**：另一会话加 skills → 切回本会话 → 首条消息后缓存命中率不因前缀变化跌落（仅追尾增量），技能信息经链尾 notice 进入且模型可引用。

## 8. 风险与回退

- 快照落档后「会话档内快照永不翻新」可能让模型长期看旧清单——追尾 notice 已补足增量信息；`/init` 与压缩是合法翻新口。
- 回退开关：无（行为收敛，非开关型特性）；出问题按 §7-2/3 回退路径即旧行为。
