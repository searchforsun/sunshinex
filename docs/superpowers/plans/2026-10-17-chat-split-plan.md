# D32 Chat.tsx 上帝组件拆分实施计划（立项方案）

> 状态：**主体已清（批A/批A′/批B 数据部/批C-1…C-5 共九批落库，Chat.tsx 3324→1739，−48%）**；
> 第六批全清（第二十六轮 F-1..F-6 + 第二十七轮 F-7a-d,Chat.tsx 1737→768,−56% 过 ≤800
> 验收线:ComposerPills/SteerQueue/AskDock/ChatTopbar/MessageList 五渲染件 + derived/scroll/
> fold/title/session-info/submit/composer-side 七 hooks + chat-types 类型面;DOM 面/行为零变
> 化）。filePal UI 部
> 留置裁定（composer 键链域，见台账第二十轮）。进度详见 `docs/TECH-DEBT-LOG.md` D32 行与
> 第十三~二十一轮台账行。
> 台账：`docs/TECH-DEBT-LOG.md` D32（H·重，2026-10-17 清理轮普查登记）。

## 目标与锚点

`gui/src/pages/Chat.tsx` 3300+ 行、91 个 hooks（Chat() 组件本体约 1500 行）混杂
状态机/渲染/命令面板/差异条多职责。拆分为**行为零变化**的渲染件与 hooks 件，
公开导出面（TodoBatch、expandFileRefs、tokenDisplayText 等被 App/测试消费的符号）
保持原路径再导出，消费方零迁移。

**锚点**：gui 全量单测 + e2e（322+ 例，含 Chat.test/App.test/e2e.test 19 组）+
`pnpm --dir gui test` exit 0 门禁；拆分期间每批全绿后交付（D31 四批同 pattern）。

## 现状职责块（落库后需重盘点校准）

| 块 | 现位 | 目标 |
|---|---|---|
| 工具条目渲染器 ToolEntryView | 组件内约 480 行 | `pages/chat/ToolEntry.tsx` |
| 运行尾部操作条 RunChangesBar / run footer | 文件内组件 | `pages/chat/RunFooter.tsx` |
| 命令面板/技能命令数据面（cmdData/skillCmds） | Chat() 内 state+effect | `pages/chat/use-command-palette.ts` |
| 队列面（queued/pauseAndSend/续发泵） | Chat() 内 | `pages/chat/use-queue.ts` |
| 会话事件消费（onEvent 分流/回显/挂起卡重建） | Chat() 内 effect 簇 | `pages/chat/use-session-events.ts` |
| 文件面板（@ 提及/loadWorkspaceFiles/filesCacheRef） | Chat() 内 | `pages/chat/use-file-palette.ts` |
| token 显形/输入高亮 | 已部分共享导出 | 维持现位，落库后复核 |

拆分模式沿 D17（控制器薄委托保公开 API）与 D31（io/deps 注入、叶子模块）：
自定义 hook 返回内聚 state+action 包，Chat() 保留编排与 JSX 骨架。

## 批序（每批一步全绿）

1. **批A 渲染件**：ToolEntryView → ToolEntry.tsx（最大单件，纯渲染+回调 props）。
2. **批B hooks 三件**：use-command-palette / use-queue / use-file-palette。
3. **批C 事件簇**：use-session-events（onEvent 分流最大 effect 群）+ RunFooter。
4. **批D 收尾**：残留导出再导出归位、死代码扫（noUnused 已门禁）、行数复核。

## 验收标准

- `pnpm --dir gui test` 全绿且测试文件零改动（断言面不迁移）；
- Chat.tsx ≤ 800 行（编排+JSX 骨架），单件 ≤ 500 行；
- 公开符号消费方（App.tsx、projection、tests）import 路径零变化；
- 前缀缓存无关（渲染层拆分零触提示词面——CLAUDE §11 不适用本批）。

## 风险与既定裁定

- G14.211 在途（token 显形/思考卡）与本拆分同文件——**必须落库后再动刀**，
  落库前本计划仅立项不执行；
- e2e 静态挂载组对 DOM 结构敏感：渲染件搬运保持 DOM 树与 className 逐字节不变
  （搬移不重排），e2e 19 组为差分门禁；
- 拆分期间禁顺手改行为；发现缺陷登记台账不顺手修（只还债纪律）。

## 附录:Chat.tsx 模块头叙事史(批F-7d 自源文件迁出存档;现役口径见 Chat.tsx 头注短版)

