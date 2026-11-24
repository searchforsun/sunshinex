# 远程工作区(SSH)实施计划(阶段一骨架 + 阶段二 serve 全量 + 阶段三 GUI 完形)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任意多台远程 SSH 主机上的项目目录以一等工作区身份进入项目分组与 Sunx 域——GUI 单连接不动、
daemon 回环绑定不动、远程零网络监听;agent 循环本地驱动,远程跑自部署的纯 JS server bundle。

**Architecture:** daemon 网关共存——`ssh://<hostId>/<路径>` 形态 root 经 `src/config/root-scheme.ts`
单点谓词分发;连接池按 hostId 持 ssh2 常驻连接(exec channel 跑 sunx-remote 帧协议 + SFTP 子系统 +
pty channel 三通道并存);执行后端经 `SshBackend implements ToolBackend` 兑现 types.ts:494 预留位;
serve 层各 handler 按工作区形态路由;GUI 仅 DirPicker 远程页 + 设置页主机 pane + 徽标。

**Tech Stack:** TypeScript strict;运行时唯一新依赖 **ssh2 ^1.x**(+devDep esbuild 打 server bundle、
@types/ssh2);后端测试 node:test + assert/strict;GUI 测试 vitest + @testing-library/react。

**Spec:** `docs/superpowers/specs/2026-11-24-remote-workspace-ssh-design.md`(计划与 spec 配套阅读;
本文 §号引用均指 spec 章节)

**范围裁定:** 本计划 = spec §12 三阶段全量。演进节(便携 node/断线续跑/wsl/docker/handoff)→ 后续
计划。Task 4(协议)与 Task 6(server bundle)是一对:server 侧实现与 client 侧编解码同 task 交付,
内存夹具互测。

## Global Constraints

- **运行时唯一新 npm 依赖 `ssh2`**;`esbuild`、`@types/ssh2` 仅 devDependencies(build/类型)。
  ssh2 候选池转正记录写入 `CLAUDE.md §5` 依赖台账(维护活跃/类型完善/许可证 BSD-2)。
- **root URI 禁本地 path API**:`ssh://` 形态 root 严禁进 `path.resolve/join/basename`——一律先过
  `src/config/root-scheme.ts` 谓词(`isRemoteRoot/parseRemoteRoot/remoteRootOf`),路径段由远程侧解释。
  现有陷阱两处:`projectSlug`(data-dir.ts:20)与 `createSessionIn` 入口(session-lifecycle.ts:134)的
  `path.resolve`,Task 7/8 各自绕行。
- 回环绑定、WS 协议、session/kernel/steer 语义、会话数据布局(dataDir)**零改动**。
- 远程降级一律显式(报"remote project 不支持 X"类错误),不静默假成功。
- host key:known_hosts TOFU,指纹变化拒连(spec §10)。
- 测试写法照 `src/serve/schedules/*.test.ts`(`node:test` + `assert/strict`);目标文件跑法
  `npx tsc -p tsconfig.json && node --test dist/serve/remote/<文件>.test.js`;提交前全量 `pnpm test`。
  GUI:`cd gui && pnpm exec vitest run <文件>`。
- 测试禁真外连/真 sshd:协议与连接池用 ssh2 **server 模式内存夹具**(Task 3);SFTP 面走接口缝注
  内存假件;真 ssh 冒烟为可选 slow(spec §11),不进门禁。
