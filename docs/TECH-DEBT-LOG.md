# 技术债清理台账（TECH-DEBT-LOG）

> 本文件记录**历次清理的执行内容**与**未偿债项登记（待办债项区）**，处理规则见 `docs/TECH-DEBT.md`。每次清理收尾时在此追加一行，该行的「清理后 HEAD」即为下一次清理的默认基线。

## 记录格式

| 日期 | 基线 | 清理后 HEAD | 账本 | 范围与结果 |
|---|---|---|---|---|

- **基线**：本次清理所用的起点 commit（首次可为「含本账的提交」）。
- **范围与结果**：动了哪些文件/类别、残留复查结论、验证方式与结论（如 selfcheck + 单测全绿）。

## 台账

| 日期 | 基线 | 清理后 HEAD | 账本 | 范围与结果 |
|---|---|---|---|---|
| 2026-09-08 | 含本账的首次提交 | 同左（改动随该提交入库） | 记录债 | 全仓去厂商化：`.env.example` 示例值、README 两处表述、probe 脚本注释与日志 ×4、测试夹具键名（DEEPSEEK→TEST）；`docs/superpowers/` 历史存档按规则保留。残留 grep 归零；selfcheck exit 0，单测 165/165 通过 |
| 2026-09-08 | 8b11e60 | d457809 | 记录债 E/B + 代码债 G | 全仓技术债审计后按双账本当轮清轻债：CLAUDE.md §3 目录树同步实况（E）、§2 补 pnpm test/cli、§7 忽略清单补 .longtask/（B）；删零引用死文件 storage/store.ts、types.ts 死枚举收敛（LoopResult.retry 零产出移除、ToolCategory.network 降注释预留，engine.test 桩值同步）（G·轻）。验证：build 零错、165/165 全绿。遗留中级别债（登记待后续批次）：装配根 buildDeps 上移出 cli 层、错误模型契约统一（Result vs catch-reply）、感知跳过集与 .gitignore 单源化、解析类纯逻辑直接单测（config/agents/skills/loader）、真实模型 e2e 资产化 |

## 待办债项

> 未偿债项在此逐条登记（编号/账本/状态/描述/证据/偿还动作/登记来源）；偿还后在同轮提交中翻转状态并补「关联提交」。本区与上方清理记录互不掺杂。

| 编号 | 账本 | 状态 | 描述 | 证据 | 偿还动作 | 登记来源 |
|---|---|---|---|---|---|---|
| D1 | 二·J | open | 装配根 buildDeps 定义于 cli/commands/run-loop.ts，run-pipeline 跨命令 import；新增交互面（TUI/GUI）复用装配将被迫依赖 CLI 层 | run-loop.ts:10、run-pipeline.ts:5/47 | 上移 src/runtime.ts 作唯一 composition root，CLI 层仅参数解析 | 2026-09-08 清理行遗留 |
| D2 | 二·J | open | 感知 SCAN_SKIP_DIRS 与 .gitignore 人肉双源，已漂移一次（d8dbcc4 补 .pnpm-store）；.superpowers 仍缺 | perception.ts:14 vs .gitignore | export 唯一源 + 绑定测试锚点防漂移 + 补 .superpowers | d8dbcc4 |
| D3 | 一·B/二·J | open | 错误模型双轨：Result（tools/chain/sandbox）与 throw→catch→reply（engine/reactor/nodes）并存，跨层语义靠约定维持 | graph/engine.ts:161 等 14 处 catch | 契约入规 CLAUDE.md §4；实现收敛另批 | 2026-09-08 清理行遗留 |
| D4 | 二·补充 | open | 解析类纯逻辑无直接单测：config.ts / graph/agents.ts / harness/skills.ts / plugins/loader.ts / cli parseArgs | 无配套 *.test.ts 清单 | 补解析器单测五件套 | 2026-09-08 清理行遗留 |
| D5 | 二·补充 | deferred | 真实模型 e2e 未资产化，现靠手工 background + 产物判定，成果只在 git log | f2adf16、f5acd9a、clamp 验收 run3 | scripts/e2e-real 手动门脚本（需真实 key，单独批次，不进门禁） | 2026-09-08 清理行遗留 |
