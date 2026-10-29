# 四类资源存储与设置规范化设计（skills / MCP / plugins / agents）

- 日期：2026-10-28
- 状态：设计定稿（待用户审阅 → 实现计划）
- 范围：src/catalog（新共享存储库）、src/config（settings/plugins 加载语义 + providers 规范化 + 散键退役）、src/config.ts（loadMcpServers 项目级复活）、src/harness/subagent.ts（agents 两级+enabled+兼容读）、src/model/catalog.ts（缺省内芯恒为 choices[0]）、src/serve（设置端点对称补齐 + WS config-changed 帧 + 文件监听）、src/cli（资源全套子命令 + settings get/set + providers）、src/tui（/mcp /agents /plugins /skills /providers 面板）、gui/src/settings（ScopeSwitcher/SearchBar/ResourceCard/EditorDrawer 共享组件 + 11 页统一卡片风格）
- 前置关系：插件体系（2026-10-26 设计已实施）提供 manifest/两级发现/安全契约；本设计不改动插件 manifest 规范，只恢复其开关的项目级生效、并把四类资源的存储、作用域、UI、CLI、TUI、实时同步统一到一套规范。

## 0. 背景与病灶（2026-10-28 现状勘查）

| 类别 | 全局位置 | 项目位置 | 开关元数据 | 病灶 |
|------|----------|----------|------------|------|
| skills | `~/.sunshinex/skills`；学习技能 `<dataDir>/skills`；插件附带 | 5 个兼容根（`.sunshinex/.agents/.claude/.codex/.cursor` 各自 `skills/`） | **无**（仅优先级静默遮蔽） | 遮蔽不可见；无来源链视图 |
| MCP | `~/.sunshinex/mcp.json`（加载唯一来源，10-27 裁定） | `.sunshinex/mcp.json`——**僵尸**：设置页仍写、加载器不读 | 条目级 `enabled`/`disabledTools` | 写读不一致；项目作用域有名无实 |
| plugins | 内置 `plugins/` + `~/.sunshinex/plugins` | 无（项目 settings `plugins` 键 10-27 起被忽略） | settings `plugins` 键（仅全局生效） | 项目键成死配置（本仓库自身即实例）；开关无项目级 |
| agents | `~/.sunshinex/agents/` | **`<root>/agents/`**——唯一活在 `.sunshinex/` 体系外 | 无开关 | 位置不统一；无启停 |

GUI 层：11 个面板 5 种布局习惯（SettingsForm 卡片引擎 / Mcp+Plugins 共用 `sx-mcp-*` 卡片 / Skills 独立网格 / Permissions 三列表格 / Raw 裸 textarea）；AgentsPane 用原生 `<form>` 控件未走共享 Select/Combo；仅 Skills 页有搜索；**无任何页面有全局/项目切换器**（root 是打开设置瞬间的隐式快照）；新增/编辑仅 MCP（JSON 文本域）与 agents（表单）。

同步层：守护进程**零文件监听**，WS 只推会话事件；设置面板全部 fetch-on-mount、写后自 refetch——外部/CLI 改文件、双窗口同开设置互相不可见。

CLI 层：仅 `skills install` 与 `plugins list/validate`；MCP/agents/settings 无命令。

## 1. 决策记录（用户裁定 2026-10-28）

1. **作用域**：恢复**项目遮蔽全局**——MCP 项目文件复活加载、插件开关恢复项目级；项目同名/同 id 遮蔽全局，UI 明确标注遮蔽关系。安全阀：项目级 MCP 首次启用需一次确认（防克隆仓库自带 mcp.json 自动拉起进程）。此裁定反转 2026-10-27 的「应用级」裁定。
2. **存储格式**：**单文件惯例 + settings.json 元数据中枢**。mcp 每作用域一个 `mcp.json`（含 enabled）；插件开关/配置留 settings `plugins` 键；`agent.md` frontmatter 新增可选 `enabled`；agents 项目目录迁入 `.sunshinex/agents`（旧位置兼容读）。否决「每类文件夹+registry.json」方案（迁移面大、破坏 mcp.json 生态惯例）。
3. **实时同步**：**双向实时**——守护进程加文件监听 + WS 广播 `config-changed` + 开着的设置页自动刷新；GUI 编辑继续直接写盘。
4. **CLI 面**：**四类全套 CRUD** + `settings get/set`；统一 `--scope`；**TUI 同样支持**（面板+启停，编辑引导 CLI/$EDITOR）。
5. **代码架构**：**共享存储库 + 各端薄封装**（新建 `src/catalog/`，harness 加载器改为消费同一 merge 逻辑）；否决原地修补（作用域逻辑继续漂移）与全泛型资源引擎（对 4 类属过度设计）。
6. **模型与提供方规范化**（2026-10-28 二次需求并入）：providers/model 配置**平级列表存储**，全局级散键退役；GUI 支持新增编辑，TUI/CLI 同样支持；**默认选中模型 = 第一个 provider 的第一个 model**。详见 §15。

