# 定时任务（Scheduled Tasks）设计方案

- 日期：2026-11-20　分支：dev1　状态：**待用户审阅**
- 需求来源（2026-11-20 用户）：入口在侧栏「新建 Sunx」下方；支持分/时/天/工作日/周/月/年 + 高级设置（开始时间、持续时间）；任务 = 名称 / 工作目录（含 + 新增）/ 模型强度；卡片展示 + 下次执行倒计时；支持编辑、立即执行；执行记录可跳转到详情，每条落在左侧对应项目下的会话里；每次触发模拟用户新建一个会话并发送一次任务。
- 同日裁定（用户六条）：
  1. GUI：**左侧菜单保持不动，主区整块显示定时任务**；不用弹窗，全部页内切换。
  2. **卡片两列、每卡只有三行**：任务名称 / 任务内容 / 下次执行倒计时；首行放启用开关；卡片不再显示工作目录、强度、上次结果、状态徽标。
  3. **配置页只有三行**：名称 / 调度 / 任务。调度 = 周期下拉框 + 开始时间（默认当前）+ 截止时间（默认无截止）；任务直接复用对话输入框，工作目录 / 强度 / 权限收进输入框**底部 dock**（从顶部 dock 移下来）。
  4. 「持续时间」= **截止时间**。
  5. daemon **启动时补跑一次**；执行产物 = 对应项目下的**普通会话**，不归档不特殊保留，触发时模拟用户新建一个会话并发送一次任务。
  6. 无人值守，但**权限可设置**。
- **2026-11-20 第二轮用户裁定（实现后返工，覆盖 §5.4/§9 的配置页描述）**：
  - 配置页改上下三段：**任务标题 / 调度 / 指令**；保存钮在页头右上角，不在输入框 dock。
  - **调度只有一行**，去掉开始时间；截止时间放在调度行右端（自绘月历 + 时:分，默认无截止）；周期只暴露**每小时 / 每天 / 每周 / 每月**（最大到月）。不同周期显示不同控件：小时选分钟、天选时:分、周选星期多选+时:分、月选日+时:分；自定义周期（分钟/年/多倍间隔）编辑时显示「自定义（沿用）」并原样保留，不静默改语义。
  - 所有下拉/星期多选/时间选择**全部项目自绘**（`settings/controls` 的 `Select` + `sx-dd` 弹层语言），不使用原生 `<select>` / `datetime-local`。
  - 指令区完全复用对话输入框：工作区 pill（原「＋」换成工作区选择）+ 权限 pill + 模型名（只读，定时执行沿用应用默认模型）+ 强度 pill。
  - 「在会话中创建」只让 agent 生成**时间与任务名称**；工作区、模型、权限、强度**沿用当前输入框**（工具缺省取会话当前 root/effort/mode，plan 映射工作区编辑），示例提示词缩短。
- 关联规格：`2026-11-14-sunx-orchestrator-design.md`（会话形态与域持久化）、`src/session/timer.ts`（会话内单槽调度，本期不复用）、`src/serve/session-lifecycle.ts`（建会话单点）。
- 界面示意图：`2026-11-20-scheduled-tasks-mockup.html`（单文件静态 mockup，可直接打开；列表 / 配置卡片 / 执行记录三视图可点击切换）。

---

## 0. 一句话定位

> **daemon 级全局调度器**：按本地时间计算下一次触发，到点用既有 `createSessionIn + setEffort + submit` 在目标工作目录新建一个**普通标准会话**并发送任务文本；调度定义与执行记录落 `~/.sunshinex/schedules.json`，GUI 在**主区全页平铺面**管理（左侧菜单保持不动）。

不是新引擎：调度只是「定时调用既有建会话/提交单点」，不碰主链、不引入新的会话形态。

---

## 1. 需求拆解与裁定

