# todo_write 通用模型工具设计（对标 Claude Code TodoWrite · Codex update_plan）

> 日期：2026-09-22 · 状态：设计定稿，待用户评审
> 决策链：定位=通用模型工具（用户裁决）→ 路径=A 单点状态面（用户裁决）→ 设计七节已获批准
> 对标：Claude Code `TodoWrite`、Codex CLI `update_plan`——两家共同形态：模型工具层的动态进度清单，模型自主维护、UI 只渲染、执行中实时更新

## 1. 背景与现状（代码事实，2026-09-22 工作区核实）

- 工具清单 12 项（exec / read / write / grep / glob / skill / webfetch / websearch / kb_search / memory_write / ask_question / worktree），无 todo 类工具；`src/loop`、`src/harness` 零 todo 概念，/goal 修正环进度走链行（deficits）。
- `session.state.todos` 唯一写入点为 `runPlanItems`（src/tui/session.ts）：/plan 规划轮产出 items → 逐项 runTask → 每步完成机械置 done。清单形态二值 `{text, done}`，模型只读、不可建改。
- 基建既有：TodoList 组件（紧凑/展开两态、行数恒定不变量）、journal `todos` 事件（末值语义，resume / rewind / fork 恢复已覆盖）。
- 对标基线：CC `TodoWrite` = `todos:[{content, status: pending|in_progress|completed, activeForm}]` 全量替换、使用规则写在工具 description；Codex `update_plan` = `{plan:[{step, status}], explanation}`。

## 2. 目标

为模型提供 `todo_write` 工具：复杂任务中自主建清单、实时更新进度，待办卡用户可见；/plan 清单与模型清单同源合流为单一事实源；journal 恢复全链免费继承；前缀缓存影响收敛为工具清单 +1 的一次性断点。

## 3. 关键裁决

| # | 裁决 | 内容 |
|---|------|------|
| D1 | 定位 | 通用模型工具：任意复杂任务中模型自主建改，/plan 清单作为同源种子（用户裁决） |
| D2 | 路径 | 单点状态面：升格既有 todos 为会话通用清单，双清单并存与文件模拟均否决（用户裁决） |
| D3 | 工具形态 | id `todo_write`；入参 `{ todos: [{text, status}] }` 全量替换；`todos: []` 合法=清空清单；条数 >50 报 INVALID_ARG（显式拒绝优于静默截断） |
| D4 | 类别与调度 | `ToolCategory` 新增 `'todo'`：单发独占（与 exec/ask 同策略，不进并行批）、免审批（进程内状态写、零 IO 副作用，沿 spawn/ask_question 先例；deny 规则仍先行） |
| D5 | 条目三态 | `TodoItem` 升格 `{ text, status: 'pending' \| 'in_progress' \| 'completed' }`；无 activeForm（活动态显示由既有 Spinner/task-state 承载） |
| D6 | 状态收敛 | `session.setTodos()` 唯一 setter：更新 state + `logTodos()` + notify；三条写路径全走此点——①模型工具调用 ②/plan 引擎推进 ③journal 重放；last-write-wins |
| D7 | plan 种子与推进 | /plan 确认后 items 灌 pending；步骤运行中置 in_progress、收口置 completed（替换 done:boolean 勾选）；引擎按当前步骤文本定位条目（无命中则跳过勾选），模型中途重排不破坏引擎语义 |
| D8 | 持久化 | journal `todos` 事件词汇零扩展，仅载荷形态升级；重放容忍旧载荷 `{text, done}`（done:true→completed / false→pending，封闭形态容错口径） |
| D9 | 子代理 | fork 派生面剔除 `todo_write`（沿 spawn 剔除先例）：子代理私有步骤零主链状态污染，进度经既有结论行回写 |
| D10 | 前缀缓存 | 工具清单 +1 = 一次全量前缀断点（CLAUDE.md §5 纪律内，D1 用户裁决即论据）；description 恒英文（§15）；注册序稳定冻结；观察行走既有观察→链路径，零新增装配面、零新增动态源 |

## 4. 工具定义

入参 schema（function calling strict 口径，additionalProperties 显式闭合）：

```json
{
  "type": "object",
  "properties": {
    "todos": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "text": { "type": "string" },
          "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] }
        },
        "required": ["text", "status"],
        "additionalProperties": false
      }
    }
  },
  "required": ["todos"],
  "additionalProperties": false
}
```

- description（英文单语）内嵌使用纪律：仅复杂多步任务建清单、同刻恰好一个 in_progress、完成即标 completed、每次全量替换整份清单、单一琐碎任务不必建。
- 观察行（英文单语，写链）：`todo list updated: N items (X completed, Y in progress)`；经既有观察路径尾追进链，模型下一帧自然见到最新清单（顺带承载 recitation 效应）。

## 5. 调度与安全

- 类别 `'todo'`：并行闸门按单发独占处理；manual 模式免审批（无文件/网络/命令副作用）；dontAsk 语义无需特判（无输入等待）；deny 规则仍先行。

## 6. 状态面与 plan 同源

- `TodoItem` 三态升格；`setTodos` 单点（session.ts）；/plan 种子与机械推进、模型工具调用、journal 重放三条路径同源。
- CLI 面同注册（工具清单三面一致=稳定段单一来源）；facade 缺省=账本留痕、无 UI（headless）。

## 7. 持久化与恢复

- `/resume` · `--continue` · `/rewind` · `/fork` 全链免费继承（todos 末值语义既有）；旧会话重放按 D8 归一。

## 8. 渲染（TodoList 升三态）

- ✓ 绿 completed / ▸ 高亮 in_progress / ○ 暗色 pending；紧凑形态当前项取首个 in_progress（无则首个 pending）；紧凑/展开两形态行数恒定不变量保持。

## 9. 落点清单

| 文件 | 改动 |
|------|------|
| src/types.ts | ToolCategory 联合 + 'todo' |
| src/harness/tools/builtin.ts | todo_write 注册（JSON Schema + 英文 description + facade 可选参，沿 SkillsFacade 形态） |
| src/tui/session.ts | TodoItem 三态、setTodos 单点、runPlanItems 种子与推进 |
| src/tui/session-journal.ts | todos 载荷类型升级 + 旧形态归一 |
| src/tui/components/TodoList.tsx | 三态渲染 |
| src/harness/subagent.ts | derive 派生面剔除 todo_write |
| 装配点（runtime / harness 聚合处） | facade 接线（TUI 实接 / CLI no-op） |
| MANUAL.md（待办卡三态口径）/ CLAUDE.md §3 工具注释 | 文档同步（CLAUDE.md 现有并发线 WIP，提交按 hunk 纪律拆分） |

## 10. 验证与验收矩阵

- TDD 用例：schema 校验（additionalProperties 闭合 / status 枚举 / 条数钳制 / 空清单清空）、类别单发不进并行批、免审批且 deny 先行、setTodos 三写路径同源、重放旧载荷容忍、TodoList 三态渲染、plan 种子与文本定位推进、description 无中文钉子、derive 剔除断言。
- 门禁：tsc strict 零报错 + 全量测试 + selfcheck（工具清单含 todo_write、注册序稳定）。
- 动态面盘点审计：零新增动态源（无时间戳/随机值进提示词面）。

## 11. YAGNI 登记

activeForm 字段；嵌套子任务与优先级/依赖排序字段；explanation 参数（Codex 有、CC 无，宁少勿滥）；todos.md 文件落盘（会话作用域，对标 CC transcript 生命周期）；引擎为普通任务自动建清单（建/改属模型自主，仅 /plan 播种）；CLI 面 UI 渲染。
