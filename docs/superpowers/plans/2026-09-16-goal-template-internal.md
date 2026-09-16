# /goal 模板语义从用户面隐藏 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `--template` 从全部用户可见面（TUI `/goal`、CLI `run`、帮助/手册）整体摘除——`/goal` 后一切即目标文本、恒走标准验收修正环；模板注册表原样保留为内部扩展点。

**Architecture:** 纯用户面摘除、零装配能力变化：session.ts 分支简化与四处文案收敛、CLI run-loop.ts flag 摘除、两份文档同步；`loop/templates.ts`（resolveTemplate/FACTORIES/TEMPLATE_NAMES）与 `runtime.runLoop` 可选 `template` 接缝（含其测试）零改动（规格 D5）。

**Tech Stack:** TypeScript strict（CommonJS）、node --test、双语 i18n `t()`（界面文案就地成对）。

**规格:** `docs/superpowers/specs/2026-09-16-goal-template-internal-design.md`（D1–D6 裁决、验收矩阵 7 条）。

## Global Constraints

- TypeScript strict 零 any；用户可见文案 `t(en, zh)` 就地成对；测试断言语言中性（t 缺省 en）。
- 模板内部面零改动（D5）：`src/loop/templates.ts`、`src/loop/templates.test.ts`、`src/tui/runtime.ts` runLoop 接缝、`src/tui/runtime.test.ts:273/286` 接缝用例全部不动。
- 链行/启动行/done 回执的模板名全部摘除；`/goal` 身份标注保留（D2）。
- 沙箱工具链（无 pnpm）：构建 `npx tsc -p tsconfig.json`；定向 `node --test dist/<path>`；全量 `node scripts/run-tests.js`；selfcheck `node --env-file-if-exists=.env dist/cli/index.js selfcheck`。
- 提交闸门：定向套件 `# fail 0` 硬断言通过后才 `git commit`（禁止以 grep 命中作闸门——goal 对齐线 Task 1 事故教训）。
- 每任务独立提交；Task 3 跑全量门禁。

---

### Task 1: session /goal 摘除模板面（分支简化 + runGoalFlow 签名 + 三处文案 + SLASH_HELP）

**Files:**
- Modify: `src/tui/session.ts`（/goal 分支 L580-598、runGoalFlow L410-431、SLASH_HELP L113-117、import L12）
- Test: `src/tui/session.goal.test.ts`（用例 1 改写、用例 4/5 删除、新增 D1 钉子用例）

**Interfaces:**
- Consumes: 既有 `this.runtime.runLoop(goal, opts?)`——`template` 可选、缺省 `DEFAULT_GOAL_TEMPLATE`（已核实 runtime.ts:78-81），session 侧不再传 template。
- Produces: `runGoalFlow(goal: string)` 单参签名；链行 `Current instruction: ${goal} (/goal)`（zh：`当前指令：${goal}（/goal）`）；done 回执 `✻ /goal done: N iteration(s) · M tokens`（zh：`✻ /goal 完成：N 轮 · M tokens`）。Task 2/3 不消费 session 内部签名，此块供回归参照。

- [ ] **Step 1: 改写失败测试（src/tui/session.goal.test.ts 四处，单脚本原子完成）**

1a 用例 1 标题（L13）：

```ts
// old
test('/goal：修正环跑通——任务行入链带模板标注，终态回执四要素齐备', async () => {
// new
test('/goal：修正环跑通——任务行入链带 /goal 标注（无模板名），终态回执四要素齐备', async () => {
```

1b 用例 1 断言（assert.ok 块整体替换）：

```ts
// old
    assert.ok(
      chain.some((s) => s.action === 'task' && s.observation.includes('/goal · test-loop')),
      '任务行入链且带 /goal·模板 标注（缺省 test-loop）',
    );
// new
    assert.ok(
      chain.some((s) => s.action === 'task' && (s.observation.includes('(/goal)') || s.observation.includes('（/goal）'))),
      '任务行入链且带 /goal 标注（en (/goal) / zh（/goal））',
    );
    assert.ok(
      !chain.some((s) => s.action === 'task' && s.observation.includes('test-loop')),
      '链行零模板名（模板为内部装配机制，用户面零暴露）',
    );
```

1c 删除用例 4（整块含其后空行）与用例 5（整块含其后空行）——两块的精确原文：