- 注释中文、每文件头注写职责与裁定引用(house style);提交信息中文 conventional commits。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/config/root-scheme.ts` | `ssh://` 谓词/解析/拼装单点(零依赖叶子模块,config/serve/harness 共用) |
| `src/config/data-dir.ts`(改) | `projectSlug` 对远程 URI 绕 `path.resolve` |
| `src/serve/remote/protocol.ts` | sunx-remote 帧类型 + 编解码 + 行缓冲解析(§6) |
| `src/serve/remote/host-store.ts` | 主机档案 remote-hosts.json CRUD + quarantine(channels store 同款) |
| `src/serve/remote/testkit/memory-ssh-server.ts` | ssh2 server 模式内存夹具(exec 通道回放脚本) |
| `src/serve/remote/connection-pool.ts` | ssh2 Client 池:认证/host key TOFU/引用计数/keepalive/退避重连/server 拉起与协议会话 |
| `src/serve/remote/deployer.ts` | server bundle 部署:探测/版本比对/SFTP 上传/原子换装/sha256 复核 |
| `src/serve/remote/server/main.ts` | 远程 server 入口(stdin JSON-lines → exec 服务 → stdout 帧) |
| `scripts/bundle-remote-server.mjs` | esbuild 打 server.cjs 单文件 + 版本档 |
| `src/harness/security/ssh-sandbox.ts` | `SshBackend implements ToolBackend`(协议 exec + SFTP) |
| `src/harness/index.ts`(改) | BackendFactory:root scheme → sandbox 注入(装配单点 :267) |
| `src/serve/remote/handlers.ts` | `/remote/hosts` 族 + `/remote/dirpicker` HTTP 面 |
| `src/serve/daemon.ts`(改) | 池/部署器装配 + 路由表 + teardown + WorkspaceRow kind |
| `src/serve/workspace-handlers.ts` / `session-lifecycle.ts`(改) | 远程注册分支 / stat 门与 mint 分支 |
| `src/serve/file-handlers.ts` / `session-changes.ts` / `pty.ts`(改) | file/tree/git/pty 按形态路由 |
| `gui/src/connection-types.ts` / `connection-api.ts` / `connection.ts` | remote 族类型与端点封装 |
| `gui/src/pages/DirPicker.tsx`(改) | 本地/远程页签 + 主机下拉 + 远程目录浏览 |
| `gui/src/settings/RemoteHostsPane.tsx`(+groups/shell/search) | 主机管理 pane |
| `gui/src/sidebar/project-menu-projects.tsx` 等(改) | 远程徽标/Sunx 主机名/降级隐藏 |

---

### Task 1: root-scheme.ts + projectSlug 绕行

**Files:**
- Create: `src/config/root-scheme.ts`
- Modify: `src/config/data-dir.ts:20-29`(projectSlug)
- Test: `src/config/root-scheme.test.ts`

**Interfaces:**
- Produces: `isRemoteRoot(root: string): boolean`;`parseRemoteRoot(root: string): { hostId: string; path: string }`;`remoteRootOf(hostId: string, p: string): string`(path 段 encodeURIComponent)。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRemoteRoot, parseRemoteRoot, remoteRootOf } from './root-scheme';

