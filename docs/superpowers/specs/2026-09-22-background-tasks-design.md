# 设计规格：后台任务（对标 Claude Code 全形态）

- 日期：2026-09-22
- 状态：设计已获用户批准（选择卡答复：批准——落规格文档并转 writing-plans）
- 关联规范：CLAUDE.md §5（原始工具面复用/专属工具纪律）、§11（前缀缓存第一要义）、§12（长任务取向）、§14（平台兼容纪律）；`docs/superpowers/specs/2026-09-14-subagent-design.md`（spawn `background` 参数预留）

## 1. 背景与问题

- `exec` 为同步阻塞执行面：缺省 1800s 超时、32MB 缓冲、ProcessSandbox 单点；长命令（dev server / watch 构建 / 测试套件）占用整个会话轮；超时即失败；中断线登记边界「执行中的 exec 命令无法被杀」。
- `spawn` 的 `background` 入参已预留，v1 输入校验显式拒绝（`NOT_SUPPORTED: Background two-phase spawn is not available yet`）——两段式接缝留而未通。
- `MemoryPipeline` 为进程内单 worker FIFO（enqueue/drain），属内部沉淀面、模型不可见，不构成模型侧后台任务能力。
- CLAUDE.md §12 长任务取向把「命令可后台长跑」列为对标基线（Claude Code），当前缺位。

## 2. 对标调研结论

### 2.1 Claude Code（官方 Tools reference 原文核验，2026-09-22 抓取）

| 机制 | 形态 |
|------|------|
| 后台执行原语 | Bash 工具 `run_in_background: true` 参数——既有工具参数化，非新工具 |
| 输出承载 | 输出流式写工作文件；TaskOutput（按 ID 取输出）官方已标 Deprecated，指路改为直接 Read 输出文件路径 |
| 状态查询配套 | `/tasks` 列出并停止后台任务（用户面）；TaskStop 按 ID 停止（模型面）；未命中 ID 时错误列出现存任务 ID+描述 |
| 超时语义 | 命令到超时未完成自动转后台而非杀掉（`sleep` 开头除外），结果显式回报 moved to background + 任务 ID + 输出文件路径 |
| 生命周期 | 前台子代理启动的后台命令随其最终答复终止；主会话/后台子代理启动的跨答复存活；非交互 `-p` 模式 run 终态后随即结束 |
| 事件流（另一形态） | Monitor 工具：后台跑命令逐行回流给模型，或挂 WebSocket 事件源 |

### 2.2 Cloud Functions / Cloud Tasks（通识口径——官方文档域连接超时未能原文核验，如实标注）

- Cloud Functions「后台函数」= 事件驱动 fire-and-forget，执行状态对调用方不可见（查询靠日志与事件源）。
- Cloud Tasks = 队列 + 投递 + 指数退避重试 + 速率控制，任务为持久化队列条目，凭任务名可查、可删。
- 长任务状态查询行业标准 = LRO（Long-Running Operation）：提交返回 Operation 对象（name / done / metadata / response 或 error），凭 name 轮询至 done。
- 公共启示：把任务状态做成一等可查询对象（任务 ID + 状态 + 结果位置），配取消语义。

### 2.3 统一性结论

两家的答案都是「统一账本、不统一工具」：统一性落在任务 ID 空间、生命周期与状态面；执行入口保持各自工具参数化。CC 把 TaskOutput 废弃改 read 输出文件，与本项目 §5「原始工具面复用」纪律同构。

## 3. 范围与路线（用户裁决）

- 范围：对标 CC 全形态——exec 异步、超时自动转后台、子代理 spawn 两段式、配套任务状态查询。
- 内部路线三选一：**A 统一任务账本 + 参数化入口（已选）**；B 零新工具极简面（停止靠模型拼 shell 命令，跨平台脆弱、无生命周期账本，已否决）；C 大一统 task 提交口工具（与 CC 口径相反、工具面最大，已否决）。

## 4. 关键裁决

