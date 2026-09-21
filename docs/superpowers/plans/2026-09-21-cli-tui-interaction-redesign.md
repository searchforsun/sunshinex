# TUI 斜杠命令选择题化 + CLI 入口判界 + 文档拆分 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 枚举型 TUI 命令全部选择卡交互（禁止手填）、命令面扁平化 18 条、CLI 入口判界统一（裸命令/路径形态/`--workdir`，`tui` 子命令废除）、文档拆分为 MANUAL.md（使用手册）与 README.md（架构与工程）。

**Architecture:** 纯交互面改造——session.ts 斜杠分发收敛为「命令表驱动 + 裸形式守卫」，卡片复用既有 askUser 通道（AskUserRequest/AskUserAnswer 三态），分页收编为纯函数单点；CLI 侧 parseArgs/resolveInvocation 三分支归一 + resolveDirArg 目录来源单点；文档层 git mv 保历史 + 引用面同步。

**Tech Stack:** TypeScript strict（Node ≥ 22.9）、ink（TUI 选择器既有组件）、node:test。

**规格:** `docs/superpowers/specs/2026-09-21-cli-tui-interaction-redesign.md`（D1–D10 裁决、§4 命令面终表、§5 选择卡交互、§6 CLI 判界、§7 文档拆分）

## Global Constraints

- 包管理器 pnpm 不在 PATH：构建 `node_modules/.bin/tsc -p tsconfig.json`；全量 `node scripts/run-tests.js`（先编译后测试）；selfcheck `node dist/cli/index.js selfcheck`
- 定向测试：`node --test dist/<测试文件路径>.test.js`（测试源编译进 dist 后执行）
- 每任务 TDD 红→绿→提交；`git add` 只加本任务文件——工作区他线 WIP 零卷入
- i18n：一切用户可见文案 `t(en, zh)` 双语运行期求值（禁模块级冻结）；报错走 warn 级 system 消息 / stderr
- 用户可见文案禁出现「已删除/已退役/不再支持」类存在史表述（删除即无痕，CLAUDE.md §10）
- 提交信息中文、约定式前缀（feat/docs/fix/chore）

## File Structure

| 文件 | 职责 | 改动 |
|---|---|---|
| `src/cli/index.ts` | CLI 入口与判界 | parseArgs 裸命令、COMMANDS 摘 tui、isPathForm/resolveDirArg 单点、usageText 重写、main unrecognized 分支 |
| `src/cli/cli.test.ts` | CLI 判界用例 | resolveInvocation 3 旧例反写 + 新增判据用例 |
| `src/cli/commands/run-loop.ts` | run 子命令 | 目录改走 resolveDirArg |
| `src/cli/commands/run-pipeline.ts` | pipeline 子命令 | 同上 |
| `src/tui/session.ts` | TUI 会话控制 | handleSlash 命令表守卫、handleModel 删除、/model·/model-effort 卡、/memory 族 6 命令、/resume 收口、paginate 单点 |
| `src/tui/components/App.tsx` | Tab 补全 | SLASH_COMMANDS 18 条 |
| `MANUAL.md` | 使用手册（CLI+TUI） | TUI-MANUAL.md git mv + CLI 章扩写 |
| `README.md` | 架构与工程 | 职责重排、使用细节外链 |
| `docs/superpowers/specs/2026-09-21-cli-tui-interaction-redesign.md` | 规格 | §6.2 同传优先级勘误 |

---

### Task 1: CLI 入口判界统一

**Files:**
- Modify: `src/cli/index.ts`（parseArgs 兜底、COMMANDS、resolveInvocation、新增 isPathForm/resolveDirArg、usageText、main）
- Modify: `src/cli/commands/run-loop.ts:14-19`、`src/cli/commands/run-pipeline.ts`（runPipeline 头部目录解析）
- Modify: `docs/superpowers/specs/2026-09-21-cli-tui-interaction-redesign.md`（§6.2 同传优先级勘误）
- Test: `src/cli/cli.test.ts`

**Interfaces:**
- Consumes: 既有 `CliArgs`（command/positional/flags）、`runTui(args)`（positional[0]=目录）
- Produces: `isPathForm(arg: string): boolean`；`resolveDirArg(args: CliArgs): { dir?: string; ignored?: string; unrecognized?: string }`——run-loop/run-pipeline/main 三处共用的目录来源单点；`resolveInvocation` 对裸词返回 `command: 'unrecognized'`

- [ ] **Step 1: 规格勘误先行（独立小提交）**

§6.2 既有行「`--workdir` 与位置路径同传时位置参数优先（提示其一被忽略，不报错）」与后补裁决「--workdir 优先」矛盾。将旧行整句改为：

```markdown
- flags 与位置参数解耦：`--mode=plan --workdir=/x` 等直通形式不受影响（同传优先级见 run/pipeline 判据条）
```

```bash
git add docs/superpowers/specs/2026-09-21-cli-tui-interaction-redesign.md
git commit -m "docs(specs): CLI 判界同传优先级勘误统一 --workdir 优先"
```

- [ ] **Step 2: 写失败测试（cli.test.ts：反写 3 旧例 + 新增判据用例）**

保留文件内既有 parseArgs 用例，替换 L38-53 三条 resolveInvocation 用例并追加：

