# 安全边界能力优先重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec《安全边界能力优先重构设计》：读全盘放开 + 可选读围栏、root 外写审批化（'always' 会话记住目录）、`--add-dir` 三面同源、permissions 规则面、`.git/**` 写硬保护、Landlock exec 围栏与 isolation 上屏。

**Architecture:** 判定序重造收敛于 `SafetyChain.resolveSafe` 单点（产品硬底线 → 用户规则 → 读分支 → 写分支）；guard 保留类别闸门与 asker 通道，路径审批由链发起、经 `guard.resolveAsk` 回路，'always' 目录登记进 guard 会话集并同喂工具面与 landlock 可写根；exec 围栏经 `landlock.ts` 接缝组装 launcher argv 前缀，由 `ProcessSandbox` 消费（平台分支仍收敛 sandbox.ts，§14）。

**Tech Stack:** TypeScript strict（CommonJS，Node ≥22.9）、node:test（`scripts/run-tests.js` 汇总）、`@deepseek-ai/node-addon-landlock-run`（optionalDependencies，ESM-only，运行期动态 import + 本地结构类型，避免编译期静态依赖）。

**Spec:** `docs/superpowers/specs/2026-09-24-security-boundary-capability-first-design.md`（判定序以其 §5.1 为准）

## Global Constraints

- TS strict，禁无理由 any；路径一律 `path.join`/`path.resolve`；子树判定一律走 `src/paths.ts` 的 `isWithin`
- 提示词装配面零改动（§11 前缀回归不触发）；新增拒绝 reason 英文单语（入链）；TUI/CLI 外观文案一律 `t()` 双语
- 共享类型登记 `src/types.ts`（`ApprovalKind`、`ExecOpts.wrap`、`RuntimeSafetyGate.execWrap?`）
- 语义零漂移项：settings.json 两级写保护、记忆写窄口、worktree 主根拒写、隔离链（`withRoot`）根外写拒——四者先于用户规则，规则不可放宽
- **行为变更三则（既有测试需同步改判）**：① manual 档信任域内写不再逐次审批（spec §5.1 写分支）② root 外读缺省全放 ③ 写审批 'always' 记**目录**（原记精确路径）
- 新增语义键一律登记 `settings.ts` SEMANTIC_KEYS：`readFence`/`sandbox`/`isolation`；`permissions` 为结构化键、不经 flatten/env 槽
- 每任务 TDD：先写失败测试并运行确认失败，再实现至通过，随即提交（`feat(security):` 前缀）
- 验证门：单测 `pnpm build && node --test dist/<对应测试文件>`；任务收尾全量 `node scripts/run-tests.js`；最终 `node dist/cli/index.js selfcheck` 需 exit 0

## File Structure

```text
src/types.ts                              # ApprovalKind('read')、GuardDecision 无关（guard 内）、ExecOpts.wrap、RuntimeSafetyGate.execWrap?
src/config/permissions.ts                 # [新建] 两级装载合并 + pathGlobMatch + matchPermission/matchAnyRule（规则匹配单点）
src/config/settings.ts                    # SettingsDoc.permissions 结构化支路；SEMANTIC_KEYS += readFence/sandbox/isolation
src/harness/security/guard.ts             # GuardDecision 扩展；mode 透出；sessionDirAllows；resolveAsk；preToolUse 重排
src/harness/security/chain.ts             # resolveSafe v2 判定序；evaluateAsync ask 路由；信任目录/permissions 注入面；landlockWritableRoots
src/harness/security/landlock.ts          # [新建] launcher 接缝（探测/包装/降级）+ resolveIsolation
src/harness/security/sandbox.ts           # exec/execBackground 消费 ExecOpts.wrap（平台分支唯一落点）
src/harness/tools/builtin.ts              # exec 后台分支经 gateView.execWrap 取包装
src/harness/index.ts                      # 装配：loadPermissions → PolicyEngine 注入 + 链 setPermissions/setAdditionalDirs；addAdditionalDir
src/runtime.ts                            # buildDeps 透传 addDirs
src/cli/index.ts                          # parseArgs 可重复 --add-dir + flagList + usage 行
src/tui/entry.ts / tui/runtime.ts         # TUI 面 addDirs 透传
src/tui/session.ts / tui/slash-commands.ts# /add-dir 斜杠命令
src/cli/commands/selfcheck.ts             # isolation : 行
docs/CLAUDE.md MANUAL.md README.md        # 台账行/平台登记/配置文档
```

---

### Task 1: guard 契约扩展（mode 透出、会话目录集、resolveAsk 通道、plan 先于 allow、Write 下放）

**Files:**
- Modify: `src/types.ts`（ApprovalRequest 附近）
- Modify: `src/harness/security/guard.ts`
- Test: `src/harness/security/guard.boundary.test.ts`（新建）

**Interfaces:**
- Consumes: 既有 `PolicyEngine.add(decision, rule)`、`setAsker`、`clearSessionAllows`、`isWithin(parent, target)`（`src/paths.ts`）
- Produces（后续任务依赖，签名逐字）:
  - `get mode(): PermissionMode`（SecurityGuard）
  - `allowSessionDir(dir: string): void`、`sessionDirAllowed(real: string): boolean`、`sessionDirList(): string[]`
  - `nextApprovalId(): string`、`async resolveAsk(req: ApprovalRequest): Promise<ApprovalDecision | null>`
  - `GuardDecision` 否决分支扩为 `{ allowed: false; reason: string; ask?: boolean; askDir?: string; safePath?: string }`
  - `types.ts`: `export type ApprovalKind = 'command' | 'mcp' | 'webfetch' | 'websearch' | 'write' | 'read';`（`ApprovalRequest.kind: ApprovalKind`）

- [ ] **Step 1: 写失败测试**

```ts
// src/harness/security/guard.boundary.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SecurityGuard } from './guard';
import { PolicyEngine } from './policy';
import type { ApprovalRequest } from '../../types';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-guard-b-'));
}

test('manual 档 Write 下放安全链：guard 不再逐次 ask（spec 5.1 写分支）', () => {
  const g = new SecurityGuard(new PolicyEngine(), 'manual');
  const d = g.preToolUse('Write', { path: path.join(tmpDir(), 'a.txt') });
  assert.equal(d.allowed, true);
});

test('plan 闸门先于 allow 短路：allow 规则不放宽 plan 只读', () => {
  const policy = new PolicyEngine();
  policy.add('allow', 'Write');
  const g = new SecurityGuard(policy, 'plan');
  const d = g.preToolUse('Write', { path: 'a.txt' });
  assert.equal(d.allowed, false);
  assert.ok(!d.allowed && d.reason.includes('plan mode allows read-only operations only'));
});

test('allow 规则在非 plan 档免批', () => {
  const policy = new PolicyEngine();
  policy.add('allow', 'Bash(npm*)');
  const g = new SecurityGuard(policy, 'manual');
  assert.equal(g.preToolUse('Bash', 'npm test').allowed, true);
});

test('会话目录登记与判定（含自身；clear 同步清理）', () => {
  const g = new SecurityGuard(new PolicyEngine(), 'manual');
  const dir = tmpDir();
  g.allowSessionDir(dir);
  assert.equal(g.sessionDirAllowed(dir), true);
  assert.equal(g.sessionDirAllowed(path.join(dir, 'sub', 'f.txt')), true);
  assert.equal(g.sessionDirAllowed(path.join(path.dirname(dir), 'elsewhere.txt')), false);
  assert.deepEqual(g.sessionDirList(), [dir]);
  g.clearSessionAllows();
  assert.equal(g.sessionDirAllowed(dir), false);
});

test('resolveAsk：无 asker 返回 null（宁停不误）；有 asker 原样回传决策', async () => {
  const g = new SecurityGuard(new PolicyEngine(), 'manual');
  const req: ApprovalRequest = { id: g.nextApprovalId(), kind: 'write', subject: '/tmp/x/a.txt', reason: 'r' };
  assert.equal(await g.resolveAsk(req), null);
  g.setAsker(async () => 'allow');
  assert.equal(await g.resolveAsk(req), 'allow');
  assert.ok(g.nextApprovalId().startsWith('ap-'));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build 2>&1 | grep -E "error TS" ; node --test dist/harness/security/guard.boundary.test.js 2>&1 | tail -5`
Expected: 编译期即报 `sessionDirAllowed`/`resolveAsk`/`nextApprovalId`/`mode` 不存在（TS2339 类）——失败即预期。

- [ ] **Step 3: 实现**

`src/types.ts`——在 `ApprovalRequest` 定义上方新增，并把 `kind` 字段类型替换为 `ApprovalKind`：

```ts
/** 审批卡种类（spec 5.2）：'read' 为读围栏（D1）新增通道 */
export type ApprovalKind = 'command' | 'mcp' | 'webfetch' | 'websearch' | 'write' | 'read';
```

`src/harness/security/guard.ts`——五处变更：

① 文件头补 import（与既有 import 并列）：

```ts
import { isWithin } from '../../paths';
```

② `GuardDecision` 否决分支扩字段（替换现有 type 定义）：

```ts
export type GuardDecision =
  | { allowed: true; safePath?: string }
  | { allowed: false; reason: string; ask?: boolean; askDir?: string; safePath?: string };
```

③ 构造器参数属性 `mode` 改名 `modeName`（`private mode: PermissionMode = 'manual'` → `private modeName: PermissionMode = 'manual'`），类内全部 `this.mode` 机械替换为 `this.modeName`，并新增 getter 与会话目录集（放在 `setAsker` 附近）：

