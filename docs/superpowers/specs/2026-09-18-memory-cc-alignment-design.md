# 记忆体系对齐 Claude Code 形态 · 设计规格

- 日期：2026-09-18
- 状态：待用户评审
- 承接：`docs/superpowers/specs/2026-09-18-auto-memory-design.md`（自动记忆底座，已实施收口）。本规格只做「向 CC 形态对齐的五项补齐」与两条项目级新规范落地，不改动已实现的四类提取 / 五重闸门 / 整理管线语义。
- 关联规范：`CLAUDE.md` §11（前缀缓存第一要义 + 动态改动尾追）、§5（原子工具优先）。

## §1 背景与目标

自动记忆（陈述性四类：user / feedback / project / reference）已落地并可跨会话装载。本线补的是「对标 Claude Code 记忆形态」的五项差距，以及两条新规范带来的设计约束。

| # | 对齐项 | Claude Code 形态（官方文档取证） | 本项目现状 |
|---|---|---|---|
| A1 | 会话内自写 + Saved 回执 | 模型会中自己读写记忆文件，界面显示 `Saved N memories` / `Recalled N memories` | 仅任务收口一次性独立提取 |
| A2 | 总开关 | `autoMemoryEnabled` / `CLAUDE_CODE_DISABLE_AUTO_MEMORY` / `/memory` 面板 | 无显式开关 |
| A3 | 写入时间戳 | 每次写入刷新 `modified`（ISO 8601） | 仅 `created` |
| A4 | 子代理自有记忆 | subagent `memory` 字段 + 独立目录（主记忆不进子代理，fork 例外继承） | 未做 |
| A5 | 索引将满提醒 | 接近上限提醒 + 超限「写入成功但报错」两级 | 仅超限报错一级 |

两条项目级新规范（本轮写入 `CLAUDE.md`，与本规格同批交付）：

- **N1 动态改动一律尾追**（§11，与第一要义同等）：会话运行期对「已进前缀的会话常量」（SUNSHINE.md、技能清单、记忆索引）的任何变更，一律不改写前缀、不重建快照，只在链尾追加变更说明；新内容由尾部承载、后到者优先；快照重写仍只发生在四刷新点（构造 / `reloadContext` / `resetSession` / 压缩成功）。
- **N2 原子工具优先**（§5）：能靠既有原子工具与既有工具参数完成的，不新增专属工具；**本规格不新增任何工具**，工具面零变化。

## §2 裁决台账

| 编号 | 裁决 | 来源 |
|---|---|---|
| D1 | 写入路径＝原子 `read` / `write`，不开专属记忆工具 | 用户裁决 |
| D2 | 冻结保留：会中自写不在本会话生效（索引快照不动）；模型可自行 `read` 记录文件回看 | 用户裁决 |
| D3 | 可见性＝尾追一行增量告知（一次覆盖记忆与技能，不加工具面） | 用户裁决 |
| D4 | 范围＝A1–A5 全做 | 用户裁决 |
| D5 | 程序性记忆（learned 技能）同样补控制参数 | 用户裁决 |
| D6 | 控制参数三层：env > SUNSHINE.md > 会话内命令（问卷通道故障时按推荐项收束，可单独否决） | 收束项 |
| D7 | SUNSHINE.md 支持动态改动：轮次起点读盘比对不一致即尾追变更说明；运行中模型改写同样尾追 | 用户裁决 |
| D8 | 不新增专属工具（N2） | 用户裁决 |

## §3 方案级取舍

| 分叉 | 采纳 | 否决项与理由 |
|---|---|---|
| 写入守卫位置 | 原子 `write` + 内部「记忆写入接缝」（`memory/writer.ts`） | 校验散落在 write 执行器（违反单职责、易漂移）；专属记忆工具（D1 已否决） |
| 索引维护权 | 派生制：索引由记录文件全量重建，拒直写 `MEMORY.md` | 模型自维护索引（CC 形态）——本项目索引是生成物，手改必被覆盖，制造「改了却不见了」的歧义 |
| 常驻记忆条目 | 恒在（含空集）：引导行 + 记忆目录绝对路径 + 写入协议 | 仅在有记忆时注入——空集时模型不知道能写 / 写哪 / 怎么写，会中自写形同不存在 |
| 子代理记忆注入位 | fork 私有尾块（角色行 → 记忆索引行 → 任务行） | 注入前置段——击穿「主链↔fork 首帧严格前缀连续」不变量 |
| SUNSHINE.md 变更承载 | 尾追块＝**最新磁盘全文**（超 4KB 截断 + `read` 指针） | 仅 diff 摘要——规则文本需精确可执行，diff 要求模型自行重建全文 |
| 通知通道 | 链尾说明行（模型面）+ TUI 系统行（用户面，可单独否决） | 只给模型不给用户——丢失 CC 的 Saved 回执体验 |
| 会中改写 SUNSHINE.md 的说明来源 | `write` 工具观察行后缀（同轮不追加全文块） | 同轮再追加一份全文块——与下一轮起点检测重复、链膨胀 |

