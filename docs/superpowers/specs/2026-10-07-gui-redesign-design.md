# GUI 风格与布局重构(Codex 对标)设计规格

- **日期**:2026-10-07
- **状态**:设计定稿 v9(G8a-e 全量交付收官)(主题统一裁定并入:青色主色/现代/简约/圆润/易读),待评审
- **来源**:用户 2026-10-07 指令——对标 Codex 风格优化、现代图标、交互人性化;三栏布局;右栏多标签页(+ 号新开任意扩展类型:终端/Web/Diff/文件/目录等);尽量用开源组件,终端、Web 等等同本地体验;左栏以项目分组,一个项目一个工作区;设置页:菜单底部入口,点击后左栏变设置菜单栏,通用设置/agent 能力/各配置实时显示——含记忆、技能、上下文设置等,与配置数据对应;MCP 服务器管理并入设置页;插件与子智能体定义并入设置页;**子智能体定义支持全局级别**(七次裁定累积)
- **关联**:`docs/superpowers/specs/2026-10-06-gui-v1-design.md`(G1-G7 已交付;本 spec 是其 UI 层重构批次 **G8**)、`docs/ROADMAP.md`(5B)
- **现状**:gui 包**零 CSS**(class 名仅为测试钩子)——本批建立设计系统并完成布局重构

## 0. 范围与判定

**架构级**(布局重构改变 App 骨架,波及全部页面与测试选择器)。**UI 层 + 四块服务端新增**:
①目录标签 `GET /session/:id/tree`(单层列举,复用 /file 会话边界校验);
②**真 PTY 终端套件**——主仓新依赖 `node-pty`(开源,win32 conpty 预编译),`POST /session/:id/pty`(分配)+ 专用 WS `/session/:id/pty/:ptyId`(双向流,子协议鉴权同主 WS)+ kill/teardown 清杀;gui 新依赖 `@xterm/xterm`+`@xterm/addon-fit`(开源,VS Code 同款终端);
③**设置套件**——`GET /settings`(全键 effective 视图:值+来源层级+可编辑性+permissions 合并结果+providers 卡数据)/`PUT /settings`(结构化改写)/`GET|PUT /settings/raw`(JSONC 原文编辑+验证)/`GET /settings/skills`(三来源技能清单)/**`GET /settings/mcp`(两级 mcp.json 合并清单)+`POST /settings/mcp/probe`(单台真实探测连接)+`PUT /settings/mcp`(结构化改写)**/**`GET|PUT /settings/agents`(子智能体定义清单与增删改)**,全部锚既有 `src/config/*`+`config.ts loadMcpServers`+`harness/mcp/client.ts McpHost`+`harness/subagent.ts AgentRegistry` 真实配置面,零新配置键;
④**harness 小改:AgentRegistry 两级装载化**——全局 `<userConfigDir>/agents/<id>/agent.md`+项目 `<root>/agents/<id>/agent.md`,项目 id 撞名遮蔽全局(与 MCP/技能装载链同构;装配纪律不变:畸形文件 fail-fast、运行期零增删);
④Agents 标签消费既有 `payload.subagent` 事件(纯 gui 侧)。零既有协议变更。
**安装风险**:node-pty 若平台预编译缺席则需本地构建(win32=VS Build Tools)——G8b 首任务即装依赖验证,受阻则降级裁定(备选 `@lydell/node-pty` 预编译分支或壳批次化),不影响 G8a/c。

## 1. 布局:左项目分组菜单 + 中主区 + 右多标签侧栏

```
会话态(默认):                      设置态(左栏切换):
┌────────────┬──────────────┬────┐  ┌────────────┬──────────────┐
│ ▾ sunshinex│  Main        │Tab │  │ ← 返回      │  设置面板      │
│   • s3 运行 │              │条  │  │ ▾ 通用      │  (表单/清单/   │
│   • s2 空闲 │  Chat 常驻    ├────┤  │ ▾ 模型与提供方│   raw 编辑)   │
│ ▸ 项目B     │              │内容│  │ ▾ 上下文与限额│              │
│            │  输入区贴底    │    │  │ ▾ 记忆      │              │
│ + 新会话    │              │    │  │ ▾ 插件:技能/ │              │
│ + 添加工作区│              │    │  │  MCP·智能体 │              │
│ ● 连接 ⚙设置│              │    │  │  高级        │              │
└────────────┴──────────────┴────┘  └────────────┴──────────────┘
```