| 用户原话 | 设计含义 |
|---|---|
| 入口在新建 Sunx 下方 | `ProjectMenu` 顶部栈：新对话 / 新建 Sunx / **定时任务** / 搜索；dirView 态与其它两项同隐藏 |
| 分/时/天/工作日/周/月/年 | 后端结构化 `recurrence`（七个 cadence）；GUI 只暴露一个「周期」下拉（每 15 分钟 / 每小时 / 每天 / 工作日 / 每周 / 每月 / 每年），参数由开始时间锚定（§5.4） |
| 高级设置：开始时间、持续时间 | 开始时间 = 首次触发锚点 + 周期锚点；持续时间 = **截止时间**（`until`，边界含，默认无截止） |
| 任务：名称 / 工作目录 / + / 模型强度 | `name` / `prompt` / `root`（已登记工作区下拉 + 浏览登记新目录）/ `effort`；工作目录 / 模型（含强度）/ 权限全部收进任务输入框底部 dock |
| 卡片展示 + 下次执行倒计时 | **两列卡片、每卡三行**：名称 / 内容 / 倒计时；首行启用开关；`nextRunAt` 服务端权威，前端每秒本地倒计时 |
| 编辑、立即执行 | 编辑进三行配置页；立即执行在卡片「…」菜单 |
| 执行记录 + 跳转详情 | 每次运行一条记录，关联 `sessionId/journalId/root`；点击走既有 `newSession + attach` 打开会话 |
| 每次一个新会话 | 标准会话（`kind` 缺省 = standard），自然出现在对应项目分组 / RECENTS |
| GUI 和设置页一样平铺 | **左侧菜单保持原样**，主区整块切换为定时任务页；列表 / 配置 / 记录页内切换，无 modal、无二级左导航 |
| 无人值守，权限可设置 | 每任务 `mode: read-only | acceptEdits | full-access`，默认 `full-access`，权限 pill 在输入框底部 dock 且带警示色 |

---

## 2. 非目标（本期不做）

- 不做云调度 / 关机运行：daemon 不在 = 不触发，启动时补跑一次。
- 不做 cron 字符串、秒级、时区选择：最小粒度 1 分钟，统一本地时区。
- **本期 GUI 不暴露「每 N / 具体时刻」细化参数**：周期下拉=七档固定预设，锚点信息由开始时间承载；后端 `recurrence` 仍保留 `every/at/weekdays/...`，后续要放开不迁移数据。
- 不做线程式续聊 / 共享会话：每次独立新会话（与 Codex Automations 的 fresh session 同型）。
- 不做 worktree 隔离、固定模型、失败自动暂停、系统通知、跨设备同步、任务模板/克隆。
- 不复用会话内 `TimerController`：它是会话级单活跃调度位，语义是「到点唤醒本会话」。
- 不改侧栏会话的归档/删除/列表语义。

---

## 3. 架构总览

```
GUI  SchedulesPage（主区全页，左侧菜单保持）
  │  HTTP /schedules*
  ▼
GuiDaemon
  ├─ routes ──────────────► schedules/handlers.ts
  ├─ ScheduleStore ───────► ~/.sunshinex/schedules.json（原子写）
  └─ ScheduleEngine ──────► 每任务一个 setTimeout（可注入时钟）
        │ fire(plannedAt)
        ▼
     Executor
        ├─ createSessionIn(root, { mode, activate:false })
        ├─ session.setEffort(job.effort)
        ├─ session.submit(job.prompt)          ← 模拟用户发送
        ├─ writeSessionMeta(title)
        └─ session.onRunEnd(cb)                ← 回填记录状态
              │
              ▼
     SessionRuntime（standard）→ journal → /sessions → 侧栏项目分组
```

- 引擎在 daemon 装配完成后启动，`teardown()` 时停止并落盘；桌面壳单实例锁保证同一用户只有一个 daemon，不存在双触发。
- 不新增 WS 帧：定时任务面打开时轮询（10s）+ 操作后即时重拉；侧栏新会话由既有 30s tick 拾取。
- 执行走 daemon 进程内的既有会话栈，不 fork CLI、不起子进程。

---

## 4. 数据模型与持久化

### 4.1 类型（`src/serve/schedules/model.ts`）

```ts
export type CadenceUnit = 'minute' | 'hour' | 'day' | 'weekday' | 'week' | 'month' | 'year';
export type ScheduleMode = 'read-only' | 'acceptEdits' | 'full-access';
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'stopped' | 'skipped' | 'interrupted';
export type RunTrigger = 'schedule' | 'catch-up' | 'manual';

export interface Recurrence {
  unit: CadenceUnit;
  every: number;              // 1..N；weekday 档忽略
  at?: string;                // 'HH:mm'，day/weekday/week/month/year 必填
  weekdays?: number[];        // week 档：1=周一 .. 7=周日
  dayOfMonth?: number;        // month 档：1..31
  month?: number;             // year 档：1..12
  day?: number;               // year 档：1..31
}

export interface RunRecord {
  id: string;                 // run-<8hex>
  trigger: RunTrigger;
  scheduledAt?: number;       // 计划触发时刻（manual 无）
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  sessionId?: string;
  journalId?: string;
  root: string;               // 解析后的绝对路径
  error?: string;
  seconds?: number;
}

export interface ScheduleJob {
  id: string;                 // sch-<8hex>
  name: string;               // 1..80
  prompt: string;             // 1..20000
  root: string;               // 绝对路径或字面 'default'
  effort: string;             // EFFORTS 值
  mode: ScheduleMode;
  recurrence: Recurrence;
  startAt: number;            // epoch ms，首次触发锚点
  until?: number;             // 截止时间（含边界）；缺省=无限期
  enabled: boolean;
  ended?: boolean;            // 已过截止时间/无下一次
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;   // 服务端权威；null=暂停或已结束
  runs: RunRecord[];          // 每任务最近 100 条
}

export interface StoreFile { version: 1; jobs: ScheduleJob[] }
```

