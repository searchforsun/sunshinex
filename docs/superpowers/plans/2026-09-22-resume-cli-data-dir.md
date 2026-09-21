# 会话恢复对标 CC（指针收编 + resume 子命令 + 数据目录口径收敛）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 摘除 `sessions-active.json` 显式指针（最近会话统一按会话档 mtime 解析）、新增 `--resume` 启动旗标（弹会话选择卡，对标 CC `--resume`）、`SUNSHINEX_DATA_DIR` 收口为开发测试专用口（用户面零感知）。

**Architecture:** journal 层删除指针读写与全部写入点（建档/轮转/续挂/分档）；`--continue` 改 `listSessions()`（mtime 降序）首项；`--resume` 复用 `/resume` 的 askUser 选择卡通道（抽 `resumeFlow` 共用单点防两处拼装漂移）；注释与手册按「删除即无痕 + 正向表述」同步。

**Tech Stack:** TypeScript strict + node:test（零框架）、pnpm；规格 `docs/superpowers/specs/2026-09-22-resume-cli-data-dir-design.md`。

## Global Constraints

- 门禁三件套：`pnpm build`（tsc strict 零报错）+ `pnpm test`（全量 fail 0）+ `pnpm selfcheck`，Task 4 终验与每个提交前定向套件须绿。
- 删除即无痕：收口时全仓 grep `sessions-active|ActivePointer` 零命中（代码+文档；`docs/superpowers/` 历史规格计划存档除外）；注释禁复述「已删除/已退役」。
- 语言规范（CLAUDE.md §15）：写链/提示词恒英文单语；界面回执一律 `t(en, zh)` 调用时求值。本线新增回执均为 t() 双语。
- 测试数据目录钉扎：凡 new SessionController 的用例沿 `session.selector.test.ts` 的 `pinDataDir` 先例，构造前设 `SUNSHINEX_DATA_DIR`、finally 恢复并清理临时目录。
- 并发 WIP 纪律：工作区存在他线未提交改动（含 `src/cli/*`、`MANUAL.md`）。每个提交 `git add` 限定本线文件路径，暂存后 `git diff --cached` 核对仅含本线 hunk；同文件重叠时沿「临时索引 + commit-tree」先例按 hunk 隔离，零卷入他线。
- 平台纪律：路径一律 path.join/resolve；测试断言不依赖 shell 方言。
- mtime 并列风险：ScriptedAdapter 亚毫秒完成，跨档排序断言前显式 `fs.utimesSync` 钉 mtime（session.journal.test.ts 先例）。

## File Structure

| 文件 | 动作 | 职责 |
|------|------|------|
| `src/tui/session-journal.ts` | Modify | 删 `ACTIVE_POINTER`/`readActivePointer`/`writeActivePointer` 与 4 个写入点；头注释同步 |
| `src/tui/session.ts` | Modify | `resumeLatest()` 改 mtime 口径；新增 `resumeFlow()`（/resume 与启动选择卡共用）；opts 增 `resumePicker` |
| `src/tui/entry.ts` | Modify | `--resume` 旗标解析、双互斥校验、`resumePicker` 透传 |
| `src/cli/worktree-launch.ts` | Modify | `--resume` 与 `--worktree` 互斥校验（沿 `--continue` 先例同点位） |
| `src/cli/index.ts` | Modify | USAGE 双语 flags 行补 `--resume` |
| `src/config/data-dir.ts` | Modify | 注释正向化（开发测试专用重定向） |
| `src/config/settings.ts` | Modify | RETIRED_KEYS 与头注释口径同步 |
| `MANUAL.md` | Modify | 目录树摘指针行、数据目录段摘环境变量句、启动参数表与 flags 表补 `--resume` 行 |
| `CLAUDE.md` | Modify | §7 L115 DATA_DIR 定位句改「开发与测试专用重定向口」 |
| `src/tui/session-journal.test.ts` 等 5 个测试 | Modify | 指针断言改写/删除，新增零指针钉子 |
| `src/tui/session.resume.test.ts` | Create | 启动选择卡用例（选中/Esc/空目录） |
| `src/cli/entry-resume.test.ts` | Create | `--resume` 旗标互斥与透传判据用例 |

