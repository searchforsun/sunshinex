# 智能体团队：工具面重构、会话隔离开关与 GUI 三分栏

- **日期**: 2026-11-01
- **状态**: 设计定稿，待用户审阅后进入 implementation plan
- **来源**: 会话隔离裁定 + 页签「任务板→智能体团队」+ 工具整包改名/wait·stop 分域 + settings 开关
- **路径裁定**: 方案 1——settings 语义键 + 装配期剔工具；**禁止兼容**（旧工具名、工作区级 teams 根、双读别名一律不保留）
- **关联**: `2026-10-31-agent-team-simplify-design.md`（五态/队卡语义仍有效；本规格替换其工具命名与 wait/stop 边界，并叠加 GUI/开关）

---

## 0. 意图与成功标准

### 0.1 意图

1. 团队/板/inbox **按会话 `journalId` 隔离**（已落地方向：`data/teams/<journalId>/`），新会话空板。
2. 工具面整包改名 `agent_team*`；`task_wait` / `task_stop` 与板域拆开。
3. 全局 + 项目开关 `agentTeams`：关闭则不注入团队工具，并隐藏 GUI 页签。
4. GUI 页签「智能体团队」；队卡内 **成员 | 任务 | 编排**；外观用语「成员」不用「队友」。

### 0.2 成功标准

1. 下表 8 个团队工具名注册齐全；旧名零注册。
2. `task_wait` / `task_stop` 仅服务 exec/spawn（及超时转后台）账本任务；板 id / 成员名走 `agent_team_task_*`。
3. `agentTeams: false` 时工具清单与 selfcheck 均无 `agent_team*`；GUI 无「智能体团队」页签。
4. 队卡三分栏：成员可点开转录；任务=原列表；编排=原 DAG。
5. 会话流团队工具带 `agent_teams` 标识 + 中文动词；可见文案无「队友」「任务板」作为产品名（历史 journal 回放除外）。

### 0.3 非目标

- 旧工作区 `data/teams/` 根迁移或双读。
- 开关热改在飞 run 的工具清单。
- 将团队能力拆成独立插件包。
- 队卡内嵌完整聊天窗。

---

## 1. 工具名表与语义边界

### 1.1 更名（零兼容）

| 英文工具名 | 中文名（外观） | 原名（删除） |
|-----------|----------------|-------------|
| `create_agent_team` | 创建智能体团队 | `create_team` |
| `create_agent_teammate` | 创建团队成员 | `create_teammate` |
| `create_agent_team_task` | 创建团队任务 | `create_task` |
| `update_agent_team_task` | 更新团队任务 | `update_task` |
| `get_agent_team_board` | 查看团队看板 | `get_board` |
| `send_agent_team_message` | 发送团队消息 | `send_message` |
| `agent_team_task_wait` | 等待团队任务 | （原 `task_wait` 板分支） |
| `agent_team_task_stop` | 停止团队任务 | （原 `task_stop` 板/成员分支） |

收窄后的通用工具：

| 英文工具名 | 中文名 | 职责 |
|-----------|--------|------|
| `task_wait` | 等待后台任务 | 仅 exec / spawn（及超时转后台） |
| `task_stop` | 停止后台任务 | 仅上述账本任务 |

### 1.2 分域拒识

- `task_wait` 收到板任务 id → `INVALID_ARG`，说明改用 `agent_team_task_wait`。
- `agent_team_task_wait` 收到 exec/spawn id → 对称拒识。
- `task_stop` / `agent_team_task_stop` 同口径：后者含板任务取消 + 按名打断成员；前者不含。
- 旧名不设别名；历史 journal 只读回放；新 run 调旧名 = 未知工具。

### 1.3 队内隔离（不变式）

- 认领、消息、成员列表均按 `teamId`；跨队 `send_agent_team_message` 拒绝。
- 成员名在会话内唯一（inbox 按名落档）；可见文案称「成员」。

### 1.4 Fork 剔除

- `FORK_EXCLUDED_TOOLS` 改为新名单（含 `send_agent_team_message`、`create_agent_teammate` 与板四件套 + wait/stop 团队件）；子面不得建队/建成员/改板。

---

## 2. Settings、装配与 GUI 门闩

### 2.1 配置键

