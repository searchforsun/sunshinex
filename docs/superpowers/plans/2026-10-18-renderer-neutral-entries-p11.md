# P11 渲染中立化条目模型 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 内核条目渲染中立化——自由文本类 md 裸文化、工具条 md 退役(字段单源 name/input/result)+ 三态 status 进条目,TUI/GUI 渲染记号与态推导全部改字段驱动。

**Architecture:** 内核(entry.ts)是唯一条目装配点:五 tool 装配点 md→''、user 去 `> `、status 按 payload 生命周期接线(pending→running→缺省 done);journal v2 写面单形态、读侧一次性归一旧档;batch-runner 执行起点补发同 callId `status:'running'` 的 tool-call(内核乱序回填路径天然幂等);GUI ToolEntry 从 md 解析切字段单源并退役 toolInputs 旁路。

**Tech Stack:** TypeScript strict(CommonJS,node:test);GUI vitest + jsdom;无新依赖。

**Spec:** `docs/superpowers/specs/2026-10-18-renderer-neutral-entries.md`(§1-2 模型/§3 四层改动/§4 迁移/§5 测试/§7 三态/§8 子代理同构——本计划逐节落地面,执行者两份同读)。

## Global Constraints

- `md` 语义:自由文本类裸内容;`kind:'tool'` 的 `md` 恒 `''`;任何渲染记号(`●`/`⎿`/`>`)不得进内核;读侧零归一(零兼容红线);
- `status?: 'pending' | 'running' | 'done'`,**done 以缺省(undefined)承载**——终态行字段省略,失败不设态(`result.ok=false` 承载 ✗);
- **零兼容(用户裁定)**:journal 升 **v3**——attach/restore 仅认 `v:3`,v2 档 INVALID_ARG+purge(`scripts/purge-legacy-sessions.mjs` 扫描口径 v≠3);**读侧零归一**(剥 `> `/记号 md 丢弃等兼容代码不得存在);悬空 tool 行补 `result:{text:'(interrupted)', ok:false}` 是 v3 自身语义;`v2log.ts` 正名 `seglog.ts`(`reduceV2Rows`→`reduceSegRows`、`V2RowLike`→`SegRowLike`);**status 不落 journal 行**(落档恒终态);
- `tsconfig` strict 且**未开** exactOptionalPropertyTypes:`status: undefined` 为合法删字段写法(序列化时 JSON.stringify 丢弃 undefined 键);
- 测试基线语言钉 en(`SUNSHINEX_LANGUAGE=en`);daemon 测试走 `node scripts/run-tests.js`(先 `cd src && npx tsc`);GUI 走 `npx vitest run`(gui/ 下);
- 每任务独立可测、独立提交;conventional commits 中文(仓内既有惯例)。

---

### Task 1: 内核条目——status 字段 + 渲染中立 md

**Files:**
- Modify: `src/session/entry.ts`(KernelEntry 接口 :33-50;tool 五装配点 :246-329;user 分支 :331-334;token/reasoning 开段 :218-244;sealSeg :173-182;done 分支 :397-431;model-start :353-364;toolMd 删除 :130-137;PendingTool.resultLine 删 :97-104)
- Test: `src/session/kernel.test.ts`

**Interfaces:**
- Produces: `KernelEntry.status?: 'pending' | 'running' | 'done'`(done=undefined);`KernelEntry.md` 对 tool 恒 `''`、对 user 为裸文本;`PendingTool` 不再有 `resultLine`。后续所有任务依赖这两个形态。

- [ ] **Step 1: 写失败测试(status 生命周期 + 裸 md)**

在 `src/session/kernel.test.ts` 追加(文件尾):

