# SessionKernel 会话内核设计(方案 B 全量收敛)

- 日期:2026-10-17
- 状态:待评审
- 轮次:G14.213b(承接同日「转录持久化/段边界落档」临时修复,本轮将其下沉为内核单点)
- 裁定记录:用户确认「方案 B 全量收敛」+「不做旧档兼容(旧会话直接删除)」+「TUI/GUI 只做渲染,数据同源,唯一差异 = TUI 单会话单窗口 / GUI 多会话多标签」

---

## 1. 背景与问题

`SessionEvent` 流(types.ts 单点)离开运行时后有 **3 个消费者各自实现了同构的"下层"**:

| 职责 | TUI(tui/session.ts) | daemon(serve/session.ts + transcript.ts) | GUI(gui/chat-reducer.ts) |
|---|---|---|---|
| 转录投影(事件→条目) | ✅ 自建 | ✅ 自建(TranscriptCollector) | ✅ 自建(chat-reducer) |
| tool-call/result 配对 | ✅ pendingCalls FIFO | ✅ pending FIFO | ✅ 又写一遍 |
| runmeta/usage 投影 | ✅ 自建 | ✅ 自建 | ✅ 又一遍 |
| 持久化 | ✅ journal(ChatItem 面) | ✅(G14.213b 起临时 jsonl) | ❌ 无 |
| todos 推导 | ✅ journal todos | — | ✅ 从转录再推一遍 |

后果(本会话实测):

1. 流式中刷新浏览器 → 空窗(归档面曾只落终答;段边界落档已作为临时修复补在 serve 层);
2. daemon 重启/会话重开 → 内存转录清零(rg68 会话实测快照 0 条);
3. 同一份历史三种粒度/三种口径,双端渲染行为漂移(TUI 不丢、GUI 丢)。

对照样版:`taskboard/model` + `delegation/projection` 是单一纯 reducer 三端共享(gui/projection.ts re-export),从未出过此类问题——本设计把转录投影也收敛成同一种形态。

## 2. 目标与非目标

**目标**

- SessionEvent 的**唯一落档点**下沉到内核:事件泵单点驱动唯一转录 reducer,增量持久化;
- TUI/GUI 退化为纯渲染视图:打开会话 = `kernel.replay()`(历史) + `kernel.subscribe()`(增量);
- 表面(用户可见行为)零变化:双端渲染结果与现状一致;
- 元数据完整:段级条目携带完整 payload(见 §4 清单),GUI 渲染零推导。

**非目标**

- 不做旧会话/旧 journal 兼容(开发期,旧会话直接删除;提供 dev 清理脚本);
- 不做 token 级事件日志(段级聚合,量与兼容的平衡);
- 不改变 run 的执行生命周期(daemon 重启仍中止在途 run——恢复的是"历史显示",不是"运行续跑");
- **future(不在本轮)**:run 执行器独立进程化(执行与会话状态进程分离,重启可重连附身在途 run)。
- 不合并 TUI journal 与 kernel 日志两个物理文件(chain 上下文面与展示转录面职责分离)。

## 3. 架构

```
src/session/kernel.ts      SessionKernel(事件泵/投影/持久化/replay/subscribe)
src/session/entry.ts       KernelEntry 模型 + 纯 reducer(applyEvent)
src/harness,src/loop       运行面不动(事件语义/types.ts 不动)
src/tui/session.ts         渲染视图:窗口态+输入行+按键;转录=内核条目视图;journal 只写 chain 面
src/serve/session.ts       daemon 面:快照=kernel.replay();帧=内核增量;collector/journal-msg 面退役
gui/src/chat-reducer.ts    内核条目 → 视图条目的纯映射(配对/投影/删除)
```

### 3.1 事件泵(唯一)

`createRuntime`(现 tui/runtime.ts,迁移正名为内核装配点)的 onEvent 是唯一汇聚点。TUI 与 daemon 会话运行时都改为**内嵌 SessionKernel**,由 kernel 统一:

- 转录投影(唯一 reducer);
- 持久化(段边界即追加 v2 单会话档);
- board/delegation 投影(既有共享纯件原样移入);
- steer/queue 状态单点。

