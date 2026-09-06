# P1-1 压缩预算闭环实施计划（估算解耦 + 收敛环 + 记忆水位治理）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec `docs/superpowers/specs/2026-09-05-phase2-context-budget-design.md`（含修正 99996c3/eade004/3788899）：压缩预算闭环——估算与 kind 权重解耦、摘要/重读预算化、记忆分层配额治理、收敛环与滞回。

**Architecture:** 方案 A（用户批准）——收敛环挂 Reactor observe（拥有两个水位线的唯一所有者）；记忆治理用「record 入口限长 + assemble 分层配额 tail」；摘要/重读预算化在 window/ContextManager 内收口。

**Tech Stack:** TypeScript strict（CommonJS）、`node --test`、零新增 npm 依赖。

## Global Constraints

- 基线：HEAD `3788899`，全量 **101/101/0**（`npm test` 实测）。终态预期 **113/113/0**。
- tsc strict 不动；import 相对路径；`npm run build` 零报错是每任务绿灯前置。
- **重校白名单（spec S5，修正 3788899）**：数字行 + 压缩闭环用例 prompts[1] 断言随 F-b 修复翻转——两处之外**断言语义零改动**。
- **常数表（spec §2.5，唯一取值来源）**：`MEMORY_RECORD_MAX_CHARS=500`；`MEMORY_INJECT_BUDGET={skill:600, episodic:700, working:700}`；滞回 `step - lastCompactStep >= 2`；收敛环 ≤2 轮、续环条件 `est > total`（硬越限越阈即止）；摘要/重读预算各 `Math.floor(reserve/2)`；`REREAD_MAX_LINES=500` 不变。
- `src/` 属 root:root：修改已有文件用 sandbox__edit（shell 直写 EACCES）；**同一文件多处编辑分轮串行**（1B 覆盖事故教训）。
- TDD 红灯先行并亲眼确认。API 扩展任务（T1 estimateTokens、T2 summaryTokenBudget、T3 tail、T4 opts 参数）红灯形态为**编译错**（新 API 未实现）——1D 先例，合法红灯；T5 红灯为行为断言失败。
- 每任务一提交：显式 `git add <文件列表>`，禁止 `git add -A`。
- 测试观察约定：reactor 用例捕获 prompt 用「`prompts: string[]` + 自定义 model.complete 推入」模式（压缩闭环用例同款）；观察 memory 压缩记录用 `context.memory.index().filter((l) => l.startsWith('compaction: 摘要'))`（reactor 内联构建持 `context` 引用，参照 trackFile 用例的组装方式）。

## File Structure

| 文件 | 改动 |
|---|---|
| `src/harness/context/window.ts` | Modify：`estimateTokens` export、estimate 重写（去权重）、`ContextItemEstimate` 简化、`KIND_WEIGHT` export 化、compact 摘要预算化 |
| `src/harness/context/window.test.ts` | Modify：estimate 用例改写 + 新增；compact 预算化 3 用例 |
| `src/harness/context/memory-lifecycle.ts` | Modify：record 限长 + `tail(maxChars)` |
| `src/harness/context/memory-lifecycle.test.ts` | Modify：+3 用例 |
| `src/harness/context/index.ts` | Modify：`MEMORY_INJECT_BUDGET`、assemble 切 tail、applyCompaction 重读预算化 |
| `src/harness/context/assemble.test.ts` | Modify：+1 用例 |
| `src/harness/context/compaction.test.ts` | Modify：+2 用例 |
| `src/harness/reactor.ts` | Modify：observe 收敛环 + 滞回门 + 预算参数贯通 |
| `src/harness/reactor.test.ts` | Modify：压缩闭环重校（白名单）+ 复杂度信号注释 + 新增 2 用例 |
| `scripts/probe-context-budget.js` | Create（Task 6）：E2E 收敛探针（不进测试套件） |
| `docs/superpowers/specs/…phase2-context-budget-design.md` | Modify（Task 6）：状态行 + §8 实施记录 |
| 本计划 | Modify（Task 6）：checkbox 勾选 + 执行记录 |

---

### Task 1: 估算解耦——estimateTokens 真实 token 近似

**Files:** Modify `src/harness/context/window.ts`、`src/harness/context/window.test.ts`

**Interfaces:**
- Produces: `export function estimateTokens(content: string): number`（后续 T2/T3/T4 消费）；`estimate(items): { used, items: { id }[] }`（weight 字段退役，仅测试消费已核实）。
- 消费前提：`KIND_WEIGHT` 改 export（T2 丢弃序使用；顺带免 noUnusedLocals 误报）。

- [x] **Step 1: 写失败测试**（window.test.ts：import 行改 `import { ContextWindow, estimateTokens } from './window';`；将首个用例 `test('estimate 按 kind 加权估算 token', …)` **整体替换**为以下两个用例）：