**缺省裁定（用户评审可翻）**：skills 不设开关、不做增删改（只读 + 搜索 + 遮蔽标注）；CLI `--scope` 默认 project@cwd（对齐 `claude mcp` local 默认）；TUI 不做表单编辑；档位路由三键（modelSmall/modelMedium/modelLarge）随 `model`/`baseUrl` 一并退役，档位改为 models 条目可选 `tier` 标注表达（此条为澄清问题未及答复后的推荐落法，评审可翻回「部分退役」）。

## 2. 存储层规范（目标布局）

```text
~/.sunshinex/                              全局作用域
  settings.json    语义键 + env + permissions + providers
                   + plugins{<id>:{enabled,config}}        # 元数据中枢（不变，恢复两级生效）
                   + mcpApprovals{<projectSlug>:[name...]} # 新增：项目 MCP 批准记录
                   + mcpDenied{<projectSlug>:[name...]}    # 新增：项目 MCP 拒绝记录（不再询问）
  mcp.json         {mcpServers:{<name>:{command,args?,env?,transport?,url?,headers?,enabled?,disabledTools?}}}
                   # 格式不变
  skills/<id>/SKILL.md                       # 不变；学习技能仍在 <dataDir>/skills
  plugins/<id>/                              # 用户安装插件目录（不变）
  agents/<id>/agent.md                       # 位置不变；frontmatter 新增可选 enabled（缺省 true）

<root>/.sunshinex/                         项目作用域
  settings.json    不变；plugins 项目级键恢复生效
  mcp.json         复活：项目级 MCP，遮蔽全局同名；条目首次加载需批准（§4）
  skills/<id>/SKILL.md                       # 不变（五兼容根优先级链不动）
  agents/<id>/agent.md                       # 新家；旧位置 <root>/agents/ 兼容读（遮蔽全局、低于新家——
                                             # 终审修复波裁定 2026-10-28，见 §2 作用域规则注），写只写新家
```

**统一作用域规则**：四类一律项目遮蔽全局（同 id/同名，视图标 `shadowed`）；settings 语义键维持既有 env > project > global 填充链不动。skills 的五兼容根优先级链（`.sunshinex` > `.agents` > `.claude` > `.codex` > `.cursor` > user > learned > plugin）不动，仅视图补遮蔽标注。

> **agents 三级优先级终审裁定（2026-10-28 终审修复波，控制器裁定）**：agents 的旧位置并非全资源统一规则下的「最低优先级」——装载器（harness.AgentRegistry.loadAgents，Task 7 收口）三级序为 **global → legacy（旧位置）→ 新家**，last-wins 即**旧位置遮蔽全局、新家遮蔽旧位置/全局**（保住分支前行为与迁移叙事）。2026-10-28 终审修复波裁定：**以装载器语义为准**，catalog 读面（listAgents）对齐——旧位置撞全局时旧位置行照列且生效（shadowed 恒 false），同 id 全局行降标 shadowed 保留在列；撞新家时旧位置不列。此前 catalog 读面「全局在场时旧位置整行隐藏」与装载器的三面分歧（CLI/TUI 显示全局副本、运行期却装 legacy 副本）随之收口，显示与运行恒同一副本（跨面钉测见 harness/subagent.test ④）。

