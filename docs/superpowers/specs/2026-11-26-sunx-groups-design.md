# Sunx 群组与群聊页设计（增量规格）

- 日期：2026-11-26　分支：dev1
- 状态：**待复核**（2026-11-26 用户需求与二轮语义/视觉补充；复核通过后进入实施计划）
- 需求来源（2026-11-26 用户）：给 Sunx 增加**群组**概念，群内 Sunx 可相互发消息；左侧菜单以群组为二级分组；创建 Sunx 弹窗选择群组（下拉支持创建/筛选）；群组右侧有「新建 Sunx」与「进入群聊」两个钮，SUNX 组头的新建钮换成「新建群组」；群聊页是飞书式全宽页面（去掉右侧页签栏）；`+` 不再显示文件；`@` 改为选 Sunx 成员，支持多选与 `@全体成员`；输入框去掉上下文圆环与终端图标；右侧气泡=群主（人）输入，左侧气泡显示来源 Sunx 与 `A 发送给 B`；气泡支持 md；左侧气泡首行显示所回复的目标气泡（成员或群主），点击可跳转；群主是特殊 Sunx，群主消息走 Sunx 用户输入路径并带 `fromSunx` 归因，成员用 `send_sunx_messages` 回复群主。
- 二轮补充（2026-11-26 用户）：
  - `@全体成员` = 分派给全体成员 Sunx；气泡右下角类似飞书的 ✓，显示**接收的 Sunx 数量比例**（如 `3/5`）；点击打开接收成员名单回执；点击名单中的名字可跳到对应 Sunx。
  - 左侧气泡首行显示**回复的目标气泡**（包括成员气泡或群主气泡）；其上方显示 `SUNX 图标 {from} 发送给 SUNX 图标 {to} | 群主`。
  - 群主消息走输入框气泡的原因：一些 `/status` 系统命令也要支持发送；标群主是为了让 Sunx 通过 `send_sunx_messages` 回复消息。
- 三轮修正（2026-11-26 用户，以本节为准）：
  - **回执**：飞书式圆形饼图/圆环，显示投递成功数量；全部完成时圆内显示 √；点击打开弹窗，**左「已接收」/右「未接收」两栏，纵向滚动，固定高度**。
  - **左侧气泡**：不拆引用块——Sunx 图标+名称在气泡**上方**（位置如示意图）；气泡是一个整体，最大高度更高，底部支持展开到全部高度；气泡**第一行=所回复消息的省略（单行，不显示发送者）**，点击这一行跳到对应气泡；正文 md 在下一行开始。
  - **命令**：破坏性命令（删档/删记忆/删技能）从群输入框直接去掉，只显示可执行命令；其余可执行命令**全部可用、不设只读白名单**（群是用户自己的；其他 Sunx 也不能发命令）；`@全体成员`=全体，**无上限、无二次确认**。
  - **顶栏/侧栏**：群聊页**没有右侧页签栏**；窗口控件 `[|]` 位置换成查询图标，打开右侧查询侧栏（输入+查询按钮）搜索群消息并跳转；群聊页顶栏**只有群名称和 `⋯`**（菜单：编辑群名、复制群主 ID 等；无文件/打开方式）。
- 四轮修正（2026-11-26 用户，与三轮冲突处以本轮为准）：
  - **破坏性命令按目标收紧，不按命令封死**：`@全体成员`/多目标发送破坏性命令**禁止发出**；**恰好 1 个显式成员**时可以执行（`@A /delete` 允许，`@all /delete` 400）。其余命令任意目标。
  - **群聊页 `⋯` 菜单**固定为：新建 SUNX、编辑群名、复制群主 ID、群成员。点「群成员」弹窗展示 Sunx 列表（基本信息 + 点击跳转），不是侧栏。
  - **查询**：点 `[|]` 查询图标 → 右侧**侧栏**（占宽，消息区收窄；不是浮层、不是页签栏）。侧栏第一行是查询图标，下侧是查询接口（输入+查询按钮）；结果行显示**发送人、日期、命中信息高亮**；点击结果跳到房间对应气泡。
- 关联规格：`2026-11-14-sunx-orchestrator-design.md` §10（GUI SUNX 分组）、§17.4（跨 Sunx 对等消息，**本规格的基线**）、`2026-11-21-channels-design.md`（群聊式页面与通道域的既有边界，本规格不混用通道存储）。

---

## 0. 一句话定位

> **Sunx 群组 = 一组 Sunx 实例的通信作用域 + 一个由人（群主）观察和投递的房间。**
> 群聊页是房间的 GUI，不是新的 agent 会话；`@` 是投递，`@全体成员` 是 fan-out，环形饼图是送达回执；成员用
> `send_sunx_messages(to=群 id)` 回复群主；房间把两两消息镜像成可读时间线；群主（人）的发言经由现有
> Sunx 用户输入路径落到目标成员，普通文本带 `fromSunx` 归因，系统命令走 daemon 命令通道。

不新建 agent 运行时、不新建模型上下文、不引入 A2A 协议、不做跨群桥接。

---

## 1. 需求重述与术语

### 1.1 用户原话 → 设计含义

| 用户原话 | 设计含义 |
|---|---|
| 给一个群组的概念，每个群组内 sunx 可以相互发送消息 | 群是**通信作用域**：同群成员可互发；跨群不可见、不可投 |
| 左侧菜单以群组为二级菜单分组 | SUNX 组头（一级）→ 群组行（二级）→ Sunx 实例行（三级）；群组行可折叠 |
| 创建 sunx 弹窗选择群组，下拉支持创建群组和筛选群组 | 创建弹窗新增「群组」字段：搜索筛选 + 行内新建；从群组行 `+` 进入时预填该群 |
| 群组右侧有新建 sunx 图标；原来的 SUNX 右侧是新建群组图标换掉新建 sunx | 群组行右侧：`MessagesSquare`（进群聊）+ `SunxIcon`（在本群新建）；SUNX 组头右侧的新建钮改为「新建群组」 |
| 群组右侧有一个按钮，进入群聊页面 | 群组行 → 主区群聊层；同一时刻只开一个群聊 |
| 右侧正文提供一个类似飞书的群聊天页面，去掉侧栏 | 主区全宽覆盖层（`SchedulePage` 同款）；群聊页**没有右侧页签栏**（不渲染）；左侧 ProjectMenu 保留 |
| `+` 不再显示文件 | `+` 面板不渲染文件区（不传 session/root/workspaceFiles 即天然隐藏）；群聊页只保留**可执行命令**区 |
| `@` 替换为 sunx，就是群成员，能够 @ 几个，@ 全体成员 | `@` 面板=群成员多选 + `@全体成员`；`@all` 对全部未归档成员 fan-out（无上限/无确认） |
| 输入框去掉上下文和终端图标 | 群聊 composer 无上下文圆环、无终端入口；且无会话，模型/审批模式 pill 一并不渲染 |
| 右侧气泡正常显示用户（群主输入） | 人的发言=右侧气泡；`@` chips 与环形饼图回执挂在右侧气泡 |
| 左侧显示气泡但要显示来源 sunx | 气泡**上方**发送行=`SunxIcon + 成员名`；点击名开会话 |
| sunx 之间交流显示 sunx1 发送给 sunx2，下面气泡 | 上方发送行=`SunxIcon A 发送给 SunxIcon B`；下方气泡是单卡片，正文 md |
| 气泡支持 md 格式化显示，就是把 send_sunx_messages 内容显示到当前页面 | 左侧气泡正文=原始消息文本的 md 渲染（不含 fromSunx 前缀/回答提示行） |
| 气泡第一行显示回复消息的第一行省略，点击跳转到指定气泡 | 左侧气泡是单卡片，第一行=引用（目标首行、单行省略、无发送者），点击滚到目标气泡；正文 md 从下一行开始；卡片 480px 折叠、底部展开全部 |
| 群主可以是一个特殊的 sunx；群主的消息就是用户消息，走 sunx 的用户输入框路径 | 群主=**虚拟群身份**（`grp_` id，名「群主」，`kind:'group'`），不是可 attach 的会话；人发言即群主发言，投递到成员时是普通用户消息 |
| 发消息可以 @sunx、多个 @sunx、甚至全员就分发群主消息 | 群主消息按 mention 列表 fan-out；`@all`=全部未归档成员，无上限、无二次确认；每个目标独立回执 |
| sunx 回复时通过 send_sunx_messages 返回给群主消息 | 群 id 作为 `send_sunx_messages` 的合法 `to`；回房间；`list_sunx_peers` 列群目标 |
| `@全体` 类似飞书 ✓，显示接收的 sunx 数量比例，点击打开接收名单作回执，点击名单跳到对应 sunx | 右侧气泡右下**环形饼图**（成功占比；全部完成圆内 √）；点击开**左已接收/右未接收两栏、固定高度滚动**弹窗；点名开对应 Sunx |
| 首行显示回复的目标气泡，包括成员或者群主气泡；上面显示 SUNX 图标 {} 发送给 SUNX 图标 {} \| 群主 | 发送行在气泡**上方**（图标+名字，目标为群主时「群主」+徽标）；气泡内第一行=引用，无发送者 |
| 为什么走输入框气泡：`/status` 系统命令也支持发送 | 群主普通文本走 `submitExternal`/`steer`；系统命令走 daemon 命令直跑通道，不进入模型轮 |
| 发送为什么标群主：让 sunx 通过 send_sunx_messages 回复消息 | 投递正文带 `[fromSunx: 群主 (grp_x)]` + 回信提示；成员回群 id 即回到群主 |
| 破坏命令 @全体禁止、单个可执行；所有（可执行）命令都能用；@全体=全体无上限 | `COMMAND_SUPPORT` 全部可用；破坏四件仅恰好 1 个显式成员（@all/多目标 400）；面板带「仅单个」徽标；@all 无上限/无确认 |
| 群聊页没有右侧页签栏；`[|]` 位置换查询图标；顶部只有群名称和三个点 | 群聊页不渲染页签栏；`[|]`=查询图标（右侧查询侧栏）；顶栏=群名+`⋯`（新建 SUNX/编辑群名/复制群主 ID/群成员；无文件/打开方式/关闭） |

