# 预定义智能体与团队 P1：管理面（serve 三端点 + GUI TeamsPane + 聊天双 palette + TUI /teams）

- **日期**: 2026-11-04
- **状态**: P0 已落（commit 713d8ced 合入 dev1）；本计划执行 spec §8 P1
- **Spec（绑定权威）**: `docs/superpowers/specs/2026-11-04-agents-teams-catalog-design.md` §6（serve/GUI/TUI 面）、§3.1/3.2（符号与输入面）、§7（测试面）、§8 P1
- **P0 已就位（本计划消费，不重建）**: `src/harness/teams.ts`（TeamManifest/resolveTeam/formatTeamCard/formatAgentCard/TeamsFacade）、`src/catalog/teams.ts`（listTeams 只读视图 + upsertTeam/removeTeam/setTeamEnabled/renderTeamMd 写面 + notifyCatalogWrite('teams')）、`ResourceKind` 已含 `'teams'`、GUI `use-config-changed` 已有 teams 键（临时解堵注释待换真）、TUI/GUI `$`/`#` token 解析与徽标已落（mention.tsx seven-kind）、`team`/`agent` 工具已注册

---

## Global Constraints（全任务绑定）

1. **镜像 agents 线契约**：serve 端点/Gui 连接/Pane 结构一律以 agents 同位实现为模板（GET `{ view: { entries, warnings } }`；PUT body `{ root?, scope, op: 'upsert'|'delete'|'enable'|'disable', id, frontmatter?, body?, enabled? }`；GET body `{ body }`）；`CatalogWriteError` → 409（`COMMENTS` 码附 `hint:'use raw editor'`，走 `sendCatalogWriteError` 单点）；**delete 不存在的 id 吞作幂等 200 `{ok:true}`**，enable/disable 不存在 → 409。
2. **scope 词表三态共存**（现状即如此，不得改rename）：catalog `Scope='global'|'project'`；wire/GUI `'project'|'global'`；harness `TeamManifest.source='project'|'user'`。边界处映射，各面内部保持本面词表。
3. **GUI 提交链路零改动**：`use-chat-submit.ts` 不因本计划改动；palette 插入与未知引用提示均为只读旁路（照发原文、不拦截、不转换）。
4. **TUI /teams 只读清单**（spec §6.3「写引导 GUI/CLI，TUI 不做表单惯例」）：不做 enable|disable 参数。
5. **测试纪律**：src 层 node:test 跑编译产物（`node scripts/clean-dist.js && pnpm exec tsc && node --test dist/...` 聚焦跑）；gui 层 vitest（`pnpm test`，pretest 自带 typecheck）。每任务 TDD：先红后绿，报告附 RED/GREEN 证据。
6. **提交纪律**：conventional 中文主题（`feat(serve): ...`），正文说明裁定与测试；每任务至少一 commit。
7. **代码风格**：中文注释、库内既有习语；GUI 文案双语 `t(en, zh)`；不改无关文件。

---

## Task 1: catalog 写面自防御（version 校验 + id 词法校验 + round-trip 补 version）

**文件**: `src/catalog/teams.ts`、`src/catalog/teams.test.ts`

`upsertTeam` 现状缺口（P0 交接、serve PUT 暴露前必须补齐）：
1. **id 无词法校验**——对照 `upsertAgent`（`src/catalog/agents.ts:220`）开头的 id 校验（读它，镜像同款 `AGENT_ID_RE`=`/^[A-Za-z0-9][A-Za-z0-9_-]*$/` 与错误消息风格），在 `upsertTeam` 入口补同款 id 校验（词法一致；错误消息 `team id invalid: ...`）。
2. **version 无校验**——在 description 校验旁补：`spec.version !== undefined` 时必须为单行 string，否则 `CatalogWriteError('INVALID', 'team version must be a single-line string')`。
3. **round-trip 不比 version**——在 enabled round-trip 行旁补：`meta.version !== (spec.version ?? '0.1.0')` → `round-trip version mismatch (<teams>/<id>/team.md)`（`parseTeamFrontmatter` 缺省回填 0.1.0，故省略=0.1.0 自动闭环）。

