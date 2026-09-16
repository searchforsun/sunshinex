# /goal 对齐 Claude Code 形态 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把本项目 /goal 的评估语义对齐 Claude Code /goal——条件自由化（消灭「无验收标准空转」）、Impossible 三值裁决（不可满足即终局）、判据错误分级（不可恢复清除 / 可恢复重试后暂停）。

**Architecture:** 全部改动收敛在 loop 层单点（modelJudge/judgeOne/checkNode/engine 终局通道），CLI run 与 TUI /goal 经共用模板工厂自动受益；判据 prompt 属独立一次性调用，主链零新增拼装面；向后兼容——旧二值判据输出与规则谓词零破坏。

**Tech Stack:** TypeScript strict（CommonJS）、node --test（scripts/run-tests.js 启动器，数据目录钉 .data-test）、双语 i18n 基座 `t()`（界面）/`pick()`（模型侧）。

**规格:** `docs/superpowers/specs/2026-09-16-goal-claude-code-alignment-design.md`（D1–D6 裁决、验收矩阵 8 条）。

## Global Constraints

- TypeScript strict 零 any；用户可见文案 `t(en, zh)` 就地成对；测试断言语言中性（pick 缺省 en）。
- 判据 prompt 属独立一次性调用（不进 reactor 主链）——主链零新增拼装面，既有前缀稳定用例不得破坏。
- 向后兼容：旧二值判据输出（无 `impossible` 字段）零破坏；规则谓词保持二值、不产生 verdict。
- `CriterionResult.verdict?`、`NodeOutput.terminal?` 登记 `src/types.ts`；`LoopRunResult` 零新字段。
- 聚合优先级（checkNode）：impossible（短路，不再判余下判据）> fatal > recoverable 耗尽 > 常规 done/deficits。
- 错误分类：fatal=`/401|402|403|unauthorized|forbidden|quota|insufficient|billing|invalid api key|model not found/i`；recoverable=`/timeout|etimedout|econn|overloaded|rate limit|429|5\d\d/i`；fatal 优先匹配，均未中按 recoverable（保守暂停）。
- 重试：仅 recoverable，重试 ≤3 次（不含初次，共 ≤4 次尝试）、同步立即无退避；fatal 不重试。
- 沙箱工具链（无 pnpm）：构建 `npx tsc -p tsconfig.json`；定向 `node --test dist/loop/engine.test.js` 等；全量 `node scripts/run-tests.js`；selfcheck `node --env-file-if-exists=.env dist/cli/index.js selfcheck`。
- 每任务独立提交；Task 4 跑全量门禁（tsc 零报错 + 全量测试 + selfcheck）。

---

### Task 1: 判据协议三值化（modelJudge 解析 impossible + CriterionResult.verdict）

**Files:**
- Modify: `src/types.ts:51-56`（CriterionResult 增可选 verdict）
- Modify: `src/loop/nodes.ts:39-62`（modelJudge prompt 协议行 + 解析映射）
- Test: `src/loop/engine.test.ts`（文件尾追加 1 用例）

**Interfaces:**
- Consumes: 既有 modelJudge 签名 `modelJudge(adapter, criterion, goal, agentReply): Promise<CriterionResult>`（模块私有，签名不变）；`ScriptedAdapter`/`makeDeps`/`ctxOf`（engine.test.ts 既有脚手架）。
- Produces: `CriterionResult.verdict?: 'met' | 'not-yet' | 'impossible'`（Task 3 聚合消费）；模型协议 `{"passed":boolean,"impossible":boolean,"evidence":string}`（impossible 可选，缺省 false）。

- [ ] **Step 1: 写失败测试（src/loop/engine.test.ts 文件尾追加）**