test('ssh:// 谓词与解析', () => {
  assert.equal(isRemoteRoot('D:\\proj'), false);
  assert.equal(isRemoteRoot('ssh://01HX/proj'), true);
  const p = parseRemoteRoot('ssh://01HX/home/u/my%20proj');
  assert.deepEqual(p, { hostId: '01HX', path: '/home/u/my proj' });
});
test('拼装 roundtrip(路径含斜杠/空格/Unicode)', () => {
  const r = remoteRootOf('01HX', '/home/u/我的 项目');
  assert.equal(parseRemoteRoot(r).path, '/home/u/我的 项目');
});
```

- [ ] **Step 2: 跑失败** — `npx tsc -p tsconfig.json && node --test dist/config/root-scheme.test.js` → FAIL(模块不存在)

- [ ] **Step 3: 最小实现**(零依赖叶子;parse 用 `new URL` 会把路径段再编码,手拆前缀更稳):

```ts
const SCHEME = 'ssh://';
export function isRemoteRoot(root: string): boolean { return root.startsWith(SCHEME) && root.length > SCHEME.length; }
export function parseRemoteRoot(root: string): { hostId: string; path: string } {
  const rest = root.slice(SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) throw new Error(`invalid remote root: ${root}`);
  return { hostId: rest.slice(0, slash), path: decodeURIComponent(rest.slice(slash + 1)) };
}
export function remoteRootOf(hostId: string, p: string): string {
  return `${SCHEME}${hostId}/${encodeURIComponent(p).replace(/%2F/gi, '/')}`;
}
```

- [ ] **Step 4: projectSlug 绕行**(data-dir.ts:21 `const abs = path.resolve(root)` 改):

```ts
const key = isRemoteRoot(root) ? root : path.resolve(root);
const base = key.replace(...)  // 以下三段 replace/slice/digest 全部对 key,逻辑零变化
```

- [ ] **Step 5: 跑过 + 提交** — 上述单测 PASS + `node --test dist/config/data-dir.test.js` PASS;`git commit -m "feat(config): ssh:// 远程 root 形态谓词单点+projectSlug 绕行 path.resolve(spec 2026-11-24 §3)"`

### Task 2: protocol.ts —— sunx-remote 帧编解码

**Files:**
- Create: `src/serve/remote/protocol.ts`,Test 同目录

**Interfaces:**
- Produces: `RemoteHelloFrame{kind:'hello',version,protocol,node}`;`RemoteReqFrame{id,kind:'req',method,params}`;`RemoteResFrame{id,kind:'res',ok,result?,error?}`;`RemoteEvtFrame{kind:'evt',event,params}`;`encodeFrame(f): string`(JSON+\n);`FrameParser.push(chunk: string): RemoteFrame[]`(行缓冲,单帧 1MB 上限即整体 fail);`PROTOCOL_VERSION = 1`。

- [ ] **Step 1: 失败测试**(半包/粘包/坏 JSON/超限四锚):

```ts
const p = new FrameParser();
assert.deepEqual(p.push('{"kind":"hello",'), []);                       // 半包不吐
assert.deepEqual(p.push('"version":"1"}\n{"kind":"evt"'), []);          // 分界后仍欠
const frames = p.push(',"event":"x","params":{}}\n');                    // 粘包补齐
assert.equal(frames.length, 2);
assert.throws(() => p.push('not-json\n'));                               // 坏 JSON 抛
```

- [ ] **Step 2: 跑失败 → Step 3: 实现(行缓冲 + JSON.parse + 上限抛)→ Step 4: 跑过**

- [ ] **Step 5: Commit** — `feat(remote): sunx-remote 帧协议编解码(spec §6)`

### Task 3: host-store.ts + 连接池(含内存 ssh2 夹具)

**Files:**
- Create: `src/serve/remote/host-store.ts`、`src/serve/remote/testkit/memory-ssh-server.ts`、`src/serve/remote/connection-pool.ts`
- Test: 同目录三个 test 文件

**Interfaces:**
- host-store: `RemoteHost{id,name,host,port?,auth:'agent'|'key'|'password',keyPath?,keyPassphrase?,password?,enabled}`;`HostStore(file?)` 注入档路径(缺省 userConfigDir/remote-hosts.json);`list/add/update/remove(id)`;坏档 quarantine(channels store 同款);`referencingWorkspaces(id)` 供 409 判定。
- pool: `ConnectionPool`:`ensure(hostId): Promise<RemoteChannel>`(引用计数;连接+部署检查+server 拉起+hello 握手);`release(hostId)`(归零闲置 60s 收);`isReady(hostId): boolean`(同步,createSessionIn 门用);`stateOf(hostId)`;`close()`(teardown)。
- `RemoteChannel`(SshBackend 与 serve 路由共用面):
```ts
export interface RemoteChannel {
  execStart(params: { cmd: string; cwd: string; env?: Record<string,string>; timeoutMs?: number }): Promise<{ execId: string }>;
  execWait(execId: string, onStream?: (stream: 'stdout'|'stderr', chunk: string) => void): Promise<{ exitCode: number; aborted?: boolean }>;
  execKill(execId: string, signal?: string): Promise<void>;
  sftpRead(p: string): Promise<Buffer>;
  sftpWrite(p: string, content: Buffer): Promise<void>;   // 含父目录逐级 mkdir(ProcessSandbox.writeFile 同语义)
  sftpStat(p: string): Promise<{ isDirectory: boolean } | null>;
  sftpReaddir(p: string): Promise<string[]>;
  sftpUnlink(p: string): Promise<void>;
  openPty(opts: { cwd: string; cols: number; rows: number }): Promise<PtyStreamHandle>;  // ssh2 channel {pty:true}
  close(): void;
}
```
- memory-ssh-server:`startMemorySshServer(script: Array<{stdout?: string; stderr?: string; exit?: number}>)` → `{port, close()}`——ssh2 Server 模式,session exec 按 script 顺序回放;SFTP 不实现(SFTP 测试走 Task 6 假件缝)。

- [ ] **Step 1: host-store 失败测试**(CRUD/quarantine/缺档回空)+ **Step 2 跑失败 + Step 3 实现 + Step 4 过**
- [ ] **Step 5: 夹具失败测试**——`startMemorySshServer` 起后用真 ssh2 Client 连接、exec `echo hi` 回放 `hi\n`/exit 0:

```ts
const srv = await startMemorySshServer([{ stdout: 'hi\n', exit: 0 }]);
const conn = new ssh2.Client();
await new Promise((ok, no) => { conn.on('ready', ok).on('error', no).connect({ host: '127.0.0.1', port: srv.port, username: 't', password: 't' }); });
const out = await new Promise<string>((ok, no) => conn.exec('echo hi', (err, s) => err ? no(err) : s.on('close', () => ok(buf)).on('data', (c) => (buf += c))));
assert.equal(out, 'hi\n');
```

- [ ] **Step 6: pool 失败测试**——注入 `{host, port: srv.port, auth:'password', password:'t'}` 档:`ensure` 返回 channel → `execStart('echo hi')+execWait` 得 exitCode 0;`release` 后 `isReady` 仍真(闲置窗)→ `close()` 后假;断线退避:关 server 后 `ensure` 抛归一化中文错误(握手超时三分支文案,ZCode 同构)。SFTP 面:pool 构造接受 `sftpFactory?` 注入缝,测试注入内存假件(读写表),生产缺省 ssh2 `conn.sftp()`。
- [ ] **Step 7–8: 实现(连接复用单 Client/TOFU:host key 首见记录指纹进 hostStore 档,变化抛)/跑过**
- [ ] **Step 9: Commit** — `feat(remote): 主机档案+ssh2 连接池+内存 ssh2 夹具(spec §4/§6)`

### Task 4: server bundle 与部署器(源码 + esbuild 脚本 + deployer)

**Files:**
- Create: `src/serve/remote/server/main.ts`、`scripts/bundle-remote-server.mjs`、`src/serve/remote/deployer.ts`
- Test: `src/serve/remote/server/main.test.ts`、`src/serve/remote/deployer.test.ts`

**Interfaces:**
- server main(stdin JSON-lines 服务循环):方法面 `ping`/`exec.start`/`exec.kill`;事件 `exec.data`/`exec.exit`;启动首行 hello;**stdin EOF 即 process.exit(0)**(生命周期挂连接,spec §5)。exec 实现用 `child_process.spawn(shell 解析 cmd)`,win32 远程按 `process.platform` 分支(远程自己的平台,daemon 无感)。
- deployer:`ensureDeployed(conn, hostArchive) → {version, launched: boolean}`——conn = 裸 ssh2 连接级访问器 `{exec(cmd): Promise<{code, stdout, stderr}>; sftpRead; sftpWrite; sftpStat}`(部署发生在协议会话建立前,不经 RemoteChannel——鸡生蛋解耦);探测(`bash -lc 'node --version'`,缺 bash/node<22 → 归一化错误含指引)→ 读远程 version → 与本地 `remote-server.version`(bundle 脚本产物)比对 → 缺/不符 SFTP 写 `server.cjs.new` → rename 原子换装 → sha256 复核 → 返回。并发单飞:pool 内 per-host Promise 复用。

- [ ] **Step 1: server main 失败测试**(进程内喂 stdin 帧断言 stdout 帧:hello 先行、ping→pong、exec.start 回显 'echo hi' 产 data+exit 帧、EOF 退出):

```ts
import { spawn } from 'node:child_process';
// 编译产物直跑:node dist/serve/remote/server/main.js,stdio pipe,写 req 读帧断言(node:test 通用形态)
```

- [ ] **Step 2: 跑失败 → Step 3: 实现 main.ts(readline 循环 + FrameParser 复用 protocol.ts,注意 server 与 client 共享该模块——bundle 用 esbuild 打平)→ Step 4: 过**
- [ ] **Step 5: bundle 脚本**(esbuild `--bundle --platform=node --format=cjs` → `dist-remote/server.cjs`;产 `remote-server.version` JSON `{version: package.json version, sha256, protocol:1}`)——纳入 `pnpm build` 后置步(package.json scripts 增 `bundle:remote`)。
- [ ] **Step 6: deployer 失败测试**(夹具 exec 脚本编排:node --version → cat version → mkdir/write 由 SFTP 假件注入;断言:首装上传、版本一致跳过上传、sha256 不符重传、node 缺失错误文案)
- [ ] **Step 7: 实现 → 跑过 → Commit** — `feat(remote): server bundle 源+esbuild 单文件+部署器原子换装(spec §5)`

### Task 5: SshBackend implements ToolBackend

**Files:**
- Create: `src/harness/security/ssh-sandbox.ts`,Test 同目录

**Interfaces:**
- Consumes: `RemoteChannel`(Task 3);`ExecOpts/ExecResult/ToolBackend`(types.ts:494)。
- Produces: `SshBackend implements ToolBackend`(name='ssh'):`exec(cmd, opts)`(协议 exec.start+execWait,`timeoutMs` 缺省 120_000,超时不杀转后台语义:execId 上抛 `backgroundize()` 由 harness 后台账本接管——ProcessSandbox 同语义对齐);`execBackground`/`killBackground`(execId 即 pid 位);`readFile`(sftpRead→utf8)/`writeFile`(sftpWrite)/`listFiles(root, pattern)`(sftpReaddir 递归走 sftpStat 判目录,escapeRegExp 过滤对齐 ProcessSandbox:194-211 输出形状:相对路径串数组)。构造:`new SshBackend(channel: RemoteChannel, runSignal?: AbortSignal)`——`setRunSignal` 同 ProcessSandbox 面;runSignal.aborted → exec 直接 `fail('EXEC_ABORTED')`。

- [ ] **Step 1: 失败测试**(channel 内存假件注入):exec 回放断言 ExecResult(exitCode/stdout);runSignal 先置 aborted → fail EXEC_ABORTED;writeFile 对假 sftp 表断言逐级 mkdir;listFiles 对嵌套假件断言 glob 过滤。
- [ ] **Step 2: 跑失败 → Step 3: 实现 → Step 4: 过(`node --test dist/harness/security/ssh-sandbox.test.js`)**
- [ ] **Step 5: Commit** — `feat(harness): SshBackend 兑现 ToolBackend ssh 预留位(spec §7)`

### Task 6: BackendFactory + daemon 池装配(会话全通)

**Files:**
- Modify: `src/harness/index.ts:267`(`this.sandbox = new ProcessSandbox()` 装配点)、`src/serve/session.ts`(assemble 注入缝)、`src/serve/daemon.ts`(池构造 + assemble 传 channel)
- Test: `src/serve/daemon.remote.test.ts`(daemon.test 锚风格:`new GuiDaemon({model})` + `start({port:0})`)

**Interfaces:**
- HarnessOptions 增 `backend?: ToolBackend`(缺席=ProcessSandbox,本地零变化);`this.sandbox = opts.backend ?? new ProcessSandbox()`(SafetyChain/skill/团队 facade 的 base 不动——安全判界仍本地 root 字符串)。
- daemon assemble(session.ts:828-876)按 `isRemoteRoot(root)` 取 `pool.ensure(hostId)` → `new SshBackend(channel)` 注入;本地走旧路径零感知。

- [ ] **Step 1: 失败测试**——装配缝两层:①单测 `backendForRoot('ssh://t1/x', 假池)` 返回 SshBackend、本地 root 返回 ProcessSandbox(且同一 root 两次调用连接复用);②`new Harness({root:'ssh://t1/x', backend: new SshBackend(fakeChannel)})` 后 `harness.sandbox.name === 'ssh'`,exec/read/write 四件经 fakeChannel 断言;本地 root 对照组(harness 既有构造测试)零变化。
- [ ] **Step 2: 跑失败 → Step 3: 实现(Factory 即 harness :267 一行分支 + session/daemon 注入缝)→ Step 4: 过 + 全量 `pnpm test`(本地路径回归零变化是本 task 红线)**
- [ ] **Step 5: Commit** — `feat(harness): BackendFactory 按 root scheme 注入执行后端(spec §7;本地路径零变化)`

### Task 7: 远程工作区注册/建会话/attach + WorkspaceRow kind

**Files:**
- Modify: `src/serve/workspace-handlers.ts`(handleWorkspaceCreate remote 分支)、`src/serve/session-lifecycle.ts:133-141`(root 门与 mint)、`src/serve/daemon.ts:123-130`(WorkspaceRow)
- Test: `src/serve/daemon.workspace.test.ts` 补 remote 锚 + `daemon.remote.test.ts` 追加

**Interfaces:**
- `POST /workspaces` body 增 `{remote: {hostId, path}}` 分支:handler async(现已是)→ `pool.ensure(hostId)` → `sftpStat(path)` 非目录 400 → 落 `workspace.json {root: remoteRootOf(...)}`;幂等/隐藏档摘除逻辑复用现行代码路径(root 换成 URI 串)。
- `createSessionIn`(session-lifecycle.ts:134):`const abs = root === DEFAULT_ROOT_LITERAL ? defaultScratchRoot() : (isRemoteRoot(root) ? root : path.resolve(root))`;远程分支跳过 statSync 门(注册面已验;连接态由 `pool.isReady` 在 daemon.createSession 前置校验,未连 400 "remote host not connected");`mintSessionId(io.sessions, abs)`——其内部若有 basename/path 消费需同步绕行(实现时核对该函数,含 path 消费即走 root-scheme 的远程分支:名称段取 path 尾段手拆)。
- `WorkspaceRow` 增 `kind?: 'local'|'remote'; hostId?: string`(handleWorkspaces 由 workspace.json root 谓词推导);`connection-types.ts` 同步(GUI Task 10 消费)。

- [ ] **Step 1: 失败测试**——remote 注册:假 pool stat 命中 → 200 且 `GET /workspaces` 出列 `kind:'remote'`;stat 未命中 400;`/session/new {root:'ssh://...'}` 200;journal meta root=URI 原样(attach 回读 roundtrip);本地路径对照组零变化。
- [ ] **Step 2: 跑失败 → Step 3: 实现 → Step 4: 过 + 全量**
- [ ] **Step 5: Commit** — `feat(serve): ssh:// 工作区注册/建会话/attach+WorkspaceRow kind(spec §3)`

