# GUI 风格与布局重构(Codex 对标)设计规格

- **日期**:2026-10-07
- **状态**:设计定稿,待评审,未实施
- **来源**:用户 2026-10-07 指令——对标 Codex 风格优化、侧栏标签页(diff/文件/任务/子 agent)、现代图标、交互人性化
- **关联**:`docs/superpowers/specs/2026-10-06-gui-v1-design.md`(G1-G7 已交付;本 spec 是其 UI 层重构批次 **G8**)、`docs/ROADMAP.md`(5B)
- **现状**:gui 包**零 CSS**(class 名仅为测试钩子)——本批建立设计系统并完成布局重构

## 0. 范围与判定

**架构级**(布局重构改变 App 骨架,波及全部页面与测试选择器)。**只做 UI 层**:组件结构/样式/交互;零协议变更、零 daemon 改动(唯一例外:Agents 面板消费既有 `payload.subagent` 事件,纯 gui 侧)。

## 1. 布局:左会话菜单 + 中主区 + 右面板侧栏(用户 2026-10-07 裁定)

```
┌──────────┬──────────────────────────┬────┬────────────┐
│ Sessions │  Main                    │ P  │  Panel     │
│          │                          │ a  │            │
│ 工作区    │  Chat(会话中,常驻)        │ n  │ Diff       │
│ ▾ 会话列表│                          │ e  │ Files      │
│          │  消息流(满高滚动)          │ l  │ Tasks      │
│ + 新会话  │                          │ s  │ Agents     │
│          │  ┌────────────────────┐  │    │ (单选)     │
│ (底部:   │  │ 输入区(贴底)        │  │ 图 │            │
│  连接态)  │  └────────────────────┘  │ 标 │            │
└──────────┴──────────────────────────┴────┴────────────┘
```

- **左会话菜单**(240px):顶栏工作区名(当前 root,点击可切换/回工作区列表);会话列表(id/相对时间/状态点,当前高亮);底部「+ New session」(→DirPicker 模态)与连接状态点。**原 Home 全页退役**——其工作区/会话列表职能内化为左栏;无会话时主区显示欢迎空态(引导新建/选择)。
- **中主区**:Chat 满高(消息流+输入区贴底);Chat 的既有 Chat|Board|Files 顶部 tab **退役**(面板移入右侧栏)。
- **右面板侧栏**:外缘 44px **图标纵条**(FileText/GitCompare/Kanban/Bot,当前高亮右侧 2px 指示条,**再点当前图标=收起/展开面板**)+ 内侧 300px 面板内容(标题行+上下文操作)。
- 会话中才可用四面板(无会话时图标禁用+tooltip);Tasks/Agents 会话维数据,Diff/Files 会话维路由。
- 快捷键 Ctrl/Cmd+1..4 切面板;Esc 收起面板(既有 Esc 语义处除外)。

## 2. 四个面板

| 面板 | 内容 | 数据源 |
|---|---|---|
| **Files** | 现 Files 页迁入(路径输入+高亮预览+truncated 横幅) | readFile 既有 |
| **Diff** | write 条目点击 → 该 callId 的 diff(old/new 双列);面板显示当前 diff(标题=path);**多 diff 栈**(最近打开在上,点击切换)——v1 简化为「最近一次」,栈深 1 | fetchDiff 既有 |
| **Tasks** | Board 的 List 视图迁入(紧凑行+gate 行内审批);**DAG 视图保留**(面板内切换 List/DAG 图标钮) | 板投影既有 |
| **Agents**(新) | 子 agent 活动卡:每 delegation 一卡(name/status/tokens/当前工具调用);**live 流**——消费 `payload.subagent` 标签事件(既有事件面,TUI ChildPanel 同源);卡片点击展开 mini 转录(最近 20 行文本) | 事件流新增收集器(gui 侧 `agent-activity.ts` 纯 reducer:按 label 聚合 token/tool-call/tool-result) |

**配套修复(顺带)**:chat reducer 目前把 `payload.subagent` 事件混入主聊天流(潜在串染)——本批在 `applyChatEvent` 入口过滤 `payload.subagent` 在场的事件(交 Agents 面板消费),Chat 面只留 delegation 摘要行(既有)。

## 3. 设计系统(设计令牌 + 单 CSS)