---

### Task 1: journal 去指针 + `--continue` mtime 口径

**Files:**
- Modify: `src/tui/session-journal.ts`（ACTIVE_POINTER 常量 L77、readActivePointer/writeActivePointer L80-96、branchFrom 写点 L189、attach 写点 L214、startId 写点 L231、头注释 L2/L6）
- Modify: `src/tui/session.ts:15`（import 去 readActivePointer）、`src/tui/session.ts:598-606`（resumeLatest）
- Modify: `src/tui/session-journal.test.ts`、`src/tui/session.journal.test.ts`、`src/tui/session-journal.branch.test.ts`、`src/tui/session.rewind.test.ts`、`src/tui/session.turnlog.test.ts`

**Interfaces:**
- Consumes: 既有 `listSessions(dataDir): SessionMeta[]`（mtime 降序，session-journal.ts L172）
- Produces: `readActivePointer`/`writeActivePointer` 从模块导出面整体消失；`SessionJournal.start/rotate/attach/log/branchFrom` 签名不变（行为去指针）；`resumeLatest()` 签名不变

- [ ] **Step 1: 红灯——零指针钉子替换旧指针用例**

`src/tui/session-journal.test.ts`：删除文件末尾的 `test('活动指针：写入后可读回；无指针/损坏返回 undefined', ...)`（L205-210）与 import 中的 `readActivePointer`/`writeActivePointer`（L11/L14），在同位置新增：

```ts
test('建档/轮转/续挂：目录树零指针文件，最近会话由 listSessions 解析', () => {
  const dataDir = tmp();
  const j = new SessionJournal(dataDir);
  j.start();
  j.log({ t: 'user', text: '你好' });
  assert.equal(fs.existsSync(path.join(dataDir, 'sessions-active.json')), false, '建档后目录树无指针文件');
  j.rotate(newSessionId());
  assert.equal(fs.existsSync(path.join(dataDir, 'sessions-active.json')), false, '轮转后仍无指针文件');
  const b = new SessionJournal(dataDir);
  b.attach(j.currentId!);
  assert.deepEqual(
    fs.readdirSync(dataDir).filter((n) => n !== 'sessions'),
    [],
    'dataDir 顶层仅 sessions 目录',
  );
});
```

同文件既有用例就地改写（删指针断言行，其余断言不动）：
- L43 `assert.equal(readActivePointer(dataDir), id, '建档即切指针');` → 删除
- L70 `assert.equal(readActivePointer(dataDir), newId, '指针=轮转会话');` → 删除
- L82 `assert.equal(readActivePointer(dataDir), id, 'attach 即切指针');` → 删除

- [ ] **Step 2: 跑红灯确认**

Run: `node --test dist/tui/session-journal.test.js`（先 `pnpm build`；或 `npx tsc && node --test dist/tui/session-journal.test.js`）
Expected: FAIL——现存实现写入 `sessions-active.json`，`fs.existsSync(...) === false` 断言不成立。

- [ ] **Step 3: 实现——journal 摘除指针**

`src/tui/session-journal.ts`：
1. 删 `const ACTIVE_POINTER = 'sessions-active.json';`（L77）与 `readActivePointer`、`writeActivePointer` 两个导出函数（L80-96）。
2. `branchFrom()` 末尾 `writeActivePointer(dataDir, newId);` 删除。
3. `attach()` 中 `writeActivePointer(this.dataDir, id);` 删除（方法体只剩 `this.id = id;`）。
4. `startId()` 中 `writeActivePointer(this.dataDir, id);` 删除。
5. 头注释 L2 `+ data/sessions-active.json 活动指针` 删除；L6 `写=事件级即时落盘（逐事件 append，运行中即写，崩溃丢失窗口=在飞一步；生命周期点写 header 与指针，` 改为 `写=事件级即时落盘（逐事件 append，运行中即写，崩溃丢失窗口=在飞一步；生命周期点写 header，`。

`src/tui/session.ts`：
1. L15 import 去 `readActivePointer`。
2. `resumeLatest()`（L598-606）整体替换为：