- **左项目分组菜单**(240px):**工作区=项目,一项目一组**。
  - 组头:项目名(Folder 图标)+会话数 badge+折叠 chevron;点击=展开/收起并惰拉该 root 会话(`/sessions?root=` 既有);当前工作区组恒展开+高亮。
  - 组内会话行:id/相对时间/状态点,当前会话高亮;组内「+」新建=**root 预填该项目**(跳过选目录,仅弹 mode 选择 auto/manual→`/session/new {root,mode}`)。
  - 底部行:连接状态点+**设置钮(⚙ Settings)**——点击进入**设置态**:左栏整体切换为设置导航(顶部「← 返回」回项目分组),中主区显示所选设置面板,右标签栏整体隐藏(设置态非会话态);再次点击返回或 Esc 恢复会话态。
  - 「+ 添加工作区」(DirPicker 模态选新项目根→刷新组列表)。
  - **原 Home 全页彻底退役**(工作区列表+会话列表职能全部内化为左栏);无会话时主区欢迎空态。
- **中主区**:会话态=Chat 满高(消息流+输入区贴底;Chat 的既有 Chat|Board|Files 顶部 tab **退役**,面板移入右栏标签);设置态=设置面板满高。
- **右多标签侧栏**(默认 420px,双列 Diff 可读;8px 拖拽调宽边条,200-720px clamp):
  - **标签条**(顶):打开的标签横排(图标+标题+×;活动标签 pill 高亮;溢出横向滚动 v1);末端「**+**」按钮弹菜单按类型新开;右端「≫」折叠整个右栏。
  - **标签内容**(剩余满高):当前标签组件;每类自带空态。
- **标签模型**:标签态**每会话独立**(Map<sessionId, tabs>——切会话各持各的标签页);新会话默认开「任务」一页;**同目标去重**(resolveKey 判重——重开同文件/同 Diff/同 URL=聚焦既有);**单例类型**(任务/Agents/目录)全局一份,多实例类型(文件 by path/Diff by callId/Web by URL/终端)各开各的。
- 无会话时右栏整体禁用(标签条灰+tooltip);Tasks/Agents 会话维数据,文件/Diff/目录/终端会话维路由。
- 快捷键 v1:Alt+W 关当前标签、Ctrl+Alt+←/→ 切换标签(Ctrl+W/Ctrl+Tab 为浏览器保留键);Esc 折叠右栏/退出设置态(既有 Esc 语义处除外)。

## 2. 标签类型注册表(可扩展核心)

`gui/src/tabs/registry.tsx`:每类型一条注册 `{ id, icon, title, singleton?, resolveKey(params), Component }`;「+」菜单=注册表枚举(分组:内容[目录/文件/Diff]/会话[任务/Agents]/工具[终端/Web])。新类型=新增一条注册,零壳层改动——这是「放任何扩展性内容」的架构保证。