**enabled 语义**：agent.md `enabled: false` ⇒ 注册表中剔除（等同不存在，不参与遮蔽计数）；缺省/true ⇒ 正常。MCP 条目 `enabled: false` 维持现状语义（列出但标停用）。插件 enabled 由 settings 记录表达（两级：项目记录存在则用项目记录，否则全局记录，否则 manifest `defaultEnabled`）。

**版本策略**：无格式版本升级——settings `version` 仍为 1，mcp.json 格式不变，agent.md 仅增量可选字段。旧文件无需迁移即可用。

## 3. `src/catalog/` 共享存储库

```text
src/catalog/
  types.ts      Scope = 'global'|'project'；ResourceKind = 'mcp'|'agent'|'plugin'|'skill'|
                'settings'|'permissions'|'providers'（watch/WS 帧的 resource 联合类型）；
                Entry/Listing<T>{entries,warnings}
  mcp.ts        listMcpServers(root|null)            # 两级合并视图 + scope/shadowed/approval 标注
                upsertMcpServer(root,scope,name,server) / removeMcpServer / setMcpServerEnabled
                approveMcpServer(root,name) / denyMcpServer(root,name)
  agents.ts     listAgents(root|null)                # 全局 → 项目旧位置 → 项目新家（层序=装载序；
                                                     # 旧位置遮蔽全局、新家最高——终审修复波裁定
                                                     # 2026-10-28 对齐 harness 装载器，见 §2 注）+
                                                     # 含 enabled:false 项（视图可见可再启用）+
                                                     # shadowed/oldLocation 标注
                upsertAgent(root,scope,id,spec) / removeAgent / setAgentEnabled
                                                     # 运行时加载器（harness）剔除 enabled:false
  plugins.ts    listPlugins(root) / setPluginEnabled(root,scope,id,enabled) / setPluginConfig
                                                     # 发现复用 config/plugins.ts 不动
  providers.ts  listProviders / upsertProvider / removeProvider / setProviderApiKey（写 settings
                env 块，响应不回显）/ modelAdd / modelRemove / modelMove / testProvider
                                                     # 见 §15；格式沿现 providers 键
  skills.ts     listSkills(root,opts)                # 分组+来源链+遮蔽标注（包装 harness/skills.ts 既有链）
  approvals.ts  项目 MCP 批准/拒绝记录读写（settings mcpApprovals，按 projectSlug）
  watch.ts      watchConfigs(targets) → EventEmitter # 防抖 fs.watch 目录级 → {resource,scope,root}
```

约定：所有写走**原子写**（tmp+rename）与**注释保护**（JSONC 文件含注释时结构化写返回 409 语义，由调用方决定走 raw/外科手术更新，复用 `surgicalSettingsUpdate`）；所有 list 从盘即时读（无缓存层，与现状一致——实时性由 watch 推送刷新承担，不由缓存承担）。

**单一事实源改造**（行为收口的关键）：
- `src/config.ts loadMcpServers(root)`：改调 `catalog/mcp.ts` 的合并+批准过滤逻辑（今日它读全局 mcp.json、`void projectRoot`）。
- `src/harness/subagent.ts loadAgents`：改调 `catalog/agents.ts` 的两级+旧位置+enabled 逻辑（保持 fail-fast 加载纪律与 `loadAgentsView` 宽容视图分离）。
- `src/config/plugins.ts readGlobal`：恢复两级 settings 读取（今日 global-only、项目键「存在即忽略」）。
- `src/harness/skills.ts` 不动（catalog/skills.ts 仅做视图组合）。

## 4. 安全阀：项目 MCP 首次启用确认

- 项目 `.sunshinex/mcp.json` 中出现 `mcpApprovals[projectSlug]` 未记录的 server：**不自动拉起进程**；条目标 `pendingApproval`。
- 批准/拒绝动作：GUI 设置页「待确认」徽标 + 确认/拒绝按钮；TUI 启动加载时列出未批准项并提示 `/mcp approve <name>`（非阻塞问答）；CLI `mcp list` 标注 + `mcp approve|deny <name>` 子命令。
- 批准记录写全局 settings `mcpApprovals.{projectSlug}:[names]`（projectSlug 沿用 `src/config/data-dir.ts` 折叠规则）；拒绝记录同结构存 `mcpDenied`，拒绝过的不再询问、加载器直接跳过。
- 全局 mcp.json 条目**不需要**批准（用户亲手配置的机器级文件）。