```typescript
test('resolveInvocation：裸命令归一为 tui（当前工作区）', () => {
  const a = resolveInvocation(parseArgs([]));
  assert.equal(a.command, 'tui');
  assert.deepEqual(a.positional, []);
});

test('resolveInvocation：路径形态位置参数归一为 tui 指定目录', () => {
  for (const dir of ['/abs/proj', '../my-project', './x', '.', 'a/b', 'D:\\work\\p']) {
    const a = resolveInvocation(parseArgs([dir]));
    assert.equal(a.command, 'tui');
    assert.deepEqual(a.positional, [dir]);
  }
});

test('resolveInvocation：裸词不识别（含废除形态的 tui 首词）', () => {
  for (const word of ['foo', 'my-project', 'tui']) {
    assert.equal(resolveInvocation(parseArgs([word])).command, 'unrecognized');
  }
});

test('resolveInvocation：已知子命令透传、flag 直通', () => {
  assert.equal(resolveInvocation(parseArgs(['selfcheck'])).command, 'selfcheck');
  assert.equal(resolveInvocation(parseArgs(['help'])).command, 'help');
  const a = resolveInvocation(parseArgs(['--mode=plan']));
  assert.equal(a.command, 'tui');
  assert.equal(a.flags.mode, 'plan');
});

test('isPathForm 判据：绝对/./..开头/含分隔符为真，裸词与点前缀文件名为假', () => {
  for (const p of ['/a/b', '../a', './a', '.', 'a/b', 'D:\\w', 'D:/w']) assert.ok(isPathForm(p));
  for (const p of ['proj', '', '.env', 'help']) assert.ok(!isPathForm(p));
});

test('resolveDirArg：--workdir 优先于位置路径并登记 ignored', () => {
  const d = resolveDirArg(parseArgs(['../a', '--workdir=/b']));
  assert.equal(d.dir, '/b');
  assert.equal(d.ignored, '../a');
});

test('resolveDirArg：仅 flag / 仅路径 / 皆缺 / 裸词四态', () => {
  assert.equal(resolveDirArg(parseArgs(['--workdir=/b'])).dir, '/b');
  assert.equal(resolveDirArg(parseArgs(['../a'])).dir, '../a');
  assert.equal(resolveDirArg(parseArgs([])).dir, undefined);
  assert.equal(resolveDirArg(parseArgs(['proj'])).unrecognized, 'proj');
});
```

- [ ] **Step 3: 跑定向确认红灯**

```bash
node_modules/.bin/tsc -p tsconfig.json && node --test dist/cli/cli.test.js
```

预期：FAIL（isPathForm/resolveDirArg 未导出、tui 仍在 COMMANDS、裸词归一为 tui）。

- [ ] **Step 4: 实现 cli/index.ts**

```typescript
/** 已知子命令清单：首个 positional 命中其一按子命令分发（tui 为内部派发键、非用户子命令） */
const COMMANDS = ['selfcheck', 'run', 'pipeline', 'help'];

/** 路径形态判据（规格 §6.2）：绝对路径（POSIX `/` 前缀、Windows 盘符）、`.`/`..` 显式相对形态、或含路径分隔符 */
export function isPathForm(arg: string): boolean {
  if (!arg) return false;
  if (/^(?:[A-Za-z]:)?[\\/]/.test(arg)) return true;
  if (arg === '.' || arg === '..' || arg.startsWith('./') || arg.startsWith('../') || arg.startsWith('.\\') || arg.startsWith('..\\')) return true;
  return /[/\\]/.test(arg);
}

/** 目录来源统一单点（顶层与 run/pipeline 同判据，规格 §6.2）：--workdir flag 优先于位置路径（同传登记 ignored）；
 *  路径形态判据外的一切裸词报 unrecognized */
export function resolveDirArg(args: CliArgs): { dir?: string; ignored?: string; unrecognized?: string } {
  const positional = args.positional[0];
  const flagDir = typeof args.flags.workdir === 'string' && args.flags.workdir ? args.flags.workdir : undefined;
  if (positional && flagDir) return { dir: flagDir, ignored: positional };
  if (flagDir) return { dir: flagDir };
  if (!positional) return {};
  if (isPathForm(positional)) return { dir: positional };
  return { unrecognized: positional };
}

export function resolveInvocation(args: CliArgs): CliArgs {
  if (args.command === '') return { ...args, command: 'tui' };
  if (COMMANDS.includes(args.command)) return args;
  if (isPathForm(args.command)) return { command: 'tui', positional: [args.command, ...args.positional], flags: args.flags };
  return { ...args, command: 'unrecognized' };
}
```

parseArgs 兜底行 `?? 'tui'` 改 `?? ''`（注释同步：裸命令=当前工作区 TUI）。main() 的 switch 改为：

```typescript
  if (args.command === 'unrecognized') {
    console.error(t('Unrecognized command. Run sunshinex help for usage.', '无法识别命令，使用 sunshinex help 查看使用方法'));
    process.exit(1);
  }
  switch (args.command) {
    case 'selfcheck':
      return runSelfcheck(args);
    case 'run':
      return runLoop(args);
    case 'pipeline':
      return runPipeline(args);
    case 'tui': {
      const d = resolveDirArg(args);
      if (d.unrecognized) {
        console.error(t('Unrecognized command. Run sunshinex help for usage.', '无法识别命令，使用 sunshinex help 查看使用方法'));
        process.exit(1);
      }
      if (d.ignored) console.warn(t(`--workdir takes precedence; ignoring positional dir ${d.ignored}`, `--workdir 优先，位置参数目录 ${d.ignored} 已忽略`));
      return runTui({ ...args, positional: d.dir ? [d.dir] : [] });
    }
    default:
      console.log(usageText());
  }
```

run-loop.ts 与 run-pipeline.ts 的目录解析（两处同款）改为：

```typescript
  const d = resolveDirArg(args);
  if (d.unrecognized) {
    console.error(`无法识别命令：${d.unrecognized}——使用 sunshinex help 查看使用方法`);
    process.exitCode = 1;
    return;
  }
  if (d.ignored) console.warn(`--workdir 优先，位置参数目录 ${d.ignored} 已忽略`);
  const dir = d.dir;
  if (!dir) throw new Error('用法：sunshinex run <dir> --goal="一句可度量的目标终态（复杂目标可内嵌：验收标准：id=描述）"');
```

（run-pipeline 的用法串用其既有文案；`import { resolveDirArg } from '../index'`。）

usageText() 整体重写（en/zh 两段结构对称）：

