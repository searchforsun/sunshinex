# GUI 产品面重构(Codex 面 → sunshinex 底层,G10)· 设计 spec

日期:2026-10-08。前置:`2026-10-08-codex-desktop-1to1-design.md`(G9 视觉令牌复刻,已交付)。
本 spec 处理 G9 之后的**产品面层**:布局、信息架构、能力承载——方法论为「**从 Codex 产品面上层切入,映射到 sunshinex 底层实现;sunshinex 独有能力以 Codex 视觉语言拓展**」。每个 Codex 面元素必须落到真实底层;无底层能力的 UI 一律不做(延续 G9 §0 复刻纪律)。

用户已裁定:①composer 模型/权限 pill **运行中真切换**(扩 daemon);②**计划模式映射 `/plan` 流程**(先规划→确认→逐项执行;纠正初版「只读围栏」方案,弃用);③设置页**全功能重排、行式控件化**;④TUI 已有能力**一项不漏**全部承载(审计见 §8 映射表)。

## 0. 目标与非目标

**目标**:GUI 五区(侧栏/主对话区/输入区/设置页/右栏)按 Codex 产品面重构;TUI 25 个斜杠命令 + 非命令能力(steer 队列、ask、审批、子代理、任务板等)全量在 GUI 有 Codex 形态的承载;全局简洁化(去冗余图标/阴影/文字,hover 提示制,快捷键 hover 可见)。

**非目标**:不做 Scheduled/Plugins/Explore 等无底层导航项;不做文件上传(+ 钮);`/terminal-setup` 为 TUI 专属不承载;不译会话内容(双语仅 GUI chrome);不改 TUI 本身。

## 1. 侧栏(IA 对齐 Codex 扁平双区)

```text
 Sunshinex                    ← 品牌行(纯文本;无模式切换/搜索——无底层不做)
 ⎙ 新对话                     ← nav 行:最近激活工作区建会话(无激活则弹项目选择菜单)
 Projects                     ← 分区头(小标题)
   <工作区行>          N +    ← 名称+计数 pill;hover 显 +;点击展开/折叠组内会话
 Recents                      ← 分区头:扁平最近会话(跨项目,时间降序,上限 20)
   <会话行> 标题   2h ago     ← hover 显 Attach;运行中行尾旋转环;点击 attach 打开
 ⚙ Settings                   ← 底部行
```

- 展开的项目组内会话行保留(现有),Recents 是**新增的扁平视图**:`GET /sessions?root=` 聚合各工作区最近会话(gui 侧拉多份归并排序,或 daemon 端 `/sessions/recent` 聚合端点——实施取 daemon 端单点,避免 gui N 次请求)。
- 原生组件纪律:行=原生 `button`;tooltip=原生 `title`;滚动条原生+细样式;侧栏宽 275 固定(去 240 硬编码),不做拖拽。
- Attach/分叉等 hover 钮沿用现有浮现制;新增「分叉」钮(见 §8 /fork)。

## 2. 主对话区

- **思考链**:GUI 目前忽略 `reasoning` 事件。chat-reducer 收 `reasoning` 增量 → 聚合为折叠行「思考 3s ˅」(正在流入时示「思考中…」),点开看全文;done 收段同 assistant 语义。行形态对齐 Codex「Thought for 1s」:裸行 tertiary,无框。
- **工具行**:去 `●/⎿` 文本记号,渲染面改 12px lucide 图标 + 动词短语(read/write/exec/grep…,图标按工具名映射,未知工具用通用件);md 形态不变(渲染侧拆解,归档/种子条兼容)。展开区代码井保留(G9 已做)。
- **正文 GitHub 标准 md + mermaid**:排版对 GitHub 惯例(标题/列表/表格/引用/行内码,G9 已大体就位,校差即可);新依赖 `mermaid`(登记 §5 依赖台账 + §13 组件选型表):代码块 `language-mermaid` 懒加载渲染 SVG,主题随 `data-theme`,渲染失败回落原文代码块。
- **双语**:GUI chrome 文案走 `t(en,zh)`(src/i18n.ts 复用,GUI 侧引入同一模块);语言源 = daemon settings `language` 键(连接后拉取,SettingsForm 改动即热生效)。范围:按钮/空态/提示/菜单/tooltip。
- **顶栏精简**:左=会话标题;运行中标题旁 spinner;右=仅「⋯」菜单(内含 Delete,hover title 显快捷键)。tokens/steps/耗时 → 标题 hover 原生 title tooltip。去 Coins/Footprints 图标组与常显状态文字;`← 返回` 改纯图标 ghost(hover title「返回 (Alt+Shift+S)」口径按实际快捷键)。

## 3. 下部输入区(composer)

```text
 [textarea 浮卡 ……                                ]
 [⌘ 命令面板由「/」唤起]        [⌁ 模型 ˅] [🛡 权限 ˅] [↑]
```

