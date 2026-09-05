# 统一主链 · 1C 内嵌路由 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.
>
> 设计依据：docs/superpowers/specs/2026-09-05-phase1-harness-spine-1c-design.md（评审稿，commit ea4492c）
> 验收目标：总纲 A5「算力档位在 Loop 内决策」+ 本 spec C1–C5

## Global Constraints（逐字执行）

- 零新增 npm 依赖；测试仅用 `node --test`；`tsconfig` 保持 strict；模块 CommonJS，import 用相对路径。
- **零回归红线**：现有全部测试（69 个）必须零改动保持全绿；仅允许在 `reactor.test.ts` / `adapter.test.ts` 文件末尾追加新用例，以及扩展 `makeReactor` helper 的可选参数。
- 实施红线：现有用例不带 tier 字段的回复格式必须完全兼容（parse 容错不破坏）。
- 提交前必须 `npm run build`（tsc strict 零报错）+ `npm test` 全绿；每任务一提交，显式 `git add <文件列表>`，禁止 `git add -A`。
- 环境硬约束：`src/` 属 root:root 0755——新建文件用 sandbox__write、修改已有文件用 sandbox__edit，shell 无法写 src/。**同一文件多处编辑分轮串行**（1B 教训：同轮并行多 edit 会覆盖丢失）。
- TDD 铁律：每个任务先写失败测试并亲眼确认红灯（编译错或断言失败），再实现转绿。

## File Structure（改动面）

| 文件 | 改动 |
|---|---|
| `src/types.ts` | 登记 `export type ModelTier = 'small' \| 'medium' \| 'large'`（自 adapter.ts 迁入） |
| `src/model/adapter.ts` | ModelTier 改自 types 导入并兼容重导出；ModelRouter 新增 `bindDefault`/`boundTiers`，`resolve` 改回退语义 |
| `src/model/adapter.test.ts` | 追加 4 个 ModelRouter 用例（全部新增，无旧用例调整） |
| `src/harness/reactor.ts` | ReactorDeps 增可选 `router`；档位信号建议 + 模型一次性偏好；complete 经 `router.resolve`；Action/StepRecord 增 tier；buildPrompt 注入档位行 |
| `src/harness/reactor.test.ts` | 扩展 makeReactor 可选参 + 追加 4 组新用例 |

---

### Task 1: ModelRouter 回退语义与 ModelTier 登记

**Goal**: Router 具备「绑定档直取 / 未绑定回默认 / 双无抛错」三态 resolve；ModelTier 类型迁入 types.ts；为 Task 2 提供路由底座。

- [x] **Step 1: 写失败测试**

`src/model/adapter.test.ts` 在文件头部 import 区追加：

```ts
import { ModelRouter } from './adapter';
import { ModelTier } from '../types';
```

文件末尾追加 4 个用例：

```ts
test('ModelRouter 未绑定档位回退默认 adapter', () => {
  const def = new StubAdapter();
  const r = new ModelRouter();
  r.bindDefault(def);
  assert.equal(r.resolve('small'), def);
  assert.equal(r.resolve('large'), def);
});

test('ModelRouter 无默认且档位未绑定 → 抛错', () => {
  const r = new ModelRouter();
  assert.throws(() => r.resolve('small'), /no adapter/);
});

test('boundTiers 返回显式绑定快照（不含默认）', () => {
  const r = new ModelRouter();
  r.bindDefault(new StubAdapter());
  r.bind('large', new StubAdapter());
  assert.deepEqual(r.boundTiers(), ['large']);
});

test('ModelTier 自 types 登记且 adapter 侧可用', () => {
  const tiers: ModelTier[] = ['small', 'medium', 'large'];
  assert.equal(tiers.length, 3);
});
```

- [x] **Step 2: 红灯确认**

`npm run build 2>&1 | grep 'error TS'`：预期 `TS2551/TS2339`——`ModelRouter` 无 `bindDefault`/`boundTiers`，types 无 `ModelTier`。

- [x] **Step 3: 实现**

1. `src/types.ts`：在文件合适分区（与 Loop 相关类型同级）登记：

```ts
/** 三档算力档位（模型路由） */
export type ModelTier = 'small' | 'medium' | 'large';
```

