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

---

## 9. 2026-11-03 修订:/plan 三态与批准卡选档(已实施,三端)

会话裁定(用户 2026-11-03):/plan 本质是切档快捷方式——不应被在途状态挡出 busy/409;带目标即「按这个(重新)规划」;批准卡给执行档选择。本节推翻/扩员原裁定如下,实现已落地(§9.1-9.3 三端)。

### 9.0 裁定变更记录

| 原裁定 | 修订后 |
| --- | --- |
| ③ 批准后固定落 acceptEdits、批准卡不设选档 | 批准卡三选:实施·工作区编辑(缺省 primary)/实施·完全访问(显式选择,无二次确认——pill 直选 full-access 同权)/驳回附反馈;决策体 `{approved, mode?, feedback?}` 缺省 acceptEdits 兜底 |
| §5.1 serve /plan:档位切换 busy(运行中)/提交 409(流程在途) | 武装快路径:`setMode('plan')` 恒 ok——arm 只是 currentMode 标记(装配映射恒 acceptEdits,内核档不动),不重建运行时、任何状态可用、幂等、永不 busy;运行中武装对下一次提交生效 |
| 拒绝(无反馈)=无理由修订重入(烧轮次) | 空反馈拒绝=放弃本轮(aborted-discarded):流程即停、武装保持、不烧修订轮;带反馈才进修订环;判定序=信号中断最优先(TUI Esc/serve interrupt 先 abort 再回填拒绝,必须回执 interrupted 不误判 discarded) |
| ⑤ 方案 B(exit_plan 模型工具)留作演进 | 维持演进(本轮不做);计划书落盘同样维持演进 |

### 9.1 /plan 命令三态(三端口径)

- **裸 `/plan`**=纯切档(武装),幂等可重复;解除三路径=批准自动落所选档/`/plan off` 或 pill 切走/重启不恢复(原 §5.1 arm 语义沿用)。TUI 补齐裸武装(旧=Usage 提示),armed 可见性=系统回执+输入框提示文案(TUI)/pill(TUI 原无档位面,本轮新增输入提示位)。
- **`/plan <目标>`**=武装+按目标规划,按会话状态三分:
  1. 空闲→立即启动 planFlow(原语义);
  2. **规划在途/挂卡期→replan**:中止当前流程(信号+挂卡拒绝回填+有界等收束,`planReplanQuiet` 抑制「规划已中断」双文案)+以新目标重启;旧卡删表(GUI 单槽换卡,回执=404 面)——不再 409;
  3. **执行段/普通任务在途→武装+入 steer 队列**:不中断在途工作,当前 run 收口后队列补跑经 armed 拦截转规划(serve 递归 submit→arm 拦截既有路径;TUI drainQueue 增 armed 判定)。
- **`/plan off`**=解除武装(规划/挂卡期先中止流程;执行段 armed 已不成立=如实提示;普通 run 在途的真切档仍 idle-only,busy 提示稍后)。
- **GUI 武装提交通道(2026-11-03 用户裁定)**:pill/`/plan` 切计划模式后,普通文本(含图片)**直接走普通提交通道**,daemon submit 单点的 armed 拦截自动转 planFlow——**废除旧形态「armed 消息整行包成 `/plan <文本>` 命令」**(用户消息被改写成命令气泡+命令三态行=双份噪音,且 `/status` 等命令词在 armed 下被误吞);pill 乐观态与 daemon 的竞窗经 `setSessionMode('plan')` 快路径前置收口(幂等恒 ok),命令词不补(命令自管武装,`/plan off` 解除不被顶掉)。
- 区分「可 replan」与「执行段」:serve `planExecuting`/TUI `planExecuting` 标记(runPlanItems 持锁期置位)——执行段档位已落非 plan,armed 不成立。

### 9.2 GUI PlanCard 重排(2026-11-03)

