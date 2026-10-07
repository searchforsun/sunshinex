# G8c 设置全链(端点族+自填槽重载+十面板)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 依 G8 spec §2.5+§0③④+§7 G8c 行交付设置页全链:daemon /settings 端点族(effective 视图/结构化改写/raw 双文件/mcp 探测/agents 两级/skills/memory-stats)+自填槽清除重载(新会话即刻生效)+gui 设置态(左栏切换导航+十面板+来源徽标+生效 toast)。

**Architecture:** 配置正名仍是 settings.json/mcp.json/agent.md 文件——daemon 端点族是这些文件的视图与验证性编辑器;自填槽机制(settings.ts 登记链内自填,保存→清→以新 root 重跑链)让「新会话即刻生效」成立且真 env 恒最优先。GUI 设置态=App 新增顶层态(左栏整体切换,右栏隐藏),面板组件按复杂度两批落地。

**Tech Stack:** 全既有(零新依赖;node:test 主仓+vitest gui)。

**Spec:** `docs/superpowers/specs/2026-10-07-gui-redesign-design.md`(v8)§2.5 全节+U-D9..U-D12c。

## Global Constraints

- **主仓改动白名单**:src/config/settings.ts(自填槽登记)/src/config/config.ts(或 mcp 解析导出,仅按需)/src/harness/subagent.ts+src/harness/index.ts(AgentRegistry 两级化)/src/harness/skills.ts(分组视图导出)/src/serve/daemon.ts/src/serve/daemon.test.ts(+新端点测试文件可并入 daemon.test.ts 或新建 src/serve/settings.test.ts)。**gui 白名单**:gui/src/connection.ts/App.tsx/App.test.tsx+gui/src/settings/(新目录)/gui/src/sidebar/ProjectMenu.tsx(设置钮)/e2e.test.ts。越界即违规。
- 零新依赖;测试钩子 class 保留;新结构 sx- 前缀;watchdog:逐任务聚焦,T10 全量。
- **项目上下文裁定(控制器)**:设置端点族带 `root` 查询/body 字段(绝对路径;缺省=仅全局面)。GUI 设置态顶栏项目选择器(/workspaces 列表;默认=最近活跃会话 root,无则空=仅全局)。
- **生效语义(U-D11)**:保存文件→daemon 清自填槽→以该 root 重跑装载链(项目→全局,只填缺省)→**后续新建会话即刻生效**;运行中会话不回改;真导出 env 恒最优先(覆盖键标徽标+禁编)。
- **注释守卫(U-D10)**:结构化写(PUT /settings、PUT /settings/mcp)目标文件含注释(raw≠stripJsonComments(raw))→ 409 `{error:'file contains comments', hint:'use raw editor'}`;agent.md 生成式写入不受此限。
- raw 写原子性:tmp+rename;验证失败拒存(400 带解析错误原文)。
- agent.md id 安全校验:`/^[A-Za-z0-9][A-Za-z0-9_-]*$/`(拒路径分隔/点开头)。
- gui 命令 `pnpm --dir gui …`;主仓 `pnpm build`+`node --test dist/…`;提交规约 feat(serve)/feat(gui)/fix(…);git add 仅点名文件。

## File Structure

```
src/config/settings.ts          [T2] applySettings 自填槽登记+getSelfFilledSlots 导出
src/config/config.ts            [T4] parseMcpJsonFile 导出(仅按需)
src/harness/subagent.ts         [T1] AgentRegistry 两级装载+loadAgentsView 宽容视图
src/harness/index.ts            [T1] 装配点传全局 agents 目录
src/harness/skills.ts           [T6] loadSkillsGrouped 三源分组导出
src/serve/daemon.ts             [T2/T3/T4/T5/T6] 端点族路由+实现+自填槽重载
src/serve/daemon.test.ts        [T2..T6] 端点测试(逐任务增 describe)
gui/src/connection.ts           [T7] 设置方法族(12 个)
gui/src/settings/               [T8/T9] SettingsShell/SettingsForm/徽标/toast/十面板
gui/src/App.tsx                 [T8] 设置态(左栏切换/右栏隐藏/项目上下文)
gui/src/App.test.tsx            [T8/T9] 增例
gui/src/e2e.test.ts             [T10] 设置场景
```

---

### Task 1: AgentRegistry 两级装载 + 宽容视图

**Files:**
- Modify: `src/harness/subagent.ts` / `src/harness/index.ts`
- Test: `src/harness/subagent.test.ts`(增 describe)