- **「/」命令面板**:输入 `/` 弹出 Codex 式面板——命令+双语描述、前缀/模糊过滤、↑↓ 导航、Tab 补全、Enter 执行。清单与描述**复用 TUI 单点** `SLASH_COMMANDS`/`slashCommandDescriptions()`——经 daemon 新端点 `GET /commands` 下发(本地化文案服务端求值,防 gui/tui 双清单漂移);GUI 不内嵌命令表。
- **权限 pill**(footer 左):三态「完全访问 dontAsk / 变更确认 manual / 计划模式 plan」。dontAsk/manual 直改会话模式;**plan 态=下一次提交进入 planFlow**(提交后弹出计划确认卡,复用既有 ask 通道;计划批准即逐项执行,GUI 显示执行中)。切换调新端点,轻 toast「已切换,下一轮生效」口径按端点实际语义。
- **模型 pill**(footer 右):列 settings `providers` 清单(daemon 下发);二级菜单含**档位(tier)**与**思考强度(effort)**。切换调新端点。
- **发送钮**:28px 圆形实心(G9 已做)。
- **steer 队列显示**:运行中提交=插话(已有);新增 composer 上方「排队中」chips(文本+撤回钮),数据源 snapshot 增 queued 段(撤回=新端点 `POST /session/:id/steer/cancel {seq}`,daemon steer 队列已序号化则直接用,否则补)。

## 4. 设置页(Codex 同构)

- 左 nav 分组:Personal(通用、模型与提供方)/ Coding(上下文与限额、记忆、知识库与搜索)/ Integrations(MCP、技能、智能体)/ Permissions / 高级。**十面板全保留**,只重排。
- 主区**居中 720px 窄列**;行式 = 左(标题+双语描述)+ 右控件;**枚举键全部下拉**(language、autoMemory/learnedSkills、kbBackend、sandbox、isolation、readFence 等有闭集语义的键),自由文本/路径/数字右对齐定宽输入;行间 hairline;**静态面板卡去阴影**(阴影只留浮层,见 §5)。
- SettingsForm 引擎增行渲染器:键描述双语表(高频键逐条写,`t()` 口径);SourceBadge 保留(env 覆盖态)。
- 复杂面板(Providers/MCP/Agents/技能/权限/raw)同宽列重排,卡列表去阴影改 hairline 分隔。

## 5. 全局去冗余

- **阴影收敛**:`--elev-card/--elev-prominent/--elev-composer` 仅用于浮层(composer、菜单/弹层、审批/ask 卡、模态、toast);静态面板(设置行组、provider/MCP/agent 卡、task 行、board-dag、团队栏)**全部去 box-shadow**,层次靠 hairline(`--border`)与明度差。
- **图标收敛**:功能即图标,装饰即删除。删除 Coins/Footprints/组头文件夹等无交互图标;保留 chevron/齿轮/发送/停止/复制/分叉等功能件。
- **文字收敛**:常显提示文字删除或收进空态;hover 用原生 `title`;快捷键在 title 内展示(如「停止 Esc」)。chat-empty、token-gate、welcome 的提示精简为一行。
- 焦点环/滚动条/选区沿用 G9 令牌。

## 6. 底层新增(src/serve + harness/model 接缝)

| 端点/能力 | 语义 | 底层接缝 |
|---|---|---|
| `GET /commands` | SLASH_COMMANDS + 本地化描述单点下发 | 复用 `tui/slash-commands.ts`(重导出面),daemon 调 `t()` 求值 |
| `POST /session/:id/command {line}` | 文本产出型命令直跑,输出经既有事件流(notice/system) | daemon session 增命令适配层,操作共享 runtime;支持集见 §8 标记 |
| `POST /session/:id/model {model}` | 运行中换芯,下一轮生效 | `ModelSwitcher`(model/catalog.ts)+ providers 清单校验 |
| `POST /session/:id/tier {tier}` / `…/effort {effort}` | 档位/思考强度 | model/router.ts 与 adapter effort 接缝(运行时可变位) |
| `POST /session/:id/mode {mode}` | dontAsk/manual/plan 态标记 | session opts.mode 可变;plan 为提交通道标记非权限态 |
| `POST /session/:id/rewind {seq}` | 回退到指定轮(用户气泡「编辑/回到此轮」) | journal/链截断对齐 TUI /rewind 语义 |
| `POST /session/:id/fork` | 从当前链分叉新会话 | 对齐 TUI /fork |
| `POST /session/:id/steer/cancel {seq}` | 撤回排队插话 | daemon steer 队列 |
| `POST /memory/rm {ids}` | 记忆删除(记忆面板多选) | memory store |
| snapshot 增段 | `mode/model/tier/effort/queued/tasks/memoryOverview` | pill 回显与面板数据源 |

