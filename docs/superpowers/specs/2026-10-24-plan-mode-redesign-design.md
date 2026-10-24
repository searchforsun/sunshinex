# 权限档重构与 plan 模式重造设计(read-only / acceptEdits / full-access · planFlow)

- 日期:2026-10-24
- 状态:已批准(会话内分段评审;方案 A 与分节设计经用户确认后落档)
- 轮次:权限面与计划流程首轮(brainstorming 产出;承接 G10-C1b 模式面「plan 提交通道标记」的历史欠账与 /plan 首版语义空缺)
- 裁定记录:用户裁定——①一份 spec 三阶段(权限档改名+read-only 新增 / planFlow 共享模块+TUI 重造 / serve+GUI 接通),依赖递进,每阶段独立可交付;②计划书批准交互=批准+反馈驳回环(非 yes/no 二选一);③批准后执行档固定落 acceptEdits(不落回原档、批准卡不设选档);④TUI+GUI 一起纳入(GUI「计划模式」入口现状是 plan→dontAsk 假映射,必须随本 spec 收口);⑤方案 A 入口驱动共享 planFlow(方案 B exit_plan 模型工具留作演进);⑥命名定稿四项:计划模式/plan、只读模式/read-only、工作区编辑/acceptEdits、完全访问/full-access。

---

## 1. 背景与问题

现状三档 `manual | plan | dontAsk`(`src/harness/security/modes.ts`),五处问题:

1. **manual 名不副实**:信任域内 Write/Edit 静默直放(guard 写分支 path 形态直放 + 链写分支信任域放行),域外才 ask——实际语义就是「工作区编辑+域外确认」,名字却暗示逐项审批;
2. **dontAsk 与 CC 同名不同义**:Claude Code 的 `dontAsk` =「该问的不问、直接拒绝」(headless 安全);本项目的 `dontAsk` =「未 deny 一律自动放行」——实为 CC `bypassPermissions` 语义。同名反义是命名债里最危险的一处;
3. **GUI plan 假映射**:`src/serve/session.ts` 装配把 `plan` 映射成 `dontAsk`,计划流程根本不存在(planFlow 未共享化、serve COMMAND_SUPPORT 无 /plan)——GUI 选「计划模式」拿到的是全自动,最受限的名字配最放开的实际行为;
4. **/plan 规划轮无调研**:单发内部任务,提示词「output only step lines, no explanations」主动劝退调研,实践中即上下文列步骤;且规划轮不挂只读闸门(按会话当前档跑):manual 下可静默改工作区内文件,dontAsk 下任意写——口头在 plan、手上能写;
5. **计划书被丢弃**:规划产物只留编号行(`pendingPlan = { items }`),正文弃置;批准后逐项执行每步只带一行指令,不带计划上下文。

业界对照(Claude Code 六档 `default/acceptEdits/plan/auto/dontAsk/bypassPermissions`,plan=只读面+ExitPlanMode 批准后同会话注入;Codex 两轴,沙箱 `read-only/workspace-write/danger-full-access` + 审批策略):权限档按「允许碰什么」命名;计划是**流程**(只读权限面+批准闸门+同会话注入),不是权限档。CC 早期「批准后清历史、计划当新会话开头」的做法已放弃,现行=同会话注入——本 spec 从之。

 enforcement 收口点维持现状:全量工具清单恒下发(reactor 每轮 registry.list()),模式只改变 guard/chain 判决,不做按档裁剪工具箱;read-only=硬拒+拒绝消息带出路,不走确认(确认语义属 acceptEdits 档域外分支)。

## 2. 目标与非目标

**目标**

- 三权限档语义对齐业界:`read-only | acceptEdits | full-access`,全链改名+旧档别名回放;`plan` 从权限枚举除名,退为流程标记;
- 共享 planFlow 模块:规划轮 guard 临时覆盖 read-only 只读调研 → 产出计划书(reply 正文,markdown)+ 调 `todo_write` 结构化步骤 → 确认卡 → 批准+反馈驳回环(上限 3 轮)→ 批准后计划书注入链、档位落 acceptEdits、逐项执行;
- TUI/GUI 同一 planFlow:GUI「计划模式」单选真正可用(规划/批准/反馈/执行全流程),假映射删除;
- read-only 拒绝消息带出路提示;中英文命名全链单源。

