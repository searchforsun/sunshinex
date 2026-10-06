# G3 会话中心 + 对话页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付会话中心模型(daemon 会话管理器/工作区注册表/attach 恢复)+ gui 首页(工作区·会话·目录选择)+ 对话页(流式转录/提交/中断/steering/状态栏/激活切换)——对标 Codex 的「应用为入口、会话为中心」。

**Architecture:** daemon 从绑 root 改为**会话注册表**:`Map<sessionId, SessionRuntime>`,每会话按 root 独立装配 createRuntime(独立泵/影子投影/转录/run 票据);协议路由挂会话维(`/session/:id/*`),**裸端点降级为激活会话别名**(渐进迁移,G2 gui 面不破);WS 帧挂 `sessionId`,连接补发全会话缓冲。gui 侧连接层重做(会话维过滤/状态机/重连=快照重置全量重放,spec §9 既有裁定)+ 首页两栏 + 对话页(chat reducer 细粒度流式 + md 渲染)。

**Tech Stack:** TypeScript strict(主仓+gui typecheck)、React 18、vitest、react-markdown(gui 新依赖)。

**Spec:** `docs/superpowers/specs/2026-10-06-gui-v1-design.md`(§3/§4/§7 会话中心修正版、§5.2 chat reducer、§6.1 对话页、§12 G3;2026-10-06 修正记录)。

## Global Constraints

- 主仓 tsc strict 零报错、`pnpm test` 0 败(全量门禁仅 T6 控制器后台;看门狗 600s:逐任务聚焦,单命令 ≤8min,长命令后台)。
- gui `pnpm --filter sunshinex-gui test` 全绿(typecheck→主仓 build→vitest 链)。
- **裸端点兼容裁定**:`/submit` `/interrupt` `/steer` `/snapshot` `/session/new(旧软重置语义→改 /session/:id/reset)` 中,submit/interrupt/steer/snapshot 保留为激活会话别名(v1.x 移除);旧 `/session/new` 语义让位新 `{root}` 创建。
- 事件 payload 结构化禁 ANSI;sessionId 方言 `s<n>` 进程内单调。
- 注释中文决策风格;gui 新依赖仅 react-markdown(+remark-gfm 如需)。
- SessionJournal 消费经 `src/tui/session-journal.ts` 既有导出(listSessions/parseJournalFile/reduceJournal/sessionsDir)——抽纯模块记 v1.x(浏览器 bundle 不受影响:gui 不 re-export 该链)。

## Rulings(计划级)

1. **激活会话(active)**:最近 create/attach 的会话;裸端点与 board/review 挂它。UI 切换 = 纯前端状态,不改 daemon active(active 是协议兼容层概念,不是 UI 状态)。
2. **同 root 多会话允许**(各自主链;teams/serve-token 工作区级共享——任务板跨会话可见是特性,spec §7)。
3. **dirpicker**:服务端目录浏览 `GET /dirpicker?path=`(缺省家目录;列子目录名+类型,不含文件;path 必须存在且为目录;不设白名单——token 持有者本就可开任意目录,spec §7 安全裁定)。
4. **attach 恢复**:createSession 后经 reduceJournal 播种——chain 行回放进 `context.appendChain`,msg 行播种影子转录,journal 实例挂 SessionRuntime(后续运行继续落盘);恢复后新 run 续写同 journal(rotate 语义不触发)。
5. **transcript 上限**:2000 条丢最老(无界增长收口,丢档记 stderr 一行);eventBuffer 维持 512。
6. **chat reducer 流式语义**:token 增量直接入活动 assistant 段(不缓冲整段),done 收段定格;工具行折叠(call+result 配对,默认收起一行,可展开);与 daemon 转录(粗归档面)分工不共享。
7. **静态挂载**(T5):daemon 服务 `dist-gui/`(存在探测;SPA fallback index.html;缺失保留 404+hint);`--root` 预选 = 启动即 createSession(root) 并激活。

---

### Task 1: daemon 会话管理器核心

**Files:**
- Create: `src/serve/session.ts`(SessionRuntime + 注册表逻辑,从 daemon.ts 抽出并扩)、`src/serve/session.test.ts`
- Modify: `src/serve/daemon.ts`(GuiDaemon 改持有注册表;端点路由会话维;WS 帧 sessionId;全会话 teardown;--root 预选)
- Modify: `src/cli/commands/serve.ts`(--root 语义)、`src/serve/daemon.test.ts`/`daemon.ws.test.ts`/`daemon.contract.test.ts`(会话维扩展 + 裸端点别名断言)
- Test: 同上