### 1.2 术语

| 术语 | 定义 |
|---|---|
| **Group（群组）** | 全局命名实体：`{id, name, createdAt, updatedAt}`；id 形如 `grp_xxxx`；`grp_default`=默认群 |
| **Owner（群主）** | 本机用户在该群的虚拟身份：`{id: groupId, name: '群主', kind: 'group'}`；无会话、无 agent 轮 |
| **Member（成员）** | 归属该群的真实 Sunx 实例（`meta.groupId === groupId`；缺失=默认群） |
| **Room（房间）** | 群的 append-only 消息日志；人看的时间线，**不是**任何 agent 的上下文 |
| **Dispatch（分发）** | 群主一次发言按 mention 列表投递给 N 个成员；每个目标独立送达状态 |
| **Delivery（送达）** | 一次投递结果：`ok/queued/error`；`ok`=已被目标受理（起轮或入队），不等于已完成回答 |
| **Receipt（回执）** | 右侧气泡右下的环形饼图（成功占比；全部完成圆内 √）+ 两栏弹窗（已接收/未接收） |
| **Quote（引用）** | 左侧气泡第一行的目标消息省略（单行、无发送者）；点击滚到目标气泡 |
| **Group Command（群命令）** | 群主发给成员的可执行系统命令（`COMMAND_SUPPORT` 全部；破坏四件仅单目标），由 daemon 逐目标执行 |

### 1.3 目标

1. 群组成为 Sunx 的通信作用域：同群可互发、跨群隔离；侧栏、创建弹窗、群聊页三面一致。
2. 群主可以在群聊页用 `@`/`@all` 一次性分派消息，看到每个成员的接收回执，并能一键跳到任一成员。
3. 成员之间、成员与群主之间的消息在群聊页可见、可读（md）、可引用、可跳转；不要求 agent 共享上下文。
4. 可执行系统命令（`COMMAND_SUPPORT` 全部）可以从群聊页发给成员并看到结果，不启动模型轮；破坏四件
   仅单目标，`@全体`/多目标不发出。
5. 现有两两对等消息（§17.4）语义零破坏：默认群兜底，存量实例行为不变。
6. 群聊页顶栏极简（群名+`⋯`），没有右侧页签栏；`[|]` 位置可打开右侧查询侧栏（发送人/日期/高亮），
   点结果跳转。

### 1.4 非目标（本期不做）

- 不做跨群消息/跨群桥接；不做多群归属（一个 Sunx 只属于一个群）。
- 不做群主 agent（群主不是真实会话，不推理、不自动汇总）；不做多群主/管理员角色。
- 不做“所有成员共享房间上下文”：房间是人的观察窗，不是 agent 共享记忆；成员只收到被 @ 或点对点发送的消息。
- 不做文件/图片/技能/子智能体/团队消息的群内投递（对等消息当前是纯文本）。
- 不做消息编辑、删除、撤回、已读回执、正在输入、线程回复（`N 条回复` 仅作可选增强）。
- 不做群归档、群级权限、外部 IM 群同步；不把群聊塞进通道（channels）存储。
- 不做历史对等消息回填到房间；不迁移既有实例数据（默认群读取兜底）。
- 不做群聊页多开页签（v1 是单层覆盖；后续要并行再升 tab）。
- 不做群消息全文索引/搜索高亮；查询=房间日志子串扫描 + 滚动定位。

---

## 2. 核心语义裁定（R1–R14）

> 这些是实施前必须冻结的口径；§12 列出建议复核项。

- **R1 群是通信作用域，一个实例只属于一个群。** `meta.groupId` 单值；缺失=默认群 `grp_default`。侧栏是树，不出现同一实例多行；换群=改 `groupId`，不迁移历史房间消息。
- **R2 群主是虚拟群身份，不是真实 Sunx 会话。** `SunxPeerRef {id: groupId, name: '群主', kind: 'group'}`；不能 attach、不跑 agent、不出现在 `/sunx/sessions`。成员侧仍是普通 user 气泡 + `fromSunx` 归因；`list_sunx_peers` 把群 id 作为合法回信目标。
- **R3 房间是人的观察窗，不是 agent 共享上下文。** 只有被 `@` 或点对点发送的成员收到消息；`A→B` 的旁路消息镜像到房间，但其他成员不会因此收到它。无 `@` 的群主发言是**房间内记录**（room-only），不投递、不显示饼图回执。
- **R4 群主发言=用户消息语义。** 普通文本：idle 目标 `submitExternal`（回显帧+起轮）、running 目标 `steer`（排队）；正文=`[fromSunx: 群主 (grp_id)]` + 正文 + 回答提示行；`fromSunx` 由 daemon 按群身份补全，模型不可伪造。系统命令：见 R9（不走前缀，走命令通道）。
- **R5 群作用域收口在两处。** `list_sunx_peers` 只列**同群成员 + 本群群目标**；`send_sunx_messages` 只接受同群成员或本群群 id；跨群/归档/未知目标返回英文可读错误。默认群保证存量实例仍互相可见。
- **R6 房间日志独立落盘、append-only。** 由 daemon 在投递成功的同一收口写入；不试图从任一 journal 推导房间（`A→B` 在 B 的 user 行、A 的工具行；群主发言无会话）。成员 journal 仍是该成员自己的 agent 上下文；房间只服务人看。
- **R7 引用（Quote）规则。** 群主侧：GUI 选中某条气泡「回复」时在发送请求带 `replyTo`（房间消息 id），daemon 校验同群后写入引用。成员侧：工具无 `replyTo` 参数，daemon **推断**引用——目标是群 id 时，取该成员最近收到的群主/成员消息（通常是它正在回复的那条）；目标是成员 B 时，取 B 最近发给发送者 A 的消息（即 A 正在回复的那条）；无候选则无引用。引用预览在写入时冗余存储（发送者名 + 首行，≤200 字符），分页后仍可显示。
- **R8 群聊页=主区覆盖层，不是页签。** 群聊页无右侧页签栏（不渲染 TabStrip/侧栏），保留左侧 ProjectMenu；点成员/切会话/再次点本群群行即关闭。页面状态不跨重启恢复。
- **R9 群命令：全部可执行；破坏性四件仅限单目标。** `COMMAND_SUPPORT` 全部可执行，不设只读白名单
  （`/status` `/compact` `/context` `/memory` `/memory-on|off` `/archive` `/unarchive` `/plan`
  以及破坏四件）。破坏四件（`/delete`、`/skills-rm`、`/memory-rm`、`/memory-gc`）只在**恰好 1 个显式
  @ 成员**时执行；`@全体成员` 或多目标 → 400 `destructive command requires exactly one target
  (not @all or multiple)`。面板列出全部可执行命令，破坏四件带「仅单个」徽标；手敲同样校验。其他
  Sunx 没有命令入口（对等消息里的 `/xxx` 是普通文本）。命令必须至少 1 个 @；idle-only 命令
  （`/compact` `/archive` `/unarchive` 及破坏四件）遇 running 目标 busy；未知 `/xxx` 按普通文本。
- **R10 `@全体成员`=全体，无上限、无二次确认。** 目标=发送时快照的全部未归档成员；每个目标独立投递、
  独立回执；不截断、不弹确认（输入框可显示“N 个成员”作为信息，不阻塞发送）。
- **R11 群生命周期最小集。** 建群/改名/筛选；删除仅空群（有成员返回 409）；默认群不可删；不做群归档。编辑 Sunx 可换群（写 `meta.groupId`），历史房间消息不迁移。
- **R12 群聊 composer 是精简件。** 无文件/图片/技能/子智能体/团队区（对等消息纯文本）；无模型/审批模式 pill、无上下文圆环、无终端入口（群聊页无会话）。`+` 只列**可执行命令**（破坏四件带「仅单个」徽标）；`@` 只列成员与 `@全体成员`；Enter 发送、Shift+Enter 换行。
- **R13 未读只做群行圆点（可选增强）。** 群列表带 `lastMessageAt`，GUI 用本地 seen 表比较；不做逐成员已读回执。核心验收不依赖未读。
- **R14 兼容与迁移。** 存量实例无 `groupId` 时读取兜底 `grp_default`，不做批量改写；旧 journal 的 `fromSunx` 无 `kind` 视为 `'sunx'`；两两对等消息的正文前缀/提示行保持现有格式（引用靠推断，不新增工具参数）。新 GUI 对旧 daemon（无 `/sunx/groups`）降级为平铺 SUNX 组，隐藏群组动作。
- **R15 群聊页顶栏与查询。** 群聊页没有右侧页签栏；顶栏只有群名称 + `⋯`（固定四项：新建 SUNX、编辑群名、复制群主 ID、群成员；**无文件/打开方式/关闭项**）。窗口控件 `[|]` 位置在群聊页换成查询图标，点击打开右侧查询侧栏（占宽、消息区收窄；第一行查询图标，下侧查询接口；结果行=发送人/日期/命中高亮；点击滚到对应气泡，侧栏保持打开）。

---

## 3. 数据模型

### 3.1 群组存储

- 路径：`sunxGroupsDir() = sunxContainerDir() + '-groups'`，缺省 `~/.sunshinex/sunx-groups/`；跟随
  `SUNSHINEX_SUNX_DIR` 覆盖（与域容器同源换轨）。新增于 `src/config/data-dir.ts`，不 mkdir（首次写建）。
- `groups.json`：`{ "version": 1, "groups": [ { "id": "grp_...", "name": "...", "createdAt": 173..., "updatedAt": 173... } ] }`
  - 默认群：`id='grp_default'`, `name='默认群组'`；首次读/写时惰性补种。GUI 对未改名的默认群显示
    `t('Default group', '默认群组')`（`isDefault && name === '默认群组'`）；改名后以存储名为准。
  - 名称：trim、1–60 字符、大小写不敏感唯一（重名 409）；允许中文/空格。
  - 写入：临时文件 + rename 原子替换；daemon 单写者。