### 3.1b 公开事件词汇收缩(实质保障)

内核只向视图层发**段级事件**:`seg-open/seg-close(正文/思考段)`、`tool-call/tool-result`、`run-open/runmeta`、`user/notice/error`、`truncate`。`token/reasoning/usage/step/route/ctx` 收为**内核内部遥测**(不再出内核)——增量拼接、配对、统计从此不是视图层的事务,三份转录投影失去产生的土壤。

### 3.2 唯一会话档(`<数据目录>/sessions/<id>.jsonl`,格式 v2)

**单文件单写者**:kernel 事件泵是唯一写者,一个会话一个文件;三个读面共享同档——GUI 转录重放(seg 行)、TUI/上下文恢复(chain 行 + compact)、参数快照(model/todos/view)。不再存在第二个 jsonl(G14.213b 的 transcript.jsonl 与旧 journal 均由本档取代,双写双读消除)。

行类型与读面:

| 行 | 写入时机 | 读面 |
|---|---|---|
| `{"t":"seg",…}` | 段边界(转录段闭合) | GUI/TUI 转录重放 |
| `{"t":"chain","step":{…}}` | 链步进(上下文) | restoreSession(TUI resume/重开) |
| `{"t":"runmeta",…}` | run 收尾 | run 条统计/Worked 行 |
| `{"t":"compact",…}` | 压缩发生 | 上下文恢复 |
| `{"t":"model"/"todos",…}` | 参数变更 | TUI/会话参数快照(view 行=渲染态出档,TUI 本地自存) |
| `{"t":"truncate","upToSeq":n}` | rewind/compact | 全读面截断 |

追加式段级行,重放即重建转录:

```
{"t":"seg","kind":"user","md":"> 目标","ts":...}
{"t":"seg","kind":"assistant","md":"正文段","ts":...}
{"t":"seg","kind":"tool","md":"● read src/a.ts","callId":"c1","name":"read","input":{...},"ts":...}
{"t":"seg","kind":"tool","callId":"c1","result":{"text":"ok","ok":true},"ts":...}   // 回执吸附语义,重放时回填
{"t":"seg","kind":"thinking","md":"…","seconds":6,"ts":...}
{"t":"run-open","ts":...}
{"t":"runmeta","seconds":14,"steps":3,"runSteps":3,"tokens":12000,"cacheTokens":0,"endedTs":...,"stopped":false,"changes":[...]}
{"t":"truncate","upToSeq":12}        // rewind/compact:重放时视图截断到该位
{"t":"seg","kind":"notice","md":"…","ts":...}
```

要点:

- **token 增量不落日志**(内存聚合,段边界/收尾落一行)——量可控;
- 回执独立成行、重放回填:与"call 先到/result 先到"的乱序真实形态一致;
- `truncate` 行承载 rewind/compact 的视图截断(链面照旧回退,两轨语义对齐);
- 快照即"逐行 apply 后的投影态"。

### 3.3 条目模型(元数据完整性清单)

```ts
interface KernelEntry {
  seq: number; ts: number;
  kind: 'user' | 'assistant' | 'tool' | 'thinking' | 'run' | 'notice' | 'error';
  md: string;
  callId?: string; name?: string; input?: Record<string, unknown>;   // 工具 input 全量
  result?: { text: string; ok: boolean };
  seconds?: number;                                                   // thinking
  meta?: RunMeta;                                                     // run(全字段)
}
```

`streaming` 不入模型:段开启即流式中,由内核派生(公开事件 `seg-open/seg-close` 显式承载)。

GUI 渲染需求 → 内核携带对照(全部随档,渲染端零推导):

| 渲染需求 | 内核携带 |
|---|---|
| 工具行折叠/展开/两字动词/图标 | kind=tool + name + input 全量 |
| write 展开双列 diff | callId + input.path(fetchDiff 按 callId 拉) |
| spawn 行链接 → 子代理页 | label + agentTitle |
| ask_question 挂起卡 | question/options/allowCustom/pid |
| todo_write 三态清单 | items[](text/status) |
| create_task/task_wait 链接+任务名 | taskId/title/回执文本 |
| run 行计时/统计/停止/变更文件 | RunMeta 全字段 |
| 思考行计时 | thinking 秒数 |
| 流式光标/「正在写入…」执行中标签 | streaming 标志 + 段闭合语义 |