```ts
test('⓰ 渲染中立条目模型:tool md 恒空+字段单源;user 裸文;三态 pending→running→done', () => {
  const k = new SessionKernel();
  pump(k, ev('tool-call', 'read', { callId: 'c1', input: { path: 'a.ts' }, status: 'pending' }));
  let es = k.replay();
  assert.equal(es[0]!.md, '', 'tool md 恒空(字段单源)');
  assert.equal(es[0]!.status, 'pending', 'call 发射即前态');
  pump(k, ev('tool-call', 'read', { callId: 'c1', input: { path: 'a.ts' }, status: 'running' }));
  es = k.replay();
  assert.equal(es.length, 1, '执行起点同 callId 二次 call 幂等回填(不建新条)');
  assert.equal(es[0]!.status, 'running', 'running 升级');
  pump(k, ev('tool-result', 'body', { callId: 'c1', ok: true }));
  es = k.replay();
  assert.equal(es[0]!.status, undefined, 'done 以缺省承载(字段省略)');
  assert.deepEqual(es[0]!.result, { text: 'body', ok: true });
  pump(k, ev('user', '问'));
  assert.equal(k.replay()[1]!.md, '问', 'user 裸文(无 > 前缀)');
  const k2 = new SessionKernel();
  pump(k2, ev('model-start'));
  assert.equal(k2.replay()[0]!.status, 'running', 'run 行开即 running');
  pump(k2, ev('done', '答', { stopReason: 'done' }));
  assert.equal(k2.replay()[0]!.status, undefined, 'run 收口 done 缺省');
  assert.equal(k2.replay()[1]!.status, undefined, '正文封段 done 缺省');
});

test('⓱ 段开 running:token/reasoning 开启段显 running,封段删字段', () => {
  const k = new SessionKernel();
  pump(k, ev('reasoning', '想'));
  assert.equal(k.replay()[0]!.kind, 'thinking');
  assert.equal(k.replay()[0]!.status, 'running');
  pump(k, ev('token', '答'));
  assert.equal(k.replay()[1]!.kind, 'assistant');
  assert.equal(k.replay()[1]!.status, 'running');
  pump(k, ev('done', '答', { stopReason: 'done' }));
  assert.equal(k.replay()[0]!.status, undefined);
  assert.equal(k.replay()[1]!.status, undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src && npx tsc && cd .. && SUNSHINEX_LANGUAGE=en node --require scripts/test-env.cjs --test dist/session/kernel.test.js 2>&1 | tail -8`
Expected: FAIL(md 断言 `● create_task…`/`> 问` 与 status 断言 undefined 不符)

- [ ] **Step 3: 实施内核改动**

`src/session/entry.ts` 逐处:

(a) KernelEntry 接口(`:47` meta 之前)插:

```ts
  /** 三态生命周期(渲染中立 spec §7):pending=已发射未执行/running=执行或流式中;done 以缺省
   *  承载(终态行字段省略——journal 轻量,undefined 即 done)。失败不设第四态:result.ok 承载 ✗ */
  status?: 'pending' | 'running' | 'done';
```

(b) 删除 `toolMd` 函数(:130-137 整块)与 `PendingTool.resultLine` 字段(:97-104 内 `resultLine: string;` 一行);

(c) tool-call 正常装配(`:274-283`):

```ts
      const input = e.payload?.input;
      const next = appendEntry(sealed, {
        ts: e.ts,
        kind: 'tool',
        md: '',
        status: e.payload?.status === 'running' ? 'running' : 'pending',
        ...(callId !== undefined ? { callId } : {}),
        name,
        ...(input !== undefined && typeof input === 'object' ? { input: input as Record<string, unknown> } : {}),
      });
      return { ...next, pending: [...next.pending, { seq: next.nextSeq - 1, ...(callId !== undefined ? { callId } : {}), name }] };
```

(d) 乱序 call 回填(`:261-271`,result 先行条补 name/input——条已有 result 即 done,不回 status):

```ts
              entries: replaceAt(sealed.entries, idx, {
                ...cur,
                name,
                ...(input !== undefined && typeof input === 'object' ? { input: input as Record<string, unknown> } : {}),
              }),
```

(e) tool-result `fill`(`:295`)——收 done(删 status)+ result:

```ts
      const fill = (cur: KernelEntry, name: string): KernelEntry => ({ ...cur, name, result, status: undefined });
```

(f) result 先行占位(`:310`)与孤儿 result(`:329`):`md: ''`(两处 toolMd 调用替换,无 status——即刻 done);

(g) token 开段(`:232`)与 reasoning 开段(`:244`):条目字面加 `status: 'running'`;

(h) sealSeg(`:173-182`):封段收 done:

```ts
  return { ...s, entries: replaceAt(s.entries, idx, { ...cur, status: undefined, ...(seconds !== undefined ? { seconds } : {}) }), openSeg: -1 };
```

(i) user 分支(`:333`):`return appendEntry(sealed, { ts: e.ts, kind: 'user', md: e.text ?? '' });`

(j) model-start(`:359`):`appendEntry(sealed, { ts: e.ts, kind: 'run', md: '', status: 'running' })`;

(k) done 分支:assistant 合并(`:406`)`{ ...seg, md: mergeFinal(seg.md, finalText), status: undefined }`;直答独立成条(`:408`)不加 status;run 收口(`:428`)`{ ...run, status: undefined, meta }`。

- [ ] **Step 4: 同步 kernel.test 既断言**

全文件替换(逐处核对,`grep -n "⎿\|> " src/session/kernel.test.ts` 清点):
- `'> 把测试跑绿'` → `'把测试跑绿'`;`'> 一'`/`'> 三'`/`'> 问'` 等全部裸文化;
- `'● create_task {"title":"A"}\n⎿ …'` → `''` 且补 `.status, 'pending'`;`'● create_task {"title":"A"}\n⎿ task t1 created'` → `''`(补 status undefined 断言);③ 的 `'● …\n⎿ file content here'`/`'● read {"path":"a.ts"}\n⎿ file content here'` → `''`(乱序条 status undefined);④⑤ 同理(`'● read\n⎿ first out'`→`''`、`'● bash {"command":"ls"}\n⎿ …'`→`''`+status pending)。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd src && npx tsc && cd .. && SUNSHINEX_LANGUAGE=en node --require scripts/test-env.cjs --test dist/session/kernel.test.js 2>&1 | tail -8`
Expected: PASS(kernel.test 全绿)

- [ ] **Step 6: Commit**

```bash
git add src/session/entry.ts src/session/kernel.test.ts
git commit -m "feat(session): P11-T1 内核条目渲染中立化——tool md 退役字段单源,user 裸文,status 三态接线"
```

---

### Task 2: journal v3——写面单形态 + 正名 seglog + 版本守卫(零兼容)

**Files:**
- Modify: `src/session/v2log.ts` → **Rename `src/session/seglog.ts`**(seg-update md 重算块 :167-179;reduceV2Rows→reduceSegRows 全文;悬空收口 :191-197)
- Modify: `src/tui/session-journal.ts`(start/rotate 缺省 version 2→3)、`src/serve/daemon.ts`(attach 守卫 :272)、`src/tui/commands-session.ts`(restoreFromSession 守卫 :120-123)、`scripts/purge-legacy-sessions.mjs`(扫描口径 v≠3)、`src/tui/session.ts`(j.start(2) 三处 → 3)
- Test: `src/session/v2log.test.ts`(随改名 seglog.test)、`src/serve/daemon.test.ts`(:1978-1993 夹具)、`src/serve/daemon.workspace.test.ts`(makeJournal(..., 2) → 3 逐处)、`src/tui/session-journal.test.ts`(v3 夹具)

**Interfaces:**
- Consumes: Task 1 的条目形态(tool md=''/user 裸文)。
- Produces: `reduceSegRows`(改名后)——装载出的 tool 条 md='' 且无 result 者补 `result:{text:'(interrupted)', ok:false}`(v3 自身语义);user 条裸文直读(零变换);全仓仅认 v:3。

- [ ] **Step 1: 写失败测试(悬空归一 + 往返 + 版本守卫)**

`src/session/v2log.test.ts`(改名后 seglog.test)追加:

```ts
test('渲染中立 v3(P11):tool md 恒空;悬空 tool 行补 interrupted result(零旧形态归一——raw 直读)', () => {
  const entries = reduceSegRows([
    { t: 'seg', kind: 'user', md: '裸目标', ts: 1, seq: 1 },
    { t: 'seg', kind: 'tool', md: '', ts: 2, seq: 2, callId: 'c1', name: 'read', input: { path: 'a.ts' } },
    { t: 'seg-update', seq: 2, ts: 3, result: { text: 'body', ok: true } },
    { t: 'seg', kind: 'tool', md: '', ts: 4, seq: 3, callId: 'c2', name: 'bash', input: { command: 'ls' } },
  ]);
  assert.equal(entries[0]!.md, '裸目标', 'user 裸文直读(零变换)');
  assert.equal(entries[1]!.md, '');
  assert.deepEqual(entries[1]!.result, { text: 'body', ok: true });
  assert.deepEqual(entries[2]!.result, { text: '(interrupted)', ok: false }, '悬空 tool 行(渲染 ✗ 不永转)');
});
```

版本守卫用例(daemon 侧,照 workspace ④ 既有守卫断言形态改写):v:2 header 的 journal 走
`daemon.attach` → INVALID_ARG 且 message 含 purge 指引。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src && npx tsc && cd .. && SUNSHINEX_LANGUAGE=en node --require ./scripts/test-env.cjs --test dist/session/seglog.test.js 2>&1 | tail -8`
Expected: FAIL(悬空无 result;或先 RED 于改名编译错)