## §4 写入面

### 4.1 分类器单点

新增 `src/harness/memory/paths.ts`（纯路径判定、零 IO）：

```ts
isMemoryPath(dataDir: string, absPath: string, scope?: string): 'main' | `agents/${string}` | null
```

- `scope` 供 fork 运行时收窄：子代理只可写自身 `agents/<id>/`，主链可写 `memory/**` 整子树。
- 判定施加于 **realpath 解析后的真实路径**（对齐 `chain.ts` 既有 `resolveSafe` 纪律），`..` 与符号链接逃逸自然被拒。
- 该纯模块被安全链与写入接缝共用，杜绝两处口径漂移；放置于 `memory/` 而非 `security/`，避免安全层反向依赖业务模块。

### 4.2 安全链窄口

`chain.ts` 的 `resolveSafe` 现为 `tool !== 'Write' && underDataDir(real) → allow`。改为：

```ts
// 现状（chain.ts:85-86）：
if (tool !== 'Write' && this.underDataDir(real)) return { allowed: true, safePath: real };
return { allowed: false, reason: `COMMAND_DENIED: 路径越出项目 root（真实路径）：${real}` };

// 改为（underDataDir 已内部走 resolveDataDir(this.root) + realpath 归一，记忆判定复用同一数据根）：
if (tool !== 'Write' && this.underDataDir(real)) return { allowed: true, safePath: real };
if (tool === 'Write' && isMemoryPath(resolveDataDir(this.root), real, this.memoryScope) !== null) {
  return { allowed: true, safePath: real };
}
return { allowed: false, reason: `COMMAND_DENIED: 路径越出项目 root（真实路径）：${real}` };
```

`memoryScope` 为 `SafetyChain` 新增可选构造项（`undefined` = 主链整子树；子代理 fork 传 `agents/<id>`），由 `SubagentRunner` 派生 registry 时随 run 装配注入；未注入即回退主链语义。

- 数据目录其它子树（`skills/`、`runs/`、`tool-outputs/`、`sessions/`）与项目工作区的写仍拒。
- **免审批**放行（理由：该子树属产品自身数据区、不在工作树内；逐条弹审批会摧毁「无感」语义）。总开关关闭时该放行整体失效（§7）。
- `resolveSafe` 现有注释「写面被拒，dataDir 内无法由模型植入链接」在本规格后过时，同批改写为新语义（realpath 判界 + 子树白名单），不留悬空说明。

### 4.3 写入接缝

新增 `src/harness/memory/writer.ts`：`guardMemoryWrite({ dataDir, absPath, content, scope })` → `Result<{ observation: string }>`，顺序固定：

1. 后缀必须为 `.md`，否则拒绝并给指引；
2. `MEMORY.md` 拒绝（索引属派生物，回报「请写记录文件或删记录」）；
3. 文件名（去扩展名）必须等于 `slugifyMemory(文件名)`（复用既有 slug 函数：Unicode 字母数字 + 连字符）——保证目录规范与去重身份一致；
4. `scanMemoryText(content)` 命中 temporal / injection → 拒绝（与提取路径同一闸门）；
5. frontmatter 缺 `type` / `description` → 拒绝；
6. 落盘 → 规范化 frontmatter（`type` / `created` / `description` / `modified`）→ 重建索引 → 容量判定 → 生成回执观察行。

校验**先于写入**（不落盘即无需回滚），杜绝垃圾文件进索引。回执形态（`pick` 双语）：

```text
Saved memory: <slug> [<type>] — index 12/200 lines
```

近满 / 超限时追加 §6 文案。

### 4.4 接线