原则:**daemon 现在泵出的每个事件的 payload 原样进档;上游缺的信息先补事件,不在渲染层自己编。**

### 3.4 会话级快照字段

标题/模式/模型/effort/status/lastSeq/queued/pending(approval+ask)/board/delegations/team/ctx——照旧由 daemon 会话状态暴露(snapshotResponse 字段不删),与 kernel 转录日志分离。

## 4. 审批/提问挂起下沉内核

pending 表(approval/ask)从 daemon-wire 层资产**下沉为内核会话状态**(挂起是会话事件,不随连接生灭)——daemon 保留网络寻址与广播(帧形态不变,多客户端重连不丢挂起)。GUI/TUI 的挂起卡渲染照旧读内核态。

## 4b. 旧 journal 退役

v2 单档取代旧 `<id>.jsonl` journal(其 msg/chain/runmeta/compact/model/todos/view 各面全部由 v2 行型承载)。旧文件**不做兼容**:dev 阶段删除旧会话档(§5 清理脚本),daemon 对无法识别的格式忽略该会话。

打开会话的装载序(单文件双读面):

1. 逐行 apply:seg/runmeta/truncate → 转录投影;chain/compact → 上下文恢复载荷(`restoreSession`);model/todos/view → 参数快照;
2. 转录投影态 = snapshot.messages;上下文载荷 = 首个 run 前 `restoreSession`。

## 5. 兼容策略(无兼容)

- 开发期:**旧会话直接删除**。dev 脚本 `scripts/purge-legacy-sessions.ts`:扫描各 dataDir/sessions 下旧格式档(首行非 v2 header 的 `.jsonl`)列出并 `--delete` 删除;
- daemon 对无法识别的旧档:忽略该会话(不 404 轰炸);
- v2 为唯一格式,单文件单写者。

## 6. 迁移序(每阶段独立回归)

| 阶段 | 内容 | 回归 |
|---|---|---|
| P1 | 内核模块(entry 模型+reducer+SessionKernel)落地;三份投影的既有用例合并为参数化单测 | 新增单测全绿 |
| P2 | daemon 接入:SessionRuntime 内嵌 kernel 并成为 v2 单档唯一写者;collector/G14.213b 临时 jsonl/旧 journal 写面退役;快照=kernel.replay | daemon 全量 |
| P3 | TUI 接入:消息区=内核条目视图;resume/重开读面切 v2(旧档已删);rewind/fork/compact 回归 | TUI 全量 |
| P4 | GUI:chat-reducer 瘦身为内核条目→视图条目映射;旧会话清理脚本 | GUI 全量 |

## 7. 测试策略

- 内核 reducer:三份投影实现的既有用例合并参数化(token 段聚合/配对乱序/runmeta/思考秒/notice/kind 扩/上限裁剪……);
- 持久化:落档-重放往返(含 truncate 行);坏档容错;
- TUI:resume(含旧档删除后的新格式)、rewind/fork/compact;
- daemon:snapshot/attach/重连补发(512 帧环+快照基线);
- GUI:158 用例回归(reducer 映射断言随条目模型更新)。
- 词汇收缩:视图层不再收到 token 级事件(内核遥测面用例)。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 三份投影的隐性语义差异 | 用例合并为参数化表(差异显式成行),差异不可调和处以上报字段区分 |
| rewind/fork/compact 与 kernel truncate 对齐 | truncate 行 + 链位点同源写入;P3 单独回归 |
| 段聚合丢 token 尾巴 | done/boundary 双保险 flush(沿用 G14.213 语义并入 reducer) |
| v2 单档格式一次到位的回归面 | P3 全量 TUI resume/rewind/fork/compact 用例;旧档物理删除不并存 |
| 旧档残留干扰 dev | 清理脚本 + daemon 忽略未知格式 |

## 11. GUI 单进程化(二期优化,要写明的方向)

