# 预定义智能体与智能体团队：目录注册、软引用统一与缓存稳定

- **日期**: 2026-11-04
- **状态**: 设计定稿，待用户审阅后进入 implementation plan
- **来源**: 会话四轮收敛——①团队预定义目录（`$` 单符号）→ ②`$`=智能体 / `#`=团队分符号 → ③三域统一「软引用」（清单进快照、模型匹配、工具按需加载，harness 零预注入）→ ④skills 一并软引用化，harness 硬加载机制退役
- **路径裁定**: `$` 智能体 / `#` 团队 / `/skill-id` 技能全部软引用；命令面仅剩纯内置命令；**禁止兼容**（硬载通道零保留，历史 journal 只读回放）
- **关联**:
  - `2026-11-01-agent-teams-tools-gui-design.md`——八件套工具名、`agentTeams` 门禁、会话隔离开关仍有效，本规格叠加「预定义目录 + 软引用」层
  - `2026-09-22-skill-as-command-design.md`——**本规格反转其 D3/D4/D6/D7/D8**（技能退出命令面），D1 撞名内置优先随命令面收缩自然消解；历史档案不改写，以本文件 + CLAUDE.md 为准
  - `2026-10-31-session-snapshot-freeze-design.md`——快照冻结/漂移尾追纪律原样沿用
  - `2026-10-31-agent-team-simplify-design.md`——五态/队卡语义仍有效

---

## 0. 意图与成功标准

### 0.1 意图

1. 智能体团队**预定义目录**：设置页可维护团队（团队 + 成员 + 描述 + 章程），底层存储 TUI/GUI/serve 共用一个核心层；成员按 id 引用既有 agents 注册表，不复制定义。
2. 输入面符号直达：`$agent-id` 点名单个智能体、`#team-id` 引用整队——补齐「用户侧无单独调用子智能体入口」的缺口（现状仅模型自主 spawn + 管理面）。
3. 三域统一**软引用模型**：`/skill-id`、`$agent-id`、`#team-id` 同构——清单摘要进 system#2 冻结快照，消息内引用由模型匹配后经工具按需加载全量内容，harness 零预注入。
4. skills 一并软引用化：退出命令面（命令面仅剩纯内置命令），harness 硬加载机制（`loadSkill` / `skillRef` / `setSkillBlock`）退役。
5. agent 可像 skills 一样**预定义团队**（政策行授权 write 直写），模型经清单 + `[teams]` notice 识别、新 id 即时可用。
6. 全程**前置缓存稳定**：任何目录变化与引用加载只链尾追加，前缀零击穿。

### 0.2 成功标准

1. `.sunshinex/teams/{id}/team.md` 两级注册（项目遮蔽全局）、`missing` fail-soft；`GET/PUT /settings/teams` 三端点；GUI TeamsPane；TUI `/teams`。
2. agents/teams 清单进 system#2 快照（确定性序列化、空清单零注入）；`team` / `agent` 工具注册（镜像 `skill` 工具），加载产物=工具观察尾追。
3. `$` / `#` token 两端解析（徽标渲染 + palette + 未知引用提示）；**提交链路零改动**（引用随 goal 原文上行）。
4. 命令面仅剩纯内置命令：`skillCommandIdsOn` / `loadSkill` / `skillFlow` 硬载 / serve `skillCommands()` 数据面 / GUI palette `kind='skill'` 混入 / loop `skillRef`→`setSkillBlock` 全部退役；技能唯一加载通道 = 消息内 `/skill-id` 软引用（模型经清单匹配）+ `skill` 工具；`/skill` 选择卡改「插入引用」。
5. 缓存回归：新增双清单与双工具后，runmeta `cached_tokens` 命中率不回退，前缀逐字节稳定（确定性排序 + 会话冻结 + 尾追）。
6. `TEAMS_INSTALL_LINE` 政策行就位；agent 写 `team.md` 后 `[teams] added` notice 公告，`#ref` / `team` 工具即时可用（notice 超越快照清单）。

### 0.3 非目标

