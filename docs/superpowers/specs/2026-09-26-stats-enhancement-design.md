# 子代理与主链任务统计增强设计

- 日期：2026-09-26
- 状态：设计已获用户确认（三项关键取舍均经用户裁决）
- 关联：`2026-09-26-child-inspector-view-design.md`（§3.1 子代理单行面板、§4 transcript 结构化）

## 1. 背景与动机

用户真机反馈（4 并发子代理调研任务）：

1. 4 个子代理陆续完成后，面板只剩 3 行——done 行是瞬态的：主链收批归档（`archiveInto`）时该行即从面板消失、折进 SPAWN 调用行 detail，完成统计随面板一起蒸发；
2. done 行只显示 tokens，缺步数与执行时长；
3. 主 agent 任务收尾没有任何统计——正文结束后用户看不到整个任务执行了多久、多少步、多少 token；
4. 状态栏 `↑tokens` 只聚合主链 usage（截图实测：主链 1491k，子代理合计约 2.6M 未计入），总消耗严重失真。

## 2. 裁决记录（2026-09-26，用户裁决）

| # | 取舍点 | 裁决 |
|---|--------|------|
| 1 | 子代理完成统计承载 | **归档行内补统计**——面板 done 行展示完整统计（步数/耗时/tokens），归档后由 SPAWN 调用行 detail 尾追统计摘要行（入历史区、/resume 可回放） |
| 2 | 主 agent 收尾统计形态 | **dim 系统行·入档**——任务完成后正文最后尾追统计行，随 journal 入档 |
| 3 | 状态栏 token 口径 | **合并为总数**——↑tokens = 主链 + 子代理合计；子代理缓存命中率无法统一计算显示，**先不加**（cache 命中率与 ctx 水位维持仅主链口径） |

## 3. 设计

### 3.1 子代理完成统计（面板 done 行 + 归档摘要行）

**数据**：`ChildLiveState` 补 `doneAt?: number`——done 事件置位（完成时刻）。面板 done 行耗时**冻结**在完成时刻：`duration = (doneAt ?? Date.now()) - startedAt`，不随渲染帧跳动。

**面板 done 行形态**（瞬态，归档前）：

```text
✓ [调研:前端体验与工程] done (14 steps · 4m15s · ↑1.3M tokens)
```

**归档摘要行**：`archiveInto()` 序列化 detail 时尾追一行统计（作为 detail 最后一行，随 SPAWN 调用行入历史区，/resume 回放可见）：

```text
⏱ 4m15s · 14 steps · ↑1.3M tokens
```

**subagentMeta 扩展**：`{ steps, durationMs, tokens }` 补 `tokens` 字段——归档摘要与全屏回看视图（ChildInspector）同源可复用。error/失败归档同形态记录（事实承载，steps/tokens/duration 照记）；零子事件即败的缺省行为不变（`Math.max(1, steps)` 等既有口径）。

### 3.2 主 agent 任务收尾统计行（入档）

任务正常完成时，正文最后尾追一行系统行：

```text
⏱ 3m12s · 25 steps · ↑3.1M tokens（含子代理 2.6M）
```

- **落点**：`closeTask()` 的 done 正常完成路径，`pushMsg('system', t(...))`——随 journal 入档、/resume 可回放；走 `t()` 双语（en：`⏱ 3m12s · 25 steps · ↑3.1M tokens (subagents 2.6M)`），属外观面不进提示词；
- **数据（基线差值口径）**：任务提交（submit）时建任务级快照基线 `{ tokens, childTokens, steps, startedAt }`（记录当刻主链 tokens 累计、子代理 tokens 累计、sessionSteps）；closeTask 时以当前累计减基线得差值——对单轮任务、plan 多步骤任务（步骤间累计不重置）均正确，不依赖 turn 语义；
- **省略规则**：任务期间无子代理 token 消耗时省略「含子代理」段；
- **边界**：仅 done 正常完成路径追加；中断（Esc/Ctrl+C）与 error 路径不追加（保留既有中断/错误行，不加噪声）。

### 3.3 状态栏 token 合并口径

```text
↑3.1M tokens · ctx 38k/1000k (3.8%) · 2 turns · 25 steps · glm-5.3-flash · cache 93.3% · todo 3/3 · 空闲
```

- `↑tokens` = 主链 + 子代理合计：`StatusMetrics` 补 `turnChildTokens` / `sessionChildTokens` 两个累计器，子代理 token 事件路由处（payload.subagent 分支）同步累加，归档不清零、仅 /new 归零（与既有 session 级累计器同生命周期）；
- **ctx 水位与 cache 命中率维持仅主链口径**：子代理 tokens 不占主上下文窗口；子代理缓存命中率无法统一计算，按用户裁决不显示。

## 4. 硬约束

- 历史区保持 ink Static 零改动（09-26 闪屏撤回裁决）：统计行以 `pushMsg` 入档尾追承载，属「尾追入档」既有合法通道，零重绘；
- 系统行走 `t()` 双语（外观面），不进提示词面、稳定段零改动；
- 零新增依赖；fork-safe（子代理工具面无变化）。

## 5. 测试计划

| 面 | 用例 |
|----|------|
| ChildPanel | done 行含 steps/耗时/tokens；doneAt 冻结耗时（固定 startedAt/doneAt 断言精确字符串，断言值不随时间变化） |
| session 归档 | archiveInto 后 SPAWN 行 detail 尾行含统计摘要；subagentMeta.tokens 在位；error 归档同形态 |
| closeTask | done 路径 messages 尾部产出 ⏱ 统计行且 journal 含该行（/resume 回放可见）；含子代理段在有/无子代理消耗两形态下正确；中断路径不产出统计行 |
| StatusBar | ↑tokens 为主链+子代理合并值；ctx 水位与 cache 命中率不受子代理 tokens 影响 |

## 6. 明确不做（YAGNI）

- 子代理缓存命中率：无法统一计算，用户裁决先不加；
- 中断/error 路径的统计行：不加（既有中断行已承载事实）；
- 拆分显示主/子 token：用户裁决合并为总数。
