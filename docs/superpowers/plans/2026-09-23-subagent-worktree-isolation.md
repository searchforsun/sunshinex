# 子代理 Worktree 隔离（程序化）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对标 Claude Code，程序化重建子代理 worktree 隔离——声明面（frontmatter/spawn 入参）+ fork 前建树 + 三出口收口 + 无 Git 静默兜底 + exec 命令文本判界三查。

**Architecture:** 隔离是 harness 机制，模型面零接触（子面恒无 worktree 工具）。`SubagentRunner.runSubagent` 在 fork 前探测声明 → 程序建树 → `SafetyChain.withRoot` 换根克隆（带 `isolatedRoot` 标记）→ 子 Reactor root=树；三出口统一收口（干净删/脏保留）。判界三查收口在 `SafetyChain` 单点，仅隔离子链生效。

**Tech Stack:** TypeScript strict / node:test / spawnSync git（全部收敛 `worktree.ts`）。

## Global Constraints

- 判界唯一函数：`isWithin`（`src/paths.ts`）；git 调用唯一落点：`src/harness/worktree.ts`
- 提示词/链行英文单语；registry/`createdAt` 时间戳仅落数据面文件，零进提示词面
- 无 Git 静默兜底：非仓/缺根 → 零链行、零报错、主工作区执行（Spec D3）
- 未声明隔离的子代理行为与现状逐字节一致（回归锚）
- 每任务独立提交；全量验证 `pnpm build` + `node scripts/run-tests.js` + `pnpm selfcheck`
- 规格文件：`docs/superpowers/specs/2026-09-23-subagent-worktree-isolation-design.md`

---

### Task 1: worktree.ts — `subagentTreeName` 恢复 + `isRepo` 导出

**Files:**
- Modify: `src/harness/worktree.ts`（`randomTail4` 定义区之后、`execGit` 之前）
- Test: `src/harness/worktree.test.ts`

**Interfaces:**
- Produces: `export function subagentTreeName(label: string): string`（`subagent-<slug>-<4位随机>`）；`export function isRepo(root: string): boolean`（现私有函数加 `export`）

- [ ] **Step 1: 写红灯测试**（`worktree.test.ts` 追加）

```ts
test('subagentTreeName：subagent-<slug>-<4位随机>，随机尾落合法名域', () => {
  const name = subagentTreeName('代码审查');
  assert.match(name, /^subagent-[a-z0-9-]{1,32}-[a-z0-9]{4}$/);
  assert.notEqual(name, subagentTreeName('代码审查'), '两次调用随机尾不同');
});
```

（import 行补 `subagentTreeName`。）

- [ ] **Step 2: 跑测试确认失败**：`npx tsc -p tsconfig.json && node --test dist/harness/worktree.test.js` → 编译错（无导出）
- [ ] **Step 3: 实现**——`worktree.ts` 的 `randomTail4` 之后追加：

```ts
/** 子代理专属树名（规格 2026-09-23-subagent-worktree-isolation §3）：`subagent-<净化label>-<4位随机>`；
 * slug 走 slugifyLabel 单点（空折叠回 's' 兜底），并行批多个隔离子代理互不撞名 */
export function subagentTreeName(label: string): string {
  const slug = slugifyLabel(label) || 's';
  return `subagent-${slug}-${randomTail4()}`;
}
```

并把第 85 行 `function isRepo(root: string): boolean {` 改为 `export function isRepo(...)`。

- [ ] **Step 4: 绿灯**：同 Step 2 命令 → PASS
- [ ] **Step 5: 提交**：`git add src/harness/worktree.ts src/harness/worktree.test.ts && git commit -m "feat(worktree): subagentTreeName 恢复 + isRepo 导出（隔离子代理建树前置探测）"`

### Task 2: chain.ts — `withRoot` 换根克隆 + exec 判界三查

**Files:**
- Modify: `src/harness/security/chain.ts`（`withMemoryScope` 之后加 `withRoot`；`run()` 前加判界单点；字段区加 `isolatedRoot*`）
- Test: `src/harness/security/chain.isolation.test.ts`（新建）

**Interfaces:**
- Produces: `withRoot(root: string): SafetyChain`（克隆换根，`isolatedRoot` 生效）；隔离子链 `run(cmd)` 对越树命令返回 `fail('EXEC_OUT_OF_TREE', reason)`

