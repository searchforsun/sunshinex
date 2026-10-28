# 四类资源存储与设置规范化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** skills/MCP/plugins/agents/providers 五类资源统一存储规范（项目遮蔽全局 + 元数据开关 + 单文件惯例）、共享 catalog 存储库、双向实时同步、CLI/TUI/GUI 三端统一管理面。

**Architecture:** 新建 `src/catalog/` 共享存储库（每类一个模块，作用域合并与遮蔽逻辑单点），harness 现有加载器收口为消费 catalog（单一事实源）；serve op 端点 + fs.watch + WS `config-changed` 帧承担实时；GUI 共享组件（ScopeSwitcher/SearchBar/ResourceCard/EditorDrawer）统一 11 页卡片风格；CLI/TUI 薄封装同一库。

**Tech Stack:** TypeScript + node:test（主仓）/ vitest（gui）、node:fs.watch（零新依赖）、cli-table3、React（gui）。

**Spec:** docs/superpowers/specs/2026-10-28-settings-storage-normalization-design.md（本计划从 spec 论证，执行者两份都读）

## Global Constraints

- **作用域统一规则**：MCP/agents/plugins/providers 一律项目遮蔽全局；skills 五兼容根链不动；settings 语义键 env > project > global 填充链不动。
- **写纪律**：所有结构化写 = 原子写（同目录 tmp + rename）+ JSONC 注释保护（含注释 → `CatalogWriteError('COMMENTS')` → 调用方 409 + `hint:'use raw editor'`，沿 `config-handlers.ts` 现语义）。
- **密钥纪律**：API key 只写 settings `env` 块（`SUNSHINEX_API_KEY_<UPPER>`），任何响应/日志不回显。
- **skills 只读**：无启停、无增删改端点/命令/表单。
- **零新依赖**：文件监听用 `node:fs.watch`；表格用已有 cli-table3。
- **i18n**：GUI 新字符串一律 `t(en, zh)` 内联双语、render-time 调用（不得冻结进模块常量）。
- **CLI scope**：`--scope` 默认 `project`（root=cwd，写时自动建 `.sunshinex/`），`--scope=global` 切全局，`--root=<dir>` 覆盖 cwd。
- **测试命令**：全量 = `pnpm test`（= clean + tsc + `node scripts/run-tests.js`）；聚焦 = `pnpm build && node --require scripts/test-env.cjs --test dist/<路径>/<file>.test.js`。gui：`pnpm --dir gui run typecheck` + `pnpm --dir gui run test`。测试不得直写 `~/.sunshinex`（run-tests.js 钉 `SUNSHINEX_DATA_DIR=.data-test`，直跑聚焦命令须同样钉 env）。
- **并行会话纪律**：`src/serve/daemon.ts`、`gui/src/connection.ts` 是另一活跃会话的热区——动手前先读工作区最新版；每任务提交前 `git pull --rebase`；只 `git add` 本任务文件。
- **提交格式**：conventional commits，中文主题（沿仓内惯例），一任务一提交。
- **GUI 路径**：设置页全部在 `gui/src/settings/`（无 pages/settings）。

---

## Phase A：catalog 存储库与 harness 收口（单一事实源）

### Task 1: catalog 基础（types + io 读写纪律单点）

**Files:**
- Create: `src/catalog/types.ts`
- Create: `src/catalog/io.ts`
- Test: `src/catalog/io.test.ts`

**Interfaces:**
- Produces:
  - `export type Scope = 'global' | 'project'`
  - `export type ResourceKind = 'mcp'|'agents'|'plugins'|'skills'|'providers'|'permissions'|'settings'`
  - `export interface Listing<T> { entries: T[]; warnings: string[] }`
  - `export class CatalogWriteError extends Error { readonly code: 'COMMENTS'|'INVALID' }`
  - `export function readJsoncDoc(file: string): { exists: boolean; raw: string; doc: Record<string, unknown>; hasComments: boolean; warnings: string[] }`
  - `export function writeJsonAtomic(file: string, text: string): void`（同目录 tmp + rename）
  - `export function ensureDir(dir: string): void`

- [ ] **Step 1: 写失败测试**

```ts
// src/catalog/io.test.ts
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { readJsoncDoc, writeJsonAtomic, CatalogWriteError } from './io';

test('readJsoncDoc: 缺文件 = exists false 空 doc 不算错', () => {
  const r = readJsoncDoc(join(mkdtempSync(join(tmpdir(), 'cat')), 'nope.json'));
  assert.equal(r.exists, false); assert.deepEqual(r.doc, {}); assert.equal(r.hasComments, false);
});
test('readJsoncDoc: JSONC 注释识别', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cat'));
  const f = join(dir, 'mcp.json'); writeFileSync(f, '{\n // 注释\n "a": 1 }\n');
  const r = readJsoncDoc(f); assert.equal(r.hasComments, true); assert.deepEqual(r.doc, { a: 1 });
});
test('writeJsonAtomic: 落盘原子且内容一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cat'));
  const f = join(dir, 'x.json'); writeJsonAtomic(f, '{"a":2}\n');
  assert.equal(readFileSync(f, 'utf8'), '{"a":2}\n');
});
test('CatalogWriteError 携带 code', () => {
  const e = new CatalogWriteError('COMMENTS', 'x'); assert.equal(e.code, 'COMMENTS');
});
```

- [ ] **Step 2: 跑测试确认失败**（模块不存在）：`pnpm build && node --require scripts/test-env.cjs --test dist/catalog/io.test.js` → FAIL "Cannot find module"
- [ ] **Step 3: 最小实现**

```ts
// src/catalog/io.ts —— 注释识别/剥离复用 settings.ts 既有词法单点：
// import { hasJsonComments, stripJsonComments } from '../config/settings'（未导出则就地加 export，实现零改动）
import * as fs from 'node:fs'; import * as path from 'node:path';
import { hasJsonComments, stripJsonComments } from '../config/settings';
export class CatalogWriteError extends Error { constructor(readonly code: 'COMMENTS' | 'INVALID', message: string) { super(message); } }
export function ensureDir(dir: string): void { fs.mkdirSync(dir, { recursive: true }); }
export function readJsoncDoc(file: string): { exists: boolean; raw: string; doc: Record<string, unknown>; hasComments: boolean; warnings: string[] } {
  if (!fs.existsSync(file)) return { exists: false, raw: '', doc: {}, hasComments: false, warnings: [] };
  const raw = fs.readFileSync(file, 'utf8');
  const hasComments = hasJsonComments(raw);
  try {
    const parsed = JSON.parse(stripJsonComments(raw));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { exists: true, raw, doc: {}, hasComments, warnings: [`${file} 根须为对象，已按空处理`] };
    }
    return { exists: true, raw, doc: parsed as Record<string, unknown>, hasComments, warnings: [] };
  } catch (e) {
    return { exists: true, raw, doc: {}, hasComments, warnings: [`${file} 解析失败：${(e as Error).message}`] };
  }
}
export function writeJsonAtomic(file: string, text: string): void {
  ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
}
```

- [ ] **Step 4: 跑测试通过** → PASS
- [ ] **Step 5: Commit** `feat(catalog): io 读写纪律单点——JSONC 容错读/原子写/CatalogWriteError`

### Task 2: catalog/mcp 读面（两级合并 + 遮蔽标注）

