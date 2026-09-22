# /skill 命令与选择卡 filterable 筛选能力设计

- 日期：2026-09-22
- 状态：设计定稿（用户已批准设计呈现；三项交互裁决与注入通道经问卷/呈现收束）
- 关联：`specs/2026-09-21-cli-tui-interaction-redesign.md`（扁平命令与选择卡先例）、`specs/2026-09-20-askquestion-selector-design.md`（OptionSelector 与 ask_question）、CLAUDE.md §6（技能装载）、§11（前缀缓存第一要义）、§15（外观双语/写链恒英文）

## 1. 背景与目标

技能目前只有模型自主加载单通道：清单（name+description）注入会话冻结段，模型按需经 skill 工具加载正文。用户侧缺显式入口——TUI 无命令可浏览可用技能，也无法确保某技能一定进上下文（自然语言「使用 XX 技能」依赖模型是否调用 skill 工具）。

本特性线交付两件事：

1. `/skill` 斜杠命令：列出可用技能，用户选择即加载正文进上下文。
2. 选择卡 filterable 能力：OptionSelector 增可选筛选（按 label+description 子串过滤），做成组件可选变量，选项少的卡不启用。

/skill 技能卡是 filterable 的首个消费点；/resume、/memory-rm 两个既有清单卡同批接线。

## 2. 关键裁决

| # | 裁决 | 内容 |
|---|------|------|
| D1 | 命令形态 | /skill 为第 19 条扁平命令，只认裸形式（沿扁平化裁决）；`SLASH_COMMANDS` 与 slashHelp 同步 |
| D2 | 注入通道 | 会话链尾追：resolve 后正文以 `action='skill'` 条目 appendChain，头行 `[Skill] <name> (id=<id> v=<version>)`（对齐 loop/engine.ts:120 既有格式），空行后接正文。与模型 skill 工具观察同语义的持久通道，后续每帧经链自然携带 |
| D3 | 去重 | 加载前扫描 `chainView()`：同 id 已在存续链（action='skill' 且头行含 `(id=<id>)`）→ 回执已加载、不重复注入；被压缩折叠出可见链后可重新加载 |
| D4 | 守卫 | 运行中拒绝（沿 /resume）；空清单回执不弹卡（沿 /memory-rm）；resolve 失败（SKILL_NOT_FOUND / SKILL_PARAM_MISSING）warn 回执，不部分加载 |
| D5 | 卡片形态 | 单选卡（选定即加载）；选项 label=技能 name、description=frontmatter 描述截 128（沿 formatSkillsIndex 口径）、按名排序 |
| D6 | filterable 变量 | `AskUserRequest` 增可选 `filterable?: boolean`；OptionSelector 增受控 `filter` 显示行 + 导出纯函数 `filterOptions(options, query) → { view, map }`（label+description 大小写不敏感子串匹配；map=视图下标→原下标）；启用判据=调用方 items.length > 8（与分页 pageSize 同源）；审批/plan/ask 等固定小卡零触碰 |
| D7 | 键位 | filterable 卡：可打印字符（字母/数字/符号）进筛选词，数字快选让位；Backspace 删字；Esc 两段式（词非空先清词、为空才取消）；词变化 cursor 归 0；↑/↓/Space 作用于过滤视图；单选 Enter 提交高亮项、多选 Enter 仍提交全部勾选累积集（/memory-rm 跨页累积语义保持），提交经 map 取原选项 label；picked 存原下标、跨筛选词稳定。筛选词为单段连续字符——Space 保留选定/勾选语义、不进筛选词 |
| D8 | 分页组合 | 筛选词为空走既有 `paginateOptions`（More…/Back… 照旧）；非空时全量过滤直出、隐藏导航项，清词回分页态 |
| D9 | 前缀与语言 | 技能正文只尾追（D2），筛选词纯 TUI 瞬态不进 session/journal，/skill 属用户面命令不进模型工具清单（零前缀断点）；链行头恒英文（§15 写链面），上屏回执与卡文案走 t() 双语 |

**勘误登记（呈现→规格间经代码核实修正）**：设计呈现时 D2 表述为「正文经 pendingSkill 单点置尾注入」。核实 `ContextManager.pendingSkill` 为消费即清的一次性首帧槽（loop skillRef 专用，reactor 经 takePendingSkill 单帧消费），一次性注入无法支撑「技能指导整个后续任务」语义；模型 skill 工具的实际通道是工具观察→会话链（持久）。故 D2 落定为链尾追（与模型加载同语义的持久通道），前缀面结论不变（尾追零击穿）。

## 3. 组件与数据流

三个单元，各自可独立测试：

### 3.1 session.skillFlow（src/tui/session.ts）

handleSlash 增 '/skill' 分支 → skillFlow()：

1. 守卫：status !== 'idle' → warn 回执 return；`runtime.harness.skills.list()` 为空 → 回执 return。
2. 组卡：选项按 D5 映射排序；items.length > 8 时请求带 filterable。
3. askUser 单选；dismissed → 静默 return（沿既有卡语义）。
4. 去重扫描（D3）→ 已加载回执 return。
5. `skills.resolve(id)`（不传 params）；!ok → warn 回执（错误码+消息）return。
6. `appendChain([{ action: 'skill', observation: 头行 + '\n\n' + body }])`。
7. 回执：已加载 \<name\>，随后续任务轮进上下文（t() 双语）。

会话日志：appendChain 经 onContextChange 自动落 journal 'chain' 事件，/resume 重放后 D3 去重依然成立；/rewind 回退锚点在加载前则该条目随链回退、可再次加载（语义自洽）。

