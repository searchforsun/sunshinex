# GUI 风格与布局重构(Codex 对标)设计规格

- **日期**:2026-10-07
- **状态**:设计定稿 v3(多标签侧栏裁定),待评审,未实施
- **来源**:用户 2026-10-07 指令——对标 Codex 风格优化、现代图标、交互人性化;三栏布局(左会话菜单/中主区/右栏);**右栏为多标签页形式,可放任何扩展性质内容,+ 号新开:终端、Web、Diff、文件、目录等**(附参照图:右侧顶部标签条,活动标签 pill+×关闭+「+」新开)
- **关联**:`docs/superpowers/specs/2026-10-06-gui-v1-design.md`(G1-G7 已交付;本 spec 是其 UI 层重构批次 **G8**)、`docs/ROADMAP.md`(5B)
- **现状**:gui 包**零 CSS**(class 名仅为测试钩子)——本批建立设计系统并完成布局重构

## 0. 范围与判定

**架构级**(布局重构改变 App 骨架,波及全部页面与测试选择器)。**UI 层为主 + 两个受限新端点**:目录标签需 `GET /session/:id/tree`(单层目录列举,复用 /file 会话边界校验);终端标签需 `POST /session/:id/exec`(一次性命令,走会话 harness 同源命令执行链)。零既有协议变更、其余 daemon 改动为零(Agents 标签消费既有 `payload.subagent` 事件,纯 gui 侧)。

## 1. 布局:左会话菜单 + 中主区 + 右多标签侧栏(用户 2026-10-07 两次裁定)

```
┌──────────┬────────────────────────────┬──────────────┐
│ Sessions │  Main                      │ [文件×][Diff×][+]│ ← 标签条
│          │                            ├──────────────┤
│ 工作区    │  Chat(会话中,常驻)           │              │
│ ▾ 会话列表│                            │  当前标签内容  │
│          │  消息流(满高滚动)             │  (目录树/文件/ │
│ + 新会话  │                            │   Diff/任务/  │
│          │  ┌──────────────────────┐  │   Agents/终端/│
│ (底部:   │  │ 输入区(贴底)          │  │   Web)       │
│  连接态)  │  └──────────────────────┘  │              │
└──────────┴────────────────────────────┴──────────────┘
```

- **左会话菜单**(240px):顶栏工作区名(当前 root,点击可切换/回工作区列表);会话列表(id/相对时间/状态点,当前高亮);底部「+ New session」(→DirPicker 模态)与连接状态点。**原 Home 全页退役**——其工作区/会话列表职能内化为左栏;无会话时主区显示欢迎空态(引导新建/选择)。
- **中主区**:Chat 满高(消息流+输入区贴底);Chat 的既有 Chat|Board|Files 顶部 tab **退役**(面板移入右栏标签)。
- **右多标签侧栏**(默认 420px,Diff 双列可读;8px 拖拽调宽边条,200-720px clamp):
  - **标签条**(顶):打开的标签横排(图标+标题+×;活动标签 pill 高亮;溢出横向滚动 v1);末端「**+**」按钮弹菜单按类型新开;右端「≫」折叠整个右栏。
  - **标签内容**(剩余满高):当前标签的组件;每类自带空态。
- **标签模型**:
  - 标签态**每会话独立**(Map<sessionId, tabs>——切会话各持各的标签页);新会话默认开「任务」一页。
  - **同目标去重**:按 resolveKey(params) 判重——重开同文件/同 Diff/同 URL = 聚焦既有标签,不重复开。
  - **单例类型**(任务/Agents/目录):全局一份,重开=聚焦;多实例类型(文件 by path/Diff by callId/Web by URL/终端)各开各的。
- 无会话时右栏整体禁用(标签条灰+tooltip);Tasks/Agents 会话维数据,文件/Diff/目录/终端会话维路由。
- 快捷键 v1:Alt+W 关当前标签、Ctrl+Alt+←/→ 切换标签(Ctrl+W/Ctrl+Tab 为浏览器保留键,不可捕获);Esc 折叠右栏(既有 Esc 语义处除外)。

## 2. 标签类型注册表(可扩展核心)

`gui/src/tabs/registry.tsx`:每类型一条注册 `{ id, icon, title, singleton?, resolveKey(params), Component }`;「+」菜单=注册表枚举(分组:内容[目录/文件/Diff]/会话[任务/Agents]/工具[终端/Web])。新类型=新增一条注册,零壳层改动——这是「放任何扩展性质内容」的架构保证。

