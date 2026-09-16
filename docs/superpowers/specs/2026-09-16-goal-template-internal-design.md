# `/goal` 模板语义从用户面隐藏 设计规格

- 日期：2026-09-16
- 状态：设计要点经用户裁决批准（「不要暴露给用户……保留这个模板，未来有其他方向的话，可以定义其他模板，作为内部的一种扩展方式」），落库待书面评审
- 关联：`2026-09-16-goal-claude-code-alignment-design.md`（goal 对齐，同日先落）、`2026-09-15-tui-goal-loop-entry-design.md`（/goal v1，D4 CLI/TUI 同语义裁决）

## 1. 背景与目标

用户质询 /goal 的 `--template` 参数定位后裁决：**内部设计的流程不暴露给用户**——`/goal` 就是一个标准的验收修正环，目标是完成任务；模板机制保留，作为内部扩展方式（未来有其他方向可定义其他模板），而不是暴露给用户。

目标：把模板概念从全部用户可见面（TUI `/goal`、CLI `run`、帮助/手册）整体摘除；内部注册表原样保留为扩展点。语义对标 CC：`/goal <goal>` 只有目标，没有装配参数。

## 2. 现状暴露面清单（已核实，session.ts / run-loop.ts / App.tsx 实读）

| # | 位置 | 现状 |
|---|------|------|
| 1 | session.ts `/goal` 分支 | `--template=(\S+)` token 解析、缺省 `DEFAULT_GOAL_TEMPLATE`；`TEMPLATE_NAMES` 校验 + 未知模板报错守卫 |
| 2 | session.ts `runGoalFlow(goal, template)` | 链行 `当前指令：${goal}（/goal · ${template}）`；启动行 `✻ /goal: ${template} · ${goal}`；done 回执 `✻ /goal done: ${template} · N iterations · M tokens` |
| 3 | session.ts usage（/goal 无参提示） | 含 `[--template=code-refactor\|test-loop\|code-review]` |
| 4 | session.ts SLASH_HELP | `/goal` 帮助行含 `[--template=...]` |
| 5 | CLI run-loop.ts | `--template` flag 解析（缺省 test-loop）、`resolveTemplate(deps, template)`、`[run] root=… template=…` 输出、usage 行含 `--template=test-loop` |
| 6 | TUI-MANUAL /goal 条目 | 命令表行与说明段含模板口径 |
| 7 | session.goal.test.ts | 用例 1 断言链行带 `（/goal · test-loop）` 标注；用例「未知模板报错列可选值」；用例「--template=code-review 显式覆盖」 |
| 8 | run-loop.test.ts | 无 template 断言（grep 零命中，已核实） |
| 9 | App.tsx SLASH_COMMANDS | 仅命令名 `'/goal'`，无模板变体（零改动） |

## 3. 关键裁决

| # | 裁决 | 内容 |
|----|------|------|
| D1 | 一切即目标文本 | `/goal` 后的全部内容（含看似 flag 的 `--template=…` 字样）**原样作为目标文本**进链，不做静默剥离——静默剥离等于行为上承认该语法仍存在，与「不暴露」矛盾；判据按条件语义读文本，flag 字样无特殊行为 |
| D2 | 标注去模板名、保留 /goal 身份 | 链行 `当前指令：${goal}（/goal）`（/goal 标注本身有信息价值：区分验收环任务行与普通任务行）；启动行 `✻ /goal: ${goal}`；done 回执 `✻ /goal done: N iterations · M tokens`；incomplete 回执本就无模板字段，不动 |
| D3 | 守卫收敛 | `/goal` 守卫只剩两件：无参用法提示（新文案）、运行中拒绝；「未知模板报错列可选值」守卫随 token 语法一并删除 |
| D4 | CLI run 同步摘除 | CLI 同属用户面：`--template` flag 解析删除、恒走缺省模板；usage 行去模板字样；`[run]` 输出去 `template=` 字段。旧脚本若仍传 `--template=xxx`：argv 解析器不识别即静默忽略（不报错，计划阶段核实解析器形态并登记） |
| D5 | 内部注册表原样保留 | `loop/templates.ts` 的 `resolveTemplate / TEMPLATE_NAMES / DEFAULT_GOAL_TEMPLATE / FACTORIES`（含 long-task 与 code-review 的 gate+fixer 装配）零改动——正合「未来定义其他模板作为内部扩展」：新增方向 = 注册表加工厂 + 内部调用点传名；`runtime.runLoop(goal, { template?, tier? })` 接缝签名保留可选 `template`（内部 API 扩展点），session 侧不再传、走缺省 |
| D6 | 测试面处置 | session.goal.test：链行断言改「无模板标注」；「未知模板报错」「显式覆盖 code-review」两用例删除（code-review 装配已由 templates.test.ts 注册表回归覆盖）；新增一例「含 `--template=xxx` 字样的输入整体作为目标文本」钉住 D1 语义；SLASH_HELP/usage 断言同步；文档同步 |