**测试**（`src/catalog/teams.test.ts` 追加；先红后绿）：
- 多行 version 拒写（断言 throw INVALID 且盘上无目录）。
- 非串 version 拒写。
- id 词法：`../evil`、`a/b`、空串拒写；合法 `fullstack-delivery` 落盘成功。
- version round-trip：upsert version `'2.0.0'` → `parseTeamFrontmatter` 读回 `'2.0.0'`；省略 → `'0.1.0'`。

---

## Task 2: serve 三端点 + watcher teams 接线

**文件**: `src/serve/config-helpers.ts`、`src/serve/config-handlers.ts`、`src/serve/daemon.ts`、`src/catalog/watch.ts`、`src/serve/daemon.test.ts`、`src/catalog/watch.test.ts`

### 2a. `parseTeamFrontmatterInput`（config-helpers.ts，镜像 `parseAgentFrontmatterInput`:224-251 的 throw→400 模式）

输入 `frontmatter: unknown` → `{ name, description?, version?, members: string[], lead?, enabled? }`：
- `name` 必填非空白单行；`description`/`version` 可选单行 string；`enabled` 可选 boolean。
- `members` **必填**非空 array，每项 string 且匹配 `/^[A-Za-z0-9][A-Za-z0-9_-]*$/`（去空白、留原样——去重交给 catalog 层）。
- `lead` 可选 string。
- 校验失败 throw（400 由 handler 捕），消息风格对照 agents 版。

### 2b. 三端点（config-handlers.ts，镜像 handleAgentsGet:877 / handleAgentsPut:906 / handleAgentsBodyGet:1005）

- **`GET /settings/teams?root=`** → `handleTeamsGet`：`listTeams(root, ...)` catalog 单点；响应 `200 { view: { entries, warnings } }`，entries 行=`{ id, name, description, version, members, lead?, missing, source, shadowed, bodyPreview, enabled }`（bodyPreview 200 截断，镜像 agents 行构造；无 root → 全局-only tmp 哨兵目录，镜像 agents 同款）。
- **`PUT /settings/teams`** → `handleTeamsPut`：body 校验镜像 agents（op 四值/scope 二值/id 词法 `/^[A-Za-z0-9][A-Za-z0-9_-]*$/` 400、project 必带 root、global 忽略 root）；`upsert` → `parseTeamFrontmatterInput` + `body` string 校验 → `upsertTeam`；`delete` → try/catch 吞 CatalogWriteError 幂等 200（镜像 :936-945 逐字风格）；`enable|disable` → `setTeamEnabled(root, scope, id, enabled)`（`enabled` 布尔交叉校验可选；不存在 → 409）；其余 CatalogWriteError 走 `sendCatalogWriteError` 409。
- **`GET /settings/teams/body?scope=&id=&root=`** → `handleTeamsBodyGet`：镜像 agents body 端点——校验 400；文件缺失 `404 { error: 'team.md not found: <scope>/teams/<id>' }`（相对路径风格同 agents）；frontmatter 畸形 400；`200 { body }` = frontmatter 闭合后原文全文（不截断）。
- **daemon.ts**：路由表 `/settings/agents` 三行旁插同款三行（GET/PUT `/settings/teams`、GET `/settings/teams/body`，auth: true）+ 三个 thin wrapper（镜像 :1078-1091）。

### 2c. watcher teams 接线（catalog/watch.ts——types.ts:9-11 注明的 P1 待办）

1. `mapFilename` 段循环补 `if (s === 'teams') return 'teams';`（skills/agents/plugins 旁）。
2. `watchGlobal` specs 补 `{ dir: path.join(globalDir, 'teams'), resource: 'teams', scope: 'global', root: null }`。
3. `watchProject` specs 补 `{ dir: path.join(base, 'teams'), resource: 'teams', scope: 'project', root }`。
4. 文件头/注释中「skills/agents 子目录」措辞同步补 teams。
内部写回环（notifyCatalogWrite → daemon suppress + 直发）零改动自动生效。

### 2d. 测试（先红后绿）