- [ ] **Step 3: 实施**

`src/session/v2log.ts`(先 `git mv src/session/v2log.ts src/session/seglog.ts`,再全文 `reduceV2Rows`→`reduceSegRows`、`V2RowLike`→`SegRowLike`,import 点三处跟改:serve/session.ts、serve/daemon.ts、tui/commands-session.ts):

(a) seg-update 分支:删 md 重算块(`line` 推导与 `next.md = toolMd(...)` 两段,含 T1 的 toolMdLegacy 桥),只留字段回填:

```ts
    if (row.t === 'seg-update') {
      const target = num(row.seq);
      const idx = target !== undefined ? entries.findIndex((e) => e.seq === target) : -1;
      if (idx < 0) continue;
      const cur = entries[idx]!;
      if (cur.kind !== 'tool') continue;
      const name = str(row.name);
      const input = row.input !== undefined && typeof row.input === 'object' && row.input !== null ? (row.input as Record<string, unknown>) : undefined;
      const result = resultOf(row.result);
      entries[idx] = { ...cur, ...(name !== undefined ? { name } : {}), ...(input !== undefined ? { input } : {}), ...(result !== undefined ? { result } : {}) };
      continue;
    }
```

(b) seg 行:**零变换直读**(v3 世界之外不存在——md 原样、user 不剥前缀):

```ts
      entries.push({
        seq,
        ts: num(row.ts) ?? 0,
        kind,
        md: str(row.md) ?? '',
        ...(callId !== undefined ? { callId } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(input !== undefined ? { input } : {}),
        ...(kind === 'thinking' && seconds !== undefined ? { seconds } : {}),
      });
```

(c) 悬空收口(悬空 run 块之后)追加(v3 自身语义):

```ts
  // 悬空 tool 行(渲染中立 spec §7.4):result 永不到达=执行体已死——done+ok=false(渲染 ✗,不永转)
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.kind === 'tool' && e.result === undefined) entries[i] = { ...e, result: { text: '(interrupted)', ok: false } };
  }
```

(d) import 删 `toolMd`/`toolMdLegacy`(保留 sanitizeChanges);

(e) 版本守卫:`src/tui/session-journal.ts` 的 `start(version = …)`/`rotate(id, version = …)` 缺省 → 3;`src/tui/session.ts` 全部 `j.start(2)` → `j.start(3)`;`src/serve/session.ts` 的 `j.start(2)` 同步;`src/serve/daemon.ts` attach 守卫 `!== 2` → `!== 3`(message 同形换 3);`src/tui/commands-session.ts` restore 守卫同改;`scripts/purge-legacy-sessions.mjs` 扫描判定 `v !== 2` → `v !== 3`。

- [ ] **Step 4: 同步测试与守卫夹具**

