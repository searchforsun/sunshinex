# 技术债清理台账（TECH-DEBT-LOG）

> 本文件只记录**历次清理的执行内容**，处理规则见 `docs/TECH-DEBT.md`。每次清理收尾时在此追加一行，该行的「清理后 HEAD」即为下一次清理的默认基线。

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
