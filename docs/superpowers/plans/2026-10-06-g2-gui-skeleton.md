# G2 GUI 骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 GUI 骨架:pnpm workspace + gui/ 子包(Vite+React+vitest+连接层+投影复用)、daemon `GET /snapshot`(影子投影+粗粒度转录累积器)、WS subprotocol token 鉴权变体与 G1 遗留三项——无头断言证明 snapshot 渲染出静态转录与板。

**Architecture:** daemon 侧在 pump 内同步喂**影子投影**(applyBoardEvent/applyDelegation 同源纯函数)与**事件累积器**(user/assistant 段/tool 配对的粗粒度转录,G3 的 gui 细粒度 chat reducer 与之分工=归档面 vs 实时面);浏览器无法设 Authorization 头 → WS 鉴权增 **subprotocol 变体**(`Sec-WebSocket-Protocol: bearer.<token>`);gui 经 workspace 直 import 主仓 TS 源(投影零拷贝)。

**Tech Stack:** TypeScript (tsc strict 主仓;gui 子包 vite 自管)、React 18、vitest(gui)、既有 ws。

**Spec:** `docs/superpowers/specs/2026-10-06-gui-v1-design.md`(§5.3 snapshot、§4.3 鉴权、§8 仓库构建、§12 G2;G1 终审遗留三项转本批次)。

## Global Constraints

- 主仓 tsc strict 零报错、`pnpm test` 0 败(全量门禁仅 T3 控制器后台;看门狗 600s 协议:逐任务聚焦,单命令 ≤8min)。
- gui 子仓自管依赖,主仓新增依赖 = 0。
- 事件 payload 结构化禁 ANSI;转录累积器只存 md 原文与结构行。
- 注释中文决策风格(daemon/gui 源同)。
- gui 构建/测试不进主仓门禁(workspace 隔离,gui 自带 `pnpm --filter gui test`)。

## Rulings(计划级)

1. **snapshot 转录源 = 事件累积器**(`src/serve/transcript.ts`),非 journal——daemon 无 SessionController,journal msg 写点在 TUI 层,提升 journal 面是结构迁移(YAGNI,G3/G4 若需 --continue 再议);粗粒度三类:`user`(submit 回显)、`assistant`(done 事件 reply 收段)、`tool`(tool-call/tool-result 按 callId 配对摘要行);偏离 spec §5.3「读 journal」记入回写。
2. **WS 鉴权双形态**:Authorization 头(服务端/测试客户端)与 `Sec-WebSocket-Protocol: bearer.<token>` subprotocol(浏览器)皆过;subprotocol 不进 URL(日志面与 G1 裁定一致)。
3. **serve-token 升 JSON** `{token, port, pid}`(工具可发现;EADDRINUSE 天然同端口互斥,跨端口双开自担——文档一句);**--port 解析收紧**(非 `^\d+$` 或越界 fail-fast 报错)。
4. **gui 投影复用**:workspace 直接 import 主仓 `src/taskboard/model.ts` 与 `src/delegation/projection.ts` 源码(vite 编译;主仓 tsc 不触 gui)。
5. **G2 gui 页面仅骨架**:App 顶栏(连接态/status)+ 转录列表 + 板列表(纯渲染 snapshot,无交互);页面交互全部 G3+。

---

### Task 1: daemon snapshot 套件 + subprotocol 鉴权 + G1 遗留

**Files:**
- Create: `src/serve/transcript.ts`、`src/serve/transcript.test.ts`
- Modify: `src/serve/daemon.ts`(影子投影+累积器喂入+GET /snapshot+subprotocol+杂项)、`src/serve/daemon.ws.test.ts`/`daemon.contract.test.ts`(扩)
- Modify: `src/cli/commands/serve.ts`(serve-token JSON、--port 收紧)

**Interfaces:**
- Consumes: `applyBoardEvent`/`emptyBoard`/`TaskBoardState`(taskboard/model)、`applyDelegation`/`Delegation`/`emptyDelegations?`(delegation/projection——若无 empty 帮手则 `[]` 起)、Task 1 GuiDaemon 既有
- Produces(T2/T3 依赖):
  - `interface TranscriptEntry { seq: number; ts: number; kind: 'user' | 'assistant' | 'tool'; md: string }`
  - `class TranscriptCollector { push(e: SessionEvent): void; submit(goal: string): void; entries(): TranscriptEntry[] }`——done 事件收 assistant 段(reply 全文);tool-call/tool-result 按 callId 配对为单条 `tool` 条目(`● <动词/名> → <result 摘要首行>` 两行 md);user 由 daemon submit 时调 `collector.submit(goal)`
  - daemon 影子态:`private board: TaskBoardState = emptyBoard(); private delegations: Delegation[] = [];` pump 内:`this.board = applyBoardEvent(this.board, boardEventFromDaemon(e))`(task-/gate- 前缀,翻译复用 **session.ts 的 boardEventFrom 需导出**——裁定:从 src/tui/session.ts `export` 该函数,gui/daemon 同源消费,一行改动)与 `this.delegations = applyDelegation(this.delegations, e)`(delegation- 前缀)
  - `GET /snapshot`(鉴权)→ `{ messages: TranscriptEntry[], board: TaskBoardState, delegations: Delegation[], status: 'idle' | 'running' }`
  - WS upgrade:Authorization 头**或** `sec-websocket-protocol === 'bearer.' + token` 过(通过时 handleUpgrade 回显该 protocol)
  - serve.ts:token 文件写 `JSON.stringify({token, port, pid}, null, 2)`;`--port` 非纯数字/越界(1-65535)fail-fast