```ts
  /** --continue（规格 D1/D3）：续接最近会话（listSessions mtime 降序首项，对标 CC -c）；无档提示后按新会话继续（不静默吞） */
  resumeLatest(): void {
    const dataDir = resolveDataDir(this.root);
    const meta = listSessions(dataDir)[0];
    if (!meta) {
      this.pushMsg('system', t('No saved session to continue; started a fresh one', '没有可续接的已保存会话，已开启新会话'), { level: 'warn' });
      return;
    }
    this.restoreFromSession(meta);
  }
```

- [ ] **Step 4: 既有测试的指针消费面同步改写**

- `src/tui/session.journal.test.ts`：
  - import（L8）去 `readActivePointer`。
  - L85 `const activeId = readActivePointer(dataDir);` 及 utimes 钉扎循环改按摘要定位：`const newer = listSessions(dataDir).find((m) => m.firstUser === '任务乙')!;` 循环体内 `new Date(m.id === newer.id ? 2_000_000_000 : 1_000_000_000)`。
  - L91 `assert.equal(readActivePointer(dataDir), metas[0].id, ...)` → 删除（`metas[0].firstUser === '任务乙'` 断言已覆盖排序）。
  - L154 `assert.equal(readActivePointer(dataDir), id, '指针保持指向被恢复会话');` → 删除（恢复成功已由横幅/消息断言覆盖）。
  - L180-181 `const { writeActivePointer } = await import(...); writeActivePointer(dataDir, id);` → 两行删除（手工日志档已在盘、mtime 为当前时间，`--continue` 按 listSessions 首项自然选中）。
- `src/tui/session-journal.branch.test.ts`：import（L7）去 `readActivePointer`；L38 `assert.equal(readActivePointer(dataDir), newId);` → `assert.equal(fs.existsSync(path.join(dataDir, 'sessions-active.json')), false, '分档后目录树仍无指针文件');`
- `src/tui/session.rewind.test.ts`：import（L10）去 `readActivePointer`；4 处 `const srcId = readActivePointer(dataDir)!;` → `const srcId = listSessions(dataDir)[0]!.id;`（此时仅一档在盘）；L91 `assert.notEqual(readActivePointer(dataDir), srcId, ...)` → 删除（紧随其后的 branched/forkedFrom 断言已覆盖分档产物）。import 补 `listSessions`（若该行已含则只去 readActivePointer）。
- `src/tui/session.turnlog.test.ts`：import 去 `readActivePointer` 补 `listSessions`；L37 `const id = readActivePointer(dataDir);` → `const id = listSessions(dataDir)[0]!.id;`；L60 同形态 `readActivePointer(dataDir)!` → `listSessions(dataDir)[0]!.id`。

- [ ] **Step 5: 定向套件绿**

Run: `npx tsc && node --test dist/tui/session-journal.test.js dist/tui/session.journal.test.js dist/tui/session-journal.branch.test.js dist/tui/session.rewind.test.js dist/tui/session.turnlog.test.js dist/tui/session.selector.test.js`
Expected: 全部 PASS（selector 套件零改动必须仍绿——其断言只用 listSessions）。

- [ ] **Step 6: 残留核查 + 提交**

Run: `grep -rn "ActivePointer\|sessions-active" src/ | grep -v "\.test\."` → 零命中（测试文件也应在 Step 4 后零命中）。

```bash
git add src/tui/session-journal.ts src/tui/session.ts src/tui/session-journal.test.ts src/tui/session.journal.test.ts src/tui/session-journal.branch.test.ts src/tui/session.rewind.test.ts src/tui/session.turnlog.test.ts
git diff --cached --stat   # 核对仅含本线 7 文件
git commit -m "refactor(session): 最近会话解析统一走会话档 mtime，journal 摘除显式活动指针"
```

---

### Task 2: `--resume` 启动选择卡（resumeFlow 共用单点）

**Files:**
- Modify: `src/tui/session.ts`（/resume 分支 L1018-1057 改调 `resumeFlow()`；opts 接口 L126 附近增 `resumePicker?: boolean`；构造区 L294 增启动选择卡分流；新增私有方法 `resumeFlow`）
- Modify: `src/tui/session.resume.test.ts`（Create）

