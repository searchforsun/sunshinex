# 设计档:内核条目渲染中立化(renderer-neutral entries,2026-10-18)

> 背景:工具行渲染修复(c0b30de)把 `● 名称 {输入JSON}\n⎿ 首行` 定为内核 md 形态——但 `●`/`⎿`
> 本身是 TUI 渲染记号,塞进内核仍是呈现语义漏进数据层。用户裁定:内核层返回的就是结构化数据
> (工具=输入 JSON+输出),不应有渲染记号;**内核条目重构为业界标准形态,不关心渲染层如何渲染**,
> 未来任何渲染层或纯 API 消费者拿到即可识别。状态:**设计定版,实施未开始(P11 单片)**。
> 修订(同日):并入三态标识(§7)——思考/工具/正文行的前中后态进条目模型,渲染层零推导。

## 1. 原则

1. **内核条目=结构化记录**:自由文本类(user/assistant/thinking/notice/error)md 承载**裸内容**
   (无任何前缀/记号/装饰);工具类(kind:'tool')**仅结构字段承载**(name/input/result),md 退役
   (恒空串)——字段已全量在场,md 是冗余的第二真相源,正是双源漂移的根;
2. **呈现记号归渲染层**:`●`(调用行符)/`⎿`(结果行符)/`>`(用户输入符)/首行截断/动词本地化
   (读取/查找…)/图标,全部由 TUI/GUI/未来渲染层自绘——内核零渲染词汇;
3. **业界标准形态**(对标 OpenAI/Anthropic message API 的 self-describing 条目):
   `{kind:'tool', name:'read', input:{path}, result:{text, ok}}`——无 md 也能完整识别;
   `{kind:'user', md:'goal'}`——裸文本即内容;
4. **单真相源**:工具条语义唯一载体=字段;user 内容唯一载体=md 裸文。上一轮「GUI 契约 md」
   与本轮裁定冲突,以本轮为准(渲染契约是渲染层内部事务)。

## 2. 内核条目模型(改后)

| kind | md | 结构字段 | 渲染层职责 |
|---|---|---|---|
| user | **裸文本**(去 `> `) | —(无 status,即时终态) | 绘输入符/气泡 |
| assistant | 裸正文(现状) | status(§7) | markdown |
| thinking | 裸思考文(现状) | status + seconds | 耗时摘要/展开 |
| tool | **恒空串** | name/input/result{ text, ok, full? } + status(§7) | 图标/动词本地化/目标字段/展开全文;三态+✓✗ |
| notice / error | 裸文本(现状) | —(无 status) | 级别着色/前缀(P10 已裁定归渲染面) |
| run | ''(现状) | status + meta | 状态行(Working…/Worked for) |

## 7. 三态标识(前/中/后,业界同构:pending → running → done)

> status 为条目/事件流协议字段(快照与事件流可携);**journal v3 不落 status**——落档恒终态
>(见 §3.2),挂起态只活在事件流与内核内存。

现状三态靠渲染层各自推导(工具行看结果占位符 `…`、正文/思考行拿 openSeg 游标比对、GUI
`executing = result === '…'` 残留)——渲染中立化后 md 退役,态必须进条目显式字段。

### 7.1 字段与词汇

`KernelEntry.status?: 'pending' | 'running' | 'done'`——缺省视作 done(即时终态行省略字段);
失败不设第四态:工具 `result.ok=false` 即失败面,渲染层绘 ✗(业界同构:completed/failed 由
ok 承载,status 只管生命周期)。

### 7.2 各 kind 生命周期

| kind | 前 pending | 中 running | 后 done |
|---|---|---|---|
| tool | call 发射即入列(批次**全批调用行先行发射**是既有事实,batch-runner:88,payload `status:'pending'`——串行批后位调用真实存在「已发射未执行」) | 执行起点 | result 到达(首行/全文随 result 字段) |
| assistant / thinking | ——(无前态:正文行出现即流式中,「前」由 run 行承载 Working…,业界同构) | 段开启(首 token/reasoning 增量) | 封段(done/边界/终稿合并) |
| run | —— | run 开启 | 收口(meta.endedTs;中断/失败经 meta.stopped) |
| user / notice / error | — | — | 即时(字段省略) |