```ts
  private readonly sessionDirAllows = new Set<string>();

  /** 当前权限模式（链侧消费：读/写分支按档位定论，spec 5.1） */
  get mode(): PermissionMode {
    return this.modeName;
  }

  /** 'always' 目录登记（spec 5.1 会话放行集；链侧 realpath 归一后传入） */
  allowSessionDir(dir: string): void {
    this.sessionDirAllows.add(dir);
  }

  /** 会话目录放行判据：real 落在任一已登记目录内（含自身） */
  sessionDirAllowed(real: string): boolean {
    for (const dir of this.sessionDirAllows) {
      if (real === dir || isWithin(dir, real)) return true;
    }
    return false;
  }

  /** landlock 可写根消费（spec 5.4：工具面与 exec 面对齐同一目录集） */
  sessionDirList(): string[] {
    return [...this.sessionDirAllows];
  }

  /** 审批请求 id 单点（链侧发起的 ask 复用同一序号空间） */
  nextApprovalId(): string {
    return `ap-${++this.seq}`;
  }

  /** 链侧发起的 ask 决策通道（spec 5.1 写/读分支）：asker 缺失返回 null（宁停不误，调用方维持原拒绝） */
  async resolveAsk(req: ApprovalRequest): Promise<ApprovalDecision | null> {
    if (!this.asker) return null;
    try {
      return await this.asker(req);
    } catch {
      return null;
    }
  }
```

④ `clearSessionAllows()` 方法体末尾追加一行：

```ts
    this.sessionDirAllows.clear();
```

⑤ `preToolUse` 两处定点重排（类别闸门——Bash destructive、WebFetch/WebSearch、mcp__、ask_question/todo_write、worktree——一律原样保留不动）：
   a. 把现「plan 只读闸门」分支（`if (this.modeName === 'plan') { if (tool !== 'Read' && ...) return ... }` 整块）**剪切**到 `if (decision === 'allow') return { allowed: true };` **之前**（语义：allow 免批不放宽 plan 只读）；
   b. 在 manual 段「Read/Grep/Glob 白名单放行」行之后、最终 `return { allowed: false, ask: true, ... }` 之前插入：

```ts
  if (tool === 'Write') return { allowed: true }; // 路径写工具的 manual 审批下放安全链（链持归一路径与目录粒度会话放行，spec 5.1 写分支）
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm build 2>&1 | grep -E "error TS" ; node --test dist/harness/security/guard.boundary.test.js 2>&1 | tail -3`
Expected: 新文件 5/5 PASS。随后 `node scripts/run-tests.js 2>&1 | grep -E "^# (pass|fail)"`——既有用例中**断言「manual 档 Write 被 ask」**者会转绿/转红：凡此类断言改为「allowed === true」（依据 Global Constraints 行为变更①），其余失败零容忍。

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/harness/security/guard.ts src/harness/security/guard.boundary.test.ts
git commit -m "feat(security): guard 契约扩展——mode 透出/会话目录集/resolveAsk 通道/plan 先于 allow/Write 下放"
```

---

### Task 2: permissions 配置模块 + settings 结构化支路与三个语义键

**Files:**
- Create: `src/config/permissions.ts`
- Modify: `src/config/settings.ts`
- Test: `src/config/permissions.test.ts`、`src/config/settings.permissions.test.ts`（均新建）

**Interfaces:**
- Consumes: `parseSettingsFile`（settings.ts，返回 `SettingsDoc | null`）、`loadProjectSettings(root)` / `loadGlobalSettings()`（返回路径字符串）、`parseRule`（`../harness/security/rules`，返回 `{ tool: string; specifier: string | null }`）
- Produces（后续任务依赖，签名逐字）:
  - `interface PermissionsConfig { deny: string[]; allow: string[]; additionalDirs: string[] }`
  - `interface LoadedPermissions { config: PermissionsConfig; warnings: string[] }`
  - `loadPermissions(projectRoot: string): LoadedPermissions`
  - `pathGlobMatch(pattern: string, target: string): boolean`（target 须 `/` 分隔）
  - `matchPermission(rule: string, tool: string, specifiers: string[]): boolean`、`matchAnyRule(rules: string[], tool: string, specifiers: string[]): boolean`
  - `SettingsDoc` 增字段 `permissions?: unknown`；SEMANTIC_KEYS 增 `readFence: 'SUNSHINEX_READ_FENCE'`、`sandbox: 'SUNSHINEX_SANDBOX'`、`isolation: 'SUNSHINEX_ISOLATION'`

- [ ] **Step 1: 写失败测试**

```ts
// src/config/permissions.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadPermissions, matchAnyRule, matchPermission, pathGlobMatch } from './permissions';

function withHome(fn: (home: string, root: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-perm-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-perm-root-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    fn(home, root);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeSettings(dir: string, body: object): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(body));
}

test('两级装载合并不遮蔽：deny 并集 + 去重', () => {
  withHome((home, root) => {
    writeSettings(path.join(home, '.sunshinex'), { permissions: { deny: ['Bash(rm*)', 'Read(**/.env)'] } });
    writeSettings(path.join(root, '.sunshinex'), {
      permissions: { deny: ['Read(**/.env)'], allow: ['Write(src/**)'], additionalDirs: ['../lib'] },
    });
    const { config, warnings } = loadPermissions(root);
    assert.equal(warnings.length, 0);
    assert.deepEqual(config.deny, ['Bash(rm*)', 'Read(**/.env)']);
    assert.deepEqual(config.allow, ['Write(src/**)']);
    assert.deepEqual(config.additionalDirs, ['../lib']);
  });
});

test('单级形状非法：该级警告跳过，另一级照常生效', () => {
  withHome((home, root) => {
    writeSettings(path.join(home, '.sunshinex'), { permissions: 'oops' });
    writeSettings(path.join(root, '.sunshinex'), { permissions: { deny: ['Bash(rm*)'] } });
    const { config, warnings } = loadPermissions(root);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.includes('须为对象'));
    assert.deepEqual(config.deny, ['Bash(rm*)']);
  });
});

test('deny 数组元素非字符串：该键警告忽略', () => {
  withHome((home, root) => {
    writeSettings(path.join(root, '.sunshinex'), { permissions: { deny: ['ok', 42] } });
    const { config, warnings } = loadPermissions(root);
    assert.equal(warnings.length, 1);
    assert.deepEqual(config.deny, []);
  });
});

test('两级均缺省：空配置零警告', () => {
  withHome((_home, root) => {
    const { config, warnings } = loadPermissions(root);
    assert.deepEqual(config, { deny: [], allow: [], additionalDirs: [] });
    assert.equal(warnings.length, 0);
  });
});

test('pathGlobMatch：** 跨段、* 不跨段、无 / 模式对 basename', () => {
  assert.equal(pathGlobMatch('**/.env', 'home/u/.env'), true);
  assert.equal(pathGlobMatch('**/.env', 'home/u/proj/.env'), true);
  assert.equal(pathGlobMatch('src/**', 'src/a/b.ts'), true);
  assert.equal(pathGlobMatch('src/**', 'lib/x.ts'), false);
  assert.equal(pathGlobMatch('a/**', 'a'), false);
  assert.equal(pathGlobMatch('*.pem', 'server.pem'), true);
  assert.equal(pathGlobMatch('*.pem', 'a/server.pem'), false);
  assert.equal(pathGlobMatch('src/*.ts', 'src/a.ts'), true);
  assert.equal(pathGlobMatch('src/*.ts', 'src/a/b.ts'), false);
});

test('matchPermission：Bash 前缀（尾 *）/ 精确、mcp 直名尾通配、文件工具按 specifiers 任一命中', () => {
  assert.equal(matchPermission('Bash(rm -rf*)', 'Bash', ['rm -rf /x']), true);
  assert.equal(matchPermission('Bash(ls)', 'Bash', ['ls -la']), false);
  assert.equal(matchPermission('Bash(ls)', 'Bash', ['ls']), true);
  assert.equal(matchPermission('mcp__legacy__*', 'mcp__legacy__query', ['']), true);
  assert.equal(matchPermission('mcp__legacy__query', 'mcp__legacy__other', ['']), false);
  const specifiers = ['home/u/proj/src/a.ts', 'src/a.ts', 'a.ts'];
  assert.equal(matchPermission('Write(src/**)', 'Write', specifiers), true);
  assert.equal(matchPermission('Write(*.ts)', 'Write', specifiers), true);
  assert.equal(matchPermission('Read(**/.env)', 'Read', ['home/u/.env']), true);
  assert.equal(matchAnyRule(['Bash(git*)', 'Write(src/**)'], 'Write', ['proj/src/a.ts', 'src/a.ts', 'a.ts']), true);
});
```

```ts
// src/config/settings.permissions.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSettingsFile, SEMANTIC_KEYS, flattenSettings } from './settings';

test('parseSettingsFile 保留 permissions 结构化原值，flattenSettings 零警告', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-settings-perm-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    permissions: { deny: ['Bash(rm*)'], additionalDirs: ['../lib'] },
  }));
  const doc = parseSettingsFile(file);
  assert.notEqual(doc, null);
  assert.deepEqual(doc!.permissions, { deny: ['Bash(rm*)'], additionalDirs: ['../lib'] });
  const flat = flattenSettings(doc!);
  assert.equal(flat.warnings.some((w: string) => w.includes('permissions')), false, 'permissions 不得产生未知键警告');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SEMANTIC_KEYS 登记三个边界语义键', () => {
  assert.equal(SEMANTIC_KEYS.readFence, 'SUNSHINEX_READ_FENCE');
  assert.equal(SEMANTIC_KEYS.sandbox, 'SUNSHINEX_SANDBOX');
  assert.equal(SEMANTIC_KEYS.isolation, 'SUNSHINEX_ISOLATION');
});
```

（`flattenSettings` 返回值字段名以现文件为准：若警告字段不叫 `warnings`，按实际字段名断言同一语义。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build 2>&1 | grep -E "error TS" ; node --test dist/config/permissions.test.js dist/config/settings.permissions.test.js 2>&1 | tail -5`
Expected: 编译失败（模块不存在 / 字段不存在）——失败即预期。

