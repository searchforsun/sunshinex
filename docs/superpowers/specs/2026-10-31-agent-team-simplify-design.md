# 智能体团队简化设计规格（Team / 五态任务机 / 停等重试 / 消息 / GUI）

- **日期**: 2026-10-31
- **状态**: 设计定稿，待用户审阅后进入 implementation plan
- **来源**: 任务板 GUI 与团队语义重构讨论（状态徽标 → 停钮 → 团队实体 → 流程简化）
- **路径裁定**: 方案 1——在现有 TaskBoard 上增加 Team 聚合层；**禁止兼容**（旧状态名、gate/审批、用户气泡队头、双读映射一律删除）
- **关联**: `docs/superpowers/specs/2026-10-04-multi-agent-orchestration-design.md`（本规格对其状态机、gate、卡头聚合做破坏性收敛）

---

## 0. 意图与成功标准

### 0.1 意图

把「智能体团队」收成一条简单主链：先建队（队名 + 系统 `teamId`）→ 成员与任务绑定该队 → 五态任务生命周期 → 可停可等 → 失败/取消后以新 id 重试并在 DAG 上挂 `retryOf` → 成员执行期可互发消息（进上下文 + 转录气泡）。

### 0.2 成功标准

1. 板上只有五态：`pending` | `running` | `success` | `failed` | `cancelled`；无审批/gate/`in-review`。
2. `create_team(name)` 自动生成 `teamId`；`create_teammate` / `create_task` 必带 `teamId`；GUI 一队一卡，卡头为队名。
3. `task_stop` 对 `pending` 与 `running` 均可停，板态一律 `cancelled`；与 GUI 停钮同一条链；`task_wait` 见终态即收口。
4. 重启装载：所有非终态（`pending`+`running`）→ `cancelled`；无盲等、无静默回池重跑。
5. 状态迁移由代码门禁强制；非法迁移明确报错（含 taskId、当前态、目标态、允许去向）。
6. 重试无专用工具：`create_task` + `retryOf`；DAG 区分依赖边与重试边。
7. `send_message` 同队互投；接收方尾追进链；转录气泡带来源智能体名，点击跳转该智能体页。

### 0.3 非目标

- 不为旧 journal / 旧板快照做迁移双读或别名映射。
- 不在队卡内嵌完整聊天窗（消息在转录页）。
- 不改变 Composer 会话 interrupt「只打断当前 run/wait、不改板态」的既有边界。
- 不引入按队切开的多物理板（方案 2）；本规格为一张板 + Team 聚合。

---

## 1. 状态机与停止 / 等待

### 1.1 五态

| 态 | 含义 | GUI |
|----|------|-----|
| `pending` | 已创建，未开始 | 灰点 |
| `running` | 执行中 | 转圈 |
| `success` | 执行成功终态 | 完成色点（现网蓝点语义） |
| `failed` | **当次进程内**执行异常终态 | 红点 |
| `cancelled` | 主动停止、lead/工具取消、或重启自愈 | 黄点 + 标题划线 |

**删除（无兼容、无别名）**: `claimed`、`in-review`、`done`、`gated` / gate 事件、`review_task`、用户审批路径。

### 1.2 合法迁移（`LEGAL` 单表）

```
pending ──派发──► running ──成功──► success
   │                 │
   │                 ├──执行异常──► failed
   │                 └──task_stop──► cancelled
   └──task_stop──► cancelled
```

- 终态无出边；重做 = 新任务 id（见 §3）。
- 所有写状态入口（派发、`finishExecution`、`task_stop`、装载自愈）必须先过 `transitionLegal`；非法迁移 **不静默忽略**，返回明确错误。

### 1.3 `task_stop`（唯一主动终止入口）

| 当前态 | 行为 |
|--------|------|
| `pending` | 直接 → `cancelled` |
| `running` | abort 执行体 / `interruptCurrent` → 回写 `cancelled`；台账 `stopped`；成员本身不消亡 |
| 终态 | 幂等回执当前态，不重复 abort |

