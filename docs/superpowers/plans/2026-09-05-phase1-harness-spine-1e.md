# 统一主链 · 1E 记忆沉淀 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.
>
> 设计依据：docs/superpowers/specs/2026-09-05-phase1-harness-spine-1e-design.md（评审稿，commit fd2ef2c）
> 验收目标：总纲 A4 完整（记忆唯一生命周期）+ 本 spec E1–E4

## Global Constraints（逐字执行）

- 零新增 npm 依赖；测试仅用 `node --test`；`tsconfig` 保持 strict；模块 CommonJS，import 用相对路径。
- **零回归红线**：现有全部测试（82 个）断言零改动全绿；仅允许追加新用例与 e2e 的「种子行」装配适配（见 Task 2 Step 1.3，断言零改动）。
- **同一文件多处编辑分轮串行**（1B 教训：同轮并行多 edit 会覆盖丢失）。
- TDD 铁律：先写失败测试并亲眼确认红灯（编译错或断言失败），再实现转绿。
- 提交前必须 `npm run build`（零报错）+ `npm test` 全绿；每任务一提交，显式 `git add <文件列表>`，禁止 `git add -A`。
- 环境硬约束：`src/` 属 root:root——修改已有文件用 sandbox__edit，shell 无法写 src/。

## File Structure（改动面）

| 文件 | 改动 |
|---|---|
| `src/harness/context/memory-lifecycle.ts` | 重写：三层分键、record 路由、index 聚合、promote/endTask/counts、legacy 迁移 |
| `src/harness/context/memory-lifecycle.test.ts` | 追加 6 组用例（既有 2 用例零改动） |
| `src/harness/reactor.ts` | run 收尾调用 `endTask()`（一行） |
| `src/harness/reactor.test.ts` | 追加 2 组收尾用例 |
| `src/e2e.test.ts` | 种子行适配（run 前种子 episodic 一条，断言零改动） |

`ContextManager` / `types.ts` / 安全链 / 压缩 / 档位 / 后端全部零改动。

---

### Task 1: MemoryLifecycle 三级生命周期

**Goal**: `MemoryLifecycle` 升级为三层分键（working/episodic/skill）+ record 路由 + 聚合 index + promote/endTask/counts + legacy 迁移；既有 2 用例与 compaction/assemble 断言零改动兼容。

- [ ] **Step 1: 写失败测试**

`src/harness/context/memory-lifecycle.test.ts` 文件末尾追加 6 组用例：

```ts
test('record 按主题路由：project→working，compaction→episodic', () => {
  const m = new MemoryLifecycle(new FileStore(tmpdir()));
  m.record('project', '偏好 TDD');
  m.record('compaction', '摘要 checksum=abc');
  assert.deepEqual(m.counts(), { working: 1, episodic: 1, skill: 0 });
});

test('index 聚合顺序：skill → episodic → working', () => {
  const m = new MemoryLifecycle(new FileStore(tmpdir()));
  m.record('project', '工作条目');
  m.record('compaction', '事件条目');
  assert.equal(m.promote('事件条目'), true);
  assert.deepEqual(m.index(), ['compaction: 事件条目', 'project: 工作条目']);
});

test('promote：命中提升 episodic → skill，未命中返回 false', () => {
  const m = new MemoryLifecycle(new FileStore(tmpdir()));
  m.record('compaction', '关键事实 root 越界即拒绝');
  assert.equal(m.promote('不存在'), false);
  assert.equal(m.promote('关键事实'), true);
  assert.deepEqual(m.counts(), { working: 0, episodic: 0, skill: 1 });
  assert.equal(m.promote('关键事实'), false, '已提升后 episodic 无此条目');
});

test('skill 层上限 50，FIFO 淘汰最旧', () => {
  const m = new MemoryLifecycle(new FileStore(tmpdir()));
  for (let i = 0; i < 52; i++) m.record('compaction', `事实 marker${i}end`);
  for (let i = 0; i < 52; i++) assert.equal(m.promote(`marker${i}end`), true);
  const c = m.counts();
  assert.equal(c.skill, 50);
  assert.equal(c.episodic, 0);
  assert.equal(m.index()[0], 'compaction: 事实 marker2end', '最旧两条被 FIFO 淘汰');
});

test('endTask 清退 working，episodic/skill 保留', () => {
  const m = new MemoryLifecycle(new FileStore(tmpdir()));
  m.record('project', '易失记录');
  m.record('compaction', '持久事件');
  assert.equal(m.promote('持久事件'), true);
  m.endTask();
  assert.deepEqual(m.counts(), { working: 0, episodic: 0, skill: 1 });
  assert.deepEqual(m.index(), ['compaction: 持久事件']);
});

test('legacy 单桶索引自动迁移：按前缀路由，legacy 键清空且幂等', () => {
  const store = new FileStore(tmpdir());
  store.write('memory.index', ['project: 旧工作记录', 'compaction: 旧压缩事件']);
  const m = new MemoryLifecycle(store);
  assert.deepEqual(m.counts(), { working: 1, episodic: 1, skill: 0 });
  assert.deepEqual(m.index(), ['compaction: 旧压缩事件', 'project: 旧工作记录']);
  assert.deepEqual(store.read<string[]>('memory.index', ['x']), [], 'legacy 键写空防重复迁移');
  const m2 = new MemoryLifecycle(store);
  assert.deepEqual(m2.counts(), { working: 1, episodic: 1, skill: 0 });
});
```