```ts
test('/goal：未知模板报错列可选值，不入链', async () => {
  const tmp = tmpDir('sunshinex-goal4-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    await ctrl.submit('/goal 做事 --template=nope');
    const last = ctrl.getState().messages.at(-1)?.text ?? '';
    assert.match(last, /Unknown template: nope|未知模板：nope/);
    assert.match(last, /code-refactor/);
    assert.equal(ctrl.context.chainView().length, 0);
    assert.equal(ctrl.getState().status, 'idle');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

```

```ts
test('/goal：--template 显式覆盖 code-review（agent→gate→check 判据通过）', async () => {
  const tmp = tmpDir('sunshinex-goal5-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"审查结论：输出正确"}', '{"passed":true,"evidence":"已确认"}']),
    });
    await ctrl.submit('/goal --template=code-review 审查输出（验收标准：t1=有结论）');
    await ctrl.waitIdle();
    const chain = ctrl.context.chainView();
    assert.ok(
      chain.some((s) => s.action === 'task' && s.observation.includes('/goal · code-review')),
      '模板标注取显式覆盖值',
    );
    const receipt = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.match(receipt, /\/goal done|\/goal 完成/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

```

1d 文件尾追加 D1 钉子用例（锚点=goal9 尾块，追加其后）：

```ts
test('/goal：--template 字样不解析，整体作为目标文本（D1 钉子：剥离等于行为上承认该语法仍存在）', async () => {
  const tmp = tmpDir('sunshinex-goal10-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"已完成"}', '{"passed":true,"evidence":"已达成"}']),
    });
    await ctrl.submit('/goal --template=code-review 审查输出（验收标准：t1=有结论）');
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().status, 'idle');
    const chain = ctrl.context.chainView();
    assert.ok(
      chain.some((s) => s.action === 'task' && s.observation.includes('--template=code-review')),
      '输入整体作为目标文本入链，不做静默剥离',
    );
    const receipt = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.match(receipt, /\/goal done|\/goal 完成/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsc -p tsconfig.json && node --test dist/tui/session.goal.test.js 2>&1 | tail -6`
Expected: FAIL——用例 1 两断言红（现状链行 `/goal · test-loop` 不含 `(/goal)` 且含 test-loop）、goal10 红（`--template=code-review` 被剥离不入链）。

- [ ] **Step 3: 最小实现（src/tui/session.ts 六处，单脚本原子替换）**

3a /goal 分支（`const rest` 行起至 `await this.runGoalFlow(goal, template);` 止，if-idle 守卫与尾部 return 不动）：

```ts
// old
      const rest = text.slice(cmd.length).trim();
      const tm = rest.match(/--template=(\S+)/);
      const template = tm?.[1] ?? DEFAULT_GOAL_TEMPLATE;
      const goal = rest.replace(/--template=\S+\s*/g, '').trim();
      if (!goal) {
        this.pushMsg('system', t(
          'Usage: /goal <goal> [--template=code-refactor|test-loop|code-review] — runs the verify-fix loop until your condition is met; state the goal as one measurable end state (e.g. /goal all tests in src/auth pass), or embed multiple criteria inline (验收标准：t1=…)',
          '用法：/goal <目标> [--template=code-refactor|test-loop|code-review]——运行验收修正环，直至目标条件满足；目标用一句可度量的终态描述（如 /goal src/auth 测试全绿），复杂目标可内嵌多判据（验收标准：t1=…）',
        ));
        return;
      }
      if (!TEMPLATE_NAMES.includes(template)) {
        this.pushMsg('system', t(
          `Unknown template: ${template} (available: ${TEMPLATE_NAMES.join('/')})`,
          `未知模板：${template}（可选 ${TEMPLATE_NAMES.join('/')}）`,
        ));
        return;
      }
      await this.runGoalFlow(goal, template);
// new
      // 模板为内部装配机制（规格 2026-09-16-goal-template D1/D5）：/goal 后一切即目标文本，恒走缺省标准环
      const goal = text.slice(cmd.length).trim();
      if (!goal) {
        this.pushMsg('system', t(
          'Usage: /goal <goal> — runs the verify-fix loop until your condition is met; state the goal as one measurable end state (e.g. /goal all tests in src/auth pass), or embed multiple criteria inline (验收标准：t1=…)',
          '用法：/goal <目标>——运行验收修正环，直至目标条件满足；目标用一句可度量的终态描述（如 /goal src/auth 测试全绿），复杂目标可内嵌多判据（验收标准：t1=…）',
        ));
        return;
      }
      await this.runGoalFlow(goal);
```

