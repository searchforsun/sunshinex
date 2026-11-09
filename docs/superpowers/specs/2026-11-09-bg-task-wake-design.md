# 后台任务唤醒（bg-wake）设计

日期：2026-11-09　分支：dev1　状态：草案（§10 待用户裁定；文案与分派提示已裁定）

## 0. 背景与现状

现状链路（代码实证）：

- 后台任务统一账本 `TaskRegistry`（`src/harness/tasks.ts`）：`submit/finish` 经 `onChange` 旁路发 `bg-task` 事件（`src/harness/index.ts` 装配），GUI 后台任务页签/顶栏计数消费；`src/session/entry.ts` 对 `bg-task` **不产转录条目**。
- 模型获知任务终态只有**拉模式**：`task_wait`（`src/harness/tools/task-wait.ts`）阻塞等终态并内联回执（2026-10-04 编排规格裁定「唤醒复用 task_wait(null) 拉模式」）。exec 转后台回执原文是 "poll that file … **or** block with task_wait"（`src/harness/tools/builtin.ts`），只给选项、不强制阻塞。
- 等待队列（P5 spec §12，`SteerItem`）只承载用户消息；G14.89 轮收束续跑分别写在两端宿主（`src/serve/session.ts`、`src/tui/session.ts`）。

缺口：模型起了后台任务、做完手头同步工作、输出正文结束本轮（没有调用 `task_wait`）后，任务完成时会话保持空闲，结果无人接续。

目标：后台任务到终态时自动唤醒空闲会话；模型带着完整历史自然接续后续流程；该轮 run 行显示为「后台任务 {id} 唤醒，运行中 N 秒」。

用户裁定（2026-11-09）：

- 唤醒是**底层系统行为**：判定与模型输入归 harness/session 层，TUI 与 GUI 两端同源，上层只渲染；
- **不改 spawn / exec / 智能体团队任何提词**；
- 显示**合并为一行**：唤醒信息作为该轮 run 行的前缀，不另起一行、不用胶囊/气泡；
- 文案极简（2026-11-09 二次裁定）：显示 `后台任务 {任务名} 唤醒`，**不区分失败成功**；**多个任务只显示第一个**；任务名给人看、无业务含义就不显示花括号段；**只有任务名可点**，「后台任务」字样恒为静态文本，无名时整行无点击（统一口径）；点击任务名按归属路由页签（§6.4，三次裁定：智能体团队的打开团队管理页签）；
- 跳转定位不加闪光（对齐既有裁定「跳转不加边框/撤闪光」）：瞬跳到位，无 flash 无描边（§6.4）；
- 分派面加提示：告知模型可以不立即等待，提前结束本轮，任务完成后被唤醒继续（§4.2，已裁定）；
- 显示段 = 任务名（`title`，2026-11-07 裁定的人读名称），写入端解析一次随档；命令源码（exec 的 `label`）永不显示；
- 只做唤醒，既有队列/暂停/中断/交互一概不动。

## 1. 不变量（唯一裁决规则）

> **唤醒是状态驱动的系统事件：由「任务终态 × 未被消费 × 会话空闲」判定，不依赖模型意图，不进等待队列，不产 user 条目，不改任何既有提词与交互面；live 与恢复看到同一份模型输入，两端显示同一裁定。**

## 2. 分层

| 层 | 职责 | 落点 |
|---|---|---|
| harness | 消费标记 `receipted`；通知原文生成（复用 task_wait 回执单点） | `tasks.ts` / `task-wait.ts` |
| session（共享） | `WakeController`：登记、合批、优先级、复检、防循环；唤醒 notice 归约与落档；显示推导纯函数 | 新增 `src/session/wake.ts`；`entry.ts` / `seglog.ts` |
| 宿主（两端各一处） | 轮收束 / 空闲时问控制器要批次，有批次即 `submitWake`。与 G14.89 续跑同一位置、同一形态，各约十行胶水 | `serve/session.ts`、`tui/session.ts` |
| 渲染（两端） | run 行加唤醒前缀；不含任何判定逻辑 | GUI `EntryViews.tsx`；TUI run 状态行 |

CLI 一次性 `run` 模式随进程退出，不挂唤醒。

## 3. 唤醒判定（`WakeController`，session 层）

### 3.1 登记条件