- GUI hover 停与模型 `task_stop` 同一条链（daemon 板停接口底层同语义）。
- 不再对外提供与 `task_stop` 分叉的 lead `cancel` 工具；内部若保留方法，仅实现同语义。

### 1.4 重启自愈（防盲等）

装载时：

| 装载时态 | 处理 |
|----------|------|
| `running` | → `cancelled`（execution lost on restart） |
| `pending` | → `cancelled`（no live executors after restart） |
| 终态 | 不动 |

硬约束：

- **禁止**将残留 `running` 静默改回 `pending`。
- 台账孤儿 `running`（异进程）装载 → `stopped`，与板 `cancelled` 对齐。
- 装载后板上不存在可被 `task_wait` 盲等的非终态任务。

### 1.5 `task_wait`

- 终态集合：`success` | `failed` | `cancelled`；任一即返回。
- 重启后旧等待目标若已自愈为 `cancelled`，立即返回；文案标明须 `create_task` 重做（可带 `retryOf`）。
- Composer 会话 interrupt 仍可打断 wait 本身，但不改板任务态。

### 1.6 门禁报错口径（示例）

- `cannot transition task-foo from success to cancelled; terminal state has no outbound edges (allowed: none)`
- `task_stop expects pending|running, got failed`
- `cannot dispatch task-foo: status is cancelled`

---

## 2. Team 实体与绑定

### 2.1 实体

```
Team {
  teamId: string;    // 系统生成，唯一
  name: string;      // 创建时队名；GUI 卡头只显示 name
  createdAt: number;
}
```

成员与任务以 `teamId` 反查，不在 Team 内嵌副本列表为唯一真相（可有投影缓存，写路径仍以任务/成员记录上的 `teamId` 为准）。

### 2.2 工具

| 工具 | 必填 | 规则 |
|------|------|------|
| `create_team` | `name` | 非空；生成并返回 `teamId` |
| `create_teammate` | `teamId` + `name` +（`prompt` \| `agent_id`） | 未知 `teamId` 拒绝；同队成员名撞名拒绝 |
| `create_task` | `teamId` + title/spec… | 未知 `teamId` 拒绝；`dependsOn` / `retryOf` 必须同队 |

会话内 **多队并行**；派发与消息 **队内隔离**。

### 2.3 删除

- 卡头用用户气泡 / `turnGoal` 分批聚合的方式删除。
- 不存在「无队」任务或成员。

### 2.4 报错口径（示例）

- `unknown teamId: …; create a team with create_team first`
- `teammate name already exists on team …`
- `dependsOn task … is not on team …`
- `retryOf task … is not on team …`

---

## 3. `retryOf` 与 DAG

### 3.1 字段

- `BoardTask.retryOf?: string` — 同队被重试的**直接前驱**任务 id。
- **不是** `dependsOn`：不参与派发阻塞。
- `dependsOn`：上游必须全为 **`success`** 才可派发（语义不变）。

### 3.2 创建方式

- 无专用 retry 工具。
- 模型再 `create_task`：新 id、内容可复用、`retryOf: <前驱 id>`、同一 `teamId`。
- 门禁：`retryOf` 未知/跨队 → 报错；`retryOf` 指向非终态 → 拒绝（先停或等终态）。
- 多次重试成链：`A → A1 → A2`（每条 `retryOf` 指直接前驱）。

### 3.3 DAG 渲染

- `dependsOn`：实线依赖边。
- `retryOf`：重试边（虚线或「重试」标注），呈现 `任务A → 任务A(重试)`。
- 一队一图；重试节点布局跟在前驱之后。
- 失败/取消节点保留在图上，便于挂重试。

### 3.4 报错口径（示例）

- `retryOf task-x is still running; stop it or wait for a terminal state first`
- `retryOf task-x does not belong to team …`

---

## 4. 成员消息

### 4.1 行为

