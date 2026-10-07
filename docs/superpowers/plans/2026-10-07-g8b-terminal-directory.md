# G8b 终端全链(Pty) + 目录标签 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 依 G8 spec §2「终端」「目录」两行交付真 PTY 交互终端(node-pty+xterm.js,专用 WS 双向流+64KB 环形缓冲断线重放,「等同本地」口径)与工作区文件树目录标签。

**Architecture:** 主仓新增 PtyManager(src/serve/pty.ts,通用 spawn/环形缓冲/kill,owner 维度批量清杀)+ daemon 三接线(分配/kill 两 HTTP 路由、upgrade 路径分支出 pty 专用 WS、teardown 两处插杀);gui 侧 pty-codec(纯帧编解码)+PtySocket(裸 WS 客户端)+TerminalTab(xterm 渲染,jsdom 守卫)+DirectoryTab(逐层惰拉,点文件开文件标签)。pty 生命周期绑**标签**(关标签=kill),非组件挂载。

**Tech Stack:** node-pty(主仓,win32 conpty)+@types/node-pty;@xterm/xterm+@xterm/addon-fit(gui);其余全既有。

**Spec:** `docs/superpowers/specs/2026-10-07-gui-redesign-design.md`(v8)§2 终端/目录行+§0 ②③+U-D4/U-D5/U-D6/U-D13。

## Global Constraints

- **主仓改动白名单**:src/serve/pty.ts(新)/src/serve/daemon.ts/src/serve/pty.test.ts(新)/src/serve/daemon.test.ts/package.json/pnpm-lock.yaml;**gui 改动白名单**:gui/src/tabs/(pty-codec.ts/PtySocket.ts/TerminalTab.tsx/DirectoryTab.tsx/registry.tsx/tab-state 无改)/gui/src/connection.ts/gui/src/App.tsx/gui/src/App.test.tsx/gui/src/e2e.test.ts/gui/package.json/gui pnpm 经根 lockfile。越界即违规。
- 依赖:主仓仅 `node-pty`+`-D @types/node-pty`;gui 仅 `@xterm/xterm`+`@xterm/addon-fit`。**T1 若 node-pty 安装/加载受阻(预编译缺席且无 VS Build Tools)→ STOP 报 BLOCKED**,降级裁定(备选 `@lydell/node-pty`)归控制器,不得自选。
- PTY 语义(spec U-D4/5/6):分配走 HTTP,流走专用 WS(不复用 /events 事件 WS);64KB 环形缓冲,attach 即重放;**PTY 免审批门**(用户直打);cwd=会话 root;shell=win32 `powershell.exe`/其余 `$SHELL ?? '/bin/bash'`。
- 帧协议(JSON text,`b` 字段 base64(utf8)):C→S `{"t":"in","b"}`/`{"t":"resize","cols":N,"rows":N}`;S→C `{"t":"replay","b"}`(attach 首帧)/`{"t":"data","b"}`/`{"t":"exit","code":N}`/`{"t":"error","message"}`。
- 目录(tree)语义(spec U-D13):单层列举;判界同 /file(realPathOf+insideTrustedRoots);默认忽略 `.git`/`node_modules`/`dist`/`dist-gui`;单层上限 500 条+`truncated:true`;目录先序字母序;`path` 缺省 `''`=会话 root。
- 杀链三口:关终端标签(gui→DELETE)/会话 dispose(daemon killAllFor)/daemon teardown(全杀)。
- 测试钩子 class 原名保留;新结构 sx- 前缀;watchdog 协议:逐任务聚焦测试,T8 才跑全量。
- gui 命令 `pnpm --dir gui …`;主仓 `pnpm build` 后 `node --test dist/…`;提交规约 `feat(gui)/feat(serve)/fix(…)`;git add 仅点名文件。

## File Structure