- 语义键：`agentTeams`（boolean），缺省 `true`。
- 全局 `~/.sunshinex/settings.json` + 项目 `.sunshinex/settings.json`；两级只填缺省，项目显式覆盖全局。
- 可选运行时槽 `SUNSHINEX_AGENT_TEAMS` 经 `SEMANTIC_KEYS` 登记；优先级：显式 env > 语义键落槽。
- GUI 设置页：全局 / 项目各一开关「智能体团队」。

### 2.2 装配

- `agentTeams === false`：不注册 §1.1 八个团队工具；`task_wait` / `task_stop` 仍注册。
- 盘上已有会话团队数据不因关开关而删除。
- 生效：下一轮 run / 换铸 Harness（不热改在飞清单）。
- selfcheck `tools :` 与注册清单同源。

### 2.3 GUI 门闩

- 关：不挂载「智能体团队」页签。
- 开：显示页签；历史转录中的团队工具行仍可只读回放。

---

## 3. GUI：页签与三分栏

### 3.1 页签

- 标题：智能体团队 / Agent teams（替换「任务板」）。
- 受 `agentTeams` 控制。

### 3.2 队卡内切换（替换「列表 | DAG」）

| 键 | 中文 | 英文 | 内容 |
|----|------|------|------|
| members | 成员 | Members | 该 `teamId` 存活成员（busy 点可留）；空态「暂无成员」；**点击成员名** → `onOpenAgent` 打开转录页签 |
| tasks | 任务 | Tasks | 原任务列表（点色 + 停钮 → `agent_team_task_stop`） |
| orchestration | 编排 | Orchestration | 原 DAG；节点停钮同上 |

- 每卡本地 view state；默认 **任务**。
- 定位：开团队 → 高亮队卡；开任务 → 切到「任务」并高亮行。

### 3.3 会话流标识

- 固定名单 `AGENT_TEAM_TOOLS`（八名）→ 智能体团队类。
- 折叠行/运行态：标识 `agent_teams`（外观可译「智能体团队」）+ §1 中文动词。
- 与普通工具视觉区分（徽标或独立 `tool-verb` 样式）；不改 md 正文形态。
- tip/空态：「打开该团队」「在智能体团队中定位」「打开成员转录」等；产品文案不用「队友」。

### 3.4 术语

- 用户可见中文：成员；英文外观：member（工具英文 id 可保留 `teammate` 词根）。

---

## 4. 会话落盘（与本规格一并遵守）

- 团队根：`data/teams/<journalId>/`（registry、main 板事件、inbox、cursors）。
- journal 铸造 / attach 后与任务账本同拍 `adoptSessionTeams`。
- 不做旧工作区级 `teams/` 兼容读。

---

## 5. 测试与文档

### 5.1 测试

- 主仓：新名单、FORK 剔除、wait/stop 分域、`agentTeams:false` 清单、selfcheck。
- GUI：页签文案、三分栏、成员点击 `onOpenAgent`、开关藏页签、ToolEntry 标识与「成员」用语。
- 无旧名双读用例。

### 5.2 文档

- 更新 `CLAUDE.md` 工具清单、持久化分层、设置语义键。
- MANUAL-GUI：设置开关 + 页签说明。
- 历史规格档案不改写「跨会话」旧句；以本文件 + CLAUDE 为准。

---

## 6. 实现落点（计划阶段展开）

| 域 | 主要落点 |
|----|----------|
| 工具注册/改名 | `harness/index.ts`、`taskboard-tools.ts`、`message-tools.ts`、`task-wait.ts`、`task-stop.ts`、FORK 常量 |
| 开关 | `config/settings.ts` SEMANTIC_KEYS、settings GUI、Harness 条件注册 |
| GUI | 页签标题、`TaskBoardTab` 三分栏、`ToolEntry` 标识与 i18n、设置表单 |
| 文档/selfcheck | CLAUDE.md、MANUAL-GUI、selfcheck tools 行 |

---

## 7. 决议摘要

| 项 | 决议 |
|----|------|
| 实现路径 | settings + 装配期剔工具 |
| 工具 | 整包 `agent_team*`；wait/stop 拆开 |
| 停成员 | 归 `agent_team_task_stop` |
| 开关缺省 | `true`；关=无工具+无页签 |
| GUI | 智能体团队；成员\|任务\|编排；成员点击转录 |
| 用语 | 「成员」不用「队友」 |
| 兼容 | 无 |