- 房间：`<sunxGroupsDir>/<groupId>/room.jsonl`；只追加，不重写。
- 群删除：`groups.json` 移除 + 删 `<groupId>/` 目录（仅空群）；默认群拒绝。

### 3.2 实例归属（旁车 meta）

- `SessionSidecarMeta` 增 `groupId?: string`（`src/session/journal.ts`，与 kind/charterText/root 同级）。
- 出生写入：`SessionRuntime.persistBirthMeta()`（`src/serve/session.ts`）在 kind/title/charterRev/root 同拍写
  `groupId`；`CreateSessionOpts`（`src/serve/session-lifecycle.ts`）增 `groupId?: string`，`createSessionIn`
  透传；缺省/非法=不写键（读取兜底默认群）。
- 读取：`readSessionMeta(...).groupId`；`listSessions` 已 spread 全 meta；`GET /sunx/sessions` 的
  `enumerateContainerSessions` 行显式加 `groupId`（有效值=`meta.groupId ?? 'grp_default'`）。
- 换群：`PATCH /session/:id/group {groupId}` → 校验群存在 + 目标非归档 → `writeSessionMeta(dataDir, jid, {groupId})`；
  运行中允许（只是标签），房间历史不迁移。

### 3.3 房间日志（room.jsonl）

两种行，读者按 `t` 折叠；`msg` 顺序即展示顺序：

```jsonl
{"t":"msg","seq":1,"id":"m_1732_ab12","ts":1732000000000,"kind":"human",
 "from":{"id":"grp_x","name":"群主","kind":"group"},
 "text":"@A @B 评审一下","mentions":[{"id":"jid_a","name":"A"},{"id":"jid_b","name":"B"}],
 "mentionAll":false,"targets":[{"id":"jid_a","name":"A"},{"id":"jid_b","name":"B"}],
 "replyTo":null}

{"t":"delivery","seq":2,"msgId":"m_1732_ab12","to":"jid_a","name":"A","ok":true,"queued":false,"ts":1732000000123}
{"t":"delivery","seq":3,"msgId":"m_1732_ab12","to":"jid_b","name":"B","ok":false,"error":"attach failed","ts":1732000000456}

{"t":"msg","seq":4,"id":"m_1732_cd34","ts":1732000001000,"kind":"peer",
 "from":{"id":"jid_a","name":"A","kind":"sunx","runSeq":12},
 "to":{"id":"grp_x","name":"群主","kind":"group"},
 "text":"评审结论：……","replyTo":"m_1732_ab12",
 "replyPreview":{"from":{"id":"grp_x","name":"群主","kind":"group"},"text":"@A @B 评审一下"}}

{"t":"msg","seq":5,"id":"m_1732_ef56","ts":1732000002000,"kind":"command",
 "from":{"id":"jid_a","name":"A","kind":"sunx","runSeq":13},
 "to":{"id":"grp_x","name":"群主","kind":"group"},
 "text":"session sun-... · idle · model ... · mode ...",
 "command":"/status","replyTo":"m_1732_ab12",
 "replyPreview":{"from":{"id":"grp_x","name":"群主","kind":"group"},"text":"/status"}}
```

- **seq**：每条行（`msg`/`delivery`）都有群内单调递增序号；`msg.seq`=展示顺序，`delivery.seq`=回执
  更新顺序。追加时读末行 seq + 1（daemon 单写者，首次读缓存）。游标/增量拉取一律用 seq，不用消息 id
  ——否则 `delivery` 后到（human 消息已返回）时 `after=<lastMsgId>` 永远拉不到回执更新。

- **human**：群主（人）的发言。`targets`=发送时快照；`mentions`=显式成员；`mentionAll`=@全体；`deliveries`
  由后续 `delivery` 行折叠。`text` 保留用户原文（含 `@名字`/`@全体成员`）。
- **peer**：成员→群主或成员→成员。只记录**成功**投递；失败只进发送方工具错误，不进房间。`from` 带
  `runSeq`（发送轮锚，供房间跳转）。`to` 为群主或目标成员。
- **command**：命令结果。`from`=目标成员，`to`=群主；`text`=捕获输出；`command`=命令行；
  `replyTo`=群主那条命令消息。
- 折叠：`msg` 按 `seq` 升序返回；`delivery` 按 `(msgId,to)` 后者覆盖前者；`targets` 的未回执目标=待定；
  每个返回消息带 `updatedSeq`=其所有事件的最大 seq（供增量合并识别“老消息的新回执”）。
- 引用：`replyTo` 指向同群 `msg.id`；`replyPreview` 写入时从目标消息取 `from` + 首行（`\n` 前，
  trim，≤200 字符）。目标不存在/跨群=拒绝（群主 API 400；成员推断路径静默省略）。
- 分页/增量：默认返回最近 200 条；`before=<seq>` 向前翻；`after=<seq>` 增量拉（返回**任何事件**
  seq 大于游标的折叠后消息，包括老 human 消息新增的 `delivery` 回执）；响应带 `cursor`=本次返回
  的最大事件 seq。找不到游标（被清理/越界）= 返回最近 `limit` 并 `reset:true`，GUI 清空重载。
  单群房间超过 2 MB 时后续加轮转（本期仅记录，不实现）。
- 消息 id：`m_<base36 时间>_<4 随机>`；群 id：`grp_` + 12 位 `[A-Za-z0-9_-]`；默认 `grp_default`。

### 3.4 共享类型

```ts
export type SunxPeerKind = 'sunx' | 'group';
export interface SunxPeerRef { id: string; name: string; runSeq?: number; kind?: SunxPeerKind }

export interface SunxGroup {
  id: string; name: string; isDefault?: boolean;
  createdAt: number; updatedAt?: number;
  memberCount?: number; lastMessageAt?: number;
}

export interface SunxGroupMember {
  id: string; name: string; live: boolean; running: boolean;
  awaiting?: boolean; archived?: boolean; updatedAt: number; root: string;
}

export interface SunxRoomMessage {
  id: string; seq: number; ts: number; kind: 'human' | 'peer' | 'command';
  from: SunxPeerRef; to?: SunxPeerRef;
  text: string;
  mentions?: Array<{ id: string; name: string }>;
  mentionAll?: boolean;
  replyTo?: string;
  replyPreview?: { from: SunxPeerRef; text: string };
  targets?: Array<{ id: string; name: string }>;
  deliveries?: Array<{ to: string; name: string; ok: boolean; queued?: boolean; error?: string }>;
  command?: string;
  clientMsgId?: string; // 乐观气泡对位（发送方生成，服务端原样存）
  updatedSeq?: number;  // 折叠后面上：该消息所有事件的最大 seq（增量合并用）
  runSeq?: number;      // peer/command 的发送轮锚（与 from.runSeq 同值，便于前端直取）
}
```

- `SunxPeerInfo`（`src/harness/tools/sunx-peer-tools.ts`）增 `kind?: 'sunx' | 'group'`、`memberCount?: number`；
  群目标行填 `kind:'group'`, `id: groupId`, `name: groupName`, `live: true`, `running: false`,
  `awaiting: false`, `root: ''`, `updatedAt: lastMessageAt ?? createdAt`, `memberCount`。
- `SunxPeerSendResult` 成功面增 `kind?: 'sunx' | 'group'`，工具回执据此不变（仍 `message delivered to <name> (<id>)`；GUI 按 `grp_` 前缀识别群目标）。
- `SunxPeerRef.kind` 进 `parseSunxPeerRef`（`src/session/entry.ts`）白名单（只接受 `'sunx'|'group'`），
  经 `KernelEntry` → seg 行 → 快照/replay 全链；`gui/src/chat-reducer.ts` 同步。

---

## 4. 后端接口与投递

### 4.1 路由表（daemon，`auth: true`，与 `/sunx/*` 同族）

| 方法 | 路径 | 请求 | 响应/错误 |
|---|---|---|---|
| GET | `/sunx/groups` | — | `{groups: SunxGroup[]}`（含默认群、成员数、`lastMessageAt`；惰性补种） |
| POST | `/sunx/groups` | `{name}` | `{ok, group}`；重名 409、空名 400 |
| PATCH | `/sunx/groups/:id` | `{name}` | `{ok, group}`；未知 404、重名 409 |
| DELETE | `/sunx/groups/:id` | — | `{ok}`；有成员 409、默认群 409 |
| GET | `/sunx/groups/:id` | — | `{group, members: SunxGroupMember[], owner: {id,name,kind}}`；未知 404 |
| GET | `/sunx/groups/:id/messages` | query `after? before? limit?`（seq 游标） | `{group, messages: SunxRoomMessage[], cursor, hasMore, reset?}` |
| GET | `/sunx/groups/:id/search` | query `q, limit?`（默认 50） | `{results: Array<{id,seq,ts,from,text,kind}>}`；q 空=空列 |
| POST | `/sunx/groups/:id/send` | `{text, mentions?: string[], mentionAll?: boolean, replyTo?, clientMsgId?}` | `{ok, messageId, seq, targets}`；校验失败 400/404/409 |
| PATCH | `/session/:id/group` | `{groupId}` | `{ok, groupId}`；未知群 404、归档 409 |
| POST | `/session/new`（既有） | opts 增 `groupId?` | 出生 meta 写入；未知群 400 |
| GET | `/sunx/sessions`（既有） | — | 行增 `groupId`（有效值，缺失=默认群） |

- `mentions` 与 `mentionAll` 互斥优先：`mentionAll:true` 忽略 `mentions`；`text` 必填（trim 非空，≤4000，
  与工具同口径）。
- `POST /send` 的 `mentions` 为空且 `mentionAll` 非真：允许（room-only），`targets: []`，不显示饼图回执。
- 群命令：`text` 首个 token 命中 `COMMAND_SUPPORT` → 走命令 fan-out；若命中破坏四件且
  （`mentionAll` 或**去重后** `mentions.length !== 1`）→ 400 `destructive command requires exactly
  one target (not @all or multiple)`；其余命令任意目标。未知 `/xxx` → 普通文本。命令 + 零目标 → 400
  （选至少一个成员执行命令）。不设只读白名单：`/compact`、`/archive`、`/unarchive`、`/plan`、
  `/memory-on|off` 等都可执行；idle-only 命令遇 running 目标按该目标失败回执。