```
src/serve/pty.ts              [T2] PtyManager:spawn/ring/write/resize/kill/killAllFor
src/serve/pty.test.ts         [T2] 真进程测(node -e 定向,跨平台零 shell 依赖)
src/serve/daemon.ts           [T3] 两路由+upgrade 分支+pty WS 会话+teardown 插杀;[T4] handleTree
src/serve/daemon.test.ts      [T3/T4] 增面
gui/src/tabs/pty-codec.ts     [T5] 帧编解码纯函数
gui/src/tabs/PtySocket.ts     [T5] 裸 WS 客户端(wsFactory 注入可测)
gui/src/connection.ts         [T5] openPty/killPty;[T7] tree
gui/src/tabs/TerminalTab.tsx  [T6] xterm+fit+jsdom 守卫+生命周期上报
gui/src/tabs/DirectoryTab.tsx [T7] 树组件(逐层惰拉)
gui/src/tabs/registry.tsx     [T6] terminal 注册+mintParams;[T7] directory 注册+TabRenderProps.openTab
gui/src/App.tsx               [T6] ptyIdsRef+关标签 kill+onPtyAllocated;[T7] openTab 传入 render
gui/src/App.test.tsx          [T6/T7] 增例
gui/src/e2e.test.ts           [T8] 两新场景(目录树开文件/pty 全链)
```

---

### Task 1: 依赖落装与加载验通

**Files:**
- Modify: `package.json` / `pnpm-lock.yaml`(经 pnpm add,不手编)
- Modify: `gui/package.json`(经 pnpm --dir gui add)

**Interfaces:**
- Produces: `import * as pty from 'node-pty'`(主仓,类型来自 @types/node-pty);`import { Terminal } from '@xterm/xterm'` + `import { FitAddon } from '@xterm/addon-fit'`(gui)。

- [ ] **Step 1: 安装(主仓)**

```bash
pnpm add node-pty && pnpm add -D @types/node-pty
```

预期:安装成功;若编译失败/报 node-gyp/MSBuild 缺失 → **STOP,返回 BLOCKED**(附完整错误输出,不得自选替代)。

- [ ] **Step 2: 加载+spawn 冒烟(node -e,不落测试文件)**

```bash
node -e "const pty=require('node-pty');const p=pty.spawn(process.execPath,['-e','process.stdout.write(\"pty-ok\")'],{name:'xterm',cols:80,rows:24,cwd:process.cwd(),env:process.env});let out='';p.onData(d=>out+=d);p.onExit(({exitCode})=>{console.log('OUT['+out.trim()+']EXIT['+exitCode+']');if(!out.includes('pty-ok')||exitCode!==0)process.exit(1);});"
```

预期:输出 `OUT[pty-ok]EXIT[0]`,退出码 0。

- [ ] **Step 3: 安装(gui)+主仓编译面**

```bash
pnpm --dir gui add @xterm/xterm @xterm/addon-fit && pnpm build
```

预期:两者皆绿(pnpm build 证明 node-pty 类型/加载与主仓 tsc 无冲突)。

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml gui/package.json
git commit -m "feat(serve): G8b-T1 终端依赖落装——node-pty+@types+xterm 双件,加载与 spawn 冒烟验通"
```

---

### Task 2: PtyManager(src/serve/pty.ts)

**Files:**
- Create: `src/serve/pty.ts`
- Test: `src/serve/pty.test.ts`

**Interfaces:**
- Produces(T3 消费,签名逐字):

```ts
export interface PtySpawnOptions {
  readonly file: string; readonly args: readonly string[];
  readonly cwd: string; readonly cols: number; readonly rows: number;
  readonly owner: string;                      // 会话 id(daemon 传入)——killAllFor 锚
  readonly env?: Readonly<Record<string, string>>;
}
export interface PtySession {
  readonly id: string;
  write(data: string): void;                   // UTF-8 直写(输入链)
  resize(cols: number, rows: number): void;
  kill(): void;
  replay(): string;                            // 环形缓冲尾部(UTF-8 文本,≤ RING_LIMIT chars)
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;    // 触发后自动注销条目(has→false)
}
export const RING_LIMIT = 65536;
export class PtyManager {
  spawn(id: string, opts: PtySpawnOptions): PtySession;   // id 撞名 throw `pty id exists: ${id}`
  get(id: string): PtySession | undefined;
  has(id: string): boolean;
  kill(id: string): void;                                   // 无此 id 静默(幂等)
  killAllFor(owner: string): void;                          // 该 owner 全部 kill(daemon dispose/teardown 消费)
  readonly size: number;                                    // 活跃条目数(测试断言清杀净)
}
```

- [ ] **Step 1: 写失败测试(src/serve/pty.test.ts 全量)**

```ts
import * as test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PtyManager, RING_LIMIT } from './pty.js';