| # | 裁决 |
|---|------|
| D1 | 统一账本单点 `TaskRegistry`（新增 `src/harness/tasks.ts`），ID 空间/生命周期/状态统一承载；执行入口参数化（exec 加 `background` 入参、spawn 开通两段式），零新提交工具 |
| D2 | 任务 ID = 会话内递增确定性序号（`b1`、`b2`…），零随机源；ID 仅出现在链尾观察行，前置段零污染（动态面盘点审计口径内） |
| D3 | 输出承载 = `<dataDir>/tasks/<id>.log` 流式追加；任务终态时账本在文件尾写终态行（exec 写 `[exit N]`，subagent 写其结论行/失败补丁行作终态标记）；查询复用既有 `read`（数据目录只读放行先例见 memory 线，零安全链改动）；零主动完成通知，模型按需 read 轮询 |
| D4 | exec schema 增 `background`（`['boolean','null']` 进 `required`，`additionalProperties` 显式闭合，strict 兼容口径，照 spawn 先例）；description 同步教模型用法（英文单语） |
| D5 | 前台 exec 触超时 → 自动转后台登记而非失败（`sleep` 开头命令除外，照 CC）；观察行回报 moved to background + 任务 ID + 输出路径；审批语义不变——批准的是「跑这条命令」，转后台属执行形态 |
| D6 | 并行闸门细化：`background` 提交即返回、可进并行批；前台 exec 维持单发独占（reactor 判定按 `input.background` 分支） |
| D7 | spawn `background: true` 两段式开通：摘除 `NOT_SUPPORTED` 校验与 schema 中该描述文案，立即返回 runId 观察行；子代理结论行写任务输出文件（模型 read 获取）；TUI 实时态沿用 ChildPanel 既有 done/error 事件分流；预算/护栏沿用 Runner 现行（父剩余换算、同层并发 4 上限） |
| D8 | `task_stop` 新工具（入参 `{id}`）：ToolCategory 新增 `task` 类（可并行）；免审批沿 spawn 先例、deny 规则仍先行；未命中 ID 报错列出现存任务 id+label（照 CC）；exec 进程 kill 与子代理 abort 的平台差异收敛在 TaskRegistry 单点 |
| D9 | 生命周期：前台子代理启动的后台任务随其收口收割（ownerRun 记账，照 CC）；主链启动的跨轮存活、`/new` 保留（任务属进程）；CLI 非交互 run 终态后收口在飞任务（对标 CC `-p` 语义）；TUI 退出随进程终止、退出前回执登记在飞任务 |
| D10 | 账本进程内承载，不落盘、不跨会话（对标 CC 任务属进程）；用户面 `/tasks` = 第 19 条扁平斜杠命令，无参列任务表（t() 双语纯回执，选择卡交互后置批次） |

## 5. TaskRegistry 数据面（`src/harness/tasks.ts`）

- 记录形态：`{ id, kind: 'exec' | 'subagent', label, status: 'running' | 'done' | 'failed' | 'stopped', outputFilePath, exitCode?, ownerRun? }`。
- 接口面：`submit`（登记+开日志）/ `list`（全量快照）/ `stop(id)`（kind 分派 kill/abort，终态落文件）/ `reap(ownerRun)`（前台子代理收口收割其名下任务）。
- 写入纪律：日志追加与终态行走 FileStore 原子写先例的追加形态；数据目录路径统一经 `resolveDataDir` 解析（§7 运行时数据落盘纪律）。

## 6. exec 后台化（`tools/builtin.ts` + `security/sandbox.ts`）

- ProcessSandbox 新增 detached spawn 形态：stdout/stderr 追加写任务日志；立即返回观察行 `task b1 started (output: <dataDir>/tasks/b1.log)`；后台输出不进 fitOut、不占上下文窗口。
- 超时自动转后台挂在前台 exec 现行 timeout 判定点：触界即转登记，`sleep` 开头命令除外。
- schema 与 description 同步（D4）；「中断无法杀在飞前台 exec」边界维持，后台任务经 `task_stop` 可停。

## 7. spawn 两段式（`subagent.ts`）

- 校验面摘除 `background === true` 的 `NOT_SUPPORTED` 抛错与 schema 中对应描述文案（删除即无痕）。
- 两段式：提交立即返回 `spawned <id> (<label>)`；Runner 后台执行，结论行写任务输出文件；失败补丁行同落文件。
- 事件面零新增：既有 `payload.subagent` 分流与 ChildPanel 终态渲染直接受益。

## 8. 停止与查询工具面

| 面 | 形态 | 纪律对账 |
|----|------|----------|
| 查询 | `read` 输出文件（复用，零新工具） | CC 废 TaskOutput 改 read 的同构方向 |
| 停止 | `task_stop` 新工具 `{id}` | 工具清单 +1 = 一次全量前缀断点（路线 A 经用户裁决买断）；§5 专属工具论证成立（跨 kind 停止的统一生命周期语义，原始工具拼凑脆弱） |
| 用户面 | `/tasks` 命令（第 19 条扁平命令） | SLASH_COMMANDS/slashHelp/手册同步；t() 双语上屏 |

