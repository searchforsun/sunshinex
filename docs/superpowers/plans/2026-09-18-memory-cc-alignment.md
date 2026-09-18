# 记忆体系对齐 Claude Code 形态 实施计划（8 任务 TDD）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把自动记忆从「任务收口一次性提取」补齐到 Claude Code 形态——模型会中自写记忆（原子 `write`，含 Saved 回执）、记忆总开关、`modified` 写入时间戳、子代理自有记忆、索引将满两级提醒；同时落地两条项目规范（动态改动一律尾追、原子工具优先）。

**Architecture:** 新增三个纯/薄模块——`memory/paths.ts`（路径分类器，安全链与写入接缝共用单点）、`memory/writer.ts`（记忆写入接缝：校验→落盘→规范化→重建索引→容量回执）、`config/memory-config.ts`（env + 缺省两层解析单点）。会话常量的运行期变更一律走链尾说明行（`ContextManager.appendInstructionLine` 单点），前端段字节零改写。

**Tech Stack:** TypeScript strict（CommonJS）、node:test + assert/strict、node:fs 同步 API、`resolveDataDir`（config/data-dir.ts）、`t()`/`pick()` 双语（src/i18n.ts）。

**规格来源:** docs/superpowers/specs/2026-09-18-memory-cc-alignment-design.md（c9abb78，用户「写计划」批准）

**规范来源:** CLAUDE.md §5（原子工具优先）、§11（动态改动一律尾追）

## Global Constraints

- **不新增任何工具**（规范 N2 / 规格 §4.4）：工具面零变化——会中自写复用既有 `write`，可见性复用链尾说明行；实施后 `selfcheck` 工具清单须与实施前逐字节一致。
- **前缀缓存第一要义 + 动态改动尾追**（规范 N1）：会话运行期对 SUNSHINE.md／技能清单／记忆索引的任何变更只走**链尾说明行**；禁止改写 `contextSnapshot`、禁止就地改写历史行、禁止提前重建快照。快照重写仍只在四刷新点（构造 / `reloadContext` / `resetSession` / 压缩成功非 replay）。
- **冻结语义**：会中自写的记忆不在本会话进入索引；模型需要就用 `read` 直接读记录文件（数据目录只读放行已存在，开关与只读放行**无关**）。
- 全部用户可见文案走 `t(en, zh)`、模型可见文案走 `pick(en, zh)`，双语字面量就地成对（零词典文件）；禁止模块级 `t()`/`pick()` 冻结。
- 旁路纪律：记忆层任何失败（写入/校验/索引/容量）一律降级为工具侧可读错误或静默吞错，**任务收口永不因记忆失败而失败**。
- 测试卫生：数据目录断言统一走 `resolveDataDir(root)`；用例内重定向 `SUNSHINEX_DATA_DIR`（或 `HOME`+`USERPROFILE` 双变量），禁止断言真实家目录。
- TDD 纪律：每任务先红灯后实现；**单文件单编辑串行**（`context/index.ts`、`reactor.ts`、`session.ts` 有并行编辑竞态两次先例）；提交前定向套件绿。
- 闸门纪律：测试通过判据用「fail 0 / pass N」硬断言，禁用 `grep` 命中作通过判据（goal 对齐批次教训）。
- 平台约束（CLAUDE.md §14）：路径一律 `path.join` / `path.resolve` / `path.relative`，禁手拼分隔符。
- **测试用例纪律（预检修正）**：本计划部分任务以「断言面清单」形式列出用例名（Task 4 的六拒绝分支/超限/近满、Task 7 的 scope 收窄与主链零污染、Task 8 的 settle 返回与 toggle）——那些是**必须逐条写成真断言**的红灯测试，禁止提交空体用例（`test('...', () => {})`）。提交前自检：`grep -c "() => {}" <改动测试文件>` 必须为 0。

---

### Task 1: MemoryStore 扩展（`modified` / `put` 更新语义 / 容量两级 / 子目录构造）

**Files:**
- Modify: `src/harness/memory/store.ts`
- Test: `src/harness/memory/store.test.ts`（就近追加用例）

**Interfaces:**
- Consumes: 无（本任务为底座扩展）
- Produces（后续任务依赖）:
  - `export interface MemoryRecord { slug: string; type: MemoryType; created: string; modified: string; description: string; body: string }`
  - `export class MemoryStore { constructor(root: string, opts?: { subdir?: string }); dir(): string; put(input: { slug: string; type: MemoryType; description: string; body: string; created?: string; modified?: string }): Result<MemoryRecord>; capacityNotice(): string | null }` —— 其余既有成员签名不变
  - `put` 语义：同 slug **更新**（去重自排除 + 刷新 `modified`）、不存在则**创建**；写入 → `rebuildIndex()` → 超限返回 `fail('MEMORY_INDEX_OVER_LIMIT', ...)`（文件已落盘，CC 语义）
  - `capacityNotice()`：≥80%（160 行 / 20 000 字节）返回提醒文本，否则 `null`

- [ ] **Step 1: 写红灯测试**

在 `src/harness/memory/store.test.ts` 追加（沿用该文件既有 tmpdir + `SUNSHINEX_DATA_DIR` 重定向与还原范式）：

```ts
test('put 同 slug 为更新：不产生 -2 副本、刷新 modified、保留 created', () => {
  const store = new MemoryStore(root);
  const first = store.put({ slug: 'prefers-chinese', type: 'user', description: 'prefers Chinese replies', body: 'always answer in Chinese' });
  assert.equal(first.ok, true);
  const before = store.list().find((r) => r.slug === 'prefers-chinese')!;
  const updated = store.put({
    slug: 'prefers-chinese',
    type: 'user',
    description: 'prefers Chinese replies',
    body: 'always answer in Chinese, including tables',
  });
  assert.equal(updated.ok, true);
  const after = store.list().find((r) => r.slug === 'prefers-chinese')!;
  assert.equal(after.created, before.created, 'created 不被覆盖');
  assert.notEqual(after.modified, '', 'modified 必填');
  assert.equal(store.count(), 1, '更新不新增记录文件');
  assert.equal(store.list().some((r) => r.slug === 'prefers-chinese-2'), false, '不产生 -2 副本');
});

test('put 撞他人 description 归一相同 → MEMORY_DUPLICATE（自排除不误伤自身更新）', () => {
  const store = new MemoryStore(root);
  store.put({ slug: 'a', type: 'project', description: 'Repo uses pnpm', body: 'pnpm only' });
  const r = store.put({ slug: 'b', type: 'project', description: 'repo uses   PNPM', body: 'other body' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'MEMORY_DUPLICATE');
});

test('modified 为 ISO 8601 且写入后被解析回读', () => {
  const store = new MemoryStore(root);
  const r = store.put({ slug: 'iso', type: 'project', description: 'd', body: 'b' });
  assert.equal(r.ok, true);
  const rec = store.list().find((x) => x.slug === 'iso')!;
  assert.match(rec.modified, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'ISO 8601 时间戳');
});

test('缺 modified 的旧记录回退 created（零迁移）', () => {
  const store = new MemoryStore(root);
  fs.writeFileSync(
    path.join(store.dir(), 'legacy.md'),
    ['---', 'type: project', 'created: 2026-01-02', 'description: legacy record', '---', 'body', ''].join('\n'),
  );
  const rec = store.list().find((x) => x.slug === 'legacy')!;
  assert.equal(rec.modified, '2026-01-02');
});

test('capacityNotice：近满（≥80%）返回提醒、未近满返回 null', () => {
  const store = new MemoryStore(root);
  assert.equal(store.capacityNotice(), null);
  for (let i = 0; i < 160; i += 1) store.put({ slug: `n${i}`, type: 'project', description: `fact ${i}`, body: `body ${i}` });
  const notice = store.capacityNotice();
  assert.notEqual(notice, null);
  assert.match(String(notice), /160|200/);
});

test('显式子目录构造：dir() 落在 memory/agents/<id> 且与主目录互不干扰', () => {
  const child = new MemoryStore(root, { subdir: path.join('agents', 'reviewer') });
  child.put({ slug: 'r1', type: 'project', description: 'child fact', body: 'child body' });
  const main = new MemoryStore(root);
  assert.equal(main.count(), 0, '主目录零干扰');
  assert.equal(child.count(), 1);
  assert.ok(child.dir().endsWith(path.join('memory', 'agents', 'reviewer')), '目录形态');
});
```

- [ ] **Step 2: 跑红灯确认**

Run: `npx tsc -p tsconfig.json && node --test dist/harness/memory/store.test.js 2>&1 | tail -8`
Expected: FAIL（`put` / `capacityNotice` 未定义，`modified` 缺失）

- [ ] **Step 3: 最小实现**

`src/harness/memory/store.ts` 逐点改：

```ts
export interface MemoryRecord {
  slug: string;
  type: MemoryType;
  /** 绝对日期 YYYY-MM-DD：整理判 stale 的唯一时效依据（时间只以绝对形式存在） */
  created: string;
  /** 最近写入时间（ISO 8601，每次写入刷新）；缺该字段的旧记录解析回退 created */
  modified: string;
  description: string;
  body: string;
}

/** 近满阈值（规格 §6）：上限的 80%，行数与字节数任一先到即提醒 */
const NEAR_LIMIT_RATIO = 0.8;

/** frontmatter 序列化（四键单一来源：add 与 put 共用，防两处格式漂移） */
function serialize(rec: { type: MemoryType; created: string; modified: string; description: string; body: string }): string {
  return [
    '---',
    `type: ${rec.type}`,
    `created: ${rec.created}`,
    `modified: ${rec.modified}`,
    `description: ${rec.description}`,
    '---',
    rec.body,
    '',
  ].join('\n');
}
```