### 4.2 持久化

- 文件：缺省 `path.join(userConfigDir(), 'schedules.json')`（全局，跨工作区；与 pins/seen 同级）；`SUNSHINEX_DATA_DIR`（开发/测试专用重定向口）在场时落其下的 `schedules.json`——全量测试与 focused 测试都经它隔离，绝不读用户真实调度档。
- 写：临时文件 + `rename` 原子落盘；每次调度变更、每次运行状态变化都落盘。
- 读：缺失 = 空库；坏档 = 原文件改名 `schedules.corrupt-<ts>.json` 后空库启动，并在 daemon 日志留一行 warn（不阻塞启动）。
- 记录上限：每任务 `runs` 保留最近 100 条（防 JSON 无限增长）；会话本身**不归档、不删除**，留在项目下由用户处理。
- 不存 prompt 以外的敏感信息；任务提示词会落用户配置目录，文档中提示用户不要写密钥。

---

## 5. 调度语义

### 5.1 七档 cadence

| 档 | 参数 | 语义 | 示例 |
|---|---|---|---|
| 分 | every | 每 N 分钟，锚点 = startAt | 每 15 分钟 |
| 时 | every | 每 N 小时，分钟位取 startAt 的分钟 | 每 2 小时（09:07 起 → 11:07） |
| 天 | every, at | 每 N 天，HH:mm | 每天 09:00 / 每 3 天 18:30 |
| 工作日 | at | 周一至周五，HH:mm | 工作日 09:00 |
| 周 | every, weekdays, at | 每 N 周的选定星期几 | 每周一、三 10:00 / 每 2 周周五 |
| 月 | every, dayOfMonth, at | 每 N 月的第 X 号 | 每月 1 日 09:00 / 每 2 月 15 日 |
| 年 | every, month, day, at | 每 N 年的 MM-DD | 每年 1 月 1 日 / 每 2 年 6 月 1 日 |

### 5.2 通用规则

1. **本地时间**：所有 `HH:mm` 与日历日都按运行 daemon 的本地时区解释，不支持每任务时区。
2. **开始时间**：`startAt` 是相位锚点，也是最早可触发时刻；创建时若 `startAt` 已过，下一次按锚点向前推算（不立即补跑，补跑只发生在 daemon 启动）。
3. **截止时间**：`until` 含边界——`fireAt <= until` 的触发允许发生；下一次若越过 `until`，任务置 `ended=true`、`nextRunAt=null`、`enabled=false`，卡片显示「已结束」。改开始/截止或恢复可重新计算。
4. **nextRunAt 定义**：`nextRunAt(rec, startAt, after)` 返回**严格大于 `after`** 的最小合法触发时刻，且不早于 `startAt`；无解返回 null。
5. **日历步进**：
   - `month`：该月不存在 `dayOfMonth`（如 2 月 31 日）→ 跳过该月，不夹到月末。
   - `year`：2 月 29 日只在闰年触发；非闰年跳过。
   - `week`：周一为一周起点；`every>1` 以 `startAt` 所在周为第 0 周。
6. **夏令时**：按本地墙钟构造 `Date`；春季缺口（如 02:30 不存在）由 JS 归一为 03:30 触发；秋季重复小时只触发一次（取较早的那次）。
7. **校验**：`every>=1`；`at` 合法 HH:mm；`until > startAt`；`week` 的 weekdays 非空；`dayOfMonth` 1..31；`year` 的 month/day 组合合法（允许 2/29）。非法入参 400，不落盘。
8. **预览**：表单通过 `POST /schedules/preview` 拿「接下来 3 次」做实时预览，日期数学只在 daemon 侧实现一份。

### 5.3 前端展示