### 4.2 群列表与详情

- 群列表：读 `groups.json`（惰性补种默认群）→ 扫描 `sunxContainerDir()` 逐域 `listSessions`，按
  `meta.groupId ?? 'grp_default'` 计数（未归档）；读各房间最后一条 `msg.ts` 作为 `lastMessageAt`。
  容器不可读=空列合法空态（不建目录）。
- 群详情：同扫描 + `liveByJournal` 状态标注（live/running/awaiting），成员行排除归档；`owner` 恒
  `{id: gid, name:'群主', kind:'group'}`。成员按 `updatedAt` 降序。
- `GET /sunx/sessions` 的既有行形只加 `groupId` 一个字段；其余白名单字段不变（不泄露 charterText 全文）。

### 4.3 房间读取

- 单点读取器：解析 `room.jsonl`（坏行跳过）→ 折叠 `msg`/`delivery` → 按 seq 切片。`after=<seq>` 返回
  任何事件 seq 大于游标的折叠消息（含老消息的新回执）；`before=<seq>` 之前一页；无游标=最近 `limit`
  （默认 200，最大 500）。响应 `cursor`=本次返回的最大事件 seq（无消息时=请求游标或房间末 seq）。
- 排序=msg.seq 升序（append 顺序即权威）；`ts` 仅展示，不用于排序。
- 搜索：`GET /sunx/groups/:id/search?q=&limit=50` 扫房间消息的 `text`（human/peer/command 全含），
  大小写不敏感子串（中文按原样）；返回 `{id,seq,ts,from,text(首行预览),kind}`，按 seq 降序，最多
  `limit`。GUI 点结果按 seq 滚到消息（不在已加载窗口→向前加载到该 seq）；不做高亮闪烁。
- 群不存在=404；房间文件不存在=空消息合法（不 404）。

### 4.4 群主发送（人流）

`POST /sunx/groups/:id/send`：

1. 校验群、`text`、`replyTo`（同群存在）、mentions（必须属于本群；归档成员可入名单但记失败）。
  若命令为破坏四件：**去重后**目标必须恰好 1 个显式成员（`mentionAll` 或去重后 `mentions.length
  !== 1` → 400，**不写房间消息、不 fan-out**）。
2. 解析目标：
   - `mentionAll` → 本群全部未归档成员（快照）；零成员 409。
   - `mentions` → 按给定 id 去重保序；未知 id 400；跨群 400；归档 id 记入目标但投递失败。
3. 生成房间 `human` 消息：`targets`=目标快照；`mentions`/`mentionAll`；`replyTo`/`replyPreview`；
   `clientMsgId`（若带）；立即追加（先于 fan-out），返回 `{ok, messageId, seq, targets}`。
4. **后台 fan-out**（daemon 进程内，顺序执行，避免同时 attach 多个）：对每个目标：
   - 普通文本：`ensureLive`（未在座→`attachSunxIn`，与点侧栏同一链）→ `deliverToSession(from=群主 ref,
     to=目标, text, quote)`：idle=`submitExternal`、running=`steer`、409 回退 `steer`。正文=
     `[fromSunx: 群主 (grp_id)]` +（若有引用：`> [<name>] <首行>\n`）+ 正文 + 回信提示行。
   - 命令：`ensureLive` → `runCommand(session, line, capture, 群主 ref)`；`ok` 时捕获输出→追加房间
     `command` 消息（`from=目标`, `to=群主`, `replyTo=群主那条命令消息`）；`busy`/抛错=该目标失败
     （不写 command 消息，错误进回执）。
   - 每目标完成→追加 `delivery` 行（带新 seq；`ok/queued/error`）。
5. 失败不整单回滚：部分失败=200 + 逐目标回执；全部失败仍是 200（饼图 0/N 失败色），仅“群不存在/
   无成员/参数非法/命令不可用”是 4xx。
6. `replyTo` 引用：群主侧引用用于房间渲染；普通文本投递时把引用块放入目标成员的消息正文（模型可见）。

### 4.5 成员发送（群目标与成员目标）

`SunxPeersSeam`（daemon 注入）扩展为：

- `list()`：同群未归档成员（排己）+ **本群群目标行**；群目标行 `kind:'group'`。跨群成员不列。
- `send(to, text)`：
  - `to`=本群群 id：校验 caller 是该群成员 → 追加房间 `peer` 消息（`from=callerRef`,
    `to=群主 ref`, 推断引用）→ `{ok:true, name:群名, queued:false, kind:'group'}`。
  - `to`=同群成员：`deliverToSession(from=callerRef, to=目标, text)`（现有 idle/running/409 语义）→
    成功后追加房间 `peer` 消息（`from=callerRef`, `to=目标 ref`, 推断引用）→ 回执。
  - 跨群/归档/未知/自己：英文可读错误（`not in your group` / `archived` / `unknown or not openable`）。
- 归因：`from` 由 daemon 按 caller 会话补全（含 `runSeq`），工具壳不持身份；群目标回执的 `name`=群名，
  `id`=群 id；工具 stdout 保持 `message delivered to <name> (<id>) - <suffix>`：群目标 suffix=
  `posted to the group room`，成员目标沿用 `run started` / `queued until its current run ends`；
  GUI 按 `grp_` 前缀识别群目标。
- 命令只属于群主 fan-out：成员用 `send_sunx_messages` 发到群/成员的 `/xxx` 文本按普通消息处理
  （不执行命令）——对等工具没有命令通道，也不应远程触发目标命令。
- 推断引用（R7）：目标=群 id → 取该 caller 最近收到的群主/成员消息；目标=成员 → 取该目标最近发给
  caller 的消息；无候选省略。引用预览写入时冗余。

### 4.6 投递语义（与 §17.4 对齐）

| 目标状态 | 普通文本 | 命令 |
|---|---|---|
| idle / not open（可 attach） | `submitExternal`（用户气泡+起轮） | `runCommand`（不启动模型轮） |
| running | `steer`（排队，轮收束补跑） | `runCommand`（命令通道同步，不启动模型轮） |
| idle→running 受理竞态 409 | 回退 `steer` | 不适用（命令通道同步） |
| 归档 | 拒绝（`archived`），记失败 | 拒绝，记失败 |
| attach 失败/未知 | 拒绝，记失败 | 拒绝，记失败 |
| 自己 | 拒（工具面） | 不适用（群主不是会话） |

- “送达”=`submit/steer/runCommand` 受理；不是“回答完成”。命令的“回答”就是捕获输出。
- 房间镜像：成员→成员/群的成功投递写 `peer`；群主 fan-out 不写逐目标 `peer`（避免 N 条重复气泡），
  只写 `human` + `delivery` 行。失败不写房间。

### 4.7 工具面

- `list_sunx_peers` 输出（英文，内容原样）：
  ```
  group: <群名> [group] id=<gid> members=<n> - send here to reply to the group owner
  <成员名> [running|idle|not open, awaiting input?] id=<jid>
    root: ...
    updated: ...
    charter: ...
  ```
  群目标行置首；无同群成员时仍有群目标行。
- `send_sunx_messages`：`to` 描述改为 “Target Sunx instance id (journalId) or group id from
  list_sunx_peers. Sending to the group id replies to the group owner.”；`text` 上限 4000 不变；无新参数。
- 工具名/白名单/子面剔除维持 §17.4（`SUNX_FACE_TOOLS`、`SUNX_ORCHESTRATION_TOOLS`）；不新增工具。
- 模型面提示恒英文；群名/成员名/品性/正文原样（用户裁定“内容是什么就是什么”）。

### 4.8 错误与回执

- HTTP 错误（英文，GUI 原样展示）：`group not found`、`group name already exists`、`group has members`、
  `default group cannot be deleted`、`text required`、`text too long`、`mention not in group: <id>`、
  `unknown mention: <id>`、`replyTo not found in this group`、`destructive command requires exactly
  one target (not @all or multiple)`、`command requires at least one mentioned Sunx`、
  `group has no deliverable members`、`not a member of this group`。
- 工具错误（英文）：`cannot send_sunx_messages to <id>: not in your group`、`... archived Sunx
  instance`、`... unknown or not openable Sunx instance`、`caller session has no journal yet`。
- 部分失败不是 HTTP 错误：`deliveries` 逐项 `ok:false,error`；GUI 饼图显示比例并可展开两栏回执。

### 4.9 实时性

- 群聊页打开时：初次 `GET messages`（最近 200）→ 每 1.5 s `after=<cursor>` 轮询（游标=上次响应的
  max event seq）；窗口聚焦/发送成功后立即刷新；页面隐藏时暂停轮询。
- 房间写入后 daemon 广播轻量旁路帧 `sunx-group-changed {groupId, lastMessageAt}`（可选，P3）：侧栏
  未读点/群列表即时刷新；无帧时靠 30 s 轮询兜底。群聊页自身不依赖该帧。

---

## 5. 群命令通道（`/status` 等）

### 5.1 可用集合与目标限制（不做只读白名单）

| 命令 | 群输入框 | 执行目标 | 说明 |
|---|---|---|---|
| `/status` `/context` `/memory` | ✅ | 任意 | 只读，群内常用 |
| `/compact` | ✅ | 任意 | 用户主动压缩目标上下文；idle-only，running 时 busy |
| `/archive` `/unarchive` | ✅ | 任意 | 可逆的归档/撤销；idle-only |
| `/plan` | ✅ | 任意 | 进入目标计划模式 |
| `/memory-on` `/memory-off` | ✅ | 任意 | 切换目标记忆开关 |
| `/delete` `/skills-rm` `/memory-rm` `/memory-gc` | ✅（「仅单个」徽标） | **恰好 1 个显式成员** | `@全体`/多目标一律 400；单个可执行 |