**Interfaces:**
- Consumes: `this.askUser(req: AskUserRequest): Promise<AskUserAnswer>`、`this.resolveAskAnswer(a)`、`this.pushMsg`、`this.restoreFromSession(meta)`、`this.journal?.currentId`、`paginateOptions(options, page)`（session.ts L144，8 条/页，自动追加 More…/Back…）
- Produces: `resumeFlow(): Promise<void>`（私有，/resume 与启动选择卡共用）；`SessionControllerOpts.resumePicker?: boolean`（Task 3 的 entry.ts 透传消费）

- [ ] **Step 1: 红灯——启动选择卡用例**

新建 `src/tui/session.resume.test.ts`（沿 session.selector.test.ts 夹具形态）：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { listSessions } from './session-journal';

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-resume-'));
}

function pinDataDir(root: string): string {
  const dataDir = path.join(root, '.data-pin');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.SUNSHINEX_DATA_DIR = dataDir;
  return dataDir;
}

function messageTexts(ctrl: SessionController): string {
  return ctrl.getState().messages.map((m) => m.text).join('\n');
}

test('resumePicker：构造后即弹会话选择卡 → 选中 → 恢复目标会话', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    const ctrl1 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"要恢复的答复"}']) });
    await ctrl1.submit('造档任务');
    await ctrl1.waitIdle();
    const sessions = listSessions(dataDir);
    assert.equal(sessions.length, 1, '前置：1 个存档会话');

    // 事件级落盘：选择卡挂起发生在首个持久化事件之前，此档由造档任务产生；期望候选排除该命令自建档的口径与 /resume 一致
    const ctrl2 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"忽略"}']), resumePicker: true });
    await waitFor(() => ctrl2.getState().status === 'awaiting-question');
    const labels = ctrl2.getState().question?.options.map((o) => o.label) ?? [];
    assert.ok(labels.includes(sessions[0].id), '选择卡列出存档会话');
    ctrl2.resolveAskAnswer({ type: 'selected', labels: [sessions[0].id] });
    await waitFor(() => ctrl2.getState().status === 'idle');
    assert.ok(messageTexts(ctrl2).includes('要恢复的答复'), '选定后重放目标会话消息面');
  } finally {
    process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resumePicker：Esc 放弃 → 新会话继续（回执上屏）', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  pinDataDir(tmp);
  try {
    const ctrl1 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl1.submit('造档任务');
    await ctrl1.waitIdle();
    const ctrl2 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"忽略"}']), resumePicker: true });
    await waitFor(() => ctrl2.getState().status === 'awaiting-question');
    ctrl2.resolveAskAnswer({ type: 'dismissed' });
    await waitFor(() => ctrl2.getState().status === 'idle');
    assert.ok(messageTexts(ctrl2).includes('Resume cancelled'), '放弃回执上屏（与 /resume 同文案通道）');
    assert.equal(ctrl2.getState().status, 'idle');
  } finally {
    process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resumePicker：空目录 → 回执「暂无已保存会话」后按新会话继续', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  pinDataDir(tmp);
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]), resumePicker: true });
    await waitFor(() => ctrl.getState().status === 'idle');
    assert.ok(messageTexts(ctrl).includes('暂无已保存会话') || messageTexts(ctrl).includes('No saved sessions yet'), '空目录回执');
  } finally {
    process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑红灯确认**

Run: `npx tsc && node --test dist/tui/session.resume.test.js`
Expected: FAIL——`opts.resumePicker` 类型不存在（TS2353）/ 选择卡不弹（waitFor 超时）。

- [ ] **Step 3: 实现——resumeFlow 单点 + 启动挂接**

`src/tui/session.ts`：

1. opts 接口（L126 `continueLast?: boolean;` 邻位）增 `/** 启动即弹会话选择卡（--resume） */ resumePicker?: boolean;`
2. 构造区尾部（L294 `if (opts.continueLast) this.resumeLatest();` 之前）增：

```ts
    if (opts.resumePicker) void this.resumeFlow();
```

3. /resume 分支（L1018-1057）整段替换为：

```ts
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /resume unavailable now', '当前有任务进行中，暂不能执行 /resume'), { level: 'warn' });
        return;
      }
      await this.resumeFlow();
      return;
```

4. 在 /resume 分支可达的类内位置（`resumeLatest()` 邻位）新增 `resumeFlow()`——候选过滤、文案、分页交互逐字自现 /resume 分支（L1024-1057）迁移，仅候选行补去重说明：

```ts
  /** 会话恢复选择卡（/resume 与 --resume 启动共用单点）：mtime 降序候选（排除当前在飞会话）→ askUser 挂起 → restoreFromSession */
  private async resumeFlow(): Promise<void> {
    const dataDir = resolveDataDir(this.root);
    // /resume 候选排除当前在飞会话（事件级落盘：命令输入自身即时建档，不排除会把本次命令的自建档选为最新恢复目标）
    const currentId = this.journal?.currentId;
    const sessions = listSessions(dataDir).filter((s) => s.id !== currentId);
    if (sessions.length === 0) {
      this.pushMsg('system', t('No saved sessions yet', '暂无已保存会话'), { level: 'warn' });
      return;
    }
    const moreLabel = t('More…', '更多…');
    const backLabel = t('Back…', '上一页…');
    let page = 0;
    for (;;) {
      const shown = paginateOptions(
        sessions.map((s) => ({ label: s.id, description: s.firstUser ? s.firstUser.slice(0, 60) : t('(no user input)', '（无用户输入）') })),
        page,
      );
      const answer = await this.askUser({
        question: t('Resume which session?', '恢复哪个会话？'),
        options: shown.options,
      });
      if (answer.type === 'dismissed') {
        this.pushMsg('system', t('Resume cancelled', '已取消恢复'));
        return;
      }
      const pickedId = answer.type === 'custom' ? answer.text.trim() : (answer.labels[0] ?? '');
      if (pickedId === moreLabel) { page += 1; continue; }
      if (pickedId === backLabel) { page -= 1; continue; }
      const pick = sessions.find((s) => s.id === pickedId);
      if (!pick) {
        this.pushMsg('system', t('No such session: ' + pickedId, '没有这个会话：' + pickedId), { level: 'warn' });
        return;
      }
      this.restoreFromSession(pick);
      return;
    }
  }
```

5. 空目录时序注记：`resumePicker` 路径下 `journal` 尚未建档（无任何事件），`currentId` 为 undefined、候选即全量——零额外代码，测试空目录用例已覆盖。

- [ ] **Step 4: 定向套件绿（含既有 /resume 套件回归）**

Run: `npx tsc && node --test dist/tui/session.resume.test.js dist/tui/session.selector.test.js dist/tui/session.journal.test.js`
Expected: 全 PASS——selector 套件行为零变化（resumeFlow 迁移保文案逐字一致）。

- [ ] **Step 5: 提交**

```bash
git add src/tui/session.ts src/tui/session.resume.test.ts
git diff --cached --stat
git commit -m "feat(tui): resumeFlow 会话恢复选择卡单点，--resume 启动挂接（resumePicker）"
```

---

### Task 3: `--resume` 启动旗标（entry 解析 + 双互斥 + USAGE）

**Files:**
- Modify: `src/tui/entry.ts:39-40`（`--resume` 解析、与 `--continue` 同传 fail-fast、`resumePicker` 透传）
- Modify: `src/cli/worktree-launch.ts`（`--resume` 与 `--worktree` 互斥，沿 `--continue` 校验同点位 L14-16）
- Modify: `src/cli/index.ts`（usageText 双语 flags 行补 `--resume`）
- Modify: `src/cli/entry-resume.test.ts`（Create）

**Interfaces:**
- Consumes: Task 2 的 `resumePicker` opts 通道；`resolveWorktreeLaunchRoot(args, root)`（worktree-launch.ts，已有 `--continue` 互斥先例）；`runTui(args: CliArgs)`
- Produces: `sunshinex [dir] --resume` 端到端可用；`--resume`+`--continue` 与 `--resume`+`--worktree` 同传均 fail-fast

- [ ] **Step 1: 红灯——旗标判据用例**

新建 `src/cli/entry-resume.test.ts`（纯函数面，不启 TUI）：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, usageText } from './index';
import { resolveWorktreeLaunchRoot } from './worktree-launch';