`parseRecord` 的返回行改为：

```ts
  return {
    slug,
    type,
    created: meta.created ?? '',
    modified: meta.modified ?? meta.created ?? '',
    description: meta.description ?? '',
    body: m[2].replace(/\n$/, ''),
  };
```

构造器增子目录形态：

```ts
  constructor(root: string, opts?: { subdir?: string }) {
    const base = path.join(resolveDataDir(root), 'memory');
    // 子目录形态（规格 §5）：子代理自有记忆 memory/agents/<id>，与主目录互不干扰
    this.dirPath = opts?.subdir === undefined ? base : path.join(base, opts.subdir);
    fs.mkdirSync(this.dirPath, { recursive: true });
  }
```

`add` 改为复用 `serialize`（并补 `modified`）：

```ts
    const created = input.created ?? new Date().toISOString().slice(0, 10);
    const modified = new Date().toISOString();
    fs.writeFileSync(path.join(this.dirPath, `${slug}.md`), serialize({ type: input.type, created, modified, description, body }));
    this.rebuildIndex();

    const record: MemoryRecord = { slug, type: input.type, created, modified, description, body };
    const over = this.overLimit();
    if (over !== null) return fail('MEMORY_INDEX_OVER_LIMIT', over);
    return ok(record);
```

新增 `put`：

```ts
  /**
   * 按既有 slug 写入（会中自写路径，规格 §5）：同 slug 视为**更新**（去重自排除、保留 created、刷新 modified），
   * 不存在则创建。存在的价值：模型改写一条记忆不产生 -2 副本。超限语义与 add 一致（写成功 + 报错勒令精简）。
   */
  put(input: { slug: string; type: MemoryType; description: string; body: string; created?: string; modified?: string }): Result<MemoryRecord> {
    const slug = input.slug.trim();
    const description = input.description.trim();
    const body = input.body.trim();
    if (!slug) return fail('MEMORY_EMPTY', 'slug 不得为空');
    if (!description || !body) return fail('MEMORY_EMPTY', '记忆描述与正文均不得为空');
    const existing = this.list().find((r) => r.slug === slug);
    const duplicate = this.list().find(
      (r) =>
        r.slug !== slug &&
        (normalizeText(r.description) === normalizeText(description) || normalizeText(r.body) === normalizeText(body)),
    );
    if (duplicate) return fail('MEMORY_DUPLICATE', `duplicate: ${duplicate.slug}`);

    const created = input.created ?? existing?.created ?? new Date().toISOString().slice(0, 10);
    const modified = input.modified ?? new Date().toISOString();
    fs.writeFileSync(path.join(this.dirPath, `${slug}.md`), serialize({ type: input.type, created, modified, description, body }));
    this.rebuildIndex();

    const record: MemoryRecord = { slug, type: input.type, created, modified, description, body };
    const over = this.overLimit();
    if (over !== null) return fail('MEMORY_INDEX_OVER_LIMIT', over);
    return ok(record);
  }
```

新增 `capacityNotice`：

```ts
  /** 近满提醒（规格 §6 两级容量：近满=提醒、超限=错误）：行数或字节数任一 ≥80% 返回提醒文本，否则 null */
  capacityNotice(): string | null {
    const text = this.indexText();
    const lines = text.split('\n').filter((l: string) => l.length > 0).length;
    const bytes = Buffer.byteLength(text, 'utf8');
    const nearLines = Math.floor(MEMORY_INDEX_MAX_LINES * NEAR_LIMIT_RATIO);
    const nearBytes = Math.floor(MEMORY_INDEX_MAX_BYTES * NEAR_LIMIT_RATIO);
    if (lines < nearLines && bytes < nearBytes) return null;
    return pick(
      `Memory index near limit: ${lines}/${MEMORY_INDEX_MAX_LINES} lines, ${bytes}/${MEMORY_INDEX_MAX_BYTES} bytes — consolidate entries or move detail into record bodies`,
      `记忆索引接近上限：${lines}/${MEMORY_INDEX_MAX_LINES} 行、${bytes}/${MEMORY_INDEX_MAX_BYTES} 字节——请合并条目或把细节挪进记录正文`,
    );
  }
```

顶部补 `import { pick } from '../../i18n';`。

- [ ] **Step 4: 跑绿灯**

Run: `npx tsc -p tsconfig.json && node --test dist/harness/memory/store.test.js 2>&1 | tail -8`
Expected: PASS（fail 0）

- [ ] **Step 5: 提交**

```bash
git add src/harness/memory/store.ts src/harness/memory/store.test.ts
git commit -m "feat(memory): M1 store 扩展——put 更新语义（同 slug 刷新 modified 不产 -2 副本）、modified ISO 时间戳、capacityNotice 近满提醒（两级容量）、子目录构造（子代理自有记忆）"
```

---

### Task 2: 记忆控制面解析（env + 缺省）+ learned 开关/上限驱动

> **用户裁决（2026-09-18）**：SUNSHINE.md 与 CLAUDE.md 同定位——项目规范、给模型的指令，**不承载键值配置**。故控制面只有两层：环境变量 > 缺省（外加会话内 `/memory on|off`，见 Task 8）。**不要给 SUNSHINE.md 增配置分区、不要读 SUNSHINE.md**。

**Files:**
- Create: `src/config/memory-config.ts`
- Modify: `src/harness/skills/learned.ts`（上限由入参驱动）
- Test: `src/config/memory-config.test.ts`（新建）、`src/harness/skills/learned.test.ts`（就近追加）

**Interfaces:**
- Consumes: 无
- Produces（后续任务依赖）:
  - `export interface MemoryConfig { autoMemory: boolean; learnedSkills: boolean; learnedSkillLimit: number }`
  - `export const DEFAULT_LEARNED_SKILL_LIMIT = 50;`
  - `export function resolveMemoryConfig(env?: NodeJS.ProcessEnv): MemoryConfig` —— 只读 env + 缺省；非法值装配期 fail-fast（抛错）
  - `LearnedSkillStore.settle(goal: string, reply: string, opts?: { limit?: number }): Result<string>`（`opts.limit` 缺省 `DEFAULT_LEARNED_SKILL_LIMIT`）

- [ ] **Step 1: 写红灯测试**

```ts
// src/config/memory-config.test.ts
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveMemoryConfig, DEFAULT_LEARNED_SKILL_LIMIT } from './memory-config';

const ORIG_CWD = process.cwd();

test('缺省：全开 + 上限 50', () => {
  const c = resolveMemoryConfig({});
  assert.equal(c.autoMemory, true);
  assert.equal(c.learnedSkills, true);
  assert.equal(c.learnedSkillLimit, DEFAULT_LEARNED_SKILL_LIMIT);
});

test('env 三键各自生效（关 / 关 / 配 12）', () => {
  const c = resolveMemoryConfig({ SUNSHINEX_AUTO_MEMORY: 'off', SUNSHINEX_LEARNED_SKILLS: 'off', SUNSHINEX_LEARNED_SKILL_LIMIT: '12' });
  assert.equal(c.autoMemory, false);
  assert.equal(c.learnedSkills, false);
  assert.equal(c.learnedSkillLimit, 12);
});

test('on/off 大小写与首尾空白容错', () => {
  assert.equal(resolveMemoryConfig({ SUNSHINEX_AUTO_MEMORY: ' OFF ' }).autoMemory, false);
  assert.equal(resolveMemoryConfig({ SUNSHINEX_AUTO_MEMORY: 'On' }).autoMemory, true);
  assert.equal(resolveMemoryConfig({ SUNSHINEX_LEARNED_SKILLS: 'False' }).learnedSkills, false);
});

test('上限上下界：1 与 1000 通过，0 / 1001 / abc 抛错', () => {
  assert.equal(resolveMemoryConfig({ SUNSHINEX_LEARNED_SKILL_LIMIT: '1' }).learnedSkillLimit, 1);
  assert.equal(resolveMemoryConfig({ SUNSHINEX_LEARNED_SKILL_LIMIT: '1000' }).learnedSkillLimit, 1000);
  assert.throws(() => resolveMemoryConfig({ SUNSHINEX_LEARNED_SKILL_LIMIT: '0' }), /learned_skill_limit/);
  assert.throws(() => resolveMemoryConfig({ SUNSHINEX_LEARNED_SKILL_LIMIT: '1001' }), /learned_skill_limit/);
  assert.throws(() => resolveMemoryConfig({ SUNSHINEX_LEARNED_SKILL_LIMIT: 'abc' }), /learned_skill_limit/);
});

test('开关非法值装配期 fail-fast', () => {
  assert.throws(() => resolveMemoryConfig({ SUNSHINEX_AUTO_MEMORY: 'maybe' }), /auto_memory/);
  assert.throws(() => resolveMemoryConfig({ SUNSHINEX_LEARNED_SKILLS: 'yes' }), /learned_skills/);
});

test('钉子：SUNSHINE.md 不参与配置（同 CLAUDE.md 定位）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memcfg-'));
  try {
    fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), ['## 记忆', 'auto_memory: off', 'learned_skill_limit: 3'].join('\n'));
    process.chdir(tmp); // 当前目录放一份"带配置的 SUNSHINE.md"，解析结果必须不受影响
    const c = resolveMemoryConfig({});
    assert.equal(c.autoMemory, true, 'SUNSHINE.md 分区不得进控制面');
    assert.equal(c.learnedSkillLimit, DEFAULT_LEARNED_SKILL_LIMIT);
  } finally {
    process.chdir(ORIG_CWD);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

```ts
// src/harness/skills/learned.test.ts 追加
test('settle 上限由 opts.limit 驱动（淘汰最旧至 limit 内）', () => {
  const root = mkRoot();
  const store = new LearnedSkillStore(root);
  for (let i = 0; i < 3; i += 1) assert.equal(store.settle(`goal ${i}`, `reply ${i}`, { limit: 3 }).ok, true);
  // 已达上限 3：第 4 次沉淀须淘汰最旧，目录内恒 ≤3
  assert.equal(store.settle('goal 4', 'reply 4', { limit: 3 }).ok, true);
  const dir = path.join(resolveDataDir(root), 'skills');
  assert.ok(fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory()).length <= 3);
});
```

- [ ] **Step 2: 跑红灯确认**

Run: `npx tsc -p tsconfig.json 2>&1 | tail -5; node --test dist/config/memory-config.test.js 2>&1 | tail -6`
Expected: FAIL（模块不存在 / `opts.limit` 未生效）

- [ ] **Step 3: 实现**

新建 `src/config/memory-config.ts`：

```ts
/**
 * 记忆控制面（规格 §7）解析单点：环境变量 > 缺省。
 * **不读 SUNSHINE.md**（2026-09-18 用户裁决）：该文件与 CLAUDE.md 同定位——项目规范、给模型的指令，不承载键值配置。
 * 非法值装配期 fail-fast（沿用 agents/MCP 装配纪律）——不做静默兜底，配置错误必须显式暴露。
 */
