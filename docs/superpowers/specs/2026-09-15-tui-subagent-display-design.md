# TUI 子代理显示设计（Subagent Display）

- 日期：2026-09-15
- 状态：设计经用户确认（方案一获批），待规格审阅
- 上游：`docs/superpowers/specs/2026-09-14-subagent-design.md`（子代理能力已实施，提交 2e588ae…75bc760）、`2026-09-14-context-fork-design.md`（fork 显示语义依据）

## 1. 背景与问题

子代理能力已落地：spawn 工具（主链工具面）、SubagentRunner 单点拼装、同层并发上限 4、fork 私有执行零主链回写、终态一行 `[label]` 结论。

显示层现状缺陷：SubagentRunner 透传子代理 SessionEvent 时已带 `payload.subagent = label` 标识，但 `session.ts` 完全忽略该字段——子代理的 token/reasoning/tool 事件被当主链事件处理，输出混入主链 live 块与工具行。fork 语义只保证上下文层私有，显示层没有隔离。

用户诉求（2026-09-15）：①显示形态参考 Claude Code；②必须实时看到子代理内部流式输出。

## 2. 目标与非目标

目标：

- G1 主链零污染：子代理事件不进主链 live 块、不进主链工具行。
- G2 流式实时可见：每个运行中子代理的流式尾部在动态区实时呈现。
- G3 历史紧凑可展开：结束后归档为 Claude Code 式紧凑行（调用行 + 结果行），完整转录可展开重放。
- G4 并发可视：最多 4 个并发子代理同时可见，面板行数有护栏。

非目标（YAGNI）：

- 不做层级显示（子代理注册表已排除 spawn，深度恒 1）。
- 不做子代理内容搜索/过滤/导出。
- 不改 fork 上下文语义与结论行格式（仅同名并发消歧后缀，见 §7）。
- GUI 复用同一 SessionEvent 事件面另行设计，不在本期。
- background 异步两段式（若将来实施）复用同一面板、生命周期延伸到显式收束；本期 spawn 恒同步，不实现。

## 3. 关键裁决

| # | 裁决 | 理由 |
|---|---|---|
| D1 | 显示层隔离：子代理事件只写 `TuiState.children`，不写主链 messages/live | fork 私有性延伸到显示层；主链渲染路径零改动 |
| D2 | 运行中 live 面板 + 完成归档：流式内容在动态区实时渲染，终态才入 Static | Ink Static 条目渲染后不可变，流式文本无法原位更新——直写 Static 技术不成立；动态区每帧重渲、天然承载流式 |
| D3 | 归档载体复用 detail 机制：子代理全转录存 spawn 调用行 detail，展开复用 Tab/Ctrl+O 两层视图 | 不新增消息角色、不新增键位；与 thinking/工具结果折叠同机制 |
| D4 | 同名并发消歧收敛 Runner 单点：同 label 并发时后到者加 `#N` 后缀 | 结论行/事件标识随之，关联键唯一；TUI 不复刻后缀逻辑 |
| D5 | 面板行数恒定：头部 + 固定行数尾流，内容轮转不增减行数 | 动态区高度波动 = 整帧重排闪烁（TodoList/表格两先例）；流式面板必须恒高 |

## 4. 数据面（session.ts 子代理分流）

### 4.1 事件分流

`onEvent` 入口首查 `e.payload?.subagent`（string）：

- 存在 → 路由到子代理状态（§4.2/§4.3），return（不进主链任何分支）；
- 缺省 → 现有主链逻辑零改动。

### 4.2 ChildLiveState 与 TuiState

`TuiState` 新增 `children: ChildLiveState[]`（缺省 `[]`）：

```ts
interface ChildLiveState {
  label: string;        // payload.subagent 原值（含并发后缀）
  startedAt: number;    // 首个事件到达时刻
  steps: number;        // 子代理 step 事件计数
  tokens: number;       // usage 累计（端点回传时）
  transcript: string[]; // 全量行（归档用；工具行/流式文本统一行化）
  tail: string[];       // 最近 ≤3 行（面板渲染用，transcript 尾部视图）
}
```

### 4.3 事件映射

| 子代理事件 | 处理 |
|---|---|
| token / reasoning | 增量拼进当前行缓冲、遇换行成行追加 transcript（裸换行行化即可，无需主链 reply-flusher 的安全点切块；宽终端折行交渲染层），刷新 tail（= transcript 末 ≤3 行，含当前未成行）；节流 notify（复用流式合帧 120ms 窗口） |
| tool-call / tool-result | `toolCallLine` 行化追加 transcript/tail |
| step | steps 计数 |
| usage | tokens 累计 |
| done | 无操作（归档锚点在主链 tool-result，见 §4.4） |
| 其他/未识别 | 忽略 |

### 4.4 生命周期与归档锚点

- 面板创建：首个带该 label 的事件到达时。
- 归档触发：主链 spawn tool-result 到达（权威锚点——executor 返回必在子代理 run 结束之后，事件序保证子代理 done 先于 tool-result）。注意 tool-result 属主链事件、不带 `payload.subagent`：关联基名取**对应 spawn 调用行事件入参** `input.label ?? input.agent_id ?? 'subagent'`，在该基名下匹配未归档 ChildLiveState（label 精确命中 → `#` 前缀匹配 → FIFO 兜底），transcript 折入调用行 detail、children 移除该项，恰好归档一次。
- 回合结束 / run 重置 / `/new`：children 清空（与 live 同生命周期；resize 重挂、compact 天然安全）。

## 5. 渲染面（ChildPanel.tsx，新增）

