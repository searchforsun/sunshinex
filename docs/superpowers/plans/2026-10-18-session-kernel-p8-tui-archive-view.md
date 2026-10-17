# Plan 8:TUI 静态归档面收编内核——渲染层收敛终局(spec §3.1b/§6 收尾)

> 前置:P1-P5 已落地(P5 本工作区待提交)。P3 范围裁定「渲染面不迁移——内核条目视图的渲染收敛
> (GUI 同款)留给后续轮次」,本 plan 即该轮次。P4 已完成 GUI 侧(applyEvent 全仓单实现 + 快照游标
> 直供);本 plan 收 TUI 侧剩余面。P6(挂起表下沉/TuiRuntime 正名)、P7(执行入口统一)与本 plan
> 正交,无前置依赖。

## 0. 现状勘察(2026-10-18 代码实测)

### 0.1 已收编面(本 plan 不动)

| 面 | 状态 |
|---|---|
| 持久化 | kernel.pump → seg 行(v2 单档,P3) |
| 恢复 | reduceV2Rows → kernel.seed → entriesToChatItems(P3) |
| steer 队列 | kernel.steer*(P5) |
| GUI 转录投影 | applyEvent 全仓单实现 + 快照游标直供(P4 + 本 plan 前置提交) |

### 0.2 剩余残留(本 plan 范围)

**TUI 静态归档面仍从原始 SessionEvent 自建**,与内核并行构成同一事件流的第二投影:

| 原始事件分支 | 自建逻辑(session.ts) | 内核对应 |
|---|---|---|
| token/reasoning | appendLive + md 通道(流式渲染) | assistant/thinking 条 md 增量 |
| tool-call | pendingCalls 挂起行 + childPrompts 捕获 | tool 条入列(name/input/callId) |
| tool-result | 成对定格 + spawnCalls 压栈/archiveChild | tool 条回填(result,seg-update 发射) |
| done | finalText 推导 + pushedSource 前缀对齐 | mergeFinal 合并进开启段(seg-close 发射) |
| error | closeLive 折叠思考 | **不封段**(G14.51,done 必发) |
| notice / agent-message | pushMsg system 直上屏 | notice 条(seg-open 发射) |
| closeTask/error 收尾 | flushPendingCalls 补档 | pending 池留账(条目缺 result 可推导) |

### 0.3 已落地步(本 plan 提交内含)

1. **内核事件单分发散**:`applyKernelEvent` = persistKernelEvent(持久化) + archiveKernelEventToView
   (视图归档)单点;kernelSeedForRestore 换内核两态同源。
2. **thinking 折叠收编**:seg-close(thinking) → 折叠行出自内核条目(`Thought for ${seconds ?? 0}s`,
   与 entriesToChatItems 恢复面同形);closeLiveBlock 纯解散(不再产条目);error 旁路按旧行为就地
   折叠 + `foldedThinkingSeq` 登记位,seg-close 凭 seq 跳过防双档。
3. **快照游标直供**(GUI 侧收尾):SessionSnapshot 增 openRun/openSeg(内核访问器既有),GUI
   seedChatFromSnapshot 删除「末 run+尾随部分段」反推导块——推断只能近似,内核游标是精确权威。

## 1. 剩余面设计定版

### 1.1 tool 面(最大单面)

- `seg-open(tool)`(onKernelEvent 视图臂):挂起行入 pendingCalls(text=toolCallLine(entry.name,
  entry.input),与原始分支同构);spawn 的 input.prompt 捕获照迁。
- `seg-update(tool)`:result 在场 → 成对定格(callItem+resultItem 出自 entry 字段:callId/name/input/
  result.text/result.ok);entry.name==='spawn' → spawnCalls 压栈 + archiveChild。原始 tool-call/
  tool-result 两分支整删。
- `flushPendingCalls`:改从内核条目推导(replay() 中缺 result 的 tool 条;kernel.pending 私有——
  推导面公开 accessor 或按条目过滤,取『条目缺 result 即未回程』不变式)。closeTask/error 调用点不变。
- **漂移核对**(实施时逐条验):① toolCallLine 入参同源(entry.name/input vs e.text/payload.input);
  ② 孤儿 result 分支(payload.tool 独立成条)——seg-update 对 name=PLACEHOLDER 条的定格形态;
  ③ result 先行乱序(call 回填同条)——定格时机跟随 seg-update 即可。

### 1.2 assistant/done 对账面

- 关键事实:**通道 source 与内核条目 md 同源**(同为 token 增量拼接),正常流式下 seg-close 时
  二者相等——通道已是该段的渲染器,seal() 冲刷尾块即收敛,零对账。