const cwd = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pty-t-'));

/** 跨平台定向:spawn 宿主 node 直跑 -e,零 shell 依赖(win32 conpty 真进程) */
const ECHO = (s: string): { file: string; args: string[] } => ({ file: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(s)})`] });

test('spawn→data→exit 链与幂等 kill', async () => {
  const m = new PtyManager();
  const s = m.spawn('p1', { ...ECHO('hello-pty'), cwd: cwd(), cols: 80, rows: 24, owner: 's1' });
  assert.equal(m.has('p1'), true);
  const got = new Promise<string>((r) => { let acc = ''; s.onData((d) => { acc += d; }); s.onExit(() => r(acc)); });
  const code = new Promise<number>((r) => s.onExit((c) => r(c)));
  assert.equal((await got).includes('hello-pty'), true);
  assert.equal(await code, 0);
  assert.equal(m.has('p1'), false);            // exit 自动注销
  m.kill('p1');                                 // 幂等:不抛
  m.kill('ghost');                              // 无此 id 静默
});

test('kill 中止活进程并触发 exit 注销', async () => {
  const m = new PtyManager();
  const s = m.spawn('p2', { file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: cwd(), cols: 80, rows: 24, owner: 's1' });
  const exited = new Promise<number>((r) => s.onExit((c) => r(c)));
  s.kill();
  const c = await exited;
  assert.notEqual(c, 0);                        // 被 kill,非零退出
  assert.equal(m.has('p2'), false);
});

test('环形缓冲:超限输出仅保尾部 RING_LIMIT;未超限全量', async () => {
  const m = new PtyManager();
  const big = 'x'.repeat(RING_LIMIT + 4096);
  const s = m.spawn('p3', { ...ECHO(big), cwd: cwd(), cols: 80, rows: 24, owner: 's1' });
  await new Promise<void>((r) => s.onExit(() => r()));
  assert.equal(s.replay().length, RING_LIMIT);  // 恰尾部
  assert.equal(s.replay().endsWith('x'), true);
  const s2 = m.spawn('p4', { ...ECHO('tiny'), cwd: cwd(), cols: 80, rows: 24, owner: 's2' });
  await new Promise<void>((r) => s2.onExit(() => r()));
  assert.ok(s2.replay().includes('tiny'));      // 未超限全量(含可能的环境回显,故 includes)
});

test('killAllFor 按 owner 批量清杀;size 归零', async () => {
  const m = new PtyManager();
  const mk = (id: string, owner: string) => m.spawn(id, { file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: cwd(), cols: 80, rows: 24, owner });
  const a1 = mk('a1', 's1'); const a2 = mk('a2', 's1'); mk('b1', 's2');
  assert.equal(m.size, 3);
  const gone = Promise.all([new Promise<void>((r) => a1.onExit(() => r())), new Promise<void>((r) => a2.onExit(() => r()))]);
  m.killAllFor('s1');
  await gone;
  assert.equal(m.has('a1'), false); assert.equal(m.has('a2'), false);
  assert.equal(m.size, 1);                      // s2 的 b1 存活
  m.killAllFor('s2');
  assert.equal(m.size, 0);
});

test('id 撞名 throw', () => {
  const m = new PtyManager();
  const o = { ...ECHO('a'), cwd: cwd(), cols: 80, rows: 24, owner: 's1' };
  m.spawn('dup', o);
  assert.throws(() => m.spawn('dup', o), /pty id exists/);
  m.killAllFor('s1');
});
```

- [ ] **Step 2: 跑测确认失败**

```bash
pnpm build && node --test dist/serve/pty.test.js
```

预期:FAIL(模块不存在/构建失败)。

- [ ] **Step 3: 实现 pty.ts**