```ts
test('T4-6 判据协议三值化：verdict 映射与向后兼容', async () => {
  // impossible：模型回 impossible=true（passed:false）→ CriterionResult.verdict='impossible'
  const depsImp = makeDeps(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t4-imp-')),
    new ScriptedAdapter(['{"passed":false,"impossible":true,"evidence":"目标依赖的模块不存在，结构性不可满足"}']),
  );
  const outImp = await checkNode(depsImp).run(ctxOf({ goal: '任务。验收标准：c1=测试全绿' }), null);
  assert.equal(outImp.status, 'fail'); // 本任务仅协议字段，聚合终局在 Task 3
  assert.equal(outImp.criteria![0].verdict, 'impossible');

  // 映射：显式 verdict 优先；缺省按 passed 推导（旧二值输出零破坏）
  const depsMap = makeDeps(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t4-verdict-')),
    new ScriptedAdapter([
      '{"passed":true,"verdict":"met","evidence":"ok"}',
      '{"passed":true,"evidence":"ok"}',
      '{"passed":false,"verdict":"not-yet","evidence":"未绿"}',
    ]),
  );
  const ctxM = ctxOf({ goal: '任务。验收标准：c1=测试全绿' });
  const out1 = await checkNode(depsMap).run(ctxM, null);
  assert.equal(out1.criteria![0].verdict, 'met');
  const out2 = await checkNode(depsMap).run(ctxOf({ goal: '任务。验收标准：c1=测试全绿' }), null);
  assert.equal(out2.criteria![0].verdict, 'met'); // 旧输出无 verdict → passed:true 推导 met
  const out3 = await checkNode(depsMap).run(ctxOf({ goal: '任务。验收标准：c1=测试全绿' }), null);
  assert.equal(out3.criteria![0].verdict, 'not-yet');

  // 规则谓词不产生 verdict（二值语义不变）
  const ctxRule = ctxOf({ goal: '任务。验收标准：c1=测试全绿' });
  const outRule = await checkNode({} as LoopDeps, { ruleCheckers: { c1: () => true } }).run(ctxRule, null);
  assert.equal(outRule.status, 'done');
  assert.equal(outRule.criteria![0].verdict, undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsc -p tsconfig.json 2>&1 | head -5; node --test dist/loop/engine.test.js 2>&1 | tail -8`
Expected: FAIL——`outImp.criteria![0].verdict` 为 `undefined`（modelJudge 尚不产出 verdict）。

- [ ] **Step 3: 最小实现**

`src/types.ts` CriterionResult（L51-56）增一字段：

```ts
export interface CriterionResult {
  id: string;
  desc: string;
  passed: boolean;
  evidence?: string;
  /** 模型判据三值裁决（规则谓词不产生；缺省按 passed 推导 met/not-yet） */
  verdict?: 'met' | 'not-yet' | 'impossible';
}
```

`src/loop/nodes.ts` modelJudge：prompt 协议行（第 4 行）替换为 pick 双语、解析增 impossible 映射：

```ts
  const prompt = [
    `你是验收判据模型。目标：${goal}`,
    `执行答复（证据）：${agentReply}`,
    `验收标准 ${criterion.id}：${criterion.desc}`,
    pick(
      'Reply with a single JSON object: {"passed":boolean,"impossible":boolean,"evidence":string}',
      '仅回复一个 JSON 对象：{"passed":boolean,"impossible":boolean,"evidence":string}',
    ),
  ].join('\n');
```

解析段（成功分支）替换为：

```ts
  try {
    const j = JSON.parse(raw) as { passed?: unknown; impossible?: unknown; evidence?: unknown };
    const impossible = j.impossible === true;
    return {
      id: criterion.id,
      desc: criterion.desc,
      passed: j.passed === true,
      ...(impossible ? { verdict: 'impossible' as const } : {}),
      evidence: typeof j.evidence === 'string' ? j.evidence : undefined,
    };
  } catch {
    // fail-bounded：判据输出不可解析 → 判不通过，不静默放行
    return { id: criterion.id, desc: criterion.desc, passed: false, evidence: '模型判据输出非 JSON' };
  }
```

