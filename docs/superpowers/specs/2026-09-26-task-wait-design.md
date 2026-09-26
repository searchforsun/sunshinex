# task_wait：后台任务阻塞等待工具设计

- 日期：2026-09-26
- 状态：已确认（用户裁决：方案 A · 阻塞等待 + 批量 + 终态回执）
- 主题：为后台任务（后台 exec、超时转后台 exec、后台子代理）补齐「等待」工具面

## 1. 背景与问题

后台任务线已交付统一账本 `TaskRegistry`（`src/harness/tasks.ts`）：exec 与 subagent 两类任务同构登记，终态统一写任务日志（exec 落 `[exit N]`，子代理落结论 marker 行），`task_stop` 承载停止面。但模型侧缺少「等待」面：

- 背景 exec 描述教模型 poll by reading that file，后台 spawn 描述教 inspect via read——现状即反复 read 日志轮询；
- 轮询无阻塞语义，模型只能 sleep 干等，每轮烧一次模型调用；
- 任务成功无回执推回，模型读到 `[exit 0]` 前无法确证结果，读到后还需再 read 一次拿输出尾部/子代理结论。

对标：Claude Code TaskOutput（阻塞等待后台任务并取回输出）。

## 2. 目标与非目标

目标：

- 新增专属工具 `task_wait`：阻塞等待后台任务到终态，终态回执内联输出尾部/子代理结论；
- 覆盖三类后台任务（后台 exec、超时转后台 exec、后台子代理）——账本同构，单点统一承载；
- 支持批量等待（一次调用等全部或指定多个任务）。

非目标：

- 不做完成事件自动尾追进链（方案 C）：任务终态不主动打断模型，等待主动权在模型；
- 不改变 task_stop、后台 exec、两段式 spawn 的既有语义；
- 不做取消等待（等待超时即返回，模型自判续等或 task_stop）。

## 3. 工具面设计

新增 `src/harness/tools/task-wait.ts`（与 `task_stop.ts` 同构、同册装配，selfcheck `tools :` 行同源）。

```text
task_wait(taskIds?: string[] | null, timeoutSeconds?: number | null)
- taskIds 为 null（缺省）= 等待当前全部 running 任务；指定列表 = 只等这些任务
- 已终态任务（含等待发起前已完成）立即回执，零等待、幂等
- timeoutSeconds 缺省 1800（§12 命令执行超时同量级，长任务宽预算）
```

schema strict 兼容：`additionalProperties: false`，`taskIds`（array of string / null）、`timeoutSeconds`（number / null）以 null 联合进 `required`。

### 3.1 回执语义

| 场景 | 返回 |
|---|---|
| 全部目标到终态 | 逐任务一行：`id / kind / status / exitCode`；exec 附任务日志输出尾部，子代理附结论（marker 行起全文，对标提交 0a4e6be 的结论落盘） |
| 超时仍有 running | 逐任务当前状态，附「可续等（再调 task_wait）或先处理其他事或 task_stop」的事实性说明，判断权在模型 |
| 未知 id | INVALID_ARG 附现存任务清单（照 task_stop 报错形态） |
| 无 running 且列表全空 | 立即回执当前无后台任务（幂等空回执） |

### 3.2 前缀缓存与工具清单纪律

- 新增工具 = 一次全量前缀断点（§5 既有明示，本设计即论证：等待是后台任务线的闭环缺口，原始工具 read+sleep 无法承载阻塞与终态回执语义）；
- 稳定段零改动：等待能力全部经工具描述分发，fork-safe，子面剔除 task_wait 时指令自动消失；
- 主链工具面登记：CLAUDE.md §5「另册」补 `task_wait`（task-stop 同册）。

## 4. 实现要点

- `TaskRegistry` 新增 `waitUntilSettled(taskIds, timeoutMs)` 单点：终态 Promise + 定时轮询兜底（纯 node: 内置，零新依赖）；任务终态时 resolve 对应 waiter；
- 回执裁剪：exec 输出尾部取任务日志末 200 行（与既有工具结果 200 行截断口径同量级，`builtin.ts` truncation 先例）；子代理结论从任务日志 marker 行起取全文（结论可能多行，0a4e6be 形态）；
- 等待期间不阻塞 reactor 主循环：task_wait 是工具调用，占据一个工具执行槽；其批内其他调用照常完成；
- owner 作用域语义不变：task_wait 只等本 run 名下可见任务（账本 `list()` 面即模型可见面，与 task_stop 一致）。

## 5. 测试设计

`src/harness/tools/task-wait.test.ts`（与被测模块同目录就近放置）：

1. 已终态任务立即回执（幂等、零等待）；
2. 运行中任务终态到达后回执带 exitCode 与输出尾部；
3. 超时回执 running 状态；
4. 批量混合：部分已完成 + 部分运行中，一次等到全部收口；
5. 未知 id INVALID_ARG 附现存清单；
6. 子代理后台任务回执含结论全文。

回归：`pnpm build` + 全量测试 + `pnpm selfcheck`（tools 行计数 +1）。

## 6. 文档同步

- CLAUDE.md §5 主链工具面「另册」补 task_wait 一行；
- README / MANUAL 按「表格+短行」体例各补一行。