**Files:**
- Create: `src/catalog/mcp.ts`
- Test: `src/catalog/mcp.test.ts`

**Interfaces:**
- Consumes: `parseMcpJsonFile`（`src/config.ts` 已导出，输入文件路径 → `McpServerConfig[]`）、Task 1 的 io。
- Produces:
  - `export interface McpServerEntry { name: string; scope: Scope; shadowed: boolean; server: McpServerConfig; approval: 'none'|'approved'|'pending'|'denied' }`
  - `export function mcpJsonPath(scope: Scope, root: string | null, globalDir?: string): string`（global=`<userConfigDir>/mcp.json`；project=`<root>/.sunshinex/mcp.json`）
  - `export function listMcpServers(root: string | null, globalDir?: string): Listing<McpServerEntry>`——合并序：全局先、项目后；同名项目遮蔽（全局条目标 `shadowed:true` 保留在列）；`approval` 项目条目由 approvals 查（Task 3 前先恒 `'none'`，Task 3 接线），全局条目恒 `'none'`

- [ ] **Step 1: 失败测试**（钉三类断言）

```ts
// src/catalog/mcp.test.ts（globalDir/root 全部用 tmpdir 桩，禁止直写 ~/.sunshinex）
test('listMcpServers: 项目遮蔽全局同名，全局保留 shadowed 标注', () => {
  const g = mkdtempSync(join(tmpdir(), 'g')), p = mkdtempSync(join(tmpdir(), 'p'));
  writeFileSync(join(g, 'mcp.json'), JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['a'] }, api: { url: 'https://x' } } }));
  writeFileSync(join(p, '.sunshinex', 'mcp.json'), JSON.stringify({ mcpServers: { fs: { command: 'node', args: ['b'] } } }));
  const r = listMcpServers(p, g);
  const fsEntry = r.entries.find((e) => e.name === 'fs')!;
  assert.equal(fsEntry.scope, 'project'); assert.equal(fsEntry.server.command, 'node');
  const gFs = r.entries.filter((e) => e.name === 'fs');
  assert.equal(gFs.length, 2); assert.ok(gFs.some((e) => e.scope === 'global' && e.shadowed));
});
test('listMcpServers: 两级文件均缺 = 空表不报错；坏条目跳过进 warnings', () => { ... });
test('enabled:false 条目仍在列（列表面标停用，加载面过滤是加载器职责）', () => { ... });
```

- [ ] **Step 2: 跑失败** → FAIL
- [ ] **Step 3: 实现**：`listMcpServers` = 两次 `readJsoncDoc` + `parseMcpJsonFile`（缺文件跳过）+ 同名遮蔽标注 + 排序（scope: global 先；name 字典序）。
- [ ] **Step 4: 跑通过** → PASS
- [ ] **Step 5: Commit** `feat(catalog): mcp 两级合并读面——项目遮蔽全局+shadowed 标注`

### Task 3: catalog/approvals（项目 MCP 批准阀）

**Files:**
- Create: `src/catalog/approvals.ts`
- Modify: `src/config/settings.ts`（`SettingsDoc` 增加 `mcpApprovals?: unknown; mcpDenied?: unknown` 结构化键透传，沿 `plugins`/`imageHistoryLimit` 先例）
- Modify: `src/catalog/mcp.ts`（list 接 approval 标注）
- Test: `src/catalog/approvals.test.ts`

**Interfaces:**
- Produces:
  - `export function approvalState(root: string, name: string): 'approved' | 'pending' | 'denied'`（读全局 settings `mcpApprovals`/`mcpDenied`，键 = `projectSlug(root)`——复用/导出 `src/config/data-dir.ts` 的 `projectSlug`）
  - `export function approveMcpServer(root: string, name: string): void` / `export function denyMcpServer(root: string, name: string): void`（写全局 settings 两键；走 settings 结构化写既有纪律）
  - `listMcpServers` 的项目条目 `approval` 字段接到 `approvalState`

- [ ] **Step 1: 失败测试**

```ts
// approvals.test.ts：SUNSHINEX_PROJECTS_DIR 或 userConfigDir 桩（env 钉 tmp），断言：
// 1) 无记录 → 'pending'；2) approve 后 → 'approved'（settings.json 出现 mcpApprovals.<slug> 含 name）；
// 3) deny 后 → 'denied'；4) listMcpServers 项目条目 approval 反映状态、全局条目恒 'none'
```

- [ ] **Step 2: 跑失败** → FAIL
- [ ] **Step 3: 实现**（settings 结构化写复用 `surgicalSettingsUpdate` 的无注释路径：直接读 doc→改→`writeJsonAtomic`，含注释时抛 `CatalogWriteError('COMMENTS')`）
- [ ] **Step 4: 跑通过** → PASS
- [ ] **Step 5: Commit** `feat(catalog): 项目 MCP 批准阀——mcpApprovals/mcpDenied 结构化键+approval 标注接线`

### Task 4: loadMcpServers 收口（项目级复活 + 批准过滤）

**Files:**
- Modify: `src/config.ts:112-121`（`loadMcpServers`）
- Test: `src/config.test.ts`（既有测试文件追加用例；若无则新建 `src/config.mcp.test.ts`）

**Interfaces:**
- Consumes: Task 2/3 的 `listMcpServers` + `approvalState`。
- Produces: `loadMcpServers(projectRoot, globalDir?)` 签名不变（调用方 `src/harness/index.ts:140` 零改动），语义变为：两级合并（项目遮蔽全局）→ 过滤 `enabled === false` → 过滤项目级 `approval !== 'approved'`（未批准/拒绝不拉起进程）。

- [ ] **Step 1: 失败测试**

```ts
// 1) 项目 mcp.json 的 server（approved）出现在 loadMcpServers 结果；
// 2) 同名时项目条目胜出（command 取项目值）；3) 未批准项目条目被过滤、全局同名仍生效；
// 4) enabled:false 全局条目不再出现；5) denied 项目条目不出现
```

- [ ] **Step 2: 跑失败** → FAIL（现状 `void projectRoot`）
- [ ] **Step 3: 实现**：`loadMcpServers` 改为消费 catalog（合并 → enabled 过滤 → 项目条目 approval 过滤）；删除 `void projectRoot` 与「应用级」注释（注明 2026-10-28 裁定反转，指向 spec §1/§4）。
- [ ] **Step 4: 跑通过 + 全量 `pnpm test`**（MCP 相关既有测试如有「项目级忽略」断言，随裁定反转更新断言方向，提交信息注明）
- [ ] **Step 5: Commit** `feat(mcp): 项目级 mcp.json 装载复活+批准阀过滤——loadMcpServers 收口 catalog 单一事实源`

### Task 5: agents enabled + catalog 读面（两级 + 旧位置兼容）

**Files:**
- Create: `src/catalog/agents.ts`
- Modify: `src/harness/subagent.ts:67-74`（`parseAgentFrontmatter` 增 `enabled`）
- Test: `src/catalog/agents.test.ts`

