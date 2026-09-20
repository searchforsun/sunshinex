# 事件级会话日志即时落盘（Crash-Resilient Journal）设计规格

- 日期：2026-09-22
- 状态：已获用户批准（设计裁决 D1–D8 经问卷「对齐 CC：事件级即时落盘」+「批准，落库规格并转 writing-plans」拍板）
- 关联：规格 2026-09-17-session-persistence-resume-design.md（D1/D3/D4/D5 原始裁决）、规格 2026-09-20-rewind-fork-design.md（§5/§6 影子快照与代码回退）

## 1. 背景与问题

现行会话日志（`src/tui/session-journal.ts`）为缓冲批量形态：事件 `log()` 入内存缓冲，仅三个 flush 点（closeTask 收口、/new 轮转、TUI 退出与切换前收口）批量 `appendFileSync`。对标 Claude Code（官方文档明示 *sessions are saved continuously as you work*，每条消息/工具使用/元数据逐行落 JSONL）后确认两点差距：

- **P1 崩溃丢失窗口为整任务轮**：进程被强杀/断电时，在飞任务轮的全部事件（含那条 user 指令本身）尚在缓冲未落盘，恢复只能回到上一个收口点，用户须重打指令。CC 的丢失窗口仅为在飞的一个工具步。
- **P2 影子快照回填耦合缓冲**：`amendLastUser` 依赖「本轮 user 事件仍在缓冲内」才能回填 write 影子快照清单。事件级即时落盘后缓冲不复存在，若不重构回填机制，`drain()` 清空队列后回填恒失败，/rewind 代码回退整线静默失效。

## 2. 目标与非目标

目标：

- 崩溃丢失窗口对齐 CC 事件粒度：指令、已完成步骤、消息、链行、压缩、待办、档位随产生随落盘。
- 撕裂容忍、fail-bounded、append-only、逐字节分档（branchFrom）等既有不变量零破坏。
- /rewind //fork 代码回退在事件级形态下语义等价（含锚点轮自身写入）。

非目标：

- 不引入 fsync/断电强持久（与 CC 同口径：依赖 OS 页刷，断电 best-effort）。
- 不做 journal 自压实、不做跨进程多写者协调（既有登记方向，本线不扩）。
- CLI 面无会话日志，本线为 TUI 专属。

## 3. 关键裁决

| # | 裁决 | 内容 |
|---|------|------|
| D1 | 缓冲机制整体删除 | `log()` 改为直接 `appendFileSync` 逐事件落盘；`buf`/`flush()`/`pending` 一并清退，无残渣。三 flush 点概念消失，收口只剩快照清单补拍（D2） |
| D2 | 影子快照改为独立事件 | 新增封闭词汇事件 `{ t: 'snapshots', files: SnapshotEntry[] }`，closeTask 时 `writeSnapshot.drain()` 结果非空才尾追。`amendLastUser` 及其「缓冲内寻 user 事件」机制删除 |
| D3 | 生命周期方法落盘语义 | `start()`/`rotate()`：mkdir + header 立即写盘 + 指针；`attach()`：仅换 id（续挂档已在盘，指针按 D4 更新）。目录创建收敛在三个生命周期方法，逐事件追加不做 mkdir |
| D4 | 活动指针写收敛 | 指针仅在 id 变化（建档/轮转/续挂）时写；同 id 内逐事件追加不再重写指针 |
| D5 | 快照型事件改变更点接线 | todos（任务起点建档、步骤完成勾选两处）、model（/model 分支）在变更点即时 `log()`；view 已在 `recordView` 即时 log（现状保持）。closeTask 不再补拍三快照事件 |
| D6 | schema additive、版本不升 | `snapshots` 并入 `JournalEvent` 联合，header v 恒 1。旧二进制读新档：`reduceJournal` switch 无 default 天然跳过未知事件（降级不损坏）；新代码读旧档：无 snapshots 事件、`user.files` 历史行照常消费 |
| D7 | 切换/退出收口调用清退 | 事件级形态下切换前收口（restoreFromSession 首行、/rewind//fork、/new）与退出 finally 的 `flushJournal` 全部为 no-op，调用点删除；「先 attach 再 restore 防双重 flush」防护随之失效即删（该隐患类结构性消失） |
| D8 | 命名 | `flushJournal` 更名 `sealJournal`（语义=closeTask 快照清单补拍，唯一保留的收口动作）；调用点仅剩 closeTask 一处 |

## 4. 数据面

事件词汇扩展（schema v1 additive）：

```jsonl
{"t":"snapshots","files":[{"path":"src/a.ts","hash":"<sha1>"}]}
{"t":"snapshots","files":[{"path":"src/b.ts","hash":"<sha1>","deleted":true}]}
```