唤醒源在 `harness/index.ts` 既有 `tasks.setOnChange` 回调内、**`boardDispatch` 显示过滤之前**分流一路终态给唤醒汇（harness 装配期由宿主注入，缺省不注入=无唤醒）——不消费 GUI 的 `bg-task` 帧（该帧按 11-03 裁定滤掉板任务行，取不到板任务终态），也不新增账本回调。任务同时满足以下条件才登记：

| 条件 | 理由 |
|---|---|
| `status ∈ {done, failed}` | `stopped` 是用户停止、owner 收割或进程退出，都属主动收口 |
| `ownerRun === 'main'` 或 `boardDispatch === true`（三次裁定） | fork 名下任务随 owner 收割（`reap('fork:…')`），由子智能体自己等待；板任务台账行（`taskboard/teammate.ts` execute 登记，label=`dispatchTag(板 id)`）生命周期归板，**纳入唤醒**（2026-11-09 三次裁定「智能体团队的也要，页签要灵活」） |
| 未 `receipted` | 本轮已经 `task_wait`/`agent_team_task_wait` 拿到回执，再唤醒就重复处理 |

消费标记：`BackgroundTask` 新增可选字段 `receipted?: boolean`，由 `task_wait` 返回某任务终态回执时置位。只在内存，不入账本：重启后运行中任务被孤儿标为 `stopped`，本就不唤醒。账本装载/收养重放不经 `onChange`，历史任务天然不唤醒。

### 3.2 时机

- **会话空闲**：首个终态到达后开 1.5s 合批窗口，窗口内到达的终态合为一批，然后起唤醒轮。
- **会话运行中**：登记进控制器私有的 `pending`，**不进 steer 队列**、不进 queue 帧、待发送区不可见。轮收束时：
  1. steer 队列非空 → 走既有 G14.89，用户消息优先，`pending` 留存；
  2. steer 队列为空 → 起唤醒轮。
- **起轮前复检**：剔除期间已 `receipted` 的任务，全部被消费就不起轮。
- **interrupted 收束**：与 G14.89「停止即停」一致，不起唤醒轮；`pending` 的去留见 §10-1。
- **防循环**：中间没有用户消息的连续唤醒轮上限 10 轮，触顶后剩余待唤醒丢弃，并落一条普通 notice「auto-wake limit reached」。

## 4. 提词策略：分派面一句话引导，其余零改动

### 4.1 现有提词下的两种自然走法（不改动也闭环）

唤醒由状态触发，不依赖模型事先知道「会被唤醒」。现有提词下模型面对后台任务只有两种走法，都闭环：

| 模型的选择 | 发生什么 | 唤醒的作用 |
|---|---|---|
| 后续步骤依赖结果 → 调 `task_wait` 阻塞 | 既有行为不变：本轮在 task_wait 上等，拿到回执继续 | 置 `receipted`，不再唤醒，无重复 |
| 不立即依赖结果 → 做完手头同步工作、输出正文、结束本轮 | 会话进入空闲（现状下这里断链） | 任务终态时起唤醒轮，模型接续 |

「自然接续」靠的是三样已有的东西：完整历史（模型自己发起任务的调用、任务 id、上轮正文交代）、唤醒通知里的回执（与 task_wait 返回同构）、通知自身的定性说明（§5.2）。系统提示不加任何关于唤醒的说明，前缀零击穿。

### 4.2 分派面提示（已裁定，本期唯一提词改动）

现状痛点：现有回执只说「poll or block with task_wait」，模型在「无同步工作可做」时最省事的出牌是原地 `task_wait` 阻塞——唤醒链路给了模型第二选项，但回执不点破它就不会用。

改动（2026-11-09 用户裁定）：后台任务**分派回执**追加一句，工具描述不动、系统提示不动：

| 落点 | 位置 |
|---|---|
| exec 转后台 | `builtin.ts` 两处回执（显式 background / 超时转后台） |
| spawn 后台 | `subagent.ts` 后台分支返回（现 `{ taskId, outputFilePath }`，回执文本处追加） |

追加句（英文单语，单点常量 `WAKE_HINT`，实现时可微调措辞）：

```text
You need not wait for it within this turn: if nothing else blocks on it now, finish your current work, reply, and end the turn — you will be woken automatically when it completes.
```

**挂载闸（硬约束——提示只出现在唤醒真能兑现的地方，否则模型收轮后无人唤醒，断链比现状更糟）：**