- [ ] **Step 3: 实现 settings.ts 支路**

① `SettingsDoc` 增字段（保持既有字段不动）：

```ts
  /** permissions 结构化语义键原值（spec 5.2）：形状裁决在 config/permissions.ts，不经 flatten/env 槽 */
  permissions?: unknown;
```

② `parseSettingsFile` 根键循环：在 `version`/`env` 分支之后追加一个分支，并让返回值带上它：

```ts
      if (key === 'permissions') {
        permissions = root[key] as unknown;
        continue;
      }
```

（`permissions` 局部变量初值 `undefined`，随返回对象一并输出；`semantic` 不再收它。）

③ `SEMANTIC_KEYS` 对象内追加三行：

```ts
  readFence: 'SUNSHINEX_READ_FENCE',
  sandbox: 'SUNSHINEX_SANDBOX',
  isolation: 'SUNSHINEX_ISOLATION',
```

- [ ] **Step 4: 实现 permissions.ts（全文新建）**

```ts
/**
 * permissions 结构化语义键装载与规则匹配单点（spec 5.2）：
 * - 两级装载合并不遮蔽：全局 ~/.sunshinex/settings.json + 项目 .sunshinex/settings.json 数组拼接去重
 *   （deny 取并集——项目级不得解除全局 deny；对标 CC 层级合并语义）
 * - 单级形状非法 → 该级 warning 跳过（对标 mcp.json 非法条目跳过语义），畸形 JSON 由 settings 装载链统一 fail-fast
 * - 语法 Tool(specifier)：文件工具 = 路径 glob（`**` 跨段、`*`/`?` 不跨段、无 `/` 模式对 basename 匹配）；
 *   Bash = 命令匹配（尾 `*` 为前缀）；mcp__ 直名（尾 `*` 通配）
 */
import * as path from 'path';
import { parseRule } from '../harness/security/rules';
import { parseSettingsFile, loadProjectSettings, loadGlobalSettings } from './settings';

export interface PermissionsConfig {
  deny: string[];
  allow: string[];
  additionalDirs: string[];
}

export interface LoadedPermissions {
  config: PermissionsConfig;
  warnings: string[];
}

const EMPTY: PermissionsConfig = { deny: [], allow: [], additionalDirs: [] };

function readLevel(filePath: string, warnings: string[]): PermissionsConfig {
  let doc: ReturnType<typeof parseSettingsFile> = null;
  try {
    doc = parseSettingsFile(filePath);
  } catch {
    doc = null; // 畸形 JSON 由 settings 装载链统一上报；此处按缺级处理
  }
  if (doc === null || doc.permissions === undefined) return EMPTY;
  const raw = doc.permissions as unknown;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnings.push(`settings.json permissions 须为对象（${filePath}），该键已忽略`);
    return EMPTY;
  }
  const obj = raw as Record<string, unknown>;
  const strArr = (value: unknown, name: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((s) => typeof s !== 'string')) {
      warnings.push(`settings.json permissions.${name} 须为字符串数组（${filePath}），该键已忽略`);
      return [];
    }
    return value as string[];
  };
  return {
    deny: strArr(obj.deny, 'deny'),
    allow: strArr(obj.allow, 'allow'),
    additionalDirs: strArr(obj.additionalDirs, 'additionalDirs'),
  };
}

/** 两级装载合并不遮蔽：全局在前、项目在后，数组拼接去重 */
export function loadPermissions(projectRoot: string): LoadedPermissions {
  const warnings: string[] = [];
  const levels = [readLevel(loadGlobalSettings(), warnings), readLevel(loadProjectSettings(projectRoot), warnings)];
  return {
    config: {
      deny: [...new Set(levels.flatMap((l) => l.deny))],
      allow: [...new Set(levels.flatMap((l) => l.allow))],
      additionalDirs: [...new Set(levels.flatMap((l) => l.additionalDirs))],
    },
    warnings,
  };
}

function escapeRegExp(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 路径 glob → 正则片段（gitignore 风格，spec 5.2）：`**` 跨段、`*`/`?` 不跨段 */
function pathGlobToRegex(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**', i)) {
      const prevIsSlash = i === 0 || pattern[i - 1] === '/';
      const nextIsSlash = pattern[i + 2] === '/';
      if (prevIsSlash && nextIsSlash) {
        out += '(?:[^/]+/)*';
        i += 3;
        continue;
      }
      out += '.*';
      i += 2;
      continue;
    }
    const ch = pattern[i]!;
    out += ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : escapeRegExp(ch);
    i += 1;
  }
  return out;
}

/** 路径 glob 匹配（target 须 `/` 分隔）：无 `/` 模式对 basename，其余对整路径 */
export function pathGlobMatch(pattern: string, target: string): boolean {
  if (!pattern.includes('/')) {
    const base = target.slice(target.lastIndexOf('/') + 1);
    return new RegExp('^' + pathGlobToRegex(pattern) + '$').test(base);
  }
  return new RegExp('^' + pathGlobToRegex(pattern) + '$').test(target);
}

/** 单条规则匹配：文件工具对 specifiers 任一命中即命中；Bash 尾 `*` 前缀否则全等；mcp 直名尾 `*` 通配 */
export function matchPermission(rule: string, tool: string, specifiers: string[]): boolean {
  const { tool: ruleTool, specifier: spec } = parseRule(rule);
  const toolMatches = ruleTool.endsWith('*')
    ? tool.startsWith(ruleTool.slice(0, -1))
    : ruleTool === tool || ruleTool === '*';
  if (!toolMatches) return false;
  if (spec === null || spec === '*') return true;
  const first = specifiers[0] ?? '';
  if (ruleTool === 'Bash' || ruleTool.startsWith('mcp__')) {
    return spec.endsWith('*') ? first.startsWith(spec.slice(0, -1)) : first === spec;
  }
  return specifiers.some((s) => pathGlobMatch(spec, s));
}

/** 规则清单匹配：任一条命中即 true */
export function matchAnyRule(rules: string[], tool: string, specifiers: string[]): boolean {
  return rules.some((rule) => matchPermission(rule, tool, specifiers));
}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm build 2>&1 | grep -E "error TS" ; node --test dist/config/permissions.test.js dist/config/settings.permissions.test.js 2>&1 | tail -3`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/config/permissions.ts src/config/permissions.test.ts src/config/settings.ts src/config/settings.permissions.test.ts
git commit -m "feat(security): permissions 结构化键装载与规则匹配单点 + readFence/sandbox/isolation 语义键"
```

---

### Task 3: chain.resolveSafe v2（判定序重造 + 会话目录集 + 信任目录 + ask 路由）

**Files:**
- Modify: `src/harness/security/chain.ts`
- Test: `src/harness/security/chain.boundary.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `guard.mode`/`allowSessionDir`/`sessionDirAllowed`/`resolveAsk`/`nextApprovalId`、`GuardDecision.askDir/safePath`；Task 2 的 `loadPermissions`、`matchAnyRule`、`PermissionsConfig`
- Produces（后续任务依赖，签名逐字）:
  - `setPermissions(config: PermissionsConfig): void`、`setAdditionalDirs(dirs: string[]): void`、`addAdditionalDir(dir: string): void`
  - `async execWrap(cmd: string): Promise<ExecOpts['wrap'] | null>`（Task 5 消费；本任务先落 landlockWritableRoots + 占位 import，见 Step 3 注）
  - resolveSafe 求值序（spec §5.1）：settings.json → .git → 记忆窄口 → worktree 主根拒写 → 用户 deny → 会话目录放行 → 用户 allow → 读分支 → 写分支

- [ ] **Step 1: 写失败测试**