**Interfaces:**
- Consumes: `parseFrontmatterKV`（skills.ts）、`parseAgentFrontmatter`。
- Produces:
  - `parseAgentFrontmatter` 返回值增 `enabled: boolean`（缺省 true，仅字面 `'false'` 为 false）
  - `export interface AgentEntry { id; scope: Scope; shadowed: boolean; oldLocation: boolean; dir: string; meta: { name; description; version; memory: boolean; isolation?; executor?; enabled: boolean }; bodyPreview: string }`
  - `export function agentsDir(scope: Scope, root: string | null, globalDir?: string): string`（global=`<userConfigDir>/agents`；project=`<root>/.sunshinex/agents`）
  - `export function legacyAgentsDir(root: string): string`（`<root>/agents`）
  - `export function listAgents(root: string | null, globalDir?: string): Listing<AgentEntry>`——合并序：global → project 新家（遮蔽，同 id 全局标 shadowed）→ legacy 旧位置（最低，仅新家与全局都没有该 id 时列出，标 `oldLocation:true`）；`enabled:false` 条目照列（视图可再启用）；`bodyPreview` = body 前 200 字符（沿 `loadAgentsView` 现口径）；宽容纪律：单文件畸形 → warnings，不 throw

- [ ] **Step 1: 失败测试**

```ts
// 1) 新家遮蔽全局（同 id，全局 shadowed:true）；2) 旧位置条目 oldLocation:true 且新家有同 id 时不再列出；
// 3) enabled:false 照列且 meta.enabled===false；4) 畸形 agent.md → warnings 非空、其余条目正常；
// 5) frontmatter enabled 缺省 true / 'false' → false
```

- [ ] **Step 2: 跑失败** → FAIL
- [ ] **Step 3: 实现**（读面纯函数；`parseAgentFrontmatter` 增量字段向后兼容）
- [ ] **Step 4: 跑通过** → PASS（`subagent.test` 全量回归确认零破坏）
- [ ] **Step 5: Commit** `feat(catalog): agents 读面——enabled 字段+两级新家+旧位置兼容+遮蔽标注`

### Task 6: catalog/agents 写面（upsert/remove/setEnabled/migrate）

**Files:**
- Modify: `src/catalog/agents.ts`
- Test: `src/catalog/agents.test.ts`（追加）

**Interfaces:**
- Consumes: `renderAgentMd`（现居 `src/serve/config-handlers.ts`，本任务迁入 catalog，serve 层改 import）；Task 1 io。
- Produces:
  - `export interface AgentUpsertSpec { name: string; description?: string; memory?: boolean; isolation?: 'worktree'; executor?: 'internal-team'|'external-cli'; body?: string; enabled?: boolean }`
  - `export function upsertAgent(root: string | null, scope: Scope, id: string, spec: AgentUpsertSpec): void`——写 `<agentsDir>/agents/<id>/agent.md`，写后 reparse round-trip 校验（沿 `handleAgentsPut` 现纪律），id 校验沿 `AGENT_ID_RE`
  - `export function removeAgent(root: string | null, scope: Scope, id: string): void`（rm -rf 该 id 目录；不存在 → `CatalogWriteError('INVALID')`）
  - `export function setAgentEnabled(root, scope, id, enabled: boolean): void`——读 agent.md → frontmatter 增/改 `enabled` 行（保序：插在 description 后）→ 原子写回 + reparse
  - `export function migrateAgent(root: string, id: string): void`——legacy → 新家 copy（cp 目录），旧目录保留不删

- [ ] **Step 1: 失败测试**

```ts
// 1) upsert 写出文件 reparse 字段全对（含 enabled 缺省 true）；2) setAgentEnabled false → 文件含 enabled: false 且 listAgents meta.enabled===false；
// 3) 再 setAgentEnabled true → frontmatter 行更新非新增重复；4) removeAgent 后 listAgents 不再含；
// 5) migrateAgent 后新家存在同内容文件、旧位置仍在；6) 非法 id → CatalogWriteError('INVALID')
```

- [ ] **Step 2: 跑失败** → FAIL
- [ ] **Step 3: 实现**（renderAgentMd 从 config-handlers 迁入时保持输出字节级一致——先抄测试：把 `config-handlers.test` 中 render 相关断言随迁）
- [ ] **Step 4: 跑通过** → PASS
- [ ] **Step 5: Commit** `feat(catalog): agents 写面——upsert/remove/setEnabled/migrate，renderAgentMd 收口`

### Task 7: AgentRegistry 收口（三级装载 + enabled 剔除）

**Files:**
- Modify: `src/harness/subagent.ts:92-115`（`loadAgents`/`loadAgentsFrom`）
- Modify: `src/harness/subagent.ts:153-188`（`loadAgentsView` 改为 catalog `listAgents` 薄委托或迁除）
- Test: `src/harness/subagent.test.ts`（既有，追加用例）

**Interfaces:**
- Consumes: Task 5/6 catalog agents。
- Produces: `loadAgents(projectRoot, globalDir?)` 装载序变为 global → legacy `<root>/agents` → 新家 `<root>/.sunshinex/agents`（后装遮蔽同 id）；`enabled === false` 条目不进注册表（运行时剔除，视图不受影响）。fail-fast 纪律讨论：现状单文件畸形整次 throw；catalog list 是宽容视图。**装配面保持 fail-fast**（沿现状），仅 view 迁宽容。

- [ ] **Step 1: 失败测试**

```ts
// 1) 新家 agent 遮蔽 legacy 同 id（resolve 取新家 framing）；2) enabled:false 的 agent 不进注册表（resolve throw/返回 builtin 回退沿现状语义）；
// 3) loadAgentsView 输出与 catalog listAgents 一致（含 oldLocation/shadowed/enabled 标注）
```

- [ ] **Step 2: 跑失败** → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑通过 + `pnpm test` 全量**（subagent/serve 相关回归）
- [ ] **Step 5: Commit** `refactor(agents): AgentRegistry 三级装载收口 catalog——enabled 剔除+旧位置兼容`

### Task 8: catalog/plugins（开关两级复活）

**Files:**
- Create: `src/catalog/plugins.ts`
- Modify: `src/config/plugins.ts:266-277`（`readGlobal` → 两级 per-id 合并）
- Test: `src/catalog/plugins.test.ts`

**Interfaces:**
- Consumes: `loadEffectivePlugins`（签名不变；其内部 `settingsReader` 注入面改为两级询问：`opts.settingsReader?: (scope: 'global'|'project') => Record<string,unknown>|null`，实现内 `merged = {...readLevel('global'), ...readLevel('project')}` 浅 per-id 遮蔽）。
- Produces:
  - `export function listPlugins(root: string | null): { plugins: EffectivePlugin[]; warnings: string[] }`（= loadEffectivePlugins 薄包装，零增值字段先不做）
  - `export function setPluginEnabled(root: string | null, scope: Scope, id: string, enabled: boolean): void`——写 settings `plugins.<id>.enabled`（整个 record 读改写：`{enabled, config?}` 保留 config）；未知 id → `CatalogWriteError('INVALID')`（先 list 校验 id 存在）
  - `export function setPluginConfig(root, scope, id, config: Record<string, unknown>): void`
  - 两函数含注释 settings → `CatalogWriteError('COMMENTS')`

- [ ] **Step 1: 失败测试**