1. **宿主装了唤醒**：harness 装配期由宿主注入 `wakeEnabled`（GUI daemon / TUI 为真；CLI 一次性 `run` 为假）；为假时回执保持原文。
2. **主链归属**：只在 `currentOwner() === 'main'` 时追加；fork 子智能体名下任务不登记唤醒（§3.1），子面回执保持原文。
3. **板任务创建回执同样追加**：板任务已纳入唤醒（三次裁定），lead 经 `create_agent_team_task` 分派后同样可以提前收轮等唤醒——回执（`taskboard-tools.ts`）在既有 "wait with agent_team_task_wait…" 行后追加同一句 `WAKE_HINT`。工具描述、成员执行面（teammate 不经此回执）不动。

原则：**提示是可选出路，不是指令**——不否定 task_wait（后续步骤依赖结果时阻塞等待仍是正解），只告知「提前收轮、等待唤醒」同样合法，模型按上下文自行出牌。回执其余字段一概不变。

## 5. 转录与模型输入契约

### 5.1 唤醒 notice 条目（模型输入的载体）

唤醒轮的模型输入以 `kind: 'notice'` 入转录，新增可选结构化字段：

```ts
// src/session/entry.ts —— KernelEntry 新增可选字段
wake?: WakeRef[];

interface WakeRef {
  id: string;                       // 账本 id（点击跳转寻址键）
  name?: string;                    // 任务名（给人看；写入端解析一次，无业务含义则不写）
  board?: true;                     // 板任务（boardDispatch 行）——点击路由到团队管理页签，定位 ref = 板 id
}
```

不携带 status：显示不区分失败成功（裁定），回执全文在通知 md 里（模型面）。

**任务名解析**（写入端一次，渲染端零推导；无业务含义就不写 `name`，显示走通用形态）：

- exec：`title`（purpose，2026-11-07 裁定的人读名称）；**无 title 则无名**——绝不回落 `label`，exec 的 `label` 是命令原文（`execLabel` 即 cmd 原样，`builtin.ts`）；
- subagent：`title ?? label`；label 为回退段 `'subagent'`（spawn 未给 label）则无名；
- 板任务（`boardDispatch` 行）：板任务 `title`（写入时从板存储按 `label` 即板 id 取；台账行自身无 title，label 是板 id 不是人读名）；板上无 title 则无名（点击仍按板 id 定位板行）。

多任务合批只取**批内第一个**（按终态到达顺序，即 `wake[0]`）做显示；其余 id 仍在列表里，模型通知回执逐个全列。

### 5.2 md = 模型面通知原文（英文单语）

```text
<task-notification>
Automated notice, not a user message: background work you started earlier has finished.
<每个任务一段 task_wait 同款回执：id / kind / status / exit / log tail 或 conclusion>
Continue any work that was waiting on this result; if nothing remains, reply briefly.
</task-notification>
```

### 5.3 写入、落档、恢复

- **事件**：沿用 `notice` 事件，`payload.wake` 携带 `WakeRef[]`；`entry.ts` 的 notice 分支校验后回填 `entry.wake`（非法形态就丢掉该字段，退化为普通 notice）。
- **顺序**：`submitWake` 先写唤醒 notice，紧接着起 run（run-open 在后），中间不插入任何条目。转录序固定为 `wake-notice → run → …`，这是 §6 一行显示的配对依据。
- **落档**：`seglog.ts` 的 `kernelEventRows` seg 行加可选展开 `wake`，读面 `reduceSegRows` 净化回填。旧档没有该字段，就是普通 notice。
- **链重建**：`entriesToChainSteps` 现行 `notice → note(observation=md)` 不改，恢复后模型看到同一份通知原文。
- **live 起轮**：`submitWake(refs, text)`，本轮模型输入取同一份通知文本；**不调** `broadcastUserEcho`（不出气泡）。live 注入步型必须与恢复面 `note` 同口径（§10-5）。
- **显示隐藏**：`isQuietNotice` 增加一条规则 `md.startsWith('<task-notification>')`。唤醒 notice 照常归档、照常进链，但两端都不单独显示，显示职责交给 run 行（§6）。这条规则是两端共用的单点，改一处即同步。

## 6. 显示：唤醒合并进 run 行（一行）

### 6.1 配对推导（session 层纯函数，两端共用）