- `files` 复用既有 `SnapshotEntry`（path 相对项目根 POSIX / hash / deleted）。
- 空清单不写事件（对齐旧 `amendLastUser` 空清单不写字段的兼容先例）。
- 时序不变量：snapshots 事件恒尾追在其所属任务轮的 user 事件之后、下一 user 事件之前（closeTask 时序天然保证）。

## 5. 落点表

| 文件 | 改动 |
|------|------|
| `src/tui/session-journal.ts` | D1 缓冲删除、log 直写；D3 生命周期落盘；D4 指针收敛；D2/D6 snapshots 事件与 `amendLastUser` 删除 |
| `src/tui/session.ts` | D5 todos/model 变更点接线；D7 切换/退出收口调用清退（含 690 行防护注释）；D8 `sealJournal` 更名；closeTask 只剩 drain→snapshots 事件 |
| `src/tui/entry.ts` | 两处退出 finally `flushJournal()` 调用删除（D7） |
| `src/tui/session-snapshots.ts` | `collectRestorePlan` 扩展：除 `user.files`（行号 ≥ anchorLine）外，同窗口内的 `snapshots` 事件 files 一并收集，按行号序「每路径取最早一条」合并输出（snapshots 恒后于同轮 user 行，行序合并天然正确，无需配对状态） |
| `src/tui/session-journal.test.ts` 等 | 缓冲/flush 用例重写为直写断言；新增未知事件类型跳过钉子（D6 兼容）、指针收敛断言（D4） |
| `src/tui/session-snapshots.test.ts` | 新增 snapshots 事件收集用例（含与 user.files 混合、每路径取最早、锚点轮自身写入） |
| `src/harness/tools/write-snapshot.ts` | 头注释同步（收口去向改 snapshots 事件） |
| 文档 | TUI-MANUAL/README 如有 flush/缓冲口径表述则同步（落库前 grep 核验；初查零命中，预计零改动） |

## 6. 恢复与回退语义

- **恢复面（/resume / --continue）**：零变化——重放 `reduceJournal` 不消费 snapshots 事件（快照属回退面非恢复面），消息/链/待办/档位/视图/输入历史照旧。
- **锚点（listAnchors）**：零变化——锚点仍是 user 行、行号制；snapshots 不产生锚点。
- **分档（branchFrom）**：零变化——逐字节前缀复制，snapshots 行随前缀自然携带。
- **代码回退（collectRestorePlan）**：按 §5 扩展；崩溃轮的 snapshots 事件未落盘时该轮回退条目缺失，如实降级（会话恢复不受影响），登记为已知边界。
- **旧档兼容**：`user.files` 消费路径保留，新旧两种快照载体并存读取。

## 7. 错误与边界

- 直写 `appendFileSync` 失败：沿既有 fail-bounded 取舍（现 flush 同样不捕获 IO 错误），不静默吞。
- 尾行撕裂：`parseJournalFile` 既有容忍零改动。
- 断电：best-effort（D 非 fsync 裁决），丢失窗口=OS 页刷未及的尾部。
- 流式 msg 逐 chunk 事件落盘：本地盘 KB 级 append 无感；chain 事件每步一次 append，与现行批量等量。
- 前缀缓存：本线零提示词面改动、零装配面触碰，击穿面为零。

## 8. 验收矩阵

1. 事件逐条落盘：提交任务后、任务运行中逐事件读档可见（user→msg→chain→…按产生序）。
2. 崩溃模拟：任务运行中强杀进程（模拟=直接新控制器不 flush），重进 `--continue`：指令与已完成步骤全在，续跑不重打。
3. 影子快照：任务含 write 后 closeTask，档内出现 snapshots 事件且非空；/rewind code 回退含本轮写入。
4. 空清单零事件：纯读任务收口后档内无 snapshots 行。
5. 兼容钉子：reduceJournal 输入含未知 `t` 事件时跳过不炸；旧形态 `user.files` 档 collectRestorePlan 照常收集。
6. 指针收敛：同 id 连续 20 次事件落盘后指针文件 mtime 不变；rotate/attach 后指针更新。
7. 无残渣：`flush`/`pending`/`buf`/`amendLastUser` 全仓零残留；三 flush 点表述从活文档清出。
8. 门禁：tsc strict 零报错、全量 fail 0、selfcheck OK。

## 9. 自审记录

- 落点行号以落库时字节为准（session.ts 处于多线混叠工作区，行号引用为 2026-09-22 快照值）。
- D5 中 /model 分支的精确落点（tier 与 effort 两处赋值）由实施计划现场核实后钉入用例。
- P2 风险复核：`drain()` 在 closeTask 唯一调用、snapshots 事件时序由 closeTask 单点保证，无并发写者。