要点:`import * as pty from 'node-pty'`;spawn 建条目(内部 Map);`onData/onExit` 直挂 pty 进程事件(多订阅支持:回调数组);数据入环形缓冲(字符串追加后 `if (ring.length > RING_LIMIT) ring = ring.slice(-RING_LIMIT)`);exit → 注销+通知+close;kill → `proc.kill()`(win32 conpty 树杀);`killAllFor` 遍历 owner 匹配;`size` getter。

- [ ] **Step 4: 跑测通过**

```bash
pnpm build && node --test dist/serve/pty.test.js
```

预期:5/5 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/serve/pty.ts src/serve/pty.test.ts
git commit -m "feat(serve): G8b-T2 PtyManager——spawn/环形缓冲 64KB/resize/kill/owner 批量清杀"
```

---

### Task 3: daemon 接线(路由×2 + upgrade 分支 + pty WS + teardown 插杀)

**Files:**
- Modify: `src/serve/daemon.ts`
- Test: `src/serve/daemon.test.ts`(增 describe)

**Interfaces:**
- Consumes: T2 PtyManager 全 API。
- Produces(T5/T6/e2e 消费):HTTP `POST /session/:id/pty` body `{cols?:number,rows?:number}` → 200 `{ptyId}`(cols/rows 缺省 80/24;未知会话 404 既有 `sessionFor` 语义);`DELETE /session/:id/pty/:ptyId` → 200 `{ok:true}`(幂等);WS 升级路径 `^/session/([^/]+)/pty/([^/]+)$`(鉴权同双形态:Bearer 头或 `bearer.<token>` subprotocol;ptyId 不在 Manager → 升级后即发 `{"t":"error","message":"pty not found"}` 后 close)。

**升级分支骨架(attachWs 内改):**

```ts
server.on('upgrade', (req, socket, head) => {
  const viaHeader = req.headers.authorization === `Bearer ${token}`;
  const viaSubprotocol = req.headers['sec-websocket-protocol'] === `bearer.${token}`;
  if (this.closePromise || (!viaHeader && !viaSubprotocol)) { /* 既有 401 拒绝 */ }
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  const m = /^\/session\/([^/]+)\/pty\/([^/]+)$/.exec(pathname);
  if (m) { wss.handleUpgrade(req, socket, head, (ws) => this.onPtyConnection(ws, decodeURIComponent(m[1]!), decodeURIComponent(m[2]!))); return; }
  wss.handleUpgrade(req, socket, head, (ws) => this.onWsConnection(ws));
});
```

**onPtyConnection(ws, sessionId, ptyId):**
- `get(ptyId)` 缺 → send error 帧 + close(1008)。
- attach 即 `send({"t":"replay","b":base64(session.replay())})`(断线重连重放,spec U-D5)。
- 挂 `session.onData(d => ws.readyState===OPEN && send {"t":"data",b:base64(d)})`;`onExit(code => send {"t":"exit",code} 且 ws.close(1000))`。
- ws 'message':JSON.parse 容错(坏帧忽略);`t==='in'` → `session.write(utf8(base64 decode b))`;`t==='resize'` → cols/rows 正整数校验后 resize。
- ws 'close' → 解绑回调(onData/onExit 需可注销:T2 回调挂的是 daemon 侧闭包,close 时置 attached=false 门+`get` 判存);**close≠kill**(标签关闭走 DELETE,断线保活——重连重放语义)。
- pty WS 客户端 Set 独立(ptySockets),复用 heartbeat ping 面(同 wsLastPong 计时);daemon close 时随 wss.close 一并退场。

**teardown 插杀两处:**
- 单会话 `handleDelete`/`dispose` 收口处(SessionRuntime.dispose 后)——daemon 侧该会话 `pty.killAllFor(sessionId)`(daemon 持 manager,session.ts 不引 pty,保持 serve 分层)。
- `teardown()` 步 0b 之后加 `this.ptyManager.killAllFor('*')`——实现为直接遍历全部 kill(或 `for (const id of [...sessions.keys()]) killAllFor(id)`;取简:Manager 加无 owner 过滤的全杀遍历,即对内部 Map 全量 kill)。

**daemon.test 增面(真 node-pty,同 T2 定向法):**

```ts
test('pty 全链:分配→WS 回环→重放→kill', async () => {
  // 既有 startDaemon 装配样例(文件内既有 helper);token/port 同款
  // 1) POST /session/:id/pty {cols:80,rows:24} → {ptyId}
  //    body 传 {file:process.execPath,args:['-e','process.stdout.write("pty-e2e")']}? —— 否:分配端点不收 file/args(shell 探测 daemon 内定),测试以默认 shell 起 + 写入 echo 命令:
  //    实测法:分配后 WS 连入,收 replay(可能空)→ send in(base64(`node -e "process.stdout.write('pty-e2e')"\r`))→ 轮询收 data 帧直至含 'pty-e2e'(默认 shell 下命令行可用;win32 powershell 同串合法)
  // 2) 断线重连:关第一个 WS → 新 WS 连入 → 首帧 replay 含 'pty-e2e'(环形缓冲重放)
  // 3) DELETE /session/:id/pty/:ptyId → {ok:true} → WS 收 exit 帧(非零)→ close;再 DELETE 幂等 {ok:true}
  // 4) 会话 delete → pty 全杀(分配第二台 setInterval 存活 → DELETE session → killAllFor 生效:新 WS 连入收 error 'pty not found')
});
test('pty 鉴权:错 token 升级拒 401;未知 ptyId 升级即 error 帧', async () => { /* 直接 socket.write 401 面;合法 token+未知 id → error 帧+close */ });
```

(测试装配具体化由实现者按 daemon.test.ts 既有 startDaemon/token/ws stub 惯例落;断言面如上四条+鉴权两条,不得缺。)

- [ ] **Step 1: 写失败测试(daemon.test.ts 增两 test)** — 按上述断言面
- [ ] **Step 2: `pnpm build && node --test dist/serve/daemon.test.js` 确认新面 FAIL**
- [ ] **Step 3: 实现(路由/分支/onPtyConnection/teardown 插杀/manager 持有 `private readonly ptyManager = new PtyManager()` + ptyId 计数 `pty-<n>`)**
- [ ] **Step 4: 同命令全绿(既有 daemon 面零破坏)**
- [ ] **Step 5: Commit**

```bash
git add src/serve/daemon.ts src/serve/daemon.test.ts
git commit -m "feat(serve): G8b-T3 daemon pty 接线——分配/kill 路由+专用 WS(重放/双向/exit)+teardown 两处插杀"
```

---

### Task 4: tree 端点(GET /session/:id/tree)

**Files:**
- Modify: `src/serve/daemon.ts`(handleTree+路由表一行)
- Test: `src/serve/daemon.test.ts`(增 describe)

**Interfaces:**
- Produces(T7 gui connection.tree 消费):`GET /session/:id/tree?path=<rel>` → 200 `{entries:[{name,kind:'dir'|'file'}], truncated?:true}`;判界同 handleFile(realPathOf→insideTrustedRoots,403 `path outside trusted roots`);缺 path 参数=根(`''`);不存在 404 `{error:'not found'}`;非目录 400 `{error:'not a directory'}`;忽略名集 `IGNORED = new Set(['.git','node_modules','dist','dist-gui'])`;上限 500(目录先序字母序,超限截断+truncated)。

- [ ] **Step 1: 写失败测试**

```ts
test('tree:单层列举/忽略集/上限截断/判界 403/根缺省', async () => {
  // 会话 root 内造:dirA/(含 fileA.ts+sub/)、fileB.ts、.git/(忽略)、node_modules/(忽略)、dist/(忽略)
  // GET tree → entries=[{dirA,dir},{fileB.ts,file}] 目录先序字母序;sub/ 不在(单层)
  // dirA 内造 501 项 → tree?path=dirA → truncated:true 且 entries.length===500
  // tree?path=../<tmp 外目录> → 403;tree?path=nope → 404;tree?path=fileB.ts → 400
});
```

- [ ] **Step 2: `pnpm build && node --test dist/serve/daemon.test.js` FAIL**
- [ ] **Step 3: 实现 handleTree(fs.readdirSync withFileTypes→过滤 IGNORED→sort(目录先,同名段字母)→slice(0,500))**
- [ ] **Step 4: 同命令全绿**
- [ ] **Step 5: Commit**

```bash
git add src/serve/daemon.ts src/serve/daemon.test.ts
git commit -m "feat(serve): G8b-T4 tree 端点——单层列举/忽略集/500 上限/判界同 file"
```

---

### Task 5: gui pty 客户端层(codec + PtySocket + connection 方法)

**Files:**
- Create: `gui/src/tabs/pty-codec.ts` / `gui/src/tabs/PtySocket.ts`
- Create: `gui/src/tabs/pty-client.test.ts`
- Modify: `gui/src/connection.ts`(openPty/killPty 两方法)

**Interfaces:**
- Produces(T6 消费,签名逐字):

```ts
// pty-codec.ts(纯函数,零依赖)
export function encIn(data: string): string;                 // {"t":"in","b":btoa(UTF-8 安全)}
export function encResize(cols: number, rows: number): string;
export type PtyFrame = { t: 'replay' | 'data'; b: string } | { t: 'exit'; code: number } | { t: 'error'; message: string };
export function decFrame(raw: string): PtyFrame | null;      // 坏 JSON/未知 t → null
export function b64ToUtf8(b: string): string;                // TextCodec 双向(UTF-8 多字节安全,btoa/atob 直裸不可用于中文)