### Task 8: harness 降级面(SUNSHINE.md 通道化 + 五处显式降级)

**Files:**
- Modify: `src/harness/context/loader.ts:36,44`(读改 backend 注入)、`src/harness/skills.ts`(项目五根跳过)、`src/harness/perception.ts`(root 扫描探针缝)、`src/harness/security/chain.ts:81`(rootReal 跳过)、`src/harness/worktree.ts`(入口拒绝)、`src/serve/daemon.ts:351-358`(watch 跳过)、`src/harness/tools/builtin.ts`(图片直读走 backend)
- Test: 各文件对应 test 补 remote 锚(注入 `isRemoteRoot` 可判的 URI root)

**Interfaces:**
- loader:`loadSunshine(root, read?: (p: string) => string | null)`——harness 装配传 `backend.readFile` 包装(本地 backend=ProcessSandbox,行为逐字节不变;远程走 SFTP);缺档返回 null 语义不变。
- 五处降级统一形态:`isRemoteRoot(base)` 早退分支——skills 五根只装 user 级;perception 深扫描跳过(仅 channel stat 探 `.git` 存在性一次,结果缓存);chain rootReal 直接用 root 原串;worktree 工具入口 `fail('INVALID_ARG','remote project 不支持 worktree')`;daemon watch 不挂。
- builtin 图片直读(:302-306/:489 statSync)改走 `backend.readFile`(本地实现等价)。

