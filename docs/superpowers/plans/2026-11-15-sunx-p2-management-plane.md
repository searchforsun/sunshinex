# Sunx P2（管理面）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sunx 的管理面四件套——①板任务通道（target='team'：依赖图/重派/外部 CLI 可插拔，能力自举 R6）②调度原语（schedule_wakeup/schedule_task，对标 Grok Tasks 的最小内化）③挂起持久化 + 恢复唤醒轮（R9，无人值守闭环补完）④GUI 管理面（SUNX 分组 + 总览页 + 品性编辑 GUI + 品性模板目录）。

**Architecture:** 四件各自独立、共享 P1 地基。板通道 = `dispatch_task` 增 `target:'team'` 分支走既有 TaskBoard 协调器（板任务终态已在 bg-wake 唤醒汇，boardDispatch 行既有）；调度 = WakeController 旁的 session 层 `TimerController`（定时是会话资产随档走——偏离 spec §7.2「daemon 级」字面、语义等价，见 Rulings）；挂起持久化 = journal 新影子行 `pending-open/resolve`，attach 重放为**恢复轮素材**（不复活 promise——executor 已死，复活无消费者）；恢复唤醒轮 = R9 的 attach 注入；GUI = 侧栏 SUNX 过滤组 + 单例 `sunx` 总览页签 + charter 编辑弹窗。

**Tech Stack:** TypeScript（node:test 根包 + vitest GUI）、React 18、JSONL 会话档（journal 新行词汇）、TaskBoard/Teammate 既有器官。

**Spec:** `docs/superpowers/specs/2026-11-14-sunx-orchestrator-design.md`（§7.2/§8/§10/§11 + R1–R13 已裁记录；矛盾处以 spec 为准，本 plan 的 Rulings 为 spec 未覆盖处的裁定）。
**前置（已落地）:** P1 全链（kind 会话/分派白名单面/唤醒闭环/attach 重铸/charter 端点/GUI 弹窗）——本 plan 全部消费不重建。

## Global Constraints（沿 P1 全部 + 本期新增）

- **普通会话零变化（最高约束）**：主链工具清单逐字节不变；standard 装配路径行为不变；新 journal 行词汇只增不篡（旧档无新行=行为不变）。
- **bg-wake 裁定不可破坏**：调度是唤醒管线的**第二触发源**（复用 WakeController 管线/合批/上限/显示前缀），不得旁路 submitWake 或自起轮；显示前缀文案「定时唤醒」双语走 t()。
- **板通道纪律**：TaskBoard 是任务状态唯一权威；teammate 器官零结构改动（face 派生除外）；「无活成员留 pending」语义保持。
- **提示词恒英文**：工具描述/系统行英文单语；品性模板正文=用户自撰物料原样直存。
- **GUI 铁律全套**：data-tip 禁原生 title、`--radius-*` 22px 族、图标钮 24px 命中盒/14px 下限、文字 ≥14px、跳转瞬跳无闪光、展开收合平滑过渡、t() 双语。
- **持久化分层纪律**：会话级共享数据同一落盘同一读写面（CLAUDE.md §13），不建平行写面。
- 每批完成即提交（conventional commits 中文说明）；全量门禁 = `pnpm test` + `pnpm selfcheck` + `pnpm --dir gui test`，最后一批加 `pnpm --dir gui run test:e2e`。
- 定向跑测：先 `pnpm exec tsc -p tsconfig.json`，再 `node --require scripts/test-env.cjs --test dist/<路径>.test.js`；GUI `pnpm --dir gui run typecheck` + 定向 vitest。
- 已知预存抖动（非本计划范围，如实报不修）：`loop/nodes.chat` 记忆提取间歇红、`images-cache` 秒界抖动、gui e2e unhandled-rejection 噪声。
- 工作树里非本工作改动绝不入提交（P1 期间并行会话活跃，提交前 `git status` 核对 stage 清单）。

## P1 移交的强制义务（本计划内清偿）