- [ ] **Step 2: 红灯确认**

`npm run build 2>&1 | grep 'error TS'`：预期 `TS2339`——`promote`/`endTask`/`counts` 不存在。既有 2 用例此时仍绿（接口未变）。

- [ ] **Step 3: 实现（memory-lifecycle.ts 重写）**

```ts
import { StorageAdapter } from '../../storage/adapter';

/** 记忆分层：working（当前任务，易失）/ episodic（事件记忆，持久）/ skill（沉淀知识，仅经 promote 写入） */
export type MemoryTier = 'working' | 'episodic' | 'skill';

const TIER_KEY: Record<MemoryTier, string> = {
  working: 'memory.working',
  episodic: 'memory.episodic',
  skill: 'memory.skill',
};
const LEGACY_KEY = 'memory.index';
const CAP: Record<MemoryTier, number> = { working: 200, episodic: 200, skill: 50 };

/** 统一记忆生命周期：working→episodic→skill 三级流转（A4 唯一记忆面，memory.* 键仅此类读写） */
export class MemoryLifecycle {
  constructor(private store: StorageAdapter) {
    this.migrate();
  }

  private tier(t: MemoryTier): string[] {
    return this.store.read<string[]>(TIER_KEY[t], []);
  }

  private save(t: MemoryTier, items: string[]): void {
    this.store.write(TIER_KEY[t], items);
  }

  record(type: string, text: string): void {
    const t: MemoryTier = type === 'project' ? 'working' : 'episodic';
    const items = this.tier(t);
    items.push(`${type}: ${text}`);
    if (items.length > CAP[t]) items.shift();
    this.save(t, items);
  }

  /** 聚合视图：skill → episodic → working（注入顺序 = 价值梯度） */
  index(): string[] {
    return [...this.tier('skill'), ...this.tier('episodic'), ...this.tier('working')];
  }

  /** episodic → skill 显式沉淀：按子串匹配第一条命中条目，原样移入 skill 层（上限 50 FIFO） */
  promote(match: string): boolean {
    const epi = this.tier('episodic');
    const i = epi.findIndex((l) => l.includes(match));
    if (i === -1) return false;
    const skill = this.tier('skill');
    skill.push(epi[i]);
    if (skill.length > CAP.skill) skill.shift();
    epi.splice(i, 1);
    this.save('episodic', epi);
    this.save('skill', skill);
    return true;
  }

  /** 任务收尾：清退 working 层；episodic/skill 持久保留 */
  endTask(): void {
    this.save('working', []);
  }

  counts(): { working: number; episodic: number; skill: number } {
    return {
      working: this.tier('working').length,
      episodic: this.tier('episodic').length,
      skill: this.tier('skill').length,
    };
  }

  /** legacy 单桶索引一次性迁移：按前缀路由到分层键；legacy 键写空（StorageAdapter 无删除语义，不加接口） */
  private migrate(): void {
    const legacy = this.store.read<string[]>(LEGACY_KEY, []);
    if (legacy.length === 0) return;
    if (this.tier('working').length + this.tier('episodic').length + this.tier('skill').length > 0) return;
    const routed: Record<MemoryTier, string[]> = { working: [], episodic: [], skill: [] };
    for (const line of legacy) routed[line.startsWith('project:') ? 'working' : 'episodic'].push(line);
    for (const t of ['working', 'episodic', 'skill'] as MemoryTier[]) {
      if (routed[t].length > CAP[t]) routed[t] = routed[t].slice(routed[t].length - CAP[t]);
      if (routed[t].length > 0) this.save(t, routed[t]);
    }
    this.store.write(LEGACY_KEY, []);
  }
}
```

- [ ] **Step 4: 全绿确认**

`npm run build` 零报错；`npm test` 期望 **88/88/0**（82 既有零改动 + 6 新增）。特别核对 compaction.test 的 `compaction:` 断言与 assemble.test 的 `includes` 断言不受聚合顺序影响。

- [ ] **Step 5: 提交**

```bash
git add src/harness/context/memory-lifecycle.ts src/harness/context/memory-lifecycle.test.ts
git commit -m "feat(harness): MemoryLifecycle 三级生命周期——分层路由/聚合索引/显式沉淀/收尾清退（1E/T1）"
```

---

### Task 2: Reactor 收尾挂点与可替换性收口

