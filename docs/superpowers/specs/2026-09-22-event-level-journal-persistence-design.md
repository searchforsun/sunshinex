# 事件级会话日志即时落盘（Crash-Resilient Journal）设计规格
- 日期：2026-09-22
- 状态：已实施交付（2026-11-23 D83 批二状态回写核证：CLAUDE.md §3 tui/ session-journal 条目（v3 段级行、jsonl 逐字节权威）+ MANUAL.md 故障表 journal v3 口径；src/tui/session-journal.ts 逐事件 appendFileSync（D1/D3）与 session.ts sealJournal（D2/D8）在座；原状态行留档：「- 状态：已获用户批准（设计裁决 D1–D8 经问卷「对齐 CC：事件级即时落盘」+「批准，落库规格并转 writing-plans」拍板）」）
- 关联：规格 2026-09-17-session-persistence-resume-design.md（D1/D3/D4/D5 原始裁决）、规格 2026-09-20-rewind-fork-design.md（§5/§6 影子快照与代码回退）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 会话日志从缓冲批量收口改为逐事件即时落盘：崩溃丢失窗口从「整任务轮」收窄到在飞单步（对标 Claude Code），任务运行中强杀进程后指令与已完成步骤全在、续跑不重打（验收 1/2）。
- 影子快照回填重构为独立 snapshots 事件，随缓冲一并清退；/rewind 代码回退在事件级形态下语义等价、含锚点轮自身写入（验收 3/5）。
- 恢复/锚点/分档三面零变化（snapshots 只属回退面）；旧档旧快照载体并存读取，未知事件天然跳过——schema 纯增量、版本不升（验收 5/6）。
- 既有不变量零破坏：撕裂容忍、fail-bounded、append-only、逐字节分档全保留；不做 fsync 断电强持久与跨进程多写者（与 CC 同口径 best-effort）。
- 收口收敛：切换/退出前的集中收口调用全部清退，唯一保留收口=任务收口时的快照清单补拍（空清单零事件，验收 4/7）。

## 现行真值

现行口径见 CLAUDE.md §3 目录结构（tui/ session-journal v3 段级行、jsonl 逐字节权威）、MANUAL.md 九、故障排查（journal 版本与恢复处置）。