```ts
// src/harness/security/chain.boundary.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SafetyChain } from './chain';
import { SecurityGuard } from './guard';
import { PolicyEngine } from './policy';
import { ProcessSandbox } from './sandbox';
import { DryRun } from './dryrun';

interface Fixture { chain: SafetyChain; guard: SecurityGuard; root: string; home: string; restore: () => void }

function withChain(mode: 'manual' | 'dontAsk' | 'plan', fn: (f: Fixture) => void | Promise<void>): Promise<void> | void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-boundary-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-boundary-root-'));
  const prevHome = process.env.HOME;
  const prevFence = process.env.SUNSHINEX_READ_FENCE;
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.HOME = home;
  process.env.SUNSHINEX_DATA_DIR = path.join(home, '.sunshinex', 'projects', 'p', 'data');
  fs.mkdirSync(process.env.SUNSHINEX_DATA_DIR, { recursive: true });
  const guard = new SecurityGuard(new PolicyEngine(), mode);
  const chain = new SafetyChain(guard, new ProcessSandbox(), new DryRun(), root);
  const restore = (): void => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevFence === undefined) delete process.env.SUNSHINEX_READ_FENCE; else process.env.SUNSHINEX_READ_FENCE = prevFence;
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR; else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  };
  const r = fn({ chain, guard, root, home, restore });
  if (r instanceof Promise) return r.then(restore);
  restore();
}

test('D1：root 外读缺省全放（manual 档亦放）', async () => {
  withChain('manual', ({ chain, root }) => {
    const outside = path.join(path.dirname(root), 'outside.txt');
    fs.writeFileSync(outside, 'x');
    const d = chain.evaluate('Read', { path: outside });
    assert.equal(d.allowed, true);
  });
});

test('D1：fence 开启时 root 外读 manual=ask，askDir 记目录；dontAsk=拒', async () => {
  withChain('manual', async ({ chain, root }) => {
    process.env.SUNSHINEX_READ_FENCE = 'on';
    const outside = path.join(path.dirname(root), 'secret.txt');
    const d = await chain.evaluateAsync('Read', { path: outside });
    assert.equal(d.allowed, false);
    assert.ok(!d.allowed && d.ask === true && d.askDir === path.dirname(outside));
  });
  withChain('dontAsk', ({ chain, root }) => {
    process.env.SUNSHINEX_READ_FENCE = 'on';
    const outside = path.join(path.dirname(root), 'secret.txt');
    const d = chain.evaluate('Read', { path: outside });
    assert.equal(d.allowed, false);
    assert.ok(!d.allowed && d.reason.includes('read fence'));
  });
});

test('D2：root 外写 manual=ask（askDir=目录）；'always' 经 evaluateAsync 登记目录后同目录免批', async () => {
  withChain('manual', async ({ chain, guard, root }) => {
    const dir = path.join(path.dirname(root), 'granted');
    fs.mkdirSync(dir, { recursive: true });
    const d1 = await chain.evaluateAsync('Write', { path: path.join(dir, 'a.txt') });
    assert.ok(!d1.allowed && d1.ask === true && d1.askDir === dir);
    guard.setAsker(async () => 'always');
    const d2 = await chain.evaluateAsync('Write', { path: path.join(dir, 'a.txt') });
    assert.equal(d2.allowed, true);
    assert.equal(guard.sessionDirAllowed(path.join(dir, 'b.txt')), true);
    guard.setAsker(undefined); // 撤走 asker：同目录后续写仍放行（会话目录登记生效）
    const d3 = await chain.evaluateAsync('Write', { path: path.join(dir, 'b.txt') });
    assert.equal(d3.allowed, true);
    const elsewhere = path.join(path.dirname(root), 'elsewhere', 'c.txt');
    const d4 = await chain.evaluateAsync('Write', { path: elsewhere });
    assert.equal(d4.allowed, false); // asker 已撤，新目录 ask 无通道 → 维持拒
  });
});

test('D2：root 外写 dontAsk=放行；信任域内 manual 亦直放', () => {
  withChain('dontAsk', ({ chain, root }) => {
    const outside = path.join(path.dirname(root), 'w.txt');
    assert.equal(chain.evaluate('Write', { path: outside }).allowed, true);
  });
  withChain('manual', ({ chain, root }) => {
    assert.equal(chain.evaluate('Write', { path: path.join(root, 'in.txt') }).allowed, true);
  });
});

test('D6：.git 任一段写拒（仓库 .git 目录与指针文件同护）', () => {
  withChain('dontAsk', ({ chain, root }) => {
    assert.ok(!chain.evaluate('Write', { path: path.join(root, '.git', 'config') }).allowed);
    assert.ok(!chain.evaluate('Write', { path: path.join(root, 'sub', '.git', 'HEAD') }).allowed);
    assert.ok(chain.evaluate('Write', { path: path.join(root, 'github-like', 'a.txt') }).allowed);
  });
});

test('D6：.git 硬底线先于用户 allow 规则（规则不可放宽）', () => {
  withChain('dontAsk', ({ chain, root }) => {
    chain.setPermissions({ deny: [], allow: ['Write(**/.git/**)'], additionalDirs: [] });
    const d = chain.evaluate('Write', { path: path.join(root, '.git', 'config') });
    assert.equal(d.allowed, false);
  });
});

test('D5：用户 deny 命中即拒、allow 信任域外免批', () => {
  withChain('manual', ({ chain, root }) => {
    chain.setPermissions({ deny: ['Write(**/.env)'], allow: ['Write(**/allow.txt)'], additionalDirs: [] });
    assert.ok(!chain.evaluate('Write', { path: path.join(root, 'sub', 'x.env') }).allowed);
    const outside = path.join(path.dirname(root), 'allow.txt');
    assert.equal(chain.evaluate('Write', { path: outside }).allowed, true);
    const other = path.join(path.dirname(root), 'other.txt');
    assert.ok(!chain.evaluate('Write', { path: other }).allowed);
  });
});

test('D3：信任目录读写放行（setAdditionalDirs 归一 + addAdditionalDir 追加）', () => {
  withChain('manual', ({ chain, root }) => {
    const trust = path.join(path.dirname(root), 'trusted');
    fs.mkdirSync(trust, { recursive: true });
    const link = path.join(root, '..', path.basename(trust)); // 相对形态注入
    chain.setAdditionalDirs([link]);
    assert.equal(chain.evaluate('Write', { path: path.join(trust, 'a.txt') }).allowed, true);
    chain.addAdditionalDir(path.join(trust, 'nested'));
    assert.equal(chain.evaluate('Write', { path: path.join(trust, 'nested', 'b.txt') }).allowed, true);
  });
});

test('withRoot 克隆共享 permissions/additionalDirs；隔离链根外写恒拒', () => {
  withChain('dontAsk', ({ chain, root }) => {
    const tree = path.join(path.dirname(root), 'wt-tree');
    fs.mkdirSync(tree, { recursive: true });
    const trust = path.join(path.dirname(root), 'shared-dir');
    fs.mkdirSync(trust, { recursive: true });
    chain.setAdditionalDirs([trust]);
    chain.setPermissions({ deny: ['Read(**/secret)'], allow: [], additionalDirs: [] });
    const child = chain.withRoot(tree);
    assert.equal(child.evaluate('Write', { path: path.join(trust, 'a.txt') }).allowed, true);
    assert.ok(!child.evaluate('Read', { path: path.join(tree, 'secret') }).allowed);
    const outside = path.join(path.dirname(root), 'out.txt');
    assert.ok(!child.evaluate('Write', { path: outside }).allowed);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build 2>&1 | grep -E "error TS" ; node --test dist/harness/security/chain.boundary.test.js 2>&1 | tail -5`
Expected: 编译失败（`setPermissions`/`setAdditionalDirs`/`withRoot` 外的 `execWrap` 未定义；`matchAnyRule` 未导入）——失败即预期。

- [ ] **Step 3: 实现 chain.ts**

① import 区追加（与既有并列）：

```ts
import * as os from 'os';
import { matchAnyRule } from '../../config/permissions';
import type { PermissionsConfig } from '../../config/permissions';
```

② 模块级追加（`PATH_TOOLS` 定义附近）：

```ts
/** .git 内部路径判据（spec D6）：路径任一段为 .git 即命中（仓库 .git 目录与 worktree 指针文件同护） */
function isGitInternalPath(real: string): boolean {
  return real.split(path.sep).includes('.git');
}
```

③ 类内私有字段（既有 `isolatedRootReal` 等字段旁）：

```ts
  private permissions: PermissionsConfig | undefined = undefined;
  private readonly additionalDirs: string[] = [];
```

④ 注入面三方法（放在 `setAsker` 可达的公开区）：

```ts
  /** D5 用户规则注入（路径工具消费；Bash/mcp/web 通道在 guard PolicyEngine） */
  setPermissions(config: PermissionsConfig): void {
    this.permissions = config;
  }

  /** D3 信任目录集：realpath 归一（缺失锚定向上）；原地变更保引用——fork 克隆共享同一实例 */
  setAdditionalDirs(dirs: string[]): void {
    const normalized = dirs.map((d) => {
      try {
        const abs = path.resolve(d);
        let anchor = abs;
        while (!fs.existsSync(anchor)) anchor = path.dirname(anchor);
        return fs.realpathSync(anchor) + abs.slice(anchor.length);
      } catch {
        return path.resolve(d);
      }
    });
    this.additionalDirs.length = 0;
    this.additionalDirs.push(...normalized);
  }

  /** D3 追加单个信任目录（/add-dir 运行期通道；与 settings/CLI 三面同源） */
  addAdditionalDir(dir: string): void {
    this.setAdditionalDirs([...this.additionalDirs, dir]);
  }
```

⑤ `resolveSafe` **整体替换**为下述实现（求值序即 spec §5.1；既有 catch 形态保留）：