**Interfaces:**
- Produces(T5 端点消费,签名逐字):

```ts
// subagent.ts
export interface AgentEntryView {
  readonly id: string; readonly name: string; readonly description?: string;
  readonly memory?: boolean; readonly isolation?: string; readonly executor?: string;
  readonly source: 'project' | 'global'; readonly shadowed: boolean;
  readonly bodyPreview: string;  // 正文前 200 字符
}
export interface AgentsView { readonly entries: AgentEntryView[]; readonly warnings: string[]; }
export function loadAgentsView(projectRoot: string, globalDir: string): AgentsView;
// 两级扫描(全局 <globalDir>/agents/ + 项目 <projectRoot>/agents/),逐文件宽容:畸形(parseAgentFrontmatter throw/读失败)入 warnings 不抛死;
// 项目 id 撞名遮蔽全局(全局条目 shadowed=true 保留展示);bodyPreview=frontmatter 后正文 slice(0,200)
```

- `AgentRegistry.loadAgents(projectRoot, globalDir?)` 改两级装载(全局先、项目遮蔽;装配纪律不变:任一级畸形文件仍 fail-fast——运行期装配语义零变);`registerBuiltins` 不动;`harness/index.ts:203` 调用点传 `userConfigDir()`(import 自 ../config/env)。

- [ ] **Step 1: 失败测试**(subagent.test.ts 增):①两级装载+项目遮蔽(Registry.resolve 走项目版)②loadAgentsView:global+project 清单/遮蔽标记/bodyPreview/畸形文件入 warnings 不抛③单级存在即可(无全局目录=空);RED → [ ] **Step 2: 实现** → [ ] **Step 3: `pnpm build && node --test dist/harness/subagent.test.js` 全绿(既有面零破坏)** → [ ] **Step 4: Commit** `feat(harness): G8c-T1 AgentRegistry 两级装载(项目遮蔽全局)+宽容视图`

---

### Task 2: settings 自填槽 + GET/PUT /settings(核心)

**Files:**
- Modify: `src/config/settings.ts` / `src/serve/daemon.ts` / `src/serve/daemon.test.ts`

**Interfaces:**
- Produces:

```ts
// settings.ts(模块态)
export function getSelfFilledSlots(): readonly string[];   // 本进程装载链自填的 SUNSHINEX_* 槽
// applySettings 内:process.env[slot]===undefined 写入时登记;loadSettingsChain/直接 applySettings 均经此单点

// daemon.ts
GET /settings?root=<abs>  → 200 {
  keys: Array<{ key: string;            // 语义键(model/language/contextWindow/…33 键全集=SEMANTIC_KEYS 键序)
                value: string | null;   // effective 值(process.env 槽值;null=未配置走缺省)
                source: 'env' | 'project' | 'global' | 'default';
                envOverride: boolean }>, // source==='env'(真导出,非自填)→gui 禁编+徽标
  permissions: { merged: PermissionsConfig; project: PermissionsConfig; global: PermissionsConfig },
  providers: { choices: ModelChoice[]; apiKeyPresent: Record<string, boolean>; warnings: string[] }
}
// source 判定:槽在 process.env 且非自填→'env';自填→读 root 项目文件有值→'project',否则全局文件有值→'global',否则(链来自其他 root 的窄缝)→'env';槽缺→文件链同判定→'default'
// providers: loadProviders(root) 展开;apiKeyPresent[name]=resolveProviderApiKey(name)!==undefined(布尔,不显值)
PUT /settings { root?: string; updates: Record<string, string | number | null> }  → 200 { ok: true }
// null=删键;未知语义键 400(列 RETIRED 提示);值类型非 string|number 400;目标=root 的 .sunshinex/settings.json(root 缺省=仅全局?PUT 无 root 即写全局?裁定:PUT 必带 root 或 scope——本端点恒项目级(body.root 必填,缺 400;全局级编辑走 raw));
// 结构化写:parse 原文件(缺=空对象)→改键→保 version/env/permissions/providers/未知键→JSON.stringify(obj,null,2) 原子写;含注释→409;成功→reloadSettingsChain(root)(清自填→applySettings(project)→applySettings(global))
```