- 集合单点：`GROUP_COMMAND_SINGLE_ONLY = ['/delete','/skills-rm','/memory-rm','/memory-gc']`
  （`src/serve/sunx-groups.ts`）。`COMMAND_SUPPORT` 全部可执行，**不是只读白名单**；只有破坏四件
  受目标数限制——单目标允许，`@all`/多目标禁止发出（用户四轮裁定：批量不可逆操作不可一键发出）。
- 群 composer 的 `/` 面板列出全部可执行命令（描述同 `GET /commands`），破坏四件带「仅单个」徽标；
  选中破坏件后若目标为 `@全体`/多个，输入框下方红色提示并阻断（同一错误 API 侧 400）。未知 `/xxx`
  →普通文本（与 Chat“不截取未知命令”同口径）。
- 命令只对**群主 fan-out** 生效：成员用 `send_sunx_messages` 发到群/成员的 `/xxx` 是普通文本，
  不执行命令、不远程触发目标命令通道（其他 Sunx 没有命令入口）。因此也不需要按 agent 做权限模型。
- idle-only 命令（`/compact`、`/archive`、`/unarchive` 及破坏四件）遇 running 目标返回 busy：
  该目标回执失败（`session is running`），不影响其他目标；成员空闲后可重发。
- 命令必须至少 @ 一个成员（否则 400）；非破坏命令可 `@全体成员`（R10 无上限）。

### 5.2 执行

- 扩展 `runCommand(s, line, capture, fromSunx?)`（`src/serve/session-commands.ts`）：
  - `s.pump({type:'user', text:line, ts, payload:{fromSunx}})`——user 行带归因，命令解析仍看原始
    `line`（首 token），**不加前缀/提示行**，所以 `/status` 能命中命令分支。
  - 现有三态 tool-call/tool-result 行不变；`capture` 收到的文本=命令结果。
- 群 fan-out 对每个目标调用 `runCommand`；没有模型轮、没有 `submitExternal`。
- 目标成员转录：user 命令气泡（上方显示「群主」归因行，点击开群聊页）+ 命令三态行；命令输出同时
  进入群房间。
- 命令输出为空→房间正文 `(no output)`；命令抛错/busy→`delivery` 失败（不写 command 消息）。
- `/status` `/context` `/memory` 在 running 会话也执行（不在 `IDLE_ONLY`）；`/compact` `/archive`
  `/unarchive` 是 idle-only，running 目标返回 busy（回执显示 `session is running`）。

---

## 6. GUI：侧栏与创建弹窗

### 6.1 侧栏树

```
SUNX  (count / board / sort / archive / new-group)
  ▾ 默认群组 (5)            [MessagesSquare] [SunxIcon] [⋯]
      • Sunx A
      • Sunx B
  ▸ 研发群 (3)              [MessagesSquare] [SunxIcon] [⋯]
  ▸ 空群 (0)  — 暂无 Sunx
```

- 数据：`GET /sunx/groups` + `GET /sunx/sessions`（行带 `groupId`）合并；`groupId` 缺失按
  `grp_default`。群行即使 0 成员也显示（空态行 `暂无 Sunx`）。
- 群行：折叠箭头 + 群名 + 成员数（未归档）；右侧 `MessagesSquare`（进群聊）、`SunxIcon`（在本群新建，
  打开创建弹窗并预填群组）、`⋯`（改名/删除；删除仅空群可用，默认群禁用）。
- 实例行：沿用 `SessionRow`（现有状态点/未读/归档确认/悬浮卡），缩进挂在群下；排序沿用 SUNX 组头
  的 updated/name（组内实例）；群行按名称 localeCompare 排序。
- 折叠态：localStorage `sunshinex.sunx-groups.collapsed`（group id 数组），默认全展开；SUNX 组头折叠
  仍整块收起。
- 活跃态：群聊页打开时对应群行高亮（`activeGroupId`）。
- 未读（P3）：群行圆点=群 `lastMessageAt` > localStorage seen；进群聊页/在底部时更新 seen。
- 归档层：不变（`archiveScope='sunx'` 行走 `attachSunxJournal`）；归档实例从群树消失，群仍显示。
- 总览页（`sunxboard`）：v1 不改分组；卡片加群名标签（P3 可选）。

### 6.2 组头动作与图标

- SUNX 组头保留：数量、看板、排序、归档；新建钮改为 `FolderPlus`（新建群组）。工具提示
  `New group` / `新建群组`。
- 群行 `MessagesSquare`：`Open group chat` / `进入群聊`；`SunxIcon`：`New Sunx in this group` /
  `在本群新建 Sunx`；`⋯`：`Rename group` / `Delete group`。
- 新群图标不复用 `UsersRound`（智能体团队语义）；实例仍用 `SunxIcon`。
- 图标尺寸 ≥14（icon-min 规则）；只用 `data-tip`，不用原生 `title`。

### 6.3 创建/编辑 Sunx 弹窗的群组字段

- `NewSunxDialog` 增「群组」字段（创建/编辑双模式）：
  - 下拉弹层=搜索框 + 群列表（按名称过滤）+ 底部「新建群组」行；行内输入名称→
    `POST /sunx/groups`→自动选中新群。重名/空名在弹层内提示。
  - 创建模式默认= `defaultGroupId`（群行 `+` 进入时=该群；顶部快捷区/总览页=默认群）；预填可改。
  - 编辑模式=当前 `meta.groupId`；可改（换群），保存走 `PATCH /session/:id/group`。
  - 群列表拉取失败：字段降级显示「默认群组」并允许提交（daemon 兜底），不阻塞创建；错误行可见。
- 提交：`newSession(..., {kind:'sunx', name, charter?, groupId})`；成功后既有打开链不变。
- 新建群组弹窗（SUNX 组头）=名称输入 + 创建/取消；成功后侧栏即时重拉，不自动打开群聊。

### 6.4 群生命周期

- 建群：1–60 字符、唯一；成功后群行出现在 SUNX 下（空群）。
- 改名：群行 `⋯` → 行内/弹窗输入；`PATCH`；群聊页标题同步（若正开）。
- 删除：仅空群；确认文案明确“删除群组（含聊天记录）”；默认群禁用并提示。
- 不做群归档、群级权限、群成员批量管理（成员在创建/编辑弹窗换群）。

### 6.5 数据与刷新

- `ProjectMenu` 新增 `conn.sunxGroups()` / `conn.createSunxGroup(name)` / `conn.renameSunxGroup` /
  `conn.deleteSunxGroup`；`useMenuSunx` 行集继续拉 `/sunx/sessions`，群树在渲染面合并。
- 建群/改名/删除/换群/新建 Sunx 成功后：重拉群列表 + Sunx 行集（现有 `bumpSunx` 链）。
- `SUNX` 组头计数=全部未归档实例；群行计数=该群未归档实例。
- 旧 daemon（无 `/sunx/groups`）→ 群列表降级为空：平铺现有 SUNX 组，群行动作隐藏；不阻塞既有功能。

---

## 7. GUI：群聊页

### 7.1 载体与“去侧栏”

- 新组件 `GroupChatPage`，主区覆盖层（`sx-group-layer`，参照 `sx-schedules-layer`：`left`=菜单实占宽，
  `position: fixed`/主区内绝对定位，z-index 低于全局弹窗/高于 Chat）。
- 群聊页**没有右侧页签栏**（不是隐藏，而是该页面不渲染）：`app-shell-panes.tsx` 的
  `aside.sx-sidebar` 在 `groupChatId !== null` 时不渲染；`TabStrip` 随之一并不在。左侧 ProjectMenu
  保留。群聊页不承载会话页签。
- 窗口控件 `[|]`（右栏开合）在群聊页换成**查询图标**（`Search` 14px）：点击打开/关闭右侧**群消息
  查询侧栏**（占宽侧栏，消息区收窄；不是页签栏、不是浮层）。侧栏第一行=查询图标+「查询」标题；下侧=
  查询输入+「查询」按钮；再下结果列表（固定宽度约 320px、全高、纵向滚动）。结果行显示**发送人、
  日期、命中信息高亮**；点击结果滚到房间对应气泡（必要时向前加载），**侧栏保持打开**（可连续跳），
  当前命中行高亮。ESC/再点图标/关闭钮收起。
- 同一时刻只开一个群；群行 `MessagesSquare` 切换 `groupChatId`（再次点本群=关闭）。关闭路径=点左栏
  其它会话/另一个群聊/设置/定时任务，或再次点本群群行的 `MessagesSquare`；顶栏没有返回钮/关闭项。
  不持久化，重启回原会话/欢迎页。
- 打开群聊不销毁底层 Chat/页签状态；关闭后原样返回。

### 7.2 布局

```
┌ 群名                                                   ⋯ ┐   ← 顶栏只有这两件
│                                                     [🔍] │   ← [|] 原位置=查询图标（窗口控件区）
│                                                          │
│                        ┌──────────────────────────────┐  │
│                        │ @A @B 评审一下          (◔)  │  │ 右侧（饼图回执）
│                        └──────────────────────────────┘  │
│  [SunxIcon] A 发送给 [SunxIcon] B                        │
│  ┌────────────────────────────────────────────────────┐  │
│  │ @A @B 评审一下…                                    │  │  ← 气泡第一行=引用（单行省略，可点跳）
│  │ 评审结论：……（md）                                  │  │
│  │                                   [展开全部]       │  │  ← 底部展开（超高时）
│  └────────────────────────────────────────────────────┘  │
│                                        21:29  [copy]     │
│                                                          │
├──────────────────────────────────────────────────────────┤
│ [引用 chip ×]                                            │
│ 输入框（@ 选成员 / 全体成员，/ 可执行命令）        [发送] │
└──────────────────────────────────────────────────────────┘
```

- 顶栏：只有**群名称**与 `⋯`。`⋯` 菜单固定四项：**新建 SUNX、编辑群名、复制群主 ID、群成员**；
  **无文件/打开方式**（不复用 ChatTopbar 菜单）。「新建 SUNX」开创建弹窗并预填本群；「群成员」开
  成员弹窗（§7.10）；「复制群主 ID」复制群 id（`grp_x`）并 toast。不进顶栏的：返回、成员数、成员
  头像、刷新、关闭——成员入口在 `⋯`→群成员与 `@` 面板。
