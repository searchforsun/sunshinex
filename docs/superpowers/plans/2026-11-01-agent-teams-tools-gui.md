# 智能体团队工具面 + GUI 三分栏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 整包改名 `agent_team_*`、拆分 wait/stop、加 `agentTeams` 开关，并把 GUI「任务板」收成「智能体团队」三分栏（成员|任务|编排）；零兼容。

**Architecture:** 会话团队根已按 `journalId` 隔离（工作区 WIP 先收口）。工具在 Harness 装配期按 `agentTeams` 条件注册；`task_wait`/`task_stop` 收窄为 exec/spawn，板域另册。GUI 读同一开关藏页签，队卡三态切换，ToolEntry 用固定名单打 `agent_teams` 标识。

**Tech Stack:** TypeScript / Node test / Vitest(GUI) / React / 既有 settings 两级装载

**Spec:** `docs/superpowers/specs/2026-11-01-agent-teams-tools-gui-design.md`

## Global Constraints

- 零兼容：旧工具名不注册、不设别名；旧工作区 `teams/` 根不双读。
- 外观用语：中文「成员」不用「队友」；页签「智能体团队」。
- 工具 description / 观察 / 链行恒英文；GUI/设置用 `t()` 双语。
- `agentTeams` 缺省 `true`；关=不注入八个团队工具 + 隐藏页签。
- 前缀缓存：工具清单按名排序；改名接受一次全量断点。

## Review Focus

- 关开关后模型仍吐出旧名 `create_team` → 未知工具，不静默映射。
- `task_wait` 混入板 id → `INVALID_ARG` 并点名 `agent_team_task_wait`。
- 成员页点击无转录 → 仍开页签，空态由转录页承接，不抛。
- 项目关、全局开 → 项目优先，该 root 无团队工具。
- 历史 journal 含旧工具行 → GUI 只读回放，不因改名崩溃。

## File map

| 文件 | 职责 |
|------|------|
| `src/config/settings.ts` | `SEMANTIC_KEYS.agentTeams` |
| `src/config/agent-teams.ts`（新建） | `agentTeamsEnabled(root): boolean` 解析单点 |
| `src/harness/tools/taskboard-tools.ts` | 四件套改名 + 常量 |
| `src/taskboard/message-tools.ts` | `send_agent_team_message` |
| `src/harness/tools/task-wait.ts` | 收窄 + 导出板等待工厂或姊妹文件 |
| `src/harness/tools/task-stop.ts` | 收窄 + `makeAgentTeamTaskStopTool` |
| `src/harness/index.ts` | 条件注册、新名接线 |
| `src/harness/subagent.ts` | FORK 剔除表跟新名 |
| `gui/src/settings/SettingsForm.tsx` | 开关字段 |
| `gui/src/tabs/TaskBoardTab.tsx` | 三分栏 |
| `gui/src/pages/chat/ToolEntry.tsx` | 标识 + i18n |
| `gui/src/App.tsx` 等 | 页签标题/菜单「智能体团队」 |
| `CLAUDE.md` / MANUAL-GUI | 活文档 |

---

### Task 1: 收口会话隔离 WIP

**Files:**
- Modify: 已有 `src/harness/index.ts`、`src/serve/session.ts`、`src/tui/session.ts`、`src/taskboard/store.ts` 等（工作区未提交）
- Test: `src/harness/session-teams.test.ts`

**Interfaces:**
- Produces: `Harness.adoptSessionTeams(journalId: string): void`；`sessionTeamsRoot(dataDir, journalId)`

- [ ] **Step 1: 确认隔离测试绿**

Run: `pnpm exec tsc -p tsconfig.json; node --test dist/harness/session-teams.test.js dist/harness/message.e2e.test.js`

Expected: PASS

- [ ] **Step 2: 扫残留「工作区级任务板/跨会话」活文档并改 CLAUDE 已改段之外的漏网**

仅改活文档与代码注释正向口径；不改历史 specs 档案正文。

- [ ] **Step 3: Commit**

```bash
git add src/config/data-dir.ts src/harness/index.ts src/harness/session-teams.test.ts src/harness/message.e2e.test.ts src/serve/session.ts src/tui/session.ts src/tui/commands-session.ts src/taskboard/board.ts src/taskboard/store.ts src/taskboard/team-registry.ts src/taskboard/file-inbox.ts src/taskboard/inbox-cursors.ts src/taskboard/message-tools.ts CLAUDE.md
git commit -m "feat(taskboard): 团队/板/inbox 按 journalId 会话隔离"
```