```ts
test('estimate 按真实 token 近似：CJK×1 + 其余÷4', () => {
  const w = new ContextWindow();
  assert.equal(estimateTokens('abcd'), 1); // ceil(4/4)
  assert.equal(estimateTokens('你好'), 2); // CJK 逐字
  assert.equal(estimateTokens('ab你好'), 3); // 2 + ceil(2/4)
  assert.equal(estimateTokens(''), 0);
  const est = w.estimate([{ kind: 'instruction', content: 'abcd' }]);
  assert.equal(est.used, 1, '无 kind 权重：4 ASCII → 1');
  assert.equal(est.items.length, 1);
  assert.ok(est.items[0].id.length > 0);
});

test('estimate 无 kind 权重：同内容异 kind 同值', () => {
  const w = new ContextWindow();
  const a = w.estimate([{ kind: 'history', content: '同长内容' }]);
  const b = w.estimate([{ kind: 'system', content: '同长内容' }]);
  assert.equal(a.used, b.used);
});
```

- [x] **Step 2: 红灯确认**：`npm run build 2>&1 | grep -c 'error TS'` → ≥1（TS2305 estimateTokens 未导出，API 扩展红灯）。记录输出。
- [x] **Step 3: 实现 window.ts**（三处编辑分轮串行）：
  1. `ContextItemEstimate` 接口去掉 `weight` 字段，仅留 `id: string`；
  2. 在 `ChecksumVerdict` 类型之后新增：

```ts
/** 真实 token 近似：CJK（中文/全角区）×1 + 其余 ÷4（spec §2.1，零依赖近似口径） */
export function estimateTokens(content: string): number {
  const cjk = (content.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  return cjk + Math.ceil((content.length - cjk) / 4);
}
```

  3. `KIND_WEIGHT` 改 `export const` 并加注释「权重表：estimate 已退役权重语义，现供 compact 丢弃序使用（T2 起消费）」；`estimate` 方法整体替换：

```ts
  /** 估算：used = Σ estimateTokens(content)（真实 token 近似，无 kind 权重；权重语义退役为 compact 丢弃优先级） */
  estimate(items: ContextItem[]): { used: number; items: ContextItemEstimate[] } {
    const out: ContextItemEstimate[] = [];
    let used = 0;
    for (const it of items) {
      used += estimateTokens(it.content);
      out.push({ id: this.chunkId(it.content) });
    }
    return { used, items: out };
  }
```

- [x] **Step 4: 绿灯确认**：build `0` 错 + `npm test 2>&1 | grep -E '^# (tests|pass|fail)'` → **102/102/0**。
- [x] **Step 5: 提交**：`git add src/harness/context/window.ts src/harness/context/window.test.ts && git commit -m "feat(context): estimateTokens 真实 token 近似——估算与 kind 权重解耦（P1-1 T1）"`

---

### Task 2: 摘要预算化——compact summaryTokenBudget

**Files:** Modify `src/harness/context/window.ts`、`src/harness/context/window.test.ts`

**Interfaces:**
- Consumes: `estimateTokens`（T1）、`KIND_WEIGHT`（T1 export）。
- Produces: `compact(items, opts?: { force?: boolean; summaryTokenBudget?: number })`——未传 budget 行为与现版完全一致（T4/T5 与既有用例依赖此兼容）。

- [x] **Step 1: 写失败测试**（window.test.ts 末尾追加 3 用例）：

```ts
test('compact 摘要预算化：超限按丢弃序丢块，白名单 kind 保留', async () => {
  const w = new ContextWindow();
  const items: ContextItem[] = [
    { kind: 'system', content: '## 系统规则\n系统级锚点内容' },
    { kind: 'history', content: '## 旧块A\n' + 'A'.repeat(1200) },
    { kind: 'history', content: '## 旧块B\n' + 'B'.repeat(1200) },
  ];
  const chunks = await w.compact(items, { summaryTokenBudget: 400 });
  assert.equal(chunks.length, 2, '应恰好丢弃一个 history 块');
  assert.ok(chunks.some((c) => c.type === 'system'), '白名单 system 块保留');
  const joined = chunks.map((c) => c.summary).join('\n');
  assert.ok(joined.includes('旧块B'), '位置最旧的 A 先被丢弃，B 保留');
  assert.ok(!joined.includes('AAAA'), '被丢弃块不出现');
});

test('compact 摘要预算化：未传 summaryTokenBudget 行为不变', async () => {
  const w = new ContextWindow();
  const items: ContextItem[] = [
    { kind: 'history', content: '## 块一\n' + 'x'.repeat(1200) },
    { kind: 'history', content: '## 块二\n' + 'y'.repeat(1200) },
  ];
  const a = await w.compact(items);
  const b = await w.compact(items, { force: true });
  assert.deepEqual(a.map((c) => c.id), b.map((c) => c.id));
  assert.equal(a.length, 2);
});

test('compact 摘要预算化：丢尽可丢块仍超限 → 确定性均匀截断', async () => {
  const w = new ContextWindow();
  const items: ContextItem[] = [
    { kind: 'system', content: '## 系统\n' + 'S'.repeat(1200) },
    { kind: 'history', content: '## 历史\n' + 'H'.repeat(1200) },
  ];
  const chunks = await w.compact(items, { summaryTokenBudget: 100 });
  const t = chunks.reduce((s, c) => s + estimateTokens(c.summary), 0);
  assert.ok(t <= 100, `截断后 Σ token ${t} 应 ≤ 100`);
  assert.ok(chunks.some((c) => c.type === 'system'), 'system 块可截断但不丢弃');
  const again = await w.compact(items, { summaryTokenBudget: 100 });
  assert.deepEqual(chunks.map((c) => c.summary), again.map((c) => c.summary), '同输入确定性一致');
});
```