- 消息区：底部锚定；新消息在底部时自动跟随，否则显示「新消息」胶囊；向上滚动到顶附近加载更早一页。
  查询侧栏打开时消息区按侧栏宽度收窄（不是覆盖）。
- 输入区：贴底；引用 chip 在输入框上方；`@`/`/` 面板浮在输入框上方。

### 7.3 右侧气泡（群主输入）

- 人（群主）的发言：右对齐；头像/名字可省略或显示「群主（你）」；正文 md（纯文本/命令）。
- `@` tokens 蓝色 chip（`@A`、`@B`、`@全体成员`）；点击 chip 打开对应成员会话（`@全体成员` 不跳）。
- 右下**环形饼图回执**（仅当 `targets.length > 0`）：
  - 18px 圆环：成功占比画弧（成功/总数）；全部成功=绿色实心圆 + 白色 √；部分成功=accent 弧；
    0 成功=灰/红环。`data-tip`=`k/N 已送达`（悬停/读屏）。
  - 待定在途时环按当前成功数绘制；点击打开回执浮层（§7.5）。
  - 回执只表示**受理**（起轮/入队/命令执行），不表示回答完成。
- 引用（群主回复某条左侧气泡时）：右侧气泡顶部显示引用（目标首行），点击滚到目标气泡。
- 时间/日期分隔：按自然日或 ≥5 分钟间隔显示轻量时间行。

### 7.4 左侧气泡（成员消息）

- **气泡上方**（不是气泡内）放发送行：`SunxIcon 14` + 发送者名（蓝色按钮，点击开该成员会话并定位其
  发送工具行/轮次）+ `发送给` + `SunxIcon 14` + 目标名（目标=群主时显示「群主」+ 群主徽标；点击
  目标成员名开目标会话并定位入站气泡）。图标/名称位置与示意图一致：图标+名字在气泡上方。
  - 形如：`[SunxIcon] A 发送给 [SunxIcon] B`；目标为群主：`… 发送给 [SunxIcon] 群主 ｜群主`。
- **气泡是一个整体**（不拆引用块）：高度更高，折叠最大高度 **480px**；内容超高时底部出现渐变 +
  「展开全部」条，点击展开到内容全高（消息区滚动），展开后「收起」；命令输出同样适用。
- 气泡**第一行**（`replyTo` 存在时）=所回复消息的首行省略：**单行、ellipsized、不显示发送者、不加
  「回复」前缀**；整行可点→滚到房间内目标气泡（已加载则滚；未加载则向前加载至多 3 页找 seq；找不到
  不报错）。无引用时正文从第一行开始。
- 正文：消息原文的 md 渲染（房间存的就是原文，天然没有 fromSunx 前缀/回答提示行）；代码块横向滚动；
  长文由上方 max-height/展开控制，不再按行数二次折叠。
- 命令气泡（`kind:'command'`）：同卡片；发送行右侧小徽标 `/status`；正文=命令输出（`pre-wrap` 等宽、
  保留换行/缩进）；第一行引用=群主那条命令消息。
- 时间 + 复制钮在气泡下方（对齐示意图）；成员→成员（`A 发送给 B`）与成员→群主（`A 发送给 群主`）
  同一组件，仅发送行的目标不同。
- 气泡不显示“已读/完成”；成员运行中状态只在 `⋯`→群成员与 `@` 面板显示。

### 7.5 回执：环形饼图 + 两栏名单

- 入口=右侧气泡右下环形饼图（§7.3）。点击打开 `GroupDeliveryPop`：
  - 顶部汇总 `k/N 已送达`。
  - **左栏「已接收」/右栏「未接收」**；两栏各自**固定高度（约 260px）+ 纵向滚动**，列头带计数。
  - 行：`[状态点] 成员名`（蓝色按钮）→ `openSunxInstance(memberId)`（关群聊层）；状态=已送达/
    已排队（当前轮结束后处理）/发送中/失败（附错误原文）。接收与否以 `delivery.ok` 为准。
  - 待定/失败不阻塞其他行；全部失败也展示名单；点外/ESC 关闭，不遮挡输入框。
- `@全体成员` 的目标数=发送时快照的未归档成员数；**无上限、无二次确认**；发送后新加入的成员不补发。
- 回执表示受理，不是回答完成；重试失败项为 P3 可选。

### 7.6 输入区（精简 composer）

- 结构：引用 chip（可选）+ textarea + `@` 面板 + `/` 命令面板 + 发送钮。
- **无**：文件区、图片附件、技能/子智能体/团队区（`+` 面板只列**可执行命令**，破坏四件带「仅单个」
  徽标）；模型 pill、审批模式 pill、上下文圆环、终端入口；停止/中断（群聊页没有 run）。
- `@` 面板：
  - 首行 `@全体成员`（至少 1 个可投成员时）；其后本群未归档成员（名字+状态 running/idle/not open）；
    输入过滤；↑↓/Enter；可多次插入。
  - mention 只由面板选择产生（token 映射 id）；手工敲 `@名字` 不产生投递（防重名歧义）。删除 token
    文本即移除 mention。
  - `@全体成员` 与显式成员互斥：选全体时清空显式成员，反之亦然。**@全体=全体，无上限、无确认弹窗**
    （输入框可显示“N 个成员”作为信息）。
- `/` 面板：列出 `COMMAND_SUPPORT` 全部可执行命令；破坏四件（`/delete`、`/skills-rm`、`/memory-rm`、
  `/memory-gc`）带「仅单个」徽标。插入 `/cmd `。发送时：
  - 首 token 命中 `COMMAND_SUPPORT`=命令；未知 `/xxx`=普通文本。
  - 破坏四件：目标为 `@全体` 或多个显式成员→输入框下方红色提示并阻断
    （`destructive command requires exactly one target`）；恰好 1 个显式成员→允许。
  - 命令必须至少 1 个 @ 目标（否则提示“选择至少一个成员执行命令”）；非破坏命令可 `@全体`（无上限）。
  - idle-only 命令（`/compact`、`/archive`、`/unarchive` 及破坏四件）对 running 目标的失败在回执里显示。
- 引用：任一气泡 hover 出现「回复」动作→输入框上方 chip；发送带 `replyTo`；chip 可关。
- 发送：Enter 发送、Shift+Enter 换行；空文本禁发；IME 组合中不发送；token 原子删除沿用现有 composer
  口径。无 @ 的普通文本允许发送（room-only），输入框下方轻提示“未选择成员，仅记录在群聊”。
- 发送中：乐观右侧气泡（饼图 pending），POST 返回 messageId 后归位；失败=气泡标红+错误行+保留草稿。

### 7.7 发送、乐观与轮询

- 发送流程：本地校验（群命令/@ 目标）→ `POST /send` → 用返回的 `messageId/seq/targets` 替换乐观气泡 →
  轮询 `after=<cursor>` 拉 `delivery` 更新饼图（老 human 消息的新回执也会被增量返回）；群聊页打开时
  每 1.5 s 增量。
- 去重：发送前生成 `clientMsgId` 随请求带上（房间消息原样存）；轮询回包按 `clientMsgId` 对位乐观
  气泡，避免短暂重复；服务端未存（旧档）则按 `id` 对位。
- 滚动：发送后滚到底；用户在底部时新消息自动跟随；不在底部时显示新消息计数胶囊。
- 初始加载：最近 200 条；顶部「加载更早」或在顶附近自动加载一页；`hasMore` 控制。
- 群详情/成员状态：打开时拉一次，之后每 5 s 或房间增量时刷新（成员列表/状态点/@ 面板）。

### 7.8 空态与错误

- 空群：居中「群内还没有 Sunx」+「新建 Sunx」钮（预填本群）。
- 空消息：群名 + 提示「输入 @ 选择成员，@全体成员 分发给全员」。
- 加载中：骨架/spinner；加载失败：错误行 + 重试钮（保留已加载消息）。
- 发送失败/成员跳跃失败/群被删：既有 toast（`showOpError`）；群聊页不崩，保留输入。
- 群被删（另一处删除）：轮询 404 → 提示并关闭群聊页，侧栏重拉。
- 查询侧栏：空查询=空列；无结果=「无匹配消息」；查询失败=侧栏内错误行 + 重试。

### 7.9 视觉规则

- 沿用现有设计令牌/圆角/暗码面：右侧人气泡=用户气泡同族；左侧=次级面板面（不要比正文亮，避免
  与正文抢层级）；左侧气泡是单一卡片，第一行引用仅做弱化文字（无独立底色/竖线），时间/复制在卡下。
- 环形饼图=accent/成功绿；全部完成圆内 √；部分成功只画弧，不显数字（`data-tip` 给 k/N）。
- 蓝色可点名字/`@` chip 用 accent；hover 下划线覆盖图标+名字（沿用 Sunx 归因行先例）；图标 ≥14；
  `data-tip` 不使用原生 `title`。
- md 正文用现有渲染件（`files-md`/`tool-md` 同族），暗码模式走暗底面板；长文由 480px 折叠 +
  「展开全部」控制。
- 顶栏极简（群名+⋯）；查询侧栏全高占宽、消息区收窄；亮暗两套主题都验收。

### 7.10 群成员弹窗与「新建 SUNX」

- 触发：顶栏 `⋯` →「群成员」；弹窗（portal modal，标题「群成员 · N」）。
- 内容=本群未归档 Sunx 列表（`GET /sunx/groups/:id` 的 `members`）。每行：`SunxIcon` + 名称 + 状态点
  （running/idle/not open）+ 工作区 `root` + runs/steps/最近活动（基本信息）；**点击行=**
  `openSunxInstance(memberId)`（关群聊层，复用 §8 链）；行尾可复制实例 id。
- 弹窗固定最大高度（约 420px）+ 纵向滚动；空群提示 +「新建 Sunx」钮；加载失败重试。
- `⋯` →「新建 SUNX」：打开 `NewSunxDialog`，`defaultGroupId`=当前群；创建成功→重拉群详情/成员列表
  + 侧栏群树；群聊页保持打开。与群行 `SunxIcon` 入口同一弹窗组件。

