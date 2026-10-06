# 5B GUI v1 设计规格(daemon + Web UI)

- **日期**:2026-10-06
- **状态**:设计定稿,待评审,未实施
- **来源**:设计对话(三假设经用户「继续」放行:壳路线 daemon+Web 先行 / 协议 SessionEvent 直通 / 看板并入 v1)
- **关联**:`docs/ROADMAP.md`(阶段五 5B)、`docs/superpowers/specs/2026-10-04-multi-agent-orchestration-design.md`(§10.4 GUI 投影三边界、§13 P3)、`src/tui/runtime.ts:44-46`(daemon 接缝预留注释)
- **定位**:ROADMAP 5B「GUI 设计规格(复用 SessionEvents 事件面与 asker 契约,三面同源)」的正式落地件;编排 spec P3 的验收载体

---

## 0. 背景与定位

- 事件面地基已全部就绪:P0 起建立的 SessionEvent 公共事件面(delegation/task/gate/agent-message 词汇齐备)、AskUserSeam 三面同源(CLI=TTY / TUI=问询管线 / headless=dismissed)、taskboard 与 delegation 的**纯函数投影 reducer**(零 TUI 依赖,可直接在浏览器运行)。
- 已知耦合债(P0 调查确立):TuiState 的 ChatItem 带 `ansi` 预渲染字符串、归档回放是序列化文本行——**GUI 不复用 TuiState**,从事件流与 journal 原文自行派生视图(spec 编排 §10.4 边界 2 的兑现)。
- `TuiRuntime` 是唯一运行时接缝(runtime.ts:44-46 注释:「GUI 阶段如需隔离可换 daemon 实现同契约」)——本 spec 把它 daemon 化,**不新建旁路**。

## 1. 目标与非目标

### 1.1 目标(v1)

1. **`sunshinex serve`**:HTTP/WS daemon,同进程装配 `createRuntime`(与 TUI 同一装配单点),暴露会话控制与事件流。
2. **四页面**:对话页(转录/流式/提交/中断/steering)、审批与问询卡、任务看板(dependsOn→DAG 自动推导、teammate 侧栏、gate 审批)、代码预览+diff。
3. **三面同源第四面**:协议 = SessionEvent 原样 JSON 直通 + asker/approval 序列化;零 GUI 专用中间事件词汇。
4. **会话持久**:刷新/重连经 `GET /snapshot` 恢复归档转录与投影;`--continue`/`--resume <id>` 启动续接既有会话。

### 1.2 非目标(v1 明确出范围)

- 桌面壳(Tauri/Electron)、系统托盘、全局快捷键、三平台安装包——**壳批次后置独立立项**(ROADMAP 随壳交付);
- 多窗口同屏并行渲染多会话(v1 一次激活一个;daemon 侧多会话并发运行、创建/切换/恢复在 v1 内——2026-10-06 会话中心修正);
- 板写操作经 GUI(create_task 等工具调用面板)——v1 看板只读 + gate 审批;
- 管理面(记忆/技能/插件管理)、双端实时同步配置;
- 远程暴露(仅回环 + token)。

## 2. 术语

| 术语 | 定义 |
|---|---|
| **daemon** | `sunshinex serve` 进程:**会话管理器**——持有会话注册表,按会话装配 Harness/TuiRuntime,暴露 HTTP/WS 端点(2026-10-06 会话中心修正,原「启动绑定单 root」形态降级为 `--root` 预选) |
| **工作区(workspace)** | 一个工作目录(root)——数据按 `resolveDataDir(root)` 的 slug 隔离(journal/teams/记忆各归各) |
| **会话(session)** | 对话单元:`{id, root, runtime, 事件泵/影子投影/转录, journal}`;创建时选目录,attach 时从 journal 恢复;同一工作区可多会话 |
| **激活会话(active)** | UI 当前查看的会话;后台会话可继续运行(teammate/任务板本就工作区级存活) |
| **下行帧** | WS 服务端→浏览器的封装:`{kind:'event', sessionId, e: SessionEvent}` / `{kind:'approval', sessionId, req}` / `{kind:'ask', sessionId, req}`(会话中心修正:帧挂会话维) |
| **投影** | 浏览器侧从 SessionEvent 流派生状态的纯函数层(复用 taskboard/delegation 既有 reducer + 新 chat reducer) |
| **快照** | `GET /snapshot` 的启动补发:journal 重建的归档转录 + 当前板/委派投影 + 会话元信息 |
| **回执挂起表** | daemon 内 approval/ask 的 Promise 登记(id → resolve),HTTP 回执驱动 |