- [x] **Step 2: 红灯确认**：编译错（`summaryTokenBudget` 不在 opts 类型内，TS2353）——API 扩展红灯。记录。
- [x] **Step 3: 实现**：`compact` 方法整体替换（`_opts` 形参转正）：

```ts
  /** 摘要预算化压缩（spec §2.3）：超限时按丢弃序丢块（priority 升序 → kind 权重升序 → 位置最旧先；system/instruction 白名单不可丢），
   *  丢尽可丢块仍超限 → 确定性均匀截断（二分最大统一保留长度 L，保 checksum 确定性）。未传 summaryTokenBudget 保持既有行为。 */
  async compact(items: ContextItem[], opts?: { force?: boolean; summaryTokenBudget?: number }): Promise<ContextChunk[]> {
    const chunks = this.chunkByMarkdown(items);
    const merged = this.mergeChunks(chunks);
    const kept = merged.filter((c) => c.priority > 0);
    const budget = opts?.summaryTokenBudget;
    if (budget === undefined) return kept;
    const tokensOf = (cs: ContextChunk[]) => cs.reduce((s, c) => s + estimateTokens(c.summary), 0);
    if (tokensOf(kept) <= budget) return kept;
    const order = kept
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.type !== 'system' && c.type !== 'instruction')
      .sort(
        (a, b) =>
          a.c.priority - b.c.priority ||
          (KIND_WEIGHT[a.c.type as ContextItem['kind']] ?? 0.5) - (KIND_WEIGHT[b.c.type as ContextItem['kind']] ?? 0.5) ||
          a.i - b.i,
      );
    const dropped = new Set<ContextChunk>();
    let out = kept;
    for (const { c } of order) {
      if (tokensOf(out) <= budget) break;
      dropped.add(c);
      out = out.filter((x) => x !== c);
    }
    if (tokensOf(out) > budget) {
      const maxLen = Math.max(...out.map((c) => c.summary.length));
      let lo = 0;
      let hi = maxLen;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const t = out.reduce((s, c) => s + estimateTokens(c.summary.slice(0, mid)), 0);
        if (t <= budget) lo = mid;
        else hi = mid - 1;
      }
      out = out.map((c) => ({ ...c, summary: c.summary.slice(0, lo) }));
    }
    return out;
  }
```

- [x] **Step 4: 绿灯确认**：**105/105/0**。验算锚点：用例 1 各块 token ≈ system 12 / A 304 / B 304，总 620 > 400 → 按 A、B 顺序丢 A 后 316 ≤ 400，恰剩 2 块。
- [x] **Step 5: 提交**：`git add src/harness/context/window.ts src/harness/context/window.test.ts && git commit -m "feat(context): compact 摘要预算化——丢弃序与确定性截断（P1-1 T2）"`

---

### Task 3: 记忆治理——record 限长与分层配额注入

**Files:** Modify `src/harness/context/memory-lifecycle.ts`、`src/harness/context/index.ts`、`src/harness/context/memory-lifecycle.test.ts`、`src/harness/context/assemble.test.ts`

**Interfaces:**
- Produces: `MemoryLifecycle.tail(maxChars: { skill: number; episodic: number; working: number }): string[]`；`ContextManager.assemble` 记忆条目切换为 tail 视图。`index()` 全量语义不变（既有断言与 endTask/promote 依赖）。
- 内部字段/持久化调用名以现状为准：record 仅改 push 行的 text 截断；tail 为新增方法（层内取尾、层间按 skill→episodic→working 拼接）。

- [x] **Step 1: 写失败测试**（memory-lifecycle.test.ts 末尾追加 3 用例；组装模式照抄本文件既有用例的 MemoryLifecycle/FileStore 构造）：