（`pick` 已在 nodes.ts 导入；prompt 其余三行维持现状——不属本规格协议变更面。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsc -p tsconfig.json && node --test dist/loop/engine.test.js 2>&1 | tail -5`
Expected: PASS（既有用例 + 新增 1 例全绿；旧二值输出回归零破坏）。

- [ ] **Step 5: 提交**

```bash
git add src/types.ts src/loop/nodes.ts src/loop/engine.test.ts
git commit -m "feat(loop): 判据协议三值化——modelJudge 解析 impossible、CriterionResult.verdict 登记（向后兼容旧二值输出，规则谓词不受影响）"
```

---

### Task 2: 条件自由化（checkNode 隐式条件兜底 + usage 文案放宽）

**Files:**
- Modify: `src/loop/nodes.ts:160-168`（checkNode 判据来源兜底分支）
- Modify: `src/tui/session.ts:581-585`（/goal usage 双语）
- Modify: `src/cli/commands/run-loop.ts:11`（run usage 行）
- Test: `src/loop/engine.test.ts`（T4-1 无段断言改写）、`src/tui/session.goal.test.ts`（文件尾追加 1 用例）

**Interfaces:**
- Consumes: Task 1 的 verdict 通路；既有 `parseCriteria`、`ScriptedAdapter`/`makeDeps`/`ctxOf`。
- Produces: checkNode 判据三优先级新语义——显式清单 > 内嵌段 > `[{id:'condition', desc:<goal 原文>, passed:false}]`（隐式条件）；「无验收标准」fail 分支删除。

- [ ] **Step 1: 改写失败测试**

`src/loop/engine.test.ts` T4-1 中「CheckNode：无段 → fail 不静默」段（L201-204，`const ctx = ctxOf({ goal: '无验收段' });` 起四行断言）整体替换为：

```ts
  // CheckNode：无段 → goal 整体作为隐式条件（id=condition，走模型判据；规格 §4 替换空转 fail 路径）
  const depsCond = makeDeps(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t4-cond-')),
    new ScriptedAdapter(['{"passed":true,"evidence":"对话里已自证"}']),
  );
  const noSeg = await checkNode(depsCond).run(ctxOf({ goal: '把 src/auth 的所有测试跑到全绿' }), null);
  assert.equal(noSeg.status, 'done');
  assert.equal(noSeg.criteria!.length, 1);
  assert.equal(noSeg.criteria![0].id, 'condition');
  assert.ok((noSeg.criteria![0].desc ?? '').includes('src/auth'));