2. `src/model/adapter.ts`：
   - 删除本地 `export type ModelTier = ...`，改为 `import { ModelTier } from '../types';` + 兼容重导出 `export type { ModelTier };`
   - ModelRouter 改造（保持 `bind` 原样）：

```ts
export class ModelRouter {
  private adapters = new Map<ModelTier, ModelAdapter>();
  private fallback: ModelAdapter | null = null;

  /** 默认档：所有未显式绑定的档位回退到此 adapter */
  bindDefault(adapter: ModelAdapter): this {
    this.fallback = adapter;
    return this;
  }

  bind(tier: ModelTier, adapter: ModelAdapter): void {
    this.adapters.set(tier, adapter);
  }

  /** 该档已绑定 → 直取；未绑定但有默认 → 回退默认；两者皆无 → 抛错（装配错误快速失败） */
  resolve(tier: ModelTier): ModelAdapter {
    const a = this.adapters.get(tier);
    if (a) return a;
    if (this.fallback) return this.fallback;
    throw new Error(`no adapter bound for tier ${tier}`);
  }

  /** 显式绑定档快照（不含默认回退） */
  boundTiers(): ModelTier[] {
    return [...this.adapters.keys()];
  }
}
```

- [x] **Step 4: 全绿确认**

`npm run build 2>&1 | grep -c 'error TS'`（期望 0）且 `npm test 2>&1 | grep -E '^# (tests|pass|fail)'` 期望 73/73/0。

- [x] **Step 5: 提交**

```bash
git add src/types.ts src/model/adapter.ts src/model/adapter.test.ts
git commit -m "feat(harness): ModelRouter 回退语义与 ModelTier 类型登记（1C/T1）"
```

---

### Task 2: Reactor 内嵌路由（信号建议 + 一次性偏好 + 档位可观测）

**Goal**: 档位成为循环内决策——每轮 observe 用已有 estimate 产物计算信号建议档；上一轮 reply 合法 `tier` 作为下一轮一次性偏好覆盖；complete 经 `router.resolve(effectiveTier)`；prompt 注入服务档位行；StepRecord 记录每步实际服务档位。

- [x] **Step 1: 写失败测试**

`src/harness/reactor.test.ts`：

1. import 区追加 `import { ModelRouter } from '../model/adapter';`
2. `makeReactor` 扩展第三可选参（保持既有调用点兼容）：

```ts
function makeReactor(
  tmp: string,
  adapter: { provider: string; complete: (p: string) => Promise<string> },
  router?: ModelRouter,
): Reactor {
  const store = new FileStore(tmp);
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'manual'), new ProcessSandbox(), new DryRun(), tmp);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, tmp)) registry.register(t);
  const context = new ContextManager(tmp, store);
  return new Reactor({ registry, safety, context, model: adapter, ...(router ? { router } : {}) });
}
```

3. 文件末尾追加 capture 工具与 4 组用例：