- 卡片第三行只显示倒计时：`<1min` 显秒，`<1h` 显分，`<24h` 显时分，否则显天时；不显示绝对时间、工作目录、强度、上次结果。
- 暂停：开关关闭，第三行「已暂停」。
- 结束：开关关闭，第三行「已结束」。
- 卡片状态只用首行开关；运行态/结果态在记录页用项目既有状态点（§9.5）。

### 5.4 GUI 周期下拉映射（用户裁定：周期=一个下拉框）

配置页只暴露一个「周期」下拉；选中项 + 开始时间一起映射为存储的 `recurrence`，**开始时间同时是周期锚点**：

| 下拉选项 | recurrence | 锚点来源 |
|---|---|---|
| 每 15 分钟 | `minute/15` | 相位取 startAt |
| 每小时 | `hour/1` | 分钟位取 startAt 的分钟 |
| 每天 | `day/1 + at` | `at` = startAt 的 HH:mm |
| 工作日 | `weekday + at` | `at` = startAt 的 HH:mm |
| 每周 | `week/1 + weekdays=[startAt 的星期] + at` | 星期取 startAt 的星期（1=周一..7=周日） |
| 每月 | `month/1 + dayOfMonth=startAt 的日 + at` | 31 日遇短月跳过（§5.2） |
| 每年 | `year/1 + month/day=startAt 的月日 + at` | 2/29 只在闰年触发 |

- 改开始时间会同时改周期锚点（例如把周五改到周一，周任务就从周一定）；表单里的「接下来 3 次」随表单实时刷新（`POST /schedules/preview`）。
- 开始时间默认当前、截止默认无截止；截止勾掉「无截止」才出现日期输入且必须晚于开始。

---

## 6. 执行管线

到点（或手动/补跑）执行单点 `runJob(job, trigger, plannedAt?, now)`：

1. **重读 job**：从 store 取最新定义；已禁用/已结束/已删除 → 直接返回。
2. **先算下一次**：`next = nextRunAt(job, after=Math.max(now, plannedAt ?? now))`；写回 `nextRunAt`；若 null → `ended=true, enabled=false`。**先落盘再执行**，执行耗时不影响下一次绝对时间。
3. **重叠检查**（仅定时/补跑）：该 job 有在途运行（内存标记或 `runs[0].status==='running'`）→ 追加一条 `skipped` 记录，返回。手动触发不受限（用户显式操作）。
4. **解析 root**：字面 `default` → `defaultScratchRoot()`（与 HTTP `/session/new` 同源）；否则绝对路径，必须存在且是目录。
5. **建会话**：`createSessionIn(io, root, { mode, activate:false })`。
   - 失败：追加 `failed` 记录（error=返回错误），返回。
   - `activate:false`：后台建会话不得抢占 daemon 的 active 会话（TUI/裸端点语义）。
6. **设置强度**：`session.setEffort(job.effort)`（非法值在校验期已挡；防御性失败回落 medium）。
7. **提交任务**：`session.submit(job.prompt)`（与用户在新会话里发第一条消息完全同路径）。
   - 失败：`session.teardown()` + 从注册表移除，追加 `failed` 记录，返回。
8. **标题与记录**：`jid = session.attachedJournalId`（submit 同步铸档；防御性最多等 50ms 轮询一次）；`writeSessionMeta(session.dataDir, jid, { title: \`${job.name} · ${MM-DD HH:mm}\` })`；追加 `running` 记录（`sessionId/journalId/root/scheduledAt/startedAt`）并落盘。
9. **收尾回填**：注册一次性 `session.onRunEnd(cb)`；cb 收到 `{stopReason, endedAt, seconds, tokens}` 后更新记录：
   - `stopReason === 'done'` → `succeeded`
   - `stopReason === 'interrupted'` → `stopped`
   - 其它/异常 → `failed`（error=stopReason 或异常文本）
   - 落盘；GUI 下一次轮询/操作即见。
10. **运行态回收**（内存卫生，用户不可见）：所有定时任务运行产生的运行时进入 LRU，最多保留 10 个已结束的；超出时对最旧且**不是 daemon active** 的运行时 `teardown()` + 从注册表移除（journal 留在磁盘，点记录会走 `newSession+attach` 重建）。job 删除时释放其最近一次运行的运行时；daemon teardown 统一由既有收口处理。

### 6.1 需要的少量底层扩面