```ts
  private resolveSafe(raw: unknown, tool: string): GuardDecision {
    try {
      const baseRoot = this.activeRootPath ?? this.root;
      const abs = path.resolve(baseRoot, String(raw ?? ''));
      let anchor = abs;
      while (!fs.existsSync(anchor)) anchor = path.dirname(anchor);
      const real = fs.realpathSync(anchor) + abs.slice(anchor.length);

      // ── 产品硬底线（spec 5.1：先于用户规则；规则只可收窄不可放宽）──
      // ① settings.json 两级写保护
      if (tool === 'Write' && this.isProtectedSettingsPath(real)) {
        return { allowed: false, reason: `COMMAND_DENIED: settings.json is protected (edit it manually): ${real}` };
      }
      // ② .git/** 写保护（D6）
      if (tool === 'Write' && isGitInternalPath(real)) {
        return { allowed: false, reason: `COMMAND_DENIED: .git is protected (git state changes go through exec git): ${real}` };
      }
      // ③ 记忆写窄口（既有；先于信任域放行，不绕记忆总开关与 scope）
      if (tool === 'Write' && isMemoryPath(dataDirReal(this.root), real) !== null) {
        const memory = this.memoryWriteAllowed(real);
        return memory.allowed
          ? { allowed: true, safePath: real }
          : { allowed: false, reason: `COMMAND_DENIED: ${memory.reason}: ${real}` };
      }
      // ④ worktree 主根拒写（既有硬底线；主根读类恒开放）
      if (this.activeRootReal !== null && tool === 'Write' && (real === this.rootReal || isWithin(this.rootReal, real))) {
        return { allowed: false, reason: `COMMAND_DENIED: path escapes active worktree root (write outside worktree session): ${real}` };
      }

      // ── 用户规则面（D5：deny → 会话目录放行 → allow）──
      const ruleSpecifiers = this.pathRuleSpecifiers(real);
      if (this.permissions !== undefined && matchAnyRule(this.permissions.deny, tool, ruleSpecifiers)) {
        return { allowed: false, reason: `COMMAND_DENIED: denied by user permissions rule: ${real}` };
      }
      if (this.guard.sessionDirAllowed(real)) return { allowed: true, safePath: real };
      if (this.permissions !== undefined && matchAnyRule(this.permissions.allow, tool, ruleSpecifiers)) {
        return { allowed: true, safePath: real };
      }

      // ── 信任域 ──
      const cfgReal = fs.existsSync(userConfigDir()) ? fs.realpathSync(userConfigDir()) : userConfigDir();
      const inUserConfig = real === cfgReal || isWithin(cfgReal, real);
      const inActiveRoot = this.activeRootReal !== null && (real === this.activeRootReal || isWithin(this.activeRootReal, real));
      const inMainRoot = real === this.rootReal || isWithin(this.rootReal, real);
      const inAdditional = this.additionalDirs.some((d) => real === d || isWithin(d, real));

      // 读分支（D1）：信任域内直放；域外全盘放行，fence 开启时收窄（manual=ask、其余档=拒）
      if (tool !== 'Write') {
        if (inUserConfig || inActiveRoot || inAdditional || inMainRoot) return { allowed: true, safePath: real };
        if (this.underDataDir(real)) return { allowed: true, safePath: real };
        if (this.readFenceEnabled()) return this.readFenceDecision(real);
        return { allowed: true, safePath: real };
      }

      // 写分支（D2/D3）：信任域放行；域外按档位；隔离链根外恒拒（程序化隔离，spec D2 边界）
      if (inUserConfig || inActiveRoot || inAdditional || inMainRoot) return { allowed: true, safePath: real };
      if (this.isolatedRootReal !== null) {
        return { allowed: false, reason: `COMMAND_DENIED: path escapes the isolated worktree root: ${real}` };
      }
      const mode = this.guard.mode;
      if (mode === 'plan') return { allowed: false, reason: 'COMMAND_DENIED: plan mode allows read-only operations only' };
      if (mode === 'dontAsk') return { allowed: true, safePath: real };
      return {
        allowed: false,
        ask: true,
        askDir: path.dirname(real),
        safePath: real,
        reason: `COMMAND_DENIED: write outside trusted roots requires approval: ${real}`,
      };
    } catch (error) {
      return { allowed: false, reason: `COMMAND_DENIED: path resolution failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
```

⑥ 新增私有/公开辅助（紧邻 resolveSafe）：

```ts
  /** D1 读围栏开关（SUNSHINEX_READ_FENCE，onOff，缺省关） */
  private readFenceEnabled(): boolean {
    const v = process.env.SUNSHINEX_READ_FENCE;
    if (v === 'on' || v === 'true') return true;
    if (v === 'off' || v === 'false') return false;
    return false;
  }

  /** fence 触发后的读判据（spec 5.1 读分支：manual=ask、其余档=拒） */
  private readFenceDecision(real: string): GuardDecision {
    if (this.guard.mode === 'manual') {
      return {
        allowed: false,
        ask: true,
        askDir: path.dirname(real),
        safePath: real,
        reason: `COMMAND_DENIED: read outside trusted roots requires approval (read fence enabled): ${real}`,
      };
    }
    return { allowed: false, reason: `COMMAND_DENIED: read fence blocks reads outside trusted roots: ${real}` };
  }

  /** 文件工具规则匹配 specifiers：绝对 posix（去首 /）/ root 相对 posix / basename */
  private pathRuleSpecifiers(real: string): string[] {
    const posix = real.split(path.sep).join('/');
    const noLead = posix.startsWith('/') ? posix.slice(1) : posix;
    const rel = path.relative(this.rootReal, real).split(path.sep).join('/');
    const base = posix.slice(posix.lastIndexOf('/') + 1);
    return [...new Set([noLead, rel, base])];
  }

  /** 路径工具输入的 path 字段归一读取 */
  private rawPath(input: unknown): string {
    if (typeof input === 'object' && input !== null && typeof (input as { path?: unknown }).path === 'string') {
      return (input as { path: string }).path;
    }
    return String(input ?? '');
  }
```

⑦ `evaluateAsync` **整体替换**（ask 路由进 guard.resolveAsk；非路径工具语义不变）：

```ts
  async evaluateAsync(tool: string, input: unknown): Promise<GuardDecision> {
    const decision = await this.guard.preToolUseAsync(tool, input);
    if (!decision.allowed) return decision;
    if (!PATH_TOOLS.has(tool)) return { allowed: true };
    const resolved = this.resolveSafe(this.rawPath(input), tool);
    if (resolved.allowed || resolved.ask !== true) return resolved;
    // 链侧 ask 路由（spec 5.1 写/读分支）：'always' 目录登记，会话内同目录后续读写免批
    const askDecision = await this.guard.resolveAsk({
      id: this.guard.nextApprovalId(),
      kind: tool === 'Write' ? 'write' : 'read',
      subject: this.rawPath(input),
      reason: resolved.reason,
    });
    if (askDecision === null) return resolved;
    if (askDecision === 'deny') return { allowed: false, reason: 'COMMAND_DENIED: rejected by user' };
    if (askDecision === 'always' && resolved.askDir !== undefined) this.guard.allowSessionDir(resolved.askDir);
    return { allowed: true, safePath: resolved.safePath };
  }
```

（`resolveSafe` 的调用入参若现实现以其它形式从 input 取路径，保留其取值语义、仅替换 ask 路由段——以 `rawPath` 为准归一。）

⑧ `withRoot` 与 `withMemoryScope` 两个克隆方法：在既有共享引用赋值处（guard/backend/dryrun）之后各追加两行：

```ts
    child.permissions = this.permissions;
    child.additionalDirs = this.additionalDirs;
```

（`additionalDirs` 为原地变更的共享实例——见 setAdditionalDirs 注释；`additionalDirs` 字段声明相应从 `private readonly additionalDirs: string[] = []` 确认为 const 数组引用。）

- [ ] **Step 4: 运行确认通过**

Run: `pnpm build 2>&1 | grep -E "error TS" ; node --test dist/harness/security/chain.boundary.test.js dist/harness/security/chain.settings-protect.test.js 2>&1 | tail -3`
Expected: boundary 全 PASS；settings-protect 既有语义（settings 保护、记忆开关）零回归。

- [ ] **Step 5: Commit**

```bash
git add src/harness/security/chain.ts src/harness/security/chain.boundary.test.ts
git commit -m "feat(security): resolveSafe v2 判定序——读全放+fence/写审批化/信任目录/用户规则/.git 硬保护"
```

---

### Task 4: Landlock 接缝（探测/包装/降级单点）+ 可选依赖登记

**Files:**
- Create: `src/harness/security/landlock.ts`
- Modify: `package.json`（optionalDependencies）
- Test: `src/harness/security/landlock.test.ts`（新建）

**Interfaces:**
- Consumes: `@deepseek-ai/node-addon-landlock-run`（ESM-only；契约 `launcherPath(): string`、`probe(launcher: string): string`（非 `'unusable'` 即可用）、`grantArgs({readOnly, readWrite}): string[]`）
- Produces（后续任务依赖，签名逐字）:
  - `interface LandlockWrap { file: string; args: string[] }`
  - `async function landlockWrap(writableRoots: string[]): Promise<LandlockWrap | null>`
  - `function sandboxEnabled(): boolean`、`async function resolveIsolation(): Promise<'landlock' | 'container' | 'host'>`
  - `configureLandlockLoader(custom: Loader | null): void`、`resetLandlockProbe(): void`（测试注入口）

- [ ] **Step 1: 登记可选依赖并安装**

`package.json` 顶层（与 dependencies 并列）追加：

```json
  "optionalDependencies": {
    "@deepseek-ai/node-addon-landlock-run": "^0.1.1"
  },
```

Run: `pnpm install 2>&1 | tail -3`
Expected: 安装成功（沙箱无外网时不阻塞后续步骤——本地结构类型 + 动态 import 降级保证编译与测试全绿，真实包在部署机生效）。

- [ ] **Step 2: 写失败测试**

```ts
// src/harness/security/landlock.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import { configureLandlockLoader, landlockWrap, resetLandlockProbe, sandboxEnabled } from './landlock';

const fakeModule = {
  launcherPath: () => '/fake/landlock-launcher',
  probe: (_launcher: string) => 'ok',
  grantArgs: (g: { readOnly: string[]; readWrite: string[] }) => ['--rw', ...g.readWrite, '--ro', ...g.readOnly],
};

test('可用 seam：launcher 前缀组装，可写根去重保序，只读放行整盘', async () => {
  configureLandlockLoader(async () => fakeModule);
  resetLandlockProbe();
  const wrap = await landlockWrap(['/a', '/b', '/a']);
  if (process.platform !== 'linux') return assert.equal(wrap, null);
  assert.notEqual(wrap, null);
  assert.equal(wrap!.file, '/fake/landlock-launcher');
  assert.deepEqual(wrap!.args, ['--rw', '/a', '/b', '--ro', '/']);
});

test('SUNSHINEX_SANDBOX=off 一键关（seam 可用亦不包装）', async () => {
  configureLandlockLoader(async () => fakeModule);
  resetLandlockProbe();
  process.env.SUNSHINEX_SANDBOX = 'off';
  try {
    assert.equal(await landlockWrap(['/a']), null);
    assert.equal(sandboxEnabled(), false);
  } finally {
    delete process.env.SUNSHINEX_SANDBOX;
  }
  assert.equal(sandboxEnabled(), true);
});

