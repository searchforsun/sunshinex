# Plan 3:SessionKernel TUI 接入(转录持久化面 v2 收编,P3)

- Spec:docs/superpowers/specs/2026-10-17-session-kernel-design.md(§3.2/§4b/§6 P3)
- 前置:P1(内核 aa58bf8)、P2(daemon v2 a3f5591)
- 目标:TUI 会话档升 v2(msg/msg-update 行退役,内核 seg 面成为转录持久化);/resume 读面切 v2(链/参数面不变 + seg 面重建消息区);rewind/fork/compact 面回归。
- 范围裁定(渐进式):**渲染面不迁移**——TUI 静态区/实时区/动态区的渲染逻辑全数不动(推入 state.messages 的路径照旧);本轮只换**持久化面**(journal 写什么)与**恢复面**(resume 重建什么)。内核条目视图的渲染收敛(GUI 同款)留给后续轮次——词汇已统一(seg 面),视图映射是纯函数可随时补。

## 勘察结论(计划依据的代码事实)

- TUI 转录持久化写点收敛:`appendMessages`(msg 行)与 `updateMessage`(msg-update 行)两点;静态区含大量 TUI 专属行(命令回显/卡/md ANSI 归档/stats 行)——这些是**渲染归档**非对话转录,v2 后不再落档(resume 只还原对话,命令回显/卡即 ephemeral,对标 Codex)。
- user 行(输入历史+锚点+firstUser)**保留**(spec §4b 替换清单不含 user 面);todos/model/view/chain/compact/snapshots 行型照旧。
- submit 路径:slash 命令即时分流;自然语言=新轮或 steer 入队(两种都 pushMsg('user') 回显)。
- resume 版本守卫 `!==1`;消息区=reduceJournal 的 msg 面直注入;msgSeq=msg 行最大 seq。

## 改动清单

### 1. 写面:行映射单点共享(src/session/v2log.ts)

- 新增 `kernelEventRows(ev: KernelEvent): JournalEvent[]`——P2 serve/session.persistKernelEvent 的映射逻辑上收为纯函数(serve 侧改委托,消双写)。
- tui/session.ts 内嵌 `SessionKernel({ onKernelEvent })`:
  - `onEvent()` 顶部 `kernel.pump(e)`(子代理事件 kernel 自守卫零条目);
  - `submit()` 自然语言路径(新轮 + steer 入队两支,slash 除外)`kernel.submit(text)`;
  - persistKernelEvent = journal.log(kernelEventRows)——journal 未建档丢弃(惰性建档由 user 行/chain 订阅既有点承担);
  - `/new` 与 resume 装载时内核换新(resume:reduceV2Rows → kernel.seed,seq 续接)。
- `appendMessages`/`updateMessage` 的 journal 写删(msg/msg-update 退役;归档富化 updateMessage 仍改内存态,持久化面由 kernel tool 条承载)。
- 建档版本:`submit()` 的 `j.start()` → `start(2)`;`/new` `rotate()` 写 v2 header。
- 已知取舍(钉板):plan 轮终稿(planReplyNoArchive 屏上不出)内核照录——转录保模型输出,屏显归渲染面;steer 行以 `Queued:` 系统行在档(内核不产 user 条,daemon 自动续发路径的 user 事件帧照常入核)。

### 2. 读面:resume v2 装载(src/tui/commands-session.ts)

- 版本守卫 `!==1` → `!==2`(v1 旧档报不支持,purge 脚本清理)。
- 新增纯函数 `entriesToChatItems(entries, mdWidth): ChatItem[]`(KernelEntry → 静态区消息,形态与 live 入档对齐):
  - user(`> x`)→ `{role:'user', text:x}`(剥引用块);assistant → `{role:'assistant', text:renderMd(md), ansi:true}`;
  - thinking → `{role:'thinking', text:'Thought for Ns', detail:md}`(closeLiveBlock 折叠形);
  - tool → call+result 两件(`toolCallLine(name,input)` + result 全文/callId——live CC 配对同形);
  - notice → system 行;error → system 行(`Error: ` 前缀,与 live 同形);run → 跳过(状态栏承载);
  - msgSeq = 重建条数。
- `restoreFromSession`:kernel 换新 + seed(reduceV2Rows)→ state.messages = entriesToChatItems;链/参数/UI 现场还原不变。

### 3. 回归面(不动,验证)

- rewind/fork/branchFrom:逐行字节复制 v2 档零改动;listAnchors=TUI user 行 + daemon 链 task 行(既有双路径);compact/snapshots 行照旧。
- listSessions:firstUser=user 行(TUI)/链首 task(daemon)双源照旧。

## 测试

- commands-session resume 往返:ScriptedAdapter 跑一轮(v2 档:seg 面+user+chain)→ 新 controller resume → 消息区重建断言(user 剥前缀/assistant ANSI/thinking 折叠/tool 配对两件)→ 续跑一轮 seg 行 seq 续接;v1 档拒载文案。
- session.test:msg 行零新写(appendMessages 后 journal 无 msg 行);内核 user/tool/assistant 段行在档。
- TUI 全量 + daemon 全量(P2 既有面回归)+ GUI vitest(零接触面,守护性回归)。

## 验收(2026-10-17 实测)

- [x] 写面:SessionController 内嵌 kernel(onEvent 顶部泵入/submit 自然语言进核);kernelEventRows 共享映射(P2 serve 改委托消双写);appendMessages/updateMessage journal 写删除(msg/msg-update 退役);submit start(2)/rotate v2;/new 与 resume 换新内核(kernelSeedForRestore)。
- [x] 读面:restoreFromSession v2 守卫 + reduceV2Rows → entriesToChatItems 重建(user 剥引用块/assistant ANSI 现渲/thinking 折叠/tool call+result 两件/error `Error:` 前缀/run 跳过);msgSeq=重建数;链/参数/UI 现场还原不变。
- [x] 实测抓出并修复内核真 bug:**model-end 每模型轮收尾即发,作为段边界会把轮内正文与 done 终稿裂成重复两条**(live 单气泡 vs 落档双条)——改入流内集合,G14.213 语义面(route 边界)不动。TUI/daemon 共享此修复。
- [x] 回归:daemon 全量 1843 过 0 挂;journal 族重写 3 例(重放一致性=对话面重建断言/continueLast v2 fixture/撕裂 v2 fixture)+ subagent-meta 重写 1 例(resume SPAWN 行随档、meta/detail 内存富化不跨重启,档面零 msg 行);GUI 333 全绿零改动。
- [x] 显式取舍钉板:命令回显/卡(/model-tier 选择卡、恢复横幅除外——横幅是当轮 ephemeral)/SPAWN detail·subagentMeta 不跨重启;plan 轮终稿内核照录;steer 行不产 user 条(以 `Queued:` 系统行为准)。
- 表面行为:resume/rewind/fork/compact 对话面与现状一致;TUI 档 v2 后 GUI 可 attach(跨端空窗自愈)。