export interface MemoryConfig {
  /** 陈述性记忆总开关（不注入 / 不提取 / 不整理 / 写被拒，四处贯通） */
  autoMemory: boolean;
  /** 程序性记忆（技能沉淀）开关 */
  learnedSkills: boolean;
  /** 技能沉淀 FIFO 上限（替换旧硬编码 50） */
  learnedSkillLimit: number;
}

export const DEFAULT_LEARNED_SKILL_LIMIT = 50;


function onOff(key: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'on' || v === 'true') return true;
  if (v === 'off' || v === 'false') return false;
  throw new Error(`memory config: ${key} must be on|off, got "${raw}"`);
}

function limit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LEARNED_SKILL_LIMIT;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(n) || String(n) !== raw.trim() || n < 1 || n > 1000) {
    throw new Error(`memory config: learned_skill_limit must be an integer in 1..1000, got "${raw}"`);
  }
  return n;
}

/** 解析链：env（SUNSHINEX_AUTO_MEMORY / SUNSHINEX_LEARNED_SKILLS / SUNSHINEX_LEARNED_SKILL_LIMIT）> 缺省 */
export function resolveMemoryConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  return {
    autoMemory: onOff('auto_memory', env.SUNSHINEX_AUTO_MEMORY, true),
    learnedSkills: onOff('learned_skills', env.SUNSHINEX_LEARNED_SKILLS, true),
    learnedSkillLimit: limit(env.SUNSHINEX_LEARNED_SKILL_LIMIT),
  };
}
```

`src/harness/skills/learned.ts`：删除 `const MAX_LEARNED_SKILLS = 50;`（残渣清零），改：

```ts
import { DEFAULT_LEARNED_SKILL_LIMIT } from '../../config/memory-config';

  settle(goal: string, reply: string, opts?: { limit?: number }): Result<string> {
    ...
    this.evictOldest(dir, opts?.limit ?? DEFAULT_LEARNED_SKILL_LIMIT);
    ...

  /** 超上限按 mtime 升序删最旧，为本次沉淀腾出 1 个空位（limit 由控制面配置驱动） */
  private evictOldest(dir: string, limit: number): void {
```

（`evictOldest` 内部把原 `MAX_LEARNED_SKILLS` 引用改 `limit`。）

- [ ] **Step 4: 跑绿灯**

Run: `npx tsc -p tsconfig.json && node --test dist/config/memory-config.test.js dist/harness/skills/learned.test.js 2>&1 | tail -6`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/config/memory-config.ts src/config/memory-config.test.ts src/harness/skills/learned.ts src/harness/skills/learned.test.ts
git commit -m "feat(config): M2 记忆控制面解析（env > 缺省，非法值装配期 fail-fast；SUNSHINE.md 定位同 CLAUDE.md 不进配置）+ learned 上限由配置驱动（摘除硬编码 50）"
```

---

### Task 3: 记忆路径分类器 + 安全链写窄口（含子代理 scope 收窄）

**Files:**
- Create: `src/harness/memory/paths.ts`
- Modify: `src/harness/security/chain.ts`（`resolveSafe` 写分支 + 过时注释改写 + `withMemoryScope`）
- Test: `src/harness/memory/paths.test.ts`（新建）、`src/harness/security/chain.memorywrite.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 `resolveMemoryConfig`
- Produces（后续任务依赖）:
  - `export type MemoryScope = 'main' | \`agents/${string}\`;`
  - `export function isMemoryPath(dataDir: string, absPath: string, scope?: MemoryScope): 'main' | \`agents/${string}\` | null` —— 纯判定零 IO；`scope` 给出时**收窄**（子代理只可写自身 `agents/<id>/`）
  - `SafetyChain.memoryScope: MemoryScope | undefined`（public readonly）
  - `SafetyChain.withMemoryScope(scope: MemoryScope): SafetyChain` —— 派生克隆（依赖引用共享、仅 scope 收窄），原实例零突变

- [ ] **Step 1: 写红灯测试**

```ts
// src/harness/memory/paths.test.ts
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { isMemoryPath } from './paths';

const dataDir = path.join(path.sep, 'data');

test('主记忆目录直属文件 → main', () => {
  assert.equal(isMemoryPath(dataDir, path.join(dataDir, 'memory', 'a.md')), 'main');
  assert.equal(isMemoryPath(dataDir, path.join(dataDir, 'memory', 'MEMORY.md')), 'main');
});

test('非记忆路径 → null（数据目录其它子树与工作区）', () => {
  assert.equal(isMemoryPath(dataDir, path.join(dataDir, 'skills', 'a.md')), null);
  assert.equal(isMemoryPath(dataDir, path.join(dataDir, 'memory')), null, '目录本身不是记录');
  assert.equal(isMemoryPath(dataDir, path.join(dataDir, 'memoryx', 'a.md')), null, '同前缀不同目录不算');
});

test('子代理目录 → agents/<id>；scope 收窄后只放行自身', () => {
  const p = path.join(dataDir, 'memory', 'agents', 'reviewer', 'a.md');
  assert.equal(isMemoryPath(dataDir, p), 'agents/reviewer');
  assert.equal(isMemoryPath(dataDir, p, 'agents/reviewer'), 'agents/reviewer');
  assert.equal(isMemoryPath(dataDir, p, 'agents/other'), null);
  assert.equal(isMemoryPath(dataDir, path.join(dataDir, 'memory', 'a.md'), 'agents/reviewer'), null, 'scope 收窄时主目录被拒');
});
```

```ts
// src/harness/security/chain.memorywrite.test.ts
// 范式对齐既有 chain.datadir.test.ts：tmpdir 作 root、SUNSHINEX_DATA_DIR 重定向、finally 还原
test('write 落在 <dataDir>/memory/** → 放行（总开关开）', () => { /* eval('Write', { path: <dataDir>/memory/a.md }) → allowed */ });
test('write 落在数据目录其它子树 → 仍拒', () => { /* <dataDir>/skills/a.md → !allowed */ });
test('总开关 off → 记忆路径 write 被拒（只读放行不受影响）', () => { /* SUNSHINEX_AUTO_MEMORY=off */ });
test('read 记忆路径在开关 off 时仍放行（只读与开关无关）', () => {});
test('数据目录回退 root 内（<root>/.data）→ 记忆路径仍受总开关约束，非记忆路径不受影响', () => {
  // HOME 指向不可写路径使 resolveDataDir 回退；SUNSHINEX_DATA_DIR 必须清除
  // 断言：autoMemory 开 → <root>/.data/memory/a.md 写放行；关 → 同路径拒；两种开关下 <root>/other.md 均放行
});
test('isMemoryPath：相对 dataDir 亦按归一比对（两侧同归一口径）', () => {
  // chdir 到父目录，dataDir='.' 时 path.join('.', 'memory', 'a.md') 仍应判 'main'
});
test('memoryScope 收窄：子代理链只放行自身 agents/<id>', () => {
  const child = chain.withMemoryScope('agents/reviewer');
  assert.equal(child.evaluate('Write', { path: path.join(dataDir, 'memory', 'agents', 'reviewer', 'a.md') }).allowed, true);
  assert.equal(child.evaluate('Write', { path: path.join(dataDir, 'memory', 'a.md') }).allowed, false);
});
```

- [ ] **Step 2: 跑红灯确认**

Run: `npx tsc -p tsconfig.json 2>&1 | tail -3; node --test dist/harness/memory/paths.test.js dist/harness/security/chain.memorywrite.test.js 2>&1 | tail -6`
Expected: FAIL

- [ ] **Step 3: 实现**

新建 `src/harness/memory/paths.ts`：

```ts
/**
 * 记忆路径分类器（规格 §4.1，纯判定零 IO）：安全链判界与写入接缝共用单点，杜绝两处口径漂移。
 * 放在 memory/ 而非 security/——避免安全层反向依赖业务模块。
 * 入参 absPath 须为 realpath 归一后的真实路径（chain.resolveSafe 已保证），故此处不再处理 `..`/符号链接。
 * 两侧同归一（2026-09-18 审查裁决）：dataDir 亦过 `path.resolve`——相对 dataDir 此前会静默全拒（表现为记忆写面整体失效，方向安全但无提示）。
 */
import * as path from 'path';

export type MemoryScope = 'main' | `agents/${string}`;

export function isMemoryPath(dataDir: string, absPath: string, scope?: MemoryScope): 'main' | `agents/${string}` | null {
  const prefix = path.join(path.resolve(dataDir), 'memory') + path.sep;
  const abs = path.resolve(absPath);
  if (!abs.startsWith(prefix)) return null;
  const parts = abs.slice(prefix.length).split(path.sep);
  const [head, id] = parts;
  if (head === undefined || head === '') return null;
  if (head === 'agents') {
    if (!id || parts.length < 3) return null; // agents/ 目录本身与 agents/<id>/ 目录本身都不是记录
    const kind = `agents/${id}` as const;
    return scope === undefined || scope === kind ? kind : null;
  }
  // 主记忆目录直属文件：scope 收窄（子代理 fork）时拒绝
  return scope === undefined ? 'main' : null;
}
```

`src/harness/security/chain.ts`：

顶部补 import：

```ts
import { isMemoryPath, MemoryScope } from '../memory/paths';
import { resolveMemoryConfig } from '../../config/memory-config';
```

构造器增可选 scope：

```ts
  constructor(
    private guard: SecurityGuard,
    readonly backend: ToolBackend,
    private dryrun: DryRun,
    private readonly root: string,
    /** 记忆写 scope（规格 §4.2）：undefined=主链可写 memory/** 整子树；子代理 fork 传自身 agents/<id> 收窄 */
    readonly memoryScope?: MemoryScope,
  ) {
```

新增方法（置于 `resolveSafe` 之后）：

```ts
  /** 派生带记忆 scope 的克隆（子代理 fork 用）：其余依赖引用共享，仅 scope 收窄；原实例零突变 */
  withMemoryScope(scope: MemoryScope): SafetyChain {
    return new SafetyChain(this.guard, this.backend, this.dryrun, this.root, scope);
  }

  /** 记忆写入窄口（规格 §4.2）：仅 <dataDir>/memory/** 放行，且总开关开启；判定两侧同走 realpath 归一，符号链接逃逸仍被拒 */
  private memoryWriteAllowed(real: string): boolean {
    if (!resolveMemoryConfig().autoMemory) return false;
    return isMemoryPath(this.dataDirReal(), real, this.memoryScope) !== null;
  }

  /**
   * 数据目录真实路径：存在段逐级 realpathSync 归一（与 rootReal 同源策略），新建段字面拼接；归一失败按字面路径兜底。
   * underDataDir（只读判界）与 memoryWriteAllowed（写窄口）共用本单点，防两处口径漂移。
   * 用字面 resolveDataDir(root) 会与已归一的 real 口径错位——数据目录自身含符号链接段（macOS /var、HOME 经链接）时误拒合法写入。
   */
  private dataDirReal(): string {
    const dir = resolveDataDir(this.root);
    try {
      let anchor = dir;
      while (anchor.length > 1 && !fs.existsSync(anchor)) anchor = path.dirname(anchor);
      return fs.realpathSync(anchor) + dir.slice(anchor.length);
    } catch {
      return dir;
    }
  }
```

`resolveSafe` 分支改为（并**重写上方过时注释**——原注释「Write 维持拒绝……写面被拒，dataDir 内无法由模型植入链接」在本规格后不成立）：

```ts
  /**
   * 路径归一判界：存在段 realpathSync 解析符号链接，新建段字面拼接（resolve 产物无 .. 残留）；基准 rootReal；异常按拒绝处理不放行（spec 2.1 兜底条款）。
   * 数据目录白名单（auto memory 规格 D6 + 对齐规格 §4.2）：Read/Grep 访问 dataDir 子树放行（记忆索引/主题文件按需召回；Full trace/tool-outputs 同受益）；
   * Write 只在 <dataDir>/memory/** 放行（记忆写入窄口，总开关关闭即失效）——判定一律作用于 realpath 归一后的真实路径，符号链接逃逸被拒。
   */
  private resolveSafe(raw: unknown, tool: string): GuardDecision {
    try {
      const abs = path.resolve(this.root, String(raw ?? ''));
      let anchor = abs;
      while (!fs.existsSync(anchor)) anchor = path.dirname(anchor);
      const real = fs.realpathSync(anchor) + abs.slice(anchor.length);
      // 记忆写窄口**先于** root 内外分支判定（2026-09-18 审查裁决 Important 1）：数据目录回退 <root>/.data 布局（HOME 不可写）时
      // 记忆目录落在 root 内，若让 root 内全放行分支先短路，总开关对写面就失效了（规格把开关定义为「不注入/不提取/不整理/写被拒」四贯通）。
      // 命中记忆形态（含开关关闭）即在此定论，不再下探 root 全放行分支；非记忆路径的 root 内外语义保持原样。
      if (isMemoryPath(this.dataDirReal(), real) !== null) {
        return this.memoryWriteAllowed(real) ? { allowed: true, safePath: real } : { allowed: false, reason: `COMMAND_DENIED: 记忆写入被拒（总开关关闭或不在写 scope 内）：${real}` };
      }
      if (real !== this.rootReal && !real.startsWith(this.rootReal + path.sep)) {
        if (tool !== 'Write' && this.underDataDir(real)) return { allowed: true, safePath: real };
        return { allowed: false, reason: `COMMAND_DENIED: 路径越出项目 root（真实路径）：${real}` };
      }
      return { allowed: true, safePath: real };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { allowed: false, reason: `COMMAND_DENIED: 路径判界失败：${msg.slice(0, 120)}` };
    }
  }
```

- [ ] **Step 4: 跑绿灯**

Run: `npx tsc -p tsconfig.json && node --test dist/harness/memory/paths.test.js dist/harness/security/chain.memorywrite.test.js dist/harness/security/chain.datadir.test.js 2>&1 | tail -6`
Expected: PASS（既有 datadir 只读用例保持绿）

- [ ] **Step 5: 提交**

```bash
git add src/harness/memory/paths.ts src/harness/memory/paths.test.ts src/harness/security/chain.ts src/harness/security/chain.memorywrite.test.ts
git commit -m "feat(security): M3 记忆写窄口——isMemoryPath 分类器单点 + write 仅放行 <dataDir>/memory/**（总开关联动）+ withMemoryScope 子代理收窄；改写 resolveSafe 过时注释"
```

---

### Task 4: 记忆写入接缝 + `write` 执行器委派（原子工具零新增）

**Files:**
- Create: `src/harness/memory/writer.ts`
- Modify: `src/harness/tools/builtin.ts`（`write` 执行器 + 第 7 可选参）
- Modify: `src/harness/index.ts`（装配注入）
- Test: `src/harness/memory/writer.test.ts`（新建）、`src/harness/tools/builtin.memorywrite.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `MemoryStore.put/capacityNotice`、Task 2 `resolveMemoryConfig`、Task 3 `isMemoryPath/MemoryScope`、既有 `scanMemoryText`（memory/extractor.ts）
- Produces（后续任务依赖）:
  - `export interface MemoryWriteRequest { root: string; absPath: string; content: string; scope?: MemoryScope; write: (absPath: string, content: string) => void }`
  - `export interface MemoryWriteOutcome { slug: string; kind: 'main' | \`agents/${string}\`; observation: string }`
  - `export function guardMemoryWrite(req: MemoryWriteRequest): Result<MemoryWriteOutcome | 'pass'>` —— `'pass'` 表示「非记忆路径，交回常规写入」
  - `export type MemoryWriteSeam = (req: MemoryWriteRequest) => Result<MemoryWriteOutcome | 'pass'>;`
  - `builtinTools(safety, root, kb?, webSearch?, archive?, skills?, memory?: MemoryWriteSeam)` —— 第 7 可选参；**未注入＝旧行为逐字节不变**

- [ ] **Step 1: 写红灯测试**

```ts
// src/harness/memory/writer.test.ts
// 每用例 tmpdir 作 root + SUNSHINEX_DATA_DIR 重定向 + finally 还原（既有范式）
const write = (p: string, c: string) => fs.mkdirSync(path.dirname(p), { recursive: true }) || fs.writeFileSync(p, c);
const req = (over: Partial<MemoryWriteRequest>) => ({
  root, absPath: path.join(resolveDataDir(root), 'memory', 'prefers-pnpm.md'),
  content: ['---', 'type: project', 'description: repo uses pnpm', '---', 'use pnpm only', ''].join('\n'),
  write, ...over,
});

test('正常写入：落盘规范化四键 frontmatter（含 modified）+ 索引重建 + 回执含 slug', () => {
  const r = guardMemoryWrite(req({}));
  assert.equal(r.ok, true);
  if (!r.ok || r.value === 'pass') return assert.fail('expected outcome');
  assert.equal(r.value.slug, 'prefers-pnpm');
  const raw = fs.readFileSync(path.join(resolveDataDir(root), 'memory', 'prefers-pnpm.md'), 'utf8');
  assert.match(raw, /^---\ntype: project\ncreated: \d{4}-\d{2}-\d{2}\nmodified: \d{4}-\d{2}-\d{2}T/);
  assert.match(r.value.observation, /prefers-pnpm/);
});

test('六个拒绝分支各一用例：非 .md / MEMORY.md / 非法 slug / 临时词 / 缺 frontmatter / 缺 description', () => {});

test('非记忆路径 → pass（交回常规写入，不产生任何记忆副作用）', () => {
  const r = guardMemoryWrite(req({ absPath: path.join(root, 'src', 'a.ts') }));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, 'pass');
  assert.equal(fs.existsSync(path.join(resolveDataDir(root), 'memory', 'MEMORY.md')), false, '零副作用');
});

test('同 slug 二次写入＝更新（不产 -2 副本）', () => {
  guardMemoryWrite(req({}));
  guardMemoryWrite(req({ content: ['---', 'type: project', 'description: repo uses pnpm', '---', 'use pnpm, never npm', ''].join('\n') }));
  const dir = path.join(resolveDataDir(root), 'memory');
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md').length, 1);
});

test('超限：落盘成功但回执带勒令精简错误文本（CC 语义）', () => {});
test('近满：回执追加 capacityNotice 提醒', () => {});
```

```ts
// src/harness/tools/builtin.memorywrite.test.ts
test('注入接缝：write 记忆路径走接缝（观察行含 Saved memory），未注入接缝＝旧行为（观察行 written）', () => {});
test('注入接缝但不含 memory 依赖的既有工具行为不变（read/grep 回归）', () => {});
```

- [ ] **Step 2: 跑红灯确认**

Run: `npx tsc -p tsconfig.json 2>&1 | tail -3; node --test dist/harness/memory/writer.test.js 2>&1 | tail -6`
Expected: FAIL

- [ ] **Step 3: 实现**

新建 `src/harness/memory/writer.ts`：

```ts
/**
 * 记忆写入接缝（规格 §4.3，原子工具路径的唯一权威）：模型经既有 `write` 工具写 <dataDir>/memory/** 时的校验→落盘→规范化→重建索引→容量回执单点。
 * 校验先于写入（不落盘即无需回滚）；落盘经调用方传入的 write 回调（走既有 ToolBackend 抽象，不绕过后端接缝）。
 */
import * as path from 'path';
import { pick } from '../../i18n';
import { Result, ok, fail } from '../../result';
import { resolveDataDir } from '../../config/data-dir';
import { MemoryStore, MemoryType, slugifyMemory } from './store';
import { scanMemoryText } from './extractor';
import { isMemoryPath, MemoryScope } from './paths';

const INDEX_NAME = 'MEMORY.md';
const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];

export interface MemoryWriteRequest {
  root: string;
  absPath: string;
  content: string;
  scope?: MemoryScope;
  /** 落盘回调（builtin 传 backend.writeFile）：接缝负责顺序与校验，落盘走后端接缝 */
  write: (absPath: string, content: string) => void;
}

export interface MemoryWriteOutcome {
  slug: string;
  kind: 'main' | `agents/${string}`;
  observation: string;
}

export type MemoryWriteSeam = (req: MemoryWriteRequest) => Result<MemoryWriteOutcome | 'pass'>;

/** 窄 frontmatter 解析（记忆记录四键；无 frontmatter 返回 null） */
function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } | null {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(md);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

export function guardMemoryWrite(req: MemoryWriteRequest): Result<MemoryWriteOutcome | 'pass'> {
  const dataDir = resolveDataDir(req.root);
  const kind = isMemoryPath(dataDir, req.absPath, req.scope);
  if (kind === null) return ok('pass'); // 非记忆路径：交回常规写入

  const name = path.basename(req.absPath);
  if (!name.endsWith('.md')) {
    return fail('MEMORY_WRITE_EXT', pick('Memory records must be .md files', '记忆记录必须是 .md 文件'));
  }
  if (name === INDEX_NAME) {
    return fail(
      'MEMORY_WRITE_INDEX',
      pick(
        'MEMORY.md is a derived index — write one record file per fact instead (delete or merge records to shrink it)',
        'MEMORY.md 是派生索引——请每条事实写一个记录文件（要精简就删或合并记录）',
      ),
    );
  }
  const slug = name.slice(0, -3);
  if (slug.length === 0 || slugifyMemory(slug) !== slug) {
    return fail(
      'MEMORY_WRITE_SLUG',
      pick(`Record file name must be a canonical slug (got "${slug}"; e.g. "prefers-pnpm")`, `记录文件名必须是规范化 slug（当前 "${slug}"；形如 "prefers-pnpm"）`),
    );
  }
  const flagged = scanMemoryText(req.content);
  if (flagged) {
    return fail(
      'MEMORY_WRITE_SCAN',
      pick(`Rejected: session-scoped or unsafe content (${flagged}); nothing written`, `已拒绝：会话性内容或含注入特征（${flagged}），未写入`),
    );
  }
  const parsed = parseFrontmatter(req.content);
  if (parsed === null) {
    return fail(
      'MEMORY_WRITE_FRONTMATTER',
      pick('Record must start with YAML frontmatter: type, description', '记录必须以 YAML frontmatter 开头：type、description'),
    );
  }
  const type = parsed.meta.type as MemoryType | undefined;
  if (type === undefined || !MEMORY_TYPES.includes(type)) {
    return fail(
      'MEMORY_WRITE_TYPE',
      pick(`frontmatter type must be one of ${MEMORY_TYPES.join('|')}`, `frontmatter type 必须是 ${MEMORY_TYPES.join('|')} 之一`),
    );
  }
  const description = (parsed.meta.description ?? '').trim();
  if (!description) {
    return fail('MEMORY_WRITE_DESCRIPTION', pick('frontmatter description is required', 'frontmatter 缺少 description'));
  }
  const body = parsed.body.trim();
  if (!body) return fail('MEMORY_WRITE_BODY', pick('Record body is empty', '记录正文为空'));

  const subdir = kind === 'main' ? undefined : kind;
  const store = new MemoryStore(req.root, subdir === undefined ? undefined : { subdir });
  const existing = store.list().find((r) => r.slug === slug);
  const put = store.put({
    slug,
    type,
    description,
    body,
    ...(existing ? { created: existing.created } : {}),
    modified: new Date().toISOString(),
  });
  if (!put.ok) return fail(put.error.code, put.error.message);

  const lines = store.indexText().split('\n').filter((l) => l.length > 0).length;
  const near = store.capacityNotice();
  const observation = [
    pick(`Saved memory: ${slug} [${type}] — ${lines}/${200} index lines`, `已保存记忆：${slug} [${type}] — 索引 ${lines}/200 行`),
    ...(near !== null ? [near] : []),
  ].join('\n');
  return ok({ slug, kind, observation });
}
```

`src/harness/tools/builtin.ts`：

顶部补 import：

```ts
import { MemoryWriteSeam } from '../memory/writer';
```

签名加第 7 参数：

```ts
export function builtinTools(safety: SafetyChain, root: string, kb?: KnowledgeBase, webSearch?: WebSearchProvider, archive?: ToolOutputArchive, skills?: SkillsFacade, memory?: MemoryWriteSeam): RegisteredTool[] {
```

`write` 执行器改为：

```ts
      executor: async (input: ToolInput) => {
        const p = String(input.path);
        const content = String(input.content ?? '');
        // 记忆写入接缝（规格 §4.4）：命中记忆路径走接缝（校验/规范化/索引/容量回执）；未注入接缝＝旧行为
        if (memory) {
          const r = memory({
            root,
            absPath: p,
            content,
            ...(safety.memoryScope !== undefined ? { scope: safety.memoryScope } : {}),
            write: (abs, c) => backend.writeFile(abs, c),
          });
          if (!r.ok) throw new CodedToolError(r.error.code, r.error.message);
          if (r.value !== 'pass') return execOut(r.value.observation);
        }
        backend.writeFile(p, content);
        return execOut('written');
      },
```

`src/harness/index.ts` 装配：

```ts
import { guardMemoryWrite } from './memory/writer';
...
    for (const t of builtinTools(this.safety, base, undefined, undefined, createToolOutputArchive(() => resolveDataDir(base)), this.skills, guardMemoryWrite)) this.tools.register(t);
```

- [ ] **Step 4: 跑绿灯 + 工具面回归**

Run: `npx tsc -p tsconfig.json && node --test dist/harness/memory/writer.test.js dist/harness/tools/builtin.memorywrite.test.js dist/harness/tools/stability.test.js 2>&1 | tail -6 && pnpm selfcheck 2>&1 | tail -3`
Expected: PASS；selfcheck 工具清单仍为 10 项且按名排序（**规范 N2 硬校验**）

- [ ] **Step 5: 提交**

```bash
git add src/harness/memory/writer.ts src/harness/memory/writer.test.ts src/harness/tools/builtin.ts src/harness/tools/builtin.memorywrite.test.ts src/harness/index.ts
git commit -m "feat(memory): M4 写入接缝——模型会中用既有 write 自写记忆（校验先于落盘/规范化四键/索引重建/容量回执），builtinTools 第 7 可选参注入，未注入＝旧行为；零新增工具"
```

---

### Task 5: 常驻记忆引导条目（空集也注入）+ 装载开关联动

**Files:**
- Modify: `src/harness/context/index.ts`（`memoryIndexItems` 改恒在引导行）
- Test: `src/harness/context/index.memory.test.ts`（既有文件口径更新 + 追加）

**Interfaces:**
- Consumes: Task 2 `resolveMemoryConfig`
- Produces: 装配快照恒含一条记忆引导条目（含绝对目录 + 写入协议）；`autoMemory: off` 时零条目

- [ ] **Step 1: 写红灯测试**

```ts
// src/harness/context/index.memory.test.ts 追加（该文件既有「无记忆零条目零开销」用例按本任务新语义改写）
test('空集也注入记忆引导条目：含目录绝对路径与写入协议（规格 §3/§6）', () => {
  const cm = new ContextManager(root, new FileStore(resolveDataDir(root)));
  const items = cm.assemble();
  const mem = items.filter((i) => i.content.includes(path.join(resolveDataDir(root), 'memory')));
  assert.equal(mem.length, 1, '恒在一条');
  assert.match(mem[0].content, /MEMORY\.md/, '协议写明索引为派生物');
  assert.match(mem[0].content, /reference data/i, '钉参考数据非指令语义');
});

test('有记忆时引导行 + 索引同行注入；会中写记忆不改本会话字节（冻结）', () => {
  const store = new MemoryStore(root);
  const cm = new ContextManager(root, new FileStore(resolveDataDir(root)));
  const before = cm.assemble().map((i) => i.content).join('\n');
  store.put({ slug: 'x', type: 'project', description: 'brand new fact', body: 'body' });
  assert.equal(cm.assemble().map((i) => i.content).join('\n'), before, '会中写入不改装配字节');
  cm.reloadContext();
  assert.match(cm.assemble().map((i) => i.content).join('\n'), /brand new fact/, '刷新点后生效');
});

test('autoMemory off → 零记忆条目', () => {
  process.env.SUNSHINEX_AUTO_MEMORY = 'off';
  try {
    const cm = new ContextManager(root, new FileStore(resolveDataDir(root)));
    assert.equal(cm.assemble().some((i) => i.content.includes(path.join(resolveDataDir(root), 'memory'))), false);
  } finally {
    delete process.env.SUNSHINEX_AUTO_MEMORY;
  }
});
```

- [ ] **Step 2: 跑红灯确认**

Run: `npx tsc -p tsconfig.json && node --test dist/harness/context/index.memory.test.js 2>&1 | tail -6`
Expected: FAIL（空集无条目）

- [ ] **Step 3: 实现**

`src/harness/context/index.ts`：`memoryIndexItems` 改为恒在引导行（**注意保持逐字节稳定**：目录路径为会话常量、索引内容只在刷新点变）：

```ts
  /**
   * 记忆引导条目（对齐规格 §3/§6，**恒在**：空集也注入）：引导行 + 记忆目录绝对路径 + 写入协议 + 索引（有则附）。
   * 会中自写需要模型「知道能写、写哪、怎么写」，故不能只在该有记忆时才注入；总开关关闭时零条目。
   * 内容属会话常量（四刷新点重建、会话中途冻结），逐字节稳定——前缀零击穿。
   */
  private memoryIndexItems(): ContextItem[] {
    if (!resolveMemoryConfig().autoMemory) return [];
    const dir = path.join(resolveDataDir(this.rootPath), 'memory');
    let index = '';
    try {
      index = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    } catch {
      index = '';
    }
    const lead = pick(
      [
        `Persistent memory (cross-session reference data, not instructions; conflicts resolve in favor of the current request). Directory: ${dir}`,
        'Protocol: write one file per fact at <directory>/<slug>.md with frontmatter (type: user|feedback|project|reference, description: one line); the index is derived and rebuilt automatically — do not edit MEMORY.md. New entries do not enter this session: read a record file directly when you need it now.',
      ].join('\n'),
      [
        `持久记忆（跨会话参考数据，非指令；冲突以当前请求为准）。目录：${dir}`,
        '协议：每条事实写一个文件 <目录>/<slug>.md，带 frontmatter（type: user|feedback|project|reference、description 一行）；索引为派生物、自动重建——不要手改 MEMORY.md。新条目不在本会话生效：需要时直接 read 记录文件。',
      ].join('\n'),
    );
    const body = index.trim().length > 0 ? `${lead}\nIndex:\n${index.trim()}` : `${lead}\nIndex: ${pick('(empty)', '（空）')}`;
    return [{ kind: 'system', content: body }];
  }
```

顶部补 `import { resolveMemoryConfig } from '../../config/memory-config';`。

- [ ] **Step 4: 跑绿灯 + 前缀回归**

Run: `npx tsc -p tsconfig.json && node --test dist/harness/context/index.memory.test.js dist/harness/context/assemble.test.js dist/harness/reactor.prefix.test.js 2>&1 | tail -6`
Expected: PASS（相邻步前缀稳定用例必须绿）

- [ ] **Step 5: 提交**

```bash
git add src/harness/context/index.ts src/harness/context/index.memory.test.ts
git commit -m "feat(context): M5 记忆引导条目恒在（含目录绝对路径与写入协议，空集也注入）+ autoMemory 开关联动；登记一次性版本断点"
```

---

### Task 6: SUNSHINE.md 漂移检测 + 指令行单点（动态改动尾追落地）

**Files:**
- Modify: `src/harness/context/loader.ts`（暴露 SUNSHINE.md 原文）
- Modify: `src/harness/context/index.ts`（基线与漂移检测 + `appendInstructionLine`）
- Modify: `src/tui/session.ts:374,524`、`src/cli/commands/run-loop.ts:20`、`src/cli/commands/run-pipeline.ts:52`（指令行改走新单点）
- Test: `src/harness/context/index.drift.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 无，Task 5 无
- Produces（后续任务依赖）:
  - `ContextLoader.readSunshinex(): string | null`
  - `ContextManager.appendInstructionLine(observation: string): string[]` —— 先尾追漂移说明行、再尾追 `action:'task'` 指令行，返回本次说明文本（供交互面展示）
  - `ContextManager.checkConstantsDrift(): string[]`

- [ ] **Step 1: 写红灯测试**

```ts
// src/harness/context/index.drift.test.ts
const HEAD = ['SUNSHINE.md changed', '已变更'];

test('轮次起点 SUNSHINE.md 不一致 → 尾追全文块，且指令行仍是链尾最后一行', () => {
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'rule A\n');
  const cm = new ContextManager(root, new FileStore(resolveDataDir(root)));
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'rule A\nrule B\n');
  const notices = cm.appendInstructionLine('Current instruction: do X');
  assert.equal(notices.length, 1);
  assert.ok(HEAD.some((h) => notices[0].startsWith(h)), '说明行以变更头开始');
  assert.match(notices[0], /rule B/, '承载最新磁盘全文');
  const chain = cm.chainView();
  assert.equal(chain[chain.length - 1].observation, 'Current instruction: do X', '指令恒为链尾最后一行');
  assert.equal(chain[chain.length - 2].action, 'notice', '说明行紧邻其前');
});

test('同一变更只尾追一次（baseline 前进），再改再追', () => {
  const cm = new ContextManager(root, new FileStore(resolveDataDir(root)));
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'v2\n');
  assert.equal(cm.appendInstructionLine('t1').length, 1);
  assert.equal(cm.appendInstructionLine('t2').length, 0, '未再改不重复');
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'v3\n');
  assert.equal(cm.appendInstructionLine('t3').length, 1);
});