---

## 8. 定位与跳转

| 起点 | 动作 | 落点 |
|---|---|---|
| 群聊页左侧气泡**上方发送行**的发送者 | 点蓝名 | `openSunxInstance(sender)` + `sunxPeerFocus{runSeq}` → 发送轮（复用 §17.4 的 revealEntry/rAFConverge，无闪光） |
| 群聊页左侧气泡**上方发送行**的目标 | 点蓝名 | `openSunxInstance(target)` + `sunxPeerFocus{text}` → 入站气泡（末条优先） |
| 群聊页左侧气泡「目标=群主」 | 点「群主」 | 当前群聊页（no-op） |
| 群聊页环形饼图回执 | 点击 | 打开两栏回执弹窗（§7.5），不跳转 |
| 群聊页回执弹窗名单 | 点成员名 | `openSunxInstance(member)`（关群聊层） |
| 群聊页 @ chip | 点成员名 | `openSunxInstance(member)`；`@全体成员` 不跳 |
| 群聊页 `⋯`→群成员弹窗 | 点成员行 | `openSunxInstance(member)`（关群聊层；弹窗展示基本信息） |
| 群聊页气泡**第一行引用** | 点击 | 滚到房间内目标气泡（按 seq；必要时向前加载，≤3 页） |
| 群聊页 `[|]` 查询侧栏 → 结果行 | 点击 | 滚到房间内该消息（按 seq；必要时向前加载）；**侧栏保持打开**，当前结果行高亮 |
| 成员会话里的群主归因行（`fromSunx.kind==='group'`） | 点蓝名「群主」 | `openGroupChat(groupId)`（不 attach 会话） |
| 成员会话里 `send_sunx_messages` 工具行的群目标 | 点蓝名群名 | `openGroupChat(groupId)` |
| 群聊页目标成员的工具行（发送方视角） | 点蓝名成员 | 现有 `onOpenSunxBubble`：开目标会话+定位刚投递的入站气泡 |

- `sunxPeerFocus` 仍是一次性消费；群聊页关闭+开 Chat 在同一动作内完成（与现有 `openSunxPeerStable`
  同链）。目标归档/attach 失败→toast + 保留群聊页，不静默。
- 群主归因（`kind:'group'`）不携带 `runSeq`；群聊页打开即可，不做会话内定位。

---

## 9. 边界、成本与安全

1. **作用域变更**：`list_sunx_peers` 从全局变同群；默认群兜底让存量实例行为不变，但新群建立后跨群
   真的不可达。跨群协作只能移成员或后续加桥接群（非本期）。
2. **@all 成本**：无上限、无二次确认，按目标顺序 attach/投递；目标数大时 HTTP 只返回 targets、后台
   fan-out，页面靠轮询看进度；不阻塞页面。目标过多时的耗时/资源由用户自行承担；饼图回执逐项可见。
3. **房间是第二事实源**：只服务人看，不喂模型；成员 journal 仍是其 agent 上下文。不要用房间日志做
   agent 记忆或任务状态权威。
4. **命令安全**：`COMMAND_SUPPORT` 全部可执行（不是只读白名单）；破坏四件（`/delete`、`/skills-rm`、
   `/memory-rm`、`/memory-gc`）**只允许恰好 1 个显式成员**，`@all`/多目标 400，防止一键批量不可逆
   操作。命令不启动模型轮；其他 Sunx 没有命令入口（对等消息里的 `/xxx` 是普通文本）。`@all` 无上限，
   但每个目标的成功/失败都在回执里可见。
5. **归档/删除成员**：归档成员从 @ 面板/群计数排除；历史房间保留名字。删除成员后房间里的跳转失败
   →toast。@all 快照不补发新成员。
6. **群删除**：仅空群；默认群不可删；删除房间日志需确认。群改名不影响历史消息（历史只冗余发送者名，
   不冗余群名）。
7. **容器切换**：`SUNSHINEX_SUNX_DIR` 改变会改变域容器与群目录（`<容器>-groups`）；既有域/群不迁移，
   新容器从默认群开始。这是既有“切换容器对新建 Sunx 生效”的延续。
8. **版本错配**：新 GUI + 旧 daemon→`/sunx/groups` 404，降级平铺 SUNX 组并隐藏群动作；旧 GUI + 新
   daemon→旧 GUI 忽略 `groupId`，peer 作用域仍默认群，功能不炸。
9. **无回填**：房间从启用时刻开始；既有两两消息仍在各成员会话。不做 journal→房间的历史重建。
10. **无共享上下文**：`A→B` 不会推送给 C；若后续要“全员共享同一上下文”，另立规格（每消息 fan-out
    全员或房间注入），成本高一个量级。
11. **模型面英文**：前缀/提示行/工具描述/错误恒英文；群名/成员名/品性/正文/命令输出原样。GUI 文案
    走 `t()`；群名/人名是用户数据，不翻译。
12. **无消息编辑/删除**：房间只追加；群主发错只能再发一条说明；不做撤回（后续再加）。

---

## 10. 测试与验收

### 10.1 后端（新增/扩展）

- `src/serve/sunx-groups.test.ts`：
  - 群存储：默认群惰性补种、建/改名/重名 409/删空群、有成员删除 409、默认群删除 409、名称校验。
  - 归属：出生写 `groupId`、缺失兜底默认、换群端点、归档/未知群 404/409、`/sunx/sessions` 行 `groupId`。
  - 房间：human/peer/command 追加与折叠、delivery 后者覆盖、`replyTo`/引用预览、分页 after/before/reset、
    坏行跳过、`lastMessageAt`。
  - 群发送：@1/@多/@all/零 @（room-only）、目标快照、归档/未知/跨群目标失败项、部分失败 200、
    无成员 409、命令零目标 400、`replyTo` 跨群 400。
  - 群作用域：同群 list 含群目标行、跨群成员不列、`send` 到群 id 写房间、成员→成员镜像、
    归档/跨群/自己拒绝。
  - 迁移：无 `groupId` 的既有 meta 归默认群；旧 journal replay 的 `fromSunx` 无 kind 视为 sunx。
- `src/serve/sunx-peers.test.ts` 扩展：群目标行字段、群目标 send、推断引用、回执 kind。
- `src/serve/sunx-commands.test.ts`（或 session-commands 既有测试扩展）：群可用集（非破坏命令全部
  可执行）、破坏四件单目标允许/`@all`/多目标 400、`runCommand` 带 fromSunx 的 user 行、捕获输出、
  idle-only 命令 running 目标 busy、未知 `/xxx` 普通文本、命令结果房间消息、命令失败 delivery。
- 搜索：`GET search` 命中 human/peer/command、大小写不敏感、空查询空列、limit/seq 排序。
- `src/session/sunx-peer-attribution.test.ts` 扩展：`kind:'group'` 的 journal/seg 回放。
- `src/harness/sunx-face.test.ts` 扩展：`list_sunx_peers` 群目标行文本、`send_sunx_messages` 到群 id
  的回执、接缝缺席 NOT_SUPPORTED 不变。

### 10.2 GUI（新增/扩展）

- `gui/src/sidebar/project-menu-sunx.test.tsx`：群树/空群/默认群/折叠持久/计数/群行三动作/SUNX 头
  新建群组/旧 daemon 降级平铺。
- `gui/src/welcome/NewSunxDialog.test.tsx`：群组字段下拉/筛选/行内新建/创建带 groupId/编辑换群/
  拉取失败降级。
- `gui/src/pages/group/*.test.tsx`：
  - 群聊页无右侧页签栏、左侧菜单保留；`[|]` 查询图标打开**右侧查询侧栏**（第一行查询图标、输入+查询
    按钮、结果发送人/日期/命中高亮、点击滚到消息且侧栏保持打开）。
  - `⋯` 菜单固定四项：新建 SUNX（创建弹窗预填本群）、编辑群名、复制群主 ID、群成员（弹窗列表+基本信息+跳转）；
    无文件/打开方式/关闭项。
  - 右侧气泡 @ chips/环形饼图（全部完成 √、部分弧）/两栏回执弹窗（左已接收/右未接收、固定高度滚动、
    点成员跳转）/命令气泡/引用。
  - 左侧气泡**上方发送行** from→to/目标群主徽标；气泡整体 480px 折叠/底部展开全部；第一行引用单行
    无发送者、点击滚到目标；正文 md；命令输出 pre-wrap。
  - composer：@ 多选/@all 无上限/过滤/无文件无图片无上下文无终端无模型/`/` 全部命令/破坏件「仅单个」
    徽标与 @all/多目标阻断/单目标放行/无 @ 提示/引用 chip/Enter/Shift+Enter/发送失败保留草稿。
  - 轮询增量/去重/滚动跟随/新消息胶囊/加载更早/查询侧栏空态与错误。
- `gui/src/pages/chat/EntryViews` 相关：群主归因行（`kind:'group'`）点击开群聊页、前缀/hint 同剥。
- `gui/src/pages/chat/*tool*.test.tsx`：群目标工具行蓝名开群聊页、展开目标显示「群: 名 (id)」。
- 图标扫描/暗亮主题/空态/错误态。

### 10.3 场景验收（端到端）

1. 建「研发群」→ 建 A/B/C 三个 Sunx 选研发群 → 侧栏研发群下三行；默认群不包含它们。
2. 打开研发群群聊 → 无右侧页签栏、左侧菜单在；`@A @B 你好` → 右侧气泡 @ chips + 饼图 2/2（全部
   完成圆内 √）；A/B 各自会话出现「群主」归因的用户气泡；无模型伪造 `fromSunx`。
3. A 用 `send_sunx_messages(to=群id)` 回复 → 群聊左侧气泡上方 `A 发送给 [SunxIcon] 群主`，气泡第一行
   是「@A @B 你好」的单行省略（无发送者），正文 md；点该行滚到群主那条气泡；A 会话里点「群主」→
   群聊页打开；饼图弹窗点 A → A 会话打开。