- `launch_agent_team` 一键实例化糖（P2）。
- agents/teams 的 CLI 管理命令 `sunshinex teams`（P2）。
- learned-team 沉淀、`AGENTS_INSTALL_LINE`（P2，有真实诉求再加）。
- 门禁热翻面；cache_control 显式断点 API。
- 软加载不可靠时**恢复任何形式的 harness 硬载**（兜底只有提示词措辞强化，见 §9）。

---

## 1. 数据模型与存储（TUI/GUI 复用核心层）

### 1.1 双注册表

| 注册表 | 项目级 | 全局级 | 状态 |
|---|---|---|---|
| agents | `{root}/.sunshinex/agents/{id}/agent.md` | `~/.sunshinex/agents/{id}/agent.md` | 已有，本规格不动 |
| teams | `{root}/.sunshinex/teams/{id}/team.md` | `~/.sunshinex/teams/{id}/team.md` | 新增 |

- 两级链各自就近遮蔽（团队间、智能体间独立），低优先保留并标 `shadowedBy`（catalog 纪律）。
- id 规范共用 `^[a-z0-9]+(-[a-z0-9]+)*$`；畸形目录装载期跳过。

### 1.2 team.md 格式（单行 KV frontmatter + 正文章程，沿用自制词法）

```markdown
---
name: 全栈交付小队
description: 需求→实现→测试→评审一站式交付，适合中等规模特性开发
version: 1.0.0
members: planner developer tester reviewer   ← 只写 agent 的 id（引用）
lead: developer
enabled: true
---
（正文 = 团队章程：协作流程、成员接力约定、产出物位置、冲突裁决规则）
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 展示名（索引行、面板、palette 用） |
| `description` | 是 | 一句话描述；进索引行，截 128 字符 |
| `members` | 是 | 空格分隔的 **agent id** 白名单（词法同 skills `params`） |
| `lead` | 否 | 领队 member id，缺省 members 首个；必须是 members 之一 |
| `enabled` | 否 | 缺省 true；false 时索引行标注 (disabled)（模型知情可引导用户启用）、`#ref` 解析三态拒 TEAM_DISABLED |
| `version` | 否 | 缺省 0.1.0 |

### 1.3 引用语义（按引用不按值）

- members 指向 agents 注册表条目 id——成员能力/角色随 `agent.md` 单点演化，团队只管编排。
- 装载时逐 id 走 agents 两级遮蔽链解析存在性，缺失记入 `missing[]`：fail-soft 不拖垮装载，UI 警示 chip，团队照出。
- 内容**现读**：出卡时成员描述当场从 `agent.md` 读，团队零跟随成本。
- 多对多：一个 agent 可被任意多队引用，也可不属于任何队；agent 不知被谁引用（无回链），删除的代价 = 引用团队标 missing，可见可恢复。

### 1.4 TeamManifest（`src/types.ts`，挨着 SkillManifest）

```ts
interface TeamManifest {
  id: string;            // 目录 id（TEAM_ID_RE）
  name: string;
  description: string;
  version: string;
  members: string[];     // agent id 列表
  lead?: string;
  enabled: boolean;
  source: 'project' | 'user';
  sourceDir: string;
  shadowedBy?: string;
  missing: string[];     // 解析失败的成员 id
}
```

### 1.5 模块落点（全部镜像既有文件）

| 模块 | 职责 |
|---|---|
| `src/harness/teams.ts` | `TEAM_ID_RE`、`parseTeamFrontmatter`、`loadTeamsFrom/loadTeamsChain/loadTeams`、`formatTeamsIndex`、`resolveTeam`（TEAM_NOT_FOUND/TEAM_DISABLED/ok）、`formatTeamCard`、`formatAgentCard`（两卡单点）、`TeamsFacade` |
| `src/catalog/teams.ts` | 只读视图 `listTeams`（source/shadowedBy/missing 富化）+ 写面 `upsertTeam/removeTeam/setTeamEnabled/renderTeamMd`（round-trip 验证、原子写、`notifyCatalogWrite('teams')` → config-changed WS） |
| `context/drift-detector.ts` | 基线扩展：teams + agents（现状只比 skills/memory） |