| 移交项 | 落点 |
|---|---|
| `teammate.ts:314` 缺省 derive 全克隆面收口 + teammate Reactor 无 kind | Task 1 |
| `setToolDisplayMeta` 进程级单例（混合 kind daemon 下末装配者胜） | Task 1 |
| 置顶行无 Sunx 徽标（PinEntry 缺 kind） | Task 6 |
| `dispatch_task` 的 `context:'clean'` 退路 | 本期不实施（待真模型实测串扰证据），spec §17.2 已裁定 |

---

### Task 1: 基线义务——teammate 面收口 + 呈现表去单例

**Files:**
- Modify: `src/taskboard/teammate-tools.ts`（`deriveTeammateRegistry`：剔族追加路由版 ask 语义——askedBy 已含板任务 id 字段，路由机制与 fork 同源；kind 透传入 teammate Reactor）
- Modify: `src/taskboard/teammate.ts`（Reactor 构造带 kind——teammate 实例化时从装配注入）
- Modify: `src/harness/index.ts`（mountTeammate/teamAdapter 注 kind；`setToolDisplayMeta` 调用点收敛）
- Modify: `src/session/runtime.ts` + `src/tui/tool-verbs.ts`（呈现表从进程级单例改为随 runtime 返回或 union-merge——裁定：`createKernelRuntime` 返回面增 `toolDisplay(): DisplayMeta[]`，TUI 消费点改读返回值；全局 `setToolDisplayMeta` 保留兜底但 daemon 路径不再写全局）
- Test: teammate-tools/teammate 既有套件 + tool-verbs 套件

**Interfaces:**
- teammate face：`deriveTeammateRegistry(base, askedBy?)` 形态对齐 fork（deps.ask 在场 → 注册路由版 ask_question，askedBy={label:成员名, taskId:板任务 id}）；剔除族不动（spawn/todo_write/worktree/板面五件套），**移除 ask_question 无条件剔除**。
- teammate Reactor 构造带 kind（= 装配 opts.kind；standard 缺席字节不变）。
- 呈现表：`createKernelRuntime` 返回对象增只读 `toolDisplay`；TUI 消费点（grep `setToolDisplayMeta`/`displayMeta` 全部消费面）改读；进程级 set 退化为 TUI 单会话场景兼容。

- [ ] Step 1 失败测试：teammate face（ask 在场含路由 ask/askedBy 板任务 id 形态；ask 缺席不含——headless 旧制）；teammate Reactor 稳定段随 kind；呈现表混合 kind 两次 assemble 后各自返回各自 face 表（不再互相覆盖）
- [ ] Step 2 落地 + 全部触达套件定向跑 + 提交（`feat(harness): teammate 面收口——路由 ask/kind 透传/呈现表去单例`）

---

### Task 2: 板任务通道——dispatch target='team' + 能力自举 R6

**Files:**
- Modify: `src/harness/subagent.ts`（`makeDispatchTool` schema 增 `target?: 'fork'|'team'`（缺省 'fork'）+ `depends_on?: string[]`；executor 分流：team → 板通道）
- Modify: `src/harness/index.ts`（sunx 装配注入板通道接缝：TaskBoard + AgentTeamRegistry + agent 目录——按 R6 自举）
- Modify: `src/harness/index.ts` `SUNX_FACE_TOOLS` 增 `get_agent_team_board`（板通道监视面随通道进面）
- Test: sunx-face 套件 + taskboard 既有套件 + 新 e2e

**Interfaces:**
- team 分支语义：①无既有团队 → **自举**（R6 已裁）：create team（slug 取 label 或 'sunx'）+ 按 `agent_id` 经既有 teamAdapter.spawn 实例化 teammate（agent_id 缺省 developer 预设；实例化失败=任务留 pending + 回执说明「无活成员」——板语义既有）②create board task（spec/label/dependsOn）→ 指派（assignee=按 agent_id 匹配成员，缺省留给 claim）③回执 `board task <id> created (team <teamId>)<wakeHintSuffix>`（wakeHintSuffix 既有单点）④`depends_on` 校验：环检测复用 `hasCycle`，环=INVALID_ARG。
- `get_agent_team_board` 进 sunx face（既有注册件白名单追加）。
- 板任务终态唤醒：boardDispatch 行已在 bg-wake 唤醒汇（P1 零改动）——e2e 断言。
- 裁定（§8.2 P2 裁定点）：teammate 面路由 ask **放开**（Task 1 已落机制）。