| 类型 | 内容 | 数据源 | 实例 |
|---|---|---|---|
| **目录** | 工作区文件树(逐层展开=逐请求单层列举;点文件→开「文件」标签);默认忽略 `.git`/`node_modules`/`dist`/`dist-gui`,单层 500 条上限+截断标记 | **新** `GET /session/:id/tree?path=`(会话边界校验同 /file) | 单例 |
| **文件** | 现 Files 页迁入(路径输入+高亮预览+truncated 横幅) | readFile 既有 | by path |
| **Diff** | write 条目点击 → 该 callId 的 diff(old/new 双列,标题=path) | fetchDiff 既有 | by callId |
| **任务** | Board 的 List 视图迁入(紧凑行+gate 行内审批);**DAG 视图保留**(标签内 List/DAG 切换图标钮) | 板投影既有 | 单例 |
| **Agents**(新) | 子 agent 活动卡:每 delegation 一卡(name/status/tokens/当前工具调用);live 流消费 `payload.subagent` 标签事件(TUI ChildPanel 同源);卡片展开 mini 转录(最近 20 行) | 事件流新增收集器(gui 侧 `agent-activity.ts` 纯 reducer) | 单例 |
| **终端**(新) | **真 PTY 交互终端**:`@xterm/xterm` 渲染(配色跟设计令牌),addon-fit 自适应尺寸;用户直打——**不经 agent 命令链,不设审批门**(用户自己的手指,VS Code 终端同模型) | **新** `POST /session/:id/pty {cols,rows}`→`{ptyId}` + 专用 WS 双向流(`in`/`data`/`resize`/`exit` 帧,base64);daemon pty 管理器(shell 探测:win32=PowerShell/其余=$SHELL,cwd=会话 root,64KB 环形缓冲供断线重连重放;标签关闭/会话 teardown/daemon 退出=kill) | 多实例 |
| **Web**(新) | URL 栏+sandboxed iframe+「在系统浏览器打开」外开钮+刷新;用于 localhost 预览/允许嵌入的文档页(外部站点多受 X-Frame-Options 拒嵌,属浏览器环境天花板,加载失败显示提示+外开引导) | 直连(不经 daemon) | by URL |

**开源组件口径**(用户裁定):终端=xterm.js(VS Code 同款)+node-pty(微软开源,win32 conpty 预编译)——交互等同本地终端;Web=浏览器环境内 iframe 即开源极限,**真原生 webview 归壳批次**(Tauri webview,独立 spec)。

**配套修复(顺带)**:chat reducer 目前把 `payload.subagent` 事件混入主聊天流(潜在串染)——本批在 `applyChatEvent` 入口过滤 `payload.subagent` 在场的事件(交 Agents 标签消费),Chat 面只留 delegation 摘要行(既有)。

## 2.5 设置页(左栏切换导航 + 主区面板,与配置数据对应)

**数据面全部锚既有真实配置**(`src/config/settings.ts` 33 语义键两级链+`permissions.ts`+`providers.ts`+`memory-config.ts`+`termination-config.ts`+`harness/skills.ts` 装载器)——零新配置键,GUI 是配置数据的视图与编辑器,不是新配置源。

**面板划分**(左栏设置导航 ↔ 主区面板,每键显示 effective 值+来源徽标[env 覆盖/项目级/全局级/缺省];导航分组:通用/模型与提供方/**插件(技能·MCP·智能体)**/上下文与限额/记忆/权限/知识库与搜索/高级):