**非目标**

- 不做 exit_plan 模型工具(方案 B 留作演进,见 §8);
- 不做计划书落盘(CC `.claude/plans` 式)——计划书只活在会话链与 journal 回放;
- 不做 dontAsk 主流语义档(「该问不问直接拒」,headless/batch 场景后续再说);
- 不做批准卡选执行档(固定落 acceptEdits,§4.4);
- 不动 reactor 终止预算与并行闸门(todo_write 单发独占 category:'todo' 语义照旧);
- 不做按档裁剪工具清单(§1 enforcement 收口点不变)。

## 3. 阶段一:权限档改名 + read-only 新增

### 3.1 类型与判定面

- `modes.ts`:`PermissionMode = 'read-only' | 'acceptEdits' | 'full-access'`;档语义注释同步(read-only=仅非变异操作;acceptEdits=信任域内写直放、域外与命令类 ask;full-access=未 deny 全放行,deny 规则与破坏性底线保留);`READONLY_WHITELIST`/`DESTRUCTIVE_COMMANDS`/`DESTRUCTIVE_PIPE` 不动。
- `guard.ts`:现 plan 只读闸门(Read/Grep/Glob + ask_question/todo_write/worktree list 放行)原样挂 `read-only`;拒绝消息追加出路提示:`COMMAND_DENIED: read-only mode allows read-only operations only (ask the user to switch permission modes to make changes)`。
- `chain.ts` 写分支 `mode === 'plan'` 判定同步改 `read-only`;`worktree.ts` 相关注释同步。

### 3.2 全链改名清单

| 位置 | 改动 |
|---|---|
| `src/cli/index.ts` | `--mode` 帮助文案+校验:接受新三值,旧值报 invalid 并附「manual→acceptEdits / dontAsk→full-access / plan 已退为流程」提示;缺省档 acceptEdits(沿现 manual 缺省地位,纯改名) |
| `src/tui/entry.ts` | modeFlag 判定改新值,缺省 acceptEdits |
| `src/serve/session.ts` | `SessionMode = 'read-only' | 'acceptEdits' | 'full-access' | 'plan'`——`plan` 保留为**流程标记**(阶段三启用,语义=plan-arm,见 §5.1);装配映射改 `plan→acceptEdits`(替换现 `plan→dontAsk` 假映射;armed 态内核闲置于 acceptEdits,无行为面);`isManual` 判定改名 `isAcceptEdits`(挂起表路由语义不变:仅 acceptEdits 档挂审批) |
| `src/serve/session-handlers.ts` | mode 端点校验改四值(三档+plan 流程标记);409 busy 语义不变 |
| `src/serve/daemon.ts` | 回放 setMode 白名单同步 |
| `src/serve/session-commands.ts` | (阶段三扩 /plan,本阶段不动) |
| `gui/src/connection-types.ts` `connection.ts` | mode 联合类型同步;`newSession` mode 参数 `'dontAsk'|'manual'` → `'full-access'|'acceptEdits'` |
| `gui/src/pages/DirPicker.tsx` | 新会话审批勾选语义=acceptEdits 会话,勾选框文案/提示同步 |
| `gui/src/pages/Chat.tsx` `ComposerPills.tsx` | ModeIcon 值域、sessMode 类型、菜单四项+分组线(§3.4) |

### 3.3 旧档别名回放

- meta 旁车 `mode` 字符串读入经**别名映射单点** `resolveModeAlias`:`manual→acceptEdits`、`dontAsk→full-access`、`plan→acceptEdits`(旧 GUI plan 档真身是 dontAsk,回放落全自动危险,统一落工作区编辑);写入面只写新值;TUI journal 的 mode 记录行同路径。
- 未知值:回落该端缺省档 + warn(沿现坏档容错语义)。
- 各端缺省档维持现状地位:TUI 缺省 acceptEdits(原 manual),serve/GUI 缺省 full-access(原 dontAsk)。

### 3.4 GUI 菜单(阶段一形态)

四项两段:计划模式置顶(**置灰**,tooltip「即将可用」,阶段三接通)+ 分组分隔线 + 只读模式/工作区编辑/完全访问。图标:plan=ListTodo(沿)、read-only=Eye(新)、acceptEdits=ShieldCheck(沿现 manual)、full-access=Unlock(沿现 dontAsk)。中英文案按 §6 命名表。