- `daemon.test.ts` 新 describe（圆圈编号从 ㊵ 之后续：先扫文件取下一个未用号），用 `withSettingsDaemon` + fetch + AUTH，镜像 ㉜/㉞/㉟/㊱ 四测试形态：
  - GET 两级清单 + warnings + missing 富化（预置一个 members 指向不存在 agent 的团队）+ 无 root 仅全局 + 无 token 401。
  - 校验面 400 矩阵（坏 id/缺 name/members 空或非数组或坏词法/多行 version/坏 op/scope/缺 root）+ 零盘上副作用。
  - upsert → GET 含条目（members/lead/source/bodyPreview）→ enable/disable（GET enabled 翻转）→ delete → GET 不含 + 幂等再 delete 同 200；global delete root 忽略。
  - body 端点：全文装载（含多段章程原文）、404 缺失、畸形 frontmatter 400。
- `watch.test.ts` 追加：`mapFilename('teams/t1/team.md')` → `'teams'`；`watchProject` 挂 teams 子目录（事件 → `{resource:'teams',scope:'project',root}`）——镜像既有 agents 用例形态。

---

## Task 3: GUI 连接层 + TeamsPane + SettingsShell 注册

**文件**: `gui/src/connection-types.ts`、`gui/src/connection.ts`、`gui/src/settings/TeamsPane.tsx`（新）、`gui/src/settings/SettingsShell.tsx`、`gui/src/settings/use-config-changed.ts`、`gui/src/settings/__tests__/TeamsPane.test.tsx`（新）

### 3a. 类型（connection-types.ts，镜像 :382-435 agents 段落排版）

```ts
export interface TeamEntryView { id: string; name: string; description?: string; version?: string; members: string[]; lead?: string; missing: string[]; source: 'project' | 'global'; shadowed: boolean; bodyPreview: string; enabled?: boolean; }
export interface TeamsView { entries: TeamEntryView[]; warnings: string[]; }
export interface TeamFrontmatterInput { name: string; description?: string; version?: string; members: string[]; lead?: string; enabled?: boolean; }
export type TeamsOpInput =
  | { op: 'upsert'; scope: 'project' | 'global'; root?: string; id: string; frontmatter?: TeamFrontmatterInput; body?: string }
  | { op: 'delete'; scope: 'project' | 'global'; root?: string; id: string }
  | { op: 'enable' | 'disable'; scope: 'project' | 'global'; root?: string; id: string; enabled?: boolean };
```

### 3b. connection.ts（镜像 :736-755 agents 三方法）

`teamsView(root?)` → GET `/settings/teams`（root 编码同款）；`putTeamOp(input)` → `putOp('/settings/teams', input)`；`teamBody(scope, id, root?)` → GET `/settings/teams/body?...`。

### 3c. TeamsPane.tsx（结构镜像 AgentsPane.tsx :99-405，逐件对应）

- Props：`conn: TeamsPaneConn; root?: string; scope?; onScopeChange?; scopeOptions?; refreshTick?`；`TeamsPaneConn { teamsView(root?): Promise<{ view: TeamsView }>; putTeamOp(input: TeamsOpInput): Promise<void>; teamBody(scope, id, root?): Promise<{ body: string }>; agentsView(root?): Promise<{ builtins: BuiltinRole[]; view: AgentsView }> }`（agentsView 供成员多选数据源）。
- load() useCallback + `[load, refreshTick]` effect（config-changed 即重拉）；op 后 load()。
- Toolbar：ScopeSelect + SearchBar（t('Search teams','搜索团队')）+ `+ New`。
- 卡片（ResourceCard）：title=id、subtitle=name、badge=SourceBadge(source)、shadowed 用 sx-shadow-tag、enabled/onToggle 启停；chips=members 逐个 `sx-chip`，**missing 成员用警示样式 chip**（复用库内既有 warn 红色 token——先搜 app.css 既有 `warn`/红 chip 先例，如 `sx-badge-warn`，没有就加 `.sx-chip-missing` 一条）；children：description 行 + `<pre>{bodyPreview}</pre>`。
- EditorModal 字段：id（编辑态只读，词法 `/^[A-Za-z0-9][A-Za-z0-9_-]*$/`）、name、description、version（可选单行，placeholder '0.1.0'）、**members 多选**（裁定的组合形态：已知 agent id 复选列表=「builtins 四角色 + agentsView.entries」+ 一个「额外 id（空格分隔）」文本输入兜底手输新 id；提交时合并去重）、lead（Select，选项=当前 members）、enabled（checkbox）、章程 body textarea（编辑态经 teamBody 全文回填，镜像 seedFullBody）。
- 提交 `conn.putTeamOp({ op:'upsert', scope, ...(project?{root}:{}), id, frontmatter, body })`；删确认 ConfirmDeleteButton；启停 runOp 同款。