test('--resume 与 --continue 同传：fail-fast', () => {
  const args = parseArgs(['--resume', '--continue']);
  assert.throws(
    () => resolveResumeFlag(args),
    (e: unknown) => e instanceof Error && /--continue/.test((e as Error).message) && /--resume/.test((e as Error).message),
  );
});

test('--resume 与 --worktree 同传：fail-fast（沿 --continue 先例同点位）', () => {
  const args = parseArgs(['--resume', '--worktree']);
  assert.throws(
    () => resolveWorktreeLaunchRoot(args, '/tmp/repo'),
    (e: unknown) => e instanceof Error && /--resume/.test((e as Error).message) && /--worktree/.test((e as Error).message),
  );
});

test('usageText 双语 flags 行含 --resume', () => {
  assert.match(usageText(), /--resume \(TUI, open the session picker to resume\)/);
});
```

注：`resolveResumeFlag` 从 `src/tui/entry.ts` 导出（纯函数，不触发 TUI 副作用；import 面只引该函数）。

- [ ] **Step 2: 跑红灯确认**

Run: `npx tsc && node --test dist/cli/entry-resume.test.js`
Expected: FAIL——`resolveResumeFlag` 未导出、worktree-launch 无 `--resume` 校验、usage 无该行。

- [ ] **Step 3: 实现——三处**

1. `src/tui/entry.ts`：L39 `const continueLast = ...` 之前新增导出纯函数并接线：

```ts
/** --resume 启动旗标判据：与 --continue 同传 fail-fast（前者弹选择卡、后者直取最近，择一语义） */
export function resolveResumeFlag(args: CliArgs): boolean {
  if (args.flags.resume !== undefined && args.flags['continue'] === true) {
    throw new Error(t('--resume and --continue are mutually exclusive: --resume opens the session picker, --continue resumes the latest directly', '--resume 与 --continue 互斥：--resume 弹会话选择卡，--continue 直接续接最近会话'));
  }
  return args.flags.resume === true;
}
```

L40 控制器构造改为：

```ts
  const resumePicker = resolveResumeFlag(args);
  const ctrl = new SessionController({ root: launchRoot, mode, model, ...(tier ? { tier } : {}), ...(effort ? { effort } : {}), ...(continueLast ? { continueLast: true } : {}), ...(resumePicker ? { resumePicker: true } : {}) });