// PtySocket.ts(事件化客户端;wsFactory 注入=可测)
export type PtySocketState = 'connecting' | 'open' | 'closed';
export interface PtySocketOpts { url: string; token: string; onFrame(f: PtyFrame): void; onState(s: PtySocketState): void; wsFactory?: (url: string, protocol: string) => { send(s: string): void; close(): void; on(ev: string, cb: (arg?: unknown) => void): void } }
export class PtySocket {
  constructor(opts: PtySocketOpts);                          // 构造即连(唯一协议 bearer.<token>)
  sendInput(data: string): void; resize(cols: number, rows: number): void; dispose(): void;
  get state(): PtySocketState;
}

// connection.ts(Connection 类内,postJson/getJson 既有基建)
openPty(sessionId: string, cols?: number, rows?: number): Promise<{ ptyId: string }>;
killPty(sessionId: string, ptyId: string): Promise<void>;
```

- [ ] **Step 1: 写失败测试(pty-client.test.ts)** — codec 纯测(UTF-8 中文回环/坏帧 null/enc 形状)+ PtySocket 状态机(stub wsFactory:open→onState('open')/server 推 data 帧→onFrame/坏帧吞/sendInput 走 send/dispose→close→onState('closed'))
- [ ] **Step 2: `pnpm --dir gui exec vitest run src/tabs/pty-client.test.ts` FAIL**
- [ ] **Step 3: 实现(codec 用 TextEncoder/Decoder+btoa/atob 组合;PtySocket on('message')→decFrame→onFrame,on('open'/'close')→onState)**
- [ ] **Step 4: 同命令 PASS + `pnpm --dir gui run typecheck`**
- [ ] **Step 5: Commit**(`git add gui/src/tabs/pty-codec.ts gui/src/tabs/PtySocket.ts gui/src/tabs/pty-client.test.ts gui/src/connection.ts`,message `feat(gui): G8b-T5 pty 客户端层——UTF-8 安全编解码+PtySocket 状态机+connection 两方法`)

---

### Task 6: 终端标签(registry+TerminalTab+App 生命周期)

**Files:**
- Create: `gui/src/tabs/TerminalTab.tsx`
- Modify: `gui/src/tabs/registry.tsx`(terminal 注册+mintParams)/`gui/src/tabs/tab-state.ts`(TabParams 增 `readonly nonce?: string` 一字段,其余零改动)/`gui/src/App.tsx`/`gui/src/App.test.tsx`

**Interfaces:**
- Consumes: T5 PtySocket/codec + connection.openPty/killPty;既有 tab-state(TabTypeId 已含 'terminal')/TabStrip +菜单。
- Produces:

```ts
// registry.tsx 扩(TabTypeEntry 增可选字段;tab-state 零改动)
export interface TabTypeEntry { /* 既有五字段 */ readonly mintParams?: () => TabParams; }
// terminal 条目:group 'tools';title ()=>'终端';resolveKey (p)=> p.nonce ?? '';singleton false;
// mintParams () => ({ nonce: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}` })
// render: (p) => <TerminalTab conn sessionId params onPtyAllocated uid />