```ts
// src/session/wake.ts
/** run 条目的直接前驱若为唤醒 notice，返回其唤醒引用列表；否则 undefined */
export function wakeOfRun(entries: readonly KernelEntry[], runIdx: number): WakeRef[] | undefined;
```

run 行不新增字段，唤醒数据只存在 notice 上一份。配对依据是 §5.3 的固定写入顺序。

兜底：唤醒 notice 后面没有 run（比如写 notice 后进程崩溃），则该 notice 退化为独立一行静态显示通用形态「后台任务唤醒」，不静默丢失。

### 6.2 版式

```
后台任务 {构建前端} 唤醒，运行中 12 秒          ← live：既有转圈 + 计时，唤醒作前缀
───────────────────────────────────
（assistant 流式输出…）

后台任务 {构建前端} 唤醒，已运行 2 分 3 秒      ← sealed：既有折叠开关行，唤醒作前缀
后台任务 {构建前端} 唤醒，已停止                ← 用户停止
后台任务唤醒，已运行 5 秒                       ← 首个任务无名：通用形态，整行无点击
```

- 只改 run 行的文案拼接：`{唤醒前缀}，{既有状态文案}`。转圈、计时（`runElapsed`）、chevron、分割线、live/sealed 两态、G14.31 折叠一律原样。
- 普通轮（没有唤醒前驱）的 run 行零变化。

### 6.3 前缀文案（`t()` 双语，已裁定）

| 情形 | 中文 | English |
|---|---|---|
| 首个任务有名 | 后台任务 {构建前端} 唤醒 | Woken by background task {构建前端} |
| 首个任务无名 | 后台任务唤醒 | Woken by background task |

- 多任务合批只显示第一个任务名，不显示数量、不列其余任务；完整清单在页签里。
- 不区分失败成功，整行常态色调；失败态只体现在通知回执（模型面）与页签里。
- 显示段 = `wake[0].name`（§5.1 写入端解析），原样上屏、不加「」包裹；名称过长 CSS `text-overflow` 省略、`data-tip` 显全名（§13.1 规则 2，禁原生 title）。

### 6.4 交互（只有任务名可点，按任务归属路由页签）

- **统一口径**：可点击段**只有任务名** `{构建前端}`（有名时；多任务即第一个）。「后台任务」「唤醒」字样恒为静态文本；无名（通用形态）时前缀整段无点击，行为与普通 run 行一致。
- 任务名是 run 行（折叠开关，`role="button"`，点击/Enter/Space 折叠）内独立的可聚焦元素，按任务归属路由：
  - **exec / subagent** → 打开**后台任务页签**，走既有 `bgFocus` 通道 `{ id, nonce }` 定位到该账本行（exec 顺带展开详情，既有行为）；
  - **板任务（`board: true`）** → 打开**智能体团队管理页签**（`agents`），走既有 `taskFocus` 通道 `{ ref: 板任务 id, kind: 'task' }` 定位到板任务行。
- **定位不加闪光**（CLAUDE.md §13.1 规则 6）：定位 = 瞬跳到位（`scrollIntoView` 居中），无 flash、无描边、无平滑滑动——与 task_wait 行点击、板任务定位现行口径一致。
- 任务名点击**必须 `stopPropagation`**（鼠标与键盘），不触发折叠；hover 显示链接色、下划线和指针。行的其余部分（含「后台任务」字样）保持既有折叠交互。
- 历史回放：前缀随 sealed 行静态显示，与 live 同一推导。

### 6.5 TUI

run 状态行同样以 `wakeOfRun` 拼前缀：「后台任务 {构建前端} 唤醒，运行中 12s」，无名显示通用形态，无点击交互。唤醒 notice 已被 `isQuietNotice` 隐藏，不显示通知原文。

## 7. 不受影响清单

| 面 | 结论 |
|---|---|
| spawn / exec / 团队工具描述与回执 | 一字不改 |
| 系统提示与前缀缓存 | 不变（定性说明写在通知正文内） |
| 等待队列 `SteerItem` / `SteerQueue` / G14.89 续跑 | 不变：唤醒不入队，用户续跑优先 |
| `task_wait` / `agent_team_task_wait` | 行为不变；`task_wait` 仅在终态回执时置 `receipted` |
| `bg-task` 直播 / 后台任务页签 / 顶栏计数 | 不变（板任务行仍按 11-03 裁定不进后台任务面；唤醒汇在显示过滤之前分流，不改该帧） |
| run 行（转圈/计时/折叠/live·sealed） | 结构不变，仅唤醒轮拼前缀文案 |
| user 气泡、编辑/重发/rewind | 不变 |
| 旧会话档 | 无 `wake` 字段，按普通 notice 渲染与恢复 |