| 位置 | 改动 | 理由 |
|---|---|---|
| `CreateSessionOpts` | 增 `activate?: boolean`（缺省 true）；增 `mode: 'read-only'` 允许值 | 后台建会话不抢焦点；只读任务 |
| `createSessionIn` | `activate===false` 时跳过 `io.setActive(id)` | 同上 |
| `SessionRuntime` | 增 `onRunEnd(cb): () => void`（run finally 后回调，携带 stopReason/seconds/tokens） | 执行记录状态回填 |
| `SessionRuntime` | 复用既有 `setEffort` / `submit` / `teardown` / `attachedJournalId` | 零新执行路径 |

`onRunEnd` 只是一次性观察者集合：run 收尾 `finally` 内清 `current` 后逐个调用，单个回调抛错只吞掉不影响收尾；GUI 打开会话的行不受影响。

---

## 7. 运行策略

| 场景 | 行为 |
|---|---|
| daemon 启动补跑 | 对每个 `enabled` 且 `nextRunAt !== null && nextRunAt <= now` 且未过 `until` 的任务，**只补跑一次**（trigger=`catch-up`，scheduledAt=原计划时刻），随后 `nextRunAt` 以 now 为基准前推；不按错过次数补 |
| 同一任务上次未跑完 | 定时/补跑跳过本次并记 `skipped`；手动触发允许并行（显式操作） |
| 系统休眠/定时器晚到 | 醒来只触发一次；记录 `scheduledAt` 与 `startedAt` 的差值（UI 可显示「延迟」） |
| 暂停 | 卡片首行开关关闭（`POST /schedules/:id/enabled {enabled:false}`）：清定时器；`enabled=false`；不动历史 |
| 恢复 | 开关打开（`enabled:true`）：以 now 为基准重新计算下一次（不补暂停期间的触发） |
| 编辑 | 全量更新定义并重新布防；在途运行不受影响；改到截止时间之前会重新计算 ended |
| 删除 | 停定时器、从 store 移除；已产生的会话保留 |
| root 被删/无权限 | 记 `failed`（error 原文），不建会话 |
| daemon 重启时记录仍为 running | 启动对账：所有 `running` 记录改 `interrupted`（error=daemon restarted），不复活运行 |
| 立即执行 | trigger=`manual`，不改 `nextRunAt`，记录照常 |
| 连续失败 | 不自动暂停（本期）；卡片显示最近失败原因 |

---

## 8. daemon API

所有端点走既有 `readJson` / `send` 与 auth 中间件；路径前缀 `/schedules`。

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| GET | `/schedules` | — | `{ now, jobs: ScheduleJobView[] }`（每 job 含 lastRun、runCount，不含 runs 全量） |
| POST | `/schedules` | `{ name,prompt,root,effort,mode,recurrence,startAt,until?,enabled? }` | `ScheduleJobView`；校验失败 400 |
| PUT | `/schedules/:id` | 同上（全量） | `ScheduleJobView`；未知 id 404 |
| DELETE | `/schedules/:id` | — | `{ ok:true }` |
| POST | `/schedules/:id/run` | — | 恒 200 `{ ok:true, runId }`；建会话/提交失败只体现为该 run 的 failed 记录（GUI 轮询可见），不把 HTTP 面做成业务错误 |
| POST | `/schedules/:id/enabled` | `{ enabled: boolean }` | `ScheduleJobView`（关=清定时器；开=以 now 重算 nextRunAt，供卡片开关用） |
| GET | `/schedules/:id/runs?limit=` | — | `{ runs: RunRecord[] }`（新→旧，上限 200） |
| POST | `/schedules/preview` | `{ recurrence,startAt,until? }` | `{ next: number[] }`（最多 3 个） |

`ScheduleJobView` = job 去掉 `runs` 大数组，带 `lastRun` 与 `runCount`；`nextRunAt` 由服务端在每次读时按当前时间与结束态校正。

---

## 9. GUI

### 9.1 入口与主区

- 侧栏 `ProjectMenu` 顶部栈插入「定时任务」（CalendarClock 图标，`sx-new-chat` 同款槽位），在「新建 Sunx」下方、「搜索」上方；dirView 态同「新建 Sunx」隐藏；入口不显任务计数。
- 点击 → `closeMenuDrawer()` + App `schedulesMain=true`。**不是页签、不是弹窗、不替换左菜单**。
- **左侧菜单保持原样**；主区（`.sx-main`）整块切换为 `SchedulesPage`，右侧标签栏同时隐藏（`sx-sidebar` 不渲染），退出后恢复原 `page`（chat/welcome）与右栏。切换采用主区层覆盖而**不卸载 Chat**（Chat 保持挂载、隐藏层下，沿用既有座位/滚动位语义，返回零重播种）。
- 顶栏复用项目既有 `.chat-topbar` + `.chat-title`（高 40、底边 `--border`）：
  - 列表态：`定时任务` + 右侧刷新图标钮 + 新建图标钮（`+`，data-tip「新建任务」）；**不显计数/说明副行**。
  - 配置/记录态：左侧 `.back` 返回钮 + 标题（`编辑定时任务` / `新建定时任务` / `任务名 · 执行记录`）。
  - 顶栏最左带菜单开合钮（复用 Chat 的 `[|]`，App 传 `toggleMenuStable`）：左侧菜单收起时也能从本页重开。