test('包缺失/内核探测不可用：静默降级返回 null（不抛错不阻断）', async () => {
  configureLandlockLoader(async () => null);
  resetLandlockProbe();
  assert.equal(await landlockWrap(['/a']), null);
  configureLandlockLoader(async () => ({ ...fakeModule, probe: () => 'unusable' }));
  resetLandlockProbe();
  assert.equal(await landlockWrap(['/a']), null);
});

test('不存在路径从可写根过滤剔除', async () => {
  configureLandlockLoader(async () => fakeModule);
  resetLandlockProbe();
  if (process.platform !== 'linux') return;
  const wrap = await landlockWrap([os.tmpdir(), '/definitely-not-exist-xyz']);
  assert.notEqual(wrap, null);
  assert.equal(wrap!.args.includes('/definitely-not-exist-xyz'), false);
  assert.equal(wrap!.args.includes(os.tmpdir()), true);
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm build 2>&1 | grep -E "error TS" ; node --test dist/harness/security/landlock.test.js 2>&1 | tail -5`
Expected: 编译失败（模块不存在）——失败即预期。

- [ ] **Step 4: 实现 landlock.ts（全文新建）**

```ts
/**
 * Landlock 接缝（spec 5.4）：Linux 内核级 exec 写围栏，self-restrict-then-exec launcher 形态（Codex 同款）。
 * 收敛边界：本文件单点。包缺失/非 Linux/内核不支持 → 一律返回 null，调用方原样 spawn
 * （对标 MCP 装配失败警告降级语义：不阻断）；SUNSHINEX_SANDBOX=off 一键关（'require' 硬门保留 roadmap）。
 * 模块系统缝：包为 ESM-only 且 tsconfig module=CommonJS 会把 import() 下溯为 require()，
 * 故经 new Function 构造不经转译的真动态 import；本地结构类型避免编译期静态依赖（optionalDependencies 缺失可编译）。
 */
import * as fs from 'fs';

interface LandlockModule {
  launcherPath(): string;
  probe(launcher: string): string;
  grantArgs(grants: { readOnly: string[]; readWrite: string[] }): string[];
}

export interface LandlockWrap {
  file: string;
  args: string[];
}

const dynamicImport = new Function('specifier', 'return import(specifier);') as (s: string) => Promise<unknown>;

const realLoader = async (): Promise<LandlockModule | null> => {
  try {
    return (await dynamicImport('@deepseek-ai/node-addon-landlock-run')) as LandlockModule;
  } catch {
    return null;
  }
};

let loader: Loader = realLoader;
type Loader = () => Promise<LandlockModule | null>;

/** 测试注入口；传 null 恢复真实装载器 */
export function configureLandlockLoader(custom: Loader | null): void {
  loader = custom ?? realLoader;
}

let probeCache: Promise<boolean> | null = null;

/** 探测结果缓存复位（测试隔离用；运行期进程级缓存即可用性单调） */
export function resetLandlockProbe(): void {
  probeCache = null;
}

async function usable(): Promise<boolean> {
  if (probeCache === null) {
    probeCache = (async () => {
      if (process.platform !== 'linux') return false;
      const mod = await loader();
      if (mod === null) return false;
      try {
        return mod.probe(mod.launcherPath()) !== 'unusable';
      } catch {
        return false;
      }
    })();
  }
  return probeCache;
}

/** SUNSHINEX_SANDBOX（onOff，缺省 on） */
export function sandboxEnabled(): boolean {
  const v = process.env.SUNSHINEX_SANDBOX;
  if (v === 'off' || v === 'false') return false;
  return true;
}

/** 组装 launcher argv 前缀（launcher …grantArgs -- 后由调用方接 shell 与命令）；不可用/关闭/无有效可写根 → null */
export async function landlockWrap(writableRoots: string[]): Promise<LandlockWrap | null> {
  if (!sandboxEnabled()) return null;
  if (!(await usable())) return null;
  const mod = await loader();
  if (mod === null) return null;
  const roots = [...new Set(writableRoots.map((r) => r.trim()).filter((r) => r.length > 1 && fs.existsSync(r)))];
  if (roots.length === 0) return null;
  return { file: mod.launcherPath(), args: mod.grantArgs({ readOnly: ['/'], readWrite: roots }) };
}

/** 隔离口径解析（spec 5.5）：SUNSHINEX_ISOLATION 显式声明优先，auto = landlock 探测 → 容器标记 → host */
export async function resolveIsolation(): Promise<'landlock' | 'container' | 'host'> {
  const override = process.env.SUNSHINEX_ISOLATION;
  if (override === 'landlock' || override === 'container' || override === 'host') return override;
  if (await usable()) return 'landlock';
  try {
    if (fs.existsSync('/.dockerenv')) return 'container';
  } catch {
    /* 探测失败按 host 口径 */
  }
  return 'host';
}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm build 2>&1 | grep -E "error TS" ; node --test dist/harness/security/landlock.test.js 2>&1 | tail -3`
Expected: 全部 PASS（非 Linux 平台按平台条件分支断言 null 形态）。

- [ ] **Step 6: Commit**

```bash
git add src/harness/security/landlock.ts src/harness/security/landlock.test.ts package.json pnpm-lock.yaml
git commit -m "feat(security): landlock 接缝单点——launcher 探测/包装/降级 + isolation 口径解析 + 可选依赖登记"
```

---

### Task 5: exec 围栏接线（ExecOpts.wrap → ProcessSandbox 消费；前台 run 内联、后台经 gate.execWrap）

**Files:**
- Modify: `src/types.ts`（ExecOpts、RuntimeSafetyGate、ToolBackend.execBackground opts）
- Modify: `src/harness/security/chain.ts`（run 内联 wrap + execWrap 视图方法 + landlockWritableRoots）
- Modify: `src/harness/security/sandbox.ts`（exec 两分支与 execBackground 消费 wrap）
- Modify: `src/harness/tools/builtin.ts`（exec 执行器后台分支）
- Test: `src/harness/security/sandbox.wrap.test.ts`（新建）

**Interfaces:**
- Consumes: Task 4 的 `landlockWrap`/`LandlockWrap`、Task 1 的 `guard.sessionDirList`；既有 `execCwd`/`execCommandAllowed`/`activeRootPath`/`isolatedRootPath`
- Produces:
  - `types.ts`: `ExecOpts` 增 `wrap?: { file: string; args: string[] }`；`RuntimeSafetyGate` 增可选 `execWrap?(cmd: string): Promise<{ file: string; args: string[] } | null>`；`ToolBackend.execBackground` 的 opts 形状增 `wrap?`（与 `ProcessSandbox.execBackground` 实现同步）
  - `SafetyChain`: `async execWrap(cmd: string): Promise<ExecOpts['wrap'] | null>`（registry 注入的 gate 视图自动携带——gate 即链实例）

- [ ] **Step 1: 写失败测试**

```ts
// src/harness/security/sandbox.wrap.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProcessSandbox } from './sandbox';

test('ExecOpts.wrap：wrap.file 接管进程位，grant 前缀 + `--` + shell + 命令依次入 argv', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sbx-wrap-'));
  const script = path.join(tmp, 'argv.js');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(1)));');
  const sandbox = new ProcessSandbox();
  const r = await sandbox.exec('echo hi', { wrap: { file: process.execPath, args: [script] } });
  assert.ok(r.ok, JSON.stringify(r));
  const argv = JSON.parse(r.value.stdout.trim()) as string[];
  assert.equal(argv[0], script);
  assert.ok(argv.includes('--'), 'grant 段与 shell 段以 -- 分隔');
  assert.ok(argv.includes('echo hi'), '原命令保持在 shell 位置执行');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('execBackground 同形态消费 wrap', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sbx-wrap-bg-'));
  const script = path.join(tmp, 'argv.js');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(1)));');
  const sandbox = new ProcessSandbox();
  const bg = await sandbox.execBackground('echo hi-bg', { wrap: { file: process.execPath, args: [script] } });
  const out = await new Promise<string>((resolve) => {
    let acc = '';
    bg.onData?.((chunk: string) => { acc += chunk; });
    const timer = setTimeout(() => resolve(acc), 1500);
    void timer;
  });
  const argv = JSON.parse(out.trim()) as string[];
  assert.equal(argv[0], script);
  assert.ok(argv.includes('echo hi-bg'));
  await sandbox.killBackground(bg);
  fs.rmSync(tmp, { recursive: true, force: true });
});
```

（`execBackground` 返回值形态以 `src/harness/security/sandbox.ts` 现实现为准：句柄含 `onData`/`onExit` 注入口与 `killBackground` 终止口；若字段名不同，按实际形态等价改写断言的数据流，不改语义。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build 2>&1 | grep -E "error TS" ; node --test dist/harness/security/sandbox.wrap.test.js 2>&1 | tail -5`
Expected: 编译失败（`ExecOpts.wrap` 不存在）——失败即预期。

- [ ] **Step 3: 实现**

① `src/types.ts`——`ExecOpts` 增字段：

```ts
  /** Landlock launcher 前缀（spec 5.4）：由安全链组装、ProcessSandbox 消费；缺省无围栏 */
  wrap?: { file: string; args: string[] };
```

`RuntimeSafetyGate` 增可选方法：

```ts
  /** 后台 exec 分支的 landlock 包装（spec 5.4；前台在 chain.run 内联；缺省无围栏） */
  execWrap?(cmd: string): Promise<{ file: string; args: string[] } | null>;
```

`ToolBackend.execBackground` 的 opts 形状同步增 `wrap?: { file: string; args: string[] }`。