### 3d. SettingsShell.tsx

SETTINGS_GROUPS Integrations 组 agents 项后插 `{ id: 'teams', title: { en: 'Agent Teams', zh: '智能体团队' } }`；renderPane 加 `case 'teams': return <TeamsPane key="teams" conn={conn} root={targetRoot} scope={scope} onScopeChange={onTargetChange} scopeOptions={scopeOptions} refreshTick={refreshTick.teams} />;`；`SettingsShellConn` 并集补 `TeamsPaneConn`。
`use-config-changed.ts`：teams 键两处旁的「临时解堵」注释改为正式措辞（键已被 TeamsPane 消费）。

### 3e. 测试（vitest，镜像 AgentsPane.test.tsx 的 connOf stub 模式）

清单渲染（含 missing 警示 chip）、编辑器提交 op 形状（members 合并去重/lead ∈ members）、启停 op、refreshTick 变化重拉、删除确认。先红后绿。

---

## Task 4: GUI 聊天 `$`/`#` 双 palette + 未知引用提示

**文件**: `gui/src/pages/chat/use-composer-keys.ts`、新面板组件（与 FilePalette 同目录惯例）、`gui/src/pages/Chat.tsx`、纯函数模块（可测）+ 对应测试。**不动 `use-chat-submit.ts`**。

### 4a. 纯函数（新小模块，如 `gui/src/pages/chat/ref-palette.ts`）

- `refTokenAt(text: string, caret: number): { query: string; from: number; sym: '$' | '#' } | null`——caret 前文 `/([$#])([a-z][a-z0-9-]*)$/` 命中即返回（from=symbol 下标）；空 query 合法（刚敲 `$`）。
- `filterRefEntries(entries, query)` 前缀过滤。
- 测试：`gui/src/pages/chat/ref-palette.test.ts`（vitest 纯函数，mention.tokens.test.ts 同款；覆盖 `$`/`#`/空 query/非词边界不触发如 `a$b`/`#L30` 已在 token 解析面排除、caret 中段）。

### 4b. 面板与键盘（use-composer-keys.ts）

- deps 增：`refPal/refPalSetRef`（或复用文件面板同款状态形态）、`loadRefEntries`（Chat 提供的懒加载）、`refEntries`（`{ agents: {id,name}[]; teams: {id,name}[] }`）、`refActive/setRefActive`。
- 触发：input onChange/key 路径中 `refTokenAt` 命中 → 打开面板 + 首次懒加载 entries（同 @ 面板 loadWorkspaceFiles 惯例）；活性锚检查镜像 @（`input[refPal.from]` 非 `$`/`#` 即关）。
- ↑↓ 循环（跨两组连续编号）、Esc 关、Enter：插入 `$id `/`#id `（尾随空格），替换区间=from..caret，关闭面板。**无记账**（`$id`/`#id` 插入即终态，无 @ 的展开记账语义——裁定）。
- 优先级：`$`/`#` 面板与 `@`/`/` 面板互斥（refPal 非 null 时其余面板不显示；同刻只有一符号触发）。

### 4c. Chat.tsx 装配

- state：refPal/refEntries/refActive；`loadRefEntries` 懒拉 `conn.agentsView`+`conn.teamsView`（并行 Promise.all，缓存于 ref，失败静默空列表——面板照开仅无项）。
- overlays 三元链挂新面板（FilePalette/ComposerPlusPanel/CommandPalette 同层，互斥判定）。
- **未知引用提示**：Chat 的 send 入口（Chat.tsx 自有 send 回调处，非 use-chat-submit）只读检查：`/(^|\s)([$#][a-z][a-z0-9-]*)/g` 全量 token，对照已缓存 entries id 集（未拉过则跳过检查——不为此发网络请求，裁定）；未命中者聚合一条 transient 提示（镜像 imgHint 模式：`role="status"` 行内提示、数秒自隐；文案 t('No registered match for $x #y — sent as-is','$x #y 未匹配到在册条目——已按原文发送')）。不拦截、不改写。