| 面板 | 内容(真实键) | 编辑 |
|---|---|---|
| **通用** | language/shell/projectsDir/userSkillsDir/globalSunshine | 表单 |
| **模型与提供方** | model/modelSmall/modelMedium/modelLarge/tier/reasoningEffort/baseUrl;**providers 只读卡**(名称+模型清单+apiKey 状态点=env 在场与否,不显值——密钥只走 env 面) | 表单(providers 只读) |
| **MCP** | **服务器清单**(两级合并视图:项目级 `.sunshinex/mcp.json` 撞名遮蔽全局,遮蔽项灰显标注):每台卡=名称/传输(stdio/http/sse)/command+args 或 url/env 键名列表(值打码)/来源徽标;**「测试连接」**=daemon 用 McpHost 同栈临时起单台,返回注册工具数+工具名折叠列表或失败原因(装配报告 warnings 同源);添加/编辑/删除服务器表单(名称/传输下拉/command+args/url/env 键值对) | 清单+探测+表单 |
| **智能体** | **子智能体定义清单**(AgentRegistry 同源解析,两级视图):内建四预设角色只读卡(role key/label/框定摘要)+目录注册卡——**全局 `<userConfigDir>/agents/`+项目 `<root>/agents/` 两级**(项目 id 撞名遮蔽全局,被遮蔽项灰显标注,来源徽标;卡字段:id/name/description/**memory 自有记忆开关**/isolation/executor 外部执行器/正文摘要);**表单增删改带 scope 选择(全局/项目)**(id/name/description/memory/isolation/executor/角色框定正文 textarea→生成 frontmatter+正文写对应层级 agent.md);畸形存量文件以告警卡显示不抛死;**保存前服务端 frontmatter 解析验证**(name 缺失/畸形拒存——装配期 fail-fast 的写盘前防线) | 清单+表单 |
| **上下文与限额** | contextWindow/maxTokens/subagentTokenCap/teamTokenCap/maxSteps/maxLoopIterations/maxGraphNodes/readFence/sandbox/isolation | 表单 |
| **记忆** | autoMemory/learnedSkills/learnedSkillLimit/memoryIdleKickMs/stepDigest 三键;**记忆库概览**(条数+最近沉淀时间,daemon 只读统计);会话内覆盖(TUI /memory)当前态显示 | 表单+概览只读 |
| **技能** | **已装载技能清单**(三来源分组:项目/用户 userSkillsDir/学习沉淀,名称+简述,只读) | 清单只读 |
| **权限** | permissions 两级合并结果(deny/allow/additionalDirs,逐条标注来源层级;项目不得解除全局 deny——展示即教育) | 只读 v1(编辑走高级) |
| **知识库与搜索** | kbBackend/kbDataDir/embeddingBaseUrl/embeddingModel/websearchProvider/websearchEndpoint | 表单 |
| **高级(原始编辑)** | 项目级/全局级 settings.json **与 mcp.json** **JSONC 原文** textarea(注释/env 块/未知键全保真)+「验证」+「保存」 | 原文 |

**「插件」组口径**:sunshinex **现无独立插件运行时**——真实扩展面=技能(三来源)+MCP 服务器+子智能体定义三类,导航以「插件」组收录(子项:技能/MCP/智能体),零死 UI;若未来上插件包(捆绑分发 skills+MCP+agents 的格式),该组直加第四子项。

**编辑双轨制**:表单=结构化改写(保留未知键与 permissions/providers/env 块;**目标文件含注释时拒改并引导高级原文编辑**——防 GUI 写盘抹掉用户注释;同守卫适用 mcp.json;agent.md 为生成式写入不受此限);高级=原文编辑(保存前 `parseSettingsFile`/mcp 解析器服务端验证,畸形拒存;原子写)。「未知语义键/退役键」在高级面板以告警列表显示(RETIRED_KEYS 处置提示透出)。

**生效语义(关键裁定,实时显示的诚实口径)**:装载链=真环境变量 > 项目级 > 全局级 > 缺省(applySettings 只填缺省槽)。daemon 记录自身装入的「自填槽集」;GUI 保存 → daemon 清自填槽 → 重跑装载链 → **后续新建会话即刻生效**;运行中会话配置已捕获**不回改**(与 reset 语义一致);真环境变量覆盖的键标「env 覆盖中,改文件不生效」徽标。每次保存后面板即刷新 effective 视图。**MCP/智能体同口径**:MCP 连接与 AgentRegistry 均在会话装配期建立(逐台降级/一次性加载 fail-fast),改 mcp.json 或 agent.md(任一层级)仅新会话生效,运行中会话不重连不重载——「测试连接」是即时探测,不触碰运行中会话。

## 3. 设计系统(设计令牌 + 单 CSS)

- `gui/src/app.css`(单文件,CSS 自定义属性令牌,main.tsx import):
  - 色板(**暗色优先**,v9 青色统一口径):`--bg-0` #0d1117 系/`--bg-1` 面板/`--bg-2` 浮层/`--fg-0/1`(次文本提亮 #9aa7b3 系)/`--border`/`--accent` **#22d3ee(青色,hover #06b6d4)**/`--ok`/`--warn`/`--err`;focus 环/连接点在线态/pill 活动态/流式光标一律 accent 单源;亮色后置不变(换值即切)。
  - 排版:系统栈 `ui-sans-serif`;13px 基准/12px 辅助;代码 `ui-monospace` 12px。
  - 形状(v9 圆润口径):**基准圆角 10px**(卡/输入/面板),标签 pill 与 Badge **全圆 999px**,图标钮 8px;1px 边框常态+浮层柔和阴影;hover `--bg-2`;focus-visible 2px accent 外环;简约面(左栏组行/导航)去竖分隔以背景层次代边框;间距 12px 基准留白。