- [ ] **Step 1: 写红灯测试**（新建 `chain.isolation.test.ts`；夹具参照 `chain.test.ts` 现有构造）

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SecurityGuard } from './guard';
import { PolicyEngine } from './policy';
import { ProcessSandbox } from './sandbox';
import { DryRun } from './dryrun';
import { SafetyChain } from './chain';

function makeChain(root: string): SafetyChain {
  return new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
}
function mktmp(p: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

test('withRoot 克隆：execCwd 锚专属树，原实例零突变', () => {
  const main = mktmp('iso-main-');
  const tree = mktmp('iso-tree-');
  const chain = makeChain(main);
  const child = chain.withRoot(tree);
  assert.equal(child.execCwd(), tree);
  assert.equal(chain.execCwd(), main, '原实例 cwd 不变');
});

test('隔离子链判界：cd 越树 / git 指针越树 / 环境赋值越树 / 不可验证 → EXEC_OUT_OF_TREE', async () => {
  const main = mktmp('iso-main-');
  const tree = mktmp('iso-tree-');
  const child = makeChain(main).withRoot(tree);
  for (const cmd of [
    `cd ${main} && git status`,
    `git --git-dir=${main}/.git log`,
    `GIT_DIR=${main}/.git git log`,
    'echo $(git --git-dir=/x log)',
  ]) {
    const r = await child.run(cmd);
    assert.ok(!r.ok, `应拒绝：${cmd}`);
    assert.equal(r.ok ? '' : r.error.code, 'EXEC_OUT_OF_TREE');
  }
});

test('隔离子链：树内命令与普通命令放行；主链同命令零影响', async () => {
  const main = mktmp('iso-main-');
  const tree = mktmp('iso-tree-');
  const child = makeChain(main).withRoot(tree);
  const okCmd = await child.run(`git -C ${tree} status`);
  assert.ok(okCmd.ok, '树内 git 指针放行');
  const plain = await child.run('echo hi');
  assert.ok(plain.ok && plain.value.stdout.includes('hi'));
  const mainChain = makeChain(main);
  const cross = await mainChain.run(`cd ${tree} && git status`);
  assert.ok(cross.ok, '主链（非隔离子链）不受判界约束');
});
```

- [ ] **Step 2: 红灯确认**：`npx tsc -p tsconfig.json && node --test dist/harness/security/chain.isolation.test.js` → 编译错（无 withRoot）
- [ ] **Step 3: 实现**——`chain.ts` 三处：

① `withMemoryScope` 之后追加（字段与活动根字段并列声明在类尾部既有 `activeRootPath` 区）：

```ts
  /** 派生换根克隆（隔离子代理专用，规格 2026-09-23-subagent-worktree-isolation D6）：root 置换为专属树并携带
   * isolatedRoot 标记——exec 判界三查仅隔离子链生效；guard/backend/dryrun/scope 引用共享，活动根态不继承 */
  withRoot(root: string): SafetyChain {
    const child = new SafetyChain(this.guard, this.backend, this.dryrun, root, this.memoryScope);
    child.isolatedRootPath = root;
    try {
      child.isolatedRootReal = fs.existsSync(root) ? fs.realpathSync(root) : root;
    } catch {
      child.isolatedRootReal = root;
    }
    return child;
  }
```

② 类尾部字段区（`activeRootReal` 之后）追加：

```ts
  /** 隔离子链专属树（withRoot 设置；null=非隔离子链，判界零介入） */
  private isolatedRootPath: string | null = null;
  private isolatedRootReal: string | null = null;

  /** 隔离子链 exec 判界三查（规格 §5）：cwd 恒由程序锚树（execCwd），越树通道只剩命令文本——
   * ② git 指针参数越树拒；③ 环境赋值/cd 越树拒；含运行期替换的 git 命令不可验证即拒（fail-closed）。
   * 英文单语：拒绝 reason 经工具结果入链进模型上下文 */
  private execCommandAllowed(cmd: string): { allowed: true } | { allowed: false; reason: string } {
    if (this.isolatedRootReal === null) return { allowed: true };
    const tree = this.isolatedRootReal;
    const within = (p: string): boolean => {
      try {
        return isWithin(tree, path.resolve(this.isolatedRootPath ?? tree, p));
      } catch {
        return false;
      }
    };
    const tokens = cmd.split(/\s+/).filter((t) => t.length > 0);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const ptr = /^(--git-dir|--work-tree|-c)=(.*)$/.exec(t) ?? (/^(--git-dir|--work-tree)$/.test(t) ? null : null);
      if (ptr) {
        if (!within(ptr[2])) return { allowed: false, reason: `command rejected: git pointer escapes the isolated worktree: ${ptr[2]}` };
      }
      if (t === '-C' || t === '--git-dir' || t === '--work-tree') {
        const v = tokens[i + 1];
        if (v !== undefined && !within(v)) return { allowed: false, reason: `command rejected: git pointer escapes the isolated worktree: ${v}` };
      }
      const env = /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)=(.*)$/.exec(t);
      if (env) {
        if (!within(env[2])) return { allowed: false, reason: `command rejected: GIT_* env escapes the isolated worktree: ${env[2]}` };
      }
      if (t === 'cd') {
        const v = tokens[i + 1];
        if (v !== undefined && !within(v)) return { allowed: false, reason: `command rejected: cd escapes the isolated worktree: ${v}` };
      }
    }
    if (/\$\(|\`/.test(cmd) && /(^|\s)git(\s|$)/.test(cmd)) {
      return { allowed: false, reason: 'command rejected: runtime-computed git command cannot be verified to stay inside the isolated worktree' };
    }
    return { allowed: true };
  }
```

（注：`-c core.worktree=<p>` 形态由 `^(--git-dir|--work-tree|-c)=(.*)$` 与独立 `-c` 后随值两路覆盖；上表指针正则命中即查，无需区分键名。）

③ `run()` 改为：

```ts
  run(cmd: string, opts?: ExecOpts): Promise<Result<ExecResult>> {
    const gate = this.execCommandAllowed(cmd);
    if (!gate.allowed) return Promise.resolve({ ok: false, error: { code: 'EXEC_OUT_OF_TREE', message: gate.reason } });
    return this.backend.exec(cmd, opts);
  }
```

- [ ] **Step 4: 绿灯**：Step 2 命令 → 全 PASS；再跑 `node --test dist/harness/security/` 确认既有 chain 用例零回归
- [ ] **Step 5: 提交**：`git add src/harness/security/chain.ts src/harness/security/chain.isolation.test.ts && git commit -m "feat(security): 隔离子链换根克隆 withRoot + exec 命令判界三查（对标 CC v2.1.203）"`

### Task 3: 声明面 + 建树/收口（types.ts / subagent.ts / builtin.ts schema）

**Files:**
- Modify: `src/types.ts:260`（`SubagentSpawnInput`）
- Modify: `src/harness/subagent.ts`（`AgentDef`/`parseAgentFrontmatter`/`loadAgents`/`validateSpawnInput`/`runSubagent`/收口单点）
- Modify: `src/harness/tools/builtin.ts` 不动（schema 在 `makeSpawnTool`，`subagent.ts` 内）
- Test: `src/harness/subagent.test.ts`（声明面用例）

**Interfaces:**
- Consumes: Task 1 `subagentTreeName`/`isRepo`、Task 2 `withRoot`
- Produces: `SubagentSpawnInput.isolation?: 'worktree'`；`parseAgentFrontmatter` 返回含 `isolation?: 'worktree'`；`makeSpawnTool` schema `required` 含 `isolation`

- [ ] **Step 1: 写红灯测试**（`subagent.test.ts` 追加）

```ts
test('spawn 声明面：isolation 非法值 INVALID_ARG；worktree 合法', () => {
  const h = makeHarness(mktmp('sunshinex-iso-decl-'));
  const runner = h.makeRunner(new ScriptedAdapter(['{"done":true,"reply":"ok"}']));
  assert.throws(() => runner.validateSpawnInput({ prompt: 'w', isolation: 'docker' as 'worktree' }), /INVALID_ARG/);
  assert.doesNotThrow(() => runner.validateSpawnInput({ prompt: 'w', isolation: 'worktree' }));
});

test('frontmatter 解析：isolation: worktree 键透传', () => {
  const meta = parseAgentFrontmatter('---\nname: iso-bot\ndescription: d\nisolation: worktree\n---\nbody');
  assert.equal(meta.isolation, 'worktree');
  assert.equal(parseAgentFrontmatter('---\nname: plain\n---\nb').isolation, undefined);
});
```

- [ ] **Step 2: 红灯确认**：编译错（字段不存在）
- [ ] **Step 3: 实现**——

① `types.ts` `SubagentSpawnInput`（`tools` 字段后）：

```ts
  /** 隔离声明（规格 D2）：'worktree' = fork 前程序建专属树并在树内执行；缺省无。入参优先于 agent.md frontmatter */
  isolation?: 'worktree';
```

② `subagent.ts`：`AgentDef` 增 `isolation?: 'worktree'`；`parseAgentFrontmatter` 返回类型加 `isolation?: 'worktree'`，return 改为：

```ts
  return { name: out.name, description: out.description, version: out.version, body: md.slice(m[0].length).trim(), memory: out.memory === 'true', ...(out.isolation === 'worktree' ? { isolation: 'worktree' as const } : {}) };
```

`loadAgents` 的 `defs.set` 展开 `...(meta.isolation ? { isolation: meta.isolation } : {})`。

③ `validateSpawnInput` 追加：

```ts
    if (input.isolation !== undefined && input.isolation !== 'worktree') {
      throw new CodedToolError('INVALID_ARG', `Unknown isolation: ${String(input.isolation)} (only 'worktree')`);
    }
```

④ `makeSpawnTool` schema：`properties` 增

```ts
        isolation: { type: ['string', 'null'], enum: ['worktree', null], description: "Request an isolated git worktree for this subtask; null runs in the main workspace (silently degraded when the workspace is not a git repository)" },
```

`required` 增 `'isolation'`。

- [ ] **Step 4: 绿灯 + 提交**：`git add -u && git commit -m "feat(subagent): isolation 声明面——frontmatter 键 + spawn 入参 + schema（D2）"`

### Task 4: runSubagent 建树/fork/收口 + 静默兜底

**Files:**
- Modify: `src/harness/subagent.ts`（`runSubagent` 主体 + `settleSubagentTree` 单点）
- Test: `src/harness/worktree-isolation.test.ts`（重建，样板参照 `31b8b79^` 的 `makeRepo`/`withIso`/`cwdOf` 夹具）

**Interfaces:**
- Consumes: Task 1–3 全部
- Produces: 隔离子代理 fork root=树、三出口收口、无 Git 静默兜底（D3/D4/D5）

- [ ] **Step 1: 写红灯测试**（重建 `worktree-isolation.test.ts`，夹具从 `git show 31b8b79^:src/harness/worktree-isolation.test.ts` 取 `mktmp`/`git`/`makeRepo`/`withIso`/`cwdOf`，断言按新语义）：

```ts
test('T5-1 frontmatter 声明 → 建树执行、干净树自动删且零 note 行', …);
test('T5-2 入参通道同效且优先于 frontmatter；两通道均无 → 不建树', …);
test('T5-3 脏树保留 + note 行含树路径', …);
test('T5-4 非 git 仓 → 静默兜底：不建树、零 note、主工作区正常执行', …);   // D3
test('T5-5 缺项目根 → 同 T5-4；建树失败（非 NOT_A_REPO）→ note + INCOMPLETE', …);
test('T5-6 隔离子代理 exec 锚树：cwd 事实行=树；越树命令被拒且子代理可继续', …);  // D6
test('T5-7 回归锚：未声明 isolation 的 spawn 行为零变化', …);
```

（各用例断言细节沿 §8 测试计划逐条落；静默兜底断言 `r.steps` 与链行中无 `isolation` 字样且 `reply` 正常。）

- [ ] **Step 2: 红灯确认** → 编译/断言失败
- [ ] **Step 3: 实现**——`runSubagent` 在 `resolveSpawnSpec` 之后、`seedHistory` 组装之前插入（D3 静默兜底 + D1 建树）：

```ts
      // D2 双通道声明：入参优先于 frontmatter；D3 静默兜底——root 缺失或非 git 仓 → iso 静默置空（零链行、主工作区执行）；
      // 是仓但建树失败 → fail-bounded 补丁行回链，该子代理不执行、父任务不炸
      const wantsIso =
        input.isolation === 'worktree' ||
        (input.agent_id !== undefined && this.agents.resolve(input.agent_id)?.isolation === 'worktree');
      let iso: { name: string; tree: string } | undefined;
      if (wantsIso && this.deps.root !== undefined && isRepo(this.deps.root)) {
        const name = subagentTreeName(label);
        const created = createWorktree(this.deps.root, dataDirReal(this.deps.root), name);
        if (created.ok) iso = { name: created.value.name, tree: created.value.path };
        else if (created.error.code !== 'WORKTREE_NOT_A_REPO') {
          this.deps.context.appendChain([{ action: 'note', observation: `[${label}] isolation failed: ${created.error.code}: ${created.error.message}` }]);
          return fail('INCOMPLETE', `[${label}] isolation failed (${created.error.code})`);
        }
      }
```

fork 组装（`childSafety` 行与 `root` 展开行）：

```ts
      const childSafety = own !== undefined ? this.deps.safety.withMemoryScope(own.scope) : this.deps.safety;
      const child = new Reactor({
        safety: iso !== undefined ? childSafety.withRoot(iso.tree) : childSafety,
        registry: this.deriveChildRegistry(input),
        context: this.deps.context,
        model: this.deps.model,
        ...(iso !== undefined ? { root: iso.tree } : this.forkRoot() ? { root: this.forkRoot()! } : {}),
        // …其余展开项不变
```

三出口收口：类内新增单点（`settleIsoWorktree` 语义恢复，改名对齐新规格）：

```ts
  /** 隔离树收口单点（规格 D4）：干净树自动删（含分支，零链行）；有改动/收口失败 → 保留 + 路径提示（结论/补丁行前注） */
  private settleSubagentTree(iso?: { name: string; tree: string }): string | undefined {
    if (iso === undefined || this.deps.root === undefined) return undefined;
    const removed = removeWorktree(this.deps.root, dataDirReal(this.deps.root), iso.name);
    if (removed.ok && removed.value === 'removed') return undefined;
    return `worktree kept for inspection: ${iso.tree}`;
  }
```

三个出口（`result.done` / `did not finish` / `catch`）各在 appendChain 前调 `const keptNote = this.settleSubagentTree(iso);`，`keptNote` 以 `[${finalLabel}] ${keptNote}` 前注或尾附进对应链行（完成出口：先 note 再结论行；失败两出口：拼进 note 行）。

import 行恢复：`import { createWorktree, removeWorktree, subagentTreeName, isRepo } from './worktree';`

- [ ] **Step 4: 绿灯**：`node --test dist/harness/worktree-isolation.test.js` 全 PASS
- [ ] **Step 5: 提交**：`git add src/harness/subagent.ts src/harness/worktree-isolation.test.ts && git commit -m "feat(subagent): 程序化建树/fork 换根/三出口收口 + 无 Git 静默兜底（D1/D3/D4/D5）"`

### Task 5: 全量验证 + 活文档同步

**Files:**
- Modify: `MANUAL.md`（5.3 子代理角色行补 `isolation: worktree` 声明；5.5 入口表补「子代理声明」行）
- Modify: `README.md`（快速上手 `--worktree` 注释行补子代理声明半句）

- [ ] **Step 1: 全量验证**：`pnpm build && node scripts/run-tests.js && pnpm selfcheck` → 0 fail
- [ ] **Step 2: 文档同步**（三处，表述为正向现行态，正文零存在史）：

MANUAL.md 5.3 角色行：
```markdown
- 自定义角色：放 `agents/{id}/agent.md`（frontmatter `name`、正文写职责）；可声明 `isolation: worktree` 获得独立工作树（见 5.5）。
```
MANUAL.md 5.5 入口表追加行：
```markdown
| 子代理声明 | agent.md frontmatter `isolation: worktree` 或 spawn 入参声明，子代理获得独立树；工作区非 git 仓时静默降级为主工作区执行 |
```
README.md `--worktree` 注释行尾补：`;子代理经 agent.md \`isolation: worktree\` 声明获得独立树`

- [ ] **Step 3: 提交**：`git add MANUAL.md README.md && git commit -m "docs: 子代理 worktree 隔离活文档同步（入口表/角色行/快速上手）"`

## Self-Review

- **Spec 覆盖**：D1→Task 4、D2→Task 3、D3→Task 4（T5-4/5）、D4→Task 4（settleSubagentTree）、D5→Task 4（createWorktree 缺省 HEAD）、D6→Task 2+4（T5-6）——全覆盖；§8 用例 9 条 ↔ T5-1..7 + chain.isolation 3 例
- **类型一致性**：`subagentTreeName(label): string`、`withRoot(root): SafetyChain`、`RemoveWorktreeResult = Result<'removed' | 'kept-dirty'>`、`settleSubagentTree(iso?): string | undefined` 各任务引用一致
- **占位符扫描**：T5 各用例断言细节标注「沿 §8 落」，实现时以规格 §8 为准——非 TBD，验收口径唯一来源