```

2. `src/cli/worktree-launch.ts`：既有 `--continue` 互斥块（L14-16）扩为双旗标：

```ts
  if (args.flags['continue'] === true || args.flags.resume !== undefined) {
    const other = args.flags['continue'] === true ? '--continue' : '--resume';
    throw new Error(`${other} and --worktree are mutually exclusive: resume keeps the session root, --worktree starts a fresh isolated tree`);
  }
```

3. `src/cli/index.ts` usageText：en flags 行 `--continue (TUI, resume last session)` 改 `--continue (TUI, resume latest session)  --resume (TUI, open the session picker to resume)`；zh 行 `--continue（TUI 续接最近会话）` 改 `--continue（TUI 直接续接最近会话）  --resume（TUI 弹会话选择卡恢复）`。

- [ ] **Step 4: 定向套件绿（含既有 CLI 套件回归）**

Run: `npx tsc && node --test dist/cli/entry-resume.test.js dist/cli/cli.test.js dist/cli/worktree-launch.test.js`
Expected: 全 PASS（worktree-launch 既有 `--continue` 互斥用例保持绿）。

- [ ] **Step 5: 提交**

```bash
git add src/tui/entry.ts src/cli/worktree-launch.ts src/cli/index.ts src/cli/entry-resume.test.ts
git diff --cached --stat   # 若 index.ts/worktree-launch.ts 混叠他线 hunk：暂存态核对，重叠时沿「临时索引+commit-tree」先例按 hunk 隔离
git commit -m "feat(cli): --resume 启动旗标——会话选择卡恢复、与 --continue/--worktree 双互斥"
```

---

### Task 4: 数据目录口径收敛 + 文档面收口 + 全量门禁

**Files:**
- Modify: `src/config/data-dir.ts:6-7`（头注释①）
- Modify: `src/config/settings.ts:8-10`（头注释）与 `RETIRED_KEYS.dataDir`（L51）
- Modify: `CLAUDE.md:115`
- Modify: `MANUAL.md`（L151 指针行、L163 环境变量段、CLI 表 L40 后、L50 flags 表 --continue 行）
- 验证：全量三门禁 + 残留 grep

**Interfaces:**
- Consumes: 无（纯注释与文档）
- Produces: 用户面文档（MANUAL）对 `SUNSHINEX_DATA_DIR` 零残留；全仓 `sessions-active|ActivePointer` 零命中（specs 存档除外）

- [ ] **Step 1: 注释与文档正向化（先改后验）**

`src/config/data-dir.ts` 头注释①改为：

```ts
 * - ① SUNSHINEX_DATA_DIR 显式覆盖（整目录直指；**开发与测试专用**重定向口——测试钉数据目录、
 *      CI 隔离运行时数据；已从 settings.json 语义键表退役——留在用户配置面会诱导跨项目共用一份记忆与账本）