```ts
test('record 入口限长：超 500 字符截断', () => {
  const m = new MemoryLifecycle(new FileStore(tmpdir()));
  m.record('project', 'X'.repeat(800));
  assert.deepEqual(m.index(), [`project: ${'X'.repeat(500)}`]);
});

test('tail 分层配额：层内取尾、层间按价值梯度拼接（skill→episodic→working）', () => {
  const m = new MemoryLifecycle(new FileStore(tmpdir()));
  m.record('compaction', '沉淀事实');
  m.promote('沉淀事实');                            // → skill 层
  m.record('compaction', 'E1');
  m.record('compaction', 'E2');                    // episodic 尾部 E2
  m.record('project', 'W1');
  m.record('project', 'W2');
  m.record('project', 'W3');                       // working 尾部 W3
  const t = m.tail({ skill: 600, episodic: 700, working: 700 });
  assert.deepEqual(t, [
    'compaction: 沉淀事实',
    'compaction: E1',
    'compaction: E2',
    'project: W1',
    'project: W2',
    'project: W3',
  ]);
  assert.equal(m.index().length, 6, 'index() 全量语义不受影响');
});

test('tail 配额为软上限：整条纳入，最新一条永不因配额丢弃', () => {
  const m = new MemoryLifecycle(new FileStore(tmpdir()));
  for (let i = 1; i <= 5; i++) m.record('project', `W${i}: ${'x'.repeat(300)}`);
  const t = m.tail({ skill: 0, episodic: 0, working: 700 });
  assert.equal(t.length, 3, '每条 313 字符：取尾 2 条后 618 < 700，第 3 条纳入后越限即停（软上限）');
  assert.ok(t[0].startsWith('project: W3:'));
  assert.ok(t[2].startsWith('project: W5:'));
});
```

（assemble.test.ts 末尾追加 1 用例，组装照抄本文件既有 setup 助手：）

```ts
test('assemble 记忆注入走分层配额 tail：超量旧记忆由压缩摘要代表而非全量叠加', () => {
  const { cm } = setup();
  for (let i = 1; i <= 30; i++) cm.memory.record('project', `W${i}: ${'x'.repeat(80)}`);
  const items = cm.assemble('完成任务');
  const mem = items.find((i) => i.kind === 'memory');
  assert.ok(mem, '应有记忆条目');
  assert.ok(mem.content.includes('W30'), '最新记忆保留');
  assert.ok(!mem.content.includes('W1:'), '配额外最旧记忆不再注入');
  assert.ok(!mem.content.includes('W15:'), '配额窗口外记忆不再注入');
});
```

- [x] **Step 2: 红灯确认**：`tail` 不存在 → 编译错；record 限长断言失败（行为）。两类红灯混合，记录输出。
- [x] **Step 3: 实现**：
  1. memory-lifecycle.ts 常数区（CAP 旁）新增 `const MEMORY_RECORD_MAX_CHARS = 500; // spec §2.5：record 入口单条限长`；record 的 push 行改为 `items.push(\`${type}: ${text.slice(0, MEMORY_RECORD_MAX_CHARS)}\`);`
  2. `index()` 之后新增：

```ts
  /** 分层配额注入视图（spec §2.5）：各层内取尾（最新优先，软上限——整条纳入，最新一条永不因配额丢弃），层间按价值梯度拼接 skill→episodic→working */
  tail(maxChars: { skill: number; episodic: number; working: number }): string[] {
    const take = (t: MemoryTier): string[] => {
      const items = this.tier(t);
      const out: string[] = [];
      let used = 0;
      for (let i = items.length - 1; i >= 0 && used < maxChars[t]; i--) {
        out.unshift(items[i]);
        used += items[i].length;
      }
      return out;
    };
    return [...take('skill'), ...take('episodic'), ...take('working')];
  }
```

（`this.tier(t)` 若与现状内部访问器不同名，按实际字段改写，逻辑不变。）
  3. context/index.ts：`REREAD_MAX_LINES` 旁新增 `const MEMORY_INJECT_BUDGET = { skill: 600, episodic: 700, working: 700 }; // spec §2.5 常数表：分层配额注入（合计 2000 字符）`；assemble 中 `const mem = this.memory.index();` 替换为 `const mem = this.memory.tail(MEMORY_INJECT_BUDGET);`
- [x] **Step 4: 绿灯确认**：**109/109/0**。验算锚点：30 条 94 字符记录、working 配额 700 → 注入 8 条（658 < 700，第 8 条纳入后 752 越限即停），W22 及更早不出现。
- [x] **Step 5: 提交**：`git add src/harness/context/memory-lifecycle.ts src/harness/context/memory-lifecycle.test.ts src/harness/context/index.ts src/harness/context/assemble.test.ts && git commit -m "feat(context): 记忆治理——record 限长与分层配额注入（P1-1 T3）"`

---

### Task 4: 重读预算化——LRU 整文件丢弃

**Files:** Modify `src/harness/context/index.ts`、`src/harness/context/compaction.test.ts`

**Interfaces:**
- Consumes: `estimateTokens`（T1）。
- Produces: `applyCompaction(chunks, opts?: { rereadTokenBudget?: number })`——预算**仅管辖重读条目**（摘要归 summaryTokenBudget）；未传时行为与现版完全一致（T5 与既有用例依赖）。

- [x] **Step 1: 写失败测试**（compaction.test.ts 末尾追加 2 用例，setup 照抄本文件既有助手）：