```ts
/** 可编回复的 capture adapter：记录 prompt、按需切换回复 */
function mkCap() {
  const calls: string[] = [];
  const queue: string[] = [];
  return {
    calls,
    set(...rs: string[]) { queue.push(...rs); },
    adapter: {
      provider: 'cap',
      complete: async (p: string) => {
        calls.push(p);
        return queue.length > 0 ? queue.shift()! : '{"done":true,"reply":"ok"}';
      },
    },
  };
}

test('reply.tier 作为下一轮一次性偏好路由到对应 adapter', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-1c-pref-'));
  const small = mkCap(), large = mkCap();
  const router = new ModelRouter();
  router.bindDefault(small.adapter);
  router.bind('large', large.adapter);
  small.set('{"tool":"exec","input":{"command":"echo a"},"done":false,"tier":"large"}');
  large.set('{"tool":"exec","input":{"command":"echo b"},"done":false}');
  const reactor = makeReactor(tmp, small.adapter, router);

  const r = await reactor.run({ goal: 'g' }, { maxSteps: 3 });
  assert.equal(r.done, true);
  assert.equal(large.calls.length, 1, '第二轮消费一次性偏好路由 large');
  assert.equal(small.calls.length, 2, '首轮 small + 第三轮偏好已消费回落（medium→默认回退）');
  assert.ok(small.calls[0].includes('当前服务档位：small'), 'prompt 含本轮服务档位');
  assert.ok(large.calls[0].includes('当前服务档位：large'));
  if (r.steps[0] && r.steps[1]) {
    assert.equal(r.steps[0].tier, 'small');
    assert.equal(r.steps[1].tier, 'large');
  } else {
    assert.fail('应有至少两步记录');
  }
});

test('复杂度信号：ratio≥0.6 无偏好升档 large', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-1c-sig-'));
  const small = mkCap(), large = mkCap();
  const router = new ModelRouter();
  router.bindDefault(small.adapter);
  router.bind('large', large.adapter);
  const reactor = makeReactor(tmp, small.adapter, router);

  await reactor.run({ goal: 'x'.repeat(2000) }, { maxSteps: 1, budget: { total: 300, reserve: 40 } });
  assert.equal(large.calls.length, 1, 'est.used=600/total=300 → ratio≥0.6 → large');
  assert.equal(small.calls.length, 0);
});

test('仅默认绑定的 router 行为与 1B 等价', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-1c-fb-'));
  const cap = mkCap();
  cap.set('{"tool":"exec","input":{"command":"echo hi"},"done":false}');
  const router = new ModelRouter();
  router.bindDefault(cap.adapter);
  const reactor = makeReactor(tmp, cap.adapter, router);

  const r = await reactor.run({ goal: 'echo hi' });
  assert.equal(r.done, true);
  assert.equal(cap.calls.length, 2);
  assert.ok(r.steps.every((s) => s.tier !== undefined), '每步记录实际服务档位');
});

test('非法 tier 值被忽略且不中断循环', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-1c-bad-'));
  const small = mkCap(), large = mkCap();
  const router = new ModelRouter();
  router.bindDefault(small.adapter);
  router.bind('large', large.adapter);
  small.set('{"tool":"exec","input":{"command":"echo x"},"done":false,"tier":"huge"}');
  const reactor = makeReactor(tmp, small.adapter, router);

  const r = await reactor.run({ goal: 'g' }, { maxSteps: 2 });
  assert.equal(r.done, true);
  assert.equal(large.calls.length, 0, '非法档位不得被路由');
  assert.equal(small.calls.length, 2, '回落信号档/默认回退');
});
```

- [x] **Step 2: 红灯确认**

`npm run build 2>&1 | grep 'error TS'`：预期 ReactorDeps 无 `router`、StepRecord 无 `tier`、buildPrompt 参数不匹配。

- [x] **Step 3: 实现（src/harness/reactor.ts）**

1. import：`import { ModelRouter, ModelTier } from '../model/adapter';`（ModelTier 亦可自 types 导入，二者等价）。
2. `ReactorDeps` 增 `router?: ModelRouter;`
3. `StepRecord` 增 `tier?: ModelTier;`；`Action` 增 `tier?: unknown;`
4. `run` 循环改造：

```ts
const router = this.deps.router ?? new ModelRouter().bindDefault(this.deps.model);
let prefTier: ModelTier | undefined; // 模型一次性偏好：仅影响下一轮
```

observe 之后（est 已算出，压缩分支之后、think 之前）：

```ts
// 档位决策（循环内）：模型一次性偏好优先，否则复杂度信号建议
const ratio = est.used / budget.total;
const tierStar: ModelTier = ratio >= 0.6 ? 'large' : step <= 2 && ratio < 0.2 ? 'small' : 'medium';
const effectiveTier = prefTier ?? tierStar;
prefTier = undefined; // 一次性消费
```

think：

```ts
raw = await router.resolve(effectiveTier).complete(this.buildPrompt(items, effectiveTier));
```

parse 成功后（含 done 分支之前）——注意 parse 白名单式重建 action 时必须显式携带 tier（`tier: j.tier`），否则一次性偏好永远为空（T2 实测踩坑，红灯定位后补上）：

```ts
prefTier = action.tier === 'small' || action.tier === 'medium' || action.tier === 'large' ? action.tier : undefined;
```

所有 `steps.push`（parse 失败分支、缺 tool 分支、act 成功分支）追加 `tier: effectiveTier`。