② `src/harness/security/chain.ts`——`run` 方法体替换如下（既有 `execCommandAllowed` 判界闸门原样保留于最前；若现实现的 gate 判定/失败返回形态与下文有出入，以现实现为准原样保留，仅插入 wrap 两行）：

```ts
  async run(cmd: string, opts?: ExecOpts): Promise<Result<ExecResult>> {
    const gate = this.execCommandAllowed(cmd);
    if (!gate.allowed) return Promise.resolve(fail('EXEC_OUT_OF_TREE', gate.reason));
    const wrap = await this.execWrap(cmd);
    return this.backend.exec(cmd, { ...opts, ...(wrap !== null ? { wrap } : {}) });
  }
```

新增两方法（`execCwd`/`execCommandAllowed` 旁）：

```ts
  /** RuntimeSafetyGate 视图：后台分支 landlock 包装（前台在 run 内联；registry 注入的 gate 即链实例，fork 克隆自动携带） */
  async execWrap(_cmd: string): Promise<ExecOpts['wrap']> {
    return landlockWrap(this.landlockWritableRoots());
  }

  /** landlock 可写根（spec 5.4）：活动根/隔离根 ∪ 信任目录 ∪ 会话放行目录 ∪ ~/.sunshinex ∪ 数据目录 ∪ 系统临时目录 */
  private landlockWritableRoots(): string[] {
    const base = this.activeRootPath ?? (this.isolatedRootPath ?? this.root);
    return [base, ...this.additionalDirs, ...this.guard.sessionDirList(), userConfigDir(), dataDirReal(this.root), os.tmpdir()];
  }
```

import 区追加：

```ts
import { landlockWrap } from './landlock';
```

③ `src/harness/security/sandbox.ts`——`exec` 内 `resolveShell()` 之后、两分支（timeoutToBackground 的 spawn 与常规 execFile）之前组装 argv，两分支改用统一的 `file`/`args`：

```ts
    const shell = resolveShell();
    const file = opts?.wrap !== undefined ? opts.wrap.file : shell.file;
    const args = opts?.wrap !== undefined
      ? [...opts.wrap.args, '--', shell.file, ...shell.args, cmd]
      : [...shell.args, cmd];
```

`execBackground` 同形态消费（spawn 的 file/args 同上两行改法）。

④ `src/harness/tools/builtin.ts`——exec 执行器**后台分支**（`backend.execBackground(...)` 调用处；先 `grep -n "execBackground" src/harness/tools/builtin.ts` 定位）在其 opts 对象追加 wrap：

```ts
        const wrap = gateView.execWrap !== undefined ? await gateView.execWrap(cmd) : null;
```

并把后台调用 opts 改为 `{ cwd: gateView.execCwd(), ...(wrap !== null ? { wrap } : {}), ...其余既有字段 }`（前台分支零改动——`safety.run` 已在链内联包装）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm build 2>&1 | grep -E "error TS" ; node --test dist/harness/security/sandbox.wrap.test.js dist/harness/security/landlock.test.js 2>&1 | tail -3`
Expected: 全部 PASS。chain.run→execWrap 的前台集成由本测试与 landlock 单测拼合覆盖；真实内核探针手动执行不入库（对标 ci.yml「探针不入库、开发机手动」口径）。

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/harness/security/chain.ts src/harness/security/sandbox.ts src/harness/tools/builtin.ts src/harness/security/sandbox.wrap.test.ts
git commit -m "feat(security): exec 围栏接线——ExecOpts.wrap 前后台贯通，landlock 可写根单点组装"
```

---

### Task 6: 装配三面同源（Harness 权限注入 + --add-dir 可重复 flag + /add-dir 斜杠）

**Files:**
- Modify: `src/harness/index.ts`（HarnessOptions.addDirs、ctor 权限注入、addAdditionalDir、permissionWarnings）
- Modify: `src/runtime.ts`（buildDeps 透传 addDirs）
- Modify: `src/cli/index.ts`（parseArgs 可重复 flag + flagList + usage 行）
- Modify: `src/tui/entry.ts`、`src/tui/runtime.ts`（TUI 面透传）
- Modify: `src/tui/slash-commands.ts`、`src/tui/session.ts`（/add-dir 斜杠）
- Test: `src/cli/flags.test.ts`、`src/harness/assembly.permissions.test.ts`（均新建）

**Interfaces:**
- Consumes: Task 2 `loadPermissions`、Task 3 `setPermissions`/`setAdditionalDirs`/`addAdditionalDir`
- Produces:
  - `HarnessOptions` 增 `addDirs?: string[]`；`Harness.addAdditionalDir(dir: string): { ok: boolean; message: string }`；`Harness.permissionWarnings(): string[]`
  - `cli/index.ts`: `export function parseArgs(...)`（加导出）、`export function flagList(flags: CliArgs['flags'], name: string): string[]`

- [ ] **Step 1: 写失败测试**

```ts
// src/cli/flags.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, flagList } from './index';

test('parseArgs：--add-dir 可重复收集为数组，其余 flag 语义不变', () => {
  const args = parseArgs(['run', '.', '--add-dir=/a', '--add-dir=/b', '--mode=manual', '--yes']);
  assert.deepEqual(flagList(args.flags, 'add-dir'), ['/a', '/b']);
  assert.equal(args.flags.mode, 'manual');
  assert.equal(args.flags.yes, true);
});

test('flagList：单值/数组/缺省三态归一', () => {
  assert.deepEqual(flagList({ 'add-dir': '/x' }, 'add-dir'), ['/x']);
  assert.deepEqual(flagList({ 'add-dir': ['/x', '/y'] }, 'add-dir'), ['/x', '/y']);
  assert.deepEqual(flagList({}, 'add-dir'), []);
  assert.deepEqual(flagList({ 'add-dir': '' }, 'add-dir'), []);
});
```

```ts
// src/harness/assembly.permissions.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';

// Harness 最小构造形态与本文件既有 harness 级测试保持一致（参照 mcp 装配用例的 new Harness 写法）

test('装配：settings permissions 注入后链侧生效 + permissionWarnings 通道', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-asm-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-asm-root-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(root, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sunshinex', 'settings.json'), JSON.stringify({
      permissions: { deny: ['Write(**/.env)'], additionalDirs: ['nonexistent-dir-xyz'] },
    }));
    const h = new Harness({ root, mode: 'dontAsk' });
    const d = h.safety.evaluate('Write', { path: path.join(root, 'x.env') });
    assert.equal(d.allowed, false);
    assert.ok(h.permissionWarnings().length >= 1, 'additionalDirs 不存在路径保留原样（不告警）或形状告警均走 warnings 通道');
    const outside = path.join(path.dirname(root), 'w.txt');
    assert.equal(h.safety.evaluate('Write', { path: outside }).allowed, true);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('addAdditionalDir：运行期扩目录读写放行，缺失路径报错', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-asm2-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-asm2-root-'));
  const trust = path.join(path.dirname(root), 'trusted-x');
  fs.mkdirSync(trust, { recursive: true });
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const h = new Harness({ root, mode: 'manual' });
    const bad = h.addAdditionalDir(path.join(root, 'no-such-dir'));
    assert.equal(bad.ok, false);
    const ok = h.addAdditionalDir(trust);
    assert.equal(ok.ok, true);
    assert.equal(h.safety.evaluate('Write', { path: path.join(trust, 'a.txt') }).allowed, true);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build 2>&1 | grep -E "error TS" ; node --test dist/cli/flags.test.js dist/harness/assembly.permissions.test.js 2>&1 | tail -5`
Expected: 编译失败（`flagList`/`addDirs`/`addAdditionalDir`/`permissionWarnings` 不存在）——失败即预期。

- [ ] **Step 3: 实现**

① `src/harness/index.ts`：

`HarnessOptions` 增字段：

```ts
  /** D3：CLI/TUI 显式扩目录（与 settings permissions.additionalDirs 合并，三面同源） */
  addDirs?: string[];
```

ctor 内，`const mcpServers = loadMcpServers(base);` 之后、guard 构造之前插入：

```ts
    // 用户权限规则面（spec 5.2）：两级装载合并不遮蔽；非路径通道（Bash/mcp/web）注入 PolicyEngine，路径通道由链消费
    const perms = loadPermissions(base);
    const policy = new PolicyEngine();
    for (const rule of perms.config.deny) policy.add('deny', rule);
    for (const rule of perms.config.allow) policy.add('allow', rule);
```

guard 构造改为复用该 policy：`new SecurityGuard(policy, opts.mode ?? 'dontAsk', mcpServers.map((s) => s.name))`。

`safety` 构造之后追加：

```ts
    this.safety.setPermissions(perms.config);
    this.safety.setAdditionalDirs([...perms.config.additionalDirs, ...(opts.addDirs ?? [])]);
    this.permissionWarningList = perms.warnings;
```

类内增字段与方法：

```ts
  private permissionWarningList: string[] = [];

  /** permissions 装载告警（spec 5.2 单级形状非法跳过）；selfcheck 上屏 */
  permissionWarnings(): string[] {
    return [...this.permissionWarningList];
  }

  /** /add-dir 运行期通道（spec 5.3）：realpath 归一后并入信任目录集 */
  addAdditionalDir(dir: string): { ok: boolean; message: string } {
    try {
      const abs = path.resolve(dir);
      if (!fs.existsSync(abs)) return { ok: false, message: abs };
      this.safety.addAdditionalDir(abs);
      return { ok: true, message: abs };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
```

（`fs`/`path` 若未导入则补 `import * as fs from 'fs'` / `import * as path from 'path'`；`loadPermissions` 从 `../config/permissions` 导入。）

② `src/cli/index.ts`：

`parseArgs` 加 `export`；flags 赋值段替换为可重复收集：