`src/config/agent-teams.ts` 不动（只管门禁布尔）。agents 读写面沿用 `catalog/agents.ts`。

---

## 2. 模型可见性与前置缓存稳定性

三个注册表同一套纪律：**清单进冻结快照、软引用匹配、工具按需加载、变更漂移尾追**。

### 2.1 清单进 system#2 快照

- `ContextManager` 新增 `teamsIndexItems()` 与 `agentsIndexItems()`（对标 `skillsIndexItems()`）。段内位置一次定型：SUNSHINE.md → skills 清单 → **agents 清单** → **teams 清单** → 记忆索引。
- 确定性序列化：按 name 码点字典序（平局比 id）；description 截 128；teams 行附 members 展示（截 8 个）；**空清单返回 null 零注入**。行格式：
  - `- Dev (id: developer): 负责编码实现`（agents；条目 = 内置四角色 + 两级注册表生效集，enabled 过滤）
  - `- 全栈交付小队 (id: fullstack-delivery): 需求→…交付 (members: planner, developer, tester, reviewer)`（teams）
- 快照会话期冻结，刷新点仅限既有四个（构造 / `/init` reloadContext / `/new` / 压缩成功）。

### 2.2 lead 行软引用语义（三清单各自声明，对标 skills lead 行）

清单是参考数据不是指令；用户消息中 `$agent-id` / `#team-id` / `/skill-id` 引用命中条目时，**先经对应工具加载全量内容再行动**；会话起步快照，之后新建/修改由 `[skills]` / `[agents]` / `[teams]` notice 公告且**notice 超越清单**（新 id 立即可用）。

### 2.3 加载 = 工具观察尾追

- `skill`（已有）/ `agent`（新增）/ `team`（新增）三工具 `fullObservation` 返回卡片/正文原文，观察随链尾追——三域同构。
- 观察是真实链行落 journal：**会话恢复后仍在**（优于任何预注入形态；这也是放弃 harness 预注入的收益之一）。
- 工具对不在册 id 返回 NOT_IN_CATALOG（与 skill 工具「只可用清单内 id」同语义）。

### 2.4 漂移 notice

会中磁盘变化由 DriftDetector 基线比对产出 `[skills]` / `[agents]` / `[teams]` added/removed/updated 说明行，经 `appendInstructionLine` **链尾追加**——前缀零击穿。

### 2.5 门禁装配期读数

`agentTeamsEnabled` 在 Harness 构造期消费，会话中不翻面，tools 集合逐字节稳定；新工具参与既有按名排序。

### 2.6 稳定性汇总表

| 变化源 | 机制 | 前缀影响 |
|---|---|---|
| 新装/改写/删除 team.md、agent.md、SKILL.md | DriftDetector `[teams]` / `[agents]` / `[skills]` notice 链尾 | 零（尾追） |
| `#team-id` / `$agent-id` / `/skill-id` 引用 | 模型匹配清单 → 对应工具加载，观察尾追 | 零（尾追） |
| agent 会中写新团队/智能体/技能 | 对应 notice + 工具即时可载 | 零 |
| 成员 agent.md 变化 | 出卡时现读、随观察尾追 | 零 |
| 门禁翻面 | 装配期只读，会话内不翻面 | 零 |
| 三清单本身 | system#2 快照，四刷新点，确定性序列化、禁时变字段 | 会话内字节冻结 |

### 2.7 遥测

复用 `cached_tokens` → `onCache` → reactor 命中率聚合做回归观测；不引入 cache_control API——与全库「隐式前缀稳定」纪律一致。

---

## 3. 符号与软引用

### 3.0 符号总表（四符号四域，三层同构）