## 9. 生命周期与错误边界

- 提交失败（无法创建日志/进程启动失败）：fail-bounded 显式报错回观察行。
- 任务失败：`failed` 终态 + 文件尾错误行；被停止：`stopped` 终态。
- `task_stop` 未命中：报错列出现存任务 id+label；命中已终态任务：幂等回执当前终态。
- 输出文件写失败：按启动失败显式报错，不静默吞。
- §14 平台差异：Windows 下进程组终止语义（detached 子进程收割）随实施复核并在 CLAUDE.md §14 登记结论。

## 10. 前缀缓存与上下文面

- 工具清单 +1（task_stop）+ exec/spawn schema 变更 = 同批一次全量前缀断点；此后整场冻结。
- 观察行全部尾追；后台任务完成零主动注入（模型轮询 read，中段零击穿）。
- 强制回归：相邻步前缀稳定用例（断言首个差异点落尾部新增段）、动态面盘点审计（task ID 递增计数器仅进链尾，装配面零时间戳/随机值）。

## 11. 落点表

| 文件 | 改动 |
|------|------|
| `src/harness/tasks.ts` | 新增 TaskRegistry 单点 |
| `src/harness/security/sandbox.ts` | ProcessSandbox 后台 detached spawn 形态 |
| `src/harness/tools/builtin.ts` | exec schema+executor 分支；task_stop 注册 |
| `src/harness/subagent.ts` | 摘 NOT_SUPPORTED；两段式开通 |
| `src/harness/reactor.ts` | 并行闸门按 input.background 细化 |
| `src/harness/index.ts` | 装配 TaskRegistry 贯通 deps |
| `src/types.ts` | ToolCategory 增 `task`；共享类型登记 |
| `src/tui/session.ts` | `/tasks` 命令分支 |
| `src/tui/App.tsx` | SLASH_COMMANDS 与 slashHelp 同步 |
| `MANUAL.md` | 后台任务口径文档 |
| `CLAUDE.md` | §5 工具面登记（task_stop）、§12 后台长跑基线兑现注记 |

## 12. YAGNI 登记

- 零主动完成通知（模型轮询 read 即见 `[exit N]`）。
- 账本不跨会话、不落盘（CC 同口径）。
- `/tasks` 纯列表回执，停止确认选择卡后置批次。
- Monitor 类事件流工具（逐行回流/WebSocket 源）后置独立批次。
- MemoryPipeline 不收编（内部沉淀语义独立，与模型侧后台任务互不相涉）。
- 输出文件自动清理缺省（数据目录治理既有口径承载）。

## 13. 验收矩阵

1. exec `background:true` 提交即返回，观察行含任务 ID 与输出路径；输出文件随命令增长；终态出现 `[exit N]` 行。
2. 前台 exec 触超时转后台：观察行报 moved to background + ID + 路径；`sleep` 开头命令仍按超时失败。
3. spawn `background:true` 立即返回 runId；结论行落任务输出文件；既有同步 spawn 用例零破坏。
4. `task_stop` 命中 running 任务转 `stopped` 终态；未命中报错列出现存任务 id+label。
5. background exec 可进并行批（提交即返回）；前台 exec 单发独占既有用例零破坏。
6. `task_stop` 免审批走通、deny 规则仍先行。
7. 前台子代理收口收割其名下后台任务；主链任务跨轮存活、`/new` 保留。
8. 前缀回归：工具清单变更后相邻步前缀稳定用例绿；动态面盘点审计零泄漏。
9. `/tasks` 列表回执双语上屏、手册同步。
10. 三门禁：`pnpm build`（tsc strict 零报错）+ 全量测试 + `pnpm selfcheck`。

## 14. 测试切面（TDD，预计 4–5 任务）

- TaskRegistry 单元：登记/列表/停止/收割/未命中列报/幂等终态。
- exec background 端到端：提交即返回、日志增长、终态行。
- 超时转后台：显式小 timeout 构造（§12 允许测试小值构造边界）。
- spawn 两段式：立即返回/结论落文件/同步路径零回归。
- 并行闸门双态 + task_stop 安全链（免审批+deny 先行）。
- 前缀稳定与动态面审计回归。