- `gui/src/app.css`(单文件,CSS 自定义属性令牌,main.tsx import):
  - 色板(**暗色优先**,Codex 口径):`--bg-0`(app 背景 #0d1117 系)/`--bg-1`(面板 #161b22)/`--bg-2`(浮层)/`--fg-0/1`(主/次文本)/`--border`(#30363d)/`--accent`(#4493f8)/`--ok`/`--warn`/`--err`;亮色后置(令牌就位,换值即可)。
  - 排版:系统栈 `ui-sans-serif`;13px 基准/12px 辅助;代码 `ui-monospace` 12px。
  - 形状:6px 圆角(卡/输入);1px 边框常态;hover 背景 `--bg-2`;focus-visible 2px accent 外环(a11y)。
- 组件级样式类前缀 `sx-`(如 `sx-rail`/`sx-panel`/`sx-card`);**既有测试钩子 class 原名保留**(测试零迁移优先;新增结构用 sx- 前缀)。

## 4. 图标:lucide-react

- gui 唯一新依赖 `lucide-react`(现代线性图标,Codex/Linear/shadcn 同审美;tree-shake 按需 import)。
- 映射:Files=FileText,Diff=GitCompare,Tasks=KanbanSquare(或 ListTodo),Agents=Bot;交互:Send(发送)/Square(停止)/ArrowLeft(返回)/X(关闭)/RefreshCw(刷新)/ChevronRight(折叠);状态:Circle(Point 指示连接态)。
- 尺寸 16px(活动栏 20px);strokeWidth 1.75;颜色继承 currentColor。

## 5. 交互人性化清单

1. 面板图标再点收起;左右栏宽 v1 固定(左 240/右 300,拖拽调宽后置);左栏可收起(顶栏 hamburger 或 Ctrl+)。
2. Chat 顶栏:返回/会话 id/状态(既有顶栏简化——工作区导航已在左栏,面包屑退役)。
3. 空态:每面板图标+一句引导(Files「输入路径预览文件」/Agents「暂无子 agent 活动」)。
4. 输入区:Enter 提交(既有)+ textarea 自增高(1-6 行,Shift+Enter 换行——**注意**:G3 以来 Enter=提交,本批增 Shift+Enter 换行,输入框从 input 迁 textarea)。
5. hover 一致性:可点元素恒 hover 态;按钮 disabled 恒 50% 透明+禁 pointer。
6. 流式光标:streaming 条末尾 1.5px 闪烁竖线(CSS animation)。
7. 状态条(贴输入区上方):连接点(四态色)+status+tokens/steps(既有数据,重排为图标+数字组)。
8. gate 审批/任务行的 ⚠ 改 Badge 组件(小圆标,恒可读)。
9. Home 工作区/会话行:卡片化(hover 浮起)+ 相对时间(「3m ago」)。
10. 快捷键:Ctrl/Cmd+1..4 切面板(v1);Esc 关面板(已有 Esc 语义处除外)。

## 6. 测试策略

- **既有测试零迁移优先**:测试钩子 class 原名保留;结构迁移(Files/Board 入面板)不可避免的选择器变更最小化(容器级 data-testid 加固)。
- 新增:agent-activity reducer 纯测(聚合/过滤/最近 N 行);布局壳测试(活动栏四钮/切换/收起/禁用态);App 集成(subagent 事件不再入 Chat 流)。
- e2e:既有 11 例照跑(选择器兼容)+ 新增 Agents 面板 live 卡断言。
- **无视觉回归测试**(无截图基建,YAGNI)——评审以结构+交互断言为门。

## 7. 批次切分(G8,一阶段一 plan)

| 批次 | 范围 |
|---|---|
| G8a | 设计系统(app.css 令牌)+lucide+活动栏/侧面板/主区布局壳+Chat/Board/Files 迁移+chat subagent 过滤修复 |
| G8b | Agents 面板(agent-activity reducer+卡+mini 转录)+Diff 面板化(write 条目接线)+交互清单落地+e2e |
| G8c | 全量门禁+两 spec/ROADMAP 回写(壳批次注记维持) |

## 8. 决策记录

| # | 决策 | 放弃的替代 | 依据 |
|---|---|---|---|
| U-D1 | 左会话菜单+中主区+右图标条面板(用户 2026-10-07 裁定修正) | 左活动栏(初案)/顶部 tab | 用户明确三栏布局;Home 全页退役内化为左栏 |
| U-D2 | 单 CSS 文件+设计令牌 | Tailwind/CSS Modules/inline | 零构建侵入(gui 既有 vite 最简);令牌换值即亮色;~400 行可控 |
| U-D3 | lucide-react | 手写 SVG sprite/图标字体 | 现代审美标配,tree-shake,一依赖;手绘 20+ 图标质量不可控 |
| U-D4 | 暗色优先 | 亮色优先/双主题 | Codex 对标口径;令牌架构双主题就位 |
| U-D5 | Agents 面板消费 payload.subagent 事件 | 复用 delegation 摘要(TUI 不足:无转录) | TUI ChildPanel 同源数据既有;gui 零协议新增 |
| U-D6 | 既有测试钩子 class 保留 | 全量 testid 重命名 | 测试零迁移优先;新结构 sx- 前缀隔离 |
| U-D7 | Enter=提交/Shift+Enter=换行,textarea | 维持单行 input | 人性化输入;对齐主流 chat UX |
| U-D8 | Diff 面板栈深 1(最近一次) | 多 diff 栈 | YAGNI;write 条目点击恒可重开 |