- [ ] Step 1 失败测试：team 分支回执/自举（无团队→自动建+成员实例化）/depends_on 环拒绝/指派路由/板终态唤醒 Sunx（boardDispatch 唤醒锚）/face 含 get_agent_team_board
- [ ] Step 2 落地 + 定向跑 + 提交（`feat(harness): sunx 板任务通道——dispatch target='team'/能力自举/监视面`）

---

### Task 3: 调度原语——TimerController + schedule_wakeup/schedule_task

**Files:**
- New: `src/session/timer.ts`（`TimerController`：会话级定时器——arm/cancel/到点回调；与 WakeController 同居 session 层）
- Modify: `src/session/entry.ts` + `src/session/seglog.ts`（journal 新行 `wake-schedule`：{id, atIso|delaySeconds, note, taskSpec?}——落档/回放往返）
- Modify: `src/harness/tools/`（`makeScheduleWakeupTool` / `makeScheduleTaskTool`——仅 sunx 装配注册，进 `SUNX_FACE_TOOLS`）
- Modify: `src/serve/session.ts`（TimerController 实例化、到点走 `submitWake` 同管线——notice 文 `<schedule-wake>`、无 wake 引用、计入连续上限；attach 重布防：journal 行回放 re-arm；R7 错过时段=补发一次+注明延迟）
- Test: `src/session/timer.test.ts`（新）+ session.wake 套件追加 + seglog 往返

**Interfaces:**
- `schedule_wakeup({ delay_seconds?, at_iso?, note })`（二选一必填）：到点=唤醒轮（notice md=`<schedule-wake>\nScheduled wake: ${note}\n...延迟注明（若错过）`），显示前缀「定时唤醒」（run 行 wakeOfRun 配对沿用——notice→run 固定写入序）。重复 arm=替换（一会话一活跃调度位，MVP）。
- `schedule_task({ spec, agent_id?, label?, delay_seconds?, at_iso? })`：到点自动执行 dispatch（fork 通道）→ 之后走正常唤醒闭环。落 `wake-schedule` 行（taskSpec 字段）。
- attach 重布防：journal 行回放 → 过滤已触发（行落档时同时落 `firedAt` 终态行）→ 未触发项 re-arm；daemon 停机跨越=错过时段，R7：补发一次唤醒+注明延迟时长。
- 连续唤醒上限沿用（定时唤醒计入 chain）。

- [ ] Step 1 失败测试：TimerController arm/fire/cancel/替换；journal 行往返（写→读逐字段恒等，旧档无行不炸）；到点起轮（notice 文+run 配对+显示前缀推导）；schedule_task 到点派发→完成→正常唤醒；attach 重布防（重启模拟：未触发 re-arm、已触发不重发）；R7 补发一次注明延迟
- [ ] Step 2 落地 + 定向跑 + 提交（`feat(session): 调度原语——TimerController/schedule_wakeup/schedule_task/重布防`）

---

### Task 4: 挂起持久化——pending 影子行 + 恢复轮素材

**Files:**
- Modify: `src/session/seglog.ts`（journal 新行 `pending-open` {pid,kind,req,askedBy?} / `pending-resolve` {pid,answer 摘要}）
- Modify: `src/serve/session.ts`（suspendAsk/suspendApproval/resolvePending* 三写点落档——尽力而为落档纪律）
- Modify: `src/serve/session-lifecycle.ts`（attach 回放：未决 pending 不复活 promise，转为**恢复轮素材**——reCast 后注入恢复轮 notice；已答的行仅审计）
- Test: seglog 往返 + daemon 合同（挂起→重启→恢复轮 notice 含未决问题原文）