| 类型 | 内容 | 数据源 | 实例 |
|---|---|---|---|
| **目录** | 工作区文件树(逐层展开=逐请求单层列举;点文件→开「文件」标签);默认忽略 `.git`/`node_modules`/`dist`/`dist-gui`,单层 500 条上限+截断标记 | **新** `GET /session/:id/tree?path=`(会话边界校验同 /file) | 单例 |
| **文件** | 现 Files 页迁入(路径输入+高亮预览+truncated 横幅) | readFile 既有 | by path |
| **Diff** | write 条目点击 → 该 callId 的 diff(old/new 双列,标题=path) | fetchDiff 既有 | by callId |
| **任务** | Board 的 List 视图迁入(紧凑行+gate 行内审批);**DAG 视图保留**(标签内 List/DAG 切换图标钮) | 板投影既有 | 单例 |
| **Agents**(新) | 子 agent 活动卡:每 delegation 一卡(name/status/tokens/当前工具调用);live 流消费 `payload.subagent` 标签事件(TUI ChildPanel 同源);卡片展开 mini 转录(最近 20 行) | 事件流新增收集器(gui 侧 `agent-activity.ts` 纯 reducer) | 单例 |
| **终端**(新) | 一次性命令控制台:输入行+执行中态+滚动回显(exitCode/stdout/stderr 着色);命令走会话命令执行链——manual 模式下自动走既有审批卡流 | **新** `POST /session/:id/exec {command}`(cwd=会话 root;timeout≤60s;输出尾部 200 行/64KB 截断) | 多实例 |
| **Web**(新) | URL 栏+sandboxed iframe(用于 localhost 预览/允许嵌入的文档页;外部站点多受 X-Frame-Options 拒嵌,属预期限制,加载失败显示提示) | 直连(不经 daemon) | by URL |

**终端 v1 边界**:一次性执行(非交互 PTY);PTY 交互式/流式输出/中断按钮归壳批次(独立 spec)。

**配套修复(顺带)**:chat reducer 目前把 `payload.subagent` 事件混入主聊天流(潜在串染)——本批在 `applyChatEvent` 入口过滤 `payload.subagent` 在场的事件(交 Agents 标签消费),Chat 面只留 delegation 摘要行(既有)。

## 3. 设计系统(设计令牌 + 单 CSS)