## 5. REST / WS 层（serve）

现有端点全部保留（URL 兼容，GUI 无缝）：`GET/PUT /settings`、`GET/PUT /settings/raw`、`GET /settings/mcp`、`POST /settings/mcp/probe`、`PUT /settings/mcp`（整块，保留兼容）、`GET/PUT /settings/plugins`、`GET/PUT /settings/agents`、`GET /settings/agents/body`、`GET /settings/skills`、`GET /settings/memory-stats`。

补齐对称缺口（全部走 catalog，409 注释保护/原子写/reload 语义不变）：
- `PUT /settings/mcp/op`：`{op:'add'|'remove'|'enable'|'disable'|'approve'|'deny', scope, root?, name, server?}` —— 单条操作；今日全局只能 raw、修改只能整块替换，此端点收口。
- `PUT /settings/agents/op` 扩展 op 值 `enable|disable`（现有 upsert|delete 保留）。
- `PUT /settings/providers/op`：`{op:'add'|'update'|'remove'|'modelAdd'|'modelRemove'|'modelMove'|'setKey', scope, name, provider?, model?, apiKey?, direction?}` —— apiKey 写入 settings `env` 块（`SUNSHINEX_API_KEY_<UPPER>`），响应永不回显密钥（现状纪律）；op 值语义见 §15。
- `PUT /settings/permissions/op`：`{op:'add'|'remove', scope, list:'deny'|'allow'|'additionalDirs', value}` —— 权限列表结构化增删（今日 GUI 只读、编辑靠 raw）。
- `GET /settings/skills` 无写端点（维持只读）。

**WS 新增 `config-changed` 帧**：`{kind:'config-changed', resource, scope, root}`，广播给所有已连 GUI（设置是全局面，不区分 session）；由 watch 层（§6）驱动。

## 6. 双向实时同步

- **监听目标**：全局 `~/.sunshinex/`（settings.json、mcp.json 两文件 + agents/、plugins/ 子目录）+ 各活跃会话项目 root 的 `.sunshinex/` 整目录（含 skills/、agents/、mcp.json、settings.json）；会话打开时 addWatch、关闭时 removeWatch。
- **机制**：`fs.watch` 目录级（Windows 对编辑器原子替换的 rename 事件友好，零新依赖）；300ms 防抖合并；事件映射 `{resource, scope, root}` 后经 daemon-ws 广播。skills 目录变化同样广播（GUI 技能页与 TUI 面板可刷新）。
- **回环抑制**：catalog 写函数在写前置 in-flight 标记（路径+时间窗 500ms），watch 回调窗口内忽略自触事件。
- **GUI 消费**：设置 shell 订阅 WS，收到帧后对受影响 pane 触发 refetch（复用现有 fetch 函数），多帧 200ms 合并。
- CLI/TUI 为一次性进程，不做监听；它们写文件 → GUI 自动跟上，方向反一面的「GUI 写 → 后续 CLI 读」天然从盘即读。
- **降级**：watch 不可用（网络盘/权限）时仅 daemon 日志告警，功能回退到现状（GET 即读、写后自 refetch），不阻塞。

## 7. GUI 设置页（现代卡片，统一，少术语）

**壳**：SettingsShell 顶栏加全页共用 **ScopeSwitcher**（全局/项目分段控件；无项目 root 时项目侧禁用+提示）；scope 状态提升到 shell，写目标随切换。替换今日三种各自为政的作用域处理（Mcp pane 内联判断 / Agents scope select / Raw 全局锁死）——Raw 页随之解锁项目作用域。

**共享组件**（gui/src/settings/components.tsx + controls.tsx 扩展）：`ScopeSwitcher / SearchBar（防抖过滤）/ ResourceCard（图标+名称+版本/来源 chip+SourceBadge+开关+详情折叠+操作钮）/ EditorDrawer（右侧抽屉表单；复用 Select/Combo/输入；「JSON 源码」高级折叠）/ EmptyState / ErrorBanner`。新字符串一律 `t(en, zh)` 内联双语。