### 7.3 执行起点信号(现管线缺口)

事件词汇现只有 call(pending)与 result(done)——**中态起点无事件**。补法(零新事件型):
batch-runner 执行起点对每个调用补发一次 `tool-call`(同 callId,payload `status:'running'`)
——kernel 按 callId 命中未配对 pending 槽走**幂等回填**(只升 status+补 name/input,不建新条,
既有乱序回填路径复用);tool-result payload 既有 `status:'failed'/'completed'` 同源透传。
TUI live 面同 callId 二次到达须幂等(callId 已在场只改态,不重行)——随 P11 片内改。

### 7.4 装载归一(journal v2)

assistant/thinking 段闭合才落档 → 档内恒 done(无态字段省略);tool 行落档于 call(带态)、
seg-update 收 done——**装载归一:有 result 即 done,无 result 的悬空 tool 行(daemon 重启即死)
归 `done`+`ok:false`**?否——悬空=执行体不存在了,归 **'error' 语义面**:渲染 ✗。裁定:悬空
tool 行 status='done' 且 result={text:'(interrupted)', ok:false}(与悬空 run 标 stopped 同径,
渲染层零特判);openRun/openSeg 游标保留为内核内部定位面(token 追加/G14.51 播种竞态),
渲染层态推导逐步退役改读 status。

### 7.5 渲染职责(三态 × 三行)

| 态 | 业界形态 | 本仓落点 |
|---|---|---|
| pending | 灰条/等待符,无 spinner | GUI 工具行灰态;TUI 调用行淡显 |
| running | spinner +「正在…」 | 既有 RUNNING_LABELS/Spinner 复用,数据源改 status |
| done | 折叠收口;✓/✗ 按 ok | 既有折叠分型复用 |

## 8. 子代理同构(spawn 即普通工具,用户裁定)

**spawn 条目=普通 tool 条目,零特判**——同一字段形态(name/input/result)、同一三态;同步
spawn(前台子代理)只是 running 时长长(工具结果=子代理结论行,结果到达即 done)。子代理
渲染与思考/工具/正文行**完全同构**:

1. **条目模型零异构**:内核本就按普通 tool 装配 spawn(无 spawn 分支),delegation-*/子代理
   事件流另轨零转录条目(G14.213 既有)——本设计固化此裁定:任何「子代理是特殊条目」的
   形态都不进内核;
2. **子代理自身转录同模型**:子事件流(payload.subagent 另轨)是同一条目模型+同一三态的
   一次实例化——子代理的思考/工具/正文行与前/中/后,和主链行完全同构;
3. **渲染层投影自由**:ChildPanel/Agents 卡/委派面板/SPAWN 展开转录,都是渲染层对另轨
   事件流与档的自选投影视图——存在与否、长什么样,条目模型不感知;
4. **渲染职责**:running 态=「分派子代理 xxx」长 spinner(委派面板可选叠加);done 折叠行
   =结论行(result.text);展开体=子代理转录全文(渲染层经其投影或档取数,非条目字段)——
   长输出走 result.full 既有观测通道。

## 3. 各层改动

### 3.1 内核(src/session/entry.ts)

- user 分支:`md: \`> ${text}\`` → `md: text`;
- tool 五装配点:`md: toolMd(...)` → `md: ''`;`toolMd` 函数删除(v2log 同步去引);
- **status 接线(§7)**:tool-call 按 payload.status 入态(pending 起步/running 幂等回填升级);
  tool-result 收 done;assistant/thinking 开启段 running、封段 done;run 开 running、收口 done
  (meta.stopped 保留);KernelEntry 增可选 status 字段随快照/…序列化;
- result 字段已是全量(text 全文+full 观测),首行截断是渲染职责——内核零改动。

### 3.2 journal v3(用户裁定:零兼容,读侧零归一)

条目模型变更=档格式变更:**会话档升版 v2 → v3**——渲染中立形态(tool md=''、user 裸文、
status 不落行)是 v3 的唯一世界,读侧**没有任何旧形态归一代码**(无兼容层;渲染层只接受
标准化协议数据):

- **写**:seg 行 tool `md:''`、user 裸文;seg-update 纯字段回填(不重算 md);**status 不落行**
  (journal 落档恒终态:assistant/thinking 闭合才落行;tool 行落档于 call、seg-update 收 done;
  挂起窗的行在档内即「无 result」);