- [ ] **Step 1: 失败测试**(daemon.test.ts 增 describe):①GET 无 root:env 真导出键(envStub SUNSHINEX_LANGUAGE)source='env'+envOverride;global 文件键 source='global';无配置 source='default' value=null ②GET root=项目:项目文件键 source='project' 覆盖 global 同键 ③permissions 两级+merged ④providers choices/apiKeyPresent 布尔 ⑤PUT 改键→GET 反映新值 source='project';文件在盘可复读;未知键 400;null 删键 ⑥含注释文件 PUT→409 ⑦PUT 后自填槽重载:PUT 改 SUNSHINEX_CONTEXT_WINDOW 键→process.env 槽新值(新会话即刻生效面——直接断言 process.env.SUNSHINEX_CONTEXT_WINDOW===新值);真导出键 PUT 改文件成功但 env 值不动(恒最优先)。
- [ ] **Step 2: 实现**(settings.ts 登记+daemon 路由×2+reloadSettingsChain 私方法+effective 判定 pure fn)→ [ ] **Step 3: `pnpm build && node --test dist/serve/daemon.test.js` 全绿** → [ ] **Step 4: Commit** `feat(serve): G8c-T2 /settings 端点——effective 视图/来源分层/结构化改写/自填槽清除重载`

---

### Task 3: raw 双文件端点(GET|PUT /settings/raw)

**Files:**
- Modify: `src/serve/daemon.ts` / `src/serve/daemon.test.ts`

**Interfaces:**

```ts
GET /settings/raw?scope=project|global&root=<abs>&file=settings|mcp → 200 { content: string }   // 缺文件→{content:null}
PUT /settings/raw { scope, root?, file, content } → 200 { ok: true }
// 验证:file=settings→parseSettingsFile(content)(throw→400 {error:原文 message});file=mcp→stripJsonComments+JSON.parse+根对象+loadMcpServers 形态装载成功(用 config.ts 导出;若 parseMcpJsonFile 私有→本任务导出之);
// scope=global 时 root 忽略(定位 userConfigDir());file=mcp 的 global 路径=<userConfigDir>/mcp.json;原子写(tmp+rename);成功后 file=settings→reloadSettingsChain(root 或 entry)
```

- [ ] **Step 1: 失败测试**:GET 双 scope 双文件往返;PUT settings 畸形 JSONC→400 带行号;PUT mcp 畸形→400;合法写盘+复读一致;scope=global 落对路径;未知 scope/file 400。 → [ ] **Step 2: 实现** → [ ] **Step 3: 全绿** → [ ] **Step 4: Commit** `feat(serve): G8c-T3 raw 双文件端点——JSONC 原文编辑+服务端验证拒存+原子写`

---

### Task 4: MCP 端点族(合并视图/probe/结构化写)

**Files:**
- Modify: `src/serve/daemon.ts` / `src/serve/daemon.test.ts`;(按需)`src/config/config.ts`

**Interfaces:**

```ts
GET /settings/mcp?root= → 200 { servers: Array<
  { name; transport: 'stdio'|'http'|'sse'; command?; args?; url?; envKeys: string[]; source: 'project'|'global'; shadowed: boolean }> }
// loadMcpServers 内部两级语义的视图化:项目全量(source='project',shadowed=false)+全局按名(被项目遮蔽→shadowed=true)
POST /settings/mcp/probe { root?, name } → 200 { ok: true; tools: Array<{ name; description?: string }> } | 200 { ok: false; error: string }
// 合并清单(loadMcpServers)定位该名;临时 MCP Client(stdio/http/sse transport 同 McpHost.makeTransport 三分支,内联小装配)→connect(10s 超时)→serverInfo.name!==name→{ok:false,'identity mismatch'}→listTools→close;任何失败 catch→{ok:false,原因串(截120)}
PUT /settings/mcp { root; servers: Array<{ name; transport?; command?; args?; url?; env?: Record<string,string> }> } → 200 { ok: true }
// 整块写项目级 mcp.json(键 mcpServers);逐条形状校验(stdio 需 command/http·sse 需 url/名非空)→400;含注释→409;原子写;成功不触发 settings 重载(mcp 装配期语义,新会话生效)
```

- [ ] **Step 1: 失败测试**:①GET 两级+遮蔽标记 ②probe 成功态:**fixture 最小 stdio MCP server**(daemon.test 内联写 tmp node 脚本:stdin 行读 JSON-RPC→initialize 应答 serverInfo.name 匹配+tools/list 应答一工具;~30 行)→probe {ok:true,tools 一枚} ③probe 失败态:command 不存在→{ok:false,error 含 connection};identity mismatch 形态(名不符)→{ok:false} ④PUT 写盘/形状 400/409。 → [ ] **Step 2: 实现** → [ ] **Step 3: `pnpm build && node --test dist/serve/daemon.test.js` 全绿** → [ ] **Step 4: Commit** `feat(serve): G8c-T4 MCP 端点族——两级遮蔽视图/单台真探测/结构化写`