```ts
// 1) 全局 enabled true + 项目 enabled false → 项目胜（listPlugins enabled===false）；
// 2) 项目无该 id 记录 → 回全局；3) 项目 plugins:{} 空对象 → 不遮蔽任何 id（per-id 合并非整键替换）；
// 4) setPluginEnabled 写项目 scope → 项目 settings.json 落 plugins.<id>.enabled 且 config 保留；
// 5) 注释 settings → CatalogWriteError('COMMENTS')；6) 未知 id → CatalogWriteError('INVALID')
```

- [ ] **Step 2: 跑失败** → FAIL
- [ ] **Step 3: 实现**（注意 `src/serve/config-handlers.ts` 的 `handlePluginsPut` 与 `plugins.test` 既有「项目键忽略」断言随裁定反转更新）
- [ ] **Step 4: 跑通过 + 全量** → PASS
- [ ] **Step 5: Commit** `feat(catalog): plugins 开关两级复活——per-id 项目遮蔽全局+settings 结构化写`

### Task 9: catalog/providers 读面（tier 解析 + list）

**Files:**
- Modify: `src/config/providers.ts`（`ModelChoice` 增 `tier?: ModelTier`；`parseProvidersSpec` 条目对象形态解析可选 `tier`，非法值 warning 忽略——沿 contextWindow 同款纪律）
- Create: `src/catalog/providers.ts`
- Test: `src/catalog/providers.test.ts`

**Interfaces:**
- Consumes: `parseProvidersSpec` / `loadProjectSettings` / `loadGlobalSettings` / `providerApiKeyEnv` / `resolveProviderApiKey`。
- Produces:
  - `ModelChoice` 增 `tier?: 'small'|'medium'|'large'`（Task 11 档位路由消费）
  - `export interface ProviderEntry { name: string; baseUrl: string; contextWindow?; reasoningEffort?; supportsImages?; models: Array<{ model: string; contextWindow?; reasoningEffort?; supportsImages?; tier? }>; apiKeyEnv: string; apiKeyPresent: boolean }`
  - `export function listProviders(root: string | null): { providers: ProviderEntry[]; choices: ModelChoice[]; warnings: string[] }`——两级整键遮蔽装载（现状语义），展开 choices 序 = providers 序 × models 序（默认=首个的既定规则的数据基座）

- [ ] **Step 1: 失败测试**

```ts
// 1) providers 两级：项目键在场（含空数组）遮蔽全局（现状语义钉住）；
// 2) models 对象形态 tier 解析：合法进 ModelChoice.tier、非法 warning 忽略；
// 3) apiKeyPresent：env 槽有值 true、无值 false（env 桩注入，不写真键）；
// 4) choices 序 = providers 序 × models 序
```

- [ ] **Step 2: 跑失败** → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑通过** → PASS
- [ ] **Step 5: Commit** `feat(catalog): providers 读面——tier 标注解析+两级装载+choices 序即默认序`

### Task 10: catalog/providers 写面

**Files:**
- Modify: `src/catalog/providers.ts`
- Test: `src/catalog/providers.test.ts`（追加）

**Interfaces:**
- Produces:
  - `export function upsertProvider(root, scope, name, patch: { name?; baseUrl?; contextWindow?; reasoningEffort?; supportsImages? }): void`（add=不存在则建；update=存在则增量；baseUrl 必填校验 → INVALID）
  - `export function removeProvider(root, scope, name): void`
  - `export function modelAdd(root, scope, provider, entry: { model: string; tier?; contextWindow?; reasoningEffort?; supportsImages? }): void`（同 provider 内同 model 名幂等拒绝 → INVALID）
  - `export function modelRemove(root, scope, provider, model): void`（最后一条 model 移除后 provider 整条删除——providers 条目 models 空即非法）
  - `export function modelMove(root, scope, provider, model, direction: 'up'|'down'): void`
  - `export function setProviderApiKey(root, scope, provider, apiKey: string): void`——写 settings `env.SUNSHINEX_API_KEY_<UPPER>`（`providerApiKeyEnv` 生成槽名；空串=删除该 env 行）
  - 全部：JSONC 注释 → `CatalogWriteError('COMMENTS')`；scope=project 写项目 settings、global 写全局

- [ ] **Step 1: 失败测试**

```ts
// 1) add→list 出现且 env 槽名正确；2) update 增量（未提字段不动）；3) modelAdd/modelRemove/models 空自动删 provider；
// 4) modelMove up/down 序断言（choices 序随之）；5) setProviderApiKey 写 env 块、空串删行、响应无回显路径（函数返回 void）；
// 6) 同名 model 重复 add → INVALID；7) 注释 → COMMENTS
```

- [ ] **Step 2: 跑失败 → Step 3: 实现 → Step 4: 跑通过**
- [ ] **Step 5: Commit** `feat(catalog): providers 写面——增删改/模型调序/apiKey 走 env 块`

### Task 11: 散键退役 + tier 路由改造 + 缺省恒 choices[0]

**Files:**
- Modify: `src/config/settings.ts:14-24,57-60`（五键 `model/baseUrl/modelSmall/modelMedium/modelLarge` 出 `SEMANTIC_KEYS` 入 `RETIRED_KEYS`，指引文案：「改用 providers 列表（模型与提供方页/providers 子命令）；默认模型 = 第一个 provider 的第一个 model」）
- Modify: `src/runtime.ts:41-70`（`buildTierRouter` 删除 env 绑定路径，改为 `buildTierRouterFromChoices(choices: ModelChoice[], flags)`：`tier T` 绑第一个 `choice.tier===T` 的 choice（`choiceAdapterConfig` 构造），未标注/无匹配回 default=choices[0] 适配器；choices 空 → undefined 沿现状退单模型装配）
- Modify: `src/runtime.ts` `buildModel`/`buildDeps`（`buildDeps` 改调新函数；providers choices 来源 = `loadProvidersChoices(root)`——catalog listProviders 包装，daemon/TUI/CLI 三面同源）
- Modify: `src/serve/daemon.ts:110-126`（`explicitDefault` 判断删除：choices 非空恒 `sw.switchTo(choices[0].id)`；`ModelSwitcher` 构造不再传 `explicitDefault`）
- Modify: `src/model/catalog.ts`（`explicitDefault` opts 字段与 `:99` 判断删除——default 不再作为选择卡可选项露出）
- Test: `src/runtime.tier-router.test.ts`（新建）+ `src/model/catalog.test.ts`（既有，更新 explicitDefault 断言）

**Interfaces:**
- Produces:
  - `export function buildTierRouterFromChoices(choices: readonly ModelChoice[], flags): ModelRouter | undefined`
  - 退役键 warning：settings 解析遇退役键输出指引 warning（RETIRED_KEYS 既有机制，确认 flatten 面输出到 GUI warnings 即可）

- [ ] **Step 1: 失败测试**

```ts
// 1) choices=[{a,tier:'small'},{b}] → router.resolve('small') 命中 a、'large' 回 default(choices[0])；
// 2) 同 tier 多个取第一个；3) choices 空 → undefined；
// 4) settings 含 model 键 → warning 含「providers」指引且 SUNSHINEX_MODEL 槽不被填充；
// 5) ModelSwitcher 无 explicitDefault 后选择卡不含 default 项（更新既有断言）
```