### 3.5 测试(阶段一)

- guard/chain/装配的档位矩阵改名全绿(现 plan 只读闸门测试面翻新为 read-only);
- 别名回放三例(manual/dontAsk/plan 各一)+未知值回落;
- mode 端点契约:新值 200、未知值 400、运行中 409;
- CLI `--mode` 校验(新值过、旧值报 invalid)。

## 4. 阶段二:planFlow 共享模块 + TUI 重造

### 4.1 模块与接缝

- 新 `src/harness/plan-flow.ts`(harness 层,TUI/serve 共同消费;依赖方向 graph→loop→harness 不破):纯流程编排,不含 IO 政策。输入接缝收敛为单一具名对象——`runPlanningTask(prompt, signal)`(fork 隔离由宿主实现,verbose 提示词与规划结论不入会话链,沿现 seedHistory 自 chainView 先例)、`todos` facade(读终态+写执行清单)、`modeOverride`(§4.2)、`chainAppend`、`emit`(状态机事件)。
- 状态机:`planning → awaiting-approval →(批准)executing → done |(拒绝+反馈)revising → planning |(任意段)aborted`;每事件宿主渲染(TUI 消息/pill,serve 事件行)。
- 档位临时覆盖:`SecurityGuard` 增 overrideMode 进入/退出(轻量字段,非重建 runtime;guard/chain 判 `mode` 处按覆盖值);planFlow 规划轮 enter `read-only` → 结束/中断/异常 try/finally restore。运行中模式切换本就 409/TUI 禁用,覆盖期无并发源;serve 的 setMode(重建 runtime)不参与规划轮。

### 4.2 规划轮

- 提示词(PLAN_TASK_LABEL 单点演进,防两处漂移的纪律保持):**调研先行**(用 Read/Grep/Glob 勘察相关代码,read-only 档保证零副作用)→ 产出**计划书**(固定骨架:背景与现状 / 方案 / 涉及文件 / 分步(编号) / 风险与回滚 / 验证方式)→ 调 `todo_write` 全量写入步骤(全 pending)。现「output only step lines」限制反转删除。
- 产物权威:**计划书 = reply 正文**(markdown,不再丢弃);**步骤 = todos facade 终态**(todo_write 已结构化,正文编号行解析降为兜底:todos 空或 `todo_not_configured` 时按现解析逻辑从正文提取)。
- fork 隔离保持:规划提示词与规划结论不入主链;驳回环重入时,前轮计划书+用户反馈入 fork 种子(仍不入主链——主链只见批准后的计划书)。

### 4.3 确认与驳回环

- `pendingPlan = { doc: string; items: TodoItem[] }`(items 全 pending)。
- 确认卡(TUI):计划书全文(markdown 渲染)+ 步骤列表 + 操作提示(批准 / 拒绝附反馈);`awaiting-plan` 状态复用,反馈输入沿现确认卡通道。
- 驳回环:拒绝+反馈 → 重入规划轮(fork 种子追加前轮计划书与反馈);上限 **3 轮**(含首轮),超限如实回执回 idle,已有计划书不自动执行。
- 中断:规划轮/等待批准/执行段 Esc/Ctrl+C 沿现中断路径(interrupted 回执、`planReplyNoArchive` 复位、回 idle 不粘滞)。

### 4.4 批准与执行

- 批准前常量漂移探测沿现路径(`checkConstantsDrift`,差异尾追链+回执,以最新为准)。
- 计划书注入链:`ChainAction` 扩员 **`'plan'`**(`types.ts` 词汇表登记;`messages.ts` 消费面按 `task` 同等透出——计划书全文一个 step,水位膨胀由既有压缩面承载);写入时机=批准后、执行前,一次。
- 档位落 acceptEdits:TUI pill 可见切换+状态回执;serve `setMode('acceptEdits')`(批准发生在 idle,重建 runtime 合法)。
- 执行:沿 `runPlanItems` 现语义(todo 勾选、每步指令行入链、**单项失败宁停**),差别仅步骤源=todo_write 权威 items(非正文解析行)。

### 4.5 测试(阶段二)