- `v2log.test.ts`(随改名 seglog.test.ts):旧 md 形态断言全部 → `''`(四处:`\n` 前逐字见原列);kernelEventsToRows 测试镜像的 seg-update 分支删 md 组装(与实现同形);`assertSameShape` 剥 status(status 不落行)。
- `daemon.test.ts` 夹具 seg 行 `md: '● read\n⎿ …'` → `md: ''`,回填断言 → `md: ''`。
- `daemon.workspace.test.ts`:`makeJournal(` 各处末参 `2` → `3`(grep 清点);夹具 user/tool 行 md 照 v3 形态(裸文/空)。
- `session-journal.test.ts`:v2 夹具/断言 → v3。
- 版本守卫新用例:v:2 header journal → attach INVALID_ARG + purge 指引。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd src && npx tsc && cd .. && SUNSHINEX_LANGUAGE=en node --require ./scripts/test-env.cjs --test dist/session/seglog.test.js dist/serve/daemon.test.js dist/serve/daemon.workspace.test.js dist/tui/session-journal.test.js 2>&1 | tail -8`
Expected: PASS(T1 留下的 5 个旧形态红测随此转绿)

- [ ] **Step 6: Commit**

```bash
git add -A src/ scripts/purge-legacy-sessions.mjs
git commit -m "feat(session): P11-T2 journal v3 零兼容——seglog 正名,版本守卫 v:3,写面单形态,悬空 tool 补 interrupted(零读侧归一)"
```

---

### Task 3: batch-runner 执行起点 running 发射

**Files:**
- Modify: `src/harness/batch-runner.ts`(:104-133 串/并发扇出区)
- Test: `src/harness/batch-runner.test.ts`

**Interfaces:**
- Consumes: Task 1 的内核幂等回填(同 callId 二次 tool-call 升 status 不建新条)。
- Produces: 事件序契约——每调用恰 `pending → running → result` 三帧(超限/非法参调用跳过 running)。

- [ ] **Step 1: 写失败测试(事件序三帧)**

`src/harness/batch-runner.test.ts` 追加(文件既有 `probe`/`call`/`parseArgs`/`makeFixture` 桩直接复用):

```ts
test('P11 三态事件序:串行批每调用 pending→running→result;执行起点才有 running', async () => {
  const r = new ToolRegistry();
  r.register(probe('probe_a', 'bash', async () => { await sleep(10); return 'a-ok'; }));
  r.register(probe('probe_b', 'read', async () => 'b-ok'));
  const f = makeFixture(r);
  const mixed = [call('probe_a', {}), call('probe_b', {})];
  await f.runner.runBatch({ calls: mixed, argsOf: parseArgs(mixed), step: 1, ledger: f.ledger });
  const statuses = f.events.map((e) => e.payload.status);
  assert.deepEqual(statuses, ['pending', 'running', 'completed', 'pending', 'running', 'completed'], '串行批两调用各三帧(执行起点才有 running)');
});

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src && npx tsc && cd .. && SUNSHINEX_LANGUAGE=en node --require scripts/test-env.cjs --test dist/harness/batch-runner.test.js 2>&1 | tail -8`
Expected: FAIL(statuses 为 `['pending','completed',…]` 无 running)

- [ ] **Step 3: 实施发射**

`src/harness/batch-runner.ts` 扇出区(`:104-133`)——runOne 定义之后加:

```ts
    // P11 三态:执行起点补发 running(同 callId 二次 tool-call——内核按 pending 槽幂等回填升级,零新事件型)
    const emitRunning = (i: number, c: ToolCallSpec): void => {
      this.deps.emit('tool-call', c.name, { input: argsOf[i] ?? {}, callId: callIds[i], status: 'running' });
    };
```

串行支(`:113-118`)循环内 `const r = await runOne(...)` 之前插 `emitRunning(i, calls[i]);`;并发支(`:119-125`)map 回调内 `await runOne(...)` 之前插 `emitRunning(i, c);`(overDuplicated 早退分支不加——跳执行无中态)。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src && npx tsc && cd .. && SUNSHINEX_LANGUAGE=en node --require scripts/test-env.cjs --test dist/harness/batch-runner.test.js dist/session/kernel.test.js 2>&1 | tail -8`
Expected: PASS(批次与内核两侧;running 二次 call 不建新条)

- [ ] **Step 5: Commit**

```bash
git add src/harness/batch-runner.ts src/harness/batch-runner.test.ts
git commit -m "feat(harness): P11-T3 工具执行起点补发 running(同 callId 幂等,零新事件型)——三态事件序 pending→running→result"
```

---

### Task 4: TUI 恢复面——剥 `> ` 防御分支退役