`builtinTools(safety, root, kb?, webSearch?, archive?, skills?)` 增第 7 可选参 `memory?: MemoryWriteSeam`；`write` 执行器在目标命中 `isMemoryPath` 时委派接缝，**未注入接缝＝旧行为（逐字节不变）**。装配点：`harness/index.ts`（`base` 数据根已在此）、`runtime.ts`。本规格**不新增工具、不改工具描述**：工具清单与稳定段零变化。

## §5 记录与索引

- `MemoryRecord` 增 `modified: string`（ISO 8601，每次写入刷新）；缺该字段的旧记录解析回退 `created`（零迁移）；无 frontmatter 的裸文件维持既有「零覆盖」语义。
- `MemoryStore` 新增 `put({ slug, type, description, body })`：同 slug 视为**更新**（去重自排除 + 刷新 `modified`），不存在则**创建**（跨记录三级去重照旧）。`add()`（提取路径，slug 由 description 派生）保留；两者共用去重 / 规范化 / 重建 / 容量内部件。目的：会中改写一条记忆不产生 `-2` 副本。
- 目录布局：主链 `<dataDir>/memory/`；子代理 `<dataDir>/memory/agents/<id>/`（`MemoryStore` 增显式目录构造变体，缺省仍为 `<dataDir>/memory`）。
- 索引条目行维持派生气质（由 `description` + `type` 生成），模型无需也不得手改。

## §6 容量两级

- `overLimit()` 保持：>200 行 / 25KB → **写入成功 + 报文勒令精简**（CC 语义）。
- 新增 `capacityNotice(): string | null`：≥80%（160 行 / 20KB）返回提醒 → 拼进写回执（`index 168/200 lines — consolidate entries`），并在 `/memory` 列表尾部展示。
- 硬超限仍是错误，近满只是提醒——两级不合并。

## §7 控制面

三层优先级（高→低）：环境变量 → SUNSHINE.md `## 记忆` 分区 → 会话内命令。

| 参数 | env | SUNSHINE.md `## 记忆` | 会话内 |
|---|---|---|---|
| 陈述性记忆总开关 | `SUNSHINEX_AUTO_MEMORY=off` | `auto_memory: on\|off` | `/memory on\|off` |
| 程序性记忆开关 | `SUNSHINEX_LEARNED_SKILLS=off` | `learned_skills: on\|off` | — |
| 技能沉淀上限 | `SUNSHINEX_LEARNED_SKILL_LIMIT=<n>` | `learned_skill_limit: <n>`（缺省 50） | — |

- 解析单点：新增 `src/config/memory-config.ts`（形态对齐 `config/data-dir.ts` 先例），非法值**装配期 fail-fast**（沿用 agents / MCP 装配纪律）。
- 关闭语义贯通四处：①不注入记忆条目 ②不提取 ③不沉淀 / 不整理 ④写记忆被安全链拒。不做局部半开。
- `opts.learnSkills`（现硬编码 `?? true`）与 `MAX_LEARNED_SKILLS = 50` 一并改由该配置驱动。
- `/memory on|off` 仅本会话生效、**不落盘**，回执提示「持久化请改 SUNSHINE.md」；不改写 SUNSHINE.md（避免意外文件变更，且与冻结语义冲突）。开关状态不进提示词、不改变装配字节。

## §8 子代理自有记忆

- `agents/{id}/agent.md` frontmatter 增可选 `memory: true`（`parseAgentFrontmatter` 扩一字段；缺省关）。
- 开启后：独立目录 `<dataDir>/memory/agents/<id>/`；fork 组装在 `roleLine` 与 `taskLine` 之间插入一行记忆索引（`subagent.ts` fork 组装单点扩展），主链零回写、不进主快照，保持「主链↔fork 首帧严格前缀连续」。
- 子代理写入走同一分类器与同一接缝，安全链 scope 收窄到自身目录；回执只落在其私有流。
- 主记忆仍随冻结快照被 fork 继承（对齐 CC「fork 例外继承」）。
- 不做子代理记忆自动提取（YAGNI：子代理无 settle 提取管线；其沉淀由主链决定是否显式派生写入）。

## §9 动态改动尾追（N1 落地）

### 9.1 单点与调用时序

`ContextManager` 增 `appendInstructionLine(observation: string): string[]`：先 `checkConstantsDrift()` 尾追说明行，再尾追指令行，返回本次说明文本供交互面展示。现有指令行落点（`tui/session.ts` 主任务与 plan 步、`cli/run.ts`）统一改走该方法，杜绝多调用处漂移。**任务指令恒为链尾最后一行**（顺序不变）。