5. `buildPrompt(items: ContextItem[], tier: ModelTier)`：返回数组首行前插入：

```ts
`当前服务档位：${tier}；如需调整下一轮算力，在回复 JSON 中加 "tier": "small|medium|large"`,
```

注意：档位行只存在于模型请求串，不产生 ContextItem、不参与 estimate/压缩/checksum（循环元信息而非任务上下文，不得扰动 1B checksum 基线）。

- [x] **Step 4: 全绿确认**

`npm run build` 零报错；`npm test` 期望 77/77/0；`npm run selfcheck` 通过。

- [x] **Step 5: 提交**

```bash
git add src/harness/reactor.ts src/harness/reactor.test.ts
git commit -m "feat(harness): 档位收敛进 Loop 决策——信号建议+模型一次性偏好+服务档可观测（1C/T2）"
```

---

## 验收标准映射（C1–C5 / A5）

| 编号 | 判据 | 对应用例 |
|---|---|---|
| C1 档位循环内决策 | 档位由循环内信号 + 模型协议字段决定 | T2 信号路由 + 显式偏好用例 |
| C2 模型参与决策 | 合法 reply.tier 下一轮一次性生效；非法忽略不中断 | T2 用例 1 / 用例 4 |
| C3 回退安全 | 未绑定档回退默认；仅默认绑定时与 1B 等价 | T1 用例 1/2 + T2 用例 3 + 既有 69 用例零改动全绿 |
| C4 无游离路由 | 生产代码 ModelRouter 仅 Reactor 消费 | 收尾 `grep -rn "ModelRouter" src` 复核 |
| C5 可观测 | StepRecord.tier + prompt 档位行 | T2 用例 1/3 断言 |

## Self-Review

1. 现有 69 用例是否零改动？——是；新用例全部追加，makeReactor 仅增可选参。
2. 档位行是否污染上下文管线？——否；仅在 buildPrompt 拼接，不产生 ContextItem，estimate/压缩/checksum 基线不动。
3. 回退语义是否破坏既有 adapter 行为？——`resolve` 无绑定时原抛错路径仅剩「无默认无绑定」装配错误场景；原语义用例本就不存在（adapter.test 无 ModelRouter 用例）。
4. 一次性偏好的消费时机？——本轮开头取用即清空，本轮 reply 重新声明；避免陈旧偏好驻留。
5. ratio 口径是否与压缩同源？——是，均用本轮 run 的 budget.total，无第二套预算。

---

## 执行记录（2026-09-05 回写）

两个任务全部完成。实现提交链：93fe719（T1 ModelRouter 回退语义与 ModelTier 登记）→ 9384497（T2 Reactor 内嵌路由）。

### 与本文档的偏差

1. **parse 白名单丢弃 tier（T2 实测踩坑）**：本文 T2 Step 3 原实现要点未写明「parse 重建 action 时需显式携带 `tier: j.tier`」，首轮落地后「一次性偏好」用例红灯（large.calls=0）定位补上，Step 3 第 7 点已同步。
2. **mkCap fixture 改队列式**：本文 T2 Step 1 原 mkCap 为静态回复，多轮用例中模型永不返回 done，三个用例因此失败。实际改为回复队列（`set(...rs)` 逐轮消费，耗尽即 `{"done":true}`），上文代码块已同步，用例断言逻辑不变。
3. **过程记录**：T2 子代理执行超时（5 分钟），改动已大部分落盘（红灯已确认、实现已完成、未提交），主线程接手验证（发现并修复偏差 1/2）后提交。

### 验收结果（C1–C5 / A5）

| 编号 | 结果 |
|---|---|
| C1 档位循环内决策 | 通过（信号路由 + 偏好用例） |
| C2 模型参与决策 | 通过（一次性偏好生效、非法值忽略） |
| C3 回退安全 | 通过（仅默认绑定与 1B 等价；既有用例零改动全绿） |
| C4 无游离路由 / A5 | 通过（grep 复核：生产代码仅 reactor.ts 消费） |
| C5 可观测 | 通过（StepRecord.tier + prompt 档位行） |

全量 `node --test` 77/77 通过；`npm run build` 零报错；`npm run selfcheck` 通过；1B 关键回归（压缩闭环/水位线/checksum 三态）无回归。