3b runGoalFlow 文档注释与签名：

```ts
// old
  /** /goal 完整修正环（规格 2026-09-15-tui-goal D2/D3）：模板名已经 handleSlash 预校验（入链前拒绝）；
   *  任务行入链带 /goal·模板 标注 → runLoop → 终态回执（status/iterations/criteria/tokens）→ closeTask。
   *  异常路径同 runTaskFlow 切 error 粘滞（保留现场）；已入链任务行不回滚（append-only，失败以链上轨迹为准） */
  private async runGoalFlow(goal: string, template: string): Promise<void> {
// new
  /** /goal 完整修正环（规格 2026-09-15-tui-goal D2/D3 + 2026-09-16-goal-template D2/D5）：模板为内部装配机制，用户面零暴露；
   *  任务行入链带 /goal 标注 → runLoop（缺省标准环）→ 终态回执（status/iterations/criteria/tokens）→ closeTask。
   *  异常路径同 runTaskFlow 切 error 粘滞（保留现场）；已入链任务行不回滚（append-only，失败以链上轨迹为准） */
  private async runGoalFlow(goal: string): Promise<void> {
```

3c 链行：

```ts
// old
        { action: 'task', observation: t(`Current instruction: ${goal} (/goal · ${template})`, `当前指令：${goal}（/goal · ${template}）`) },
// new
        { action: 'task', observation: t(`Current instruction: ${goal} (/goal)`, `当前指令：${goal}（/goal）`) },
```

3d 启动行：

```ts
// old
      this.pushMsg('system', t(`✻ /goal: ${template} · ${goal}`, `✻ /goal：${template} · ${goal}`));
// new
      this.pushMsg('system', t(`✻ /goal: ${goal}`, `✻ /goal：${goal}`));
```

3e runLoop 调用与 done 回执：

```ts
// old
      const r = await this.runtime.runLoop(goal, { template, ...(this.state.model ? { tier: this.state.model } : {}) });
// new
      const r = await this.runtime.runLoop(goal, this.state.model ? { tier: this.state.model } : {});
```

```ts
// old
            `✻ /goal done: ${template} · ${r.iterations} iteration(s) · ${r.tokensUsed} tokens`,
            `✻ /goal 完成：${template} · ${r.iterations} 轮 · ${r.tokensUsed} tokens`,
// new
            `✻ /goal done: ${r.iterations} iteration(s) · ${r.tokensUsed} tokens`,
            `✻ /goal 完成：${r.iterations} 轮 · ${r.tokensUsed} tokens`,
```

3f SLASH_HELP 双语（`--template=code-refactor|test-loop|code-review]` 段与「run full verify-fix loop」措辞同步）：

```ts
// old（en）
    'Commands: /init analyze & write SUNSHINE.md · /goal run full verify-fix loop: /goal <goal> [--template=code-refactor|test-loop|code-review] · /new new session (soft reset) · /compact compress context · /status session & ledger summary · /model model tier (small|medium|large) · /help show this list',
// new（en）
    'Commands: /init analyze & write SUNSHINE.md · /goal run the verify-fix loop until the condition is met: /goal <goal> · /new new session (soft reset) · /compact compress context · /status session & ledger summary · /model model tier (small|medium|large) · /help show this list',
// old（zh）
    '命令：/init 分析生成/完善 SUNSHINE.md · /goal 运行完整验收修正环：/goal <目标> [--template=code-refactor|test-loop|code-review] · /new 新会话（软重置） · /compact 压缩上下文 · /status 会话与账本摘要 · /model 模型档位（small|medium|large） · /help 本清单',
// new（zh）
    '命令：/init 分析生成/完善 SUNSHINE.md · /goal 运行完整验收修正环：/goal <目标> · /new 新会话（软重置） · /compact 压缩上下文 · /status 会话与账本摘要 · /model 模型档位（small|medium|large） · /help 本清单',
```

3g import 清理（无残渣——两符号消费点已全部摘除）：

```ts
// old
import { DEFAULT_GOAL_TEMPLATE, TEMPLATE_NAMES } from '../loop/templates';
import * as fs from 'fs';
// new
import * as fs from 'fs';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsc -p tsconfig.json && node --test dist/tui/session.goal.test.js 2>&1 | tail -4`
Expected: PASS 8/8（9 − 删 2 + 增 1）。