4. A 给 B 发消息 → B 收到；群聊显示 `A 发送给 B`；点 A→A 的发送工具行；点 B→B 的入站气泡。
5. `@全体成员` 20 人（无上限）→ 无确认、无截断，饼图随回执填充到 20/20；其中 B running 显示已排队；
   C 归档后不再出现在目标；新加 D 不补发。
6. `@A /status` → A 会话执行命令（无模型轮），群聊出现命令气泡 `A 发送给 群主`（输出）；饼图 1/1；
   `@A /delete`（单个）允许执行；`@全体成员 /delete` 被 400 拒；`@A /archive` 在 A 空闲时执行/运行中
   回执 busy；`@A` 未知 `/foo` 按普通文本投递。
7. 无 @ 文本 → 仅右侧气泡，无饼图、无投递；输入框提示“仅记录在群聊”。
8. 跨群：研发群 A 的 `list_sunx_peers` 不含另一群 B；`send` 跨群报错。
9. 创建弹窗：筛选群、行内建「临时群」并选中；从群行 `+` 预填研发群；编辑 Sunx 换群后侧栏移动。
10. 默认群兼容：升级后既有 5 个无 groupId 的 Sunx 出现在默认群，原两两消息仍可互发。
11. 群聊页 `[|]` 查询图标 → 右侧查询侧栏（第一行查询图标，下侧输入+查询）→ 结果行显示发送人/日期/
    命中高亮 → 点结果滚到对应气泡且侧栏保持打开；`⋯` 新建 SUNX/编辑群名/复制群主 ID/群成员四项
    生效；群成员弹窗列表可跳转；左侧气泡超 480px → 底部「展开全部」→ 全高 → 收起。

### 10.4 门禁与部署

- 后端：`npm test`（clean-dist + tsc + run-tests 全绿；含新增群/命令/归因用例）。
- GUI：`npx vitest run`（已知 HEAD-red `gui/src/e2e.rewind.test.ts` 除外）；icon-min、暗亮双主题截图自检。
- 模型面英文扫描：新增前缀/提示行/工具描述/错误全英文；用户数据原样。
- 前缀稳定：普通两两对等消息的正文前缀/提示行**逐字节不变**（引用靠推断，不新增工具参数）；群发送
  普通文本沿用同形，仅 `to` 指向群 id。
- 变更面含 `src/`：`node scripts/deploy-gui.mjs reinstall --allow-dirty`；验证 `resources/app-dist/daemon.cjs`
  与 `resources/dist-gui/assets/index-*.js` 新标记 + 进程重启；纯 GUI 变更走
  `node scripts/deploy-gui.mjs deploy --allow-dirty`。

---

## 11. 分期落地

| 期 | 内容 | 交付判据 |
|---|---|---|
| **P0 后端地基** | 群存储/默认群/groupId 出生与换群；同群 peers + 群目标；房间日志/读写/折叠/搜索；群发送（@/ @all / room-only / 饼图回执）；命令可用集+破坏件单目标限制+`runCommand` 归因；`SunxPeerRef.kind` 全链；单测 | 10.1 全绿；旧两两消息回归零变化；默认群迁移用例 |
| **P1 侧栏与弹窗** | 群树/空群/折叠/计数/三动作；SUNX 头新建群组；创建弹窗群选择/筛选/行内新建/编辑换群；旧 daemon 降级 | 侧栏/弹窗用例全绿；建群→建 Sunx→归组端到端 |
| **P2 群聊页** | 覆盖层（**无右侧页签栏**）；顶栏群名+⋯ 四项菜单；群成员弹窗；`[|]` 查询图标+右侧查询侧栏；右侧/左侧气泡/上方发送行/单卡片 480px/首行引用/展开全部/md；环形饼图+两栏回执；composer @多选/@all 无上限/全部命令（破坏件仅单个）/引用；轮询/滚动/空错态 | 10.3 场景 1–9/11 通过；亮暗双主题验收 |
| **P3 收尾** | 未读圆点/群变更帧、回执重试、群名标签上总览页、`N 条回复`（可选）、spec 回写、全量门 + 部署 | 全量门绿；部署验证；用户验收 |

每期强制：后端全量 + GUI 全量 + 图标/英文/主题门禁；`src/` 变更 reinstall 验证；不夹带他批 WIP。

---

## 12. 待复核裁定（建议默认值）

> 以下 10 项是本规格的默认口径；1/2/3/4/8 会改变产品形态，复核时重点看。复核通过后按 §11 进入实施计划。

1. **群聊页=主区覆盖层，没有右侧页签栏，保留左侧菜单**；顶栏只有群名+`⋯`，菜单固定四项：新建 SUNX、
   编辑群名、复制群主 ID、群成员（弹窗列表+基本信息+跳转）；无文件/打开方式/关闭项。窗口控件 `[|]`
   换成查询图标，打开右侧查询侧栏（第一行查询图标、查询接口、结果发送人/日期/高亮、点击跳转）。
   若你要的是“连左侧菜单也去掉”，需在页内加群切换/返回，工作量增加。
2. **一个 Sunx 只属于一个群**。多群归属会让侧栏出现重复行/共享实例行，本规格不做。
3. **房间是人的观察窗，不是所有成员的共享上下文**。`A→B` 其他成员看不到；要全员共享需另立规格。
4. **群主=虚拟群身份**（`grp_` id，无会话、无 agent 轮）。若你要群主本身也推理/汇总，需加
   `ownerJournalId` 与双触发语义，另立规格。
5. **群命令=`COMMAND_SUPPORT` 全部可用；破坏四件仅单目标**（`/delete`、`/skills-rm`、`/memory-rm`、
   `/memory-gc` 只在恰好 1 个显式成员时执行；`@all`/多目标 400）。面板列出全部命令，破坏四件带
   「仅单个」徽标；不是只读白名单（2026-11-26 四轮裁定：@all 批量禁止，单个允许）。
6. **`@全体成员`=全体，无上限、无二次确认**；输入框可显示“N 个成员”作为信息，不阻塞发送。
7. **群 composer 无图片/文件/技能/子智能体/团队/模型/审批/上下文/终端**；`+` 只列可执行命令
   （破坏四件带「仅单个」徽标）。若你要房间内图片（仅人看、不投递），可加“本地图片”分支。
8. **无 @ 的群主文本=room-only**（只进房间，不投递）。若你希望默认 @全体，改这里。
9. **成员回复的引用由 daemon 推断**（目标是群→取该成员最近收到的消息；目标是成员 B→取 B 最近发给
   发送者 A 的消息），工具不新增 `replyTo` 参数；群主侧引用由 GUI 显式带 `replyTo`。若你要模型可
   显式引用任意旧消息，需在工具参数/提示行加 message id。
10. **群删除仅空群、无群归档、无历史回填**；换群不迁移历史房间消息。若你要群归档/历史迁移，另立
    小规格。

---

## 13. 附：关键文件落点（实施参考）

| 层 | 文件 | 变更 |
|---|---|---|
| 配置 | `src/config/data-dir.ts` | `sunxGroupsDir()`（`sunxContainerDir() + '-groups'`） |
| 群/房间 | `src/serve/sunx-groups.ts`（新） | 群 CRUD、成员扫描、房间 append/fold/read/search、群发送 fan-out、命令可用集/破坏件单目标限制、推断引用 |
| 对等 | `src/serve/sunx-peers.ts` | 同群 list + 群目标；`send` 路由（群/成员）；镜像；跨群/归档校验；`deliverToSession(from ref, to, text)` 核心抽取 |
| 工具 | `src/harness/tools/sunx-peer-tools.ts` | `SunxPeerInfo.kind/memberCount`；群目标行；`to` 描述；回执 kind |
| 装配 | `src/serve/session-lifecycle.ts` | `CreateSessionOpts.groupId` → SessionRuntime |
| 出生 | `src/serve/session.ts` | `persistBirthMeta` 写 `groupId`；`CreateSessionOpts.groupId` 落到运行时字段 |
| 命令 | `src/serve/session-commands.ts` | `runCommand(..., fromSunx?)`；user 行携带归因 |
| 路由 | `src/serve/daemon.ts` | `/sunx/groups*`（含 `/search`）、`/session/:id/group`、send 路由；`sunxPeersFor` 群路由 |
| 列表 | `src/serve/sessions-list-handlers.ts` | `/sunx/sessions` 行加 `groupId` |
| 元数据 | `src/session/journal.ts` | `SessionSidecarMeta.groupId` |
| 类型 | `src/types.ts`、`src/session/entry.ts`、`src/session/seglog.ts` | `SunxPeerRef.kind` 全链净化/回放 |
| GUI 数据 | `gui/src/connection.ts` / `connection-api.ts` | 群 CRUD/消息/发送/换群；`newSession` groupId；行 groupId |
| GUI 侧栏 | `gui/src/sidebar/project-menu-sunx.tsx`、`ProjectMenu.tsx`、`use-menu-sunx.ts` | 群树/群行动作/新建群组/数据合并/降级 |
| GUI 弹窗 | `gui/src/welcome/NewSunxDialog.tsx`、`NewGroupDialog.tsx`（新） | 群字段下拉/筛选/行内新建/编辑换群；新群弹窗 |
| GUI 群聊 | `gui/src/pages/group/*`（新） | 页面/列表/气泡（上方发送行/单卡片 480px/首行引用）/环形饼图+两栏回执/**群成员弹窗**/**查询侧栏**/composer/轮询 |
| GUI 装配 | `gui/src/app-shell-panes.tsx`、`App.tsx`、`use-app-tabs.ts`、`gui/src/window-shell.tsx` | 群聊层/无右侧页签栏/`groupChatId`/`[|]` 查询图标/打开关闭/群主归因跳转 |
| GUI 归因 | `gui/src/pages/chat/EntryViews.tsx`、`ToolEntry.tsx`、`tool-entry-body.tsx`、`tool-entry-data.ts`、`chat-reducer.ts` | `kind:'group'` 归因/群目标工具行/群名跳转 |
| 样式 | `gui/src/app.css` | 群聊层/群树/气泡（480px 折叠+展开）/首行引用/环形饼图/两栏回执/查询侧栏/群成员弹窗/composer/亮暗主题 |