- 列表退出：点侧栏任意会话/新对话/设置；Esc 回上一页。配置/记录的顶栏返回或 Esc 回列表。
- 列表内容两列网格，最大宽约 980px，窄于 760px 自动一列；视口滚动随 `.sx-main`。

### 9.2 页内视图（点击切换，不弹窗）

```
view = { kind:'list' } | { kind:'config', editingId?: string } | { kind:'records', jobId: string }
```

- **列表**（默认）：顶栏 + 两列卡片。
- **配置**：点顶栏「+」或卡片「… → 编辑」→ 主区切到三行配置页；顶栏返回=取消（丢弃草稿）。
- **记录**：点卡片主体或「… → 执行记录」→ 主区切到该任务记录表；顶栏返回回列表。
- **回位**：从配置保存/取消返回后，列表滚动到并短暂高亮对应卡片（新建=新卡，编辑=原卡）；删除后回列表不保留高亮。
- **层级返回**：配置/记录的返回或 Esc → 列表；列表 Esc → 退出定时任务主区。

### 9.3 卡片（两列、三行）

每张卡：`background: var(--surface-elevated)`、`border-radius: var(--radius-md)`、`padding: 10px 12px`、无边框，三行：

1. **开关 + 名称 + 「…」**：开关用项目既有 `.sx-switch`（开=`--fg`、关=灰；`aria-checked`）；名称 14px/600 单行省略；「…」用 `.sx-iconbtn`，弹层用既有 `.sx-menu-pop/.sx-menuitem`。
2. **任务内容**：2 行 ellipsis，`--fg-secondary`，12.5px。
3. **下次执行**：时钟图标 + 「下次」+ 倒计时（本地每秒 tick）；暂停=「已暂停」，结束=「已结束」。
   **不显示**工作目录、强度、上次结果、启用/暂停徽标。

- 开关：`POST /schedules/:id/enabled`；关=清定时器，开=以 now 重算下一次；开关自身不做二次确认。
- 「…」菜单：立即执行 / 执行记录 / 编辑 / 删除（删除行内二次确认）。开关与菜单 `stopPropagation`；卡片主体点击进记录。
- 两列：`grid-template-columns: repeat(2, minmax(0, 1fr))`；`@media (max-width:760px)` 一列；卡宽自适应主区，不设固定 max-width。
- 空态：一行灰字「暂无定时任务」；错误条内联。
- 状态图标：卡片只用项目 `.sx-switch`；记录页状态点用项目 `.tb-status-dot`。

### 9.4 配置页（三行）

主区一张素面表单（不是大卡片），只有三行，行标签 `名称 / 调度 / 任务`：

1. **名称**：单行 input（必填，≤80）。
2. **调度**：一行三元素，窄窗自动换行：
   - 周期：原生 `<select>`，选项=**每 15 分钟 / 每小时 / 每天 / 工作日 / 每周 / 每月 / 每年**（初始「每天」）；映射见 §5.4。
   - 开始时间：`datetime-local`，默认当前；**同时是周期锚点**。
   - 截止时间：默认勾选「无截止」；取消勾选出现 `datetime-local`，必须晚于开始。
   - 调度行下一行 11.5px 灰字提示「周期以开始时间为锚点」，右侧顺带显示 preview 的第一条（不占独立行）。
3. **任务**：直接复用对话输入框 `ComposerCard`（`.sx-composer`）：
   - textarea 占位：「写清背景、目标、验收标准；每个新会话从零开始」。
   - **底部 dock**（`.sx-composer-foot`）与普通对话输入框一致，从左到右：工作目录 pill（`WelcomeProjectPop` 下拉）、「＋」登记新目录（`.composer-plus-btn`）、模型 pill（项目既有 `model-pill`：模型名 + `.model-effort-chip` 强度 chip + chevron，点开模型/强度菜单；**不再单列「强度」pill**）、权限 pill（只读/自动编辑/完全访问；完全访问挂 `mode-pill-warn` 警示色，tooltip 说明无人值守不弹审批）、右侧「保存」主钮（复用 `.send` 32px 圆钮，勾图标）。
   - 不另设「执行环境」分区；工作目录 / 模型（含强度）/ 权限全部收进这个底部 dock（用户裁定「从顶部 dock 移到底部 dock」）。