- planFlow 状态机单测(mock 全部接缝):主路径(规划→批准→执行)、拒绝反馈修订→批准、todos 空→正文兜底、`todo_not_configured`→正文兜底、反馈轮超限、规划/等待/执行各段中断;
- **判别力锚**:规划轮模型调 Write 即被 read-only 覆盖闸门拒绝(去掉 enter read-only 即红)——钉住「规划轮只读」不变量真身;
- TUI 集成(现 `session.plan.test.ts` 翻新):计划书入链断言(`'plan'` action 行存在且正文完整)、todo_write 权威断言(步骤来自 todos facade 而非正文解析)、批准后 `guard.mode === 'acceptEdits'` 断言、反馈环上限、pill 切换回执。

## 5. 阶段三:serve/GUI 接通

### 5.1 serve 命令通道(planFlow 共享化兑现)

- `COMMAND_SUPPORT` 扩 `/plan`;GUI「计划模式」单选语义=**plan-arm**(会话态:下一个任务先规划,一次性):`setMode('plan')` 置 arm(内核档闲置于 acceptEdits,§3.2 映射);arm 态下提交经 planFlow 走完整流程。arm 解除路径三条:批准落 acceptEdits 自动解除(pill 随之切换);用户手动切走计划模式解除;拒绝(含反馈环与超限)**保持 armed**——单选仍停在计划模式,下条提交再规划,与用户所选档位如实一致。
- planFlow 在 serve 侧的接缝实现:`runPlanningTask` 走 serve runtime 的 fork 通道;审批与反馈复用挂起表——新增 plan 审批挂起类型(`kind: 'plan-approval'`,payload=计划书+items;反馈=文本回执),路由沿 suspendApproval/suspendAsk 先例;GUI 已有审批挂起面板形态承接。
- `/plan <目标>` 命令同时开放给 GUI 命令面板(与模式单选等价入口,均为一次性 plan-arm+立即提交)。

### 5.2 GUI 确认卡与回放

- 确认卡=计划书 markdown 渲染+步骤列表+批准/反馈输入(阶段一的置灰解除)。
- 持久化/回放:不新增旁车键——计划书批准后已在链(`'plan'` 行,回放走链);plan-arm 态与进行中的规划轮**跨重启不恢复**(如实语义:重启落 idle+当前档,已批准的计划书随链在);档位变化经既有 mode 记录行回放。

### 5.3 测试(阶段三)

- serve e2e:模式单选 plan→提交→规划轮(read-only 判定断言)→挂起卡→批准→acceptEdits→逐项执行;反馈环路径;运行中 409;回放断言(链含计划书、档位如实)。

## 6. 命名定稿(全链单源)

| 中文 | 英文 id | 性质 | 图标 |
|---|---|---|---|
| 计划模式 | `plan` | 流程标记(GUI 单选/CLI 命令消费面;非权限枚举成员) | ListTodo |
| 只读模式 | `read-only` | 权限档 | Eye |
| 工作区编辑 | `acceptEdits` | 权限档 | ShieldCheck |
| 完全访问 | `full-access` | 权限档 | Unlock |

pill/菜单/帮助文案经 i18n `t()` 单表维护;read-only 拒绝消息出路提示见 §3.1。

## 7. 错误处理与边界

| 场景 | 处置 |
|---|---|
| 规划轮模型失败/model-error | 回执+回 idle(现路径),档位覆盖 restore |
| todos 空或 todo_not_configured | 正文编号行解析兜底(现逻辑降级保留) |
| 反馈轮超 3 轮 | 如实回执回 idle,不自动执行 |
| 执行单项失败 | 宁停(现 runPlanItems 语义),剩余保持未完成 |
| 规划/执行中用户中断 | interrupted 回执、归档抑制位复位、回 idle(现路径) |
| 运行中切换模式 | 409(现语义);覆盖期无并发切换源 |
| read-only 档写操作 | 硬拒+出路提示(不走确认) |
| 旧档/未知 mode 值 | `resolveModeAlias` 映射;仍未知回落缺省档+warn |

## 8. 后续演进(非本 spec)

- **方案 B**:exit_plan(plan_doc) 模型工具——计划模式转常驻档、模型自主出牌(CC 同构);planFlow 状态机与批准/注入面可复用,仅触发面从入口换成工具调用;
- dontAsk 主流语义档(「该问不问直接拒」)面向 headless/batch;
- 计划书落盘与跨会话引用(CC plans 式);
- auto 档(分类器后台安全检查)远期评估。