- `command` 通道支持集(首版):`/init /status /compact /context /tasks /kb-index /memory /memory-add /memory-gc /memory-on /memory-off /add-dir /goal /plan /skill`;排除(TUI 交互卡/专属):`/memory-rm /resume /rewind /fork /terminal-setup /help /new`(GUI 原生面或已有)。
- 命令适配层实现纪律:**操作共享 runtime 单点**(与 TUI 同源),禁止复制 TUI 会话逻辑;纯函数(formatContextBreakdown 等)直接 import 复用。

## 7. TUI 能力映射总表(审计结论,25/25)

| 命令 | GUI 承载 | 底层 |
|---|---|---|
| /model | composer 模型 pill(运行中切换) | 新端点 …/model |
| /model-tier / /model-effort | 模型 pill 二级菜单 | 新端点 …/tier …/effort |
| /plan <目标> | 权限 pill「计划模式」:提交走 planFlow,确认卡复用 ask 通道 | command 通道 |
| /goal <目标> | 「/」面板 | command 通道 |
| /compact | 「/」面板,完成 notice 行 | command 通道 |
| /context | 右栏「上下文」标签(分段占比) | command 通道产出结构化 |
| /tasks | 右栏「后台任务」标签 | snapshot tasks 段 |
| /memory /memory-add /memory-gc /memory-on /memory-off | 右栏「记忆」标签(列表+开关+整理) | command 通道 + snapshot memoryOverview |
| /memory-rm | 记忆面板多选删除(GUI 原生) | 新端点 /memory/rm |
| /skill | 「/」面板列技能载入 | command 通道 |
| /init /status /add-dir /kb-index | 「/」面板直跑,输出进会话流 | command 通道 |
| /new | 侧栏「新对话」 | 已有 |
| /resume | 侧栏 Recents/Attach | 已有 |
| /rewind | 用户气泡 hover「回到此轮」(Codex Edit 钮底层) | 新端点 …/rewind |
| /fork | 会话行 hover「分叉」 | 新端点 …/fork |
| /terminal-setup | N/A(TUI 专属) | — |
| /help | 「/」面板自带双语描述 | GET /commands |

非命令能力:steer 插话队列(显示+撤回,**新增**)、ask_question(AskCard ✓)、审批卡(✓)、子代理面板(Agents 标签 ✓)、任务板(Board 标签 ✓)、流式光标/自增高(✓)、chrome 双语(**新增**接线)、快捷键 hover 提示(**新增**)。结论:25 命令全部承载或显式 N/A;无遗漏项。

## 8. 分批

- **C1 底层**:`GET /commands`、`command` 通道(支持集)、`model/tier/effort/mode` 端点、snapshot 增段、steer cancel、rewind/fork、memory/rm;harness/model 运行时可变接缝。全套单测(端点契约+运行时切换语义)。
- **C2 侧栏 IA**:品牌行/新对话/Projects/Recents 双区/Settings 行;Recents 聚合端点消费。
- **C3 主对话区**:思考链折叠、工具行图标化、mermaid(依赖引入流程:登记台账+build/test 验证)、双语接线、顶栏精简。
- **C4 composer**:「/」命令面板、权限/模型/tier/effort pills、排队 chips、rewind(用户气泡编辑钮)/fork。
- **C5 设置页**:行渲染器+分组 nav+居中列+枚举下拉化;各复杂面板重排。
- **C6 全局去冗余**:阴影/图标/文字收敛、hover tooltip 体系、右栏上下文与后台任务/记忆面板;视觉对拍终验。

每批:gui 测试全绿 + 新增单测 + 浏览器对拍;C1 附 daemon 端点单测与 selfcheck 端点行。

## 9. 测试与验收

- 单测:command 通道支持集与排除集、model/tier/effort 切换语义(下一轮生效)、rewind 截断、steer cancel、snapshot 新段;gui 命令面板过滤/键盘导航、思考链聚合、双语切语言、行渲染器枚举下拉化。
- 回归:既有全量(根 + gui)绿;`GET /commands` 与 `SLASH_COMMANDS` 单点同源断言(防漂移钉子)。
- 验收:hermetic daemon(种子含 reasoning/queued/tasks 数据)浏览器对拍五区;visual-judge 评审;对照本 spec §1–§5 逐条闭合。

## 10. 风险与降级

- **mermaid 体积**:懒加载(chunk 分离);加载失败/超时回落原文代码块,不阻塞会话流。
- **命令适配层漂移**:唯一防漂移钉子 = `GET /commands` 与 TUI 单点同源的断言用例;支持集外的命令 gui 面板置灰不可选。
- **运行时切换面**:harness/model 若缺运行时可变位,按「下一轮生效」语义落在 reactor 每轮装配读取点——禁提示词层兼容(§5 核心契约纪律)。
- 计划模式确认卡与 ask 卡共用通道:pid 寻址与生命周期完全复用,不另起挂起表。