- [ ] **Step 2: 跑失败** → FAIL
- [ ] **Step 3: 实现**（daemon.ts 是并行会话热区——先读工作区最新版再改；既有测试中依赖 SUNSHINEX_MODEL/SUNSHINEX_MODEL_SMALL 填充的用例改为 providers 注入或删除并注明裁定）
- [ ] **Step 4: 跑通过 + 全量 `pnpm test`**（runtime/harness/model/serve 回归面最大的一步）
- [ ] **Step 5: Commit** `feat(model)!: 散键退役+档位路由改 tier 标注+缺省恒 choices[0]——providers 列表唯一事实源（spec §15）`

### Task 12: catalog/skills 视图（来源链 + 遮蔽标注）

**Files:**
- Create: `src/catalog/skills.ts`
- Test: `src/catalog/skills.test.ts`

**Interfaces:**
- Consumes: `loadSkillsGrouped` / `loadUserSkillsGroup` / `loadCrossProjectSkillGroups`（`src/harness/skills.ts` 不动）。
- Produces: `export interface SkillEntry { id; name; description; version; source: 'project'|'user'|'learned'|'plugin'; sourceDir: string; shadowedBy?: string }` + `export function listSkills(root: string, opts?): Listing<SkillEntry>`——同 id 跨来源：优先级最高者正选，其余标 `shadowedBy:<来源>`（skills 页展示用；harness 装载链零改动）

- [ ] **Step 1: 失败测试**：项目 `.sunshinex/skills/x` 与 user `~/.sunshinex`（env 桩）同 id x → 项目正选、user 条目 `shadowedBy:'project'`；learned/plugin 来源标注正确。
- [ ] **Step 2: 跑失败 → Step 3: 实现 → Step 4: 跑通过**
- [ ] **Step 5: Commit** `feat(catalog): skills 只读视图——来源链+跨源遮蔽标注`

---

## Phase B：双向实时同步（watch + WS）

### Task 13: catalog/watch（防抖 fs.watch + 回环抑制）

**Files:**
- Create: `src/catalog/watch.ts`
- Test: `src/catalog/watch.test.ts`

**Interfaces:**
- Consumes: Task 1 types（ResourceKind/Scope）。
- Produces:
  - `export interface ConfigChange { resource: ResourceKind; scope: Scope; root: string | null }`
  - `export class ConfigWatcher { watchGlobal(globalDir: string): void; watchProject(root: string): void; unwatchProject(root: string): void; onChange(cb: (c: ConfigChange) => void): void; suppress(resource: ResourceKind, scope: Scope, root: string | null, windowMs?: number): void; close(): void }`
  - 语义：`fs.watch` 目录级（globalDir 本层文件 + agents/plugins 子目录递归一层；project root 监听 `<root>/.sunshinex` 整目录）；事件按 filename 前缀映射 resource（`mcp.json`→mcp、`settings.json`→settings、`agents/`→agents、`plugins/`→plugins、`skills/`→skills）；**300ms 防抖**（同 resource+scope+root 合并为一次回调）；`suppress(...)` 在窗口期（缺省 500ms）丢弃对应组合事件（daemon 写回环抑制）；监听失败（ENOENT/权限）→ 回调 `onChange` 不注册、`console.warn` 降级（功能回退 GET 即读，不 throw）

- [ ] **Step 1: 失败测试**

```ts
// tmp 目录真实触发：
// 1) 写 globalDir/mcp.json → 收 {resource:'mcp',scope:'global',root:null}（300ms 防抖内多次写只收一次）；
// 2) 写 project/.sunshinex/skills/a/SKILL.md → {resource:'skills',scope:'project',root}；
// 3) suppress('mcp','global',null) 后写 mcp.json → 不回调；
// 4) watch 不存在目录 → 不 throw；5) close() 后无回调
```

- [ ] **Step 2: 跑失败**（注意计时类断言给足余量，沿仓内「计时抖动」教训：等待上界 ≥1.5s）
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑通过（连续跑 3 次确认无抖动红）**
- [ ] **Step 5: Commit** `feat(catalog): ConfigWatcher——目录级 fs.watch+300ms 防抖+写回环抑制+降级`

### Task 14: daemon 集成（watch 生命周期 + config-changed 帧）

**Files:**
- Modify: `src/serve/daemon-ws.ts`（`DaemonFrame` 联合类型增 `{ kind: 'config-changed'; resource: ResourceKind; scope: Scope; root: string | null }`——`broadcastFrame` 机制已有，`daemon-ws.ts:51`）
- Modify: `src/serve/daemon.ts`（并行会话热区——动手前读工作区最新版：daemon 持有 `ConfigWatcher` 实例；启动时 `watchGlobal(userConfigDir())`；会话打开处（`session-lifecycle` 挂接点）`watchProject(root)`、会话关闭处 `unwatchProject(root)`；watcher.onChange → 经 catalog 写路径的先 `suppress(...)` 再写（见下）→ `broadcastFrame({kind:'config-changed',...})`）
- Modify: `src/catalog/io.ts`（新增可选通知钩子：`export let onCatalogWrite: ((resource: ResourceKind, scope: Scope, root: string | null) => void) | null`——catalog 各写函数落盘成功后调用；daemon 装配时设为 `(...args) => watcher.suppress(...)` + broadcast。放 io.ts 单点是让所有 catalog 写共享一个回环抑制口，不逐模块穿参）
- Test: `src/serve/daemon.config-changed.test.ts`（新建）

**Interfaces:**
- Produces: WS 帧形状（gui Task 21 消费）：`{kind:'config-changed', resource, scope, root}`。

- [ ] **Step 1: 失败测试**