test('超 4096 字符截断 + read 指针', () => {
  const cm = new ContextManager(root, new FileStore(resolveDataDir(root)));
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), `start\n${'x'.repeat(5000)}\n`);
  const [notice] = cm.appendInstructionLine('t');
  assert.ok(notice.length < 5000, '已截断');
  assert.match(notice, /read .*SUNSHINE\.md/, '含 read 指针');
});

test('技能清单新增 → 尾追一行（正文不进上下文）', () => {
  const cm = new ContextManager(root, new FileStore(resolveDataDir(root)));
  const dir = path.join(root, '.sunshinex', 'skills', 'newone');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), ['---', 'name: New One', 'description: brand new skill', '---', 'body', ''].join('\n'));
  const notices = cm.appendInstructionLine('t');
  assert.equal(notices.filter((n) => n.includes('newone')).length, 1);
});

test('reloadContext 后基线重置：快照已是最新，不再重复尾追', () => {
  const cm = new ContextManager(root, new FileStore(resolveDataDir(root)));
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'v2\n');
  assert.equal(cm.appendInstructionLine('t1').length, 1);
  cm.reloadContext();
  assert.equal(cm.appendInstructionLine('t2').length, 0);
});

test('前缀不变量：变更后相邻帧仅尾部新增（断言 contextSnapshot 首条字节不变）', () => {
  const cm = new ContextManager(root, new FileStore(resolveDataDir(root)));
  const head = cm.assemble([])[0].content;
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'v2\n');
  cm.appendInstructionLine('t');
  assert.equal(cm.assemble([])[0].content, head, '前置段首条字节不变');
});
```

- [ ] **Step 2: 跑红灯确认**

Run: `npx tsc -p tsconfig.json 2>&1 | tail -3; node --test dist/harness/context/index.drift.test.js 2>&1 | tail -6`
Expected: FAIL（`appendInstructionLine` 未定义）

- [ ] **Step 3: 实现**

`src/harness/context/loader.ts` 增：

```ts
  /** SUNSHINE.md 原始文本（漂移检测基线/比对用；不存在返回 null） */
  readSunshinex(): string | null {
    try {
      return fs.readFileSync(path.join(this.root, 'SUNSHINE.md'), 'utf8');
    } catch {
      return null;
    }
  }