- **读**:v3 行直读,零变换;**悬空 tool 行(无 seg-update 对位)补 `result:{text:'(interrupted)', ok:false}`**
  ——这是 v3 自身语义(渲染 ✗ 不永转),非兼容;
- **版本守卫**:daemon attach 与 TUI restore 仅认 `v:3`;v2 及更早一律 INVALID_ARG + purge 指引
  (dev 期旧档直接删除,session-kernel spec §5 既有裁定);`scripts/purge-legacy-sessions.mjs`
  扫描口径同步 `v≠3`;
- `src/session/v2log.ts` 正名 `seglog.ts`(`reduceV2Rows`→`reduceSegRows`、`V2RowLike`→`SegRowLike`)
  ——名实相副,读的就是 v3。

### 3.3 TUI(src/tui)

- commands-session entriesToChatItems:user 条剥 `> ` 防御分支删除(装载已归一);
  tool 条本就字段驱动(toolCallLine(name,input)+result.text)零改动;
- live 面零改动(pushMsg 原文/事件驱动 ToolRow);
- `●`/`⎿`/`▶` 记号在 TUI 各组件自绘处原地保留(它们本来就是渲染层的)。

### 3.4 GUI(gui/src)

- chat-reducer mapEntries:user 剥 `> ` 分支退役(内核已裸);tool 三字段直映已有(P4.1);
- ToolEntry:verbOf/resultOf/toolMdInfo 的 **md 解析退役**,改 entry 字段单源
  (name/input/result 皆直映字段;verb=name 本地化在 zhToolName);旧 md 兜底删除——
  字段恒在场(内核装配点全填,装载归一);
- 测试夹具更新:App.test/Chat.test 的 md-only tool 种子条改字段形态。

### 3.5 纯 API 消费者(未来)

GET snapshot 的 messages 即自描述 JSON:工具行无需任何渲染文档即可结构化呈现——本设计的验收
锚点之一。

## 4. 迁移与兼容(零兼容)

- **v3 取代 v2**:session-kernel spec §3.2 的「v2 单档」版本位由本 spec 升级——v2 档不迁移
  不归一,dev 期直接删除(purge 脚本 v≠3 扫描 + attach/restore 版本守卫拒载),与 v2 淘汰
  v1 同一裁定与同一脚本;
- GUI 上一轮(P4.1/c0b30de)的 toolMd JSON 嵌入随本设计移除——存在时长一天,无外部消费;
- 渲染层协议即 snapshot messages / 事件流的条目形态本身——标准化之外不存在第二条可读路径。

## 5. 测试

- kernel.test:user 裸文断言(`> 一`→`一`);tool 五装配点 md==='' 断言(替换全部 `●/⎿` 断言);
  **三态组**:call→pending、执行起点二次 call(同 callId)幂等升 running 不建新条、result→done、
  ok=false 失败面、段开 running/封段 done、装载归一(悬空 tool 行 done+ok=false);
- v2log.test:往返等价(live md=''/重放 md='';**status 不落行**断言);**v3 版本守卫**(v2 header
  拒载 + purge 口径);悬空 tool 行 interrupted 归一;**零旧形态归一用例(零兼容红线)**;
- TUI:restore 用例(v3 装载;v2 档拒载指引);tool 条字段渲染回归;live 面同 callId 二次到达
  幂等(不重行);
- GUI:chat-reducer(user 裸文直映/字段+status 直映);Chat.test 种子条三态渲染(pending 灰/
  running spinner 数据源/ done 折叠,夹具改字段+status 形态);App.test 夹具同步;
- 全量:daemon 套件 0 fail、GUI 0 fail、tsc 双端。

## 6. 风险

1. **md 消费者遗漏**:全仓 grep `verbOf|resultOf|toolMdInfo|startsWith('> ')` 兜底清点
   (实施时编译器+测试双兜底);
2. **旧档 visual 断档**:旧 v2 档 tool 行装载后靠字段渲染,与 live 零差异(字段 P2 起全量)——
   无断档;
3. **anchors/firstUser 面**:user 输入历史走 journal `t:'user'` 行(裸文既有),与 seg md 无涉。
