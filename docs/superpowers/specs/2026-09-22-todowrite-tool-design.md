# todo_write 通用模型工具设计（对标 Claude Code TodoWrite · Codex update_plan）

> 日期：2026-09-22 · 状态：设计定稿，待用户评审
> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：MANUAL.md 5.1「实施进度由模型经 todo_write 自主维护」与待办卡三态现行口吻＋src/harness/tools/builtin.ts todo_write 注册（注释引本规格 D3/D4/D10）与 src/types.ts ToolCategory 'todo' 在座；原状态行留档：「原无状态行」）
> 决策链：定位=通用模型工具（用户裁决）→ 路径=A 单点状态面（用户裁决）→ 设计七节已获批准
> 对标：Claude Code `TodoWrite`、Codex CLI `update_plan`——两家共同形态：模型工具层的动态进度清单，模型自主维护、UI 只渲染、执行中实时更新
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 交付 `todo_write` 通用模型工具：复杂任务中模型自主建改进度清单、条目三态（pending/in_progress/completed）实时更新，待办卡用户可见——对标 Claude Code TodoWrite 与 Codex update_plan 的共同形态（模型工具层动态清单、UI 只渲染）。
- 关键裁决（用户两连裁）：定位=通用模型工具（任意复杂任务可用，/plan 清单作为同源种子）；路径=单点状态面——/plan 引擎清单与模型清单合流为单一事实源，「双清单并存」与「文件模拟」均否决。
- 工具形态与调度：入参全量替换、空清单=清空、条数超限显式拒绝（不静默截断）；新类别单发独占不进并行批、免审批（进程内状态写、零 IO 副作用）、deny 规则仍先行。
- /plan 种子与机械推进兼容：计划确认后条目灌 pending、步骤运行中/收口机械置态，替换旧 done 布尔勾选；引擎按步骤文本定位条目、模型中途重排不破坏引擎语义。
- 持久化与恢复免费继承：journal 事件词汇零扩展仅载荷升级、旧载荷重放容错归一，/resume · /rewind · /fork 全链继承；fork 子代理派生面剔除该工具（子代理进度经既有结论行回写，零主链状态污染）。
- 验收：TDD 用例面（schema 闭合校验/类别单发调度/免审批且 deny 先行/三条写路径同源/重放旧载荷容忍/三态渲染/description 无中文钉/派生面剔除断言）+ 门禁（tsc strict、全量、selfcheck 工具清单含 todo_write 且注册序稳定）+ 零新增动态源盘点审计。

## 现行真值

MANUAL.md §5.1 plan 模式（「实施进度由模型经 todo_write 自主维护」与待办卡三态）、MANUAL.md §四 基本用法（状态栏 todo 进度）、CLAUDE.md §5 主链工具面（todo_write 在册）。