- 计划书 markdown 限高纵向滚动(`max-height: min(44vh, 460px)`,修订轮换 pid remount 天然回顶)——长计划书不再把 dock 撑到顶;
- items 独立只读 `<ol>` 退役(Steps 节已随 doc 全文渲染,双份同内容即冗余;items 仍是执行权威,勾选进度走会话 todo 面);
- 反馈框常驻(拒绝面不再藏二级态;Enter=驳回提交、Shift+Enter 换行,composer 键位同构);
- 三按钮(§9.0);空文本驳回=放弃本轮(决策体不带 feedback);
- **plan 卡单槽**:新 plan-approval 帧先清同 kind 旧卡再挂(wire 无「挂起撤下」帧,本地不清会叠卡;reseed 同走此口)。

### 9.3 serve/TUI 机制面

- serve:`SessionRuntime.setMode('plan')` 武装快路径;`replan(goal)` 公开(静默中止+重启);`planFlowPlanning()`/`isPlanArmed()`/`abortPlanFlow()` 外窥;批准续段 `setMode(r.mode,{planFlowInternal})` 落所选档;`/plan-approval/:pid` 回执校验 mode∈{acceptEdits,full-access};aborted 臂增 discarded 文案。
- TUI:控制器 `planArmed`/`planExecuting`/`planReplanQuiet`/`planFlowSettled` 四标记;submit 分流三态(armed+规划/挂卡=replan,armed+idle=planFlow,其余沿 steer);drainQueue armed 判定;`landAcceptEditsOn` 泛化 `landModeOn(mode)`(armed 解除+setBaseMode+asker 仅 acceptEdits 接线);确认卡四键 `y`/`f`/`n`/`Esc`+选择器三选项;/new 软重置清新武装位。
- harness:`PlanDecision.mode?`/`PlanLandMode`;aborted reason 增 `discarded`;`runPlanFlow` 判定序(信号→空反馈驳回→修订环)与产物 `{doc,items,mode}`。

### 9.4 测试锚(2026-11-03)

- harness `plan-flow.test.ts`:空反馈→discarded 不烧轮、信号优先序、mode 回传(12 例);
- serve `plan-flow.e2e.test.ts`:运行中武装不 busy、挂卡期 replan(单槽+旧卡 404+文案抑制)、运行中 /plan 命令入队→收口转规划、full-access 落档、裸 /plan 幂等+off(10 例);
- TUI `session.plan.test.ts`:裸 /plan 幂等武装/off、运行中入队→队列转规划、挂卡期 replan、空反馈放弃 vs 带反馈超限、中断 armed 保持(19 例);App.selector 三选项翻新;
- GUI `PlanCard.test.tsx`/`Chat.test.tsx`:三按钮决策体/常驻反馈框/Enter 快捷驳回/单槽。

---

## 10. 2026-11-03 交稿协议(方案 B 转正):exit_plan 模型工具 + 计划书落盘 + 工具行链接化(已实施,三端)

§8 预留的方案 B 与「计划书落盘」两项演进本轮落地（会话裁定 2026-11-03：模型显式出牌交稿 + 计划工件化）。

### 10.1 交稿协议

- **exit_plan(name, doc) 模型工具**：规划轮模型调研完显式出牌交稿——name=计划名短语（模型起名）,doc=完整 markdown 计划书。terminal 工具：执行成功即终止规划 run（`stopReason='plan-presented'` 新词汇）,doc 进 harness 暂存槽（`takePresentedPlan()` 读即清）;宿主 `runPlanningTask` 接缝转译——`plan-presented` → `{done:true, reply:doc, name}`,**plan-flow 状态机零改动**（「reply=计划书」既有判定即权威通道）。
- **纯 reply 兜底保留**：模型忘调工具直接说完 → done+reply 照旧当计划书（双通道自然互斥）,name 从 goal 派生（截 24 字符,`derivePlanName`）。
- **guard 判决**：`exitPlanArmed` 武装位（宿主 enterReadOnly/exitReadOnly 接缝配对置位/清除,与 read-only 覆盖同生命周期）——仅规划轮放行;非规划轮硬拒带出路提示,拒绝不终止（模型看拒绝行自行调整）。子智能体子面剔除 exit_plan（规划轮是宿主级 fork,与子面无关）。工具清单恒下发口径不变（guard 判决,不裁剪清单）。
- **terminal 机制**：`RegisteredTool.terminal` 新字段;BatchRunner 执行成功置批级标志（被拒/坏参/重复跳过不算）;reactor 批后检查 → 收束 `stopReason`。ToolCategory 新增 `'plan'`（批次串行独占集成员）。