```

`src/harness/context/index.ts` 增字段与刷新点捕获：

```ts
  /** 动态改动尾追基线（规范 N1 / 规格 §9.2）：刷新点捕获，会话中途与磁盘比对不一致即尾追变更说明 */
  private sunshinexBaseline: string | null = null;
  private skillsBaseline = '';

  /** 刷新点基线捕获（构造/reloadContext 共用单点） */
  private captureBaselines(): void {
    this.sunshinexBaseline = this.loader.readSunshinex();
    this.skillsBaseline = skillIds(this.rootPath);
  }
```

构造器与 `reloadContext` 末尾各加 `this.captureBaselines();`；文件底部（模块级）加：

```ts
/** 技能 id 集（排序后 join，跨环境逐字节稳定）：漂移比对用 */
function skillIds(root: string): string {
  return loadSkills(root)
    .map((m) => m.id)
    .sort()
    .join('\n');
}

const DRIFT_MAX_CHARS = 4096;
```

`ContextManager` 增方法：

```ts
  /**
   * 会话常量漂移检测（规范 N1 / 规格 §9.2，确定性零模型调用）：读盘比对基线，返回应尾追的说明行文本；
   * 基线随之上进（同一变更只告知一次），刷新点由 captureBaselines 重置。
   */
  checkConstantsDrift(): string[] {
    const out: string[] = [];
    const current = this.loader.readSunshinex();
    if (current !== this.sunshinexBaseline) {
      const full = path.join(this.rootPath, 'SUNSHINE.md');
      const text =
        current === null
          ? pick('(SUNSHINE.md is gone)', '（SUNSHINE.md 已不存在）')
          : current.length > DRIFT_MAX_CHARS
            ? `${current.slice(0, DRIFT_MAX_CHARS)}\n${pick(`…(truncated) — read ${full} for the rest`, `…（已截断）——其余内容请 read ${full}`)}`
            : current;
      out.push(
        [
          pick(
            'SUNSHINE.md changed (the session snapshot is stale; the text below is authoritative until the next refresh point):',
            'SUNSHINE.md 已变更（会话快照为旧版；以下最新磁盘内容在下次刷新点前为准）：',
          ),
          text,
        ].join('\n'),
      );
      this.sunshinexBaseline = current;
    }
    const ids = skillIds(this.rootPath);
    if (ids !== this.skillsBaseline) {
      const before = new Set(this.skillsBaseline.split('\n').filter((s) => s.length > 0));
      const added = ids.split('\n').filter((s) => s.length > 0 && !before.has(s));
      if (added.length > 0) {
        out.push(
          pick(
            `[skills] added: ${added.join(', ')} — load with the skill tool`,
            `[技能] 新增：${added.join(', ')}——用 skill 工具加载`,
          ),
        );
      }
      this.skillsBaseline = ids;
    }
    return out;
  }

  /** 指令行单点（规范 N1 / 规格 §9.1）：先尾追会话常量漂移说明，再尾追任务指令行——指令恒为链尾最后一行。
   *  返回本次说明文本（交互面据此落用户可见回执）。所有指令行落点统一走此处，杜绝多调用处漂移。 */
  appendInstructionLine(observation: string): string[] {
    const notices = this.checkConstantsDrift();
    for (const n of notices) this.appendChain([{ action: 'notice', observation: n }]);
    this.appendChain([{ action: 'task', observation }]);
    return notices;
  }