## 3. 总体架构

```
浏览器(gui/ 子包:React 18 + Vite)              sunshinex 主仓
┌──────────────────────────┐                  ┌────────────────────────────────────┐
│ 首页(工作区/会话列表+新建) │  WS 单向下行事件   │ sunshinex serve(daemon=会话管理器)  │
│ 连接层(WS/HTTP/token)     │◄────────────────│  ├ sessions: Map<id, SessionRuntime>│
│ 投影层(纯函数 reducer)     │                  │  │   ├ createRuntime(按会话 root) │
│   ├ chat reducer(新)      │  HTTP 控制面      │  │   ├ 事件泵(环形缓冲,帧挂 sessionId)│
│   ├ applyBoardEvent(复用) │◄───────────────►│  │   └ 影子投影/转录/journal       │
│   └ applyDelegation(复用) │  静态资源 GET     │  ├ 工作区注册表(扫 projectsRoot)   │
│ 页面层(首页+四页)          │                  │  └ 静态服务 dist-gui                │
└──────────────────────────┘                  └────────────────────────────────────┘
```

- **daemon 零 harness 内部改动**:全部经 `TuiRuntimeOpts` 既有接缝(onEvent/onAskUser/onApproval/onTodos)与 `harness` 公开面(steering/tasks/taskboard/security);每个 SessionRuntime 一个 Harness(按会话 root 经 buildHarness 装配)。
- **事件泵(每会话一个)**:onEvent 回调 → 广播(帧挂 sessionId)至全部 WS 连接 + 写入该会话有界环形缓冲(重连补发窗口,缺省 512 条;更早历史走 snapshot)。
- **`--root` CLI 参数降级为「启动即预选工作区」**(无头/开发场景保旧形态;缺省无预选,GUI 从首页新建)。

## 4. 协议层

### 4.1 HTTP 控制面(全部 POST 除列示)

| 端点 | 语义 |
|---|---|
| `GET /workspaces` | 工作区清单(扫 projectsRoot 的 slug 目录,带 mtime 排序)——首页左栏 |
| `GET /sessions?root=` | 该工作区的 journal 会话清单(id/mtime/首行摘要)——首页右栏 |
| `GET /dirpicker?path=` | 服务端目录浏览(列子目录;起始家目录)——新建会话的目录选择器(浏览器无绝对路径选取 API) |
| `POST /session/new` `{root}` | **创建会话**(按 root 装配 SessionRuntime;返回 sessionId) |
| `POST /session/:id/attach` `{journalId}` | 恢复历史会话(journal 链回放重建 ContextManager) |
| `POST /session/:id/submit` `{goal}` | 提交任务(经该会话 runtime.runTask) |
| `POST /session/:id/steer` `{text}` | 运行中穿插(→ 该会话 harness.steering) |
| `POST /session/:id/interrupt` | 中止该会话当前 run |
| `POST /session/:id/reset` | 软重置(等价 /new,原 /session/new 语义) |
| `GET /session/:id/snapshot` | 启动补发(见 §5.3) |
| `POST /ask/:id/reply` `{answer: AskUserAnswer}` | 问询回执(驱动挂起表) |
| `POST /approval/:id` `{decision: ApprovalDecision}` | 审批回执 |
| `POST /board/review` `{taskId, approved}` | gate 审批(→ 激活会话工作区的 taskboard.review;编排 §10.3 同语义) |
| `GET /file?path=` | 只读文件预览(经 safety 路径判界,拒绝越界) |
| `GET /*` | dist-gui 静态资源 |

(裁定:回执类 ask/approval 保持无会话前缀——挂起表 id 全局唯一;board/review 挂激活会话的工作区板,团队目录工作区级语义。)

### 4.2 WS `/events`(单向下行)