```ts
test('重读预算化：超限按 LRU 最旧先丢整文件', async () => {
  const { root, cm } = setup();
  fs.writeFileSync(path.join(root, 'old.md'), 'O'.repeat(2000)); // 重读 ≈ 506 tok
  fs.writeFileSync(path.join(root, 'new.md'), 'N'.repeat(200));  // ≈ 56 tok
  cm.trackFile('old.md');
  cm.trackFile('new.md');
  const chunks = await cm.window.compact([{ kind: 'history', content: '旧上下文要点'.repeat(10) }]);
  await cm.applyCompaction(chunks, { rereadTokenBudget: 200 });
  const items = cm.assemble('完成任务');
  const texts = items.map((i) => i.content);
  assert.ok(!texts.some((t) => t.startsWith('[重读] old.md')), '最旧文件整条被丢');
  assert.ok(texts.some((t) => t.startsWith('[重读] new.md')), '预算内新文件保留');
});

test('重读预算化：预算内全部保留（与未传参数行为一致）', async () => {
  const { root, cm } = setup();
  fs.writeFileSync(path.join(root, 'a.md'), 'a'.repeat(100));
  cm.trackFile('a.md');
  const chunks = await cm.window.compact([{ kind: 'history', content: '旧上下文要点'.repeat(10) }]);
  await cm.applyCompaction(chunks, { rereadTokenBudget: 100000 });
  const items = cm.assemble('完成任务');
  assert.ok(items.map((i) => i.content).some((t) => t.startsWith('[重读] a.md')));
});
```

- [x] **Step 2: 红灯确认**：编译错（opts 参数未扩展）。记录。
- [x] **Step 3: 实现**：import 行补 `estimateTokens`（自 `./window`）；applyCompaction 签名加 `opts?: { rereadTokenBudget?: number }`；在 `this.compacted = items;` 之前插入：

```ts
    // 重读预算化（spec §2.4）：预算仅管辖重读条目；登记顺序即最旧在前，队首（最旧）整文件先丢
    const budget = opts?.rereadTokenBudget;
    if (budget !== undefined) {
      const tokens = (cs: ContextItem[]) => cs.reduce((s, i) => s + estimateTokens(i.content), 0);
      const rereads = items.slice(1);
      while (rereads.length > 0 && tokens(rereads) > budget) rereads.shift();
      items.length = 1;
      items.push(...rereads);
    }
```

  并将末尾 record 行的 `重读 ${items.length - 1} 个文件` 改为引用过滤后条数（若 items 已被裁剪，`items.length - 1` 即正确值，无需额外变量）。
- [x] **Step 4: 绿灯确认**：**111/111/0**。既有用例（未传 opts）行为不变。
- [x] **Step 5: 提交**：`git add src/harness/context/index.ts src/harness/context/compaction.test.ts && git commit -m "feat(context): 重读预算化——LRU 整文件丢弃（P1-1 T4）"`

---

### Task 5: 收敛环与滞回——压缩当轮生效

**Files:** Modify `src/harness/reactor.ts`、`src/harness/reactor.test.ts`

**Interfaces:**
- Consumes: T1-T4 全部产出。
- Produces: observe 块重构——滞回门（`step - lastCompactStep >= 2`，`lastCompactStep` 初始 `-2`）+ `est > total` 应急旁路 + 收敛环（do-while，≤2 轮，续环条件 `est > total` 硬越限越阈即止）；prompt 以**收敛后** items 组装（F-b 修复：压缩当轮生效）。
- **白名单改写点（spec S5 修正案 3788899）**：压缩闭环用例 budget 数字行 `{ total: 300, reserve: 40 }` → `{ total: 4500, reserve: 4100 }`；`!prompts[1].includes('[压缩摘要')` → `prompts[1].includes(...)` 翻转；相邻注释行同步。**白名单外其余用例断言零改动**（复杂度信号仅注释内文案更新）。

- [x] **Step 1: 写失败测试**（reactor.test.ts）：
  1. **压缩闭环用例改写**：①budget 行换 `{ total: 4500, reserve: 4100 }`（threshold 400 触发 step2；rereadTokenBudget 2050 容纳 big.txt 重读 ≈756 tok）；②`prompts[1]` 断言翻转：`assert.ok(prompts[1].includes('[压缩摘要'), '收敛环：触发轮当轮即以收敛后上下文组装（F-b 修复）');`；③相邻注释行（原「第 2 轮 prompt 在本轮压缩前组装」句）改为「收敛环使压缩当轮生效；水位线滤除压缩点前原始 history 行（语义不变）」；其余断言（prompts[0] 无摘要、prompts[2] 含摘要/含重读/不含 `\n1: read -> `/含 `2: exec -> step2`）**原样保留**。
  2. **复杂度信号用例**：断言不变；消息文案改 `est.used≈530（goal 主导且不可压缩）/total=300 → ratio≥0.6 → large`。
  3. **新增 2 用例**（追加至文件末尾；组装方式参照 trackFile 用例的内联构建——持 `context` 引用以观察压缩记录）：