```ts
const REPEATABLE_FLAGS = new Set(['add-dir']);
```

```ts
      } else if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
        const value: string | boolean = eq === -1 ? true : a.slice(eq + 1);
        if (REPEATABLE_FLAGS.has(key) && typeof value === 'string') {
          const prev = flags[key];
          flags[key] = prev === undefined ? value : typeof prev === 'string' ? [prev, value] : [...prev, value];
        } else {
          flags[key] = value;
        }
      }
```

`CliArgs.flags` 类型放宽为 `Record<string, string | boolean | string[]>`（消费面均为 `typeof === 'string'` 或 `=== true` 形态守卫，编译验证兜底）。

新增导出：

```ts
/** 可重复 flag 取值归一（spec 5.3 --add-dir）：单值/数组/缺省统一 string[] */
export function flagList(flags: CliArgs['flags'], name: string): string[] {
  const v = flags[name];
  if (typeof v === 'string') return v === '' ? [] : [v];
  if (Array.isArray(v)) return v;
  return [];
}
```

usage 双语 flags 行各追加（英文块 flags 行尾、中文块 flags 行尾）：

```text
 --add-dir=<dir>(repeatable) extend trusted dirs
```
```text
 --add-dir=<目录>（可重复）扩展信任目录
```

③ `src/runtime.ts`——`buildDeps` 增 `addDirs` 透传（先 `grep -n "new Harness" src/runtime.ts` 定位构造点）：

```ts
    new Harness({ root, mode: 'dontAsk', ask: createCliAskSeam(), addDirs });
```

（`addDirs` 由调用方从 `flagList(args.flags, 'add-dir')` 传入；`buildDeps` 签名相应增参，`run-loop`/`run-pipeline` 调用处传 `flagList(args.flags, 'add-dir')`。）

④ `src/tui/entry.ts`：解析 `flagList(args.flags, 'add-dir')` 随既有 opts 传入 `createRuntime`；`src/tui/runtime.ts`：`TuiRuntimeOpts` 增 `addDirs?: string[]`，`new Harness({ ..., addDirs: opts.addDirs })`。

⑤ `src/tui/slash-commands.ts`：`SLASH_COMMANDS` 追加 `'/add-dir'`；`src/tui/session.ts`：`FREE_TEXT_ARGS` 追加 `'/add-dir'`；`slashHelp()` 命令清单追加一行：

```ts
    t('  /add-dir <dir>  extend trusted directories (read+write, this session)', '  /add-dir <dir>  扩展信任目录（读写，本会话内生效）'),
```

`handleSlash` 分发（置于既有分支同层，消息上屏复用本文件相邻分支同一形态）：

```ts
    if (cmd === '/add-dir') {
      const arg = text.slice(cmd.length).trim();
      if (arg === '') {
        this.pushMessage({ type: 'error', text: t('/add-dir requires a directory path', '/add-dir 需要目录路径') });
        return;
      }
      const r = this.runtime.harness.addAdditionalDir(arg);
      this.pushMessage({
        type: r.ok ? 'system' : 'error',
        text: r.ok
          ? t(`trusted directory added: ${r.message}`, `信任目录已添加：${r.message}`)
          : t(`failed to add directory: ${r.message}`, `信任目录添加失败：${r.message}`),
      });
      return;
    }
```

⑥ 斜杠候选池：`grep -rn "candidates" src/tui/components src/tui/session.ts | head` 定位内置命令候选清单（提交 2999b3c 引入的前缀匹配候选），将 `'/add-dir'` 加入内置段。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm build 2>&1 | grep -E "error TS" ; node --test dist/cli/flags.test.js dist/harness/assembly.permissions.test.js 2>&1 | tail -3`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/harness/index.ts src/runtime.ts src/cli/index.ts src/tui/entry.ts src/tui/runtime.ts src/tui/slash-commands.ts src/tui/session.ts src/cli/flags.test.ts src/harness/assembly.permissions.test.ts
git commit -m "feat(security): --add-dir 三面同源 + permissions 装配注入 + /add-dir 斜杠通道"
```

---

### Task 7: selfcheck isolation 行 + 文档对齐 + 全量验证

**Files:**
- Modify: `src/cli/commands/selfcheck.ts`
- Modify: `docs/CLAUDE.md`、`MANUAL.md`、`README.md`

**Interfaces:**
- Consumes: Task 4 的 `resolveIsolation`/`sandboxEnabled`、Task 6 的 `permissionWarnings()`

- [ ] **Step 1: selfcheck 增加 isolation 行与 permissions 告警行**

在 `shell :` 行打印之后追加（`runSelfcheck` 为 async，与 `await h.mcpReady()` 同上下文）：

```ts
    for (const w of h.permissionWarnings()) {
      console.log(`permissions warn: ${w}`);
    }
    const isolation = await resolveIsolation();
    console.log(`isolation : ${isolation}${sandboxEnabled() ? '' : ' (sandbox off)'}`);
```

import 区追加：

```ts
import { resolveIsolation, sandboxEnabled } from '../../harness/security/landlock';
```

- [ ] **Step 2: CLAUDE.md §5 依赖台账追加一行（表格末行后）**

```markdown
| @deepseek-ai/node-addon-landlock-run | exec 内核级写围栏（Landlock self-restrict-then-exec launcher，Linux-only），收敛于 `src/harness/security/landlock.ts` 接缝；包缺失/内核不支持静默降级不阻断 | SUNSHINEX_SANDBOX=off 回 JS 层检查 + 容器部署口径 |
```

- [ ] **Step 3: CLAUDE.md §14 平台差异登记追加一条（「平台差异登记」小节）**

```markdown
- **Landlock exec 写围栏（2026-09-24）**：Linux-only（launcher 功能探测内核 landlock ABI），macOS/Windows 为 host 口径（manual 档审批流兜底）；隔离口径三态 `landlock | container | host`，经 `SUNSHINEX_ISOLATION` 显式声明或缺省 auto 探测，selfcheck `isolation :` 行上屏；`SUNSHINEX_SANDBOX=off` 一键关；容器部署时边界层由 Skills Docker 承担
```

- [ ] **Step 4: MANUAL.md 配置文档对齐**

在 mcp.json 小节之后新增小节（标题与正文）：

```markdown
### permissions 权限规则与信任目录

settings.json 支持结构化 `permissions` 键（全局 `~/.sunshinex/settings.json` 与项目 `.sunshinex/settings.json` 两级合并生效，数组取并集）：

```json
{
  "permissions": {
    "deny": ["Write(*.pem)", "Bash(rm -rf*)", "Read(**/.env)"],
    "allow": ["Write(src/**)"],
    "additionalDirs": ["../lib-shared"]
  }
}
```

- 语法 `Tool(specifier)`：文件工具的 specifier 为路径 glob（`**` 跨段、`*` 不跨段、无 `/` 写法对文件名匹配，相对项目根书写）；`Bash(...)` 为命令匹配（尾 `*` 前缀）；`mcp__<server>__<tool>` 直名（尾 `*` 通配）
- `deny` 命中即拒、`allow` 命中免批；`additionalDirs` 为信任目录（读写同项目根，会话内生效）
- 运行期扩展：TUI 内 `/add-dir <目录>` 即时追加信任目录；CLI/TUI 启动参数 `--add-dir=<目录>`（可重复）

配套语义键：

| 键 | 环境槽 | 缺省 | 语义 |
|----|--------|------|------|
| readFence | SUNSHINEX_READ_FENCE | off | 开启后信任域外读取需审批（manual 档）/ 拒绝（其余档） |
| sandbox | SUNSHINEX_SANDBOX | on | Linux 下 exec 经 Landlock 内核围栏；off 一键关 |
| isolation | SUNSHINEX_ISOLATION | auto | 隔离口径声明：landlock / container / host，selfcheck 上屏 |
```

- [ ] **Step 5: README.md 特性描述补一句**

在安全/权限相关描述处（`grep -n "审批\|权限模式" README.md | head` 定位段落）追加：

```markdown
- 能力优先的文件权限边界：全盘可读、写面信任域 + 审批流、用户自定义 permissions 规则、Linux 下 Landlock 内核围栏（详见 MANUAL「permissions 权限规则与信任目录」）
```

- [ ] **Step 6: 全量验证**

Run: `pnpm build 2>&1 | grep -E "error TS" ; echo BUILD_OK && node scripts/run-tests.js 2>&1 | grep -E "^# (tests|pass|fail)" && node dist/cli/index.js selfcheck ; echo "SELFCHECK_EXIT=$?"`

Expected: `BUILD_OK`；全量 `# fail` 为 0（基线 1225+ 新增约 25 用例）；selfcheck 输出 `isolation :` 行且 exit 0。

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/selfcheck.ts docs/CLAUDE.md MANUAL.md README.md
git commit -m "docs(security): isolation 上屏 + 依赖台账/平台登记/permissions 与信任目录文档对齐"
```

---

## Self-Review Checklist（执行前自查锚点）

- Spec 覆盖映射：D1→Task 2（readFence 键）+ Task 3（读分支/fence）；D2→Task 1（Write 下放/resolveAsk）+ Task 3（写分支/'always' 登记）；D3→Task 3（信任目录）+ Task 6（三面同源）；D4→Task 4/5；D5→Task 2（装载/匹配）+ Task 3（链侧消费）+ Task 6（guard 注入）；D6→Task 3（.git 硬保护）；isolation 上屏→Task 7；spec §5.6 降级→Task 4（seam null 路径）+ Task 7（文档）
- 行为变更三则的测试改判落在 Task 1 Step 4 与 Task 3 Step 4 的全量回归步骤中
- 全部代码块为可编译完整片段；无 TBD/TODO/「适当处理」类占位