### 3.2 filterOptions 与 OptionSelector（src/tui/components/OptionSelector.tsx）

- 导出纯函数 `filterOptions(options, query)`：query 空 → `{ view: options, map: [0..n) }`；非空 → 小写化 label+description 包含匹配，返回视图与原下标映射；无命中返回空视图（map 空）。
- `OptionSelectorProps` 增可选 `filter?: string` 与 `indexMap?: number[]`：filter !== undefined 时题头下渲染筛选行（`/ <query>▊` 形态）；indexMap 提供时勾选标记按原下标换算显示；筛选态隐藏数字编号前缀（数字已进筛选词、快选停用，编号无指向意义）。
- 组件保持纯受控渲染：筛选词状态由调用方（App）持有，与 cursor/picked 同形态，组件不挂 useInput。

### 3.3 App 分发与 AskUserRequest（src/tui/components/App.tsx、src/types.ts）

- types.ts：`AskUserRequest` 增 `filterable?: boolean`。
- awaiting-question 分支：q.filterable 时先行拦截可打印字符（含数字）→ 追加 qFilter；Backspace 删尾；Esc 两段式；词变化 qCursor 归 0；新问询卡到达时 qFilter 置空。视图经 filterOptions 计算，↑/↓ 以 view.length 为界；Space 沿多选勾选/单选选定语义、经 map 落原下标；单选 Enter 提交高亮项、多选 Enter 提交勾选累积集，提交经 map 取原 label。
- customIndex（Other… 自由输入）与 filterable 无组合消费点（三张清单卡均未启用 customIndex）；两者同现时按原下标换算兜底，不新增交互。
- CLI/TTY 面口径：askUser 的 stdin 编号回落忽略 filterable（无筛选、编号选择照旧）——筛选是 TUI 键盘分发层能力，接口字段对其他面为可选降级提示；headless 桩不受影响。
- 非 filterable 卡路径逐字节不动（既有审批/plan/ask 快捷键零影响，钉子用例锁定）。

### 3.4 三个消费点接线（src/tui/session.ts）

- /skill：新卡（3.1）。
- /resume：选项 >8 传 filterable；筛选词非空时跳过分页全量直出（D8），resumeFlow 翻页循环改「无词分页 / 有词直出」双态。
- /memory-rm：同上；无词态 Space 勾选累积与 More/Back 翻页照旧，有词态勾选仍累积（picked 存原下标）。

## 4. 错误处理

| 场景 | 行为 |
|------|------|
| 运行中 /skill | warn 回执「当前有任务进行中」，不弹卡 |
| 技能清单为空 | warn 回执「暂无可用技能」（提示放置 SKILL.md 或经学习沉淀），不弹卡 |
| resolve SKILL_NOT_FOUND | warn 回执（选项即来自 list()，理论不可达，防御性保留） |
| resolve SKILL_PARAM_MISSING | warn 回执列缺失参数名，提示该技能含模板参数、可让模型经 skill 工具传参加载 |
| 重复加载 | info 回执「已加载」，零副作用 |
| dismissed | 静默 return，无回执（沿 /memory-rm 取消语义） |

## 5. 测试（TDD 红灯先行）

1. filterOptions 纯函数：空词恒等、label 命中、description 命中、大小写不敏感、无命中返回空视图、map 正确性。
2. OptionSelector：filter 行渲染、indexMap 下勾选标记与编号换算、无 filter 时渲染逐字节不变。
3. App 分发：filterable 卡数字进词非快选、Backspace/Esc 两段式、词变 cursor 归 0、Enter 提交映射原 label；非 filterable 卡数字快选照旧（回归钉）。
4. session /skill：空清单回执、运行中拒绝、选择后链上出现 action='skill' 条目且头行含 (id=…)、去重回执零副作用、resolve 失败回执、dismissed 静默。
5. 分页组合：/memory-rm >8 无词翻页照旧、有词直出无导航项、清词回分页、跨词勾选不漂移。
6. 前缀回归：链尾追后相邻帧首个差异点落尾部（既有前缀套件扩展一条）。

## 6. 文档同步

- MANUAL.md：命令总表 18→19 条（/skill 行）、选择卡交互段补筛选说明（输入即筛、Esc 两段式、数字进词）。
- slashHelp()：/skill 行。
- App.tsx SLASH_COMMANDS：'/skill'（Tab 补全自动生效）。

## 7. 验收矩阵

| # | 断言 |
|---|------|
| A1 | /skill 裸形式弹单选卡，选择后链上出现 [Skill] 条目，回执确认 |
| A2 | 技能正文此后每帧经链携带（多步任务后续轮仍可见） |
| A3 | 重复选择同技能回执已加载，链上仅一条 |
| A4 | /rewind 回退到加载前锚点后可重新加载（链回退语义） |
| A5 | 三清单卡 >8 项出现筛选行，输入即过滤 label+description |
| A6 | 固定小卡（审批/plan/ask）键位与渲染零变化 |
| A7 | 筛选态数字进词、Esc 先清词再退卡 |
| A8 | 工具清单零新增、链头行恒英文、上屏回执 t() 双语 |

## 8. YAGNI 登记

- 多选一次加载多个技能：单选逐个加载（用户裁决，对标 CC 逐命令触发）。
- /skill \<id\> 带参直载：只认裸形式（沿扁平化裁决）。
- 技能参数（params）UI 表单：含必填模板参数的技能回执引导走模型 skill 工具。
- 模糊匹配/fuzzy 库：子串包含够用，零新依赖（§5 依赖原则）。
- /model 等固定小卡筛选：8 项以内不启用。