```ts
test('收敛环有界且滞回生效：压缩当轮生效、下一新步被门控、records 收敛于 1', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor8-'));
  fs.writeFileSync(path.join(tmp, 'f.txt'), 'f'.repeat(700));
  const prompts: string[] = [];
  const replies = [
    '{"tool":"read","input":{"path":"f.txt"},"done":false}',
    '{"tool":"exec","input":{"command":"echo mid"},"done":false}',
    '{"done":true}',
  ];
  let call = 0;
  const model = { provider: 'capture', complete: async (p: string) => { prompts.push(p); return replies[call++]; } };
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  const reactor = new Reactor({ registry, safety, context, model });
  // budget {640,400}：threshold 240，摘要/重读预算各 200。step2 est=125(mem)+1(goal)+178(hist)=304>240 触发；
  // 一轮收敛后 est=125+1+139+181=446≤640 即止；step3 est≈450>240 但滞回门（3-2=1<2）挡住，records 保持 1
  const r = await reactor.run({ goal: 'g' }, { maxSteps: 3, budget: { total: 640, reserve: 400 } });
  assert.equal(r.done, true);
  assert.equal(prompts.length, 3);
  assert.ok(prompts[1].includes('[压缩摘要'), '触发轮当轮以收敛后上下文组装');
  assert.ok(prompts[1].includes('[重读] f.txt'), '预算内重读保留');
  assert.equal(
    context.memory.index().filter((l) => l.startsWith('compaction: 摘要')).length,
    1,
    '一轮收敛 + 次新步被滞回门控（无门控则为 2）',
  );
});

test('硬越限旁路：est > total 时滞回被旁路立即压缩（环有界 fail-bounded）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-reactor9-'));
  fs.writeFileSync(path.join(tmp, 'f.txt'), 'f'.repeat(400));
  fs.writeFileSync(path.join(tmp, 'g.txt'), 'g'.repeat(300));
  const prompts: string[] = [];
  const replies = [
    '{"tool":"read","input":{"path":"f.txt"},"done":false}',
    '{"tool":"read","input":{"path":"g.txt"},"done":false}',
    '{"done":true}',
  ];
  let call = 0;
  const model = { provider: 'capture', complete: async (p: string) => { prompts.push(p); return replies[call++]; } };
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  const reactor = new Reactor({ registry, safety, context, model });
  // budget {430,400}：threshold 30。step2 est=209>30 触发收敛环，一轮后 est=348≤430 即止（records 1）；
  // step3 读 g 后 est=506>430 硬越限旁路（滞回门 3-2=1<2 闭）压缩 records 2，est=526 仍越限续环：存活集变 [reread f, reread g]（新 checksum）→ records 3，rounds=2 环止；
  // 若无旁路（对比 f=700/g=1200 时 est=970 且存活集与 #2 恒等被判 replay）：records 只会是 1——差值即旁路语义的证明（spec §2.2/C1，环有界 fail-bounded）
  const r = await reactor.run({ goal: 'g' }, { maxSteps: 3, budget: { total: 430, reserve: 400 } });
  assert.equal(r.done, true);
  assert.equal(prompts.length, 3);
  assert.equal(
    context.memory.index().filter((l) => l.startsWith('compaction: 摘要')).length,
    3,
    'step3 硬越限旁路触发第三次压缩',
  );
});
```

  （若本文件已有 `SafetyChain/SecurityGuard/PolicyEngine/ProcessSandbox/DryRun/ToolRegistry/ContextManager/FileStore/builtinTools` 的 import 则复用；缺哪补哪，来源路径与既有 import 一致。）
- [x] **Step 2: 红灯确认**：行为红灯——压缩闭环 prompts[1] 断言失败（现 pipeline 无收敛环）+ 两条新用例 records 数不符（现为 2 与 0/1）。记录输出。
- [x] **Step 3: 实现 reactor.ts**（两处编辑分轮串行）：
  1. `let compactedUpTo = 0;` 声明后追加一行：

```ts
    let lastCompactStep = -2; // 滞回：初始可压（step − (−2) ≥ 2 恒成立）
```

  2. observe 段（从 `const items = this.deps.context.assemble(` 起，至压缩块闭合 `}` 止）整体替换：

