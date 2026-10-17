# Plan 4:SessionKernel GUI 接入(第三投影退役,P4)

- Spec:docs/superpowers/specs/2026-10-17-session-kernel-design.md(§3.1b/§6 P4)
- 前置:P1(aa58bf8)/P2(a3f5591)/P3(2445aa4);snapshot.messages 已是内核条目(P2)
- 目标:gui/chat-reducer.ts 的事件投影逻辑删除,GUI 改为**本地内嵌同一内核 reducer**(喂 WS 原始帧,零 wire 改动)+ 纯视图映射;快照装载=内核 seed。三份投影的最后一层收敛——applyEvent 从此全仓单实现。
- 明确不做:wire 协议不变(帧仍原始 SessionEvent,§3.1b 的「内核只发段级事件上 wire」留 GUI 单进程化二期一并裁);board/delegation 投影、todos 推导、pending 卡面不动;status-bar 计数器(tokens/steps/cache 水位)保留在视图层(会话统计非转录)。

## 勘察结论(计划依据的代码事实)

- ChatState 经 useState 纯 reducer 消费(applyChatEvent/seedChatFromSnapshot/appendUserMessage 三入口,use-session-events/use-chat-submit/use-queue/use-chat-fold 四 hook);hook 会派发**合成事件**(`{type:'error'}` 错误行)——合成事件直入内核即自然成立。
- 视图层两处从 entry.key 解码 callId(`tool:${callId}` 编码,Chat.tsx/use-chat-derived 的 fetchDiff 寻址)——内核条目 callId 直挂,编码解码整个退役。
- Chat.tsx 消费 stepsBase/tokensBase(live 轮「本轮」口径减数)——runBases 视图层记账保留。
- delegation-started/ended 行 GUI 今天仍渲染(`✻ label status`)——内核按 G14.213 不产条目,P4 起主聊天流不再显示(与用户裁定对齐,委派可见性归委派徽标/Agents 页)。
- notice 显示过滤(G14.90 ask 回执/G14.106 memory 索引)是显示裁定——内核忠实归档,映射层过滤(⑥b 钉板语义)。

## 改动清单

### 1. gui/chat-reducer.ts 重写

- `ChatState = { k: KernelState; entries: ChatEntry[]; status; tokens; steps; cacheTokens; turnTokensBase; turnCacheBase; runBases: Record<number, {steps; tokens}> }`——entries 保持**物化**(消费方零改);k 为内核态(纯对象,applyEvent 直驱)。
- `applyChatEvent(s, e)`:`applyEvent(s.k, e)` + 计数器 switch(usage 轮增量/step +1/model-start 水位重置+runBase 记账/done→idle)→ 重映射 entries。物化映射 `mapEntries(k, runBases)`:key=`k${seq}`;streaming=openSeg/openRun 派生;notice 过滤(ask 回执/memory 索引);run meta→view 字段(steps=runSteps??steps/tokens/seconds/stopped/endedTs/changes)+open run 注入 runBases;delegation 零条目(内核语义)。
- `seedChatFromSnapshot(messages, status)`:applySeed 快照条目(已是内核条目形)+ meta 求和计器(既有逻辑)+ **partial-run streaming 派生保留**(G14.51:running 且末 run 无 meta → 末 run+尾随部分段标流式)。
- `appendUserMessage`:合成 `user` 事件入核(本地回显=resync 前占位,语义不变)。
- 删除:tool key 编码配对池/sealStreaming/sealThinking/sealRun/onToken/onDone/onToolCall/onToolResult/mergeFinal/delegation 行/verbOf/resultOf/uniqueKey——配对、段聚合、终稿合并、计秒全数交内核。
- ChatEntry/SnapshotTranscriptEntry 视图契约类型不动。

### 2. 视图层 key 解码退役

- Chat.tsx / use-chat-derived.ts:callId 从 `entry.callId` 直取(`tool:` key 前缀解析删除);stepsBase/tokensBase 改读 runBases(经 entries 注入,消费形不变)。

### 3. 旧会话清理脚本

- P2 已落地(scripts/purge-legacy-sessions.mjs)——本项销账。

## 测试

- chat-reducer.test.ts 38 例按内核语义重写:流式聚合/配对乱序/done 合并/thinking 秒/runmeta/run 停止态等断言经 applyChatEvent 保持(行为面等价);key 断言改 `k<seq>`;delegation 行用例改「零条目」;usage/step 计器与 partial-seed 用例保留。
- App.test.tsx / e2e.test.ts 守护回归(333 全量);daemon 套件守护(零接触)。

## 验收(2026-10-17 实测)

- [x] chat-reducer.ts 重写:内核态(k: KernelState)+物化视图映射+计器保留(usage 轮水位/step/done 步数透传);seed=applySeed+**内核游标恢复**(G14.51 partial-run:openRun/openSeg 直还——流式派生归内核,事后贴标退役);本地回显=合成 user 事件入核;子代理事件零条目零计数(G8d 双保险);零变化透传(空边界事件免重渲染)。
- [x] 物化映射 WeakMap 身份保持:token 逐 delta 重映射只换变动条目引用,未变行 memo 不破。
- [x] key 统一 `k<seq>`;callId 直挂条目——Chat.tsx/use-chat-derived 的 `tool:` key 编码解码退役;streaming 键恒在场(键值 undefined,消费面 toMatchObject/条件渲染两相宜)。
- [x] delegation 状态行主聊天流消失(G14.213 对齐;App/Chat 两处用例改零渲染断言);notice 显示过滤保留在映射层。
- [x] 回归:GUI 333 全绿(reducer 38 例按内核语义重写:delegation 零条目×3/key 方案/子代理计数守卫);daemon 1843 过 0 挂(守护);tsc 双侧净。
- [x] 清理脚本销账:P2 已落地(scripts/purge-legacy-sessions.mjs)。
- **applyEvent 全仓单实现达成**:src/session/entry.ts 是唯一「SessionEvent → 转录条目」投影,daemon/TUI/GUI 三端同源。