### 9.2 SUNSHINE.md 漂移检测

`ContextManager` 在刷新点捕获两份基线：`sunshinexBaseline`（`ContextLoader` 读到的 SUNSHINE.md 原文，`loader.ts` 需暴露原文）与 `skillsBaseline`（技能清单 id 集）。`checkConstantsDrift()` 读盘比对：

- SUNSHINE.md 不一致 → 尾追块：

```text
SUNSHINE.md changed (session snapshot is stale; the text below is authoritative until the next refresh point):
<最新磁盘全文；超 4KB 截断并附 read <绝对路径> 指针>
```

- 技能清单新增 / 变更 → 尾追一行 `[skills] added: <id, …> — load with skill tool`；正文仍按 id 实时读盘、置尾注入（`skill` 工具现为每调用实时扫盘）。
- 检测是**确定性运行时行为、零模型调用**；每步一次文件读 + 字符串比对，开销可忽略。

### 9.3 会中模型改写 SUNSHINE.md

`write` 目标为 `<root>/SUNSHINE.md` 时，接缝在观察行补一句 `SUNSHINE.md rewritten — session snapshot is stale until the next refresh point`；**同轮不追加全文块**（下一轮起点由 §9.2 统一尾追，避免重复与链膨胀）。

### 9.4 记忆与技能产物

settle 单点（`reactor.ts` 收口）在提取 / 沉淀后尾追 `[memory] saved: <slug, …> — read <dir>/MEMORY.md to recall` / `[skills] learned: <id>`（技能上限 FIFO 淘汰同样留痕）。该行不参与任务成败判定。

### 9.5 通用面

外部编辑、他处变更与已读文件变动一律以尾追说明行表达；禁止把新内容插回前置段、禁止回改历史行、禁止为「让改动生效」提前重建快照。

## §10 会话内可见性

- **模型面**：§9 的链尾说明行（append-only）＋ 写入回执（工具观察行）。
- **用户面**：会话事件面新增 `notice` 事件（payload `{ source: 'sunshine-md' | 'skills' | 'memory', text }`），TUI 落一行系统消息（对标 CC 的 `Saved N memories` 回执）。**可单独否决**——否决后仅保留模型面。

## §11 前缀与不变量

- **冻结不动**：记忆索引、技能清单、SUNSHINE.md 仍只进冻结快照，四刷新点重建；会中任何变更不触发重载。
- **尾追豁免**：说明行、工具观察、fork 私有记忆行全部落在链尾。
- **一次性版本断点**（登记、一次性）：空集也注入记忆引导条目（§3）。本规格不引入其它断点（不新增工具）。
- **回归断言**：①相邻帧前缀逐字节不变（含 SUNSHINE.md / 技能 / 记忆变更场景）②主链↔fork 首帧严格前缀连续（含子代理记忆注入态）。

## §12 验收矩阵

1. **前缀稳定**：会中写记忆、改写 SUNSHINE.md、新增技能后，相邻帧前缀逐字节不变，变更只出现在链尾。
2. **fork 连续**：开启子代理记忆后，fork 首帧仍与主链末帧严格前缀连续，私有步骤零主链回写。
3. **冻结语义**：会中自写不改变本会话索引字节；模型可 `read` 到刚写的记录文件（工具响应恒为 live）。
4. **安全面**：仅 `<dataDir>/memory/**`（含 agents 子树、fork 按 scope 收窄）可写；`..` 与符号链接逃逸、非 `.md`、`MEMORY.md`、注入 / 临时词命中一律拒；数据目录其它子树与项目工作区仍拒。
5. **开关生效**：`SUNSHINEX_AUTO_MEMORY=off` → 不注入 / 不提取 / 不整理 / 写被拒；`SUNSHINEX_LEARNED_SKILLS=off` → 不沉淀；`learned_skill_limit` 生效；非法值装配期 fail-fast。
6. **容量两级**：近满提醒出现在写回执与 `/memory` 列表；硬超限保持「写成功 + 报错」。
7. **时间戳与更新**：`modified` 每次写入刷新；缺字段旧记录回退 `created`；同 slug 更新不产生 `-2` 副本。
8. **子代理**：仅开启 `memory` 的 agent 有目录；索引只进私有尾块；未开启者无目录、无注入。
9. **动态改动**：SUNSHINE.md 轮次起点比对 → 尾追全文块（含截断 + 指针）；模型会中改写 → 观察行后缀且下一轮起点统一尾追；技能清单增量尾追一行。
10. **工具面零变化**：工具清单、工具描述与稳定段字节在本规格实施前后逐字节一致（除 §11 登记的引导条目断点）。
11. **回执**：模型面说明行与用户面 `notice` 事件均可达；`notice` 被否决时仅剩模型面。