- [ ] **Step 1: 失败测试**——transcript.test(纯):user/assistant/tool 三类累积与配对(乱序 result 按 callId 归位;无 callId FIFO);daemon.ws.test 扩:subprotocol 鉴权通过(客户端 `new WebSocket(url, ['bearer.test-token'])`)与错值拒;daemon.contract.test 扩:跑一轮(user+done)→ GET /snapshot 断言 messages 含 user 条与 assistant 条、board/delegations 影子正确(create_task 事件经 WS 不需要——直接喂?**snapshot 影子喂入路径=pump,测试经真事件流**:ScriptedAdapter 脚本含 spawn create_task 一卡?简化:直接构造 daemon 后手动 pump 不可(私有)——经 submit 一轮含工具卡的脚本(ScriptedAdapter envelope create_task)断言 board.tasks 非空)。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**(含 session.ts export boardEventFrom 一行)
- [ ] **Step 4: 跑测** `pnpm build && node --test dist/serve/transcript.test.js dist/serve/daemon.test.js dist/serve/daemon.ws.test.js dist/serve/daemon.contract.test.js dist/tui/session.board.test.js`
- [ ] **Step 5: 提交** `feat(serve): snapshot 套件——影子投影(board/delegation 同源纯件)+TranscriptCollector 粗粒度转录(user/assistant/tool 配对);GET /snapshot;WS subprotocol 鉴权变体(浏览器路径);serve-token JSON 化与 --port 收紧`

### Task 2: pnpm workspace + gui 包骨架

**Files:**
- Create: `pnpm-workspace.yaml`、`gui/package.json`、`gui/tsconfig.json`、`gui/vite.config.ts`、`gui/index.html`、`gui/src/main.tsx`、`gui/src/App.tsx`、`gui/src/connection.ts`、`gui/src/projection.ts`、`gui/src/App.test.tsx`
- Modify: 主仓 `.gitignore`(+`gui/node_modules`、`dist-gui/`)

**Interfaces:**
- Consumes: T1 snapshot 响应形态
- Produces(T3/G3+ 依赖):
  - `createConnection(opts: { baseUrl: string; token: string }): Connection`——`Connection { snapshot(): Promise<SnapshotResponse>; subscribe(cb: (e: SessionEvent) => void): () => void; submit(goal: string): Promise<void>; interrupt(): Promise<void>; close(): void; state(): 'connecting' | 'open' | 'closed' }`(WS 用 subprotocol `bearer.<token>`;重连 G3)
  - `gui/src/projection.ts`:`export { applyBoardEvent, emptyBoard } from '../../src/taskboard/model'; export { applyDelegation } from '../../src/delegation/projection'; export type { TaskBoardState, BoardTask } from '../../src/taskboard/model'; export type { Delegation } from '../../src/delegation/projection';`
  - `App.tsx`:顶栏(连接态点/status)+ 转录列表(messages.md 渲染纯文本,md 库 G3)+ 板列表(`t1 [pending] A` 行)——纯 snapshot 渲染,零交互
  - vitest 冒烟:App.test.tsx 起 jsdom,喂假 snapshot prop 断言渲染行(连接层不真连)

- [ ] **Step 1: 脚手架+测试**(App.test 先行:App 接 `snapshot: SnapshotResponse` prop 渲染)→ **Step 2: `pnpm --filter gui test` 红** → **Step 3: 实现**(vite 版本选稳定 v5;react 18 对齐主仓;vitest+jsdom+@testing-library/react;workspace packages ['gui'];**主仓 `pnpm install` 后 tsc/test 不受扰**——`pnpm build` 验证)
- [ ] **Step 4: 验证** `pnpm --filter gui test && pnpm build && node --test dist/serve/daemon.contract.test.js`(主仓面零扰)→ **Step 5: 提交** `feat(gui): pnpm workspace + gui 包骨架——Vite/React/vitest;连接层(subprotocol 鉴权/snapshot/subscribe);投影同源 re-export(主仓 TS 源直 import);App 骨架纯渲染`

### Task 3: 无头验收 + 门禁 + spec 回写(控制器)

- [ ] **无头验收**(gui 侧集成测试 `gui/src/e2e.test.ts`):主仓 dist 起真 GuiDaemon(ScriptedAdapter 两卡:工具卡+done)→ createConnection(snapshot+subscribe)→ submit → 等事件流 done → 再 snapshot → 断言 messages 增长(user+assistant)且板/委派影子在场 → App 组件以该 snapshot 渲染断言行文本(spec §12 G2 验收「snapshot 渲染出静态转录与板」)。跨包 import 主仓 dist:`import { GuiDaemon } from '../../dist/serve/daemon'`(裁定:gui 测试依赖主仓先 build——`pnpm --filter gui test` 前置 `pnpm build`,写进 gui package.json scripts.pretest)
- [ ] `pnpm --filter gui test` 绿;主仓 `pnpm test` 后台全量绿;`pnpm selfcheck`
- [ ] GUI spec §12 G2 行回写(含 Ruling 1 转录源偏离记录);提交 `docs(spec): G2 执行回写`