---

### Task 5: agents 端点(两级清单+增删改)

**Files:**
- Modify: `src/serve/daemon.ts` / `src/serve/daemon.test.ts`

**Interfaces:**

```ts
GET /settings/agents?root= → 200 { builtins: Array<{ role: string; name: string; framing: string }>; view: AgentsView }   // T1 loadAgentsView;builtins=ROLE_PRESETS 四角色(导出或经 registry 暴露——subagent.ts 导出 builtinAgentRoles(): Array<{role,name,framing}>)
PUT /settings/agents { root?, scope: 'project'|'global'; op: 'upsert'|'delete'; id; frontmatter?: { name: string; description?: string; memory?: boolean; isolation?: string; executor?: string }; body?: string } → 200 { ok: true }
// id 安全校验 /^[A-Za-z0-9][A-Za-z0-9_-]*$/→400;upsert:frontmatter 生成(name 必填 400)+body 缺省空→写 <scopeDir>/agents/<id>/agent.md(---\nname: …\n---\n正文);写后回读 parseAgentFrontmatter 验证(防生成坏文件=装配 fail-fast 写盘前防线)→失败 500 不落盘;delete:目录存在→rm -rf;不存在→幂等 ok
```

- [ ] **Step 1: 失败测试**:GET 两级+builtins+warnings;upsert project/global 两 scope 落对路径+文件内容 frontmatter 形状;写后 GET 清单含新条;坏 id 400;缺 name 400;delete 移除+幂等;upsert 后 loadAgentsView 无 warnings(生成物必合法)。 → [ ] **Step 2: 实现** → [ ] **Step 3: 全绿** → [ ] **Step 4: Commit** `feat(serve): G8c-T5 agents 端点——两级清单/表单增删改/写后回读验证`

---

### Task 6: skills 三源分组 + memory-stats 端点

**Files:**
- Modify: `src/harness/skills.ts` / `src/serve/daemon.ts` / `src/serve/daemon.test.ts`

**Interfaces:**

```ts
// skills.ts
export interface SkillsGroup { source: 'project' | 'user' | 'learned'; skills: Array<{ id: string; name?: string; description?: string }> }
export function loadSkillsGrouped(root: string): SkillsGroup[];   // priorityChain 三段分别装载(project 段=projectSkillDirs 合并)
// daemon.ts
GET /settings/skills?root= → 200 { groups: SkillsGroup[] }
GET /settings/memory-stats?root= → 200 { entries: number; lastWriteAt: number | null }
// 主域记忆目录(resolveDataDir(root)/memory 主域——按 memory/paths.ts 实构定位,实现期核对):条数=记录文件数;lastWriteAt=最大 mtime;无目录→{entries:0,lastWriteAt:null}
```

- [ ] **Step 1: 失败测试**:skills 三源分组(project 根多目录并入 project 组/去重沿 loadSkills 语义——分组视图不去重跨组?裁定:组内去重沿装载序,跨组不去重(展示重复 id 标注)→按此断言);memory-stats 造 2 文件断言 entries=2+lastWriteAt=max mtime;空目录零值。 → [ ] **Step 2: 实现** → [ ] **Step 3: 全绿** → [ ] **Step 4: Commit** `feat(serve): G8c-T6 技能三源分组+记忆概览端点`

---

### Task 7: gui connection 设置方法族

**Files:**
- Modify: `gui/src/connection.ts`
- Test: `gui/src/connection.test.ts`(增)

**Interfaces:**
- Produces(T8/T9 消费,方法名逐字):