---

### Task 2: `agentTeams` 语义键

**Files:**
- Modify: `src/config/settings.ts`（SEMANTIC_KEYS）
- Create: `src/config/agent-teams.ts`
- Modify: `src/config/settings.test.ts`（键表钉子计数 +1）
- Create: `src/config/agent-teams.test.ts`

**Interfaces:**
- Produces: `export function agentTeamsEnabled(root: string): boolean` — 读 env `SUNSHINEX_AGENT_TEAMS` / 两级 settings，缺省 `true`；仅接受 boolean 或 on/off/true/false 字符串（与 autoMemory 同类）

- [ ] **Step 1: 失败测试**

```ts
test('agentTeamsEnabled 缺省 true；显式 false 关闭', () => {
  // 空 settings → true
  // 项目 settings.json { "agentTeams": false } → false
});
```

- [ ] **Step 2: 实现 SEMANTIC_KEYS + 解析单点 + 更新 `SEMANTIC_KEYS` 全表钉子数量**

- [ ] **Step 3: 测试绿后 Commit**

```bash
git commit -m "feat(config): agentTeams 语义键与启用解析单点"
```

---

### Task 3: 板工具整包改名

**Files:**
- Modify: `src/harness/tools/taskboard-tools.ts`
- Modify: `src/taskboard/message-tools.ts`（工具 `name`）
- Modify: `src/harness/subagent.ts`（FORK_EXCLUDED / 引用）
- Modify: 所有引用旧名的 `*.test.ts` / e2e / GUI 测试字面量

**Interfaces:**
- Produces:
  - `TASKBOARD_TOOL_NAMES = ['create_agent_team','create_agent_team_task','update_agent_team_task','get_agent_team_board']`
  - `FORK_EXCLUDED_TOOLS` 含 `send_agent_team_message`、`create_agent_teammate`、上表、以及后续 Task 4/5 的 wait/stop 团队名（本任务先改已有四件套+message+teammate；wait/stop 名在 Task 4/5 补进剔除表）

- [ ] **Step 1: 改工厂 `name` 与 description（英文）；`create_agent_teammate` 在 harness 注册块同步改名**

- [ ] **Step 2: 全仓替换测试与常数中的旧工具名（`rg create_team|create_teammate|create_task|get_board|send_message` 主仓工具面，避开历史 docs/specs）**

- [ ] **Step 3: 跑相关测试**

Run: `pnpm exec tsc -p tsconfig.json; node --test dist/harness/tools/taskboard-tools.test.js dist/harness/fork-face.test.js dist/harness/taskboard.e2e.test.js dist/harness/team-flow.e2e.test.js dist/harness/message.e2e.test.js`

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(tools): 智能体团队工具整包改名 agent_team_*"
```

---

### Task 4: 拆分 `task_wait` / `agent_team_task_wait`

**Files:**
- Modify: `src/harness/tools/task-wait.ts`
- Create 或同文件导出: `makeAgentTeamTaskWaitTool(tasks, board, getRunSignal)`
- Modify: `src/harness/index.ts` 注册
- Modify: `src/harness/tools/task-wait` 相关测试；板等待用例迁到新名

**Interfaces:**
- Produces:
  - `makeTaskWaitTool`：`allowBoard=false` 固定；kinds 仅 `exec`+`subagent`（spawn 后台）；description 英文明示板 id 用 `agent_team_task_wait`
  - `makeAgentTeamTaskWaitTool`：只等板任务（可含板派发台账 id）；拒 exec/spawn 纯后台 id

- [ ] **Step 1: 失败测试——`task_wait` 喂板 id 得 INVALID_ARG；`agent_team_task_wait` 喂 exec id 得 INVALID_ARG**

- [ ] **Step 2: 实现分域；Harness 注册两工具（团队件仍无条件，条件在 Task 6）**

- [ ] **Step 3: 测试绿 + Commit**

```bash
git commit -m "refactor(tools): task_wait 与 agent_team_task_wait 分域"
```

---

### Task 5: 拆分 `task_stop` / `agent_team_task_stop`

**Files:**
- Modify: `src/harness/tools/task-stop.ts`
- Modify: `src/harness/index.ts`
- Modify: 相关测试；GUI 停钮改调团队 stop（若经工具名字符串）

**Interfaces:**
- Produces:
  - `makeTaskStopTool(tasks)`：仅台账 exec/spawn；不碰 board/team
  - `makeAgentTeamTaskStopTool(tasks, team, board)`：`stopBoardTask` + 按名打断成员

- [ ] **Step 1: 失败测试分域**

- [ ] **Step 2: 实现 + FORK 剔除表纳入 `agent_team_task_wait`/`agent_team_task_stop`**

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(tools): task_stop 与 agent_team_task_stop 分域"
```