- 帧三型(均挂 `sessionId`):`{kind:'event', sessionId, e: SessionEvent}`(SessionEvent 原样)、`{kind:'approval', sessionId, req: ApprovalRequest}`、`{kind:'ask', sessionId, req: AskUserRequest}`。
- 连接建立即补发**全部活会话**的环形缓冲尾段(≤512 条/会话,帧按 sessionId 区分),更早历史经各会话 snapshot;心跳 30s(ping/pong)。
- **裁定**:问询/审批经 WS 封装帧而非新造 SessionEventType——TUI 控制态(问询卡)不塞公共事件面;`approval-request` 词汇保留给未来事件化路径。

### 4.3 鉴权

- 监听 `127.0.0.1` 固定;启动生成随机 token(打印终端 + 写 `<dataDir>/serve-token`),请求头 `Authorization: Bearer <token>`;HTTP 与 WS 升级请求同验。失败 401/关闭。

## 5. 前端架构(gui/ 子包)

### 5.1 包结构

```
gui/
  package.json(react/react-dom/vite/vitest;workspace 内)
  src/
    connect/(WS/HTTP/token/重连)
    projection/(chat.ts 新;board.ts/delegation.ts 从主仓 re-export)
    pages/(Chat/Approvals/Board/Files)
    App.tsx(路由:四页 + 顶栏状态)
```

- **投影复用**:主仓 `src/taskboard/model.ts`、`src/delegation/projection.ts` 零 TUI 依赖——gui 经 workspace 直接 import 源码(共享 TS 基座,换实现不换语义)。

### 5.2 chat reducer(新,GUI 侧)

从 SessionEvent 流派生转录条目:`user`(submit 回显)、`assistant`(token 流累积 md,done 收段)、`tool`(tool-call/tool-result 按 callId 配对,write 工具的 old/new string 留给 diff 视图)、`notice`/`delegation`(一行摘要 + 展开详情)、`message`(agent-message 行)。**不复用 ChatItem/ansi**——md 渲染在浏览器侧(react-markdown 或等价,v1 选最小依赖)。

### 5.3 snapshot 与恢复

`GET /snapshot` 响应:

```json
{ "messages": [{"seq","ts","kind","md"}], "board": TaskBoardState, "delegations": Delegation[],
  "todos": TodoItem[], "status": "idle|running|awaiting-*", "tasks": BackgroundTask[] }
```

- 归档转录:daemon 读 SessionJournal 的 msg 行(`text` 原文 + kind;**不带 ansi**——ansi 承载的渲染态由 GUI 重渲染);write-snapshot 的 diff 底座引用 tool 观察行。
- 刷新流:GET snapshot → 开 WS → 补缓冲 → 增量;断线同路径(指数退避重连)。

## 6. 页面规格(v1)

1. **对话页**(首页):转录流(md 渲染 + 折叠的工具行)+ 输入框(提交/steering 自动判定运行态)+ 中断按钮 + 状态栏(tokens/steps 摘要,取自 usage/step 事件)。
2. **审批与问询卡**:WS approval/ask 帧 → 卡片浮层(选项/自定义输入),回执 POST;与 TUI 审批卡同语义(manual 模式)。
3. **任务看板**:板投影(applyBoardEvent 直跑)→ 列表视图(状态/依赖/gated ⚠)与 **DAG 视图**(dependsOn 自动推导,SVG 最小实现)双切换;teammate 侧栏(alive 名单 + busy 态);gated 任务行内审批卡(POST /board/review)。**编排 spec P3 的验收现场**。
4. **代码预览 + diff**:GET /file 只读预览(语法高亮复用主仓既有 highlight.js 依赖的浏览器版);diff = write 工具观察行的 old/new string 并排(行级 diff,零额外算法依赖)。

## 7. daemon 会话管理(会话中心模型,2026-10-06 修正)