### 4d. 测试

ref-palette.test.ts（4a 全量）；use-composer-keys/Chat 面板至少一条装配锚（输入 `$` 面板出现、Enter 插入并关闭）——用既有 Chat.test.tsx 或新测试文件，stub conn。

---

## Task 5: TUI /teams + registrations + 引用提示

**文件**: `src/tui/commands-teams.ts`（新）、`src/tui/slash-commands.ts`、`src/tui/session.ts`、`src/tui/commands-agents.ts`、测试（`src/tui/commands-mcp.test.ts` 追加或新 `commands-teams.test.ts`、`src/tui/slash-commands.test.ts`、session 测试）

### 5a. commands-teams.ts（镜像 commands-agents.ts 结构）

- `teamsListing(ctrl)`：`listTeams(ctrl.root)`（catalog 单点；读面失败降级 warn 行，镜像 readListing）→ 行格式镜像 agentRow 但加 members 展示与标注：`- <id> [<source>] <on|off><shadowed 标注> — <name>: <description> (members: a, b, c)`；missing>0 团队追加警示行 `  ⚠ missing agents: x, y`；头部 `Teams (N):`；尾行 usage：`Usage: reference a team in your message as #<team-id> — manage in GUI settings (Agent Teams)`（双语 t）。
- `teamsPanel(ctrl, rest)`：idle 守卫镜像；bare → teamsListing；**带参 → 写引导行**（spec §6.3：TUI 不做写表单）：`Team edits live in the GUI settings (Agent Teams) / CLI catalog API — TUI panel is read-only`（双语 t），不执行任何写。
- session.ts handleSlash `/teams` 分支（`/agents` 分支 :1172-1176 同款三行）。
- slash-commands.ts：SLASH_COMMANDS `'/agents'` 后插 `'/teams'`；slashCommandDescriptions 补 `teams: t('agent teams panel (read-only listing)', '智能体团队面板（只读清单）')`。（spec §3.2 提到的 FREE_TEXT_ARGS 在库中不存在——登记机制就是 SLASH_COMMANDS + descriptions + handleSlash 三处，裁定按实际机制。）

### 5b. /agents 面板补一行 `$id` 用法提示

agentsListing 尾部 usage 行区补：`Usage: name a single agent in your message as $<agent-id>`（双语 t）。

### 5c. 未知引用 system 行提示（session.ts，只读旁路）

普通文本派发入口（runTaskFlow 前的 submit 路径，含 G14.95 未知斜杠词落点）：token 扫描 `/(^|\s)([$#][a-z][a-z0-9-]*)/g`；在册集合 = `listAgentDefs(ctrl.root)`（builtins+两级磁盘，src/harness/subagent.ts）ids ∪ `listTeams(ctrl.root)` ids（各自 try/catch 读面失败 → 跳过提示）；未命中聚合一条 `ctrl.pushMsg('system', t(...), { level: 'warn' })`？——**不，用普通 system 行（无 warn 级）**，文案 `No registered match for $x #y — sent as-is (see /agents, /teams)`（双语 t），照发原文不拦截。读盘开销：每次纯文本发送一次小目录读，可接受（与命令面每次读盘同量级）；**运行中也提示吗？** 运行中 submit 走排队，提示跟随派发时刻，照常。

### 5d. 测试

- commands 面板：`/teams` 清单行（source/on|off/members/missing 警示）、带参写引导行、读面失败降级；`/agents` 面板含 `$<id>` 用法行（追加断言到既有 /agents 测试）。
- slash-commands.test.ts 双向对账自动覆盖 `/teams`（跑绿即可）+ 显式注册断言追加 teams。
- session 提示：文本含 `#nope` 与在册 `#yes` → 提示行含 `#nope` 不含 `#yes` 且原文照发（任务流照常派发）；无 `$`/`#` 文本零提示；读面坏目录 fail-soft 零提示。

---

## 分期外（不做）

P2：launch_agent_team、AGENTS_INSTALL_LINE、learned-team、TUI `$`/`#` 补全池（SlashMenu 同款）、CLI `sunshinex teams`、软加载措辞强化迭代。