## 8. 场景裁定

| 场景 | 裁定 |
|---|---|
| 模型发起后台构建，做完其余工作后输出正文结束本轮；构建完成 | 1.5s 合批后起唤醒轮，模型据历史接续（如验证产物）；行显「后台任务「构建」唤醒，运行中…」 |
| 模型发起后台任务后立刻 `task_wait` 阻塞 | 既有行为；回执置 `receipted`，不唤醒 |
| 空闲时 3 个任务在 1s 内相继完成 | 合为一批，行显第一个任务「后台任务 {构建前端} 唤醒」 |
| 运行中完成，本轮未等待 | 轮收束且 steer 为空时唤醒 |
| 运行中完成，且用户另有排队消息 | 先跑用户轮，结束后再唤醒（起轮前复检 receipted） |
| 用户停止本轮（interrupted） | 不起唤醒轮；pending 去留见 §10-1 |
| 任务被用户停止（stopped） | 不唤醒 |
| fork 子智能体名下任务 | 不唤醒（由子智能体自己 `task_wait`） |
| daemon/TUI 重启 | 运行中任务被孤儿标 `stopped`，不唤醒；历史唤醒轮的前缀静态回放 |
| 唤醒轮里又起后台任务并完成 | 可再次唤醒；连续唤醒上限 10 轮 |
| 板任务（成员认领执行）完成/失败 | 纳入唤醒，lead 被唤醒接续（如解锁依赖、验收）；点击名称打开智能体团队管理页签定位板行 |
| 任务无名（exec 无 purpose / spawn 未给 label / 板上无 title） | 通用形态「后台任务唤醒」，整行无点击 |
| exec 无 purpose | 无名，走通用形态「后台任务唤醒」（命令原文永不上屏） |

## 9. 验收

- **session 单测**：notice+wake 归约（合法回填/非法丢字段）；seglog 往返（写 → 读 → `wake` 逐字段恒等，旧档无字段）；`entriesToChainSteps` 对唤醒 notice 产 `note`；`isQuietNotice` 命中唤醒 notice；任务名解析（exec 有/无 title、subagent 回退段、板任务取板 title）；`wakeOfRun` 配对、非配对、未配对兜底。
- **控制器单测**：登记条件四项；合批窗口；用户优先；receipted 剔除与全消费不起轮；interrupted 不起轮；连续上限。
- **宿主集成**：GUI daemon 与 TUI 各一条端到端用例——后台任务完成 → 唤醒轮起跑 → 转录序 `wake-notice → run`，且无 user 回显帧。
- **GUI 测试**：前缀有名（单任务 / 多任务取第一个）与无名两态拼接；exec/subagent 任务名点击发出 `bgFocus`（定位瞬跳、无 flash）、板任务名点击发出 `taskFocus`（`kind:'task'`）打开 agents 页签，均不触发折叠（鼠标与键盘）；「后台任务」字样与无名形态无可点元素（点击仅走既有折叠）；live「运行中」与 sealed「已运行/已停止」拼接；普通轮 run 行零变化。
- **分派提示测试**：exec 两处回执、spawn 后台分支、`create_agent_team_task` 回执在 `wakeEnabled` 且主链归属时含引导句；`wakeEnabled=false`（CLI run）、fork 子面、同步路径回执均保持原文。
- **回归**：gui 全量、App/Chat 既有用例、steer 队列与 task_wait 既有用例全绿；`tsc` 零错。

## 10. 待裁定

1. **interrupted 后的待唤醒**：默认**保留**，下次自然轮收束时补发；备选是直接丢弃（用户可在后台任务页签查看结果）。
2. **连续唤醒上限**：默认 10 轮，写成常量，不做配置项。
3. **合批窗口**：默认 1.5s。
4. **失败任务是否唤醒**：默认唤醒（失败更需要模型跟进）；显示不区分失败成功（已裁定），失败信息只在通知回执与任务页签里。
5. **live 步型核对（实现前必核）**：reactor 能否以 `note` 步起轮。不能时，live 与 `entriesToChainSteps` 须对唤醒 notice 同改为同一步型——两端同口径是硬约束，具体步型随实现定。