- 分歧点仅二:①非流式单帧(done 终稿无 token 前缀);②终稿与流式前缀失配(协议异常防御)。
- 设计:seg-close(assistant) 处理**非 done 边界封段**(tool-call/notice 等 seal)——`entry.md ===
  pushedSource` 即 seal() 冲刷;不等时走前缀对齐(diff 入通道 pushFragment,复用 done 既有算法,
  提取公共函数)。
- done 分支保留原始对账:**planReplyNoArchive(规划轮不入档)与 model-error(错误文案不重复上屏)
  两个显示裁定只在 done 载荷可知**,且 pump 先行时 seg-close 先于 done 分支——用 `inDoneDispatch`
  分发旗标让 seg-close(assistant) 在 done 分发内让位。done 分支瘦身为:closeLive + 显示裁定 +
  refreshMetrics(finalText 推导删除,内核已合并)。

### 1.3 notice / agent-message / user 面

- `seg-open(notice)` → pushMsg('system', entry.md);原始 notice/agent-message 分支整删。
  **漂移已核对**:发射点(harness/index.ts:175、reactor.ts:356)恒带 text,payload.text 为冗余
  防御——entry.md==e.text==payload.text,无漂移。
- **user 不迁移**(裁定):submit 本地回显即显示面(含斜杠命令回显、Queued 提示行等 ephemeral 渲染
  归档),内核 user 条是转录面;journal 的 t:'user' 行是输入历史还原源——三面各司其职,非双档
  (转录归档唯一走内核)。
- error 条目:seg-open(error) → pushMsg('system', level='error');原始 error 分支保留通道清理/
  flushPendingCalls/指标事务(与 1.2 同理,error 面消息行归内核事件)。

### 1.4 统计面(独立前置调查,不在本 plan 实施)

TUI(usageBase+turnTotal 求和)与 GUI(turnTokensBase 水位差值)对同一 `usage.turnTotal` 载荷
采用**两种语义假设**(per-round 值 vs run 级单调累计)——至少一方口径有误。统一前需先钉 reactor
发射语义(每模型轮重置 or run 内累计),再定共享纯件(src/session/session-stats 同 taskboard/model
先例)。**未钉语义前不做统一**,防把错误口径扩散到两面。

## 2. 迁移序(每步全量 TUI 回归)

| 步 | 内容 | 状态 |
|---|---|---|
| S1 | 内核事件单分发散 + thinking 折叠收编 + 快照游标直供 | ✅ d90c82d |
| S2 | tool 面(seg-open/seg-update 视图臂 + flush 推导化 + 原始分支退役) | ✅ 本提交 |
| S3 | assistant/done 对账面(seg-close 非 done 封段 + done 分支瘦身) | ✅ 本提交(定版见 §2.1) |
| S4 | notice/agent-message/error 条目面 | ✅ 本提交 |

### 2.1 S3 实施定版(与 §1.2 设计差异)

**seg-close(assistant) 不做任何通道事务**(设计稿的「非 done 边界封段冲刷」取消)——真机实测:
done 前的 notice 沉淀行触发 seg-close(assistant) 时冲刷通道,done 终稿对账的 pushedSource 基线
即被清空,finalText 以空基线全量补推→**回复双份入档**(selfcheck 流式探针实锤)。通道冲刷挪至
seg-open(tool) 臂(工具行出现前清尾块,先冲刷后挂起);thinking 折叠臂补 closeLiveBlock(live
解散,原始边界分支退役后无人解散 live)。done 分支零改动(对账/规划轮/model-error 裁定原样)。

### 2.2 S2 实施定版(真机发现)

**spawn 两段式结果协议**:spawn 的完成通知(tool-result「xxx 完成」)在配对池已空时成为内核孤儿
条目(seg-open with result)——视图臂按旧孤儿口径定格:**call 行空文本**(非 toolCallLine,防再生
SPAWN 行)、不压 spawnCalls 关联栈(5 并行 spawn 乱序完成用例实锤,10≠5)。result 先行条此后
call 回填再发 seg-update,凭 archivedToolSeqs 去重只定格一次。flush 改 kernel.pendingTools()
推导(新增访问器,种子条目天然不含),登记 seq 防迟到回填二次定格。

### 2.3 内核侧配套

- `KernelEntry.result` 增 `full?: string`(全量观测随档,batch-runner payload.full)——TUI detail
  展开与恢复面(entriesToChatItems)同源,修复恢复面丢失全量观测的既有缺口;v2 seg-update 行
  随 result 对象自然携带。
- `SessionKernel.pendingTools()` 新增:未配对 tool 条视图(§1.1 flush 推导面)。

## 3. 回归面

- TUI 全量(session.*.test ~30 文件):thinking 折叠行格式/detail 断言、tool 配对/乱序/spawn 关联、
  done 终稿去重、error 折叠、rewind/fork/compact、resume 往返。
- daemon 全量(快照契约 + 游标字段)。
- GUI 全量(seedChatFromSnapshot 新签名 + streaming 竞态)。