- **会话注册表**:`sessions: Map<sessionId, SessionRuntime>`;SessionRuntime = `{ id, root, runtime(createRuntime 按该 root), pump 态(缓冲/连接广播), 影子投影/转录, current run 票据 }`。sessionId 方言 `s<n>` 进程内单调。
- **创建**:`POST /session/new {root}` → root 存在性/目录校验 → 装配;**同 root 多会话允许**(各自独立主链;teams 目录与 serve-token 工作区级共享——任务板跨会话可见是特性)。
- **恢复**:`attach {journalId}` → 该 root 的 dataDir 下打开 SessionJournal → chain 行回放经 `context.appendChain` 重建 → 影子投影/转录从 journal msg 行播种(归档态)→ idle。
- **run 串行(每会话)**:一次一 run,interrupt 可中止;运行态事件全量进该会话泵。多会话可各自在跑(N 个 Harness 并发,内存有界——v1 不做空闲回收,记 v1.x)。
- **收尾**:SIGINT → 全会话 teardown(abort 在跑 run 有界等待 → stopAll → drain → mcpClose → journal seal),序同单会话既有。
- **安全面裁定**:目录选择 = token 持有者可开任意本地目录;回环+token 威胁模型下接受(CLI 本就按目录全权),dirpicker 不列隐藏目录内容之外的信息面。

## 8. 仓库与构建

- pnpm workspace:根 `pnpm-workspace.yaml`(`gui/`);主仓构建链零扰动(tsc/node:test 不变)。
- 主仓新增依赖:**仅 `ws`**(零传递依赖);gui 子仓自管(vite/react-dom/vitest/react-markdown)。
- `gui/` 构建产物 `dist-gui/` 进主仓 `.gitignore`;daemon 缺省服务内嵌路径,不存在时打印开发模式提示(`pnpm --filter gui dev` 的 Vite 端口代理)。

## 9. 错误处理与降级

| 场景 | 行为 |
|---|---|
| WS 断线 | 前端指数退避重连;重连后**重置投影并全量重放**(GET snapshot 重建基线 + 环形缓冲从头补发,投影 reducer 从空跑天然幂等——不做增量缝隙拼接) |
| token 失败 | 401 页面提示 + 终端重打印 token(不自动降级) |
| daemon 重启(run 中) | journal 已落盘部分完整;重启 --continue 恢复,运行中链不丢(journal 事件级即时落盘既有保证) |
| 事件洪峰(看板批量) | 投影 reducer 纯函数批量应用;渲染层 raf 合帧(50ms) |
| dist-gui 缺失 | daemon 打印开发模式指引,API 面仍可用(契约测试路径) |

## 10. 测试策略

- **主仓 node:test(daemon 契约)**:起真 serve(随机端口/token)+ ws 客户端 + ScriptedAdapter——submit→事件序断言(与 TUI e2e 同型);approval/ask 挂起-回执闭环;snapshot 恢复完整性;journal 续接;鉴权拒绝;file 判界。
- **gui 子仓 vitest**:chat reducer 单测(流式/配对/折叠)、投影复用冒烟(与主仓镜像测试同口径)、连接层重连状态机、四页面组件冒烟(测试渲染)。
- **端到端冒烟**:daemon + dist-gui + 无头断言四页可达(浏览器自动化,CI 可选门)。

## 11. 与既有体系的关系

- **三面同源第四面**:协议词汇 = SessionEvent 原样 + 既有接缝序列化;GUI 增补需求一律先回事件面/接缝层评审(TUI 免费受益)——编排 spec §10.4 边界 1/3 的延续。
- **TuiState 债不跨端**:ansi/预渲染留在 TUI;GUI 投影层是新的单一事实消费面;TUI 与 GUI **并行维护**(不替代),共享到事件面为止。
- **编排 P3 兑现**:看板页 = 编排 spec §13 P3 的「任务列表→看板、dependsOn→DAG 自动推导、teammate→侧栏」逐条落地。

## 12. 阶段路线(批次,一阶段一 plan)