| 符号 | 域 | 注册表 | 加载工具 | system#2 清单 | 实例化通道 |
|---|---|---|---|---|---|
| `/` | **纯内置命令**（命令通道）+ 技能内联软引用 | — / skills | `skill`（已有） | skills 清单（已有） | 按 skill 指令行事 |
| `@` | 文件提及（GUI） | — | 客户端展开为 md 链接 | 无 | 无 |
| `$` | 单个智能体 | agents（已有） | `agent`（新增） | agents 清单（新增） | spawn（既有，恒在） |
| `#` | 智能体团队 | teams（新增） | `team`（新增） | teams 清单（新增） | 团队八件套（既有，受门禁） |

技能不再注册为命令（§4）：`/skill-id` 只作为**消息内文本**出现，模型经清单匹配后软加载。

### 3.1 语法与解析（输入面只做 UX，不承担正确性）

- token：`$agent-id` / `#team-id`，正则 `[$#][a-z][a-z0-9-]*`（词边界；`#` 后首字符必须小写 → `@` 展开产出的 `./p#L30` 行锚天然不命中）。
- **正确性判定在模型侧**：命中清单条目 → 工具加载 → 行动；未命中（粘贴的 shell `$var`、markdown `# 标题`、`#tag`）→ 普通文本，harness 零介入。
- 一条消息可含任意多个 `$`/`#` 引用，模型按需逐个加载（无「首个生效」限制）。
- 客户端纯 UX：palette 记账（镜像 `pickRelRef` 惯例）+ 未知引用 toast / TUI system 行提示，照发原文，不拦截。

### 3.2 输入面（TUI/GUI 各自的薄壳）

**GUI**：
- `mention.tsx` `splitMentionTokens` 加 `$`（kind `'agent'`）与 `#`（kind `'team'`）token，各配徽标样式（`#` 渲染为徽标，避免观感撞 markdown 标题）。
- `use-composer-keys.ts` 仿 `@` 文件面板：caret 前 `$` → 智能体 palette（数据源 `agentsView`）；`#` → 团队 palette（`GET /settings/teams`）；可一个面板分两组；↑↓/Enter/Esc，Enter 插入 `$id` / `#id` + 记账。
- `use-chat-submit.ts` **提交链路零改动**；仅未知引用 toast。
- `renderUserMd` 加两类 token 样式。

**TUI**：
- `session.ts` submit 零改动；仅未知引用 system 行提示。
- `/teams` 清单卡（新 `commands-teams.ts`，镜像 `commands-agents.ts`）：列团队（source/shadowedBy/missing 标注）；SLASH_COMMANDS + FREE_TEXT_ARGS + handleSlash 三处登记；`/agents` 面板补一行 `$id` 用法提示。
- 发起不设斜杠命令——`$id 任务` 点名、`#id 目标` 拉队，直打即达。

### 3.3 加载工具与卡片（镜像 `skill` 工具，`tools/builtin.ts` 模式）

- **`team` 工具**：param `id`，`fullObservation` 返回 `formatTeamCard` 原文；描述声明「只可用清单内 id、teams 是 live 的、会话中新建的以 notice 为准」。
- **`agent` 工具**：param `id`，`fullObservation` 返回 `formatAgentCard` 原文；同构。

```
[team] fullstack-delivery — 全栈交付小队
description: 需求→实现→测试→评审一站式交付
members (lead marked *):
- *developer — Dev: 实现角色框定摘要（取自 agent.md description/正文头部）
- planner — Planner: …
charter:
<team.md 正文章程原文>
usage: instantiate with create_agent_team + create_agent_teammate (agent_id as above), then create_agent_team_task per the charter.
```

```
[agent] developer — Dev
description: 负责编码实现
role:
<agent.md 正文角色框定原文>
usage: delegate via spawn (agent_id="developer", prompt=<the task>); do not absorb the role yourself.
```

- **`$` 与 spawn 的分工**：agent 卡服务主模型的**委派质量**（知道该派谁、怎么写委派 prompt）；即使模型跳过加载，spawn 时 `resolveSpawnSpec` 仍现读 `agent.md` 给子代理正确角色框定——委派不会错，只会「主模型计划得糙」。
- **`$` / `#` 语义区分**：`$` = 一次性 fork（spawn，干完即收）；`#` = 长驻队友（teammate，跨任务保上下文）——与 spawn / create_agent_teammate 既有「两动词两契约」分工对齐。