```
en:
SunshineX CLI
  sunshinex                               enter the interactive session terminal in the current workspace (default)
  sunshinex [dir]                         start in the given directory (path-form arg; or --workdir=<dir>)
  sunshinex help                          show this usage (--help / -h)
  sunshinex selfcheck                     skeleton self-check (perception/tools/security/context/Loop/Graph)
  sunshinex run <dir> --goal="..."        run the standard verify-fix loop (exit code 1 unless done)
  sunshinex pipeline <dir> --goal="..." [--yes]  five-node pipeline with gate approvals (--yes auto-approves)
  flags: --mode=manual|plan|dontAsk  --language=en|zh  --tier=small|medium|large  --effort=none|minimal|low|medium|high|xhigh|max
         --continue (TUI, resume last session)  --worktree[=<name>]  --workdir=<dir>

zh: 对称中文（直接进入当前工作区交互终端 / 指定目录启动（路径形态参数，或 --workdir=<目录>）/ 显示用法 / 骨架自检 /
    标准验收修正环（非 done 退出码 1）/ 五节点流水线 gate 审批（--yes 跳过交互直接批准）/ flags 行同构）
```

- [ ] **Step 5: 跑定向转绿 + 连带面核查**

```bash
node --test dist/cli/cli.test.js && node --test dist/cli/commands/run-loop.test.js && node --test dist/cli/commands/run-pipeline.test.js && node --test dist/cli/worktree-launch.test.js
```

若 run-loop/run-pipeline 既有用例以裸词目录构造 CliArgs（如 `positional: ['proj']`），改为绝对路径夹具（`path.join(tmp, 'proj')`）；USAGE 断言用例同步新 usageText 文案。

- [ ] **Step 6: 提交**

```bash
git add src/cli/index.ts src/cli/cli.test.ts src/cli/commands/run-loop.ts src/cli/commands/run-pipeline.ts
git commit -m "feat(cli): 入口判界统一——路径形态位置参数与 --workdir 直通，裸词不识别不启动"
```

---

### Task 2: TUI /model 与 /model-effort 选择卡化

**Files:**
- Modify: `src/tui/session.ts`（submit 的 /model 拦截 L303-306 删除、handleModel L871 整函数删除、handleSlash 新增 /model 与 /model-effort 卡分支、slashHelp 的 /model 行暂不动——Task 5 统一）
- Modify: `src/model/adapter.ts`（ModelAdapter 接口增可选 `resolvedEffort`，OpenAIAdapter 实现公开探测缓存读取）
- Test: `src/tui/session.test.ts`（L237-267 /model 用例反写）、`src/model/adapter.test.ts`（探测接缝钉子，沿既有 effort 套件形态）

**Interfaces:**
- Consumes: `askUser(req: AskUserRequest): Promise<AskUserAnswer>`（selected/dismissed）、`parseTier`/`parseEffort`/`EFFORT_ORDER`（session.ts 既有 import，来自 `../model/adapter`）、`logModel()`
- Produces: handleSlash 内联 `/model` 与 `/model-effort` 两分支（不新开私有方法——与既有 /resume 分支形态一致）

- [ ] **Step 1: 写失败测试（session.test.ts /model 用例反写 + 新增）**

删除 L237-267 旧 /model 用例（查询双查、/model huge、/model effort 系列），替换为：

```typescript
test('会话控制器：/model 弹卡三档即选即切，Esc 零变化', async () => {
  const { ctrl } = makeCtrl(); // 沿本文件既有夹具构造（runtime stub + 私有 tmp root）
  const p = ctrl.submit('/model');
  await waitFor(() => ctrl.state.status === 'awaiting-question');
  assert.deepEqual(ctrl.state.question?.options.map((o) => o.label), ['small', 'medium', 'large']);
  ctrl.resolveAskAnswer({ type: 'selected', labels: ['large'] });
  await p;
  assert.equal(ctrl.state.model, 'large');
});

test('会话控制器：/model Esc 取消不改档', async () => {
  const { ctrl } = makeCtrl();
  const p = ctrl.submit('/model');
  await waitFor(() => ctrl.state.status === 'awaiting-question');
  ctrl.resolveAskAnswer({ type: 'dismissed' });
  await p;
  assert.equal(ctrl.state.model, undefined);
});

test('会话控制器：/model-effort 八项单选、default 清覆盖', async () => {
  const { ctrl } = makeCtrl();
  const p = ctrl.submit('/model-effort');
  await waitFor(() => ctrl.state.status === 'awaiting-question');
  assert.deepEqual(ctrl.state.question?.options.map((o) => o.label), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'default']);
  ctrl.resolveAskAnswer({ type: 'selected', labels: ['high'] });
  await p;
  assert.equal(ctrl.state.effort, 'high');
  const p2 = ctrl.submit('/model-effort');
  await waitFor(() => ctrl.state.status === 'awaiting-question');
  ctrl.resolveAskAnswer({ type: 'selected', labels: ['default'] });
  await p2;
  assert.equal(ctrl.state.effort, undefined);
});

test('会话控制器：带参枚举形态统一无法识别（/model large、/model effort high）', async () => {
  const { ctrl, msgs } = makeCtrl();
  await ctrl.submit('/model large');
  await ctrl.submit('/model effort high');
  const texts = msgs.map((m) => m.text);
  assert.ok(texts.includes('Unrecognized command. Use /help to see available commands'));
});
```

（`makeCtrl`/`msgs`/`waitFor` 取本文件既有夹具名——第 2 步红灯前先读 session.test.ts 头部夹具段，按实名替换。）

- [ ] **Step 2: 跑定向确认红灯**

```bash
node_modules/.bin/tsc -p tsconfig.json && node --test dist/tui/session.test.js
```

预期：FAIL（/model 仍走 handleModel 文本解析：三档断言失败、effort 八项断言失败）。

- [ ] **Step 3: 实现 session.ts**

1. submit() 删除 L303-306 的 `/model` 拦截（`text.split(/\s+/)[0] === '/model'` 分支整体移除，统一落 handleSlash）。
2. 删除 `private handleModel(text: string)` 整个函数（L871 起）。
3. handleSlash 顶部（cmd 计算后）加裸形式守卫（本任务先落守卫本体，覆盖 /model；Task 3 扩全量）：

```typescript
    // 命令只认裸形式（规格 D2）：带参枚举形态与不在清单的命令词统一无法识别（自由文本参数命令除外，见 FREE_TEXT_ARGS）
    const FREE_TEXT_ARGS = new Set(['/compact', '/plan', '/goal', '/memory-add']);
    if (cmd.startsWith('/') && !FREE_TEXT_ARGS.has(cmd) && text !== cmd) {
      this.pushMsg('system', t('Unrecognized command. Use /help to see available commands', '无法识别命令，使用 /help 查看使用方法'), { level: 'warn' });
      return;
    }
```