- [ ] **Step 1: 各自失败测试(注入远程 root 断言降级行为 + 本地对照零变化)→ Step 2-3 逐文件实现 → Step 4: 全量绿**
- [ ] **Step 5: Commit** — `feat(harness): 远程工作区降级面五处显式+SUNSHINE.md/图片通道化(spec §7)`

### Task 9: serve 层路由——file/tree/git 全家桶

**Files:**
- Modify: `src/serve/file-handlers.ts`(handleFile/handleAppFile/handleTree/walkTreeBounded/gitIgnoredPaths)、`src/serve/session-changes.ts`(git() 单点 :15-17 + discardUnstaged :268 + workspaceFiles :503)
- Test: `file-handlers.test.ts` / `daemon.diff.test.ts` 补 remote 分支锚(假 channel)

**Interfaces:**
- 路由判定单点:`session-changes.ts` 顶部 `remoteChannelOf(root): RemoteChannel | undefined`(daemon 注入;本地 root 返回 undefined 走原路径)。git() 分支:远程 → `channel.execStart('git -C <path> ...')+execWait`,stdout 解析逻辑复用;discardUnstaged 的 rmSync → `sftpUnlink`;workspaceFiles → sftpReaddir 递归。
- file-handlers:handleFile 有界读 → 远程 sftpRead 截断同规则;handleTree/walkTreeBounded → sftp walk(跳过规则清单复用 :85 的 skip 集)。

