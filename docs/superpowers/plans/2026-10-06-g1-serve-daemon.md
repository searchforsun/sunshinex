# G1 Daemon 骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `sunshinex serve` daemon 骨架:HTTP 控制面(submit/interrupt)、WS 事件泵(广播+环形缓冲)、回环 token 鉴权——契约测试证明一轮 ScriptedAdapter 对话的事件序经 WS 可订阅。

**Architecture:** `GuiDaemon` 类持有 `createRuntime`(TUI 同一装配单点,dontAsk 模式)+ 单 run 锁(AbortController)+ 事件泵(onEvent→WS 广播+512 环形缓冲+连接补发);`node:http` 承载 HTTP 与 WS 升级(ws 库);`serve` CLI 命令薄壳(装配/打印 URL+token/SIGINT teardown,序同 teardownCliRun)。

**Tech Stack:** TypeScript (tsc strict)、node:test、`ws`(主仓唯一新依赖,零传递)+ `@types/ws`(dev)。

**Spec:** `docs/superpowers/specs/2026-10-06-gui-v1-design.md`(§3 架构、§4 协议、§7 会话管理、§9 错误降级、§12 G1)。

## Global Constraints

- tsc strict 零报错;`pnpm test` 0 败(2 既有 win32 跳过容忍)——全量门禁仅 T4 控制器后台执行(看门狗 600s 协议:逐任务聚焦,单命令 ≤8min)。
- daemon 零 harness 内部改动:只经 `createRuntime` opts 与 harness 公开面(spec §3)。
- 回环绑定 `127.0.0.1` 固定;token 鉴权 HTTP 与 WS 升级同验(spec §4.3)。
- 注释中文决策风格;终端打印英文。
- 新文件放 `src/serve/`(daemon 域目录,对齐 src/taskboard 先例)。

## Rulings(计划级)

1. **G1 模式 = dontAsk**:审批/问询挂起表是 G4 批次;G1 的 onAskUser 不注入(headless dismissed 桩既有缺省)。
2. **端口/token**:flags `--port`(缺省 7788)与 env `SUNSHINEX_SERVE_PORT`;token = `crypto.randomBytes(24).hex` 打印终端 + 写 `<dataDir>/serve-token`;env `SUNSHINEX_SERVE_TOKEN` 覆盖(测试口)。
3. **健康检查**:`GET /healthz` 免鉴权回 `{ok:true}`(零信息面);其余全鉴权。
4. **静态资源**:G1 只做「dist-gui 缺失 → 404 + 终端一次性提示(开发模式指引)」;真静态服务随 G2。
5. **WS 鉴权**:升级请求头 `Authorization: Bearer <token>`(不支持 query 传 token,避免日志泄漏)。

---

### Task 1: GuiDaemon 核心 + HTTP 控制面 + serve 命令

**Files:**
- Create: `src/serve/daemon.ts`、`src/serve/daemon.test.ts`
- Create: `src/cli/commands/serve.ts`
- Modify: `src/cli/index.ts`(COMMANDS 数组 + switch 分发 + help 文案两则)
- Modify: `package.json`(+`ws` dependencies、+`@types/ws` devDependencies)——本任务先加依赖(T2 用)

**Interfaces:**
- Consumes: `createRuntime`/`TuiRuntime`(src/tui/runtime.ts)、`buildModel`(CLI 模型装配,src/runtime.ts buildDeps 同源)、`ScriptedAdapter`、`resolveDataDir`
- Produces(T2/T3 依赖):
  - `class GuiDaemon { constructor(opts: { root: string; model: ModelAdapter }); start(opts?: { port?: number; token?: string }): Promise<{ port: number; token: string; close(): Promise<void> }>; }`——HTTP 端点:`GET /healthz`(免鉴权)、`POST /submit {goal}`(运行中 409;否则 `void runTask(goal,{signal})` 即回 202 `{ok:true}`)、`POST /interrupt`(无运行 409;有则 abort 200);鉴权失败 401;body JSON 解析失败 400
  - 单 run 锁:`private current?: { abort: AbortController }`;run 完成清位;`status(): 'idle' | 'running'`(内部,测试可窥)
  - teardown:close() = server close + stopAllTasks + pipeline drain + mcpClose(序同 teardownCliRun,runtime.ts:35-52 形态)
  - `runServe(args)`(src/cli/commands/serve.ts):目录判据同 pipeline(--workdir/位置)、--port flag、start 后打印 `listening at http://127.0.0.1:<port> (token: <t>)`、SIGINT/SIGTERM → close → exit 0

