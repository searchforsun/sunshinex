# 权限档重构与 plan 模式重造设计(read-only / acceptEdits / full-access · planFlow)

- 日期:2026-10-24
- 状态:已实施交付（2026-11-23 D83 批二状态回写核证：MANUAL.md --mode 旗标行与 §5.1/§六 现行口径（read-only/acceptEdits/full-access 三档、计划模式只读流程批准后实施）+ src/harness/security/modes.ts 三档枚举与 src/harness/plan-flow.ts 在座；原状态行留档：「- 状态:已批准(会话内分段评审;方案 A 与分节设计经用户确认后落档)」）
- 轮次:权限面与计划流程首轮(brainstorming 产出;承接 G10-C1b 模式面「plan 提交通道标记」的历史欠账与 /plan 首版语义空缺)
- 裁定记录:用户裁定——①一份 spec 三阶段(权限档改名+read-only 新增 / planFlow 共享模块+TUI 重造 / serve+GUI 接通),依赖递进,每阶段独立可交付;②计划书批准交互=批准+反馈驳回环(非 yes/no 二选一);③批准后执行档固定落 acceptEdits(不落回原档、批准卡不设选档);④TUI+GUI 一起纳入(GUI「计划模式」入口现状是 plan→dontAsk 假映射,必须随本 spec 收口);⑤方案 A 入口驱动共享 planFlow(方案 B exit_plan 模型工具留作演进);⑥命名定稿四项:计划模式/plan、只读模式/read-only、工作区编辑/acceptEdits、完全访问/full-access。
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 权限档三档重构对齐业界命名：`read-only / acceptEdits / full-access` 取代旧三档（旧名两处债出清：manual 名不副实、dontAsk 与 CC 同名反义——实为全放行语义），plan 从权限枚举除名退为流程标记；旧档别名回放单点映射，缺省档地位沿用，工具清单恒下发不按档裁剪、模式只改变判决。
- 计划模式最终定稿（经 2026-11-03 多轮修订收敛）=「read-only 强制覆盖 + exit_plan 挂起工具」：规划轮只读调研、模型显式出牌交稿（忘调工具的纯 reply 兜底保留）、审批面=计划卡本体、批准后同一 run 无感继续实施；驳回带反馈=原地修订再出牌（无轮次上限）、空反馈=放弃本轮（arm 保持）。
- GUI「计划模式」假映射（plan→dontAsk 全自动）出清，TUI/GUI/serve 三端同一流程语义；`/plan` 三态：裸=武装切档（幂等、任何状态可用不 busy）、带目标=（重新）规划（运行中入队收口后转规划）、off=解除。
- 批准卡按钮按当前档自适应（只读域三键含选档实施 / 可写域两键维持本档），批准落所选档；计划书落盘会话数据目录随修订覆盖写、删除会话随之清除，权威事实源仍是会话链。
- 关键架构收敛：权限档切换改纯字段轻量写（运行中即时生效，换档重建运行时整链退役、链原地零位移）；规划产物权威=结构化 todo 面与交稿正文，编号行解析降为兜底。
- 边界保留：read-only 硬拒+出路提示（不走确认）；规划轮只读覆盖窗口内切真档 busy；执行单项失败宁停。

## 现行真值

MANUAL.md §5.1 plan 模式（三态与出牌协议现行口径）与 §六 权限档与审批（三档语义）；CLAUDE.md §3 目录结构（src/harness/plan-flow.ts 共用纯件、security/modes.ts 三档枚举）。