- 组件级样式类前缀 `sx-`(如 `sx-tabstrip`/`sx-tab`/`sx-tab-active`/`sx-panel`);**既有测试钩子 class 原名保留**(测试零迁移优先;新增结构用 sx- 前缀)。xterm 主题对象从令牌取色保持一体。

## 4. 图标与开源依赖

- 新依赖三件(全开源):gui `lucide-react`(图标,tree-shake)+`@xterm/xterm`+`@xterm/addon-fit`;主仓 `node-pty`。
- 图标映射:目录=FolderTree,文件=FileText,Diff=GitCompare,任务=KanbanSquare,Agents=Bot,终端=SquareTerminal,Web=Globe,设置=Settings;交互:Send(发送)/Square(停止)/ArrowLeft(返回/设置返回)/X(关闭)/Plus(新开标签)/RefreshCw(刷新)/ChevronRight(折叠/树展开)/Folder(项目组)/PanelRight(右栏折叠);状态:Circle(连接态)。
- 尺寸 16px;strokeWidth 1.75;颜色继承 currentColor。

## 5. 交互人性化清单

1. 右栏 8px 拖拽调宽(200-720px);「≫」折叠右栏;左栏 v1 固定 240px(拖宽后置)。
2. Chat 顶栏:返回/会话 id/状态(既有顶栏简化——项目导航已在左栏,面包屑退役)。
3. 空态:每标签类型图标+一句引导(目录「展开工作区文件树」/终端「完整交互终端,运行任意命令」/Agents「暂无子 agent 活动」);标签区全空时显示类型快捷入口(等效 + 菜单)。
4. 输入区:Enter 提交(既有)+ textarea 自增高(1-6 行,Shift+Enter 换行——**注意**:G3 以来 Enter=提交,本批输入框从 input 迁 textarea)。
5. hover 一致性:可点元素恒 hover 态;按钮 disabled 恒 50% 透明+禁 pointer。
6. 流式光标:streaming 条末尾 1.5px 闪烁竖线(CSS animation)。
7. 状态条(贴输入区上方):连接点(四态色)+status+tokens/steps(既有数据,重排为图标+数字组)。
8. gate 审批/任务行的 ⚠ 改 Badge 组件(小圆标,恒可读)。
9. 左栏项目组/会话行:hover 态+相对时间(「3m ago」);当前会话所在组自动展开滚入视野。
10. 快捷键:Alt+W 关标签/Ctrl+Alt+←/→ 切标签(v1);Esc 折叠右栏/退出设置态(已有 Esc 语义处除外)。
11. 设置面板:来源徽标色分(env=橙/项目=蓝/全局=灰/缺省=无);「env 覆盖中」键的表单控件 disabled+tooltip;保存后行内 toast「已生效:新建会话起」。

## 6. 测试策略

