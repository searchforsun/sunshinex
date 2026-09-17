# 会话持久化 + resume（事件日志形态）设计规格

- 日期：2026-09-17
- 状态：方案 B（JSONL 事件日志）经用户裁决批准（原话「B, 未来肯定要做重放和回溯的」），设计六节呈现获批（「继续」），落库待书面评审
- 关联：product_vision 2026-09-17（会话跨天持久化 + resume 升格一等能力：全会话口径、对标 claude --resume、/goal 续走为首个消费场景）、2026-09-16-goal-claude-code-alignment §11（goal 跨天恢复拆线，硬前置=本线）、2026-09-14-context-fork-design（链 API）

## 1. 背景与目标

目标形态定稿（2026-09-17 /grilling）将会话跨天持久化 + resume 升格一等能力：全会话口径（链/消息/UI 状态全还原）、对标 claude --resume、/goal 续走为首个消费场景。存储形态经方案对比（A 整包快照 / B JSONL 事件日志 / C 单键覆盖），用户裁决 **B**——追加日志天然是时间轴，未来重放（确定性重建）与回溯（截断/分叉）零格式改动。

目标：会话可跨进程/跨天恢复；`/new` 后旧会话可找回；恢复后模型上下文与 UI 现场连续（/goal 续走）。

## 2. 现状核实（探索收口）

| 事实 | 含义 |
|------|------|
| `SessionStore`（context/session.ts，save/load 走 StorageAdapter）已存在、ContextManager 已持有（`harness.context.session`），**零消费者** | 持久化底座有先例位；其单键形态不满足多会话共存，本线不扩它，新模块自持 IO |
| 链 API 完整：`chainView/appendChain/trimChainFront/resetSession`；HistoryStep[] 纯数据 | 链可序列化、可重建 |
| TuiState 纯可序列化：messages（ChatItem[]，seq 会话级递增跨 /new 不回绕）、todos、metrics、model、uiState（RetainedUiState：buffer/cursor/expandAll/latestFull/history/histIdx） | 全会话口径三块数据均可落盘 |
| `/new` 软重置：清审批登记/流式水位/messages/todos/children/关联栈 + resetSession()；保留 memory/ledger | 轮转化改动点明确 |
| `resolveDataDir` 权威 + `FileStore` 写点先例成熟；FileStore 无 append API | journal 模块自持 `appendFileSync`，目录 `data/sessions/` |
| resume 在 TUI/CLI 零入口；压缩块与水位为 ContextManager 内部状态 | 恢复入口与压缩状态导出均为新增面 |

## 3. 关键裁决

前置三项（决策问卷通道超时 PT5M，按项目六次先例以推荐项收束）：恢复入口=双入口、`/new`=归档化、存盘时机=任务收口。方案 B 裁决后并入：

| # | 裁决 |
|----|------|
| D1 | 双入口：TUI `/resume` 列表选号（按更新时间倒序）+ CLI `--continue` 读活动指针续最近；`--tier` 显式传入优先，否则沿用存档 model；`--language`/`--mode` 为启动参数不持久化 |
| D2 | `/new` 轮转化：flush 当前日志 → 生成新 sessionId → 指针指向新会话 → 软重置；旧会话日志天然在盘，`/resume` 可找回（归档零成本） |
| D3 | 收口落盘：事件入内存缓冲，三个 flush 点批量追加——任务收口 `closeTask()`、`/new`、TUI 正常退出 finally；运行中不写盘；崩溃最多丢当前任务一段现场（如实登记） |
| D4 | 事件日志形态（用户裁决 B）：`data/sessions/<sessionId>.jsonl` 每会话一文件、追加只增 + `data/sessions-active.json` 活动指针；写=追加事件、恢复=按序重放重建状态 |
| D5 | 事件词汇封闭枚举 schema v1（§4）；新增任何持久化状态必须先登记新事件类型 + 对应重放动作 + 重放一致性断言，三者同批——重放确定性的纪律来源 |
| D6 | 恢复语义安全缺省：status 恒 idle；会话级审批登记不持久化（恢复后重新审批）；children/spawnCalls/流式水位（committedLen/extractor）进程内瞬态不还原；metrics 为会话聚合不持久化（恢复后从零重计）；输入缓冲 buffer/cursor 为易失现场不还原（跨天恢复输入半文无意义——「UI 状态全还原」的明确边界）；重放后下一轮 prompt 与存档时逐字节一致（重放一致性=核心测试断言） |
| D7 | 回溯（截断到过去事件+重放=时间旅行；复制前缀分叉新 sessionId=分支）与 journal 自压实本期不实现、格式零改动预留，登记为方向 |