// TerminalTab.tsx
export interface TerminalTabProps { conn: Connection; sessionId: string; params: TabParams; uid: string; onPtyAllocated(uid: string, ptyId: string): void; onOpenTab(type: TabTypeId, params?: TabParams): void }
// App.tsx:ptyIdsRef = useRef(Map<string,string>)(uid→ptyId);
// TabStrip onClose 处理链前置:const t = 关闭标签; t?.type==='terminal' → ptyIdsRef.get(uid) 存在 → void conn.killPty(openSessionId, id)(fire-and-forget) + ref.delete
// onOpenType 处理:openTabInSession(type, tabEntry(type).mintParams?.())
// render props 增传 onPtyAllocated={(uid, id) => ptyIdsRef.current.set(uid, id)}
```

**TerminalTab 行为:**
- mount:容器 div(sx-tabbody 内满高,ref);**jsdom 守卫**:`clientWidth===0 || clientHeight===0` → 渲染降级面 `<div className="sx-pty-fallback">终端渲染需要真浏览器窗口</div>`(App.test 断言面;真浏览器 clientWidth>0 走 xterm)。
- 真初始化序:`await conn.openPty(sessionId, 80, 24)` → onPtyAllocated → new Terminal({theme 取 app.css 令牌色})+FitAddon+open(container) → new PtySocket(url `/session/${sessionId}/pty/${ptyId}`, token) → onFrame replay/data → term.write(utf8);exit → term.write 换行提示+state 条;error → 行内错误。
- `term.onData(d => socket.sendInput(d))`;FitAddon fit 后 `socket.resize(term.cols, term.rows)`;容器 ResizeObserver → fit+resize。
- 卸载:socket.dispose()+term.dispose();**不 kill**(kill 归标签关闭链,App 管)。
- xterm CSS:`import '@xterm/xterm/css/xterm.css'`(TerminalTab 顶部,vite 全局注入)。

**App.test 增例:**
1. +菜单开终端 → 终端标签在场(mintParams nonce 生效,两次开=两标签);App.test 桩 conn.openPty 返回 `{ptyId:'p1'}`;jsdom 守卫降级面渲染断言;onPtyAllocated 记录(uid→p1)。
2. 关终端标签 → conn.killPty 被调(桩 spy,参数 sessionId+ptyId);会话切走(backHome)不 kill。
- [ ] **Step 1: 写失败测试** → [ ] **Step 2: 跑 FAIL** → [ ] **Step 3: 实现** → [ ] **Step 4: `pnpm --dir gui exec vitest run src/App.test.tsx`+typecheck 全绿** → [ ] **Step 5: Commit**(`feat(gui): G8b-T6 终端标签——xterm+PtySocket 装配/nonce 多实例/关标签 kill 链/jsdom 守卫`)

---

### Task 7: 目录标签(TabRenderProps.openTab + DirectoryTab + connection.tree)

**Files:**
- Create: `gui/src/tabs/DirectoryTab.tsx`
- Modify: `gui/src/tabs/registry.tsx`(TabRenderProps 增 openTab+directory 注册)/`gui/src/connection.ts`(tree 方法)/`gui/src/App.tsx`(render props 传 openTabInSession)/`gui/src/App.test.tsx`

**Interfaces:**

```ts
// registry.tsx:TabRenderProps 增 readonly openTab: (type: TabTypeId, params?: TabParams) => void;
// directory 条目:group 'content';title ()=>'目录';singleton true;resolveKey ()=>'';
// render: (p) => <DirectoryTab conn sessionId openTab={p.openTab} />
// connection.ts:tree(sessionId: string, path?: string): Promise<{ entries: Array<{ name: string; kind: 'dir' | 'file' }>; truncated?: boolean }>
```

**DirectoryTab 行为:** mount 拉 root(`tree(sessionId)`)→ 行列表(目录 `ChevronRight` 旋态+Folder/文件 FileText 图标+名字;sx- 类);目录行点击=惰拉单层(展开态 Map<path,entries>,收起保留缓存);文件行点击=`openTab('file', { path })`(相对路径以 root 起,判界一致性由服务端保证);truncated → 行尾「…已截断」badge;错误行内;加载态行内。相对路径拼合:子层 path = 父 path ? `${父}/${name}` : name。

**App.test 增例:** +菜单开目录(单例:两次开=一标签)→ 桩 conn.tree 两级(root→dirA{sub}/fileB)→ 展开 dirA → 点 fileB → 断言文件标签开且活动(title=fileB 路径)。
- [ ] **Step 1-5 同 TDD 循环**(`pnpm --dir gui exec vitest run src/App.test.tsx`;commit `feat(gui): G8b-T7 目录标签——逐层惰拉树/点文件开标签/单例注册`)

---

### Task 8: 收口门禁 + e2e 两场景 + spec 注记

**Files:**
- Modify: `gui/src/e2e.test.ts`(两新场景)/`docs/superpowers/specs/2026-10-07-gui-redesign-design.md`(G8b 行注记)

**e2e 场景(真 daemon dist,既有 startDaemon 惯例):**
1. **目录树开文件**:fixture 造 dirA/fileA.ts → 建会话 → +菜单开目录标签 → 展开/点文件 → 断言文件标签活动且内容加载。
2. **pty 全链**(不走 xterm 渲染——jsdom 限制,TerminalTab 降级面在场断言;链路以裸 WS 验):`POST /session/:id/pty` → 裸 ws(node ws,subprotocol bearer)连入 → 收 replay 帧 → 发 in(node -e 输出标记串)→ 轮询 data 帧含标记 → 关 ws → 重连 → replay 含标记(环形缓冲)→ DELETE kill → 收 exit 帧。

**门禁:** `pnpm --dir gui test`(全量,含新文件)→ `pnpm --dir gui run test:e2e`(15 场景)→ `pnpm build && node --test dist/serve/daemon.test.js dist/serve/session.test.js dist/serve/pty.test.js`。spec G8b 行划线注记(格式同 G8a 行)。

- [ ] **Step 1-5 同循环**(commit `feat(gui): G8b-T8 e2e 两场景+全量门禁+spec 注记`——两提交拆分亦可:先 e2e 提交,后 spec 注记提交)

---

## Self-Review(已执行)

1. **Spec 覆盖**:§2 终端行(分配/专用 WS/帧四类/环形/清杀三口/shell 探测/cwd/免审批)=T1-T3,T5-T6;§2 目录行(单层/忽略/500/点文件开标签/单例)=T4,T7;U-D5 重放=T2 缓冲+T3 attach;×菜单分组 'tools'/'content' 由 registry group 字段自动落位。缺口:无(spec 的「标签关闭/会话 teardown/daemon 退出=kill」三口分别在 T6/T3/T3 落)。
2. **占位扫描**:T3 daemon.test 断言面以注释规格给出四+两条(装配沿用文件既有 helper 属实指称,非「适当处理」);其余任务测试代码全量。无 TBD。
3. **类型一致**:PtyManager.spawn(id, opts) T2 定义=T3 用;encIn/decFrame/PtySocket T5=T6 用;mintParams/openTab 扩展只在 registry.tsx 单点定义;connection.openPty/killPty/tree 名称前后一致;TabParams 既有 cols/rows/nonce 字段(T2 tab-state TabParams 已含 cols/rows,nonce 为 params 任意字段——tab-state TabParams 无 nonce 字段!→ 裁定:nonce 走 `params.path` 复用会污染语义,故 T6 明确 **tab-state.ts 的 TabParams 增 `readonly nonce?: string`** ——该文件 T6 文件清单未列,修:T6 Modify 增 `gui/src/tabs/tab-state.ts`(仅加一可选字段,测试零迁移)。