- [ ] **Step 5: 提交（# fail 0 硬闸门）**

```bash
OUT=$(node --test dist/tui/session.goal.test.js 2>&1 | grep -E '^# fail'); echo "$OUT"; echo "$OUT" | grep -q '^# fail 0$' && git add src/tui/session.ts src/tui/session.goal.test.ts && git commit -m "feat(tui): /goal 模板语义摘除——一切即目标文本、恒走标准环，链行/回执/帮助去模板名（注册表保留为内部扩展点，规格 D1-D3/D6）"
```

---

### Task 2: CLI run 摘除 --template（usage/flag 解析/[run] 输出）

**Files:**
- Modify: `src/cli/commands/run-loop.ts`（usage 行、flag 解析、resolveTemplate 调用、[run] 输出）
- Modify: `src/cli/index.ts:61/70`（USAGE 双语两行）
- Test: `src/cli/commands/run-loop.test.ts`（追加 1 用例 + import 扩展）

**Interfaces:**
- Consumes: `DEFAULT_GOAL_TEMPLATE`（loop/templates.ts 导出，内部缺省标准环）、既有 `resolveTemplate` 再导出（run-loop.test.ts 导入点不动）。
- Produces: `runLoop(args: CliArgs)` 行为不变、仅模板取值收敛为缺省；CLI 用户面（usage 提示、[run] 输出）零模板字样。Task 3 文档引用该口径。

- [ ] **Step 1: 写失败测试（src/cli/commands/run-loop.test.ts）**

1a import 扩展：

```ts
// old
import { resolveTemplate } from './run-loop';
// new
import { resolveTemplate, runLoop } from './run-loop';
```

1b 文件尾追加用例（锚点=buildModel 用例尾部，追加其后）：

```ts
test('run-loop：用法提示不再含 --template（模板为内部装配机制，用户面零暴露）', async () => {
  await assert.rejects(
    () => runLoop({ command: 'run', positional: [], flags: {} }),
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      assert.match(msg, /sunshinex run <dir>/);
      assert.ok(!msg.includes('--template'), '用法提示不得暴露模板参数');
      return true;
    },
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsc -p tsconfig.json && node --test dist/cli/commands/run-loop.test.js 2>&1 | tail -5`
Expected: FAIL——现状 usage 行含 `--template=test-loop`，`!msg.includes('--template')` 断言红。

- [ ] **Step 3: 最小实现**

3a run-loop.ts 四处：

```ts
// old（import 行）
import { resolveTemplate } from '../../loop/templates';
// new
import { DEFAULT_GOAL_TEMPLATE, resolveTemplate } from '../../loop/templates';
```

```ts
// old（usage 行）
  if (!dir) throw new Error('用法：sunshinex run <dir> --template=test-loop --goal="一句可度量的目标终态（复杂目标可内嵌：验收标准：id=描述）"');
// new
  if (!dir) throw new Error('用法：sunshinex run <dir> --goal="一句可度量的目标终态（复杂目标可内嵌：验收标准：id=描述）"');
```

```ts
// old（flag 解析 + resolveTemplate + [run] 输出，三行连续区）
  const template = String(args.flags.template ?? 'test-loop');
  const deps = buildDeps(root, args.flags);
  const tpl = resolveTemplate(deps, template);
  console.log(`[run] root=${root} template=${template}`);
// new（模板为内部装配机制（规格 D4）：CLI 用户面恒走标准环，--template 不再是用户参数）
  const deps = buildDeps(root, args.flags);
  const tpl = resolveTemplate(deps, DEFAULT_GOAL_TEMPLATE);
  console.log(`[run] root=${root}`);
```

3b cli/index.ts USAGE 双语两行（保持既有对齐列）：

```ts
// old（en）
  sunshinex run <dir> [--template=...]    run a Loop refinement template on the dir (goal via prompt or --goal)
// new（en）
  sunshinex run <dir> --goal="..."        run the standard verify-fix loop on the dir (goal via --goal)
```

```ts
// old（zh）
  sunshinex run <dir> [--template=...]    在目录上运行 Loop 模板修正环（goal 走交互或 --goal）
// new（zh）
  sunshinex run <dir> --goal="..."        在目录上运行标准验收修正环（goal 走交互或 --goal）
```