**Goal**: run 收尾调用 `endTask()`（done 与 maxSteps 耗尽共用同一 return 点）；reactor.test 补收尾用例；e2e 种子行适配（断言零改动）；A4 grep 复核。

- [ ] **Step 1: 写失败测试**

1. `src/harness/reactor.test.ts` 末尾追加（import 沿用既有，无新增）：

```ts
test('run 收尾清退 working：done 形态 episodic 保留、working 清零', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-1e-done-'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  context.memory.record('compaction', '种子事件：跨任务保留');
  const reactor = new Reactor({
    registry,
    safety,
    context,
    model: new ScriptedAdapter([
      '{"tool":"exec","input":{"command":"echo a"},"done":false}',
      '{"done":true}',
    ]),
  });
  const r = await reactor.run({ goal: 'x' });
  assert.equal(r.done, true);
  const c = context.memory.counts();
  assert.equal(c.working, 0, 'working 已随任务收尾清退');
  assert.equal(c.episodic, 1, 'episodic 跨任务保留');
});

test('run 收尾清退 working：maxSteps 耗尽形态同样清退', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-1e-max-'));
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, new FileStore(tmp));
  const reactor = new Reactor({
    registry,
    safety,
    context,
    model: new ScriptedAdapter(['{"tool":"exec","input":{"command":"echo a"},"done":false}']),
  });
  const r = await reactor.run({ goal: 'x' }, { maxSteps: 1 });
  assert.equal(r.done, false);
  assert.equal(context.memory.counts().working, 0);
});
```

2. `src/e2e.test.ts`：第一个用例 `const h = new Harness({ root, model });` 之后、`h.perception.scan()` 之前插入种子行（**断言零改动**，仅装配适配——否则 run 收尾清退 working 后第 24 行 `index().length >= 1` 失去数据源）：

```ts
  h.context.memory.record('compaction', '种子事件：e2e 记忆保留验证');
```

- [ ] **Step 2: 红灯确认**

`npm run build` 零报错（endTask 已在 T1 存在）；`npm test` 预期 2 个新用例失败：`c.working` 实际 1（run 未清退）。e2e 用例此时失败（种子在但 working 未清退不影响它——它是绿灯项，仅断言核对）。

- [ ] **Step 3: 实现（reactor.ts 一行）**

`run()` 的收尾 return（`return { steps, done, reply };`）之前插入：

```ts
    // 任务收尾：清退 working 层（done 与 maxSteps 耗尽共用此出口）
    this.deps.context.memory.endTask();
```

- [ ] **Step 4: 全绿确认**

`npm run build` 零报错；`npm test` 期望 **90/90/0**（88 + 2）；`npm run selfcheck` 通过。

- [ ] **Step 5: 提交 + A4 结构复核**

```bash
grep -rn "'memory\." src --include='*.ts' | grep -v memory-lifecycle | grep -v test   # 期望空：memory.* 键仅 MemoryLifecycle 读写
git add src/harness/reactor.ts src/harness/reactor.test.ts src/e2e.test.ts
git commit -m "feat(harness): run 收尾清退 working 层——三级记忆生命周期闭环（1E/T2）"
```

---

## 验收标准映射（E1–E4 / A4）

| 编号 | 判据 | 对应用例 |
|---|---|---|
| E1 三级分层 | record 按主题路由；skill 仅经 promote 写入 | T1 用例 1/3（promote 未命中不产生 skill 条目） |
| E2 沉淀回流 | promote 提升 + 聚合注入 skill 优先 | T1 用例 2（index 聚合顺序） |
| E3 working 易失 | 收尾清退 working，持久层保留 | T1 用例 5 + T2 两用例（done/maxSteps 双形态） |
| E4 迁移兼容 | legacy 自动分层迁移、幂等；既有用例零改动全绿 | T1 用例 6 + 全量回归 |
| A4 完整 | `memory.*` 键仅 MemoryLifecycle 读写（grep 复核） | T2 Step 5 |

## Self-Review

1. 既有 82 用例是否零改动？——是；memory-lifecycle 既有 2 用例（project 路由与 200 上限）语义在新实现下逐字节成立；e2e 仅加种子行，断言不动。
2. `record` 四个既有调用点是否零改动？——是；`project`→working、`compaction`→episodic 的路由在方法内部完成，reactor.ts 与 context/index.ts 不感知。
3. StorageAdapter 是否变更？——否；spec 所述「删除 legacy 键」以「写空数组」落实（接口无删除语义，空数组读取等价于不存在，且防重复迁移）。
4. endTask 挂点是否覆盖全部退出路径？——run 仅一个 return（done break 与 maxSteps 耗尽殊途同归），挂点在 return 前一行即全覆盖。
5. 聚合顺序对 1B 压缩重读/1C 档位是否有影响？——否；压缩重读条目走 ContextManager 注入块与 memory 分层无关；档位信号只读 estimate。