- [ ] **Step 1: 失败测试(假 channel 注入 daemon;断言 git status/changes/diff/tree/file 读四链路 + 本地对照)** → **Step 2: 实现 → Step 3: 过+全量 → Step 4: Commit** — `feat(serve): file/tree/git 按工作区形态路由(spec §8)`

### Task 10: pty 远程分支 + /remote HTTP 面 + teardown

**Files:**
- Modify: `src/serve/pty.ts`(PtyManager.spawn 按 cwd root 分支)、`src/serve/remote/handlers.ts`(新建)、`src/serve/daemon.ts`(路由表 + teardown `pool.close()`)
- Test: `pty.test.ts` 补假 channel 锚 + `src/serve/remote/handlers.test.ts`

**Interfaces:**
- `SshPtySession implements PtySession`(write/resize/kill/replay/onData/onExit):包装 ssh2 channel(`exec` 带 `{pty: true, term: 'xterm-256color', cols, rows}`,命令 `bash -lc 'cd <path> && exec bash -i'`;resize 走 channel.setWindow)。PtyManager.spawn:`isRemoteRoot(cwd)` → 经 daemon 注入的 `remotePtyFactory(cwd)` 产出,owner/replay/回收逻辑全复用。
- handlers:`GET /remote/hosts`(list+state)/`POST /remote/hosts`(形状校验/重名 409)/`PATCH :id`/`DELETE :id`(referencingWorkspaces 命中 409)/`POST :id/test`(pool.ensure+release,归一化错误透出)/`GET /remote/dirpicker?host=&path=`(sftpReaddir,响应形状复用 DirPickerResp);鉴权/容量与现行 handler 同口径(io.send/readJson 注入先例)。