**Files:**
- Modify: `src/tui/commands-session.ts`(:85-88)

**Interfaces:**
- Consumes: Task 2 的 v3 装载(reduceSegRows 出的 user md 恒裸文;v2 档已被版本守卫拒载)。

- [ ] **Step 1: 改实现(TUI restore 已有 user 条测试锚,先改后跑)**

`src/tui/commands-session.ts:85-88`:

```ts
    if (e.kind === 'user') {
      items.push({ role: 'user', text: e.md, ts: e.ts, seq });
      continue;
    }
```

- [ ] **Step 2: 跑 TUI 会话族测试(restore 路径经 session.* 族承载)**

Run: `cd src && npx tsc && cd .. && SUNSHINEX_LANGUAGE=en node --require scripts/test-env.cjs --test dist/tui/session.context.test.js dist/tui/session.detail.test.js dist/tui/session-snapshots.test.js 2>&1 | tail -8`
Expected: PASS(若夹具 journal user 行含 `> ` 前缀,逐条裸文化后跑;live 幂等说明:TUI 视图臂 archiveToolEntry 对 result 缺席的 seg-update 首行守卫 no-op——running 二次 call 天然不重行,零改动)

- [ ] **Step 3: Commit**

```bash
git add src/tui/commands-session.ts src/tui/session.restore.test.ts
git commit -m "refactor(tui): P11-T4 恢复面 user 条裸文直用——剥 > 防御分支退役(装载已归一)"
```

---

### Task 5: GUI reducer——user 裸文 + status 直映

**Files:**
- Modify: `gui/src/chat-reducer.ts`(ChatEntry :24-49;SnapshotTranscriptEntry :74-93;mapEntries :113-141)
- Test: `gui/src/chat-reducer.test.ts`

**Interfaces:**
- Produces: `ChatEntry.status?: 'pending' | 'running' | 'done'`(Task 6 消费);`ChatEntry.md` user 裸文。

- [ ] **Step 1: 写失败测试**

`gui/src/chat-reducer.test.ts` seedChatFromSnapshot describe 内追加:

```ts
  it('P11 user 裸文直映(无剥前缀)+ tool status 直映', () => {
    const s = seedChatFromSnapshot(
      [
        { seq: 1, ts: 1, kind: 'user', md: 'goal' },
        { seq: 2, ts: 2, kind: 'tool', md: '', callId: 'c1', name: 'read', input: { path: 'a.ts' }, status: 'running' },
      ],
      { openRun: -1, openSeg: -1 },
    );
    expect(s.entries[0]).toMatchObject({ kind: 'user', md: 'goal' });
    expect(s.entries[1]).toMatchObject({ kind: 'tool', md: '', status: 'running' });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd gui && npx vitest run src/chat-reducer.test.ts 2>&1 | tail -5`
Expected: FAIL(status 字段缺失)

- [ ] **Step 3: 实施**

`gui/src/chat-reducer.ts`:
(a) ChatEntry 加 `status?: 'pending' | 'running' | 'done';`(callId 注释块后);
(b) SnapshotTranscriptEntry 加同名字段;
(c) mapEntries:user 分支退役(md 三元改直透 `e.md`),视图字面加 `...(e.status !== undefined ? { status: e.status } : {})`;同时删 `viewCache` sig 中的 open 分量?——**不动**(openRun/openSeg 游标仍是流式光标内部面,G14.51 播种竞态依赖,本任务零行为风险)。

- [ ] **Step 4: 跑测试确认通过 + 既断言修**