（注意：本守卫落地后 handleSlash 尾部 L1176 旧「Unknown command」分支仅剩命令词不在清单的路径，Task 3 收口时合并为同一文案。）

4. handleSlash 新增两分支（置于 /resume 分支前，均先运行中守卫）：

```typescript
    if (cmd === '/model') {
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /model unavailable now', '当前有任务进行中，暂不能执行 /model'), { level: 'warn' });
        return;
      }
      const current = this.state.model;
      const answer = await this.askUser({
        question: t(current ? `Switch model tier (current: ${current})` : 'Switch model tier (current: default)', current ? `切换模型档位（当前 ${current}）` : '切换模型档位（当前默认）'),
        options: (['small', 'medium', 'large'] as const).map((tier) => ({ label: tier, description: tier === current ? t('current', '当前档') : undefined })),
      });
      if (answer.type === 'dismissed') {
        this.pushMsg('system', t('Model tier unchanged', '模型档位未变更'));
        return;
      }
      const tier = parseTier(answer.labels[0] ?? '');
      if (!tier) return;
      this.state = { ...this.state, model: tier };
      this.notify();
      this.logModel();
      this.pushMsg('system', t(`Model tier set to ${tier}; applies to subsequent tasks`, `模型档位已设为 ${tier}；对后续任务生效`));
      return;
    }
    if (cmd === '/model-effort') {
      if (this.state.status !== 'idle') {
        this.pushMsg('system', t('A task is running; /model-effort unavailable now', '当前有任务进行中，暂不能执行 /model-effort'), { level: 'warn' });
        return;
      }
      const current = this.state.effort;
      const answer = await this.askUser({
        question: t(current ? `Switch reasoning effort (current: ${current})` : 'Switch reasoning effort (current: adapter default)', current ? `切换思考强度（当前 ${current}）` : '切换思考强度（当前适配器缺省）'),
        options: [...EFFORT_ORDER, 'default'].map((v) => ({ label: v, description: v === current ? t('current override', '当前覆盖') : undefined })),
      });
      if (answer.type === 'dismissed') {
        this.pushMsg('system', t('Reasoning effort unchanged', '思考强度未变更'));
        return;
      }
      const value = answer.labels[0] ?? '';
      if (value === 'default') {
        this.state = { ...this.state, effort: undefined };
        this.notify();
        this.logModel();
        this.pushMsg('system', t('Reasoning effort cleared; adapter default applies to subsequent tasks', '思考强度已清除；后续任务回适配器缺省'));
        return;
      }
      const effort = parseEffort(value);
      if (!effort) return;
      this.state = { ...this.state, effort };
      this.notify();
      this.logModel();
      // 回执回显实际生效档（规格 §5.2）：端点不支持时探测降级，取 adapter 探测缓存；接口未实现/未探测时与请求档一致
      const resolved = this.runtime.harness.model.resolvedEffort?.(effort) ?? effort;
      this.pushMsg('system', t(`Reasoning effort set to ${resolved}; applies to subsequent tasks`, `思考强度已设为 ${resolved}；对后续任务生效`));
      return;
    }
```

5. 核对 `EFFORT_ORDER` 导出名（`grep -n "EFFORT_ORDER" src/model/adapter.ts`）；session.ts 无则补 import。

6. adapter 探测接缝（规格 §5.2 生效档回执的读取口）：`ModelAdapter` 接口（adapter.ts:43）增可选成员，OpenAIAdapter 以既有私有缓存 `effortResolved` 实现，Stub/Scripted 零改动（接口可选、零破坏）：

```typescript
// interface ModelAdapter 内追加：
  /** effort 探测缓存读取（§5.2 生效档回执）：请求档经降级探测后的实际生效档；未探测/未实现回 undefined（调用方回退请求档） */
  resolvedEffort?(requested: ReasoningEffort): ReasoningEffort | undefined;

// OpenAIAdapter 内追加：
  resolvedEffort(requested: ReasoningEffort): ReasoningEffort | undefined {
    return this.effortResolved?.requested === requested ? this.effortResolved.resolved : undefined;
  }
```

session 侧取值（Task 2 Step 3 的 /model-effort 回执行已用此形态）：`this.runtime.harness.model.resolvedEffort?.(effort) ?? effort`——router 装配下 `harness.model` 即 OpenAIAdapter 实例（runtime.ts:87 buildModel 单 adapter 直装），`.resolvedEffort?.` 可选链对 Stub/Scripted 自然回退请求档。

7. adapter.test.ts 追加探测接缝钉子（沿既有 effort 套件夹具）：

```typescript
test('OpenAIAdapter.resolvedEffort：未探测回 undefined，探测命中返回实际生效档', () => {
  const a = new OpenAIAdapter({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'http://x' });
  assert.equal(a.resolvedEffort?.('high'), undefined); // 未发起请求零探测
  // （探测命中路径沿既有 sendWithEffort 桩 fetch 用例形态：一次降级请求成功后 resolvedEffort('high') 返回降级档）
});
```

- [ ] **Step 4: 跑定向转绿**

```bash
node --test dist/tui/session.test.js && node --test dist/tui/session.selector.test.js && node --test dist/tui/session.ask.test.js
```

- [ ] **Step 5: 提交**

```bash
git add src/tui/session.ts src/tui/session.test.ts
git commit -m "feat(tui): /model 与 /model-effort 选择卡化，带参枚举形态统一无法识别"
```

---

### Task 3: /memory 族扁平化与 /memory-rm 多选卡

**Files:**
- Modify: `src/tui/session.ts`（/memory 分支整体重写为 6 命令分支 + memoryList/memoryAdd/memoryRm/memoryGc 私有方法；文件顶部新增 paginateOptions 纯函数）
- Test: `src/tui/session.memory.test.ts`（既有用例反写）、`src/tui/session.memory-toggle.test.ts`（on/off 用例反写）