- [ ] **Step 1: handlers 失败测试(注入假池/host-store 档;CRUD/409/test 错误透出/dirpicker 形状)** → **Step 2: 实现 → Step 3: pty 假 channel 锚(写/resize/kill/replay 面)→ Step 4: 过+全量 → Step 5: Commit** — `feat(serve): pty 远程分支+/remote 运维面+teardown 收口(spec §4/§8)`

### Task 11: GUI 连接面 + WorkspaceRow kind

**Files:**
- Modify: `gui/src/connection-types.ts:145-152`(WorkspaceRow + `RemoteHost` 类型)、`gui/src/connection-api.ts`、`gui/src/connection.ts:198`(remote 族方法)

**Interfaces:**
```ts
export interface RemoteHost { id: string; name: string; host: string; port?: number; auth: 'agent'|'key'|'password'; keyPath?: string; hasPassphrase?: boolean; hasPassword?: boolean; enabled: boolean; state?: 'idle'|'connecting'|'ready'|'error'; lastError?: string }
// WorkspaceRow 增 kind?: 'local'|'remote'; hostId?: string; hostName?: string
// connection 方法:remoteHosts()/remoteHostCreate(body)/remoteHostUpdate(id,body)/remoteHostDelete(id)/remoteHostTest(id)/remoteDirpicker(host, path?)
```
- [ ] **Step 1: 类型与方法封装(无 UI)→ Step 2: `cd gui && pnpm exec vitest run src/connection.test.ts`(既有桩测补方法形状)→ Step 3: Commit** — `feat(gui): remote 族连接面封装(spec §9)`

### Task 12: DirPicker 远程页签

**Files:**
- Modify: `gui/src/pages/DirPicker.tsx`(+ `dirpicker.test.tsx`)
**Interfaces:**
- `DirPickerConn` 增 `remoteHosts?(): Promise<RemoteHost[]>`;`remoteDirpicker?(host: string, path?: string): Promise<DirPickerResp>`;`remoteHostCreate?(...)`——四消费点(侧栏/NewSunxDialog/欢迎页/ScheduleConfig)conn 由宿主注入,缺席时远程页签不渲染(向后兼容)。
- 页签形态:头下「本地 / 远程」两 tab(现行浏览列表=本地);远程 tab = 主机下拉(已存 enabled 连接 + 底部「添加 SSH 连接…」按钮弹 `RemoteHostForm` 内联卡,字段 Name/host/port/auth/keyPath/口令——提交即 remoteHostCreate+test)→ 选主机后复用现行逐级浏览交互(remoteDirpicker 数据源),确认回抛 `ssh://` URI(经 `remoteRootOf` 前端同形函数,`gui/src/root-scheme.ts` 镜像三函数,与后端单测同形断言)。
- [ ] **Step 1: 失败测试(页签切换/主机下拉/添加连接卡提交/浏览取数/确认回抛 URI;conn 假件)** → **Step 2: 实现 → Step 3: 过 + 四消费点既有测试回归 → Commit** — `feat(gui): DirPicker 远程页签+主机下拉(spec §9)`