- **既有测试零迁移优先**:测试钩子 class 原名保留;结构迁移(Files/Board 入标签)不可避免的选择器变更最小化(容器级 data-testid 加固)。
- 新增:agent-activity reducer 纯测;标签框架测(开/关/切/去重/单例/每会话独立);tree 端点测(边界拒/忽略项/上限截断);**pty 管理器测**(分配/帧回环/环形缓冲重放/kill/teardown 清杀——node-pty 真进程冒烟);**设置套件测**(effective 视图来源分层/env 覆盖徽标/结构化改写保未知键/含注释文件拒改/raw 验证拒存/自填槽清除重载→新会话生效/运行中会话不回改/**mcp 两级合并遮蔽视图/probe 成败两态/结构化写保真/agents 清单同源解析+畸形告警不抛死+增删改验证拒存**);**harness 测:AgentRegistry 两级装载(全局+项目/撞名遮蔽/畸形 fail-fast 纪律不变)**;App 集成(subagent 事件不再入 Chat 流)。
- e2e:既有 11 例照跑(选择器兼容)+ 新增:Agents 标签 live 卡/目录树展开开文件/+ 菜单开终端跑 `echo` 断言回显/项目组展开拉会话/设置改 language→新会话生效。
- **无视觉回归测试**(无截图基建,YAGNI)——评审以结构+交互断言为门。

## 7. 批次切分(G8,一阶段一 plan)

| 批次 | 范围 |
|---|---|
| ~~G8a~~ | 设计系统(app.css 令牌)+lucide+三栏布局壳+**标签框架**(注册表/标签条/+菜单/开/关/切/去重/每会话态)+**左栏项目分组**(多工作区组/组内会话/组内新建 root 预填)+Chat 迁中栏+文件/任务入标签+chat subagent 过滤修复——~~已交付~~ 2026-10-07(执行注记:壳/标签框架/项目分组左栏/文件任务标签落地,详情 G8e 收官统一回写)。**已知跟进(终审缓议,G8b-e 承接)**:App.test act() 警告收敛+DirPicker 单测回迁(G8e 视觉/卫生波);组头高亮/会话行状态点/禁用条 tooltip 三面 spec §1 未落(G8d 交互清单核);activeRoot 组多行同亮(id 域错配两级判定代价,待 journal-id 映射);sx-menu-add 等类 app.css 补定义+拖宽 user-select(G8e);onUsage 冗余守卫收敛(G8d Agents);TabStrip onNew 死面清理(G8b 触 TabStrip 时) |
| ~~G8b~~ | **终端全链**(node-pty/pty 管理器/分配端点+专用 WS/环形缓冲重连重放/teardown 清杀 + xterm.js 终端标签)+**目录标签**(tree 端点+树组件)——~~已交付~~ 2026-10-07(执行注记:终端全链+目录标签落地,详情 G8e 收官统一回写)。**已知跟进(终审缓议,G8c-e 承接)**:终端标签 TAB_ICONS 图标(SquareTerminal)与 pty 连接断开内联提示(G8e 视觉波);ptyId↔owner 校验(跨会话误杀一致性疣);StrictMode 首挂双分配(dev-only)/attach 闭包退订句柄+PtyManager.killAll 全杀硬化(G8e 可选);目录标签错误态缓存无重试 |
| ~~G8c~~ | **设置全链**(/settings 端点族+自填槽清除重载机制+十面板表单/只读清单/记忆概览/技能清单/MCP 清单+探测+编辑/**智能体定义两级清单+增删改+AgentRegistry 两级装载化**/raw JSONC 双文件编辑+来源徽标与生效 toast;导航含「插件」组)——~~已交付~~ 2026-10-08(执行注记:设置全链十面板+端点族+自填槽重载落地,详情 G8e 收官统一回写)。**已知跟进(终审缓议,G8d-e 承接)**:agents 全文读取端点(编辑正文现以 200 字预览守卫兜底)/高级面未知·退役键告警列表+memory 会话内覆盖显示(§2.5 两显示项下料)/RawPane 读取在途切目标窄竞态+scope 滞留(root 清空时)/SettingsForm 无取消守卫+relTime 三份漂移/MANUAL.md 模板补 teamTokenCap 行+键数注释(文档面)/跨 root reload「最近编辑为准」+运行中会话惰性拾取(架构项,per-session 链装化评估)/PUT root 无工作区限制(localhost+token 姿态既判维持) |
| ~~G8d~~ | **主题统一(青色令牌重定+全组件圆润简约 polish+xterm 同步)**+Diff 标签接线+Agents 标签(reducer+卡+mini 转录+**全文读取端点**)+Web 标签(iframe+外开)+交互清单落地+高级面退役键告警+e2e——~~已交付~~ 2026-10-08(执行注记:青色主题统一+Diff/Agents/Web 标签+交互清单落地,详情 G8e 收官统一回写)。**已知跟进(终审缓议,G8e 承接)**:conn-dot 在线态 accent 样式桥(规则缺失不可见)+G8a 交接三面(组头高亮/会话行状态点/禁用条 tooltip——G8d 计划漏吸收,baton 追认)+sx-agent-card/id 与 G8c 设置面类名碰撞(G8e 样式波先裁 namespace-vs-share)+光标 1.5px 细化+4px 圆角残段+Web 标签 title 恒 Web;seedFromSnapshot 播种窗 delegation 帧不重放进聚合(一行可闭,tagged 终态事件已兜底);agents/body 404 回显 scope/id 替绝对路径;样式类挂名未定义集(sx-diff/web/badge 等) |
| ~~G8e~~ | 全量门禁+两 spec/ROADMAP 回写(壳批次注记维持:原生 webview/托盘)——~~已交付~~ 2026-10-08(执行注记:样式波+遗留页面青化+缓议清偿+pty owner 校验+统一回写)。**终局归档(不再挂任务)**:跨 root reload「最近编辑为准」/PUT root 无工作区限制(localhost+token 姿态)/StrictMode 首挂双分配(dev-only)/attach 闭包退订(有界)/activeRoot 多行同亮(journal-id 映射待产品裁定)/memory 会话内覆盖(TUI 进程级,gui 不适用)/PtyManager.killAll 全杀硬化(G8e 可选项未做,teardown 扫 sessions 键面维持)/Web 标签 title 恒 Web(带参开档入口后置) |

