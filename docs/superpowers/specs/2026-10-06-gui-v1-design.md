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
- 多会话并行/多窗口切换 UI(v1 一 daemon 一会话;`/sessions` 列表与 attach 留 v1.x);
- 板写操作经 GUI(create_task 等工具调用面板)——v1 看板只读 + gate 审批;
- 管理面(记忆/技能/插件管理)、双端实时同步配置;
- 远程暴露(仅回环 + token)。

## 2. 术语

| 术语 | 定义 |
|---|---|
| **daemon** | `sunshinex serve` 进程:装配 Harness/TuiRuntime + HTTP/WS 端点 + 会话生命周期 |
| **下行帧** | WS 服务端→浏览器的封装:`{kind:'event', e: SessionEvent}` / `{kind:'approval', req}` / `{kind:'ask', req}` |
| **投影** | 浏览器侧从 SessionEvent 流派生状态的纯函数层(复用 taskboard/delegation 既有 reducer + 新 chat reducer) |
| **快照** | `GET /snapshot` 的启动补发:journal 重建的归档转录 + 当前板/委派投影 + 会话元信息 |
| **回执挂起表** | daemon 内 approval/ask 的 Promise 登记(id → resolve),HTTP 回执驱动 |

## 3. 总体架构

```
浏览器(gui/ 子包:React 18 + Vite)              sunshinex 主仓
┌──────────────────────────┐                  ┌───────────────────────────────┐
│ 连接层(WS/HTTP/token)     │  WS 单向下行事件   │ sunshinex serve(daemon)        │
│ 投影层(纯函数 reducer)     │◄────────────────│  ├ createRuntime(同 TUI 单点)  │
│   ├ chat reducer(新)      │                  │  ├ 事件泵:onEvent→广播+环形缓冲 │
│   ├ applyBoardEvent(复用) │  HTTP 控制面      │  ├ 回执挂起表(approval/ask)    │
│   └ applyDelegation(复用) │◄───────────────►│  ├ snapshot 组装(journal+现场) │
│ 页面层(四页)              │  静态资源 GET     │  └ 静态服务 dist-gui            │
└──────────────────────────┘                  └───────────────────────────────┘
```

- **daemon 零 harness 内部改动**:全部经 `TuiRuntimeOpts` 既有接缝(onEvent/onAskUser/onApproval/onTodos)与 `harness` 公开面(steering/tasks/taskboard/security)。
- **事件泵**:onEvent 回调 → 广播至全部 WS 连接 + 写入有界环形缓冲(重连补发窗口,缺省 512 条;更早历史走 snapshot)。

## 4. 协议层

### 4.1 HTTP 控制面(全部 POST 除列示)

| 端点 | 语义 |
|---|---|
| `POST /submit` `{goal}` | 提交任务(经 runtime.runTask 主链入口) |
| `POST /steer` `{text}` | 运行中穿插(→ harness.steering) |
| `POST /interrupt` | 中止当前 run(AbortController) |
| `POST /ask/:id/reply` `{answer: AskUserAnswer}` | 问询回执(驱动挂起表) |
| `POST /approval/:id` `{decision: ApprovalDecision}` | 审批回执 |
| `POST /board/review` `{taskId, approved}` | gate 审批(→ taskboard.review;编排 §10.3 同语义) |
| `POST /session/new` | 软重置(等价 /new) |
| `GET /snapshot` | 启动补发(见 §5.3) |
| `GET /sessions` | journal 会话列表(恢复入口,v1 仅启动参数消费) |
| `GET /file?path=` | 只读文件预览(经 safety 路径判界,拒绝越界) |
| `GET /*` | dist-gui 静态资源 |

### 4.2 WS `/events`(单向下行)

- 帧三型:`{kind:'event', e}`(SessionEvent 原样)、`{kind:'approval', req: ApprovalRequest}`、`{kind:'ask', req: AskUserRequest}`。
- 连接建立即从环形缓冲尾补发(≤512 条),此前历史经 snapshot;心跳 30s(ping/pong)。
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

## 7. daemon 会话管理

- 单会话生命周期:`serve [--continue | --resume <id>]` → journal attach(复用 SessionJournal 载入语义)→ 链重建(ContextManager 由 buildHarness 构造后,journal 的 chain 行回放经 `context.appendChain` 逐条注入)→ idle 待提交。
- run 串行(与 TUI 同:一次一 run,interrupt 可中止);运行态事件全量进泵。
- 收尾:SIGINT → stopAllTasks + mcpClose + journal seal(与 teardownCliRun 同序)。

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
| **G3 对话页** | 聊天 reducer/流式/提交/中断/steering/状态栏 | 冒烟:提交→流式渲染→done 收段;断线重连恢复 |
| **G4 审批问询** | 挂起表/WS 帧/卡片/回执 | 契约:manual 模式审批闭环经 HTTP 回执 |
| **G5 看板(P3)** | 板投影页/DAG/teammate 侧栏/gate 审批 | 编排 spec P3 验收逐条;gate 审批改板状态 |
| **G6 预览+diff** | /file 端点/预览页/write diff 并排 | 越界拒;write 观察行 diff 渲染 |
| **G7 收口** | 全量回归/selfcheck/ROADMAP+两 spec 回写 | 门禁绿;编排 spec 全量实现收官 |
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
| G-D8 | v1 单会话;多会话/切换 v1.x | v1 即多会话 | YAGNI;daemon 生命周期最简 |
| G-D9 | diff = write 观察行并排,预览 = /file 只读 | 全量 git diff/编辑器集成 | 零新算法依赖;write-snapshot 底座既有 |