- 保存：校验通过 → 落库并布防 → 回列表定位卡片；顶栏返回=取消（丢弃草稿）。校验错误内联在对应行下。
- 不设独立 footer、不设独立预览卡；页面只有名称/调度/任务三行。

### 9.5 执行记录页

顶栏「← 返回」+「任务名 · 执行记录」；内容一张表，列：触发方式（纯文本 定时/补跑/手动）、计划时间、开始时间、状态、耗时、会话。**状态只用项目 `.tb-status-dot`**：

- 成功=`task-status-success`（accent 点）
- 失败=`task-status-failed`（err 点），错误原因用 `--err` 文本
- 跳过 / 已中断=`task-status-cancelled`（warn 点），原因灰字
- 运行中=`task-status-running`（项目 12px 转动环）

「打开会话」为 accent 文本链（无按钮边框）；补跑延迟=灰字。点击 → 退出定时任务主区 → App `openJournalSession(journalId, root)`（在座直达/否则 `newSession+attach`；失败走 `showOpError`）。

### 9.6 连接面

`gui/src/connection-types.ts` + `connection-api.ts` + `connection.ts` 增加：

```ts
schedules(): Promise<{ now: number; jobs: ScheduleJobView[] }>;
createSchedule(body: ScheduleDraft): Promise<ScheduleJobView>;
updateSchedule(id: string, body: ScheduleDraft): Promise<ScheduleJobView>;
deleteSchedule(id: string): Promise<{ ok: true }>;
runScheduleNow(id: string): Promise<{ ok: true; runId: string }>;
setScheduleEnabled(id: string, enabled: boolean): Promise<ScheduleJobView>;
scheduleRuns(id: string, limit?: number): Promise<{ runs: ScheduleRunView[] }>;
previewSchedule(body: { recurrence: ScheduleRecurrence; startAt: number; until?: number }): Promise<{ next: number[] }>;
```

### 9.7 样式纪律（用户裁定「打磨成项目一致简约风格」）

- 复用项目既有类：`.chat-topbar/.chat-title/.back`、`.sx-switch`、`.sx-composer/.sx-composer-input/.sx-composer-foot`、`.composer-pill/.composer-plus-btn/.model-effort-chip`、`.sx-menu-pop/.sx-menuitem`、`.tb-status-dot`、`.sx-iconbtn`、`.sx-new-chat`。
- 不再自造：大写分组标题、状态徽标/chip、卡片元信息行、独立「执行环境」分区、任务计数副行、大号「新建任务」按钮（改顶栏图标钮）。
- 新增类只承载布局：`.sxs-grid2`、`.sxs-card`、`.sxs-config`、`.sxs-record-table` 等；颜色/圆角/阴影全部走主题令牌。

### 9.8 文案

全部走 `t(en, zh)`；新增键：Scheduled tasks/定时任务、New task/新建任务、Run now/立即执行、Next run/下次执行、Ends at/截止时间、No deadline/无截止、Starts at/开始时间、Repeat/周期、Weekdays/工作日、Paused/已暂停、Ended/已结束、Run history/执行记录、Run permission/运行权限、Read-only/只读、Auto edit/自动编辑、Full access/完全访问等。

---

## 10. 权限与安全

- 默认 `full-access`：无人值守任务能真正完成工作；底部 dock 的权限 pill 用警示色，tooltip 明示「不会弹审批」。
- `read-only`：适合巡检/汇报类；工具面拒绝写入与命令副作用。
- `acceptEdits`：保留为高级选项；**无人值守下可能停在审批卡**（没有回执者），权限 pill 的 tooltip 提示该风险。
- `ask_question` 同样可能挂起；本期不自动应答，文档标注该限制。
- 权限只影响任务新建的会话，不改进程级安全链；用户配置目录里的 prompt 可能含敏感信息，文档提示不要写密钥。
- 任务会话与用户手动新建的会话权限档一致（`/session/:id/mode` 可随时改）。

---

## 11. 边界与已知限制