### 3.4 门禁协同

- 三清单 / 两卡 / `team`·`agent` 工具是纯 prompt 面，**不受** `agentTeams` 门禁；实例化通道各归其位：`$` → spawn（恒在）、`#` → 八件套（受门禁）。
- 门禁关时模型有章程卡但无八件套 → 自然降级（spawn 逐个拉子代理或单干），无需特殊分支。

---

## 4. skills 硬载退役（统一软引用）

### 4.1 裁定

反转 `2026-09-22-skill-as-command-design.md` 的核心机制：技能**退出命令面**，命令面仅剩纯内置命令（SLASH_COMMANDS 内置清单）；技能唯一加载通道 = 消息内 `/skill-id` 软引用（模型经 skills 清单匹配）+ `skill` 工具自主加载。与 `$`/`#` 三域同构，harness 对三域一律零预注入。

### 4.2 退役清单（实现期逐点摘除）

| 域 | 退役点 | 现位置 |
|---|---|---|
| TUI | `skillCommandIdsOn` 注册表（技能 id 进命令分发） | `tui/commands-skills.ts` |
| TUI | handleSlash 技能 id 分支（裸形式 loadSkill / 带意图 loadSkill+runTaskFlow） | `tui/session.ts` |
| TUI | `loadSkill` 单点（去重扫描 → resolve → `appendChain(action:'skill')` 持久注入） | `tui/session.ts` |
| TUI | `skillFlow` 选择卡硬载 → **改插入引用**：选定后把 `/skill-id ` 插入输入 buffer（浏览器兜底语义保留） | `tui/session.ts`、`tui/commands-skills.ts` |
| TUI | `/help` 技能段（命令面不含技能） | `tui/session.ts` slashHelp |
| loop | run opts `skillRef` 分支 + `SkillRef` 解析接缝 | `loop/engine.ts` |
| context | `setSkillBlock` + 消费即清 + 首帧 `[skill]` 置尾 | `context/index.ts`、`context/messages.ts` |
| types | `SkillRef` / run opts 字段 | `src/types.ts` |
| serve | `skillCommands()`（`/session/:id/skill-commands` 数据面，GUI 命令面板混入技能项） | `serve/session.ts` |
| GUI | palette `kind='skill'` 命令项混入（`use-command-palette.ts` skillCmds/skillItems） | `gui/src/pages/chat/` |

### 4.3 保留面

- `skill` 工具、`skillsIndexItems` + lead 行、`formatSkillsIndex`、`SKILLS_INSTALL_LINE`、learned 沉淀管线、`/skills-rm` 删除通道——全部不动。
- `/skill` 选择卡保留为**浏览兜底**，语义改为插入引用文本（不再执行加载）。
- 技能使用记录（`tui/skill-usage.ts`，最近使用排序）改挂两处：`skill` 工具执行 + 选择卡插入；不再依赖命令加载。
- `/context` 技能段语义随硬载退役调整（不再有「链上已加载技能」清单行）。

### 4.4 加载确定性立场

硬载退役后加载确定性完全依赖模型侧（lead 行 + 清单 + usage 行）——这是 CC 自主通道的同款立场，**接受**；兜底只有提示词措辞强化（§9），不设任何 harness 硬载回退。

### 4.5 兼容

- **零兼容**：硬载通道零保留（无别名、无双读）；历史 journal 中的 `action:'skill'` 链行只读回放。
- 历史规格档案不改写；以本文件 + CLAUDE.md 为准（CLAUDE.md 技能装载段随实现更新）。

---

## 5. agent 预定义团队（像 skills 一样）