| 批次 | 范围 | 验收 |
|---|---|---|
| **G1 daemon 骨架** | serve 命令/HTTP/WS/token/事件泵/submit·interrupt | 契约测试:ScriptedAdapter 一轮对话事件序经 WS 可订阅 |
| ~~G1 已交付~~ | 2026-10-06,`c6ba520`/`cf6037a`/`7ad24c3`——GuiDaemon(createRuntime 同单点/单 run 锁/teardown 含 abort 在跑 run)+ WS 事件泵({kind:'event'} 帧+512 环形缓冲+连接即补发+Bearer 升级鉴权+ping 保活)+ serve 命令 + 契约收口(全链两轮/404 hint)。全量 1682 例 0 败。裁定:HangingAdapter 挂起测试形态(session.interrupt 同款);413 超限;补发与 101 握手同 TCP 段(客户端收集器构造即挂) | 验收已过 |
| **G2 gui 骨架** | workspace/vite/连接层/投影复用/snapshot | 无头断言:snapshot 渲染出静态转录与板 |
| ~~G2 已交付~~ | 2026-10-06,`8036689`/`7836a56`/`c65f02e`+`6a5f65c`/`1549608`——daemon snapshot 套件(影子投影同源纯件+TranscriptCollector 粗粒度转录)+WS subprotocol 鉴权(浏览器路径,ws@8 首协议回显)+serve-token JSON/--port 收紧+gui 包(Vite/React/vitest,连接层,投影源码直 import,App 纯渲染)+无头 e2e(真 daemon 全链渲染断言)。全量 1688 例 0 败。裁定:转录源=事件累积器非 journal(daemon 无 SessionController,journal 面 daemon 化随 G3 --continue 再议);退订器断 socket(G3 重连防泄漏);gui pretest 耦合主仓 build;守卫锚点修复(gui/node_modules 行冗余移除,dist-gui 入 SCAN_SKIP_DIRS) | 验收已过 |
| **G3 对话页+会话中心** | 会话管理器(注册表/创建选目录/attach 恢复/多 Harness)/首页(工作区·会话列表·目录选择器)/对话页(流式/提交/中断/steering/状态栏/激活切换) | 冒烟:新建会话选目录→提交→流式渲染→done 收段;切换会话各自独立;恢复历史会话转录在场;断线重连恢复 |