## 4. 落点表

| 文件 | 动作 |
|------|------|
| `src/tui/session.ts` | /goal 分支去 token 解析与守卫（D1/D3）、runGoalFlow 签名与三处文案（D2）、usage 双语（D2 口径）、SLASH_HELP 双语 |
| `src/cli/commands/run-loop.ts` | flag 解析删除、resolveTemplate 缺省调用、usage 与 `[run]` 输出（D4） |
| `TUI-MANUAL.md` | /goal 条目去模板口径（§13 交互面规范一致性） |
| `src/tui/session.goal.test.ts` | D6 三处用例处置 + 新增 D1 钉子用例 |
| 不动 | `loop/templates.ts` 全部、`runtime.ts` 接缝签名、`App.tsx`、`templates.test.ts` |

## 5. 验收矩阵

1. `/goal 把 src/auth 的测试跑到全绿`：行为与现状一致（标准环、终态回执），链行/回执/帮助无任何模板字样；
2. `/goal` 无参 → 新用法提示（无 `--template` 字样）；运行中 `/goal` → 既有拒绝不变；
3. `/goal --template=code-review 审查输出` → 整串作为目标文本进链（D1 钉子用例断言链行含原文）；
4. 未知 `--template=nope` 输入 → 不报错（作为目标文本），守卫不复存在；
5. CLI `run --goal="…"` → 恒走缺省模板，输出与手册无模板字样；旧脚本带 `--template=xxx` → 静默忽略不崩（按解析器实际形态登记）；
6. 内部注册表回归：templates.test.ts 全绿（三模板 + long-task 装配不变）；`runtime.runLoop` 可选 `template` 接缝既有用例不破；
7. 全量回归 + selfcheck 绿；前缀稳定用例不破（链行行文变化属一次性文案变更，非新增拼装面）。

## 6. YAGNI 与否决备选

- **不做**：`--template` 静默剥离兼容层（D1 否决）；模板注册 DSL / 配置文件式自定义（用户定位为内部扩展，注册表加条目即是）；/goal 帮助行展示「内部可用模板列表」（任何形式的暴露都违背裁决）；合并 code-refactor/test-loop（重构属另一决策，本规格只管隐藏不消减装配能力）；
- **否决备选**：仅藏 TUI 保留 CLI flag（违背「不暴露给用户」的完整语义，CLI 同属用户面）。

## 7. 自审

- 一致性：D1「一切即文本」与验收 3/4 一致；D5 保留面与用户「保留模板作为内部扩展方式」裁决逐字对应；
- 范围：只摘暴露面，不动装配能力与注册表——单一实施计划可承载（预计 2 任务 TDD）；
- 前缀缓存：链行文案变化属任务行内容（每次任务本就不同），非新增拼装面；usage/help 属界面文案非提示词；
- 残渣：runGoalFlow 的 template 参数、TEMPLATE_NAMES 的 session 侧 import 随之清理，无悬空引用（TEMPLATE_NAMES 本身保留——注册表自描述面，内部测试仍消费）。