**Interfaces:**
- Consumes: `MemoryStore`（`list(): MemoryRecord[]`、`remove(slug: string): Result<void>`、`count()`、`capacityNotice()`）、`scanMemoryText`、`consolidateMemory`、`isModelSummarizer`、`setMemorySessionOverride`（session.ts 既有 import）
- Produces: `paginateOptions(items, page?, pageSize?): { options; page; totalPages }`（导出纯函数，Task 4 /resume 复用）；新命令分支 `/memory-add <内容>`、`/memory-rm`、`/memory-gc`、`/memory-on`、`/memory-off`

- [ ] **Step 1: 写失败测试（session.memory.test.ts 反写 + 新增）**

旧用例反写为「无法识别」断言：`/memory add x`、`/memory rm <slug>`、`/memory off`（含 on）→ `Unrecognized command`。新增：

```typescript
test('会话控制器：/memory 无参列索引；/memory-on /memory-off 幂等', async () => {
  const { ctrl, msgs } = makeCtrl();
  await ctrl.submit('/memory');
  assert.ok(msgs.some((m) => m.text.includes('No memories yet') || m.text.includes('暂无记忆')));
  await ctrl.submit('/memory-on');
  await ctrl.submit('/memory-on'); // 幂等：重复开启不报错
  assert.ok(msgs.some((m) => m.text.includes('on for this session') || m.text.includes('已开启')));
  await ctrl.submit('/memory-off');
  assert.ok(msgs.some((m) => m.text.includes('off for this session') || m.text.includes('已关闭')));
});

test('会话控制器：/memory-add 空内容无法识别、正常内容入索引', async () => {
  const { ctrl, msgs } = makeCtrl();
  await ctrl.submit('/memory-add');
  assert.ok(msgs.some((m) => m.text.includes('Unrecognized') || m.text.includes('无法识别')));
  await ctrl.submit('/memory-add 项目使用 pnpm 作为包管理器');
  assert.ok(msgs.some((m) => m.text.includes('Added memory') || m.text.includes('已添加记忆')));
  await ctrl.submit('/memory');
  assert.ok(msgs.some((m) => m.text.includes('pnpm')));
});

test('会话控制器：/memory-rm 多选卡批删、Esc 零删、空索引守卫', async () => {
  const { ctrl, msgs } = makeCtrl();
  await ctrl.submit('/memory-rm'); // 空索引守卫
  assert.ok(msgs.some((m) => m.text.includes('No memories yet') || m.text.includes('暂无记忆')));
  await ctrl.submit('/memory-add fact-one');
  await ctrl.submit('/memory-add fact-two');
  const p = ctrl.submit('/memory-rm');
  await waitFor(() => ctrl.state.status === 'awaiting-question');
  assert.equal(ctrl.state.question?.multiple, true);
  assert.equal(ctrl.state.question?.options.length, 2);
  ctrl.resolveAskAnswer({ type: 'selected', labels: [ctrl.state.question!.options[0].label] });
  await p;
  const removedText = msgs[msgs.length - 1].text;
  assert.ok(/Removed 1/.test(removedText) || /已删除 1 条/.test(removedText));
  const p2 = ctrl.submit('/memory-rm');
  await waitFor(() => ctrl.state.status === 'awaiting-question');
  assert.equal(ctrl.state.question?.options.length, 1);
  ctrl.resolveAskAnswer({ type: 'dismissed' });
  await p2;
  assert.ok(msgs.some((m) => m.text.includes('No memories removed') || m.text.includes('未删除任何记忆')));
});
```

（/memory-gc 守卫沿用既有 gc 用例——stub 模型回执不变，入口改 `/memory-gc`。）

- [ ] **Step 2: 跑定向确认红灯**

```bash
node_modules/.bin/tsc -p tsconfig.json && node --test dist/tui/session.memory.test.js dist/tui/session.memory-toggle.test.js
```

预期：FAIL（/memory-on 落「Unknown command」；/memory add 仍解析成功）。

- [ ] **Step 3: 实现 session.ts**

1. 删除整个 `cmd === '/memory'` 分支（含 on/off/add/rm/gc 与「Unknown /memory subcommand」行），替换为：

```typescript
    if (cmd === '/memory') return this.memoryList();
    if (cmd === '/memory-add') return this.memoryAdd(text.slice('/memory-add'.length).trim());
    if (cmd === '/memory-rm') return this.memoryRm();
    if (cmd === '/memory-gc') return this.memoryGc();
    if (cmd === '/memory-on' || cmd === '/memory-off') {
      const on = cmd === '/memory-on';
      this.memoryOverride = on;
      setMemorySessionOverride(on); // 会话内覆盖单点：提取/注入/写闸门逐次判门读取
      this.pushMsg('system', t(`Persistent memory ${on ? 'on' : 'off'} for this session (persist with the SUNSHINEX_AUTO_MEMORY env var)`, `本会话持久记忆已${on ? '开启' : '关闭'}（持久化请设环境变量 SUNSHINEX_AUTO_MEMORY）`));
      return;
    }
```

2. 私有方法从原分支体平移（守卫次序保持原 /memory 分支先运行中守卫）：