**Interfaces:**
- Consumes: createRuntime、TranscriptCollector、影子投影、SessionJournal 族(tui/session-journal)
- Produces(T2-T5 依赖):
  - `class SessionRuntime { readonly id; readonly root; runtime; pump(e) / shadowBoard / shadowDelegations / transcript / status(); submit(goal); interrupt(); reset(); snapshotResponse(); teardown(): Promise<void>(abort 有界等待→stopAll→drain→mcpClose→journal seal) }`(从现 daemon 单会话态平移)
  - `GuiDaemon.createSession(root: string): Result<{ sessionId }>`(root 存在性校验 INVALID_ARG;装配;入表;s<n>;置 active)、`attach(journalId, root): Result<{ sessionId }>`(T2 实装,本任务留桩 INVALID_STATE)、`get(id)`、`activeId()`、`teardownAll()`
  - 端点:`POST /session/new {root}`、`POST /session/:id/submit|steer|interrupt|reset`、`GET /session/:id/snapshot`;裸 `/submit|/steer|/interrupt|/snapshot` → active 别名(无 active 409 `{error:'no active session'}`);旧 `/session/new` 无 root → 400 提示新语义
  - WS 帧三型均挂 `sessionId`;连接补发 = 全部会话缓冲逐会话帧(会话序 s1..sN,各内缓冲序)
- [ ] **Step 1: 失败测试**——session.test(SessionRuntime 平移面);daemon.test:双会话并发(两 root 各自 submit 互不串流/各自 409 语义/各自 interrupt);裸别名(创建前 409;创建后打裸端点等价 s1);daemon.ws:帧含 sessionId、双会话补发各归各;contract:两轮跨会话。**既有 G1/G2 用例迁移**:单会话用例改为「createSession 后打 :id 端点」形态(语义不变)。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**(平移+扩;全会话 teardown 序)→ **Step 4: 跑测** `pnpm build && node --test dist/serve/session.test.js dist/serve/daemon.test.js dist/serve/daemon.ws.test.js dist/serve/daemon.contract.test.js`
- [ ] **Step 5: 提交** `feat(serve): 会话管理器——注册表/按会话 root 装配/端点会话维+裸端点激活别名/WS 帧挂 sessionId/全会话 teardown/--root 预选降级`

### Task 2: 工作区注册表 + attach 恢复 + dirpicker

**Files:**
- Modify: `src/serve/daemon.ts`(三端点 + attach 实装)、`src/serve/session.ts`(attach 播种)
- Test: `src/serve/daemon.workspace.test.ts`(新)

**Interfaces:**
- Consumes: `listSessions/parseJournalFile/reduceJournal/sessionsDir`(tui/session-journal)、`projectsRoot`(config/data-dir)
- Produces:
  - `GET /workspaces` → `[{ root?, slug, mtime, sessionCount }]`——扫 `projectsRoot()` 下各 `<slug>/data/sessions` 存在者(**裁定:slug 反解 root 不可靠(单向哈希)——返回 slug+统计,root 由前端在 dirpicker 确认;首页工作区行点击 = 提示选目录确认或直接列会话(attach 需要 root 才能装配!→ 变体:workspaces 行内嵌 root?dataDir 内无 root 记录。**裁定:写 `<dataDir>/workspace.json` {root} 于 createSession 时落档**,扫描时读回真 root;历史工作区无此档则降级 slug-only 行不可 attach)**)
  - `GET /sessions?root=` → `listSessions(resolveDataDir(root))`(id/mtime/preview 首行)
  - `GET /dirpicker?path=` → `{ path, parent, dirs: string[] }`(只目录;缺省 os.homedir();非目录 400)
  - `POST /session/:id/attach {journalId}` → 该会话 root 的 dataDir 下 reduceJournal → chain 回放 appendChain + msg 播种 transcript + SessionJournal 实例挂载(后续 seal);journalId 未知 INVALID_ARG
- [ ] **Step 1: 失败测试**(workspace.json 落档/扫描含 root;dirpicker 只目录+parent 链;attach:TUI 侧既有 journal 测试桩或手工写 jsonl → attach 后 snapshot 的 messages/board 播种在场、后续 submit 续写同 journal)
- [ ] **Step 2/3/4** 同律(聚焦:daemon.workspace + session + contract)
- [ ] **Step 5: 提交** `feat(serve): 工作区注册表与恢复——/workspaces 扫描(workspace.json 落 root)/sessions?root=/dirpicker 服务端目录选择;attach 经 reduceJournal 播种链与转录并续写 journal`

### Task 3: gui 连接层重做 + 首页

**Files:**
- Modify: `gui/src/connection.ts`(会话维/状态机/重连)、`gui/src/App.tsx`(路由骨架:首页|对话)
- Create: `gui/src/pages/Home.tsx`、`gui/src/pages/DirPicker.tsx`、`gui/src/home.test.tsx`
- Modify: `gui/src/App.test.tsx`、`gui/src/e2e.test.ts`(连接层迁移)