Run: `cd gui && npx vitest run src/chat-reducer.test.ts 2>&1 | tail -5`
既夹具 `md: '> goal'` 逐处裸文化(`grep -n "'> " gui/src/chat-reducer.test.ts`)。
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gui/src/chat-reducer.ts gui/src/chat-reducer.test.ts
git commit -m "feat(gui): P11-T5 reducer user 裸文直映+status 直映(剥前缀分支退役)"
```

---

### Task 6: GUI ToolEntry 字段单源(md 解析退役)

**Files:**
- Modify: `gui/src/pages/chat/ToolEntry.tsx`(:36-93 verbOf/resultOf/toolMdInfo;:206-214 头部装配;:261 executing)
- Test: `gui/src/pages/Chat.test.tsx`、夹具 `gui/src/App.test.tsx`(:546)

**Interfaces:**
- Consumes: Task 5 的 ChatEntry 字段(name/input/result/status)。
- Produces: ToolEntryView 的 `info` prop 在本任务保留(退役归 Task 7)——本任务只换数据源优先级:`info ?? { name: entry.name ?? '', input: entry.input ?? {}, result: … }`,md 解析彻底退场。

- [ ] **Step 1: 写失败测试(种子条折叠行+running 态)**

`gui/src/pages/Chat.test.tsx` composer pills describe 内追加:

```ts
  it('P11 种子条三态渲染:running 显「正在读取文件」spinner 态,done 折叠行=动词+路径(字段单源)', async () => {
    const seed = {
      seq: 1, ts: DAY1, kind: 'tool', md: '',
      callId: 'c1', name: 'read', input: { path: 'docs/Arch-Plan.md' }, status: 'running',
    } as unknown as Seed;
    mountChat([seed]);
    await flushed();
    expect(document.querySelector('.exec-running-text')?.textContent).toContain('Reading file');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx 2>&1 | tail -5`
Expected: FAIL(md='' → toolMdInfo 无从解析,无 running 态)

- [ ] **Step 3: 实施字段单源**

`ToolEntry.tsx` 头部装配(`:206-214`)替换:

```ts
  // P11 渲染中立:字段单源(entry.name/input/result/status 直映)——md 解析(verbOf/resultOf/toolMdInfo)退役,
  // 渲染记号与截断全是本组件职责
  const toolName = info?.name ?? (entry.name ?? '');
  const input = info?.input ?? entry.input ?? {};
  const result = entry.result !== undefined ? '' : ''; // 占位:下行实测赋值(见下)
  const resultText = info?.result ?? entry.result?.text ?? '';
```

即:

```ts
  const toolName = info?.name ?? entry.name ?? '';
  const input: Record<string, unknown> = info?.input ?? entry.input ?? {};
  const resultText = info?.result ?? entry.result?.text ?? '';
```

既有引用点逐一改名:`verb` 的两处展示(`:206` verb 定义删)、`result` → `resultText`(`:219 stat`/`:249 task_stop 正则`/`:272 fullResult` 基)、`executing`(`:261`)→ `const executing = entry.status === 'pending' || entry.status === 'running';`(占位 `…` 判定删除);文件级删除 `verbOf`/`resultOf`/`toolMdInfo` 三函数;`toolTargetOf`/`fileLabelOf`/`writeStatOf` 保留(纯函数,入参已字段化)。`grep -n "verbOf\|resultOf\|toolMdInfo" gui/src` 清零(use-chat-derived 归 Task 7)。

- [ ] **Step 4: 跑测试确认通过 + 夹具同步**

Run: `cd gui && npx vitest run src/pages/Chat.test.tsx src/App.test.tsx 2>&1 | tail -5`
`App.test.tsx:546` 夹具 `{ seq: 2, ts: 2, kind: 'tool', md: '● read\n⎿ ok' }` → `{ seq: 2, ts: 2, kind: 'tool', md: '', name: 'read', result: { text: 'ok', ok: true } }`;其余 `md: '●…'` 夹具同改(`grep -n "● " gui/src --include=*.test.tsx`)。
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gui/src/pages/chat/ToolEntry.tsx gui/src/pages/Chat.test.tsx gui/src/App.test.tsx
git commit -m "feat(gui): P11-T6 ToolEntry 字段单源——md 解析(verbOf/resultOf/toolMdInfo)退役,executing 读 status"
```

---

### Task 7: toolInputs 旁路退役(G6 双通道归一)

**Files:**
- Modify: `gui/src/pages/Chat.tsx`(toolInputs/toolInfoOf/callIdOf :264-282)、`gui/src/pages/chat/use-session-events.ts`(G6 暂存臂 :200-232——**保留 todo_write 上抛与 G14.137**),`gui/src/pages/chat/use-chat-derived.ts`(:27-41)、`gui/src/pages/chat/chat-types.ts`(ToolCallInfo :88-96)
- Test: `gui/src/pages/Chat.test.tsx`、`gui/src/pages/chat/use-chat-derived` 相关用例

**Interfaces:**
- Consumes: Task 6 后 ToolEntry 字段直映——旁路 `ToolCallInfo` 不再被 ToolEntryView 需要。
- Produces: `ToolEntryView` 删 `info` prop;`Chat.tsx` 删 `toolInputs` state 与 `toolInfoOf`;`use-chat-derived` 的 `taskTitleMap` 改 `e.input` 直读。

- [ ] **Step 1: 改实现**

(a) `Chat.tsx`:删 `toolInputs` state、`toolInfoOf`、传给 `ToolEntryView` 的 `info`/派生 deps 的 `toolInputs`;`callIdOf` 保留(diff 寻址);
(b) `use-session-events.ts`:tool-call 分支保留 `todo_write` 上抛段(onTodos),删 `setToolInputs` 两分支(tool-call/tool-result 的暂存);
(c) `use-chat-derived.ts`:`taskTitleMap` 的 `const info = toolInfoOf(e) ?? toolMdInfo(e.md);` → `const input = e.input ?? {};` 直读 `input.title`;
(d) `chat-types.ts`:删 `ToolCallInfo`;`ToolEntry.tsx` 删 `info` prop 与 `info?.` 三处(全走 entry 字段);ChatDerivedDeps 删 toolInputs。

- [ ] **Step 2: 跑 GUI 全量(旁路退役横切面大,直接全量)**

Run: `cd gui && npx tsc --noEmit && npx vitest run 2>&1 | tail -5`
失败用例逐个修:凡构造 `ToolCallInfo`/断言 toolInputs 行为的用例改字段夹具(Chat.pause-send.test 若涉亦同)。
Expected: 0 fail

- [ ] **Step 3: Commit**

```bash
git add gui/src/pages/Chat.tsx gui/src/pages/chat/use-session-events.ts gui/src/pages/chat/use-chat-derived.ts gui/src/pages/chat/chat-types.ts gui/src/pages/chat/ToolEntry.tsx gui/src/pages/Chat.test.tsx
git commit -m "refactor(gui): P11-T7 toolInputs 旁路退役——G6 双通道归一字段单源(todo 上抛保留)"
```

---

### Task 8: 全量回归 + 收尾

**Files:** 无新改(回归门)

- [ ] **Step 1: daemon 全量**

Run: `cd src && npx tsc && cd .. && node scripts/run-tests.js 2>&1 | tail -9`
Expected: 0 fail(2 skip 既有)

- [ ] **Step 2: GUI 全量 + tsc 双端**

Run: `cd gui && npx tsc --noEmit && npx vitest run 2>&1 | tail -4`
Expected: 0 fail

- [ ] **Step 3: 构建产物(用户浏览器即时可见)**

Run: `cd gui && npx vite build 2>&1 | tail -3`
Expected: built

- [ ] **Step 4: plan 验收回填 + 提交**

`docs/superpowers/plans/2026-10-18-renderer-neutral-entries-p11.md` 验收节回填实测数字,连同遗留改动一并:

```bash
git add -A src/ gui/ docs/superpowers/plans/2026-10-18-renderer-neutral-entries-p11.md
git commit -m "feat(session): P11 渲染中立化条目模型收官——内核/journal/双端渲染全量对齐 spec §1-8"
```

---

## 验收清单(对照 spec)

- [ ] `grep -rn "● \|⎿ \|'> " src/session/ src/serve/ src/tui/ --include=*.ts | grep -v test` 生产源码零渲染记号;
- [ ] `KernelEntry.status` 三态接线;tool md 恒 '';user 裸文;悬空 tool 装载归一;
- [ ] 事件序 pending→running→result;TUI/GUI live 二次 tool-call 幂等不重行;
- [ ] GUI ToolEntry/derived 字段单源,toolInputs 旁路退役;
- [ ] snapshot messages 纯 API 可识别(无渲染文档依赖)——spec §3.5 锚点;
- [ ] 子代理同构(spec §8):spawn 零条目特判——普通 tool 三态贯通,delegation 另轨零转录;
- [ ] 全量:daemon 0 fail / GUI 0 fail / tsc 双端 0 error。