```ts
settings(root?: string): Promise<SettingsView>;                       // GET /settings(类型同 T2 应答,connection.ts 内定义 SettingsView/SettingsKeyRow/…)
putSettings(root: string, updates: Record<string, string | number | null>): Promise<void>;
settingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp'): Promise<{ content: string | null }>;
putSettingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp', content: string): Promise<void>;
mcpServers(root?: string): Promise<{ servers: McpRow[] }>;
mcpProbe(root: string | undefined, name: string): Promise<{ ok: true; tools: Array<{ name: string; description?: string }> } | { ok: false; error: string }>;
putMcpServers(root: string, servers: McpRowInput[]): Promise<void>;
agentsView(root?: string): Promise<{ builtins: BuiltinRole[]; view: AgentsView }>;
putAgent(input: { root?: string; scope: 'project' | 'global'; op: 'upsert' | 'delete'; id: string; frontmatter?: AgentFrontmatterInput; body?: string }): Promise<void>;
skillsGroups(root?: string): Promise<{ groups: SkillsGroup[] }>;
memoryStats(root?: string): Promise<{ entries: number; lastWriteAt: number | null }>;
```

- [ ] **Step 1: 失败测试**(stub fetch 模式沿 connection.test 既有):12 方法 URL/方法/body/应答解码;putSettings 空体 204?(以 T2 应答为准 200 {ok});错误透传既有惯例。 → [ ] **Step 2: 实现**(纯 fetch 面,零 UI)→ [ ] **Step 3: `pnpm --dir gui exec vitest run src/connection.test.ts` 全绿+typecheck** → [ ] **Step 4: Commit** `feat(gui): G8c-T7 connection 设置方法族十二件`

---

### Task 8: gui 设置态壳 + 简单表单四面板

**Files:**
- Create: `gui/src/settings/SettingsShell.tsx` / `gui/src/settings/SettingsForm.tsx` / `gui/src/settings/SourceBadge.tsx`
- Modify: `gui/src/App.tsx` / `gui/src/pages/`无改(左栏=新 `gui/src/sidebar/` 或 App 内——ProjectMenu 底栏加设置钮:改 `gui/src/sidebar/ProjectMenu.tsx`)/`gui/src/App.test.tsx`

**Interfaces:**
- App 增态:`settingsOpen: boolean`;左栏底栏设置钮(Settings icon)→开:左栏内容整体切换为 SettingsShell(导航+「← 返回」),主区=所选面板,右标签栏整体隐藏;项目上下文态 `settingsRoot: string`(默认 openRoot,无则 ''=仅全局);顶栏项目选择器(select,/workspaces 值)。
- SettingsForm(通用键值表单引擎):props {conn, root, pane: Array<{key,label,input:'text'|'number'|'boolean'}>};渲染 SettingsView.keys 过滤本 pane 键→行=SourceBadge+输入(disabled 当 envOverride,title「env 覆盖中,改文件不生效」)+保存钮→putSettings→toast「已生效:新建会话起」(sx-toast,3s 自隐)。
- 四简单面板(同引擎配键):通用(language/shell/projectsDir/userSkillsDir/globalSunshine)/上下文与限额(contextWindow/maxTokens/subagentTokenCap/teamTokenCap/maxSteps/maxLoopIterations/maxGraphNodes/readFence/sandbox/isolation)/记忆(autoMemory/learnedSkills/learnedSkillLimit/memoryIdleKickMs/stepDigestMaxSteps/stepDigestItemChars/stepDigestTotalChars + 概览行 entries/lastWriteAt 只读)/知识库与搜索(kbBackend/kbDataDir/embeddingBaseUrl/embeddingModel/websearchProvider/websearchEndpoint)。
- SourceBadge:env=橙/project=蓝/global=灰/default=无徽标(小圆点+title)。

- [ ] **Step 1: 失败测试**(App.test 增):设置钮→设置态(左栏导航在/右栏隐藏/Esc 或返回→回会话态);SettingsForm 桩测:行渲染/来源徽标类名/envOverride 禁编/保存调 putSettings+toast 出现。 → [ ] **Step 2: 实现** → [ ] **Step 3: `pnpm --dir gui exec vitest run src/App.test.tsx` 全绿+typecheck** → [ ] **Step 4: Commit** `feat(gui): G8c-T8 设置态壳——左栏切换导航/项目上下文/表单引擎+四简单面板/徽标/toast`

---

### Task 9: 复杂面板五件(模型与提供方/MCP/智能体/技能/权限+高级 raw)

**Files:**
- Create: `gui/src/settings/ProvidersPane.tsx` / `McpPane.tsx` / `AgentsPane.tsx` / `SkillsPermsPane.tsx` / `RawPane.tsx`
- Modify: `gui/src/settings/SettingsShell.tsx`(导航挂全十面板)/`gui/src/App.test.tsx`