**四张资源页统一为一屏式**（顶栏 = 搜索 + 新增；主体 = 卡片列表；scope 在壳上）：
- **MCP**：卡片列 server（连接状态点、transport chip、工具数、SourceBadge）；操作 = 测试/编辑/删除/启停；新增/编辑走 EditorDrawer（名称/transport/command|url/args/env 表单 + JSON 源码折叠）；项目作用域下全局同名卡标「被项目遮蔽」；`pendingApproval` 卡标「待确认」+ 确认/拒绝钮。
- **Agents**：卡片化重写（弃原生 form）；EditorDrawer 表单（id 编辑态锁定/名称/描述/记忆/隔离/执行器/正文）+ 启停开关；builtin 角色只读卡；旧位置条目标「旧位置」+ 一键迁移钮（copy 至 `.sunshinex/agents/`，旧目录保留不动）。
- **Plugins**：卡片 + 搜索保留；配置编辑（configSchema 驱动键值）进 EditorDrawer；无新增（安装=目录拷贝，另议）。
- **Skills**：只读网格 + 搜索 + 来源过滤保留；补同 id 跨来源遮蔽标注（谁遮蔽了谁）；无启停无增改。

**其余页补齐**：Providers 按 §15 重构（卡片增删改 + 默认标记 + 「API 地址」行与模型 Combo 删除）；Permissions 从只读表格升级为 deny/allow/additionalDirs 结构化增删；SettingsForm 四页加行过滤 SearchBar。全部 11 页统一卡片视觉令牌（间距/圆角/标题层级/描述行高）。

**文案纪律**：描述改人话、去术语（如 `disabledTools` → 「不加载这些工具」），示例保留；沿 KEY_DESCRIPTIONS 模式集中维护。

## 8. CLI

```text
sunshinex mcp      list [--scope=global|project] [--root=dir] [--json]
                   add <name> (--command=<cmd> [--arg=a]... [--env=K=V]... | --url=<u> [--transport=t])
                   remove|enable|disable <name> / test <name> / approve|deny <name>
sunshinex agents   list|add|remove|enable|disable
                   add <id> --name=... --description=... [--memory] [--isolation=worktree]
                       [--executor=internal-team|external-cli] [--body-file=<path>]
sunshinex plugins  list|enable|disable <id> [--scope] [--root]
sunshinex providers list|add|remove|set|key|test [--scope] [--root]
                   add <name> --base-url=<u> [--models=m1,m2,...] [--context-window=]
                              [--reasoning-effort=] [--supports-images]
                   set <name>（同 add 字段，增量更新）/ key <name>（交互隐藏输入，写 env 块）
                   model add|remove|move <provider> <model> [--tier=small|medium|large] [--direction=up|down]
sunshinex skills   list [--scope=all]              # 保留既有 install
sunshinex settings get <key> | set <key> <value> [--scope]
```

- `--scope` **默认 project**（root=cwd，写时自动建 `.sunshinex/`），`--scope=global` 切全局，`--root` 覆盖 cwd（对齐 `claude mcp` local 默认）。
- 全部子命令走 catalog 薄封装；表格输出（cli-table3 已有依赖），`--json` 供脚本。
- `mcp add` 项目级时打印「首次加载需 approve」提示；`settings get` 打印 effective 值 + 来源（env/project/global/default）；`settings set` 经 SEMANTIC_KEYS 校验。

## 9. TUI

按 `commands-*` 族先例（commands-skills.ts / commands-memory.ts 拆分件模式）新增：
- `/mcp`：两级合并列表（scope/状态/待确认标注）+ `/mcp enable|disable|approve|deny <name>`；`/mcp add` 引导到 `sunshinex mcp add` 或 `$EDITOR` 打开对应 mcp.json（TUI 不做表单）。
- `/agents`：注册表列表（含 enabled/旧位置标注）+ `/agents enable|disable <id>`。
- `/plugins`：清单 + `/plugins enable|disable <id>`。
- `/providers`：provider/model 清单卡（密钥状态、默认标记）+ `/model` 切换卡补「默认」徽标；编辑引导 CLI（`sunshinex providers add/...`）或 `$EDITOR`（TUI 不做表单，沿缺省裁定）。
- `/skills`：扩展现有 commands-skills 面板，补来源与遮蔽标注（轻改）。
- 项目 MCP 有未批准项时，TUI 启动加载后打一行提示（非阻塞）。