1. 应用完全退出时不会触发；只有启动补跑一次（用户裁定）。
2. 最小粒度 1 分钟；不支持秒级与 per-job 时区。
3. 每次运行都是新会话，分钟级任务会产生大量会话（用户裁定「让用户自己处理」）；daemon 内存用 10 个运行时的 LRU 兜底，侧栏不自动归档。
4. 执行记录每任务只留最近 100 条（防 JSON 膨胀）；更早的会话仍可从侧栏打开。
5. 无人值守的 `acceptEdits`/`ask_question` 可能挂起。
6. 不做 worktree 隔离：任务直接写目标工作目录；冲突/脏树由用户自行处理。
7. 固定模型不在本期：会话使用 daemon 当前默认模型，每任务只固定强度。
8. 极端情况下（被 LRU 回收的运行时正被非 active 标签页使用），标签页需要重新从记录/侧栏打开恢复（journal 在盘，不丢数据）。
9. 时钟回拨/睡眠：以墙钟为准，醒来补一次；不做单调时钟校正。

---

## 12. 测试计划

**daemon（node:test）**

- `recurrence.test.ts`：七档逐一；every>1 锚点；start 过去/未来；until 含边界与结束；week 多星期与隔周；month 31 跨 2 月跳过；year 2/29 闰年；DST 春季缺口/秋季重复（可用子进程 TZ 或仅断言本地墙钟归一）。
- `store.test.ts`：读写往返、原子写、坏档改名降级、记录 100 条截断、未知版本。
- `engine.test.ts`：假钟 arm/fire；先算下一次再执行；`enabled` 开关暂停/恢复；编辑重布防；重叠 skip；手动不改 nextRunAt；启动补跑一次；重启对账 running→interrupted。
- `daemon.schedules.test.ts`：HTTP CRUD/preview 校验、`POST /enabled` 开关；用 `ScriptedAdapter` 真跑一轮，断言新会话存在、标题、强度、mode、记录 journalId/status；root 缺失失败记录；立即执行；删除任务不影响既有会话。
- `session.onRunEnd` 单测：done/interrupted/异常三种回调与注销。

**GUI（vitest）**

- `SchedulesPage`：侧栏入口打开主区页；列表/配置/记录页切换；顶栏返回与 Esc 层级；离开主区不隐式切会话。
- 卡片：**两列**布局 + 仅三行（名称/内容/倒计时）；首行 `.sx-switch` 调用 `setScheduleEnabled`；无工作目录/强度/上次结果文本；主体点击进记录；「…」菜单四项各调用对应链；删除二次确认；从配置返回后定位并高亮对应卡片。
- 配置：**只有名称/调度/任务三行**；周期下拉七选项到 `recurrence` 的映射（含 startAt 锚点、until 默认无截止、until>start 校验）；任务输入框复用 `ComposerCard`，底部 dock 与普通输入框一致：工作目录/＋/模型（含强度）/权限/保存，**没有单独的强度 pill**；保存后回列表并定位。
- 记录表：项目 `.tb-status-dot` 状态点（成功/failed/cancelled/running）；点击记录调用 `onOpenSession(journalId, root)` 且退出定时任务主区。
- 类型检查 + 既有 chat/settings 套件回归。

---

## 13. 分阶段实施

- **P1 daemon 内核**：model/recurrence/store/engine/executor/handlers + `createSessionIn` 两键 + `onRunEnd` + 路由与 boot 生命周期 + 全部 daemon 测试。
- **P2 GUI**：connection 面、`SchedulesPage` 主区页/两列三行卡片/三行配置页（任务复用 `ComposerCard` 底部 dock）/记录页、卡片开关、侧栏入口、App 主区切换与打开会话链、样式（复用既有类）与 i18n、组件测试。
- **P3 收尾**：运行时 LRU、坏档/失败文案、全量回归（`pnpm test` + GUI typecheck/套件）、MANUAL-GUI 补一节。

---

## 14. 方案对比与放弃项

| 方案 | 结论 |
|---|---|
| **A. daemon 全局调度器 + 每次新会话（本方案）** | 推荐：复用既有建会话/提交单点，产物是普通会话，天然进项目分组；可测、可停可启 |
| B. 复用会话内 `schedule_task`/`TimerController` | 放弃：单活跃调度位、产物是子智能体转录，不满足「每次一个新会话」 |
| C. 系统 cron / 任务计划程序 + 无头 CLI | 放弃（本期）：三端差异大、凭据/并发/记录要另做；可作为后续「关机也能跑」扩展 |
| D. cron 字符串 + 第三方解析库 | 放弃：七档结构化模型更贴合 UI 与校验，零新依赖；预览/边界规则完全可控 |