```

四个调用点改为走单点（**逐文件串行编辑**）：

- `src/tui/session.ts:374`：`ctx.appendChain([{ action: 'task', observation: t(\`Current instruction: ${items[i]}\`, \`当前指令：${items[i]}\`) }]);` → `ctx.appendInstructionLine(t(\`Current instruction: ${items[i]}\`, \`当前指令：${items[i]}\`));`
- `src/tui/session.ts:524`：同上形式替换。
- `src/cli/commands/run-loop.ts:20`：`deps.context.appendChain([{ action: 'task', observation: goal }]);` → `deps.context.appendInstructionLine(goal);`
- `src/cli/commands/run-pipeline.ts:52`：同上。

- [ ] **Step 4: 跑绿灯 + 前缀回归（跨层）**

Run: `npx tsc -p tsconfig.json && node --test dist/harness/context/index.drift.test.js dist/harness/reactor.prefix.test.js dist/harness/subagent.test.js dist/graph/agents.test.js dist/tui/session.plan.test.js 2>&1 | tail -8`
Expected: PASS（**必绿**：`subagent.test.ts:127`「Runner fork 组装：子首帧 = 主链严格前缀 + 尾追」、`graph/agents.test.ts:106`「fork 首帧 = 主链末帧严格前缀 + 尾追」、`reactor.prefix.test.ts:47`「相邻步严格前缀连续」、`session.plan.test.ts:244` 相邻步严格逐字节前缀）

- [ ] **Step 5: 提交**

```bash
git add src/harness/context/loader.ts src/harness/context/index.ts src/harness/context/index.drift.test.ts src/tui/session.ts src/cli/commands/run-loop.ts src/cli/commands/run-pipeline.ts
git commit -m "feat(context): M6 动态改动尾追落地——SUNSHINE.md 轮次起点漂移检测（不一致尾追最新全文块，超 4KB 截断+read 指针）、技能清单增量告知、appendInstructionLine 单点统一四处指令行（指令恒为链尾末行）"
```

---

### Task 7: 子代理自有记忆（独立目录 + fork 私有尾块 + scope 收窄）

**Files:**
- Modify: `src/harness/subagent.ts`（`AgentDef.memory` / frontmatter 解析 / fork 组装插行 / scope 派生 / 装配根注入）
- Modify: `src/harness/index.ts`（`HarnessOptions.memoryConfig` 透传）
- Test: `src/harness/subagent.memory.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `MemoryStore(root, { subdir })`、Task 3 `SafetyChain.withMemoryScope`
- Produces:
  - `AgentDef.memory?: boolean`；`parseAgentFrontmatter(md)` 返回增 `memory: boolean`
  - fork 组装在 `roleLine` 与 `taskLine` 之间插入 `{ action: 'memory', observation: <自有记忆索引行> }`（仅当该 agent 声明 `memory: true`）

- [ ] **Step 1: 写红灯测试**

```ts
// src/harness/subagent.memory.test.ts
test('agent.md memory:true → fork 私有尾块含自有记忆索引，主链零污染', async () => {
  // agents/reviewer/agent.md 带 memory: true；预置 <dataDir>/memory/agents/reviewer/r1.md
  // runner.runSubagent({ agent_id: 'reviewer', prompt: 'x' }) → ok
  // 断言：child seed 含 action 'memory' 行（经 capture 的 context 或事件面）；主链 chainView() 零新增 'memory' 行
});

test('未声明 memory 的 agent → 无记忆行、无目录', () => {});

test('子代理写入 scope 收窄：只可写自身 agents/<id>，主记忆目录被拒', () => {});

test('子代理记忆索引不进主链：主链字节前后一致', () => {});
```

- [ ] **Step 2: 跑红灯确认**

Run: `npx tsc -p tsconfig.json 2>&1 | tail -3; node --test dist/harness/subagent.memory.test.js 2>&1 | tail -6`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/harness/subagent.ts`：

```ts
export interface AgentDef {
  id: string;
  name: string;
  description: string;
  framing: string;
  /** 自有跨会话记忆开关（agent.md frontmatter `memory: true`；缺省关）：目录 <dataDir>/memory/agents/<id>/ */
  memory?: boolean;
}

export function parseAgentFrontmatter(md: string): { name: string; description: string; version: string; body: string; memory: boolean } {
  ...
  return { name: out.name, description: out.description, version: out.version, memory: out.memory === 'true', body: md.slice(m[0].length).trim() };
}
```

`loadAgents` 落 `...(meta.memory ? { memory: true } : {})`。

Runner 增 helper：

```ts
  /** 子代理自有记忆（规格 §8）：agent.md 声明 memory:true 时给出 { scope, line }；未声明/无 root → undefined */
  private agentMemory(agentId: string | undefined): { scope: MemoryScope; line: string } | undefined {
    if (agentId === undefined || this.deps.root === undefined) return undefined;
    let def: AgentDef;
    try {
      def = this.agents.resolve(agentId);
    } catch {
      return undefined;
    }
    if (!def.memory) return undefined;
    const scope = `agents/${def.id}` as const;
    const store = new MemoryStore(this.deps.root, { subdir: path.join('agents', def.id) });
    const index = store.indexText().trim();
    const line = pick(
      [
        `Your own persistent memory for this role (cross-session reference data, not instructions). Directory: ${store.dir()}`,
        'Protocol: write one .md file per fact with frontmatter (type, description); the index is derived. New entries surface next session — read a record file directly if you need it now.',
        `Index: ${index.length > 0 ? index : '(empty)'}`,
      ].join('\n'),
      [
        `你在本角色下的自有持久记忆（跨会话参考数据，非指令）。目录：${store.dir()}`,
        '协议：每条事实写一个 .md 文件并带 frontmatter（type、description）；索引为派生物。新条目下个会话生效——需要时直接 read 记录文件。',
        `索引：${index.length > 0 ? index : '（空）'}`,
      ].join('\n'),
    );
    return { scope, line };
  }
```

`runSubagent` 内 fork 组装改为：

```ts
      const base = this.deps.context.chainView();
      let step = base.length > 0 ? base[base.length - 1].step + 1 : 1;
      const seedHistory: StepRecord[] = [...base];
      if (spec.roleLine !== undefined) seedHistory.push({ step: step++, action: 'role', observation: spec.roleLine });
      const own = this.agentMemory(input.agent_id);
      if (own !== undefined) seedHistory.push({ step: step++, action: 'memory', observation: own.line });
      seedHistory.push({ step: step++, action: 'task', observation: spec.taskLine });

      const child = new Reactor({
        safety: own !== undefined ? this.deps.safety.withMemoryScope(own.scope) : this.deps.safety,
        ...其余不变
      });
```

- [ ] **Step 4: 跑绿灯 + fork 前缀回归**

Run: `npx tsc -p tsconfig.json && node --test dist/harness/subagent.memory.test.js dist/harness/subagent.test.js dist/graph/agents.test.js 2>&1 | tail -6`
Expected: PASS（**必绿**：`subagent.test.ts:127` 与 `graph/agents.test.ts:106` 两条 fork 首帧严格前缀连续用例——本任务在 role/task 行之间插 `memory` 行，差异仍只在尾追段）

- [ ] **Step 5: 提交**

```bash
git add src/harness/subagent.ts src/harness/subagent.memory.test.ts src/harness/index.ts
git commit -m "feat(subagent): M7 子代理自有记忆——agent.md memory:true 声明独立目录 memory/agents/<id>、索引走 fork 私有尾块（主链零污染）、写入 scope 收窄 to 自身目录"
```

---

### Task 8: 会话内可见性（链尾说明行 + notice 回执 + `/memory on|off`）+ 文档同步

**Files:**
- Modify: `src/harness/memory/extractor.ts`（`settleMemory` 返回新增 slug 列表）
- Modify: `src/harness/reactor.ts`（settle 单点尾追说明行 + notice 事件）
- Modify: `src/types.ts`（`SessionEventType` 增 `'notice'`）
- Modify: `src/harness/index.ts`（settle/settleMemory 返回说明行）
- Modify: `src/tui/session.ts`（notice 事件渲染 + `/memory on|off`）
- Modify: `TUI-MANUAL.md`、`README.md`
- Test: `src/harness/reactor.notice.test.ts`（新建）、`src/tui/session.memory-toggle.test.ts`（新建）

**Interfaces:**
- Consumes: 全部前序任务
- Produces:
  - `settleMemory(...): Promise<string[]>`（新增记忆 slug）
  - `ReactorDeps.settle?: (r) => string | void | Promise<string | void>`、`settleMemory?: (r) => string | void | Promise<string | void>`
  - `SessionEventType` 增 `'notice'`；payload `{ source: 'memory' | 'skills' | 'sunshine-md', text: string }`
  - `/memory on|off`（会话内切换，不落盘）

- [ ] **Step 1: 写红灯测试**

```ts
// src/harness/reactor.notice.test.ts
test('settle 返回说明行 → 链尾追加 action:notice 行 + 发 notice 事件（用户面）', () => {});
test('settle 抛错 → 链路照常收口（旁路纪律），无 notice 行倒灌失败', () => {});
test('settle 返回 undefined → 不追加任何行（无产出零噪音）', () => {});
```

```ts
// src/tui/session.memory-toggle.test.ts
test('/memory off → 会话内关闭（不落盘 SUNSHINE.md），/memory 列表回执含当前状态', () => {});
test('/memory on 恢复；任务运行中拒绝', () => {});
```

- [ ] **Step 2: 跑红灯确认**

- [ ] **Step 3: 实现**

`extractor.ts`：`settleMemory(opts): Promise<string[]>`；每成功落盘一条即 `saved.push(record.slug)`；函数体全程 `try/catch` 兜底返回 `saved`（旁路纪律）。

`reactor.ts`：

```ts
  settle?: (r: { goal: string; reply: string }) => string | void | Promise<string | void>;
  settleMemory?: (r: { goal: string; reply: string }) => string | void | Promise<string | void>;
```

```ts
    // 收口说明行（规格 §9.4）：记忆/技能产出尾追为链尾 notice 行（模型面）+ notice 事件（用户面）；任何失败都不倒灌任务成败
    const announce = (source: 'memory' | 'skills', text: string): void => {
      this.deps.context.appendChain([{ action: 'notice', observation: text }]);
      this.deps.onEvent?.({ type: 'notice', text, payload: { source, text }, ts: Date.now() });
    };
    if (done && reply && this.deps.settle) {
      try {
        const text = await this.deps.settle({ goal: task.goal, reply });
        if (typeof text === 'string' && text.length > 0) announce('skills', text);
      } catch (e) { /* 既有 failed 说明行不变 */ }
    }
    if (done && reply && this.deps.settleMemory) {
      try {
        const text = await this.deps.settleMemory({ goal: task.goal, reply });
        if (typeof text === 'string' && text.length > 0) announce('memory', text);
      } catch { /* 旁路纪律 */ }
    }
```

`harness/index.ts` 装配：

```ts
      ...(resolveMemoryConfig().learnedSkills
        ? {
            settle: (r: { goal: string; reply: string }) => {
              const res = new LearnedSkillStore(base).settle(r.goal, r.reply, { limit: resolveMemoryConfig().learnedSkillLimit });
              return res.ok ? pick(`[skills] learned: ${res.value}`, `[技能] 已沉淀：${res.value}`) : undefined;
            },
          }
        : {}),
      ...(resolveMemoryConfig().autoMemory
        ? {
            settleMemory: async (r: { goal: string; reply: string }) => {
              const slugs = await settleMemory({ goal: r.goal, reply: r.reply, model: this.model, root: base });
              return slugs.length > 0 ? pick(`[memory] saved: ${slugs.join(', ')} — read ${path.join(resolveDataDir(base), 'memory')}/MEMORY.md to recall`, `[记忆] 已保存：${slugs.join(', ')}——召回请 read ${path.join(resolveDataDir(base), 'memory')}/MEMORY.md`) : undefined;
            },
          }
        : {}),
```

（`opts.learnSkills` 被配置取代；`HarnessOptions.learnSkills` 保留为测试显式覆盖：`opts.learnSkills ?? resolveMemoryConfig().learnedSkills`。）

`types.ts`：`SessionEventType` 增 `| 'notice'`。

`src/tui/session.ts`：`onEvent` 增 `notice` 分支 → `this.pushMsg('system', String(e.payload?.text ?? e.text ?? ''))`；`/memory` 子命令增 `on` / `off`：

```ts
      if (sub === 'on' || sub === 'off') {
        this.memoryOverride = sub === 'on';
        this.pushMsg('system', t(
          `Persistent memory ${sub} for this session (persist with the SUNSHINEX_AUTO_MEMORY env var)`,
          `本会话持久记忆已${sub === 'on' ? '开启' : '关闭'}（持久化请设环境变量 SUNSHINEX_AUTO_MEMORY）`,
        ));
        return;
      }
```

并在 `runtime.harness.context` 装配处让会话覆盖生效（会话内 override 优先于配置；不改盘）。`/memory` 无参列表尾部追加 `store.capacityNotice()` 与当前开关状态。

文档：`TUI-MANUAL.md`（/memory 子命令与开关、动态改动尾追口径）、`README.md`（记忆控制面三个 env 键）。

- [ ] **Step 4: 全量门禁**

Run: `pnpm build && pnpm test 2>&1 | tail -6 && pnpm selfcheck 2>&1 | tail -3`
Expected: tsc 零报错；全量测试 fail 0；selfcheck OK（工具清单 10 项含 skill 且按名排序、skills 21）

- [ ] **Step 5: 提交**

```bash
git add src/harness/memory/extractor.ts src/harness/reactor.ts src/types.ts src/harness/index.ts src/tui/session.ts src/harness/reactor.notice.test.ts src/tui/session.memory-toggle.test.ts TUI-MANUAL.md README.md
git commit -m "feat(memory): M8 会话内可见性——settle 产出尾追 action:notice 链行（模型面）+ notice 事件（用户面 Saved 回执）、/memory on|off 会话内开关；TUI-MANUAL/README 口径同步"
```

---

## 计划自审记录

**规格覆盖**：§1 五项差距 → A1(Task 4/5/8)、A2(Task 2/8)、A3(Task 1)、A4(Task 7)、A5(Task 1 的 `capacityNotice` + Task 4 回执)；§4 写入面 → Task 3/4；§5 记录与索引 → Task 1；§6 容量两级 → Task 1/4；§7 控制面 → Task 2/8；§8 子代理 → Task 7；§9 动态改动尾追 → Task 6；§10 可见性 → Task 8；§11/§12 → 各任务 Step 4 的回归项；§13 工具面零变化 → Task 4 Step 4 selfcheck 硬校验；§14 落点表 → 全覆盖；§15 自答 → 已固化进各任务实现。

**相对规格的两处落地细化**（均为规格条文的实现细节，不改语义）：
1. `extractor.ts` 的 `settleMemory` 由 `Promise<void>` 改 `Promise<string[]>`（规格 §9.4 需要知道新增 slug 才能生成说明行）。
2. 子代理 scope 由规格所述「SafetyChain 新增构造项」落地为 `withMemoryScope()` 派生克隆——同语义、对既有共享实例零突变。

**类型一致性核对**：`MemoryScope`（Task 3）→ Task 4/7 复用；`MemoryRecord.modified`（Task 1）→ Task 4 落盘序列化；`MemoryWriteSeam`（Task 4）→ Task 4 builtin 装配；`AgentDef.memory`（Task 7）→ Task 7 parse/load/组装；`settle`/`settleMemory` 返回类型（Task 8）→ Task 8 reactor 与 harness 双侧一致。

**占位扫描**：无 TBD/TODO；红灯测试给具体用例名与断言要点，实现块给完整可编译代码。
1/§12 → 各任务 Step 4 的回归项；§13 工具面零变化 → Task 4 Step 4 selfcheck 硬校验；§14 落点表 → 全覆盖；§15 自答 → 已固化进各任务实现。

**相对规格的两处落地细化**（均为规格条文的实现细节，不改语义）：
1. `extractor.ts` 的 `settleMemory` 由 `Promise<void>` 改 `Promise<string[]>`（规格 §9.4 需要知道新增 slug 才能生成说明行）。
2. 子代理 scope 由规格所述「SafetyChain 新增构造项」落地为 `withMemoryScope()` 派生克隆——同语义、对既有共享实例零突变。

**类型一致性核对**：`MemoryScope`（Task 3）→ Task 4/7 复用；`MemoryRecord.modified`（Task 1）→ Task 4 落盘序列化；`MemoryWriteSeam`（Task 4）→ Task 4 builtin 装配；`AgentDef.memory`（Task 7）→ Task 7 parse/load/组装；`settle`/`settleMemory` 返回类型（Task 8）→ Task 8 reactor 与 harness 双侧一致。

**占位扫描**：无 TBD/TODO；红灯测试给具体用例名与断言要点，实现块给完整可编译代码。
