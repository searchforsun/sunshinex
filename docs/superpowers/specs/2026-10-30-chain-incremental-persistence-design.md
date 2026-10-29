# 会话链逐步入链 + 崩溃兜底回灌 设计（2026-10-30）

## 背景与问题

主链（`ChainLedger`，模型上下文的唯一历史来源）的写入时机是「整个 run 收束后一次性批量回写」：
`Reactor.run()` 起点把主链拷进局部 `steps`（`src/harness/reactor.ts:167`），全部轮次只累积在局部，
收束点（`:350-358`）才 `appendChain` 回写；journal `chain` 行挂在主链 append 事件上，回写前磁盘上
同样没有。两个用户可见症状同此一根因：

1. **面板不动**：`/context` 的「会话链」段读 `ctx.chainView()`，run 进行中恒定不变（取数是新鲜的，
   口径只含已收束主链）。
2. **崩溃后失忆**：进程意外中断时局部 `steps` 随进程消失——该 run 所有步骤既没进主链也没落盘。
   resume 只回放 journal `chain` 行重建模型上下文，崩溃 run 一行没有。journal 的 seg 转录行
   （user/assistant/tool/thinking，逐事件落盘）resume 时只重建屏幕显示，**不回灌模型链**——
   用户看得到历史聊天，模型不知道（显示面与模型面脱节）。

关联既有 spec：`2026-09-17-session-persistence-resume-design.md`（resume 原设计）、
`2026-09-22-event-level-journal-persistence-design.md`（seg 事件级落盘）。本设计收窄其遗留窗口。

## 目标 / 非目标

**目标**
- 崩溃丢失窗口从「整个 run」缩到「正在飞的一轮」。
- run 进行中主链逐轮增长：面板、journal、模型 seed 三面一致。
- resume 对崩溃 run 的历史做 seg 全量归约回灌（用户裁定口径：模型完整知道之前每步做了什么）。

**非目标**
- 在飞轮次的实时可见性（轮边界入链后轮内不可见，可接受，不做 step 事件旁路上报）。
- exec 内 shell 写操作的文件级跟踪（与持久化正交）。
- 面板轮询机制改动（零改动）。

## 方案裁定

选 **方案 A：轮边界增量入链**（用户裁定「就A」），配 seg 回灌兜底。弃选的旁路直写（journal 绕过
主链）产生双真相源、resume 语义分叉；全靠 seg 回灌则面板问题原样保留且回灌变常态路径。

入链粒度选**轮边界**（`chatRound` 正常返回后）而非逐行：一轮的多条链行（phase/调用/观察）共享同一
轮步号，轮边界追加是原子语义单元；且避开 `:338` 退位重试 `steps.pop()` 的镜像问题——失败轮的行只
在局部 `steps`、从未入链，pop 无需截断主链。

## 设计

### 1. Reactor 逐步入链（`src/harness/reactor.ts`）

- `:167` 附近新增游标 `appendedCount = 0`：局部 `steps` 中已入链的条目数。
- **轮边界**：`chatRound` 成功返回且非 done 后，`scope === 'session'` 时
  `appendChain(steps.slice(appendedCount))`，随后 `appendedCount = steps.length`。
- **注入点即入链**：steer 穿插行（`:224`）与 recite 重申行（`:238`）是终态行，注入后立即
  追加（session 作用域），不等下一轮边界。
- **压缩点 trim 增量化**：主动压缩（`:269`）与反应式压缩（`:333`）推进 `compactedUpToStep` 时，
  同步 `trimChainFront`——折叠行数按**已入链部分**精确计数（`appendedCount` 游标与
  `compactedUpToStep` 取交集：已入链且步号 ≤ 水位的条目数减去已 trim 过的累计数）。run 内多次
  压缩增量推进，收束点只处理未折余量。
- **收束点退化**（`:350-371`）：`appendChain` 参数从全量改为 `steps.slice(appendedCount)`；
  `trimChainFront` 只补余量。产出的链行序列与现实现逐字节一致，只是写入时机分散。
- **fork 作用域不变量不动**：`scope !== 'session'` 时所有新写入点短路，零主链回写
  （runtime.test「fork 作用域零主链回写」钉子保住并加中途断言）。
- **中断/模型错误终态**（`:323`、`:344`）：已完成轮已在链上，收束只补 `note` 行——resume 后
  模型天然知道中断前做到哪。

### 2. seg 回灌兜底（resume 路径）

- 归约纯函数（放 `src/tui/session-journal.ts` 或新小模块，TUI/daemon 共用）：输入 seg 条目数组与
  链尾水位，输出待回灌链行数组。映射规则：
  - `user` 转录行 → `task` 链行；
  - `assistant` 正文 → `reply` 链行；
  - `tool` 行（按 tool_call_id 配对）→ 对应 action 观察行；
  - `thinking` 行 → reasoning 附挂到相邻 assistant/reply 行。
- 消费点两处同构：`src/tui/commands-session.ts:169`（`restoreFromSession`）与
  `src/serve/session-lifecycle.ts:148`——`restoreSession` 后比对 seg 面与 `chain` 行链尾，
  seg 有而链没有的（崩溃档特征）经归约函数回灌，走 `appendChain` 单点（压缩/面板/后续 seed
  自动一致）。
- 兜底语义：正常会话 seg 与 chain 一致，回灌集合为空、零开销；只有崩溃档产生非空回灌。

### 3. 错误处理

- 轮边界 `appendChain` 抛错（磁盘满等）：吞错记 `note` 行，run 不中断——落档尽力而为，
  不为持久化牺牲任务执行（与 settle 吞错纪律同款）。吞错后 `appendedCount` 不推进，
  后续轮边界与收束点自然重试补写（append 幂等面由收束点 cut 过滤保证不双写）。
- seg 回灌失败（配对残缺/档损坏）：跳过残缺行，note 记录，不阻塞 resume——恢复永远可用，
  只是兜底少一条。

### 4. 测试

- **reactor 钉子（翻转既有断言）**：两轮 run，断言每轮完成后 `chainView` 已含该轮行（现有
  「收束才回写」的测试改写）；steer/recite 注入行即时入链；压缩触发时 trim 计数精确（链上无
  残留、history 无双份）；退位重试（context overflow）不产生链上空洞/双写。
- **fork 不变量回归**：fork 作用域 run 全程（含轮边界/压缩点/注入点）`chainView` 零变化。
- **seg 归约纯函数钉子**：四类 seg 条目 → 链行映射逐类断言；残缺档（tool 无配对、截断尾）跳过
  不炸；正常档（seg 与 chain 一致）回灌集合为空。
- **崩溃恢复端到端**：伪造「seg 多于 chain」的 journal 档，restore 后断言模型 seed 链含回灌行
  （TUI `restoreFromSession` 与 daemon `session-lifecycle` 两路径）。
- **吞错路径**：appendChain 注入抛错，run 完成、后续轮补写成功、无双写。

## 裁定记录

- 2026-10-30 用户裁定：resume 恢复口径取「全量回灌」（模型完整重建崩溃 run 的步骤认知）。
- 2026-10-30 用户裁定：整体方案取「A：轮边界增量入链 + seg 回灌兜底」。