挂载：App.tsx 动态区，MessageList（Static）之下、主链 LiveArea 之上；children 为空时不渲染（零占位）。

单面板形态（恒定 4 行）：

```
✱ [reviewer] · 12s · ↑1.2k tokens
  ● grep "notifyThrottled" src/tui
  ⎿ 4 matches
  正在核对节流窗口与 done 收束的竞态…
```

- 头部行：Spinner（复用现有组件与绿色语义）+ `[label]` + 经过时间 + `↑tokens`（对齐主链 Spinner 行语汇）。
- 后 3 行：tail 轮转（工具行/流式文本按 transcript 尾部如实呈现，超宽截断）。

并发护栏：4 面板纵向堆叠，单面板恒 4 行——任意并发数下整块行数恒定，不构成动态区高度波动源。

## 6. 归档与展开

- 归档行格式（全部复用现有行语汇，零新格式）：
  - `● spawn` 调用行（tool-verbs 已登记 spawn 动词则复用，缺则补登记）；
  - `⎿ [label] 结论` / `[label] 未完成收束` 结果行（Runner 既有回写文本，现状已渲染）；
  - 子代理转录 → 调用行 detail（行形态：两空格缩进 + 原行）。
  - 归档冲刷：归档前把半行缓冲按换行定界 flush 成行、并入 transcript，保证 detail 无残缺尾行。
- 展开验收：Tab（行数维度）/ Ctrl+O（内容深度维度）既有两层视图下，Ctrl+O 展开时 detail 全行重放、缩进保留（与工具结果全文、thinking 全文同机制；transcript-view 对 detail 的重放路径核对，预期零改动或微调）。
- 默认形态 = Claude Code 式紧凑：只有调用行 + 结果行。

## 7. Runner 同名并发消歧（唯一 Runner 改动）

- 规则：`runSubagent` 进入时统计同 base label 的 in-flight 子代理数 n；n>0 则本次 label = `${label}#${n+1}`。
- 作用面：`payload.subagent` 事件标识、结论行/补丁行前缀（`[code-reviewer#2] 结论：…`）。
- 确定性：并发集合内唯一；全部结束后计数归零，后续 spawn 重新从裸 label 开始。
- 不做：不新增 payload 关联 id 字段（label 即唯一关联键，归档匹配见 §4.4/§8）。

## 8. 错误与边界

- 孤儿事件（归档后仍到）：重建 transient child 仅累积，回合结束清空，不炸不悬。
- 归档未命中（child 零事件直完）：detail 置空转录占位，不阻塞主链渲染。
- 同名并发归档可能互换：两条同 label 并发子代理的转录按 FIFO+前缀匹配归档，极端时序下可能互换归属（同为同角色任务、结论行与上下文不受影响）；接受为已知边界。
- transcript 内存上界：由子代理预算（maxSteps/tokenCap 父剩余换算）天然兜底。
- 主链不变量复核：本设计为纯显示层，提示词装配面零改动。

## 9. 测试与验收矩阵

单测：

- session.test.ts：①带 `payload.subagent` 的 token/tool 事件进 children、主链 messages/live 零变化；②spawn tool-result → detail 归档 + children 移除（恰好一次）；③4 并发各自归档；④同名并发 `#N`（Runner 侧 subagent.test.ts 断言后缀）+ TUI 前缀匹配归档；⑤节流窗口内多次 token 终态完整；⑥回合结束 children 清空。
- ChildPanel.test.tsx（test-ink）：空 children 不渲染；单面板恒 4 行；4 并发总高恒定；tail 轮转帧高不变。
- 回归：TUI 全套 + subagent/spawn 套件全绿。

验收矩阵：

| 场景 | 断言 |
|---|---|
| 单子代理运行 | 主链 live/工具行无子代理内容；面板实时尾流 |
| 并发 4 | 4 面板同屏、行数恒定 |
| 完成 | 面板消失；`●` 调用行 + `⎿ [label]` 结果行；detail 全转录默认折叠 |
| Tab/Ctrl+O | 展开重放子代理行（缩进保留） |
| 主链不变量 | 子代理事件零进 messages/context；提示词装配面零变化 |
| resize/重挂 | 面板随 TuiState 重放、无残影 |

## 10. 落点表

| 落点 | 改动 |
|---|---|
| src/tui/session.ts | onEvent 分流、TuiState.children、归档逻辑（主体改动） |
| src/tui/components/ChildPanel.tsx | 新增组件 |
| src/tui/App.tsx | ChildPanel 挂载（children 非空时） |
| src/tui/tool-verbs.ts | spawn 动词登记核对/补登记 |
| src/harness/subagent.ts | 同名并发 `#N` 后缀（唯一 Runner 改动） |
| src/tui/transcript-view.ts | detail 重放路径核对（预期零改动/微调） |
| 测试 | session.test.ts、subagent.test.ts、ChildPanel.test.tsx |

## 11. §11 自答（前缀缓存第一要义）

本设计全部落在 TUI 显示层：SessionEvent 是旁路遥测、不进提示词；提示词装配面零改动，击穿面 = 0。唯一模型可见变化是同名并发时结论行文本带 `#N` 后缀——属链尾一行内容变化（append-only 尾追语义内），非结构性击穿。

## 12. 否决备选登记

- 方案二（子代理事件按时间序直写 Static）：Ink Static 条目渲染后不可变，流式文本无法原位更新，逐 chunk 开新条目致条目爆炸——技术不成立，否决。
- 方案三（热键切换聚焦、默认只显心跳行）：并发 4 下切换疲劳，且与「直接看流式输出」诉求相悖——否决。