### Task 13: 设置页远程主机 pane

**Files:**
- Create: `gui/src/settings/RemoteHostsPane.tsx`(+test);Modify: `settings-groups.ts`/`SettingsShell.tsx`/`settings-search.ts`/`connection.ts`(SettingsShellConn 并集先例 channels Task 12)
**Interfaces:** pane 行 = name/host/state 徽标/连接测试钮/编辑/删除(409 报"仍有工作区引用");编辑表单同 Task 12 RemoteHostForm 复用(单点组件抽 `gui/src/settings/RemoteHostForm.tsx`);settings-groups 基础组插 `{id:'remote', title:{en:'Remote hosts',zh:'远程主机'}}`;search 条目注册。
- [ ] **Step 1: 失败测试(列表渲染/测试钮 loading 态/删除 409 文案/表单提交)→ Step 2: 实现 → Step 3: 过 → Commit** — `feat(gui): 远程主机设置 pane(spec §9;Codex Settings→Connections 同位)`

### Task 14: 侧栏徽标 + Sunx 主机名 + 降级隐藏

**Files:**
- Modify: `gui/src/sidebar/project-menu-projects.tsx`(组头徽标)、`gui/src/sidebar/project-menu-sunx.tsx`(行信息卡 hostName)、`gui/src/sidebar/project-menu-util.tsx`(wsName 徽标伴生)、`gui/src/welcome/NewSunxDialog.tsx`(下拉远程项 + DirPicker conn 注入 remote 面)、降级隐藏点(worktree 入口/编辑器钮按 root 谓词)、`gui/src/i18n.ts`(新键双语)
**Interfaces:** 徽标 = 组头 Folder 图标旁 `Monitor size={12}` + hostName 小字(Sunx 行同字段);谓词 `root.startsWith('ssh://')`(前端镜像,零依赖);worktree 入口/编辑器钮对远程 root 不渲染(与 Task 8 服务端 400 双保险);full-access 会话提示对远程 root 注明"将在远程机器执行"(i18n 键,en/zh,Chat 信息条同点位)。
- [ ] **Step 1: 失败测试(远程组头徽标/Sunx 行 hostName/远程项下拉/降级钮不渲染)→ Step 2: 实现 → Step 3: 过 + `pnpm --dir gui run build` + 全量 → Commit** — `feat(gui): 远程工作区侧栏徽标+Sunx 主机名+降级隐藏(spec §9)`

### Task 15: 文档收口 + 台账

**Files:**
- Modify: `CLAUDE.md §5`(ssh2/esbuild 台账行)、`MANUAL-GUI.md`(远程主机 pane/DirPicker 远程页用户面记载)、`docs/Arch-Plan.md`(§四 候选池 ssh2 移入已引入;§三 平台行补远程工作区)
- [ ] **Step 1: 三处文档改写(引用 spec/计划行号)→ Step 2: 全量 `pnpm test` + `pnpm gui:build` → Commit** — `docs: 远程工作区 ssh 阶段文档收口+依赖台账`

---

## 自检对照(spec § → Task 映射)

| spec 节 | Task |
|---|---|
| §3 root 形态/slug/注册/attach | Task 1 / 6 / 7 |
| §4 连接层(档案/认证/host key/池/HTTP 面) | Task 3 / 10 |
| §5 部署器与 server bundle | Task 4 |
| §6 协议 v1 | Task 2 / 4 |
| §7 ToolBackend/Factory/harness 治理 | Task 5 / 6 / 8 |
| §8 serve 路由 | Task 9 / 10 |
| §9 GUI 面 | Task 11 / 12 / 13 / 14 |
| §10 安全面 | Task 3(TOFU)/ 12(回显开关)/ 8(降级收窄) |
| §11 测试计划 | 各 Task 内嵌 + 全量门禁 |
| §12 分期 | 阶段一=Task 1-7,阶段二=Task 8-10,阶段三=Task 11-15 |
| §13 演进 | 不在本计划(后续计划) |