```ts
// 1) tmp 全局目录 + tmp 项目 root 起 watch 装配 → 写项目 mcp.json → ws 客户端（沿 daemon 现有测试 ws 客户端先例）收到 config-changed 帧；
// 2) 经 catalog 写路径（如 setPluginEnabled）→ 同步进程内不收到自触帧（suppress 生效）但帧仍广播给 GUI（广播与抑制独立：
//    抑制的是 watcher 事件源，广播由 onCatalogWrite 直发——外部编辑走 watcher、内部写走直发，两路合一去重）；
// 3) 会话关闭后写项目文件不再产生帧（unwatch）
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**——除 daemon/watcher 接线外，**回填钩子调用**：catalog 各写函数（`mcp.ts` 的 upsert/remove/setEnabled、`agents.ts` 的 upsert/remove/setEnabled/migrate、`plugins.ts`、`providers.ts`、`approvals.ts`、`permissions.ts`）在 `writeJsonAtomic` 成功后统一补一行 `notifyCatalogWrite(resource, scope, root)`（io.ts 导出的钩子 setter/getter，缺省 no-op——Task 1-12 期间零行为）；本任务将 daemon 装配钩子为 `suppress(...)` + `broadcastFrame(...)`
- [ ] **Step 4: 跑通过 + 全量**
- [ ] **Step 5: Commit** `feat(serve): config-changed WS 帧+daemon watch 生命周期——双向实时同步骨干`

---

## Phase C：serve op 端点（handlers 全走 catalog）

### Task 15: /settings/mcp/op + agents/op 扩展

**Files:**
- Modify: `src/serve/config-handlers.ts`（`handleMcpPut` 旁新增 `handleMcpOp`；`handleAgentsPut` 增 op 值 `enable|disable`；`renderAgentMd` 本地实现改 import catalog（Task 6 已迁）；`handleMcpGet` 改消费 `listMcpServers`（approval 字段进响应））
- Modify: `src/serve/daemon.ts`（路由表增 `PUT /settings/mcp/op`）
- Test: `src/serve/config-handlers.mcp-op.test.ts`（新建，沿既有 handlers 测试先例起 daemon/直调 handler）

**Interfaces:**
- Produces（REST 契约，gui 消费）:
  - `PUT /settings/mcp/op` body `{op:'add'|'remove'|'enable'|'disable'|'approve'|'deny', scope:'global'|'project', root?, name, server?}`；成功 200 `{ok:true}`；`COMMENTS/INVALID` → 409 `{error, hint:'use raw editor'}`（沿现 409 形状）；project scope 缺 root → 400；approve/deny 仅 project 有效（global → 400）
  - `PUT /settings/agents/op` 新增合法 op：`enable|disable|migrate`（`{op:'enable'|'disable', scope, root?, id, enabled}`；`{op:'migrate', root, id}` = legacy→新家 copy，走 `migrateAgent`，非 legacy 条目 → 404）；既有 `upsert|delete` 行为不变但实现改走 catalog

- [ ] **Step 1: 失败测试**

```ts
// mcp/op：1) add(project)→ 项目 mcp.json 落条目；2) enable/disable 改 enabled 字段；3) approve→mcpApprovals 落、
// GET /settings/mcp 该条目 approval:'approved'；4) 注释文件 → 409 hint；5) global add 无需 root、project 无 root → 400。
// agents/op：6) enable/disable 落 frontmatter；7) 未知 op → 400
```

- [ ] **Step 2: 跑失败 → Step 3: 实现（全部薄封装 catalog）→ Step 4: 跑通过 + 全量**
- [ ] **Step 5: Commit** `feat(serve): /settings/mcp/op 端点+agents enable/disable——handlers 收口 catalog`

### Task 16: /settings/providers/op + /settings/permissions/op

**Files:**
- Modify: `src/serve/config-handlers.ts`（新增两 handler；`handleSettingsGet` 的 providers 面改消费 `listProviders`（含 tier/apiKeyPresent/choices 序））
- Modify: `src/serve/daemon.ts`（路由表两行）
- Create: `src/catalog/permissions.ts`（`listPermissions(root)` 沿现 merged/project/global 形状 + `addPermission(root, scope, list:'deny'|'allow'|'additionalDirs', value)` / `removePermission(...)`——settings `permissions` 键读写，复用 `src/config/permissions.ts` 解析）
- Test: `src/serve/config-handlers.providers-op.test.ts`、`src/catalog/permissions.test.ts`

**Interfaces:**
- Produces:
  - `PUT /settings/providers/op` body `{op:'add'|'update'|'remove'|'modelAdd'|'modelRemove'|'modelMove'|'setKey', scope, name, provider?, model?, entry?, direction?, apiKey?}`；响应永不回显 apiKey
  - `PUT /settings/permissions/op` body `{op:'add'|'remove', scope, list, value}`

- [ ] **Step 1: 失败测试**（providers op 七值各一正例 + INVALID/COMMENTS 409 + setKey 后 GET /settings 的 apiKeyPresent 翻转且响应无键值；permissions add/remove 落对应数组且去重）
- [ ] **Step 2: 跑失败 → Step 3: 实现 → Step 4: 跑通过 + 全量**
- [ ] **Step 5: Commit** `feat(serve): providers/permissions op 端点——结构化编辑收口`

---

## Phase D：CLI

### Task 17: CLI 公共 target 解析 + mcp 子命令族

**Files:**
- Create: `src/cli/commands/catalog-common.ts`（`resolveTarget(args): {scope: Scope; root: string | null}`——`--scope=global` → `{global,null}`；缺省 `{project, root}`，root=`--root <dir>` 或 `process.cwd()`；`--json` 提取）
- Create: `src/cli/commands/mcp.ts`（`runMcpCommand(args)`）
- Modify: `src/cli/index.ts`（dispatch 增 `mcp` 分支 + usage 文本行）
- Test: `src/cli/commands/mcp.test.ts`（spawn dist 端到端：临时 HOME 桩 env）

**Interfaces:**
- Consumes: catalog mcp/approvals 全函数。
- Produces: `sunshinex mcp list|add|remove|enable|disable|test|approve|deny`（spec §8 旗标面）；`--json` 输出 `listMcpServers` 原样 JSON；表格沿 `plugins.ts` cli-table3 先例（stdout 数据 / stderr 诊断 / exit 1 非法参数）。

- [ ] **Step 1: 失败测试**

```ts
// spawnSync(process.execPath, [dist/cli/index.js, 'mcp', 'add', 'fs', '--command=npx', '--arg=a', '--scope=project'], {cwd: tmpProj, env: 桩})
// 1) add → tmpProj/.sunshinex/mcp.json 落条目；2) list 表格含 fs；3) list --json 解析 JSON 数组断言；
// 4) enable/disable 翻转 enabled；5) approve/deny 写全局 settings（HOME 桩）；6) 缺 --command/--url → exit 1 + usage
```

- [ ] **Step 2: 跑失败 → Step 3: 实现 → Step 4: 跑通过**
- [ ] **Step 5: Commit** `feat(cli): mcp 子命令族——list/add/remove/enable/disable/test/approve/deny`

### Task 18: agents/plugins/skills/settings 子命令族

**Files:**
- Create: `src/cli/commands/agents.ts`、`src/cli/commands/settings-cli.ts`
- Modify: `src/cli/commands/skills.ts`（新增 `skills list`；既有 skills-install.ts 不动，注意现有文件名可能是 `skills-install.ts`——`skills list` 并入同族分发）
- Modify: `src/cli/commands/plugins.ts`（增 `enable|disable <id>`）
- Modify: `src/cli/index.ts`（dispatch + usage）
- Test: `src/cli/commands/agents.test.ts`、`src/cli/commands/settings-cli.test.ts`

**Interfaces:**
- Produces:
  - `sunshinex agents list|add|remove|enable|disable`（add 旗标 spec §8：`--name --description --memory --isolation=worktree --executor=... --body-file=<path>`；list 标注 scope/shadowed/oldLocation/enabled）
  - `sunshinex plugins list|enable|disable <id>`（enable/disable 走 `setPluginEnabled`，--scope 支持）
  - `sunshinex skills list [--scope=all]`（分组表格：id/name/来源/遮蔽）
  - `sunshinex settings get <key>`（打印 effective 值 + 来源 env/project/global/default——复用 `handleSettingsGet` 的 `effectiveKeyRow` 逻辑抽出的纯函数）| `set <key> <value>`（SEMANTIC_KEYS 校验，退役键打印指引 exit 1）

- [ ] **Step 1: 失败测试**

```ts
// agents add→list 断言（含 --body-file 读入）；agents enable/disable 落 frontmatter；
// plugins enable → settings plugins 键落（--scope 两级各验一）；skills list 表格含来源列；
// settings get model → 打印退役指引 exit 1；settings get language → 值+来源；settings set language=zh → settings.json 落键
```

- [ ] **Step 2: 跑失败 → Step 3: 实现 → Step 4: 跑通过**
- [ ] **Step 5: Commit** `feat(cli): agents/plugins/skills/settings 子命令族`

### Task 19: providers 子命令族

**Files:**
- Create: `src/cli/commands/providers.ts`
- Modify: `src/cli/index.ts`（dispatch + usage）
- Test: `src/cli/commands/providers.test.ts`

**Interfaces:**
- Produces: `sunshinex providers list|add|remove|set|key|test` + `providers model add|remove|move`（spec §8 旗标面）；`providers key <name>` 交互隐藏输入（`readline` + `muted` 输出——沿仓内无 readline mute 先例则用 `process.stdin.setRawMode` 最小实现，非 TTY → 报错 exit 1 提示走 GUI/raw）；`providers test <name>` 复用 `probeMcpServer` 思路做 OpenAI 端点连通（GET `<baseUrl>/models` 带 key，超时 10s，结果两行：ok/模型数 或 错误摘要）。

- [ ] **Step 1: 失败测试**

```ts
// add --base-url --models=a,b → list --json 断言序 [a,b]；model move a --direction=down → 序 [b,a]；
// model add c --tier=small → ModelChoice tier 标注；set --base-url 增量；remove 删整条；
// key：非 TTY spawn → exit 1 提示（TTY 交互路径手工验收）
```

- [ ] **Step 2: 跑失败 → Step 3: 实现 → Step 4: 跑通过**
- [ ] **Step 5: Commit** `feat(cli): providers 子命令族——add/set/key/model 管理/test`

---

## Phase E：TUI

### Task 20: /mcp /agents /plugins /providers 面板 + /skills 标注 + 未批准提示

**Files:**
- Create: `src/tui/commands-mcp.ts`、`src/tui/commands-agents.ts`、`src/tui/commands-plugins.ts`、`src/tui/commands-providers.ts`
- Modify: `src/tui/slash-commands.ts`（`SLASH_COMMANDS` 增 `/mcp` `/agents` `/plugins` `/providers`）
- Modify: `src/tui/session.ts:510+`（分发四分支，沿 `/model` → 拆分件先例）
- Modify: `src/tui/commands-skills.ts`（面板条目补来源/遮蔽标注）
- Modify: `src/harness/index.ts` 或 MCP 装配告警面（项目 mcp 有 `pending` 条目时，TUI 启动装配后 push 一行 system 提示：「项目 MCP 有 N 个待确认服务器，/mcp 查看」——非阻塞）
- Test: `src/tui/slash-commands.test.ts`（既有，追加注册断言）+ `src/tui/commands-mcp.test.ts`（新建：面板输出行含 enable/disable 状态与待确认标注；approve 子命令写 settings；enable 落 mcp.json）

**Interfaces:**
- Consumes: catalog 全读面 + `setMcpServerEnabled` / `approveMcpServer` / `setAgentEnabled` / `setPluginEnabled`。
- Produces:
  - `/mcp [enable|disable|approve|deny <name>]`：无参列表卡（名称/scope/状态/待确认徽标），带参执行后回显结果行并重绘列表
  - `/agents [enable|disable <id>]`；`/plugins [enable|disable <id>]`；`/providers`（清单卡：provider/models 数/密钥状态/默认标记——默认恒 choices[0] 标注；编辑引导行：「编辑: sunshinex providers ... 或 $EDITOR settings.json」）
  - `/model` 选择卡增「默认」徽标（choices[0]）；运行时会话内切换行为不变

- [ ] **Step 1: 失败测试**（沿 commands-skills 族测试先例：SessionController 桩 + pushMsg 断言）
- [ ] **Step 2: 跑失败 → Step 3: 实现 → Step 4: 跑通过 + 全量**
- [ ] **Step 5: Commit** `feat(tui): /mcp /agents /plugins /providers 面板+未批准提示+/model 默认徽标`

---

## Phase F：GUI

### Task 21: 共享组件 + SettingsShell scope + config-changed 订阅

**Files:**
- Create: `gui/src/settings/components.tsx`（`ScopeSwitcher`（分段控件：全局/项目；无 root 时项目侧 disabled+title 提示）、`SearchBar`（受控 value+onChange 防抖 200ms）、`ResourceCard`（props：`{icon?, title, chips?: ReactNode, badge?: SourceBadgeProps, enabled?: boolean, onToggle?, actions?: ReactNode, children?: ReactNode(折叠详情)}`）、`EditorDrawer`（右侧滑出：`{open, title, onClose, onSubmit, children}`）、`EmptyState`、`ErrorBanner`）
- Create: `gui/src/settings/use-config-changed.ts`（订阅 WS：`conn` 的帧处理挂 `config-changed` → 按 resource 合并 200ms → 返回 `{tick: Record<ResourceKind, number>}`；gui/src/connection.ts 是并行会话热区——只加一个可选回调注册点，不动帧主流程）
- Modify: `gui/src/settings/SettingsShell.tsx`（顶栏加 ScopeSwitcher；`scope` 状态提升（`'global'|'project'`，缺省 project、无 root 时强制 global）；`root` 维持现状（打开时快照）；把 `scope`/`refreshTick` 传各 pane）
- Test: `gui/src/settings/__tests__/components.test.tsx`（vitest + testing-library 沿 gui 现有测试栈）

**Interfaces:**
- Produces（后续 GUI 任务统一消费的组件契约，签名务必一致）:
  - `<ScopeSwitcher scope, onScopeChange, projectAvailable>`
  - `<ResourceCard title, subtitle?, badge?, enabled?, onToggle?, actions?, details?>`
  - `useConfigChanged(): Record<ResourceKind, number>`（pane 依赖对应 resource 的 tick 变化触发 refetch）

- [ ] **Step 1: 失败测试**（ScopeSwitcher 切换回调/禁用态；ResourceCard 开关与 actions 渲染；useConfigChanged 收到帧后 tick 递增——connection 桩注入帧）
- [ ] **Step 2: 跑失败 → Step 3: 实现（样式沿现有 sx-card/sx-settings-card 令牌）→ Step 4: `pnpm --dir gui run test` + `pnpm --dir gui run typecheck`**
- [ ] **Step 5: Commit** `feat(gui): 设置共享组件——ScopeSwitcher/SearchBar/ResourceCard/EditorDrawer+config-changed 订阅`

### Task 22: McpPane 重构（op 端点 + EditorDrawer + 待确认 + 遮蔽）

**Files:**
- Modify: `gui/src/settings/McpPane.tsx`（整页重构为一屏式：顶栏 SearchBar + 新增按钮；卡片列表吃 `GET /settings/mcp`（approval 字段）；写全部走 `PUT /settings/mcp/op`；EditorDrawer 表单（名称/transport select/command|url/args 逐行/env 键值行）+「JSON 源码」折叠高级模式（提交前 JSON.parse + 单条形状校验）；待确认卡 = warn 边 + 确认/拒绝按钮；全局卡在 project scope 下同名被遮蔽标「被项目遮蔽」；删原整块 PUT/内联 textarea 编辑路径）
- Test: `gui/src/settings/__tests__/McpPane.test.tsx`（fetch mock：列表渲染/搜索过滤/新增提交 op 形状/待确认按钮调 approve/deny）

- [ ] **Step 1: 失败测试 → Step 2: 跑失败 → Step 3: 实现 → Step 4: vitest + typecheck**
- [ ] **Step 5: Commit** `feat(gui): MCP 页重构——op 端点卡片化+EditorDrawer+批准流+遮蔽标注`

### Task 23: AgentsPane 重构（卡片化 + enabled + 迁移）

**Files:**
- Modify: `gui/src/settings/AgentsPane.tsx`（弃原生 form：卡片列表（enabled 开关→`/settings/agents/op` enable|disable；oldLocation 卡标「旧位置」+「迁移到 .sunshinex/」按钮）+ EditorDrawer 表单（id 编辑态锁定/name/description/memory/isolation/executor/body）+ SearchBar；scope 走 shell 传入，删本地 scope select）
- Test: `gui/src/settings/__tests__/AgentsPane.test.tsx`

- [ ] **Step 1: 失败测试（渲染/开关/迁移按钮 op 形状/编辑提交形状）→ Step 2-4: 标准 TDD 循环**
- [ ] **Step 5: Commit** `feat(gui): 智能体页重构——卡片化+启停+旧位置迁移按钮`

### Task 24: PluginsPane 重构（搜索 + 配置抽屉）

**Files:**
- Modify: `gui/src/settings/PluginsPane.tsx`（并行会话有未提交改动——先读工作区最新版再重构：SearchBar 接入；卡片详情折叠保留；新增「配置」按钮 → EditorDrawer（configSchema 驱动键值表单，无 schema 时 JSON 文本域）→ `PUT /settings/plugins`（现有端点，config 字段）；enabled 开关补 scope 意识（shell scope 决定写全局/项目，现写死全局的逻辑删除））
- Test: `gui/src/settings/__tests__/PluginsPane.test.tsx`

- [ ] **Step 1-4: 标准 TDD 循环（搜索过滤/开关 scope 形状/配置提交形状）**
- [ ] **Step 5: Commit** `feat(gui): 插件页重构——搜索+configSchema 配置抽屉+作用域开关`

### Task 25: SkillsPane 标注 + PermissionsPane 编辑 + SettingsForm 行过滤

**Files:**
- Modify: `gui/src/settings/SkillsPane.tsx`（吃 catalog skills 新形状：被遮蔽卡降透明度 + 「被 <来源> 同名技能遮蔽」角标）
- Modify: `src/serve/config-handlers.ts`（`handleSkillsGet` 本任务一并扩：响应条目补 `shadowedBy`/`sourceDir`——消费 `catalog/skills.ts` 的 `listSkills`；handler 扩展与 GUI 消费同任务收口，避免跨任务契约漂移）
- Modify: `gui/src/settings/PermissionsPane.tsx`（deny/allow/additionalDirs 三组各为可增删 chips 列表 + 输入行 → `PUT /settings/permissions/op`；保留只读汇总视图）
- Modify: `gui/src/settings/SettingsForm.tsx`（SETTINGS_PANES 四页顶部接 SearchBar：按 label/key 过滤行）
- Test: `gui/src/settings/__tests__/SkillsPane.test.tsx`、`PermissionsPane.test.tsx`、`SettingsForm.test.tsx`（追加）

- [ ] **Step 1-4: 标准 TDD 循环**
- [ ] **Step 5: Commit** `feat(gui): 技能遮蔽标注+权限结构化增删+表单行过滤`

### Task 26: ProvidersPane 重构（spec §15）

**Files:**
- Modify: `gui/src/settings/ProvidersPane.tsx`（整页重构：提供方 ResourceCard 列表（name/baseUrl 副行/密钥状态点/models chips（默认=第一 provider 第一 model 加「默认」chip）/编辑/删除/测试按钮）+「新增提供方」按钮 → EditorDrawer（name/baseUrl/apiKey password 输入（写 setKey，不回显）/models 行编辑（model 名/contextWindow/reasoningEffort/tier select/上移下移））；请求参数卡删「API 地址」行与模型 Combo，仅留 tier/effort 两 select；`GET /settings` 响应中 providers 面消费 Task 16 新形状）
- Test: `gui/src/settings/__tests__/ProvidersPane.test.tsx`

- [ ] **Step 1: 失败测试**（卡片渲染含默认标记/删除确认调 op/模型上移下移提交 modelMove/apiKey 提交后输入框清空且不发回显请求/无「API 地址」行断言）
- [ ] **Step 2-4: 标准 TDD 循环 + typecheck**
- [ ] **Step 5: Commit** `feat(gui): 提供方页重构——卡片增删改+默认标记+tier 编辑+散键行移除`

### Task 27: RawPane 项目作用域解锁

**Files:**
- Modify: `gui/src/settings/RawPane.tsx`（scope 固定 global 改为吃 shell scope：project 时文件选择含项目 settings.json/mcp.json（`GET/PUT /settings/raw?scope=project&root=`——既有端点已支持 root 参数，验证即可）；409 hint 展示沿现状）
- Test: `gui/src/settings/__tests__/RawPane.test.tsx`（追加：scope 切换 → fetch URL 断言）

- [ ] **Step 1-4: 标准 TDD 循环**
- [ ] **Step 5: Commit** `feat(gui): 高级 raw 编辑器解锁项目作用域`

---

## Phase G：收尾

### Task 28: 文档 + 全量门禁 + 手工验收

**Files:**
- Modify: `MANUAL.md`（§设置：新存储布局图（spec §2 两棵目录树）、作用域统一规则、项目 MCP 批准阀、agents enabled、散键退役迁移指引（model/baseUrl/modelSmall/Medium/Large → providers 列表）、CLI 子命令一节、TUI 四面板、实时同步说明）
- Modify: `docs/PLUGIN-DEV.md`（插件开关两级生效语义校对：per-id 项目遮蔽全局）
- Modify: `src/cli/index.ts`（usage 帮助文本与实际子命令全集核对一遍）

- [ ] **Step 1: 全量门禁**：`pnpm test`（主仓）+ `pnpm --dir gui run typecheck` + `pnpm --dir gui run test` 全绿；`pnpm build && node dist/cli/index.js selfcheck` 通过
- [ ] **Step 2: 手工验收清单**（逐项记录结果进提交信息）：
  1. GUI 四资源页统一卡片；MCP/Agents/Plugins 作用域切换+搜索+增改删启停
  2. 项目 mcp.json 加一条 server → GUI 待确认 → 批准 → probe 见工具；拒绝后不再询问
  3. 插件项目级关→开，来源徽标随 scope 切换
  4. CLI `mcp add` → GUI ≤1s 自动出现（config-changed）；GUI 改 → CLI list 即见
  5. `<root>/agents/` 旧 agent 可见可迁
  6. providers 页新增 provider+model → `/model` 卡首位默认；`/model-tier` 按 tier 选中
  7. 散键存量 settings → 启动 warning 指引
- [ ] **Step 3: Commit** `docs: 设置存储规范化——MANUAL 布局/作用域/批准阀/散键迁移指引+CLI/TUI 面`

---

## 附录：任务依赖图（执行顺序即编号）

Phase A（1→12，其中 4 依赖 2+3；7 依赖 5+6；11 依赖 9）→ Phase B（13→14）→ Phase C（15→16）→ Phase D（17→18→19）→ Phase E（20）→ Phase F（21→22…27，26 依赖 16 的 providers op）→ G（28）。
并行会话热区（daemon.ts/connection.ts/config.ts/plugins.ts）每任务动手前先读工作区最新版，提交前 `git pull --rebase`。