```
`src/config/settings.ts` 头注释（L8-10）改为：

```ts
 * - SUNSHINEX_DATA_DIR 亦不进本表：它是「整目录直指」的**开发与测试专用**重定向口（测试钉数据目录、CI 隔离运行时数据），
 *   留在用户配置面即诱导误用（多工作区共用一份 sessions/memory/runs/skills，记忆索引还会跨项目注入提示词），
 *   故只保留在环境变量面，见 RETIRED_KEYS；用户级换盘一律走 projectsDir。
```

`RETIRED_KEYS.dataDir`（L51）改为：

```ts
  dataDir: 'dataDir 须走 projectsDir（按工作区分目录隔离）；SUNSHINEX_DATA_DIR 是开发与测试专用重定向口，用户配置面以 projectsDir 为准',
```

`CLAUDE.md:115` 句尾：`SUNSHINEX_DATA_DIR（整目录直指、**不按工作区隔离**）只作测试与多实例口留在环境变量面，不进 settings.json 语义键表` 整句替换为 `SUNSHINEX_DATA_DIR（整目录直指）是开发与测试专用重定向口（测试钉数据目录、CI 隔离运行时数据），留在环境变量面、不进 settings.json 语义键表`。

`MANUAL.md`：
1. L151 `    ├── sessions-active.json    # 最近会话指针` 整行删除。
2. L150 `sessions/` 行改 `    ├── sessions/               # 会话日志（/resume、resume、--continue 据此恢复）`。
3. L163 整段替换为：`> `SUNSHINEX_DATA_DIR` 是**开发与测试专用**的环境变量重定向口，用户配置面以 `projectsDir` 为准（换盘、分区都走它）。`
4. CLI 表（L40 `sunshinex pipeline ...` 行之后）保持不动；启动参数表（L50 附近）`--continue` 行改：`| `--continue` | 直接续接最近一次会话（按会话档时间自动判定，TUI 专属，与 `--worktree` 互斥） |`，其下补一行：`| `--resume` | 启动时弹会话选择卡恢复既有会话（TUI 专属，与 `--continue`/`--worktree` 互斥） |`

- [ ] **Step 2: 全量门禁**

Run: `pnpm build && pnpm test && pnpm selfcheck`
Expected: tsc 零报错、全量 fail 0、selfcheck OK。

- [ ] **Step 3: 残留终验（删除即无痕钉死）**

Run: `grep -rn "sessions-active\|ActivePointer\|readActivePointer\|writeActivePointer" src/ MANUAL.md CLAUDE.md README.md docs/ROADMAP.md docs/Arch-Plan.md` → 零命中（`docs/superpowers/` 历史存档除外）；`grep -n "SUNSHINEX_DATA_DIR" MANUAL.md` → 零命中。README 零命中已核实（实施前 grep 无该词）。

- [ ] **Step 4: 提交**

```bash
git add src/config/data-dir.ts src/config/settings.ts CLAUDE.md MANUAL.md
git diff --cached --stat
git commit -m "docs(config): 数据目录口径收敛为开发测试专用口，手册目录树与命令面同步"
```