```

`src/tui/session.goal.test.ts` 文件尾追加：

```ts
test('/goal：自然语言目标（无内嵌验收标准段）跑通，不再空转失败', async () => {
  const tmp = tmpDir('sunshinex-goal8-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"测试已全绿"}', '{"passed":true,"evidence":"对话里已自证"}']),
    });
    await ctrl.submit('/goal 把 src/auth 的所有测试跑到全绿');
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().status, 'idle');
    const receipt = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.match(receipt, /\/goal done|\/goal 完成/);
    const chain = ctrl.context.chainView();
    assert.ok(chain.some((s) => s.action === 'task' && s.observation.includes('src/auth')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsc -p tsconfig.json && node --test dist/loop/engine.test.js dist/tui/session.goal.test.js 2>&1 | tail -10`
Expected: FAIL——无段 goal 走旧「无验收标准」fail 分支（engine 断言 `status==='done'` 失败；session 断言 `/goal done` 失败）。

- [ ] **Step 3: 最小实现**

`src/loop/nodes.ts` checkNode 判据来源段（`if (isCriteriaInput(...)) {...} else {...}` 的 else 分支）替换为：

```ts
      } else {
        const goal = typeof ctx.state.goal === 'string' ? ctx.state.goal : '';
        const parsed = parseCriteria(goal);
        // 条件自由化（规格 §4）：无内嵌段时 goal 整体作为单一隐式条件（走模型判据），替代「立即 fail 空转」
        criteria = parsed ?? [{ id: 'condition', desc: goal, passed: false }];
      }
```

（其后 judgeOne 循环、聚合段不动；「无验收标准（解析失败不静默通过）」分支随 else 重写一并消失。）

`src/tui/session.ts:581-585` usage 双语替换为：

```ts
        this.pushMsg('system', t(
          'Usage: /goal <goal> [--template=code-refactor|test-loop|code-review] — runs the verify-fix loop until your condition is met; state the goal as one measurable end state (e.g. /goal all tests in src/auth pass), or embed multiple criteria inline (验收标准：t1=…)',
          '用法：/goal <目标> [--template=code-refactor|test-loop|code-review]——运行验收修正环，直至目标条件满足；目标用一句可度量的终态描述（如 /goal src/auth 测试全绿），复杂目标可内嵌多判据（验收标准：t1=…）',
        ));
```

`src/cli/commands/run-loop.ts:11` 替换为：

```ts
  if (!dir) throw new Error('用法：sunshinex run <dir> --template=test-loop --goal="一句可度量的目标终态（复杂目标可内嵌：验收标准：id=描述）"');
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsc -p tsconfig.json && node --test dist/loop/engine.test.js dist/tui/session.goal.test.js 2>&1 | tail -5`
Expected: PASS（改写用例 + 新增用例 + 既有回归全绿；session 用例 3 的 usage 断言前缀 `Usage: /goal` 仍匹配）。

- [ ] **Step 5: 提交**

```bash
git add src/loop/nodes.ts src/loop/engine.test.ts src/tui/session.ts src/tui/session.goal.test.ts src/cli/commands/run-loop.ts
git commit -m "feat(loop): 条件自由化——goal 无内嵌标准时整体作隐式条件走模型判据（替换「无验收标准」空转 fail 路径）；/goal 与 run usage 文案放宽"
```

---

### Task 3: 判据错误分级 + Impossible/暂停终局（JudgeOutcome + NodeOutput.terminal + engine 通道）

**Files:**
- Modify: `src/types.ts:59-69`（NodeOutput 增可选 terminal）
- Modify: `src/loop/nodes.ts`（classifyJudgeError 导出、JudgeOutcome 内部类型、modelJudge 重构、judgeOne 透传、checkNode 聚合）
- Modify: `src/loop/engine.ts:160-165`（terminal 通道挂点）
- Test: `src/loop/engine.test.ts`（文件尾追加 2 用例）

**Interfaces:**
- Consumes: Task 1 的 verdict 通路；既有 `finish(ctx, status, extra)`（engine 私有，extra 已支持 error）。
- Produces: `classifyJudgeError(message: string): 'fatal' | 'recoverable'`（nodes.ts 导出）；`NodeOutput.terminal?: { status: 'failed' | 'paused'; error: string }`；内部 `JudgeOutcome = { kind:'judged'; result: CriterionResult } | { kind:'blocked'; severity:'fatal'|'recoverable'; message:string }` 与 `MAX_JUDGE_RETRIES = 3`（均模块私有，不外露）。

- [ ] **Step 1: 写失败测试（src/loop/engine.test.ts 文件尾追加）**

```ts
/** 计数失败适配器：前 failTimes 次调用抛指定错误，其后返回 fallback 响应 */
class FlakyJudgeAdapter implements ModelAdapter {
  readonly provider = 'flaky';
  calls = 0;
  constructor(private failTimes: number, private error: Error, private fallback: string) {}
  async complete(): Promise<string> {
    this.calls += 1;
    if (this.calls <= this.failTimes) throw this.error;
    return this.fallback;
  }
}

test('T4-7 impossible 终局：check 判定不可满足 → 引擎 failed（不烧安全网）', async () => {
  const deps = makeDeps(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t4-terminal-')),
    new ScriptedAdapter(['{"done":true,"reply":"已完成"}', '{"passed":false,"impossible":true,"evidence":"目标依赖已删除的模块"}']),
  );
  const tpl = resolveTemplate(deps, 'test-loop');
  const r = await tpl.engine.run('任务。验收标准：c1=测试全绿');
  assert.equal(r.status, 'failed');
  assert.ok((r.error ?? '').includes('不可满足'), 'error 携带不可满足理由');
  assert.ok(r.iterations < 100, 'impossible 短路，不烧迭代安全网');
});

test('T4-8 判据错误分级：fatal 立即终局、recoverable 重试 ≤3 后成功/暂停', async () => {
  // ① fatal（401）：不重试 → NodeOutput.terminal failed
  const fatal = new FlakyJudgeAdapter(99, new Error('401 Unauthorized'), '');
  const outFatal = await checkNode(makeDeps(fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t4-fatal-')), fatal))
    .run(ctxOf({ goal: '任务。验收标准：c1=测试全绿' }), null);
  assert.equal(outFatal.terminal?.status, 'failed');
  assert.ok(outFatal.terminal.error.includes('判据评估不可用'));
  assert.equal(fatal.calls, 1, 'fatal 不重试');

  // ② recoverable：前 2 次超时、第 3 次成功 → 判定生效
  const rec = new FlakyJudgeAdapter(2, new Error('ETIMEDOUT'), '{"passed":true,"evidence":"第 3 次成功"}');
  const outRec = await checkNode(makeDeps(fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t4-rec-')), rec))
    .run(ctxOf({ goal: '任务。验收标准：c1=测试全绿' }), null);
  assert.equal(outRec.status, 'done');
  assert.equal(outRec.criteria![0].verdict, 'met');
  assert.equal(rec.calls, 3, '初次 + 2 次重试');

  // ③ recoverable 耗尽：4 次全超时 → NodeOutput.terminal paused；引擎侧 failed/paused 终局不误伤
  const exhaust = new FlakyJudgeAdapter(99, new Error('ETIMEDOUT'), '');
  const outEx = await checkNode(makeDeps(fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t4-ex-')), exhaust))
    .run(ctxOf({ goal: '任务。验收标准：c1=测试全绿' }), null);
  assert.equal(outEx.terminal?.status, 'paused');
  assert.ok(outEx.terminal.error.includes('判据评估暂不可用'));
  assert.equal(exhaust.calls, 4, '初次 + 3 次重试上限');
});
```

并在 engine.test.ts 顶部 import 区（L7 `from './templates'` 现有导入行）确认含 `resolveTemplate`——v1 Task 1 已导出；若无则并入该行：

```ts
import { resolveTemplate } from './templates';
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsc -p tsconfig.json 2>&1 | head -5; node --test dist/loop/engine.test.js 2>&1 | tail -8`
Expected: FAIL——① impossible 现走 deficits 回修烧满 maxIterations（error 为「iteration 上限」文案，不含「不可满足」）；② fatal 现被吞成 passed:false（无 terminal 字段）；③ recoverable 现无重试（calls===1 即判不通过）。

- [ ] **Step 3: 最小实现**

`src/types.ts` NodeOutput（L59-69）增一字段：

```ts
  /** 节点请求引擎立即终局（check 判据 impossible / 判据不可恢复错误 → failed；可恢复重试耗尽 → paused） */
  terminal?: { status: 'failed' | 'paused'; error: string };
```

`src/loop/nodes.ts` 三处：

① judgeOne 上方新增导出纯函数与内部类型（放 modelJudge 之前）：

```ts
/** 判据错误分级：fatal（认证/配额/模型不存在 → 立即清除）与 recoverable（超时/断连/过载/限流 → 重试后暂停）；fatal 模式优先，均未中按 recoverable（保守暂停） */
export function classifyJudgeError(message: string): 'fatal' | 'recoverable' {
  if (/401|402|403|unauthorized|forbidden|quota|insufficient|billing|invalid api key|model not found/i.test(message)) return 'fatal';
  return 'recoverable';
}

/** 判据评估内部结果：judged=判定成功（含 impossible）；blocked=调用失败（分级后终止评估） */
type JudgeOutcome =
  | { kind: 'judged'; result: CriterionResult }
  | { kind: 'blocked'; severity: 'fatal' | 'recoverable'; message: string };

const MAX_JUDGE_RETRIES = 3; // 可恢复错误重试上限（不含初次；对标 CC「retry 3 times then pause」）
```

② modelJudge 签名与主体替换（prompt 协议行沿用 Task 1 形态）：

```ts
async function modelJudge(
  adapter: { complete(prompt: string): Promise<string> },
  criterion: { id: string; desc: string },
  goal: string,
  agentReply: string,
): Promise<JudgeOutcome> {
  const prompt = [
    `你是验收判据模型。目标：${goal}`,
    `执行答复（证据）：${agentReply}`,
    `验收标准 ${criterion.id}：${criterion.desc}`,
    pick(
      'Reply with a single JSON object: {"passed":boolean,"impossible":boolean,"evidence":string}',
      '仅回复一个 JSON 对象：{"passed":boolean,"impossible":boolean,"evidence":string}',
    ),
  ].join('\n');
  let raw: string | undefined;
  try {
    raw = await adapter.complete(prompt);
  } catch (e) {
    const message = e instanceof Error ? e.message : '模型判据调用失败';
    if (classifyJudgeError(message) === 'fatal') {
      return { kind: 'blocked', severity: 'fatal', message };
    }
    for (let retry = 0; retry < MAX_JUDGE_RETRIES; retry++) {
      try {
        raw = await adapter.complete(prompt);
        break;
      } catch (e2) {
        const m2 = e2 instanceof Error ? e2.message : '模型判据调用失败';
        if (classifyJudgeError(m2) === 'fatal') {
          return { kind: 'blocked', severity: 'fatal', message: m2 };
        }
      }
    }
    if (raw === undefined) {
      return { kind: 'blocked', severity: 'recoverable', message };
    }
  }
  try {
    const j = JSON.parse(raw) as { passed?: unknown; impossible?: unknown; evidence?: unknown };
    const impossible = j.impossible === true;
    return {
      kind: 'judged',
      result: {
        id: criterion.id,
        desc: criterion.desc,
        passed: j.passed === true,
        ...(impossible ? { verdict: 'impossible' as const } : {}),
        evidence: typeof j.evidence === 'string' ? j.evidence : undefined,
      },
    };
  } catch {
    // fail-bounded：判据输出不可解析 → 判不通过，不静默放行（不算调用失败）
    return { kind: 'judged', result: { id: criterion.id, desc: criterion.desc, passed: false, evidence: '模型判据输出非 JSON' } };
  }
}
```

③ judgeOne 返回类型改 `Promise<JudgeOutcome>`，规则谓词分支与模型分支改为：

```ts
  const rule = ruleCheckers[criterion.id];
  if (rule) {
    const passed = await rule({ ctx, goal });
    return { kind: 'judged', result: { id: criterion.id, desc: criterion.desc, passed } };
  }
```

（模型分支 `return modelJudge(...)` 形态不变，类型随之。）

④ checkNode 判定循环与聚合段替换为：

```ts
      const goal = typeof ctx.state.goal === 'string' ? ctx.state.goal : '';
      const outcomes: JudgeOutcome[] = [];
      for (let i = 0; i < criteria.length; i++) {
        const outcome = await judgeOne(deps, opts?.ruleCheckers ?? {}, criteria[i], ctx, goal);
        outcomes.push(outcome);
        if (outcome.kind === 'judged' && outcome.result.verdict === 'impossible') break; // 短路：不可满足即整体终局（规格 §5）
      }

      // 聚合优先级（规格 §5）：impossible 短路 > fatal > recoverable 耗尽 > 常规 done/deficits
      const judged = outcomes.filter((o): o is Extract<JudgeOutcome, { kind: 'judged' }> => o.kind === 'judged').map((o) => o.result);
      const imp = judged.find((c) => c.verdict === 'impossible');
      if (imp) {
        return {
          status: 'fail',
          criteria: judged,
          tokens: 0,
          terminal: { status: 'failed', error: `目标判定不可满足：${imp.evidence ?? imp.desc}` },
        };
      }
      const fatal = outcomes.find((o): o is Extract<JudgeOutcome, { kind: 'blocked' }> => o.kind === 'blocked' && o.severity === 'fatal');
      if (fatal) {
        return {
          status: 'fail',
          criteria: judged,
          tokens: 0,
          terminal: { status: 'failed', error: `判据评估不可用（认证/配额/模型）：${fatal.message}` },
        };
      }
      const exhaust = outcomes.find((o): o is Extract<JudgeOutcome, { kind: 'blocked' }> => o.kind === 'blocked');
      if (exhaust) {
        return {
          status: 'fail',
          criteria: judged,
          tokens: 0,
          terminal: { status: 'paused', error: `判据评估暂不可用（已重试 ${MAX_JUDGE_RETRIES} 次）：${exhaust.message}` },
        };
      }

      const failed = judged.filter((c) => !c.passed);
      if (failed.length === 0) return { status: 'done', criteria: judged, tokens: 0 };
      ctx.state.deficits = failed;
      return {
        status: 'fail',
        criteria: judged,
        reply: `未过项: ${failed.map((c) => `${c.id}=${c.desc}`).join('; ')}`,
        tokens: 0,
      };
```

`src/loop/engine.ts` 主循环 done 判定（L160-162）之后插入：

```ts
      // ①' 节点请求立即终局（check 判据 impossible / 判据不可恢复错误 → failed；可恢复重试耗尽 → paused；规格 §6）
      if (out.terminal) {
        return this.finish(ctx, out.terminal.status, { error: out.terminal.error });
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsc -p tsconfig.json && node --test dist/loop/engine.test.js dist/cli/commands/run-loop.test.js dist/tui/session.goal.test.js 2>&1 | tail -6`
Expected: PASS（新增 2 例 + 既有全部回归绿——含 T4-2 旧二值/非 JSON fail-bounded、session 既有 8 例）。

- [ ] **Step 5: 提交**

```bash
git add src/types.ts src/loop/nodes.ts src/loop/engine.ts src/loop/engine.test.ts
git commit -m "feat(loop): 判据错误分级与 impossible 终局——JudgeOutcome 判别联合、recoverable 重试 ≤3 次、NodeOutput.terminal 引擎终局通道（failed/paused）"
```

---

### Task 4: 回执提示与文档同步 + 全量门禁

**Files:**
- Modify: `src/tui/session.ts`（runGoalFlow 非 done 分支：paused 补「重跑 /goal 续走」提示行）
- Modify: `TUI-MANUAL.md`（/goal 命令行 + 说明段）
- Modify: `README.md`（三面入口段 /goal 句）
- Test: `src/tui/session.goal.test.ts`（文件尾追加 1 用例）

**Interfaces:**
- Consumes: Task 3 的 `paused` 终态与 `r.error` 透传（session runGoalFlow 已有通道）。
- Produces: 文档与实现一致；全量门禁绿。

- [ ] **Step 1: 写失败测试（src/tui/session.goal.test.ts 文件尾追加）**

```ts
test('/goal：判据服务不可用 → paused 回执提示重跑续走', async () => {
  const tmp = tmpDir('sunshinex-goal9-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: {
        provider: 'flaky-judge',
        async complete(prompt: string) {
          if (prompt.includes('验收判据模型')) throw new Error('ETIMEDOUT: judge endpoint unreachable');
          return '{"done":true,"reply":"完成"}';
        },
      } as unknown as ModelAdapter,
    });
    await ctrl.submit('/goal 做事（验收标准：t1=达成）');
    await ctrl.waitIdle();
    const receipt = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.match(receipt, /Run \/goal again|重跑 \/goal/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsc -p tsconfig.json && node --test dist/tui/session.goal.test.js 2>&1 | tail -6`
Expected: FAIL——paused 回执现无「重跑 /goal」提示句。

- [ ] **Step 3: 最小实现**

`src/tui/session.ts` runGoalFlow 非 done 分支的消息数组，在 `...lines` 之前插入条件提示行：

```ts
        this.pushMsg('system', [
          t(
            `✻ /goal incomplete: ${r.status}${r.error ? ` — ${r.error}` : ''}`,
            `✻ /goal 未完成：${r.status}${r.error ? ` — ${r.error}` : ''}`,
          ),
          ...(r.status === 'paused'
            ? [t('Run /goal again to continue (the session chain keeps the context)', '重跑 /goal 可续走（会话链保留上下文）')]
            : []),
          ...lines,
          describeIncomplete(r.stopReason),
        ].filter((l) => l.length > 0).join('\n'));
```

`TUI-MANUAL.md`：/goal 命令表行（含 `目标内嵌验收标准如` 字样）替换为：

```markdown
| `/goal <目标> [--template=code-refactor\|test-loop\|code-review]` | 运行完整验收修正环（agent→check→repair），缺省 `test-loop`；目标即条件——一句可度量的终态（对话里可自证），复杂目标可内嵌 `（验收标准：t1=…）` 多判据 |
```

其下说明段（`/goal` 直达 Loop 修正环模板…行）替换为：

```markdown
`/goal` 直达 Loop 修正环模板（对标 CLI `sunshinex run`）：目标即验收条件，判据模型逐轮评估三值裁决（满足 / 未满足 / 不可满足——判定不可满足即终止并给出理由）；判据服务不可用时自动重试 3 次后暂停，重跑 `/goal` 续走（会话链保留上下文）；修正全程走会话主链，终态回执含轮数/验收项/tokens。
```

`README.md` 三面入口段（`TUI 内 /goal …` 句）替换为：

```markdown
TUI 内 `/goal <目标> [--template=…]` 可直接触发 Loop 修正环模板（code-refactor / test-loop / code-review，对标 CLI `run`），目标支持自然语言条件。
```

- [ ] **Step 4: 跑测试确认通过 + 全量门禁**

Run: `npx tsc -p tsconfig.json && node --test dist/tui/session.goal.test.js 2>&1 | tail -4`
Expected: PASS。

Run: `node scripts/run-tests.js && node --env-file-if-exists=.env dist/cli/index.js selfcheck`
Expected: 全量测试 0 失败 0 跳过（基线 621 + 本轮新增 ~5）；selfcheck OK。

- [ ] **Step 5: 提交**

```bash
git add src/tui/session.ts src/tui/session.goal.test.ts TUI-MANUAL.md README.md
git commit -m "docs(tui): /goal 对齐文档同步——自然语言条件/impossible 终局/判据错误分级与 paused 重跑指引；回执补重跑提示句；全量门禁绿"
```

---

## 验收矩阵对照（规格 §9 → 任务映射）

| # | 规格断言 | 覆盖 |
|----|----------|------|
| 1 | 自由文本 goal → 隐式条件 done，无空转 | Task 2 |
| 2 | 内嵌多判据回归不变 | Task 1/2 既有用例回归 |
| 3 | impossible → failed + 理由，不烧安全网 | Task 3（T4-7） |
| 4 | 判据不可恢复错误 → failed + reason | Task 3（T4-8①） |
| 5 | 可恢复错误重试 ≤3 → paused | Task 3（T4-8②③） |
| 6 | 输出不可解析维持判不通过 | Task 1/3 既有 fail-bounded 用例回归 |
| 7 | 规则谓词二值不变 | Task 1（verdict===undefined 断言） |
| 8 | CLI run 自由文本同语义；全量+selfcheck 绿 | Task 2（usage 与 loop 层同源）+ Task 4 门禁 |