现状:GUI = 浏览器/Vite 前端 ⇄ daemon(HTTP+WS,双进程)——会话状态在 daemon,前端经 snapshot+frames 消费,序列化/认证/重连都是边界成本。

**二期方向(对标 Codex 单进程会话形态)**:GUI 桌面壳**直接内嵌 SessionKernel**——进程内直调 `replay()/subscribe()`,零 HTTP/WS/零序列化;多会话多标签由 GUI 自持(kernel 按 id 多实例);daemon-wire 层退役。

- 可行性依据:P1-P4 完成后,kernel 与传输已解耦——单进程化只是把「WS 适配器」换成「进程内适配器」,视图层零改动(数据同源原则的直接收益);
- 影响面:多客户端同时连接能力消失(单用户桌面场景可接受)、token 认证面消失;
- 定位:**二期优化**。一期(本 spec P1-P4+队列)保持 daemon 形态交付,内核边界即为此预留。

## 12. 等待队列(steer)内核化与双端对齐

现状问题:队列状态在 `SteeringChannel`(harness 内存 FIFO)——**不持久化**(daemon 重启/会话重开即丢);变更无事件(GUI 靠快照轮询回显,TUI 无感知);TUI 无队列管理面(仅入队+计数);GUI 缺编辑。

### 11.1 内核化

- **状态单点**:steer 队列入内核(`items: [{seq, text, front}]`;front=插入发送,步边界注入当前轮);
- **持久化**:v2 档追加 `{"t":"steer","items":[{seq,text,front},…]}` 行——每次变更整列重写一行(行数小,append-only 语义保持,重放取末行为准);会话打开/重载即恢复队列;
- **事件**:每次变更广播 `queue` 事件(payload=全量列表)——TUI/GUI 实时识别,不再依赖快照轮询;
- **操作面(内核方法,全部触发持久化+事件)**:enqueue(text)/editAt(seq,text)/move(from,to)/moveToFront(seq)/removeAt(seq)/takePending()(轮收束补跑语义不变)。

### 11.2 端点

`POST /session/:id/steer/edit {seq, text}`(新增);既有 steer/cancel/move/front 照旧。

### 11.3 TUI:Ctrl+Q 队列管理面板(模态,与 GUI 对齐)

- **查看**:全量条目(序号+front 标记+文本);
- **编辑**:选中项 E → 内联编辑 → steer/edit;
- **删除**:选中项 D → removeAt;
- **插入**:I → 输入新条目 → enqueue(运行中随时可插);
- **直接发送**:N → 取该条 + 中断当前轮 + 立即提交为新一轮(GUI pauseAndSend 同语义);
- **排序**:Ctrl+↑/Ctrl+↓ 移动 → steer/move;
- **Esc** 关闭;退役:TUI 被动的队列识别(仅 pending 计数/静默丢弃)升级为管理面;「运行中提交自动入队」保留(=插入路径之一)。

### 11.4 GUI 对齐

- `queue` 事件 → queued chips 实时回显(替代部分快照轮询);
- steer 行增**编辑钮**(内联编辑 → steer/edit);
- 既有拖拽排序/Now 直接发送/撤回不变。

### 11.5 测试

持久化往返(变更→重载恢复);`queue` 事件广播;TUI 面板六操作用例;GUI 编辑用例;轮收束补跑语义回归。

## 10. 架构再优化定版清单(G14.213b 评审收敛)

1. 公开事件词汇收缩:段级事件出内核,流内遥测内化(§3.1b);
2. `view` 渲染态出会话档,TUI 本地自存;
3. `streaming` 改内核派生态,条目模型不存;
4. 审批/提问挂起表下沉内核(§4);
5. `TuiRuntime` 正名迁移:装配单点随内核落位;
6. 退役清单:TranscriptCollector、G14.213b transcript.jsonl、journal msg 面、GUI chat-reducer 投影段——P2-P4 分批出清,不留兼容层;
7. **future**:run 执行器独立进程化(重启不中止在途 run);Reactor 单发/Loop 模板双执行路径统一入口;
8. **二期**:GUI 单进程化(§11,去前后端分离,direct-embed kernel)——一期保持 daemon 形态。