- `gui/src/app.css`(单文件,CSS 自定义属性令牌,main.tsx import):
  - 色板(**暗色优先**,Codex 口径):`--bg-0`(app 背景 #0d1117 系)/`--bg-1`(面板 #161b22)/`--bg-2`(浮层)/`--fg-0/1`(主/次文本)/`--border`(#30363d)/`--accent`(#4493f8)/`--ok`/`--warn`/`--err`;亮色后置(令牌就位,换值即可)。
  - 排版:系统栈 `ui-sans-serif`;13px 基准/12px 辅助;代码 `ui-monospace` 12px。
  - 形状:6px 圆角(卡/输入/标签 pill);1px 边框常态;hover 背景 `--bg-2`;focus-visible 2px accent 外环(a11y)。
- 组件级样式类前缀 `sx-`(如 `sx-tabstrip`/`sx-tab`/`sx-tab-active`/`sx-panel`);**既有测试钩子 class 原名保留**(测试零迁移优先;新增结构用 sx- 前缀)。

## 4. 图标:lucide-react

- gui 唯一新依赖 `lucide-react`(现代线性图标,Codex/Linear/shadcn 同审美;tree-shake 按需 import)。
- 映射:目录=FolderTree,文件=FileText,Diff=GitCompare,任务=KanbanSquare,Agents=Bot,终端=TerminalSquare,Web=Globe;交互:Send(发送)/Square(停止)/ArrowLeft(返回)/X(关闭)/Plus(新开标签)/RefreshCw(刷新)/ChevronRight(折叠/树展开)/PanelRight(右栏折叠);状态:Circle(Point 指示连接态)。
- 尺寸 16px;strokeWidth 1.75;颜色继承 currentColor。

## 5. 交互人性化清单

1. 右栏 8px 拖拽调宽(200-720px,双列 Diff 可读);「≫」折叠右栏;左栏 v1 固定 240px(拖宽后置)。
2. Chat 顶栏:返回/会话 id/状态(既有顶栏简化——工作区导航已在左栏,面包屑退役)。
3. 空态:每标签类型图标+一句引导(目录「展开工作区文件树」/文件「输入路径预览文件」/终端「运行一次性命令,manual 模式走审批」/Agents「暂无子 agent 活动」);标签区全空时显示类型快捷入口(等效 + 菜单)。
4. 输入区:Enter 提交(既有)+ textarea 自增高(1-6 行,Shift+Enter 换行——**注意**:G3 以来 Enter=提交,本批输入框从 input 迁 textarea)。
5. hover 一致性:可点元素恒 hover 态;按钮 disabled 恒 50% 透明+禁 pointer。
6. 流式光标:streaming 条末尾 1.5px 闪烁竖线(CSS animation)。
7. 状态条(贴输入区上方):连接点(四态色)+status+tokens/steps(既有数据,重排为图标+数字组)。
8. gate 审批/任务行的 ⚠ 改 Badge 组件(小圆标,恒可读)。
9. Home 工作区/会话行(左栏):hover 态+相对时间(「3m ago」)。
10. 快捷键:Alt+W 关标签/Ctrl+Alt+←/→ 切标签(v1);Esc 折叠右栏(已有 Esc 语义处除外)。

## 6. 测试策略

- **既有测试零迁移优先**:测试钩子 class 原名保留;结构迁移(Files/Board 入标签)不可避免的选择器变更最小化(容器级 data-testid 加固)。
- 新增:agent-activity reducer 纯测(聚合/过滤/最近 N 行);标签框架测(开/关/切/去重/单例/每会话独立);tree 端点测(边界拒/忽略项/上限截断);exec 端点测(路由/超时/截断/manual 审批接线);App 集成(subagent 事件不再入 Chat 流)。
- e2e:既有 11 例照跑(选择器兼容)+ 新增:Agents 标签 live 卡/目录树展开开文件/+ 菜单新开终端跑命令。
- **无视觉回归测试**(无截图基建,YAGNI)——评审以结构+交互断言为门。

## 7. 批次切分(G8,一阶段一 plan)

| 批次 | 范围 |
|---|---|
| G8a | 设计系统(app.css 令牌)+lucide+三栏布局壳+**标签框架**(注册表/标签条/+菜单/开/关/切/去重/每会话态)+Chat 迁中栏+文件/任务入标签+chat subagent 过滤修复 |
| G8b | Agents 标签(reducer+卡+mini 转录)+Diff 标签接线+**目录标签**(tree 端点+树组件)+**终端标签**(exec 端点+控制台)+**Web 标签**(iframe)+交互清单落地+e2e |
| G8c | 全量门禁+两 spec/ROADMAP 回写(壳批次注记维持:PTY 终端/托盘) |

## 8. 决策记录

| # | 决策 | 放弃的替代 | 依据 |
|---|---|---|---|
| U-D1 | 左会话菜单+中主区+**右多标签侧栏**(标签条+×/++,任意数量内容页;用户 2026-10-07 两次裁定) | 图标条单选面板(v2)/顶部 tab | 用户参照图与指令;标签=文档模型比单选面板可扩展一档 |
| U-D2 | 标签类型注册表(resolveKey 判重/singleton 声明/组件挂载) | 每类型硬编码进壳 | 「放任何扩展性内容」的架构保证;新类型零壳层改动 |
| U-D3 | 标签态每会话独立;新会话默认开「任务」 | 全局共享标签 | 会话维数据隔离(板/转录);切会话不串台 |
| U-D4 | 终端 v1=一次性命令控制台(会话命令执行链,manual 自动接审批卡) | 真 PTY(node-pty)/流式 WebSocket 终端 | PTY=原生依赖+流协议+resize 生命周期,壳批次量级;一次性执行已覆盖「跑个命令看看」主场景且零新协议面(HTTP JSON 即可) |
| U-D5 | Web 标签=sandboxed iframe(URL 栏) | 内置代理抓取渲染 | 零 daemon 面;X-Frame 拒嵌为预期限制(localhost 预览/文档页可用),提示明示 |
| U-D6 | 目录=单层列举端点(逐层拉取)+默认忽略 .git/node_modules/dist* | 一次性全量树快照 | 全量树大仓库不可控;逐层=每次请求有界 |
| U-D7 | 单 CSS 文件+设计令牌 | Tailwind/CSS Modules/inline | 零构建侵入(gui 既有 vite 最简);令牌换值即亮色;~400 行可控 |
| U-D8 | lucide-react | 手写 SVG sprite/图标字体 | 现代审美标配,tree-shake,一依赖;手绘 20+ 图标质量不可控 |
| U-D9 | 暗色优先 | 亮色优先/双主题 | Codex 对标口径;令牌架构双主题就位 |
| U-D10 | Agents 标签消费 payload.subagent 事件 | 复用 delegation 摘要(TUI 不足:无转录) | TUI ChildPanel 同源数据既有;gui 零协议新增 |
| U-D11 | 既有测试钩子 class 保留 | 全量 testid 重命名 | 测试零迁移优先;新结构 sx- 前缀隔离 |
| U-D12 | Enter=提交/Shift+Enter=换行,textarea | 维持单行 input | 人性化输入;对齐主流 chat UX |
| U-D13 | Diff by callId 多实例(替代 v2 的栈深 1) | 多 diff 栈(G8 前案即此,已升级) | 标签模型天然多 diff 并存,栈 hack 退役 |