## 4. 事件词汇（schema v1）

文件首行为 header，其后按时间序追加：

| 事件 | 载荷 | 重放动作 |
|------|------|----------|
| header | `{t:'header', v:1, id, createdAt}` | 版本守卫：未知 v 拒载该档案并提示 |
| user | `{t:'user', text}` | 输入历史还原（RetainedUiState.history/histIdx 源） |
| msg | `{t:'msg', item: ChatItem}` | 消息流直注入（含原 seq；不重走 pushMsg 副作用），重放完成置 nextSeq=max(seq)+1 |
| chain | `{t:'chain', steps: HistoryStep[]}` | 链尾批量追加 |
| compact | `{t:'compact', ...压缩状态}` | 链折至水位、压缩块重建（精确字段=ContextManager 压缩状态导出访问器的导出形态，计划阶段钉扎） |
| todos | `{t:'todos', items}` | 待办全量覆盖 |
| model | `{t:'model', tier}` | 档位覆盖 |
| view | `{t:'view', expandAll, latestFull}` | 视图两态还原 |

sessionId 形态：`YYYYMMDDTHHMMSSZ-xxxx`（UTC 紧凑时间戳 + 4 位随机 base36），文件名可排序、跨会话唯一。

## 5. 挂钩、flush 与崩溃语义

- **单一事实源订阅**：链与压缩的 journal 事件经 ContextManager 变更订阅捕获（`appendChain`/`trimChainFront`/`applyCompaction` 三类变更），session 层零重复挂钩——链怎么变日志就怎么记，防编排者视角漏挂内部追加；`restoreSession` 为直接注入、**不触发订阅**（订阅只覆盖三类变更方法），journal 在恢复完成后才 attach（重放期间日志是读方，不二次写）。
- **session 层事件**：user/msg/todos/model/view 由 SessionController 在对应变更点产生（输入回显入档点、pushMsg 点、TodoWrite、/model、视图切换）。
- **flush 三点**（D3）：closeTask / /new（flush 后轮转）/ runTuiLoop finally；缓冲为空时 flush 为 no-op。journal 生命周期：建档（首个持久化事件产生时，header+事件同批写）→ attach（恢复完成时）→ flush×N → 轮转/退出。
- **空会话不落盘**：零输入零任务不产生任何文件；活动指针仅在存在日志后维护。
- **损坏语义（fail-bounded）**：尾行撕裂（crash 写一半）→ 重放到上一条完整事件并提示「日志尾部截断已跳过」；未知版本/空损坏档案 → 拒载提示不静默吞；`--continue` 拒载/无档案回退正常新会话；数据目录不可写 → 会话降级为不持久化并横幅提示（不阻断使用）。

## 6. 恢复入口与恢复语义