## §13 YAGNI 与差异登记

继承既有登记：`write_approval` 写审批、`session_search` 检索工具、轮级后台 review fork、Curator 状态机、每请求模型选条召回。

本规格新增不做：目录 watcher（用轮次起点 diff 替代）、技能消失通知、记忆版本历史、跨机器同步、SUNSHINE.md 的 diff-only 承载、子代理记忆自动提取、**任何新增工具（N2）**。

与 Claude Code 的刻意差异（如实登记）：

| # | 差异 | 理由 |
|---|---|---|
| 1 | 索引派生化、拒直写 `MEMORY.md` | 索引是生成物，允许手改必被覆盖 |
| 2 | 记忆协议放会话常量（快照），非系统提示词 | 分层纪律：系统提示词只承载通用契约 |
| 3 | 子代理记忆注入私有尾块，非独立系统提示词 | 受「fork 首帧前缀连续」约束 |
| 4 | `put` 语义防「更新变新增」 | 会中改写是常态，去重不得误判为新增 |

## §14 落点与受影响文件

| 文件 | 改动 |
|---|---|
| `CLAUDE.md` | §5 原子工具优先；§11 动态改动尾追 + 回归项（本批已改） |
| `src/harness/memory/paths.ts`（新） | `isMemoryPath` 纯判定单点 |
| `src/harness/memory/writer.ts`（新） | `guardMemoryWrite` 写入接缝（校验 / 规范化 / 重建 / 容量 / 回执） |
| `src/harness/security/chain.ts` | 写白名单窄口（`memory/**` + scope）、过时注释改写 |
| `src/harness/memory/store.ts` | `modified`、`put()`、`capacityNotice()`、显式目录构造 |
| `src/harness/tools/builtin.ts` | `write` 执行器委派接缝（第 7 可选参，未注入＝旧行为） |
| `src/harness/context/index.ts` | 常驻记忆条目、`sunshinexBaseline` / `skillsBaseline`、`checkConstantsDrift()`、`appendInstructionLine()` |
| `src/harness/context/loader.ts` | 暴露 SUNSHINE.md 原文（基线捕获与比对用） |
| `src/config/memory-config.ts`（新） | 三层参数解析单点 + fail-fast |
| `src/harness/index.ts`、`src/runtime.ts` | 装配注入（写入接缝、记忆配置） |
| `src/harness/skills/learned.ts` | 开关与上限由配置驱动 |
| `src/harness/subagent.ts` | `agent.md` `memory` 字段、记忆索引行注入、scope 传递 |
| `src/harness/reactor.ts` | settle 尾追说明行（记忆 / 技能） |
| `src/tui/session.ts` | 指令行走 `appendInstructionLine`、`notice` 事件渲染、`/memory on\|off` |
| `src/cli/commands/run-pipeline.ts:52`、`src/cli/commands/run-loop.ts:20` | 指令行（`action: 'task'`）走 `appendInstructionLine` |
| `TUI-MANUAL.md`、`README.md` | 开关、动态改动尾追、子代理记忆口径同步 |

## §15 自答（易歧义点）

1. **「变更说明」是全文还是 diff？** 全文——规则文本需精确可执行；超 4KB 截断并附 `read` 指针。
2. **新内容何时生效？** 语义上立即（尾部后到者优先），快照层面下次刷新点重建；回归用例把两者分开断言。
3. **会中自写记忆会进本会话提示词吗？** 不会（冻结）；模型要看就 `read` 记录文件（工具响应恒为 live）。
4. **子代理记忆会进主链吗？** 不会，只在其 fork 私有尾块与自身回执里。
5. **关掉自动记忆后还能 `read` 记忆文件吗？** 能（只读放行与开关无关）；仅写入被拒、不注入、不提取、不整理。
6. **`/memory on|off` 会改文件吗？** 不会，仅会话内生效。
7. **本规格是否新增工具？** 不新增（N2）；`write` 工具的名称 / 描述 / 参数均不变。