**Interfaces:**
- ProvidersPane:模型五键+ tier/reasoningEffort/baseUrl 表单(SettingsForm 复用)+ providers 只读卡列表(name/models 数/apiKeyPresent 圆点+槽名)。
- McpPane:server 卡列表(source 徽标/shadowed 灰显/envKeys 打码值)/「测试连接」→mcpProbe→卡内结果行(tools 折叠名列表或 error);添加/编辑表单(name/transport 下拉/command+args/url/env 键值对)→putMcpServers(整块提交=现清单替换);删除同路。
- AgentsPane:builtins 四只读卡+loadAgentsView 清单(source 徽标/shadowed 灰显/memory/isolation/executor 属性 chip/bodyPreview);新增/编辑表单(scope 选择/id/name/description/memory/isolation/executor/body textarea)→putAgent upsert;删除→putAgent delete;warnings 告警卡。
- SkillsPermsPane:上=技能三源分组清单(只读行 id+description);下=权限两级+合并表(deny/allow/additionalDirs 行,级别徽标)。
- RawPane:scope 选择(project/global)+file 选择(settings/mcp)+textarea(等宽 sx-raw-editor)+「验证」(putSettingsRaw 试存,400 错误行内显示)+「保存」;读 settingsRaw 装载。
- 全部面板消费 T7 方法;加载/错误行内态;禁用态=无 root 时项目级面(提示「选择项目」)。

- [ ] **Step 1: 失败测试**(每面板一例,桩 conn):McpPane 探测按钮回调+结果行;AgentsPane upsert 表单提交回调+清单渲染;RawPane 验证错误行内;SkillsPerms 分组+合并渲染;Providers 卡+apiKeyPresent 点。 → [ ] **Step 2: 实现** → [ ] **Step 3: `pnpm --dir gui exec vitest run src/App.test.tsx` 全绿+typecheck** → [ ] **Step 4: Commit** `feat(gui): G8c-T9 复杂面板五件——providers/MCP 探测/智能体增删改/技能权限只读/raw 编辑器`

---

### Task 10: e2e + 全量门禁 + spec 注记

**Files:**
- Modify: `gui/src/e2e.test.ts` / `docs/superpowers/specs/2026-10-07-gui-redesign-design.md`

**e2e 场景(2 新,15→17):**
1. **设置改键→新会话生效链**:建会话(项目 root)→设置态→通用面板改 language=zh 改 shell 键→保存 toast→GET 面反映 source='project'→**重启 daemon(新进程重读链)→GET 仍 project 值**(持久化);同一 daemon 内 PUT contextWindow 后**直接建新会话成功且 process.env 断言经 /settings 反映**(e2e 断言面=GET /settings value/source)。
2. **MCP probe+智能体增删改**:mcp.json 造一台坏 command 服务器→MCP 面卡在→探测→{ok:false,error} 行内;agents upsert 一台→GET 清单含→新会话 attach 正常(装配不炸)→delete→清单空。

**门禁:** `pnpm --dir gui test`(全量)→`pnpm --dir gui run test:e2e`(17)→`pnpm build && node --test dist/serve/daemon.test.js dist/serve/session.test.js dist/serve/pty.test.js dist/harness/subagent.test.js`。spec G8c 行划线注记(G8a/b 行同款)+**已知跟进注记**(按终审缓议补)。

- [ ] **Step 1-5**:e2e 红→绿→门禁三步→spec 注记→Commit(`feat(gui): G8c-T10 e2e 设置全链场景+门禁` + `docs(spec): G8c 交付注记`)。

---

## Self-Review(已执行)

1. **Spec 覆盖**:§2.5 十面板=T8 四+T9 五+高级 RawPane(=10)+左栏切换/项目分组导航(T8 壳);端点族=T2/T3/T4/T5/T6;自填槽重载=T2;AgentRegistry 两级化=§0④=T1;来源徽标/env 禁编/toast=T8;MCP 探测/智能体 scope=U-D12a/b;编辑双轨守卫=T2/T3/T4。缺口:无。
2. **占位扫描**:各任务测试断言面以具体条目给出(非「适当验证」);memory-stats 目录定位注「实现期核对 paths.ts 实构」=唯一实构依赖点,其余全钉死。无 TBD。
3. **类型一致**:SettingsView/McpRow/AgentsView/AgentFrontmatterInput/SkillsGroup 名称在 T2/T4/T5/T6 定义、T7/T8/T9 消费一致;putAgent 输入形 T5↔T7 一致;scope/root 参数序恒 (scope, root, file)。