## 10. 迁移与兼容

- agents 旧位置 `<root>/agents/`：继续读（遮蔽全局、低于新家——终审修复波裁定 2026-10-28，见 §2 注），写只写新家；GUI 一键迁移（copy，不删旧）；不自动搬移（不动用户仓库文件）。
- 项目 mcp.json 僵尸复活：现存文件直接进合并视图（本仓库自身 `{"mcpServers":{}}` 即实例）；其中 server 首次加载走批准阀。
- settings `plugins` 项目键：从「存在即忽略」恢复为两级生效；本仓库自身 `.sunshinex/settings.json` 的两插件启用配置自动复活。
- 无数据迁移脚本、无版本升级；`MANUAL.md`/`docs/PLUGIN-DEV.md` 相应章节随实现更新。

## 11. 测试策略

- **catalog 每模块 node:test**：两级合并/遮蔽标注/enabled 语义/批准阀（批准加载、未批准跳过、拒绝不再询问）/注释 409/原子写/agents 旧位置兼容读/JSONC 容忍。
- **watch.ts**：临时目录真实 write/rename 触发 → 防抖事件断言；回环抑制断言。
- **serve handlers**：op 端点、providers/permissions op、409 路径、config-changed WS 帧、reload 语义。
- **CLI**：spawn dist 端到端（`mcp add` → `mcp list --json` 断言；agents add → list）。
- **GUI vitest**：ScopeSwitcher/SearchBar/ResourceCard/EditorDrawer 组件；四页过滤/遮蔽/待确认渲染；config-changed → refetch。
- **手工验收**：双窗口互见、CLI 改→GUI 闪刷、外部编辑器改→GUI 更新、项目 MCP 批准全流程、TUI 四面板。

## 12. 不做清单（YAGNI）

skills 增删改与启停（用户裁定除外）；插件安装/卸载 CLI 与市场；配置云同步/多机；TUI 表单编辑；permissions/providers 的 raw 之外第三种编辑路径；registry.json 类元数据文件。

## 13. 验收标准（可测）

1. 四类资源 GUI 统一卡片风格；MCP/Agents/Plugins 支持作用域切换、搜索、新增/编辑/删除/启停；Skills 只读+搜索+遮蔽标注。
2. 项目 mcp.json 中 server 经批准后真实生效（probe 可见工具）；未批准不拉起进程；拒绝后不再询问。
3. 插件项目级开关真实生效且与 GUI 来源徽标一致。
4. CLI 全套子命令可用，与 GUI 写同一批文件（交叉验证一致）。
5. 外部编辑四类文件后，打开中的 GUI 设置页 ≤1s 自动反映；daemon 自写不产生多余刷新。
6. `<root>/agents/` 旧位置继续可用且 GUI 一键迁移成功。
7. 全量门禁绿：主仓 node:test + `pnpm --dir gui run typecheck` + gui vitest。
8. 模型与提供方（§15）：providers 列表三端增删改一致；默认模型恒为第一×第一且有标记；散键退役有 warning 指引；档位路由按 tier 标注工作。

## 14. 风险与缓解

- **fs.watch 平台差异**（网络盘/权限）：仅监听本地路径；不可用时降级现状语义（GET 即读），功能不阻塞（§6 降级条款）。
- **harness 加载行为变化**（MCP 项目级复活、agents enabled、model 散键退役）：批准阀兜底安全面；退役键 warning 指引兜底迁移；catalog 单测钉死合并语义；现有 guard/probe 回归测试盯防。
- **并行会话同仓冲突**：本重构触碰 config.ts/plugins.ts/subagent.ts 等热区——实现计划须小任务粒度、每任务收口前全量测试、提交前 rebase。
- **GUI 改面大**：共享组件先行落地一页（MCP）验证形态，再批量铺开，避免 11 页齐改齐崩。

## 15. 模型与提供方规范化（2026-10-28 二次需求并入）