```typescript
  private memoryList(): void { /* 原无参段平移：records 行 + memoryStateLine + capacityNotice；空索引用法提示改 /memory-add */ }
  private memoryAdd(rest: string): void { /* rest 为空 → 统一无法识别文案；scanMemoryText 闸门与 store.add 平移原样 */ }
  private async memoryGc(): Promise<void> { /* isModelSummarizer 守卫 + count()===0 守卫 + consolidateMemory force:true + 回执，平移原样 */ }
  private async memoryRm(): Promise<void> {
    if (this.state.status !== 'idle') { /* 同款运行中拒绝回执 */ return; }
    const store = new MemoryStore(this.root);
    const records = store.list();
    if (records.length === 0) {
      this.pushMsg('system', t('No memories yet — /memory-add <text> to add one', '暂无记忆——用 /memory-add <内容> 添加一条'), { level: 'warn' });
      return;
    }
    const items = records.map((r) => ({ label: r.slug, description: `${r.type} · ${r.description} (${r.created})` }));
    // 分页多选循环：导航项（More…/Back…）与勾选互斥；跨页勾选在循环外累积，Enter 提交全部
    const picked: string[] = [];
    let page = 0;
    for (;;) {
      const pageOpts = paginateOptions(items, page);
      const answer = await this.askUser({
        question: t('Select memories to delete (Space to toggle, Enter to delete)', '选择要删除的记忆（Space 勾选，Enter 批量删除）'),
        options: pageOpts.options,
        multiple: true,
      });
      if (answer.type === 'dismissed') {
        this.pushMsg('system', t('No memories removed', '未删除任何记忆'));
        return;
      }
      const labels = answer.type === 'selected' ? answer.labels : [];
      if (labels.includes('More…')) { page++; continue; }
      if (labels.includes('Back…')) { page--; continue; }
      picked.push(...labels);
      break;
    }
    if (picked.length === 0) {
      this.pushMsg('system', t('No memories removed', '未删除任何记忆'));
      return;
    }
    let ok = 0;
    let fail = 0;
    for (const slug of picked) {
      const r = store.remove(slug);
      if (r.ok) ok++;
      else fail++;
    }
    const notice = store.capacityNotice();
    this.pushMsg('system', [t(`Removed ${ok} memor${ok === 1 ? 'y' : 'ies'}${fail ? ` (${fail} failed)` : ''}`, `已删除 ${ok} 条${fail ? `（失败 ${fail} 条）` : ''}`), ...(notice ? [notice] : [])].join('\n'));
  }
```

3. 文件顶部新增导出纯函数：

```typescript
/** 选择卡分页（规格 D6）：>8 项时卡尾追加 More…（下一页）/Back…（上一页）导航项，page 0 起 */
export function paginateOptions(
  items: Array<{ label: string; description?: string }>,
  page = 0,
  pageSize = 8,
): { options: Array<{ label: string; description?: string }>; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const options = [...items.slice(page * pageSize, (page + 1) * pageSize)];
  if (page + 1 < totalPages) options.push({ label: 'More…', description: t('next page', '下一页') });
  if (page > 0) options.push({ label: 'Back…', description: t('previous page', '上一页') });
  return { options, page, totalPages };
}
```

- [ ] **Step 4: 跑定向转绿**

```bash
node --test dist/tui/session.memory.test.js dist/tui/session.memory-toggle.test.js dist/tui/session.test.js
```

- [ ] **Step 5: 提交**

```bash
git add src/tui/session.ts src/tui/session.memory.test.ts src/tui/session.memory-toggle.test.ts
git commit -m "feat(tui): /memory 族扁平化六命令，/memory-rm 多选卡批删"
```

---

### Task 4: /resume 分页化 + 未知命令统一文案收口

**Files:**
- Modify: `src/tui/session.ts`（/resume 分支删参数解析与「8 of N」提示、改分页循环；尾部 Unknown command 分支文案统一）
- Test: `src/tui/session.selector.test.ts`（/resume 用例扩展）、`src/tui/session.test.ts`（未知命令文案钉子）

**Interfaces:**
- Consumes: Task 3 的 `paginateOptions`；`listSessions(dataDir)`、`resolveDataDir`、`restoreFromSession`（既有）
- Produces: 全命令面唯一未知命令文案 `Unrecognized command. Use /help to see available commands`（warn 级）

- [ ] **Step 1: 写失败测试**

session.selector.test.ts 扩展（夹具沿本文件既有 /resume 用例的 journal 桩先例）：

```typescript
test('会话控制器：/resume 带参形态无法识别', async () => {
  const { ctrl, msgs } = makeCtrl();
  await ctrl.submit('/resume 1');
  assert.ok(msgs.some((m) => m.text.includes('Unrecognized command')));
  await ctrl.submit('/resume some-id');
  assert.ok(msgs.some((m) => m.text.includes('Unrecognized command')));
});

test('会话控制器：/resume 分页——9 条会话时卡尾 More… 翻页', async () => {
  // 预置 9 个 journal 档（沿本文件 listSessions 桩/临时目录先例）
  const p = ctrl.submit('/resume');
  await waitFor(() => ctrl.state.status === 'awaiting-question');
  assert.equal(ctrl.state.question?.options.length, 9); // 8 条 + More…
  ctrl.resolveAskAnswer({ type: 'selected', labels: ['More…'] });
  await waitFor(() => ctrl.state.status === 'awaiting-question');
  assert.equal(ctrl.state.question?.options.length, 2); // 第 2 页 1 条 + Back…
  ctrl.resolveAskAnswer({ type: 'dismissed' });
  await p;
});
```

session.test.ts 追加：

```typescript
test('会话控制器：命令词不在清单统一无法识别文案（warn 级）', async () => {
  const { ctrl, msgs } = makeCtrl();
  await ctrl.submit('/bogus');
  const hit = msgs.find((m) => m.text.includes('Unrecognized command'));
  assert.ok(hit);
  assert.equal(hit.level, 'warn');
});
```

- [ ] **Step 2: 跑定向确认红灯**

```bash
node --test dist/tui/session.selector.test.js dist/tui/session.test.js
```

预期：FAIL（/resume 1 走旧序号解析；/bogus 为旧「Unknown command: ... (/help for list)」文案）。

- [ ] **Step 3: 实现 session.ts**

1. /resume 分支：删除 `const arg = text.trim().split(/\s+/).slice(1).join(' ')` 与其后的序号/id 解析段（num/pick 与两处「No such session」中参数路径）、删除「8 of N sessions shown」提示行；无参选择器改为分页循环：

```typescript
      // 选择卡分页（规格 D2/D6）：带参形态已由裸形式守卫统一无法识别；此处只认无参翻页选择
      let page = 0;
      for (;;) {
        const shown = paginateOptions(
          sessions.map((s) => ({ label: s.id, description: s.firstUser ? s.firstUser.slice(0, 60) : t('(no user input)', '（无用户输入）') })),
          page,
        );
        const answer = await this.askUser({ question: t('Resume which session?', '恢复哪个会话？'), options: shown.options });
        if (answer.type === 'dismissed') {
          this.pushMsg('system', t('Resume cancelled', '已取消恢复'));
          return;
        }
        const label = answer.type === 'custom' ? answer.text.trim() : (answer.labels[0] ?? '');
        if (label === 'More…') { page++; continue; }
        if (label === 'Back…') { page--; continue; }
        const pick = sessions.find((s) => s.id === label);
        if (!pick) {
          this.pushMsg('system', t('No such session: ' + label, '没有这个会话：' + label), { level: 'warn' });
          return;
        }
        this.restoreFromSession(pick);
        return;
      }
```

