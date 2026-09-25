# 子代理查看视图（Child Inspector）设计

> 2026-09-26 · 状态：已与用户对齐设计，待实施
> 决策记录：用户提出「子 agent 改成和主 agent 一样的显示效果……可以选择其中一个正在运行的，进入查看工具思考过程，还有主 agent 委派的提示词，整个页面都替换成子 agent，按 esc 退出，参考 claude code 但作增强」

## 1. 目标

运行中的子代理获得与主 agent 一致的呈现与查看能力：

- 主界面输入框下侧，每个子 agent **一行**（CC 式紧凑行），替代现有每代理 4 行面板；
- 可以**选中**其中一个子 agent 进入**全屏查看视图**：整页替换为该子代理的完整转录（工具调用行、结果行、思考文本流、主 agent 委派的提示词），Esc 退出；
- 已完成的子代理可从历史区经同一浏览器回看归档转录。

## 2. 非目标

- 视口外的更早内容翻页回滚（先只做尾部跟随视口，YAGNI）；
- 全屏视图内任何输入/交互（纯只读，无输入框）；
- 子代理与主链的双向交互（只读观察，既有回写语义不变）。

## 3. 交互设计

### 3.1 子代理列表（输入框下侧，CC 式一行/代理）

```text
✻ [单体后端调研] [grep] 12s · step 14 · ↑13k tokens     ← 活动态：当前工具+单调用耗时+步数+tokens
✓ [微服务架构] done (↑2.1k tokens)                       ← 完成态终标
```

- 现有 ChildPanel 的 4 行/代理（spinner + 3 行尾流）收敛为 **1 行/代理**；信息密度由活动视图（3f4fe05 已落地）与全屏视图承载，尾流 3 行让位于全屏查看；
- 位置不变：动态区、输入框下侧。

### 3.2 统一子代理浏览器（Ctrl+B 升级）

现有 Ctrl+B 只浏览历史区已归档 spawn 调用行；升级为统一选择序列：

```text
↑↓ 选择序列 = 运行中子代理行（动态区列表） ++ 已归档 spawn 调用行（历史区，既有语义）
Enter 分流：
  选中运行中子代理 → 进入全屏实时视图（ChildInspector）
  选中已归档行     → 进入全屏回看（detail 派生，替代原行内展开）
Esc 逐级退出：全屏 → 主界面
```

### 3.3 全屏查看视图（新组件 ChildInspector）

```text
✻ [单体后端调研] 子代理视图 · step 14 · ↑13k tokens · 12s · Esc 退出   ← 头部状态行
● [READ] src/main.java                                                  ← 调用行（与主 agent 同形态）
⎿ ✓ 84 lines                                                           ← 结果行（✓/✗ ok 标记）
分析中…（思考文本原样混排）                                              ← 文本行
⏺ 委派提示词：调研单体版 AI 代码生成链路…                                ← 头部附委派 prompt（spawn input.prompt）
```

- 进入后 MessageList、输入框、底栏全部让位，整页只渲染该视图；
- **运行中**：每帧从 `ChildLiveState.transcript` 取尾适配视口高度（视口高度取 `useStdout().stdout.rows` 减头尾行预算），实时流式刷新（用户裁决：实时流式）；
- **已完成**：从 spawn 调用行 detail 派生静态全文回看（用户裁决：已完成可从 Ctrl+B 进入）；
- 只读、无输入框；Esc 退出返回主界面（用户裁决）；
- 委派提示词取自 spawn `tool-call` 事件的 `payload.input.prompt`，随 ChildLiveState 存档并在视图头部呈现。

### 3.4 浏览序列排序

Ctrl+B 选择序列：运行中子代理行在前（按启动时间序），已归档 spawn 调用行在后（按入档序）；↑↓ 循环移动，当前选中行高亮反色。

## 4. 数据结构

### 4.1 transcript 结构化（session.ts）

现有 `ChildLiveState.transcript: string[]` 纯文本行无法区分调用/结果/思考，改为轻量结构行：

```ts
export interface ChildLine {
  kind: 'call' | 'result' | 'text';
  text: string;    // call 行为 toolCallLine 形态；result 行为结果摘要；text 为流式/思考原文
  ok?: boolean;    // 仅 result：成功/失败
}
```

- `onChildEvent` 的 tool-call / tool-result / token(text) 三分支产出对应 kind；
- `tail` 派生、归档 detail（spawn 调用行折入）同源消费本结构——回看与实时视图天然一致；
- 既有消费点（ChildPanel 尾流、detail 折入）随结构化同步适配。

### 4.2 ChildLiveState 增补

```ts
export interface ChildLiveState {
  // …既有字段（label/startedAt/steps/tokens/transcript/tail/calls/done）
  prompt?: string;   // 主 agent 委派提示词（spawn input.prompt，视图头部呈现）
}
```

## 5. 组件与文件落点

| 文件 | 改动 |
|------|------|
| `src/tui/session.ts` | ChildLine 结构化、ChildLiveState.prompt、onChildEvent 三分支产出结构行 |
| `src/tui/components/ChildPanel.tsx` | 4 行/代理收敛为 1 行/代理（CC 式），行内状态对齐 3.1 |
| `src/tui/components/ChildInspector.tsx` | 新建：全屏查看视图（运行中实时/完成态回看双模式） |
| `src/tui/components/App.tsx` | inspect 状态分支（全屏让位）、Ctrl+B 浏览序列扩容（运行中行）、Enter 分流、Esc 逐级退出 |
| `src/tui/session.ts`（归档） | detail 折入改用结构化行（渲染回看共用） |

## 6. 边界与不变量

- **Static 架构零改动**：主界面历史区与撤回后代码（15daf0e）行为一致，全屏视图整体渲染在动态区（有界=视口高度），不触碰 Static——09-26 全量重绘闪屏教训的硬约束（裁决 tui_no_full_rerender）；
- 审批卡/问询卡在场时禁入全屏（Esc 优先级让位模态卡）；
- 子代理完成瞬间正在全屏查看：头部切完成态标记，内容不闪断（transcript 追加即成终态）;
- 主链与子代理事件路由零改动（payload.subagent 分流语义保持）；
- 既有恒 4 行面板不变量随 1 行/代理改造同步废止（防闪烁动机由单行恒定高度自然继承）。

## 7. 回归与验收

- ChildPanel 行收敛用例（1 行/代理、活动态字段齐、完成终标）；
- transcript 结构化用例（三分支 kind 映射、detail 折入同源）；
- 浏览器序列用例（运行中行入序列、Enter 分流、Esc 退出）；
- ChildInspector 用例（运行中取尾适配视口、完成态 detail 派生、头部 prompt 呈现、Esc 退出恢复主界面）；
- 全量 `pnpm test` + `pnpm selfcheck`。