### 10.2 计划书落盘

- `<dataDir>/sessions/<journalId>.plan.md`：awaiting-approval 时宿主 born-write 铸档后写（每轮修订覆盖写）;`<id>.` 旁车前缀先例——purgeSession 前缀全家清理天然覆盖（删除会话即删计划文件,零新增清理面）。计划名是展示元数据,文件名固定。文件是给人看的工件——权威事实源仍是链（'plan' 行 + 合成工具行）。
- 接缝形态：plan-flow `persistPlan(name, doc) → {path}`（state 机只透传 name/path,零 IO 政策不变）,写盘单源 `writePlanDoc`（session-journal.ts,TUI/serve 共用）。

### 10.3 合成链行与 GUI 链接化

- **合成链行（回放权威）**：宿主在裁决回填/终态时向主链 append `[tool-call('exit_plan',{name,path}), tool-result('decision: …')]`——链序在 'plan' 行之前（红线①不破）;live 面靠 fork onEvent 事件帧实时显示（现状已通）;有交稿事实（awaiting-approval 到过）才合成,exhausted 末轮驳回行由 awaitApproval 合成零重复。decision 文本三态：implement via workspace edits / full access、rejected with feedback (round N)、discarded by user、interrupted、planning failed。
- **两处蓝色链接**：①工具行折叠行「提交计划 · <计划名>」链接（path 在场可点——回放合成行有 path,live fork 帧入参是模型原文无 path,降级纯文本,live 点击入口归②）→ `onOpenFile` 开侧栏 file 页签;②确认卡卡头计划名链接（live 权威入口）。文件打开走既有 `/session/:id/file` 端点（数据目录已放行+绝对路径原样,零新端点）。

### 10.4 测试锚

- serve e2e：exit_plan 交稿→卡带 name/path+plan.md 落盘→批准合成链行序（tool-call→tool-result→plan）;guard 非规划轮拒（不终止、无卡、拒绝行带出路提示）。
- TUI：同构（卡头计划名行/落盘/合成链行/逐项执行）。
- harness：name 透传+persistPlan 调用+卡事件带 path;derivePlanName 截断/兜底。
- GUI：交稿行折叠链接点击 onOpenFile、展开体三态、live 无 path 降级;PlanCard 卡头链接/降级。

---

## 11. 2026-11-03 补遗:交稿停卡态修正 + 权限档轻量切换(重建退役)

### 11.1 交稿停卡显示修正

exit_plan 交稿 = 规划 run 正常收束（ask_question 同观感:停在等待裁决而非「已停止」）。两处修正:①kernel done 归约（entry.ts）stopped 映射豁免 plan-presented——live run 行显「已运行 X」;②fork 规划 run 补落终态 runmeta 行（awaiting-approval 时宿主写,带 endedTs/seconds 无 stopped,TUI/serve 同构）——回放 seglog 悬空强制 stopped 规则不再触发。

### 11.2 权限档轻量切换（重建退役,运行中即时生效）

- **语义**:真档切换不再 idle-only/409——`setBaseMode` 纯字段写,下一未决工具调用按新档判决（guard/chain 全消费点活读;在飞调用/子进程不回溯）。换铸（assemble 重建+快照直传回种）退役:档位在装配期只进 guard 构造参数,重建是 v1 复用 reset 路径的惯性（54497be）,非 mode 依赖。
- **边界保留**:①规划轮 read-only 覆盖在座（guard.overrideActive）切真档 busy——遮蔽窗口不放开;②切离 plan 且流程在途保留 disarm 收口。
- **有意差异登记**:①sessionAllows/sessionDirAllows 跨档保留（旧换铸清空;加法语义）;②readGuard 不换铸（降档免重读,旧换铸「强制重读」退役）;③asker serve 无条件就位（档位门退役）,降档 acceptEdits 的 ask 卡直落挂起表;④批准续段改 setBaseMode 直切——换铸五件套（carry/snapshotExport/restoreSession/restoreSnapshot/重挂订阅）退役,链原地零位移（前缀缓存天然保,比换铸回种更强）。
- **测试**:运行中切 read-only → 同 run 下一写调用 COMMAND_DENIED（门控适配器确定性时序）;既有 ctx-snap/switch/disarm 锚全绿。