```ts
      // observe: 装配 → 估算 → 滞回门 → 收敛环（spec §2.2：压缩当轮即以收敛后上下文组装）
      let items = this.deps.context.assemble(task.goal, this.toHistory(steps, compactedUpTo));
      let est = this.deps.context.window.estimate(items);
      const overThreshold = () =>
        this.deps.context.window.shouldCompact({ total: budget.total, used: est.used, reserve: budget.reserve });
      // 滞回门（跨步节流，环外判定一次）：≥2 新步开闸；est > total 硬越限应急旁路——保证全程 est ≤ total（C1）
      const gateOpen = step - lastCompactStep >= 2 || est.used > budget.total;
      if (gateOpen && overThreshold()) {
        // 收敛环（环内不受滞回限制）：压缩 → 重注入 → 重装配重估；续环条件为硬越限（est > total）越阈即止，至多 2 轮
        let rounds = 0;
        do {
          const chunks = await this.deps.context.window.compact(items, {
            summaryTokenBudget: Math.floor(budget.reserve / 2),
          });
          await this.deps.context.applyCompaction(chunks, { rereadTokenBudget: Math.floor(budget.reserve / 2) });
          compactedUpTo = steps.length;
          lastCompactStep = step;
          items = this.deps.context.assemble(task.goal, this.toHistory(steps, compactedUpTo));
          est = this.deps.context.window.estimate(items);
          rounds++;
        } while (rounds < 2 && est.used > budget.total);
      }
```

  （下游 `ratio = est.used / budget.total` 与 `buildPrompt(items, effectiveTier)` 不动——est/items 已是收敛后值，自动满足「档位用收敛后 est」与 F-b 修复。）
- [x] **Step 4: 绿灯确认**：**113/113/0**。特别核对：既有用例（默认 budget 200000/40000）全程不触发压缩，行为零变化；压缩闭环 prompts[2] 四条断言原样通过。
- [x] **Step 5: 提交**：`git add src/harness/reactor.ts src/harness/reactor.test.ts && git commit -m "feat(reactor): 收敛环与滞回——压缩当轮生效、预算参数贯通（P1-1 T5）"`

---

### Task 6: E2E 收敛探针、全量回归与验收回写

**Files:** Create `scripts/probe-context-budget.js`；Modify 本计划、spec 文件

- [x] **Step 1: E2E 收敛探针**：新建 `scripts/probe-context-budget.js`（node 直跑 dist，组装方式与既有 E2E 探针一致）：tmp 工作区写 f1/f2/f3 各 3000 字符；budget `{ total: 900, reserve: 150 }`（threshold 750，摘要/重读预算各 75）；replies 为三次 read + done，maxSteps 4；捕获每轮 prompt 并按 `estimateTokens` 同款公式（CJK×1+其余÷4，内联实现）计算 token，断言**全部 ≤ 900**（C1），输出 JSON 曲线 `{estPerRound, maxEst, rounds}` 后 `process.exit(0)`，任一超限 `exit(1)`。验算锚点：step2 est≈878>750 触发压缩（摘要/重读全被裁至 ≤75+75），prompt[1] est≈21；step3 est≈891≤900 滞回门控；step4 门重开再压。运行：`node scripts/probe-context-budget.js` → exit 0 且 maxEst ≤ 900。
- [x] **Step 2: 全量回归与 selfcheck**：`npm run build 2>&1 | grep -c 'error TS'` → 0；`npm test 2>&1 | grep -E '^# (tests|pass|fail)'` → **113/113/0**；`npm run selfcheck` 正常输出。
- [x] **Step 3: 验收回写**（spec 与本计划均 root:root，用「node 写临时文件 + mv」方案，参考 1B/1E 惯例；替换前校验锚点唯一）：
  1. 本 plan：29 个 `- [ ] ` 全部替换为 `- [x] `（T1-T5 各 5 步 + T6 4 步 = 29；替换前校验恰好 29 处）；文末追加「## 执行记录」——五个任务提交 hash、E2E 曲线、白名单改写点登记、偏差如实记录。
  2. spec：状态行 `> 状态：评审稿（待用户评审）` → `> 状态：已实施交付（提交链见 plan 执行记录）`；文末追加「## 8. 实施记录」：C1（探针曲线）/C3（tail 分层配额保 skill）/C4（滞回用例）/C5（113/113/0 + 白名单登记）逐项结论，C2 标注「待真实模型冒烟（外部 API 依赖不进流水线门禁，作为后续手动步骤）」。
  3. 校验门：勾选计数与锚点全部命中才允许 mv + git add；任一未命中立即中止并如实报告。
- [x] **Step 4: 提交**：`git add scripts/probe-context-budget.js docs/superpowers/plans/2026-09-05-phase2-context-budget.md docs/superpowers/specs/2026-09-05-phase2-context-budget-design.md && git commit -m "docs+test: P1-1 E2E 收敛探针与验收回写（T6）"`

---

## 验收标准映射（spec §5）

| 编号 | 判据 | 对应用例/步骤 |
|---|---|---|
| C1 收敛性 | E2E 探针全轮次 est ≤ total（budget 900/150） | Task 6 Step 1 |
| C2 语义保持 | R2b 真实场景结论正确（total=135） | 已通过（真实模型冒烟，见执行记录 C2 备注） |
| C3 价值保持 | tail 分层配额用例（skill 保配额）；compaction 记录格式不变 | Task 3 Step 1 |
| C4 滞回 | 收敛环用例 records===1（次新步被门控） | Task 5 Step 1 |
| C5 零回归 | 113/113/0 + tsc strict 零报错；白名单外断言零改动 | 各任务绿灯门 |