2. handleSlash 尾部分支统一：

```typescript
    this.pushMsg('system', t('Unrecognized command. Use /help to see available commands', '无法识别命令，使用 /help 查看使用方法'), { level: 'warn' });
```

（全仓 `Unknown command` 旧文案清零；FREE_TEXT_ARGS 终核为 `['/compact', '/plan', '/goal', '/memory-add']`——四条自由文本命令带参放行，其余一切带参输入落统一文案。）

- [ ] **Step 4: 跑定向转绿**

```bash
node --test dist/tui/session.selector.test.js dist/tui/session.test.js dist/tui/session.journal.test.js
```

- [ ] **Step 5: 提交**

```bash
git add src/tui/session.ts src/tui/session.selector.test.ts src/tui/session.test.ts
git commit -m "feat(tui): /resume 分页化与全命令面统一无法识别文案"
```

---

### Task 5: 命令清单同步——SLASH_COMMANDS、slashHelp、journal 面核查

**Files:**
- Modify: `src/tui/components/App.tsx:27`（SLASH_COMMANDS 12 条 → 18 条）
- Modify: `src/tui/session.ts:143-157`（slashHelp() 12 行 → 18 行）
- Test: `src/tui/session.test.ts`（/help 断言）、`src/tui/components/App.test.tsx`（Tab 补全断言，按既有用例形态追加）

**Interfaces:**
- Consumes: Task 2–4 已落地的 18 条命令分支
- Produces: 全命令面唯一清单事实（18 条，与规格 §4 终表一致）

- [ ] **Step 1: 写失败测试**

session.test.ts /help 用例更新（按既有 /help 断言形态）：

```typescript
test('会话控制器：/help 列出 18 条命令', async () => {
  const { ctrl, msgs } = makeCtrl();
  await ctrl.submit('/help');
  const text = msgs[msgs.length - 1].text;
  for (const c of ['/model-effort', '/memory-add', '/memory-rm', '/memory-gc', '/memory-on', '/memory-off']) {
    assert.ok(text.includes(c), `missing ${c}`);
  }
  assert.ok(!text.includes('/model effort')); // 旧子命令语法零残留
});
```

App.test.tsx 追加（沿既有补全用例形态）：

```typescript
test('Tab 补全清单含全部 18 条扁平命令', () => {
  assert.deepEqual([...SLASH_COMMANDS].sort(), [
    '/compact', '/fork', '/goal', '/help', '/init', '/memory', '/memory-add', '/memory-gc',
    '/memory-off', '/memory-on', '/memory-rm', '/model', '/model-effort', '/new', '/plan',
    '/resume', '/rewind', '/status',
  ]);
});
```

- [ ] **Step 2: 跑定向确认红灯**

```bash
node_modules/.bin/tsc -p tsconfig.json && node --test dist/tui/session.test.js && node --test dist/tui/components/App.test.js
```

- [ ] **Step 3: 实现**

App.tsx L27：

```typescript
export const SLASH_COMMANDS = ['/help', '/init', '/goal', '/new', '/resume', '/rewind', '/fork', '/compact', '/plan', '/model', '/model-effort', '/memory', '/memory-add', '/memory-rm', '/memory-gc', '/memory-on', '/memory-off', '/status'];
```

session.ts slashHelp() 重写（18 行，每行独立 t() 直包再 join，沿既有先例；en/zh 对称）：

```typescript
function slashHelp(): string[] {
  return [
    t('Commands:', '命令：'),
    t('  /init          analyze & write SUNSHINE.md', '  /init          分析生成/完善 SUNSHINE.md'),
    t('  /goal          run the verify-fix loop: /goal <goal>', '  /goal          运行完整验收修正环：/goal <目标>'),
    t('  /plan          plan first, execute on approval: /plan <goal>', '  /plan          先规划后执行：/plan <目标>'),
    t('  /new           new session (soft reset)', '  /new           新会话（软重置）'),
    t('  /resume        resume a saved session (picker)', '  /resume        恢复已保存会话（选择卡）'),
    t('  /rewind        rewind current session to an earlier turn', '  /rewind        回退当前会话到更早的任务轮'),
    t('  /fork          fork a parallel session from any past turn', '  /fork          从任意历史轮分叉出平行会话'),
    t('  /compact       compress context: /compact [focus]', '  /compact       压缩上下文：/compact [关注点]'),
    t('  /model         switch model tier (selector)', '  /model         切换模型档位（选择卡）'),
    t('  /model-effort  switch reasoning effort (selector)', '  /model-effort  切换思考强度（选择卡）'),
    t('  /memory        list persistent memories', '  /memory        列出持久记忆'),
    t('  /memory-add    add a memory: /memory-add <text>', '  /memory-add    添加记忆：/memory-add <内容>'),
    t('  /memory-rm     delete memories (multi-select)', '  /memory-rm     删除记忆（多选卡）'),
    t('  /memory-gc     consolidate memories now', '  /memory-gc     立即整理记忆'),
    t('  /memory-on     enable memory for this session', '  /memory-on     本会话开启持久记忆'),
    t('  /memory-off    disable memory for this session', '  /memory-off    本会话关闭持久记忆'),
    t('  /status        session & ledger summary', '  /status        会话与账本摘要'),
    t('  /help          show this list', '  /help          本清单'),
  ];
}
```

journal 面核查（只读）：`grep -n "startSlash\|slash" src/tui/session-journal.ts`——斜杠命令即时建档按输入文本承载，新命令名自动入档，确认零改动即收。

- [ ] **Step 4: 跑定向转绿**

```bash
node --test dist/tui/session.test.js dist/tui/components/App.test.js
```

- [ ] **Step 5: 提交**