- **政策行** `TEAMS_INSTALL_LINE` 进 stableSegment（对标 `SKILLS_INSTALL_LINE`）：团队定义于 `.sunshinex/teams/<id>/team.md`（项目）或 `~/.sunshinex/teams/<id>/team.md`（全局）；frontmatter 字段约定（members 引用 agents 注册表 id）；`settings.json` 受保护不可写；用户可用 `#team-id` 引用。
- agent 用通用 **write 工具**创建（无专门工具，与 skills 同一授权形态）；写面 round-trip 验证兜底防坏档。
- 创建后 DriftDetector 产 `[teams] added` notice → 模型面/用户面同时知晓 → 新团队**即时可用**（`#ref` / `team` 工具，notice 超越快照清单）。
- P2 可选：`AGENTS_INSTALL_LINE`（授权 agent 写 `agent.md`）、learned-team（任务终态沉淀「本次临时拉的组合」）。

---

## 6. Serve 与消费面

### 6.1 REST（镜像 agents 三端点，`daemon.ts` 路由表 + `config-handlers.ts`）

| 端点 | 语义 |
|---|---|
| `GET /settings/teams?root=` | 分组清单（project/global）+ catalog 富化（source/shadowedBy/missing）+ 章程原文 |
| `PUT /settings/teams` | body `{root?, scope, op: upsert\|delete\|enable\|disable, id, frontmatter?, body?}` |
| `GET /settings/teams/body?root=&scope=&id=` | 编辑器全文装载 |

写面收口 catalog 单点；`CatalogWriteError → 409`；`delete` 缺失吞作幂等 200；`notifyCatalogWrite('teams')` → config-changed WS → GUI 自动重拉。**submit 链路零改动**。

### 6.2 GUI

- `SettingsShell.tsx`：SETTINGS_GROUPS 的 Integrations 组 agents 后插 `teams`；renderPane 加 case；Conn 接口并集补方法。
- 新建 `TeamsPane.tsx`（镜像 `AgentsPane.tsx`）：ScopeSelect + SearchBar + New；卡片 = 团队名 + 描述 + 成员 chips（missing 红色警示）+ source/shadowedBy 徽标；EditorModal = name/description/members（多选自 `agentsView`，允许手输新 id）/lead（单选）/enabled + 章程 textarea。
- `connection.ts` 加 `teamsView / putTeamOp / teamBody`；`connection-types.ts` 加类型。
- 聊天双 palette 数据源：`$` → `agentsView`（已有），`#` → `GET /settings/teams`。

### 6.3 TUI

- `/teams` 面板：读走 catalog 单点，输出经 `ctrl.pushMsg('system', ...)`；写引导 GUI/CLI（TUI 不做表单惯例）。

---

## 7. 测试面（镜像各层既有测试位）

| 层 | 钉什么 |
|---|---|
| harness `teams.test.ts` | 正则/frontmatter 词法/两级遮蔽/missing fail-soft/`formatTeamsIndex`·agentsIndex·两卡确定性（同输入逐字节同输出）/resolveTeam 三态 |
| context | teamsIndexItems·agentsIndexItems 注入位与格式/空清单零注入/DriftDetector `[teams]`·`[agents]` 三态 notice/快照冻结 |
| tools | `team`·`agent` 工具三态（在册 ok / NOT_IN_CATALOG / disabled）/fullObservation 原文不截断 |
| serve | 三端点 + op 四值 + 409 映射 + 幂等 delete；`skillCommands()` 退役后 /commands supported 无技能 |
| TUI | /teams 面板；`loadSkill`/`skillFlow`/`skillCommandIdsOn` 退役回归（`/skill-id` 不再进命令分发、选择卡插入引用）；`/context` 技能段调整 |
| GUI | TeamsPane（卡片/missing 警示/editor 提交）；`$`·`#` token 切分/双 palette/未知引用 toast/`#L30` 不误判；palette 技能项改插入 |
| 门禁 | agentTeams off：清单照注、八件套不注入、team·agent 工具照注 |
| 缓存回归 | 新增双清单双工具后前缀逐字节稳定断言；cached_tokens 命中率不回退 |

---

## 8. 分期