- 工具名保持 `send_message`（`to` + `text`）；发送方隐式带当前身份与 `teamId`。
- 收件白名单：同队存活成员 ∪ `lead`；跨队/未知名明确报错。
- fork 子面继续禁止 `send_message`。
- 投递：inbox append-only + 事件投影。
- **进上下文**：接收方（teammate）下一轮 execute 前 drain → **尾追**私有链；只尾追，不改前置段（前缀缓存纪律）。

### 4.2 转录 UI

- 消息在智能体转录页以对话气泡展示。
- 气泡展示来源智能体名称；点击跳转到来源智能体转录页。
- 不在队卡内嵌完整聊天窗。

### 4.3 重启与位点

- inbox 文件可续。
- 消费位点随队友会话快照持久化，避免重启后重复灌同一批进上下文。

### 4.4 报错口径（示例）

- `cannot send_message to x: not a live member of team …`
- `cannot send_message across teams`

---

## 5. GUI

### 5.1 队卡

- 一队一卡；标题 = 团队名称。
- 卡内「列表 | DAG」；只渲染该 `teamId`。
- 成员可以简名出现在卡头次级区；深聊与消息进转录页。

### 5.2 状态点

去掉全部文字状态徽标（失败/已取消/评审中等）。仅用 §1.1 点色与划线。

### 5.3 停止

- 列表行与 DAG 节点：`pending` 与 `running` 均可 hover 出停止图标（与 `task_stop` 一致）。
- 点击 → daemon 板停 → `cancelled`；不可恢复；投影立即同步。

### 5.4 DAG

同 §3.3。

---

## 6. 架构落点（实现导向，非逐步计划）

| 区域 | 主要触及 |
|------|----------|
| 域模型 | `src/taskboard/model.ts` 五态与 `LEGAL`；`BoardTask.teamId` / `retryOf`；删 gate |
| 协调器 | `src/taskboard/board.ts` 派发/回写/自愈/`task_stop` 同语义 |
| Team 注册 | 新建或收敛 Team 表；`create_team`；成员/任务绑 `teamId` |
| 工具面 | `taskboard-tools` / `create_teammate` / `task_stop` / `task_wait`；删 `review_task` |
| 消息 | `message-tools` / inbox / teammate drain；队内白名单；位点持久化 |
| 服务面 | daemon 板停 HTTP；投影带 team / 五态 / retryOf |
| GUI | `TaskBoardTab` / `TaskDag` / 转录气泡来源名与跳转；`app.css` 点色 |

单物理板事件流保留；Team 为聚合与隔离键。事件与快照 schema 按新态重切，不做旧态兼容读。

---

## 7. 测试要点

1. `LEGAL`：每条合法边可迁；非法边报错文案含 from/to/allowed。
2. `task_stop`：pending→cancelled；running→cancelled + 执行中止；终态幂等。
3. 自愈：装载时 pending+running → cancelled；`task_wait` 立即终态、无永等。
4. `create_team` / 绑队：缺 `teamId`、跨队 `dependsOn`/`retryOf` 拒绝。
5. `retryOf`：DAG 有重试边；不挡派发；非终态前驱拒绝。
6. `send_message`：同队可达、跨队拒绝；接收方链尾出现消息行；fork 面无该工具。
7. GUI：无文字状态徽标；黄/红/灰/转圈；hover 停；队名卡头；转录来源名可跳转。

---

## 8. 决议摘要

| 项 | 决议 |
|----|------|
| 总体方案 | 方案 1：单板 + Team 聚合 |
| 兼容 | 禁止 |
| 状态 | pending / running / success / failed / cancelled |
| 停止 | `task_stop` 覆盖 pending+running → cancelled |
| 重启 | 非终态一律 cancelled |
| 多队 | 会话内并行，一队一卡 |
| 重试 | 模型 `create_task` + `retryOf`；dependsOn 仍须 success |
| 消息 | 完整交流面；进上下文；转录气泡+跳转 |
| 审批 | 删除 |