**Interfaces:**
- Consumes: T1/T2 端点
- Produces:
  - Connection 扩:`workspaces()` / `sessionsOf(root)` / `dirpicker(path?)` / `newSession(root)` / `attach(sessionId, journalId)` / `sessionSubmit(id, goal)` 等(会话维方法;旧 submit/snapshot 收敛为 `activeSubmit/activeSnapshot` 内部或保留壳);`onSessionEvent(sessionId, cb)`(帧按 sessionId 分发;未订阅会话帧丢弃);状态机 `connecting|open|closed` + 掉线转 closed(G2 minor 收口)+ 指数退避重连(重连后**重置投影并全量重放**:回调 onReset() 通知各会话投影清零 + snapshot 重拉,spec §9)
  - `Home({conn, onOpenSession})`:左栏工作区列表(刷新)/右栏选中工作区的会话列表(attach 按钮)/「New session」→ DirPicker(逐级浏览+自定义路径输入+确认);空态引导
- [ ] **Step 1: 失败测试**(gui vitest:Home 渲染桩数据/DirPicker 交互/连接层会话分发桩测)
- [ ] **Step 2/3/4** `pnpm --filter sunshinex-gui test` 全绿(e2e 迁移到会话维:newSession→activeSubmit)
- [ ] **Step 5: 提交** `feat(gui): 连接层会话维与状态机重做(重连=快照重置全量重放)+首页(工作区/会话两栏/服务端目录选择器/attach 入口)`

### Task 4: gui 对话页本体

**Files:**
- Create: `gui/src/chat-reducer.ts`、`gui/src/chat-reducer.test.ts`、`gui/src/pages/Chat.tsx`
- Modify: `gui/src/App.tsx`(会话视图装配:Home↔Chat 切换,激活会话本地态)、`gui/src/main.tsx`(VITE_SERVE_URL 装配)、`gui/package.json`(+react-markdown)
- Test: 上 + `gui/src/chat.test.tsx`(组件)

**Interfaces:**
- Consumes: Connection 会话维、projection re-export
- Produces:
  - `applyChat(state: ChatState, e: SessionEvent): ChatState`——流式 assistant 段(token 增量入活动段)/done 收段/tool 配对折叠行/notice/delegation 摘要行/agent-message 行;`ChatState { entries: ChatEntry[]; streaming?: { text: string } }`;ChatEntry = `{kind:'user'|'assistant'|'tool'|'notice'|'delegation'|'message', md, callId?, collapsed?}`
  - `ChatPage({conn, sessionId, snapshot, onBack})`:转录列表(react-markdown 渲染 md;工具行折叠/展开;流式段尾部渲染)/输入框(idle 提交·running 转 steering 按钮语义)/中断/状态栏(tokens/steps 从 usage/step 事件累计)/顶栏(会话 id·root·状态点·返回首页)
- [ ] **Step 1: 失败测试**(reducer 纯件全语义 + 组件冒烟)→ **Step 2/3/4** gui 全绿 → **Step 5: 提交** `feat(gui): 对话页——流式 chat reducer(token 直入活动段/工具折叠/notice·委派·消息行)+md 渲染+提交·steering·中断+状态栏+会话切换装配`

### Task 5: 静态挂载 + 失败 run 转录 + transcript 上限

**Files:**
- Modify: `src/serve/daemon.ts`(dist-gui 静态服务+SPA fallback;run 失败/错误→transcript 记 error 条目)、`src/serve/transcript.ts`(2000 上限)、`src/cli/commands/serve.ts`(启动打印 URL 提示浏览器入口)
- Test: `src/serve/daemon.contract.test.ts` 扩

- [ ] **Step 1: 失败测试**(dist-gui 存在时 GET / 回 index.html、深层路径 SPA fallback、缺失时 404+hint 保留;runTask reject→snapshot 含 error 条;2000 上限丢最老)
- [ ] **Step 2/3/4** 聚焦绿 → **Step 5: 提交** `feat(serve): dist-gui 静态挂载(SPA fallback)与转录收口——run 失败入档 error 条;transcript 2000 上限;浏览器入口提示`

### Task 6: e2e 无头验收 + 门禁 + spec 回写(控制器)

- [ ] gui e2e 扩:真 daemon → Home 流(newSession(root=tmpA)→submit→done)→ 第二会话(tmpB)独立 → 切回 s1 转录在场 → attach(T2 手工 journal)恢复转录——四断言对 spec §12 G3 验收行。
- [ ] `pnpm --filter sunshinex-gui test`;主仓 `pnpm test` 后台;`pnpm selfcheck`;spec §12 G3 回写(提交可溯+裁定);提交 `docs(spec): G3 执行回写`。