## 12. 2026-11-03 架构收敛:exit_plan 挂起工具(ask_question 同构) + planFlow 状态机消解(已实施,三端)

### 12.1 语义定稿(权威口径,覆盖 §4/§5/§10/§11 冲突面)

1. **计划模式 = 「read-only 强制(override 在座) + exit_plan 挂起工具」**,不再是宿主编排的状态机。流转:arm(pill/`/plan`)→提交任务→**会话作用域 run**→模型调研(过程在正文可见)→`exit_plan(name, doc)`→executor **弹卡并阻塞等待裁决**(run 不收口——界面保持运行中,与 ask_question「等待回答」同观感)→裁决:
   - **批准(mode)**→宿主在 executor 恢复**前**落档:exit override+`setBaseMode(mode)`+armed 解除+按计划书 Steps 播种 todos→executor 返回批准回执→**同一个 run 无感继续实施**(guard 活读,写操作即时放行)。
   - **驳回带反馈**→维持只读→executor 返回修订指引(反馈内嵌)→模型原地修订→再次 exit_plan→新卡。**无轮次上限**(模型自然迭代取代 PLAN_MAX_ROUNDS;`runPlanItems`/合成链行/`'plan'` 行注入/planFlow fork 全部退役)。
   - **驳回空反馈**→宿主中断 run 回输入态(arm 保持)。
   - Esc/中断→同放弃(既有 deny 回填路径)。
2. **非武装会话模型主动交稿=切入审批**(§10「guard 硬拒」退役):exit_plan 在非 armed run 被调时 executor 先弹「切入计划模式」审批卡(复用 approval 挂起,**30 秒超时自动 deny**)。批准→setMode('plan')+进 read-only 覆盖+计划提示 note→出计划卡;拒/超时→executor 返回拒绝文本(模型不再重试),原档原态不动(**不预切档不预武装**——批准才切)。guard 对 exit_plan 恒放行(armed 判定由 executor/seam 承载)。
3. **todo_write 回归执行期模型自管**(规划期仍不需要);交稿即正文事实:exit_plan 工具调用行(含 doc 入参)天然落主链,合成链行机制退役;`stopReason='plan-presented'`/terminal 工具面/BatchRunner terminalCalled 退役(exit_plan 不再终止 run,ToolCategory 'plan' 串行独占保留)。
4. **awaiting-plan 单义化(TUI)**:卡挂起期 status='awaiting-plan',摘卡即回 'running'——修订环两卡之间该状态只指新卡在挂(测试等待面/UI pill 单义)。

### 12.2 planSeam 接缝(harness→宿主单点)

`{ isArmed(): boolean; requestModeSwitch(timeoutMs): Promise<boolean>; awaitDecision(name, doc): Promise<PlanDecision> }`——seam 不在=工具不注册(ask 先例)。宿主实现:serve=挂起表 plan-approval 行+帧+resolvePendingPlanApproval(批准落档钩在 executor 恢复前);TUI=pendingPlan 卡+planDecide 回填+confirmPlanOn 落档。`/plan` 三态口径不变(arm 幂等/`<goal>`=提交/off=解除;运行中 `<goal>`=入队收口转规划;挂卡期=弃卡重新规划)。

### 12.3 验收锚

armed 提交→exit_plan 挂起(status 保持 running/awaiting-plan——无感锚)→批准→**同 run** 实施(链含工具调用行+todo_write)→done;驳回带反馈→原地修订再出牌;空反馈→放弃回输入态(arm 保持);非 armed→切入审批(拒→拒绝文本+原档不动,无计划卡);挂卡期切真档=弃卡+中断收口(不再 busy);轻量切档全组(§11.2)保持。