## Self-Review 记录

1. **Spec coverage**：§2.1→T1；§2.2→T5（收敛环/滞回/预算参数/当轮生效）；§2.3→T2；§2.4→T4；§2.5→T3（常数表全落地）；§4→各任务测试；§5→映射表。无缺口。
2. **Placeholder 扫描**：无 TBD/TODO；所有代码步骤含完整代码块。
3. **类型一致性**：`estimateTokens(content: string): number`（T1 定义，T2/T3/T4/探针消费）；`tail({skill,episodic,working})`（T3 定义，assemble 消费）；`applyCompaction(chunks, opts?)`（T4 扩展，T5 消费）；`compact(items, opts?)`（T2 扩展，T5 消费）。reason/记录格式无破坏性变更。
4. **红灯形态已注明**：T1-T4 编译红灯（API 扩展）、T5 行为红灯——均如实预期，不隐瞒。

## 执行记录（2026-09-05 回写）

**提交链**：`533a2b4` 本计划 → `f74b1dc` T1 估算解耦 → `a45d27d` T2 摘要预算化 → `582c181` T3 记忆治理 → `176cb14` T3 复盘勘误（tail 用例期望对齐 §2.5）→ `0a07192` T4 重读预算化 → `4335111` T5 收敛环与滞回 → 本次 T6（探针 + 回写）→ `2c35e2b` T5 复盘强化（硬越限用例 records 2→3，场景 f=400+g.txt）。

**测试路线**：101 → 102（T1）→ 105（T2）→ 109（T3）→ 111（T4）→ 113（T5）→ 终态 113/113/0；`npm run build` 全程 0 错误；`npm run selfcheck` OK。

**E2E 收敛探针（C1）**：`scripts/probe-context-budget.js`（budget 900/150，f1/f2/f3 各 3000 字符，4 轮）：
- `estAtThinkPerRound = [6, 641, 302, 809]`，max 809 ≤ 900 → C1 通过；
- `assembleEstTrace = [6, 641, 1275, 302, 809]`：step3 装配 1275 超阈 → 收敛环压缩当轮收敛至 302（F-b 生效）；step4 809 被滞回门控；compactions = 1；
- `promptEstPerRound = [184, 818, 479, 985]` 如实上报——含 ~180 tok 固定头部（工具清单等），非预算记账对象，不作断言。

**白名单改写点登记（spec S5 修订版 3788899）**：
1. 压缩闭环用例 budget 数字行 `{ total: 300, reserve: 40 }` → `{ total: 4500, reserve: 4100 }`；
2. 压缩闭环 `prompts[1]` 断言翻转（`!includes` → `includes`，F-b 修复的可观察结果）；
3. 复杂度信号用例断言消息内估算值注释（est.used≈530）。
白名单之外既有断言语义零改动。

**偏差登记（均按「实现服从 spec、文档回正」处理）**：
1. **T3 复盘（176cb14）**：计划 tail 用例期望（每层仅尾条）与 spec §2.5 配额语义不符，实现按 spec 正确，计划勘误回正。
2. **T5 复盘（4335111 + 2c35e2b）**：计划「硬越限旁路」用例锚点经历两轮实证修正——4335111 按 checksum 幂等去重实证勘误为 records=2（f=700 场景 step3 压缩集与 step2 收敛点恒等判 replay）；2c35e2b 复盘后将场景强化为 f=400+g.txt（step2 一轮即止，step3 旁路压缩后 est 仍越限续环，存活集变 [reread f, reread g] 产生新 checksum），records 恢复为 3 且旁路差值证明更直接（无旁路则恒为 1），验证强度高于初版与计划原稿。
3. **T6 探针口径修正**：计划锚点按「观测不截断」推演（step2≈878 触发），实际 describe 于 2000 字符截断 → 真实触发在 step3（装配 1275）；且探针初版误用 prompt 字符串口径断言 C1——已修正为 spec 定义的 est 口径（think 时刻最后一次装配的 estimate(items).used），prompt 口径仅透明上报。
4. **执行方式**：T1-T4 由并行执行流落地；T5 派发的后台子任务空转收束后，由控制器按计划直接实施。

**C2 备注**：真实模型冒烟已执行通过（scripts/probe-r2b-smoke.js，DeepSeek 真实端点，手动执行不进门禁）：budget {135,45} 下模型 8 轮自主收敛，done=true 且正确答复口令 7391（C2 语义保持）；compact 调用 12 次，checksum 幂等去重后 records=1，每轮 prompt 摘要块 ≤1（幂等不回归）；est 全程有界（max 395）。total=135 档在大观测后处于 fail-bounded 区（mem 尾注回灌所致，spec §6 有界退出），严格 C1≤total 由 900/150 档 E2E 探针承载。