---

### Task 6: Harness 按 `agentTeams` 条件注册

**Files:**
- Modify: `src/harness/index.ts`
- Modify: `src/runtime.ts` / `buildHarness` 若需透传 root 已有
- Test: `src/harness/agent-teams-gate.test.ts`（新建）

**Interfaces:**
- Consumes: `agentTeamsEnabled(base)`
- 关：跳过八个团队工具注册（含 create_agent_teammate、send、wait/stop 团队件）；板协调器可仍构造（空）但不暴露工具
- 开：全注册

- [ ] **Step 1: 测试——settings false 时 `h.tools.get('create_agent_team')` 为 undefined，且 `task_wait` 仍在**

- [ ] **Step 2: 实现条件注册；selfcheck 工具行自然同源**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(harness): agentTeams 关闭时不注入团队工具"
```

---

### Task 7: GUI 设置开关

**Files:**
- Modify: `gui/src/settings/SettingsForm.tsx`（KEY_META + limits 组 `sel('agentTeams', ON_OFF)`）
- Modify: daemon settings 枚举若有白名单需加键
- Test: 设置表单相关 vitest（若有键表钉子则更新）

- [ ] **Step 1: 字段 label `{ en: 'Agent teams', zh: '智能体团队' }`，说明关则隐藏页签且不注入工具**

- [ ] **Step 2: 确认 GET/PUT settings 透传该键（与 autoMemory 同路）**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(gui): 设置项 agentTeams 智能体团队开关"
```

---

### Task 8: GUI 页签三分栏 + ToolEntry

**Files:**
- Modify: `gui/src/tabs/TaskBoardTab.tsx`（`members|tasks|orchestration`；成员点击 `onOpenAgent`）
- Modify: `gui/src/App.tsx` / 菜单 / tab title：`Task board`→`Agent teams`，`任务板`→`智能体团队`
- Modify: `gui/src/pages/chat/ToolEntry.tsx`：`AGENT_TEAM_TOOLS` 集合、徽标 `agent_teams`、中文动词表、去掉「队友」
- Modify: 凡 `bi('Task board'|'任务板')` 的测试
- 页签可见性：读 settings/snapshot 的 `agentTeams`（daemon snapshot 或 settings GET；缺省 true）

**Interfaces:**
- 队卡 view：`'members'|'tasks'|'orchestration'`，默认 `'tasks'`
- 停钮 → 既有 stop 回调（服务端已是团队 stop 语义）

- [ ] **Step 1: TaskBoardTab 测试——三钮切换；成员行 click 触发 onOpenAgent**

- [ ] **Step 2: 实现三分栏 + 页签改名 + 开关藏签**

- [ ] **Step 3: ToolEntry 标识与 i18n；Chat 相关测试改新工具名**

- [ ] **Step 4: `pnpm --dir gui run test` 相关文件绿**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(gui): 智能体团队页签三分栏与工具 agent_teams 标识"
```

---

### Task 9: 文档与全量门禁

**Files:**
- Modify: `CLAUDE.md`（§5 工具清单、§13 用语）
- Modify: MANUAL-GUI（设置开关、页签）
- 扫代码注释「任务板工具」等正向改写

- [ ] **Step 1: 更新活文档**

- [ ] **Step 2: 主仓 `pnpm test` 过滤或全量；`pnpm selfcheck`；`pnpm --dir gui run test`**

- [ ] **Step 3: Commit**

```bash
git commit -m "docs: 智能体团队工具与 GUI 口径同步 CLAUDE/MANUAL-GUI"
```

---

## Spec coverage checklist

| Spec 节 | Task |
|---------|------|
| §1 工具改名与分域 | 3–5 |
| §2 agentTeams 开关与装配 | 2, 6–7 |
| §3 GUI 三分栏/标识/成员跳转 | 8 |
| §4 会话落盘 | 1（已基本完成） |
| §5 测试与文档 | 各任务 + 9 |
| 零兼容 / 用语「成员」 | Global + 8 |

## Self-review notes

- 无 TBD 占位；wait/stop 分域测试钉在 Task 4/5。
- FORK 剔除在 Task 5 收齐团队 wait/stop 名。
- `SEMANTIC_KEYS` 计数钉子随 Task 2 更新。