## 8. 决策记录

| # | 决策 | 放弃的替代 | 依据 |
|---|---|---|---|
| U-D1 | 左项目分组菜单+中主区+右多标签侧栏+左栏可切设置态(用户 2026-10-07 四次裁定累积) | 图标条单选面板/顶部 tab/单工作区左栏 | 用户参照图与指令;标签=文档模型,项目分组=一项目一工作区,设置=左栏切换 |
| U-D2 | 标签类型注册表(resolveKey 判重/singleton 声明/组件挂载) | 每类型硬编码进壳 | 「放任何扩展性内容」的架构保证;新类型零壳层改动 |
| U-D3 | 标签态每会话独立;新会话默认开「任务」 | 全局共享标签 | 会话维数据隔离(板/转录);切会话不串台 |
| U-D4 | **终端=真 PTY:xterm.js+node-pty,专用 WS 双向流**(用户裁定「等同本地」) | 一次性命令控制台(v3 案,已退役)/shell 批次后置 | 用户明确要开源组件+本地等同体验;xterm+node-pty 即 VS Code 终端同栈,成熟开源 |
| U-D5 | PTY 专用 WS(分配走 HTTP,流走独立 WS,64KB 环形缓冲断线重放) | 复用主事件 WS 多路复用 | 终端流高频大流量,独立通道不冲击事件面背压;重连可恢复是「等同本地」的底线体验 |
| U-D6 | PTY 不设审批门:用户直打,非 agent 命令路径 | 接 manual 审批 | VS Code 终端同模型——用户自己的手指即授权;cwd 锚定会话 root |
| U-D7 | Web=iframe+外开钮;真原生 webview 归壳批次(Tauri) | daemon 代理剥 X-Frame(脆弱+安全负资产) | 浏览器内嵌任意站是环境天花板,代理方案得不偿失;诚实提示+外开兜底 |
| U-D8 | 左栏项目分组:工作区=组,组内会话惰拉,组内新建 root 预填 | 单工作区列+顶部切换 | 用户裁定「以项目为分组,一个项目一个工作区」;/workspaces+/sessions?root= 既有零新增 |
| U-D9 | 设置页=左栏切换导航+主区面板;数据全锚既有配置面(33 语义键+permissions/providers/记忆/技能),零新配置键 | GUI 自有配置存储/再造配置源 | 用户裁定「和配置数据对应」;settings.json 是配置正名(仓内既判),GUI 只做视图与编辑器 |
| U-D10 | 设置编辑双轨:表单结构化改写(保未知键/块;含注释文件拒改引导原文)+高级 JSONC 原文编辑(服务端验证拒存畸形) | 仅表单(抹注释)/仅原文(门槛高) | 注释是用户资产不可静默抹;parseSettingsFile 既有单点即验证器 |
| U-D11 | 生效语义:daemon 自填槽清除重载→新会话即刻生效;运行中会话不回改;真 env 恒最优先(覆盖键标徽标+禁编) | 保存即热更运行中会话/daemon 重启才生效 | 运行中会话配置不可变与 reset 语义一致;热更=配置漂移泥潭;重启=体验不可接受 |
| U-D12 | 技能/权限/记忆概览 v1 只读展示(权限编辑走高级原文) | 全面板可编辑 | 三者结构复杂度远超表单承载;只读展示已满足「实时显示」;编辑面按需后置 |
| U-D12a | **MCP 面板=两级合并清单+单台真实探测(McpHost 同栈临时起)+表单增删改**;生效仅新会话(装配期连接,运行中不重连) | 只读清单(不探测)/daemon 常驻重连 | 探测给「实时显示」真值(注册工具数/失败原因);常驻重连=新协议面+生命周期复杂度,YAGNI;两文件(项目/全局)遮蔽语义与技能装载链同构 |
| U-D12b | **智能体面板=AgentRegistry 同源两级清单(内建四预设只读+全局/项目 agents 目录注册)+agent.md 表单化增删改带 scope(保存前 frontmatter 解析验证,畸形拒存=装配 fail-fast 的写盘前防线)** | 只读清单/自造定义格式 | 用户裁定「子智能体定义」+「支持全局级别」;目录注册制/frontmatter/内存开关/外部执行器全是既有真数据;生成式写盘无注释抹除问题 |
| U-D12d | **harness:AgentRegistry 两级装载化(全局 `<userConfigDir>/agents/`+项目 `<root>/agents/`,项目撞名遮蔽全局)** | 仅项目级(现状)/全局覆盖项目 | 用户裁定「子 agent 定义也支持全局级别」;遮蔽方向与 MCP/技能装载链同构(就近优先),装配纪律不变(畸形 fail-fast/运行期零增删) |
| U-D12c | **「插件」=导航组收录技能/MCP/智能体三真实扩展面** | 造独立插件运行时/空态占位页 | sunshinex 现无插件运行时——造=无数据死 UI,空态=占位废页;三扩展面归组即「插件」实质,未来插件包格式直加子项 |
| U-D13 | 目录=单层列举端点(逐层拉取)+默认忽略 .git/node_modules/dist* | 一次性全量树快照 | 全量树大仓库不可控;逐层=每次请求有界 |
| U-D14 | 单 CSS 文件+设计令牌 | Tailwind/CSS Modules/inline | 零构建侵入(gui 既有 vite 最简);令牌换值即亮色;~400 行可控 |
| U-D15 | lucide-react | 手写 SVG sprite/图标字体 | 现代审美标配,tree-shake,一依赖;手绘 20+ 图标质量不可控 |
| U-D16 | 暗色优先 | 亮色优先/双主题 | Codex 对标口径;令牌架构双主题就位 |
| U-D17 | Agents 标签消费 payload.subagent 事件 | 复用 delegation 摘要(TUI 不足:无转录) | TUI ChildPanel 同源数据既有;gui 零协议新增 |
| U-D18 | 既有测试钩子 class 保留 | 全量 testid 重命名 | 测试零迁移优先;新结构 sx- 前缀隔离 |
| U-D19 | Enter=提交/Shift+Enter=换行,textarea | 维持单行 input | 人性化输入;对齐主流 chat UX |
| U-D20 | Diff by callId 多实例 | 多 diff 栈(G8 前案)/栈深 1 | 标签模型天然多 diff 并存,栈 hack 退役 |
| U-D21 | **主题统一:青色 #22d3ee 主色单源,现代/简约/圆润(基准 10px/pill 全圆)/易读(次文本提亮)**(用户 2026-10-08 裁定) | 多主题色/维持蓝 accent | 用户指令「统一主题色青色和风格,现代,简约,圆润,易读」;单源令牌=xterm/focus/pill/光标一次换全 |