**裁定（spec §11 的具体化）**：挂起持久化语义 = ①审计（凡界面可见皆落库延伸）②attach 后未决 ask/approval 以恢复轮 notice 素材呈现（问题原文+选项），由恢复后的 Sunx 在新 run 里重新处理（重新 ask 或按默认决策推进）——**不复活原 promise**（executor 已死）。approval 同法。

- [ ] Step 1 失败测试：行往返；挂起→重启→attach→恢复轮 notice 含问题原文；已决行不进素材
- [ ] Step 2 落地 + 定向跑 + 提交（`feat(serve): 挂起持久化——pending 影子行/恢复轮素材`）

---

### Task 5: 恢复唤醒轮（R9）

**Files:**
- Modify: `src/serve/session-lifecycle.ts` + `src/serve/session.ts`（attach 收尾：kind==='sunx' 注入恢复 notice + 起恢复轮——专用 submitWake 变体：notice 文 `<session-restored>`、无 wake 引用、计入连续上限、恢复轮内未决挂起素材由 Task 4 注入同轮）
- Test: session.wake 套件追加（重启→attach→恢复轮起跑；standard 不触发；与 steer/挂起素材同轮合并）

**Interfaces:**
- 触发条件：attach 完成 + kind==='sunx' + （自愈产生的打开态任务 cancelled 或存在未决挂起素材）→ 恢复轮；全无素材则静默不起轮（避免每次重开空转一轮）。
- 恢复轮 notice 文（英文单语）：会话已恢复 + N 个派发任务被重启打断（自愈 cancelled 清单）+ M 个未决问询素材 + 指令「重读板态/台账，决定重派或向用户报告」。
- R9 裁定「自动恢复唤醒」落地；显示面 = 普通 run 行（notice 文 isQuietNotice 处理——`<session-restored>` 加入安静清单）。

- [ ] Step 1 失败测试：有打断任务→恢复轮；有未决挂起→同轮含素材；无素材→不起轮；standard 不起轮
- [ ] Step 2 落地 + 定向跑 + 提交（`feat(serve): 恢复唤醒轮——R9 自动重估`）

---

### Task 6: 品性模板目录——`.sunshinex/sunx/{id}/sunx.md`

**Files:**
- New: `src/catalog/sunx.ts`（两级装载：项目 `.sunshinex/sunx/{id}/sunx.md` 遮蔽全局 `~/.sunshinex/sunx/`；frontmatter name/description + 正文章程；坏档宽容进 warnings——teams/agents 目录约定同构）
- Modify: `src/serve/config-handlers.ts`（GET /settings/sunx-templates 清单端点——宽容视图）
- Modify: `gui/src/welcome/NewSunxDialog.tsx`（模板挑选：下拉/选择卡，选中回填 name/charter 可改）
- Test: catalog 套件（两级遮蔽/坏档 warnings）+ 弹窗测试

- [ ] Step 1 失败测试：两级装载遮蔽/坏档 warnings/端点形状/弹窗模板回填
- [ ] Step 2 落地 + 定向跑 + 提交（`feat(catalog): 品性模板目录——sunx.md 两级装载/弹窗挑选`）

---

### Task 7: GUI SUNX 分组——侧栏组 + 品性编辑

**Files:**
- Modify: `gui/src/sidebar/`（SUNX 组区块：`/sessions` 行 kind 过滤聚合、按工作区分节（R10）；RECENTS 与项目组并存不互斥；置顶/归档行补 kind 徽标——PinEntry 增 kind 透传）
- Modify: `gui/src/sidebar/session-row-menu.tsx`（sunx 行菜单增「编辑品性」项）
- New: `gui/src/welcome/CharterDialog.tsx`（+ 测试——小弹窗：textarea 编辑品性 → POST /session/:id/charter → 成功提示新 rev；复用弹层惯例）
- Modify: `gui/src/connection.ts`（`editCharter(id, text)` 端点封装）
- Test: 侧栏组聚合/分节/徽标 + CharterDialog 校验与提交