**病灶**：`providers` 结构化键已是平级列表（`[{name, baseUrl, contextWindow?, reasoningEffort?, supportsImages?, models:[string|{model,...}]}]`，两级整键遮蔽，展开为 `ModelChoice` 供 `/model` 选择卡），但旁边并存全局级散键 `model`/`baseUrl`（GUI「API 地址」行）/`modelSmall`/`modelMedium`/`modelLarge`（档位路由三键）→ 环境槽 → 单模型装配链。模型配置散在两处，`model` 未显式配置时缺省内芯恰好已是第一×第一（`ModelSwitcher.explicitDefault` 分支管理这个特例）。

**目标形态**：providers 列表 = 模型配置唯一事实源。

1. **存储**：settings `providers` 键格式不变，models 条目对象形态新增可选 **`tier?: 'small'|'medium'|'large'`** 标注；密钥仍走 env 槽（`SUNSHINEX_API_KEY_<源名>` 专用槽 > 主槽，D6「密钥不进结构化键」延续）；项目键**整键遮蔽**维持现状（键粒度的项目遮蔽全局，与决策 1 对齐）。
2. **散键退役**：`model`/`baseUrl`/`modelSmall`/`modelMedium`/`modelLarge` 移入 `RETIRED_KEYS`（带指引「改用 providers 列表」）；解析遇退役键打 warning 不致命（语义沿 `structuredOutput` 先例）；`tier`/`effort` 语义键保留（请求参数，非 provider 配置）。装配链缺省内芯恒为 `choices[0]`，`explicitDefault` 分支退役。
3. **默认模型规则**：默认选中 = `choices[0]` = **providers 数组序 × models 数组序的第一×第一**；顺序即优先级——GUI EditorDrawer 模型行带上移/下移，CLI `--models` 逗号清单序即序、`model move` 调序；列表首位标「默认」chip。无 defaultModel 覆盖键（用户裁定：默认即派生）。
4. **档位路由**：`/model-tier`（TUI）与 GUI 档位 select 语义不变，实现从三散键映射改为清单内按 `tier` 标注选中（同档多模型取第一个；无匹配/未标注回默认 `choices[0]`）。
5. **catalog/providers.ts**：`listProviders / upsertProvider / removeProvider / setProviderApiKey（写 settings env 块，响应不回显）/ modelAdd / modelRemove / modelMove / testProvider`；`testProvider` 复用 probe 思路连通性验证。
6. **REST**：`PUT /settings/providers/op`（§5）op 值 `add|update|remove|modelAdd|modelRemove|modelMove|setKey`。
7. **CLI**：`sunshinex providers list|add|remove|set|key|test` + `providers model add|remove|move`（§8）；`providers key <name>` 交互式隐藏输入写 env 块（无回显）。
8. **TUI**：`/providers` 清单卡 + `/model` 卡补「默认」徽标；编辑引导 CLI/`$EDITOR`（§9）。
9. **GUI**（§7 模型与提供方页）：提供方卡片列表（名称/baseUrl/密钥状态点/models chips/默认标记）+ EditorDrawer 增删改（name/baseUrl/apiKey 输入/models 行编辑含 tier select 与上下移）；「请求参数」卡保留 tier/effort 两个 select，**删除「API 地址」行与模型 Combo**。
10. **兼容**：存量 `model`/`baseUrl` 配置给出一次性 warning 指引；`providers` 键用户无需任何迁移；本仓库自身 settings 若含退役键随 warning 暴露。

**测试**（并入 §11）：catalog/providers 单测（展开/两级整键遮蔽/tier 路由选中/密钥槽解析/env 块写入与不回显/modelMove 调序）；退役键 warning 断言；缺省内芯恒为 choices[0] 断言（含单 provider 单模型、多 provider 混合对象/字符串 models 形态）；CLI providers 端到端；GUI EditorDrawer 模型行排序与默认标记渲染。

**验收**（并入 §13）：providers 三端（GUI 编辑 / CLI 子命令 / TUI 引导）增删改一致生效且写同一批文件；默认模型恒为第一×第一且 GUI 有标记；散键退役有 warning 指引；`/model-tier` 按 tier 标注正确选中、无标注回默认。