- **P0 最小闭环（含统一软引用改造）**：`src/harness/teams.ts` + types + `teamsIndexItems`·`agentsIndexItems` + DriftDetector 扩（teams/agents 基线）+ `team`·`agent` 工具 + GUI/TUI `$`·`#` token 解析（palette 可后置）+ `TEAMS_INSTALL_LINE` + **§4 skills 硬载退役全项**（一次落，不留双通道）。
- **P1 管理面**：serve 三端点 + GUI TeamsPane + 聊天双 palette + TUI `/teams`。
- **P2 增强**：
  - `launch_agent_team` 一键实例化糖；
  - `AGENTS_INSTALL_LINE`、learned-team 沉淀；
  - **TUI/GUI 输入面对齐**：TUI 补 `$`/`#` 补全池（SlashMenu 同款池）、`@` 文件提及对齐评估、token 徽标渲染与插入记账两端口径统一；
  - CLI `sunshinex teams`；
  - 软加载措辞强化兜底（lead 行/usage 行迭代——**不恢复硬载**）。

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 正文中 `$var` / `#tag` / `# 标题` 被模型误当引用 | 模型按清单匹配，未命中即普通文本；`#` 后首字符须小写（`#L30` 天然不命中）；客户端 toast 仅提示不拦截 |
| 模型跳过加载、按 128 字摘要直接行事（三域共同风险，硬载退役后成为唯一风险面） | lead 行惯例（skills 清单已长期验证）+ 卡片 usage 行约束；`$` 底线由 spawn 现读角色框定兜住；兜底只有措辞强化迭代，不设硬载回退（§4.4 立场） |
| system#2 膨胀（三清单并存） | desc 截 128、teams members 展示截 8、空清单零注入；遥测观测 token 增量 |
| 成员 agent 被删 → 团队悬空 | `missing[]` fail-soft，UI 警示 chip，章程卡只列存活成员并注明缺失 |
| 门禁关时 `#ref` 行为 | 章程卡照注（纯 prompt 面），模型无八件套自然降级 |
| agents 清单进 prompt 改变模型自主 spawn 行为 | 有意的功能升级（模型可主动委派在册智能体）；工具描述仍要求「不发明 id」，清单外 id 运行期拒识不变 |
| `#` 引用观感撞 markdown 标题 | mention.tsx 徽标渲染 token，不呈现为标题 |
| skills 退出命令面的用户习惯迁移 | `/skill` 选择卡保留（改插入引用）+ `/help` 保留纯命令段；消息内 `/skill-id` 形态不变（仍以 `/` 起手书写，只是不再由命令通道拦截） |
| 与 `@` 命名空间冲突 | 四符号四域互不相交；`$`、`#` 全库输入面此前空闲 |

---

## 10. 决议摘要

| 项 | 决议 |
|----|------|
| 符号 | `$`=智能体 / `#`=团队 / `/skill-id`=技能内联软引用；命令面仅剩纯内置命令 |
| 引用模型 | 三域统一软引用：清单进冻结快照 → 模型匹配 → 工具按需加载 → 观察尾追；harness 零预注入 |
| 存储 | teams 目录注册制两级（`.sunshinex/teams/{id}/team.md`），成员按 id 引用 agents 注册表，missing fail-soft |
| 加载工具 | `team` / `agent` 新增（镜像 `skill`）；观察落 journal，resume 仍在 |
| skills 硬载 | 全退役（loadSkill/skillRef/setSkillBlock/skillCommands/palette 混入）；`/skill` 卡改插入引用；零兼容 |
| agents 清单 | 进 system#2（软引用前提：提示词须有条目可匹配） |
| 实例化 | `$`→spawn（一次性 fork）；`#`→八件套（受 agentTeams 门禁）；清单与工具不受门禁 |
| agent 预定义 | `TEAMS_INSTALL_LINE` + write 直写 + notice 即时可用 |
| 缓存稳定 | 确定性排序 + 会话冻结 + 变更只走 notice/观察两种链尾追加；遥测 cached_tokens 回归 |
| P2 | launch_agent_team、AGENTS_INSTALL_LINE、learned-team、**TUI/GUI 输入面对齐**、CLI teams |