/**
 * T4δ Chat 页(G3 对话面会话化迁移):App 暂留的 G3 单页对话面(reducer/md 渲染/输入分流/Stop/
 * 状态条/播种门语义)整体迁入本组件,改会话维——动作走 :id(sessionSubmit/sessionSteer/
 * sessionInterrupt),基线经 conn.sessionSnapshot(sessionId) 播种;本地态(reducer 投影/输入/
 * 播种门)随组件销毁,App 以 key={sessionId} 挂载保证两会话先后打开互不串扰(无跨会话残留,
 * 不断连重连——连接生命周期在 App 壳)。
 *
 * 事件面经 App 壳转投(连接回调在 createConnection 装配时固定,Chat 无法自接):App 的 onEvent
 * 三参按 sessionRef 过滤本会话后经 sinkRef 投 `sink.on(e, seq)`;onReset(首连/重连同路径)投
 * `sink.reset()` → 本会话重播种(既有播种门语义:基线在途输入禁用,防本地回显被种子整替)。
 *
 * 每会话种子竞态缓冲(T3 收口):连接层抬基线(sessionSnapshot 应答抬高 lastSeqBySession)只在
 * HTTP 应答落定之后——seed 在途窗内到达的本会话帧已过连接层 seq 门,若直投 reducer 会被随后的
 * 种子整替清掉(丢帧),先缓冲;种子落定后以 seq ≤ snapshot.lastSeq 过滤(≤ 切割序者种子已含,
 * 再投即双应用)再依序投 reducer。G3 T3 连接层的单会话 armed/pending 语义在页内复刻(连接层
 * 已无 armed,页面自缓冲;reseed 时清缓冲重来,unmount 随组件销毁)。
 *
 * G4 挂起卡片区(转录上方固定区):App 的 onApproval/onAsk 经 sessionRef 过滤本会话后经 sink
 * 投递——ApprovalCard(kind/subject/reason + Allow/Deny/Always)/AskCard(question + 选项单/多选
 * + customIndex 自由输入 + Submit/Dismiss);回执走 conn.replyApproval/replyAsk(pid 契约:寻址
 * 用帧顶层 pid,非 req.id);卡列表 pid 管理——回执成功移,失败(404 已决)也移(不悬挂)。
 * 连接级 reset(重连)卡保留(daemon 未决重发被连接层 pid 去重);会话 reset 帧(resetSession)
 * 清卡(daemon 已 deny/dismissed 回填全部挂起)+清投影重播种。
 * G5 增两面:①顶栏 Delete(confirm → conn.deleteSession(sessionId) → onBack 回首页——Home
 * 行 Delete 以 journal id 寻址恒 404 退役,daemon 会话 id 才是回收端点的有效寻址);②status
 * 转 idle 清卡(effect 观察投影状态:run 收束 = daemon 已对本 run 挂起 deny 回填,本地卡随之
 * 清;reseed 后快照 status=idle 亦触发);③onSeeded(快照落定回调,App 借此取 snapshot.team
 * 存 App 态——事件流无 teammate 面,Board 侧栏的唯一来源)。
 * G7 增三面:①reseed 挂起卡重建——snapshot.pending 逐项 addCard({pid,kind,req})(req 透传
 * 落地,刷新/重连后卡内容可恢复;连接层 pid 去重拦了 daemon 重发帧,快照是唯一来源);②reseed
 * 时 toolInputs 清(旧投影 callId 配对残留不污染新投影);③write 条目展开接 conn.fetchDiff
 * (old/new 双列;404/失败退单列现内容)。unmount cleanup 增 seedGenRef++(G6 终审首优先):
 * 在途快照应答经 gen 失配早退,防陈旧 onSeeded 污染 App 态。
 * G8d T5 交互清单:①输入面 textarea 自增高(rows 随换行数 1-6 派生;Enter 提交 preventDefault,
 * Shift+Enter 换行走默认);②流式条末挂 span.sx-stream-cursor(闪灭动画在 app.css 特批小段);
 * ③状态条 tokens/steps 改图标+数字组(sx-stat 组类名+lucide Coins/Footprints,样式面归 G8e)。
 * G9 B3b(spec docs/superpowers/specs/2026-10-08-codex-desktop-1to1-design.md §3):用户条目
 * UserEntryView(memo)右对齐胶囊+hover 浮现复制(剥 `> ` 前缀写剪贴板,失败 1.5s 示「未复制」);
 * 条目按日分组(groupEntriesByDay 纯投影)跨日插居中日期分隔——每日组顶部一条,与 Codex 实机同形。
 */