（对齐说明：old 描述列起点 = `[--template=...]`（16 字符）+ 4 空格；new `--goal="..."`（12 字符）+ 8 空格，同列对齐。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsc -p tsconfig.json && node --test dist/cli/commands/run-loop.test.js 2>&1 | tail -4`
Expected: PASS 7/7（6 + 1）。

- [ ] **Step 5: 提交（# fail 0 硬闸门）**

```bash
OUT=$(node --test dist/cli/commands/run-loop.test.js 2>&1 | grep -E '^# fail'); echo "$OUT"; echo "$OUT" | grep -q '^# fail 0$' && git add src/cli/commands/run-loop.ts src/cli/commands/run-loop.test.ts src/cli/index.ts && git commit -m "feat(cli): run 摘除 --template——恒走标准环，usage 与 [run] 输出零模板字样（注册表保留为内部扩展点，规格 D4/D5）"
```

---

### Task 3: 文档同步 + 全量门禁

**Files:**
- Modify: `TUI-MANUAL.md:72/79`、`README.md:61`

**Interfaces:**
- Consumes: Task 1/2 落地后的用户面口径（/goal 一切即目标、run 恒标准环）。
- Produces: 手册与实现一致；全量门禁绿。

- [ ] **Step 1: TUI-MANUAL 两处**

```markdown
// old（L72）
| `/goal <目标> [--template=code-refactor\|test-loop\|code-review]` | 运行完整验收修正环（agent→check→repair），缺省 `test-loop`；目标即条件——一句可度量的终态（对话里可自证），复杂目标可内嵌 `（验收标准：t1=…）` 多判据 |
// new
| `/goal <目标>` | 运行完整验收修正环（标准环：agent→check→repair）；目标即条件——一句可度量的终态（对话里可自证），复杂目标可内嵌 `（验收标准：t1=…）` 多判据 |
```

```markdown
// old（L79）
`/goal` 直达 Loop 修正环模板（对标 CLI `sunshinex run`）：目标即验收条件，判据模型逐轮评估三值裁决
// new
`/goal` 直达 Loop 标准验收修正环（对标 CLI `sunshinex run`）：目标即验收条件，判据模型逐轮评估三值裁决
```

- [ ] **Step 2: README 一处（L61 句尾）**

```markdown
// old
TUI 内 `/goal <目标> [--template=…]` 可直接触发 Loop 修正环模板（code-refactor / test-loop / code-review，对标 CLI `run`），目标支持自然语言条件。
// new
TUI 内 `/goal <目标>` 可直接触发 Loop 标准验收修正环（对标 CLI `run`），目标支持自然语言条件。
```

- [ ] **Step 3: 全量门禁**

Run: `npx tsc -p tsconfig.json && node scripts/run-tests.js 2>&1 | tail -4`
Expected: 全量 626/626（基线 626：session.goal −2+1、run-loop +1 净持平）、0 失败。

Run: `node --env-file-if-exists=.env dist/cli/index.js selfcheck`
Expected: OK（skills 21、loop/graph 模板就绪）。

- [ ] **Step 4: 提交**

```bash
git add TUI-MANUAL.md README.md && git commit -m "docs(tui): /goal 与 run 手册去模板口径——标准验收修正环表述，模板降为内部装配机制（规格 D2/D4）"
```

---

## 验收矩阵对照（规格 §5 → 任务映射）

| # | 规格断言 | 覆盖 |
|----|----------|------|
| 1 | 自由文本 goal 行为不变、全链无模板字样 | Task 1（用例 1 改写 + 负断言） |
| 2 | 无参新提示 / 运行中拒绝不变 | Task 1（用例 3 既有断言 `/Usage: \/goal|用法：\/goal/` 仍匹配新文案；用例 6 不动） |
| 3 | `--template=code-review 审查输出` 整串入链 | Task 1（goal10 D1 钉子） |
| 4 | 未知 `--template=nope` 不报错 | Task 1（守卫删除 + goal10 同型覆盖） |
| 5 | CLI 恒标准环、输出/手册零模板字样、旧 flag 静默忽略 | Task 2（CliArgs 宽松 Record 不识别即忽略——已核实无未知 flag 报错路径） |
| 6 | 内部注册表回归不破 | Task 3 全量门禁（templates.test.ts / runtime.test.ts:273/286 零改动随全量跑绿） |
| 7 | 全量 + selfcheck 绿、前缀稳定不破 | Task 3（链行文案属任务行内容变化，非新增拼装面） |