- [ ] Step 1 失败测试：组聚合（多工作区分节、空组不显）/徽标补齐/菜单项 gate（仅 sunx 行）/CharterDialog 载荷与错误路径
- [ ] Step 2 落地 + typecheck + 定向跑 + 提交（`feat(gui): SUNX 分组——侧栏过滤组/品性编辑弹窗`）

---

### Task 8: SUNX 总览页——单例 `sunx` 页签

**Files:**
- Modify: `gui/src/tabs/tab-state.ts`（TabTypeId 增 `'sunxboard'` + 盘档白名单）
- New: `gui/src/tabs/SunxBoardTab.tsx`（+ 测试）：顶部全局聚合条（运行中实例 n/在飞任务 n/待裁决 n）+ 卡片网格（按工作区分节，R10）——每实例卡=姓名+状态点+任务进度（委派投影计数）+最近活动+待裁决徽标+点卡片 openTab 进实例；「新建 Sunx」入口卡（复用 NewSunxDialog）；数据=既有面组装（sessions 列表 kind 过滤 + snapshot 委派投影 + pending 计数），刷新钮走 snapshot 权威整替（agents 页签先例）
- Modify: `gui/src/tabs/registry.tsx`（注册条目 + TAB_ICONS；singleton）；`gui/src/sidebar/project-menu-recents.tsx`（「新建 Sunx」钮旁加看板钮开总览页）
- Test: tab 注册/判重/盘档往返 + 卡片组装 + 聚合条

- [ ] Step 1 失败测试：注册单例判重/盘档消毒白名单/卡片数据组装/聚合计数/入口卡开弹窗
- [ ] Step 2 落地 + typecheck + 定向跑 + 提交（`feat(gui): SUNX 总览页——单例页签/卡片网格/聚合条`）

---

### Task 9: spec/MANUAL 收口 + 全量回归

**Files:**
- Modify: spec（§7.2 调度实况回写——TimerController session 层裁定与 wake-schedule 行词汇；§8.2 teammate ask 放开落地；§10 实况——分组/总览页/品性编辑落点；§11 挂起持久化实况——素材语义）
- Modify: MANUAL-GUI.md（SUNX 分组/总览页/品性编辑/定时任务条目更新）
- Gates: `pnpm test` + `pnpm selfcheck` + `pnpm --dir gui test` + `pnpm --dir gui run test:e2e`（预存抖动按 P1 协议处置：standalone 复跑/stash 对照，如实报告）

- [ ] Step 1 文档回写
- [ ] Step 2 全量门禁四项
- [ ] Step 3 提交（`docs(sunx): P2 收口——实况回写+手册`）

---

## 场景走查（验收剧本）

| 场景 | 落点 |
|---|---|
| Sunx 派发板任务（含依赖）→ 成员执行 → 终态唤醒 → 重派 | Task 2 |
| 无团队时首次 team 派发自动建队+成员 | Task 2 R6 |
| 「每天 9 点跑回归」→ schedule_task 到点派发 → 完成唤醒 → 汇总 | Task 3 |
| daemon 停机跨越定时点 → 重启补发一次注明延迟 | Task 3 R7 |
| 子任务问询时 daemon 重启 → 重开恢复轮含未决问题素材 → 重新处理 | Task 4+5 |
| 重启后重开 → 恢复轮报告打断任务并重派 | Task 5 |
| 弹窗从品性模板创建 | Task 6 |
| 侧栏 SUNX 组看板钮 → 总览页卡片 → 点进实例 | Task 7+8 |
| 行菜单编辑品性 → rev 递增 → 模型面尾追生效 | Task 7 |

## P3 预告（不在本计划）

跨 Sunx 协同（sunx-of-sunx，target='session' 真子会话执行体）、外部 CLI 通道进 dispatch 面（external-cli 直连）、子任务结论注入扫描、dispatch context:'clean'（待实测串扰证据）、cron-like 周期调度。