```bash
git add src/tui/components/App.tsx src/tui/session.ts src/tui/session.test.ts src/tui/components/App.test.tsx
git commit -m "feat(tui): Tab 补全与 /help 同步 18 条扁平命令清单"
```

---

### Task 6: 文档拆分——TUI-MANUAL.md → MANUAL.md 与 README.md 职责重排

**Files:**
- Rename: `git mv TUI-MANUAL.md MANUAL.md`（保历史），随后扩写
- Modify: `MANUAL.md`（§一 扩 CLI 命令总表与启动参数；§四 命令总表按 18 条扁平命令重写；5.4/5.5 与七节交互口径随新命令面校准）
- Modify: `README.md`（职责重排：架构/亮点/扩展机制保留，安装段压为三来源门面，使用细节外链 MANUAL.md，补文档导航段）
- Modify: `CLAUDE.md` §3 目录树 TUI-MANUAL 行（grep 全仓 TUI-MANUAL 引用逐处改 MANUAL.md）

**Interfaces:**
- Consumes: 规格 §4（18 条命令）、§6（CLI 命令总表）、§7（文档拆分）；Task 1–5 落地形态
- Produces: MANUAL.md=唯一使用手册；README.md=架构与工程手册；全仓 TUI-MANUAL 引用零残留

- [ ] **Step 1: 改名与引用面同步（先让 grep 收口，再扩写内容）**

```bash
git mv TUI-MANUAL.md MANUAL.md
grep -rn "TUI-MANUAL" --include="*.md" --include="*.json" --include="*.ts" . | grep -v node_modules | grep -v dist | grep -v docs/superpowers
```

（docs/superpowers/ 历史规格按存档规则不回改；其余命中逐处改指 MANUAL.md——含 README.md、CLAUDE.md、docs/ 任意活文档。）

- [ ] **Step 2: MANUAL.md 扩写**

1. §一「安装与启动」启动参数表之前插入 CLI 命令总表（照抄规格 §6.1 全量形态，含 run/pipeline 与全局 flags 行）。
2. §四「基本用法」命令总表重写为 18 条扁平命令（每条一句话 + 「见 5.x」索引形态沿既有）：/model 行改「选择卡：三档即选即切」、/model-effort、/memory 六命令分行、/resume 行去「<序号|id>」手填口径改「选择卡（More… 翻页）」。
3. 5.4 会话回退与分叉小节尾补一句：分页卡尾 More…/Back… 翻页。5.5 Worktree 隔离启动旗标行 `sunshinex <目录> --worktree` 改为与 CLI 判界一致的路径形态写法。
4. 第七节「中断与运行控制」表格补一行：`不识别的命令` | 「无法识别命令，使用 /help 查看使用方法」（warn 级回执，命令只认 /help 所列形态）。
5. 第三节目录树：TUI-MANUAL 相关行零（无）；`sessions-active.json` 等不动。

- [ ] **Step 3: README.md 职责重排**

按规格 §7 分工：保留架构图/设计亮点/扩展机制；「快速开始」压缩为三来源安装 + `sunshinex` 一句跑起来 + 「完整使用手册见 MANUAL.md」指针；启动参数细节、settings 使用视角、/命令用法等使用细节迁移或外链 MANUAL.md（已在 MANUAL 承载的直接删除，README 留指针）；补「开发」段（pnpm build/test/selfcheck、目录结构指 CLAUDE.md §3）与「文档导航」段（MANUAL.md / docs/GOAL.md / docs/ROADMAP.md / docs/PLATFORM.md / docs/TECH-DEBT.md）。README 顶部与 MANUAL.md 首节互设指针。

- [ ] **Step 4: 复核**

```bash
grep -rn "TUI-MANUAL" --include="*.md" --include="*.json" . | grep -v node_modules | grep -v dist | grep -v docs/superpowers   # 零命中
grep -n "memory add\|model effort" MANUAL.md README.md | grep -v "memory-add\|model-effort"   # 旧语法零残留（允许空输出）
wc -l MANUAL.md README.md
```

纯文档改动免构建门禁（沿 tui_manual_restructure 先例）；工作区若仍有他线 WIP 文档改动，git add 逐文件点名、零卷入。

- [ ] **Step 5: 提交**

```bash
git add MANUAL.md README.md CLAUDE.md   # 及引用面其余命中文件（逐个点名）
git commit -m "docs: MANUAL.md 使用手册与 README.md 架构工程手册职责拆分，引用面同步"
```

---

### Task 7: 终验——三门禁 + 规格验收矩阵对账

**Files:**
- 无新改动（验证收口）；如对账发现缺口，回到对应任务补齐后重新终验

**Interfaces:**
- Consumes: Task 1–6 全部产出
- Produces: 规格 §10 验收矩阵 9 条逐项对账结论

- [ ] **Step 1: 三门禁**

```bash
node_modules/.bin/tsc -p tsconfig.json && echo TSC_OK
node scripts/run-tests.js
node dist/cli/index.js selfcheck
```

- [ ] **Step 2: 验收矩阵对账（规格 §10 九条逐条核）**

1. /model 弹卡三档即选即切，Esc 零变化 —— session.test.ts 用例
2. /model-effort 八项，default 清覆盖 —— 同上
3. /memory-rm 多选批删/空守卫/Esc 零删 —— session.memory.test.ts
4. 分页 >8：/resume 与 /memory-rm 共用 paginateOptions —— session.selector.test.ts
5. 带参枚举形态统一「无法识别」 —— session.test.ts（/model large、/resume 1、/memory off）
6. /help 与 Tab 补全 18 条 —— session.test.ts + App.test.tsx
7. CLI 三态启动/裸词报错/help 用法 —— cli.test.ts + `node dist/cli/index.js foo; echo $?`（预期非零）
8. 文档拆分与引用零残留 —— Task 6 Step 4 grep
9. 三门禁全绿 —— 本任务 Step 1

- [ ] **Step 3: 收口提交（如有勘误）**

```bash
git status --short   # 应仅剩他线 WIP
git log --oneline -10
```

（对账全绿则无收口提交；有勘误按对应任务文件点名提交。）