> **修正记录(2026-10-06,用户裁定)**:GUI 采用会话中心模型(对标 Codex)——应用为入口、会话为中心、工作目录是会话属性;推翻 G-D8「v1 单会话」裁定,`--root` 降级为预选。G3 范围相应扩为「会话管理器 + 首页 + 对话页」。
| ~~G3 对话页部分已交付~~ | 2026-10-06,`55ee7af`/`426c99a`/`b8d6656`/`2d78dda`+`88a24cd`/`17e30d0`——daemon seq 协议(帧 seq 单调+snapshot.lastSeq,重连双应用根除)+steer 端点(SteeringChannel.enqueue 空闲排队恒 200)+静态挂载(防穿越/SPA 兜底/mime 表)+TranscriptCollector 五 kind(§5.3 归档面全);boardEventFrom 抽纯模块 translate.ts(TUI/daemon/gui 三方同源);连接层状态机(四态/指数退避/onResync 基线重置/seq 过滤);chat reducer(流式收段/工具配对/多轮 token 水位)+App 装配(Codex 式单栏/Enter 分流/Stop/状态条)+md 渲染(gfm)。全量 1698 例 0 败;gui typecheck+test 53/53+e2e 4/4。裁定:seq 协议 WS 保持单向(G-D5);重连=基线重置非缝隙拼接;turnTokensBase 仅 run 边界重置(多轮虚增根除);debug.socket() 两行测试钩子;steer 恒 200(enqueue 纯 FIFO)。**未完成:会话中心扩展(管理器/首页/多会话)——用户 2026-10-06 裁定 G-D8 推翻后的新增范围,待 G3.5 批次** | 对话页验收已过;会话中心未启 |
| **G4 审批问询** | 挂起表/WS 帧/卡片/回执 | 契约:manual 模式审批闭环经 HTTP 回执 |
| ~~G4 审批问询已交付~~ | 2026-10-07,`84a4fb2`/`0eecbe0`/`5af35b2`/`a72ea74`(计划 2026-10-07-g4-approvals.md 四任务分册)——daemon 级挂起表(pid 铸 `p<n>`)+WS approval/ask 帧(无 seq,重连重发)+reset 通知帧+HTTP 回执端点(/approval/:pid、/ask/:pid/reply;interrupt/reset/teardown deny 回填;回执经 notice 事件帧归档)+manual 接线(createSession mode opts/serve --manual//session/new 可选 mode 透传——e2e 经 HTTP 建 manual 会话的最小补丁);新会话 journal 持久化(出生惰性建档,首 run 落盘)+attach chain 派生转录(msg 缺席兜底)+POST /session/:id/delete(有界回收/journal 保留)+teardownAll 死代码处决;GUI ApprovalCard/AskCard(pid 维,回执失败也移卡)+reset 帧清投影重播种+Home delete/toggle 守卫+SnapshotMessage 五 kind;e2e manual 审批闭环+delete 流。全量 1727 例 0 败(2 skip=win32 符号链接既有);gui typecheck+test 98/98+e2e 8/8;selfcheck OK。裁定:pid daemon 单点铸造 `p<n>`(guard ap-N 是会话内序,双 manual 会话撞键);中断/回收 deny 回填(防僵尸 asker 拖住被中止 run);chain 派生仅 msg 缺席(双源零重复);journal 惰性建档(空会话零文件);delete 保留 journal(磁盘档案非 daemon 生命周期资产);appendInstructionLine 潜伏 bug 修复(daemon 提交原不写指令行——真模型从不见 goal)。**已知缺口(G5+ 记档)**:Home 行 Delete 以 journal id 打会话端点恒 404(需 journal 删除端点或 id 解析接线;e2e 以现状断言钉住);会话切回后挂起卡不可恢复(连接级 pid 去重吞重发——快照带 pending 或去重改会话维);gui 连接层 newSession 无 mode 面(e2e 暂以 fetch 包装器注入) | 审批闭环验收已过(manual e2e:UI 提交挂起→ApprovalCard→Allow 回执→写落盘+notice+done+卡消失) |
| ~~G3.5 会话中心已交付~~ | 2026-10-06,`a8c51df`/`5f0a640`/`795fcd5`/`941a001`/`94d2ed3`(计划=用户并行撰写的 2026-10-06-g3-session-centric.md,执行方按调和裁定净增面执行:计划 T4 全部与 T5 静态/失败转录=G3 已交付不重写)——SessionRuntime 注册表(按会话 root 装配/:id 端点维+裸端点激活别名/WS 帧挂 sessionId/全会话 teardown/--root 预选);工作区注册表(/workspaces 扫描+workspace.json 反解 root)+/sessions?root=+/dirpicker+attach(restoreSession 超集播种+onContextChange 续写 chain+seed 五 kind);gui 连接层会话维(五方法/帧 sessionId 分发/每会话基线 Map/重连=onReset 全量重放)+首页两栏+DirPicker+attach 两步链;Chat 页会话化(pages/Chat+key 重挂独立+种子竞态缓冲);transcript 2000 上限。全量 1715 例 0 败;gui 84/84+e2e 6/6。裁定:seq 全局单调(帧挂 sessionId 客户端自滤);reset=swap Harness(seq 不回绕);链播种用 restoreSession(TUI /resume 单点)非逐条 appendChain;msg 行仅 attach 播种不续写;attach 置激活+运行中 409。**已知跟进(G3.5+ 服务端)**:新会话(非 attach)转录零持久化(pump 只进内存,daemon 重启即失、Home 不可重开)——/session/new 应否首 run 建 journal 待裁 | 会话中心验收已过(Home 全链/attach 恢复/切换独立 e2e) |
| **G5 看板(P3)** | 板投影页/DAG/teammate 侧栏/gate 审批 | 编排 spec P3 验收逐条;gate 审批改板状态 |
| ~~G5 已交付~~ | 2026-10-07,`703426b`/`38f2af6`+`a39c209`(计划 2026-10-07-g5-board.md 三任务分册)——daemon `/session/:id/board/review`(gate 审批映射 taskboard.review;400 fail 透传/404)+snapshot `team`(aliveNames+isBusy)与 `pending`(未决 pid/kind,跨会话过滤)扩段+未知 mode 400+ghost-pending asker 硬化(isAborted 注册前查,单线程同步块竞态结构性闭合)+serve --mode 别名;GUI Board 页(List 行 needs 箭头/gated ⚠ 行内 Approve/Deny + **DAG 双视图**(layoutBoard Kahn 分层纯函数+SVG 盒连线+gated 描边+done 降透明+节点点击详情面板)+teammate 侧栏 busy 点+delegations 简列)+Chat\|Board tab(Chat hidden 面常驻,切 tab 零重播种不丢卡)+**onSeeded 快照全回填板投影**(会话切换串态根除,评审 Critical 修复)+onResetSession 会话维清板(G3.5 交接 d)+Chat 顶栏 Delete(daemon 会话;Home journal 行 Delete 退役——journal 是 append-only 历史)+idle 清卡跳过 reseed 瞬态(重连卡保留 G4 不变式修复)+newSession mode 面+connection boardReview。全量 1731 例 0 败(2 skip 既有);gui typecheck+test 127/127+e2e 8/8;selfcheck OK。裁定:review 会话路由(同 root 多会话各持内存板,events.jsonl 落盘对齐,跨会话实时同步出范围 v1);ghost 硬化单检查足矣(register/sweep 双同步块无 yield——原子性前提注释);pending 段 v1 仅信号(无 req 内容,跨会话卡内容恢复 G6+)。**编排 spec P3 验收逐条兑现,编排 spec 全量实现收官(P0/P1/P2/L2/P3)** | P3 验收已过(List/DAG/team 侧栏/gate 审批;证据=board 组件测+layout 纯测+App 集成+daemon.board 全链,Board GUI-e2e 随 G6 补) |
| **G6 预览+diff** | /file 端点/预览页/write diff 并排 | 越界拒;write 观察行 diff 渲染 |
| ~~G6 已交付~~ | 2026-10-07,`24e384b`/`574932d`(计划 2026-10-07-g6-preview-diff.md 三任务分册)——`GET /session/:id/file`(会话 root 解析+isWithin 判界 fail-closed 收紧/二进制 415/512KB 截断 truncated);Files 页(hljs 高亮 16 扩展/truncated 横幅/错误态/initialPath);Chat 工具条折叠+write 展开面板+path 跳 Files;板投影 **seq 门**(boardPendingRef 同构,onSeeded 过滤重放——G5 丢帧竞态根修);DirPicker manual 勾选(mode UI 面,fetch 包装器 e2e 退役);Board GUI-e2e 全链(gated→DAG 盒→Approve→板更新+委派侧栏);highlight 回落转义(注入面封死)。全量 1732 例 0 败(2 skip 既有);gui typecheck+147/147+e2e 9/9;selfcheck OK。裁定:判界不含 additionalDirs(单 root 收紧,fail-closed);**write 工具实为 {path,content} 整文件写无 old/new string——spec §6.4 双列 diff 前提系写时臆造**,v1 单列新内容,真 diff 走 write-snapshot pre-image 记 G7;512KB 截断非 413(预览语义) | 验收已过(判界/高亮/diff/Board-e2e) |
| ~~G7 已交付~~ | 见上方交付行(02454c7/aea21c0)——交接五项落地+ROADMAP 5B 收官。**遗留注记**:UTF-16 文本经 NUL 探测误判 415(fail-closed 方向,可选精化);/diff 帧环裁剪(>512 事件)404 退单列;oldContent 侧免二进制探测(utf8 乱码装饰面);G3.5 新会话转录零持久化随壳批次 spec 议 | 收官 |
| **G7 收口** | 全量回归/selfcheck/ROADMAP+两 spec 回写 | 门禁绿;编排 spec 全量实现收官 |
| ~~G7 已交付~~ | 2026-10-07,`02454c7`(计划 2026-10-07-g7-wrapup.md 两任务分册;收官 e2e 双场景+ROADMAP 5B/两 spec 回写即本档)——交接五项落地:①`GET /session/:id/diff?callId=`(write 调用 pre-image blob+磁盘现文件双内容;sink 内存清单会话存续期常驻——run 中/run 后实时可查,blob 捕获即落盘内容寻址去重);②snapshot.pending 增 req 直序列化(Chat reseed 逐项重建卡——连接层 pid 去重拦 daemon 重发帧后快照是卡内容唯一来源,刷新/重连恢复闭环);③Chat unmount cleanup gen bump(在途快照应答经代次失配早退,防陈旧 onSeeded 污染 App 态);④reseed 时 toolInputs 清(旧投影 callId 配对残留根除);⑤Files requestIdRef 序守卫(过期应答丢弃)。e2e 双场景:dontAsk 域内 write(预置旧文件)→ 工具条展开 → fetchDiff old/new 双列断言;manual 越域 write 挂起(gate 钉断线窗内——approval 广播零客户端,卡不可能在断线前到达)→ 断 App 底层 socket → 重连 onReset/reseed → 卡恢复(daemon 挂起重发帧+snapshot.pending req 双源合流,addCard pid 防重)→ Allow 回执闭环(落盘+notice+done+idle)。全量 1738 例 0 败(2 skip 既有);gui typecheck 干净+e2e 11/11;selfcheck OK。裁定:blob 位次对位(nthFor——帧内同路径调用序对 sink 清单,newContent 恒磁盘现文件语义;denied 写不执行/同批并发乱序致两序分叉为已知退化,记档跟进);readFileBounded 三态(正常/'binary'/'missing'——/file 404 分支安放,行为零变化);512KB 同口径(diff 双侧与 /file 预览同截断语义非 413)。**收官注:GUI 线 G1-G7 全交付,5B 除壳批次(托盘/打包/管理面)外完成** | 门禁绿;e2e 双场景过(diff 双列/挂起卡恢复闭环) |
| 壳批次(后置) | Tauri/Electron 选型+打包+托盘/快捷键 | 独立 spec 立项 |

## 13. 风险与对策

| 风险 | 对策 |
|---|---|
| journal 归档转录与事件流双源漂移 | snapshot 的 messages 只取 journal md 原文;运行态只取事件流;seq 对齐校验(G2 契约) |
| chat reducer 与 TUI 呈现语义分叉 | 折叠/配对语义以 TUI 行为为参照写镜像测试;不共享实现(债隔离) |
| ws/静态服务引入安全面 | 回环+token;file 端点过 safety 判界;无远程绑定 |
| 单会话限制误期望 | 文档明示;多会话 v1.x 路线已记 |
| Vite 子仓拖慢主仓 CI | workspace 隔离;主仓门禁不含 gui 构建(gui 自带 CI 脚本) |

## 14. 决策记录

| # | 决策 | 放弃的替代 | 依据 |
|---|---|---|---|
| G-D1 | daemon + Web 先行,壳后置 | Electron/Tauri 直上 | TuiRuntime 接缝既定方向;最早验证视图派生最难轴;零新工具链;DAG 看板浏览器最强(用户「继续」放行) |
| G-D2 | 协议 = SessionEvent 原样直通,控制面全 HTTP | GUI 专用中间事件层 | §10.4 边界 1;三面同源;TUI 免费受益 |
| G-D3 | 看板并入 v1,管理面出 v1 | 严格按 ROADMAP v1 范围 | 纯订阅成本最低;编排 P3 验收载体 |
| G-D4 | 投影复用(taskboard/delegation 纯件直跑浏览器),chat reducer 新建 | 复用 TuiState/ChatItem | §10.4 边界 2;ansi 债不跨端 |
| G-D5 | WS 单向下行 + HTTP 全控制 | WS 双向 | 控制面可缓存/可测;事件面保持纯流 |
| G-D6 | 问询/审批走 WS 封装帧,不造新 SessionEventType | 扩公共事件面 | TUI 控制态不塞事件面;词汇留未来事件化 |
| G-D7 | 主仓仅增 `ws` 依赖 | 自实现 WS / 引大框架 | ws 零传递依赖;协议复杂度不值自实现 |
| G-D8 | v1 单会话;多会话/切换 v1.x | v1 即多会话 | YAGNI;daemon 生命周期最简——**已被 2026-10-06 会话中心修正推翻(用户裁定,对标 Codex),见 §12 修正记录** |
| G-D9 | diff = write 观察行并排,预览 = /file 只读 | 全量 git diff/编辑器集成 | 零新算法依赖;write-snapshot 底座既有 |
| G-D10 | **GUI 交互/美学参照 Codex 工作站,底座不变**(TUI/GUI = 同一事件流两投影,三面同源);**迁移语义 = 跨时间自由切换**(同工作区交替使用,板/teams/journal 数据同源),非同时双开 | GUI 旁路专有层;与 TUI 交互手感像素级对等;双进程并发同开 | 渲染层是事件流派生物,换皮零协议影响(G-D2/G-D4/§10.4 兑现);GUI 增补先回事件面纪律(§11)保美学自由不腐蚀成旁路;跨进程排他为 G1 终审遗留待决项,双开需求出现时再议 |