- **TUI `/resume`**：无参列出档案（倒序：id 内嵌时间/文件 mtime/首条用户输入摘要截断——从文件头扫描读取，零重放成本；消息数列不展示，登记简化）；`/resume <序号|id>` 恢复；恢复前当前会话先 flush（切换不丢现场）。
- **CLI `--continue`**：读活动指针 → 重放最近日志 → 带 restored 状态启动 TUI，启动行提示「已恢复会话 <id>」。短别名（-c）是否可用取决于既有 argv 解析形态，计划阶段核实，不预承诺。
- **恢复动作三面**：① ContextManager.restoreSession（链 + 压缩水位 + 压缩块，纯 API 不触发订阅）；② SessionController.restoreFromJournal（messages 直注入 + nextSeq 续排 + todos/model 回填，status=idle）；③ RetainedUiState 回填（history/histIdx/expandAll/latestFull），App 重挂自然读取。
- **首个消费场景**：resume 后 /goal 或新任务在链上续接——任务边界不重置上下文（fork 模型既有语义，零新代码）。

## 7. 落点表

| 文件 | 动作 |
|------|------|
| `src/tui/session-journal.ts`（新增） | 事件词汇类型、sessionId 生成、缓冲/flush/append、replay 解析（尾撕裂/版本守卫）、档案列表头扫描 |
| `src/harness/context/index.ts` | 三类变更订阅 + `restoreSession` + 压缩状态导出访问器 |
| `src/tui/session.ts` | 三 flush 点挂钩、恢复路径、`/resume` 命令、`/new` 轮转化 |
| `src/tui/components/App.tsx` | SLASH_COMMANDS 补 `/resume`、SLASH_HELP |
| `src/cli/index.ts` | `--continue` 解析与 tui 启动接线 |
| `TUI-MANUAL.md` / `README.md` | /resume 与 --continue 用法、数据目录 sessions/ 说明 |
| 不动 | `context/session.ts` SessionStore（接缝先例保留）、security（审批不持久化=零改动）、FileStore、ledger/memory |

## 8. 验收矩阵

1. 会话内多任务 + `/goal` + `/compact` 后退出 → `--continue`：messages/todos/model/uiState/链逐字段一致（重放一致性）
2. 恢复后继续任务：链上续接，下一轮 prompt 与存档末状态逐字节一致
3. `/new` 轮转：旧会话 `/resume` 可找回，新会话空链起，指针指向新会话
4. `/resume` 列表倒序与选号恢复；切换前当前会话已 flush
5. 崩溃语义：尾行撕裂重放到上一条完整事件并提示，已完成任务不丢
6. 安全缺省：恢复后 status=idle、审批登记为空（首次写操作仍走审批）
7. `--tier` 显式覆盖存档档位；`--language`/`--mode` 不持久化
8. 无档案/损坏/未知版本：提示后正常新会话，不静默吞
9. buffer/cursor 不还原；metrics 恢复后从零重计（口径登记）
10. 全量回归 + selfcheck 绿；新增「重放一致性」为核心断言

## 9. YAGNI 与否决备选

- **不做（本期）**：回溯截断/分叉（D7 方向预留）、journal 自压实、会话重命名/删除命令（文件手删即可）、跨项目迁移（存档钉在项目数据目录）、加密（本地明文与既有数据一致）、自动定时保存、CLI `--resume` 列表选择器（列表选择收敛在 TUI /resume）、metrics 持久化
- **否决备选**：A 整包快照（用户裁决否决：回溯需按点重切）、C 单键覆盖（多会话不共存）、逐事件实时写盘（写放大与 D3 收口落盘裁决冲突）

## 10. 自审

- 词汇封闭性：8 类事件覆盖全会话口径三块（链+压缩 / 消息+输入 / UI 状态+待办+档位）；瞬态与不还原清单（children/spawnCalls/流式水位/status/审批/buffer/cursor/metrics）逐项登记口径
- 一致性：D3 flush 点与 §5 一致；D1 双入口与 §6 一致；§2 SessionStore 零消费者与 §7 不动清单一致；D6 buffer 边界与「UI 状态全还原」愿景的差异已显式登记
- 范围：单一实施计划可承载（预计 4 任务 TDD：journal 模块 → ContextManager 恢复 API → 控制器挂钩+/resume+/new 轮转 → CLI --continue+文档门禁）
- 前缀缓存：恢复路径零新增拼装面；重放一致性断言即「相邻步前缀稳定」的跨进程版