- [ ] **Step 1: 失败测试**(daemon.test.ts,fetch 直打):
```ts
// ① healthz 免鉴权 200 {ok:true};无 token 的 /submit 401;错 token 401
// ② 鉴权下 submit 空体 400 / 非 JSON 400;合法 {goal} 202;ScriptedAdapter 单 done 卡——run 异步完成后 status 回 idle(轮询 ≤3s)
// ③ 运行中(hanging ScriptedAdapter:{done:false} 循环卡)二次 submit 409;interrupt 200 后可再 submit(abort 生效,runTask 以 stopReason 收)
// ④ close() 幂等且进程可退(unref 计时器/SIGINT 模拟跳过——close 后再 fetch 拒连)
```
(装配样板:tmp root + `new GuiDaemon({root: tmp, model: new ScriptedAdapter([...])})` + `start({port: 0, token: 'test-token'})`)
- [ ] **Step 2: 确认失败**(Cannot find module './serve/daemon' 或 cli 依赖)
- [ ] **Step 3: 实现**——daemon.ts(node:http + 简路由表;runTask 调 `runtime.runTask(goal, { signal: abort.signal })`,catch 吞错转 stderr 日志行;close 序见 Interfaces);serve.ts + cli/index.ts 注册(help 两语各加一行 `sunshinex serve [dir] [--port=]`);package.json 依赖
- [ ] **Step 4: 跑测** `pnpm build && node --test dist/serve/daemon.test.js`
- [ ] **Step 5: 提交** `feat(serve): GuiDaemon 骨架——createRuntime 同 TUI 单点装配/dontAsk、单 run 锁(submit 202·运行中 409·interrupt abort)、healthz 免鉴权、Bearer token 鉴权、teardown 同 CLI 序;serve 命令薄壳(端口/token 打印/SIGINT 收口)`

### Task 2: WS 事件泵(广播 + 环形缓冲 + 连接补发)

**Files:**
- Modify: `src/serve/daemon.ts`(pump + upgrade 处理)
- Test: `src/serve/daemon.ws.test.ts`(新)

**Interfaces:**
- Consumes: Task 1 GuiDaemon;`ws`(WebSocketServer 挂 http server upgrade)
- Produces:
  - 事件泵:构造注入 `onEvent: (e) => this.pump(e)` 到 createRuntime opts;`pump(e)`:JSON 下行帧 `{kind:'event', e}` 广播至全部连接 + 推入环形缓冲(容量 512,满了丢最老)
  - WS 连接:升级请求验 Bearer(失败 401 拒升级);连上即补发缓冲全量(逐帧);30s ping(pong 超时 60s 断);断连清理
  - start() 返回值不变(端口复用 http server)

- [ ] **Step 1: 失败测试**(ws 客户端,主仓测试直用 `ws` 包):
```ts
// ① 连接前 submit(hanging 适配器)→ 事件进缓冲 → WS 后连 → 补发帧含先前事件(连接晚于事件的补发语义)
// ② 连接中 submit(单 done 卡)→ 按序收到 {kind:'event'} 帧:首帧 model-start 或 token 系…以 ScriptedAdapter 实际事件面为准,
//    断言含 token 正文增量与终态 done 事件、帧序与 onEvent 收集器一致(daemon 侧同时挂收集器对照)
// ③ 错 token 升级被拒(客户端 error/无 open)
// ③.5 ping 保活:手动挂两个连接,关其一,另一连接事件流不受影响(广播隔离)
```
- [ ] **Step 2: 确认失败** → **Step 3: 实现**(WebSocketServer({noServer:true}) + server.on('upgrade') 鉴权分支;缓冲数组 + 溢出 shift)
- [ ] **Step 4: 跑测** `pnpm build && node --test dist/serve/daemon.ws.test.js dist/serve/daemon.test.js`
- [ ] **Step 5: 提交** `feat(serve): WS 事件泵——onEvent→{kind:'event'} 帧广播 + 512 环形缓冲 + 连接即补发;Bearer 升级鉴权;ping 保活断连清理`

### Task 3: 契约收口 + 静态缺失提示 + 回归门禁

**Files:**
- Modify: `src/serve/daemon.ts`(GET 非 /healthz 且非已知 API → 404 + 首次提示标志;dist-gui 探测:存在则预留静态挂载点注释,G2 接)
- Test: `src/serve/daemon.contract.test.ts`(新)

**Interfaces:**
- Consumes: T1+T2 全部
- Produces: G1 验收测试(全链)+ API 面收口(未知路径 404 JSON `{error:'not found', hint:'GUI assets not built — run pnpm --filter gui build (G2)'}`——**裁定:G1 恒定 hint**,G2 起按 dist-gui 探测分流)

- [ ] **Step 1: 契约测试**:
```ts
// 全链:daemon + ScriptedAdapter([done reply 卡]) → WS 连接 → POST /submit → WS 按序收满事件至 done 帧
//   → daemon 侧对照收集器 deepEqual 帧载荷 → status idle;再一轮(新 goal)事件流续推(泵生命周期跨 run)
// 收口:未知 GET /foo 404 + hint;401/409/400 语义复验(每态一击)
```
- [ ] **Step 2: 跑测** `pnpm build && node --test dist/serve/daemon.contract.test.js dist/serve/daemon.ws.test.js dist/serve/daemon.test.js`
- [ ] **Step 3: 提交** `test(serve): G1 契约收口——全链 submit→WS 事件序→done→续轮;API 面收口(404 hint/401/409/400)`

### Task 4: 全量门禁 + spec 回写(控制器执行)

- [ ] `pnpm test` 后台(0 败/2 既有跳过);`pnpm selfcheck`
- [ ] GUI spec §12 G1 行标 ✅ 落地记录(commit 可溯);提交 `docs(spec): G1 执行回写`
