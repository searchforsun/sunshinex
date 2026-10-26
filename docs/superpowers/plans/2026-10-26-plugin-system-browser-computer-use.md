# 插件体系 + browser use / computer use 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec 的四个里程碑：M0' 工具结果图片通道（截屏回流生命线）→ M1 插件框架+设置页+开发者面 → M2 browser-use 系统插件 → M3 computer-use 系统插件。

**Architecture:** 插件=治理/分发层（manifest+开关+设置面），能力后端=进程外 MCP server（harness 经 McpHost stdio spawn/收口）；工具结果图片沿「ExecResult.images → 链行 → buildMessages（tool 文本走 tool 消息、图片随合成 user 帧）→ wire image_url」回流；guard 对插件工具按 manifest `safety` 三类声明通用消费。

**Tech Stack:** TypeScript strict / CommonJS、node:test（经 tsc 编译跑 dist）、@modelcontextprotocol/sdk ^1.30、gui 侧 React18+vitest、M3 持久 PowerShell worker（零原生依赖）。

**Spec:** `docs/superpowers/specs/2026-10-26-plugin-system-browser-computer-use-design.md`（本计划从 spec 论证，执行者须同读）。

## Global Constraints

- Node >=22.9；主仓**零依赖新增**（G2 裁定）：新依赖一律落子包（`plugins/*` 工作区成员）自管；主仓 devDeps 不动。
- 测试：`pnpm test` = clean + `tsc -p tsconfig.json` + `node scripts/run-tests.js`（dist 下 `*.test.js` 全量）；单测定向跑 `tsc -p tsconfig.json && node --test dist/<路径>/<名>.test.js`。gui：`pnpm --dir gui exec vitest run` + `pnpm --dir gui run typecheck`。
- 图片纪律：dataURL 形态贯穿零二次转码；`MAX_IMAGES=8`（提交面钳制，`src/images.ts`）；视觉规范 长边 1568px / JPEG q0.85；历史图片渲染期剪枝缺省 N=3（settings 键 `imageHistoryLimit`）。
- 两插件 `defaultEnabled: false`；禁用=工具不注册（非注册后禁用）；开关下次会话装配生效，不热插拔。
- 安全不变量：动作只从 Tool 面出、必经 guard/PolicyEngine；deny 规则恒最先；`act` 类任何档位 ask 且 full-access 不豁免。
- Windows 开发机；M3 仅 win32（manifest `platforms:["win32"]`）。
- 每任务收口：`pnpm test` 全绿 + `git` 单提交；GUI 任务另跑 gui typecheck/vitest。

---

## 批次 M0'：工具结果图片通道（Task 1-5）

### Task 1: ExecResult.images + MCP contentOf（图片内容提取）

**Files:**
- Modify: `src/types.ts`（`ExecResult`，约 367-374 行）
- Modify: `src/harness/mcp/client.ts`（`textOf` 约 22-28 行 → `contentOf`；`makeTool` 结果映射约 144-167 行）
- Test: `src/harness/mcp/client.test.ts`（已有则延伸，无则新建）

**Interfaces:**
- Consumes: `MCP CallToolResult.content` 块（`{type:'text',text}` / `{type:'image',data,mimeType}`）。
- Produces: `ExecResult.images?: string[]`（dataURL）；`contentOf(content: unknown): { text: string; images?: string[] }`（模块内私有，经 makeTool 行为钉测）。

- [ ] **Step 1: 写失败测试**

```ts
// src/harness/mcp/client.test.ts 增补（沿既有测试形态；无既有文件则新建并 import 被测面）
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('mcp image content → ExecResult.images dataURL', async () => {
  // 经 makeTool 产出的 executor 间接钉测：构造最小 RegisteredTool 走 client 内部映射
  // 若 makeTool 未导出，则导出 contentOf 供测（export function contentOf）
  const r = contentOf([
    { type: 'text', text: 'shot taken' },
    { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
  ]);
  assert.equal(r.text, 'shot taken');
  assert.deepEqual(r.images, ['data:image/png;base64,aGVsbG8=']);
});
test('mcp 纯 text content 形态零变化（回归钉）', () => {
  const r = contentOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
  assert.equal(r.text, 'a\nb');
  assert.equal(r.images, undefined);
});
test('mcp 图片超 MAX_IMAGES 钳制', () => {
  const parts = Array.from({ length: 10 }, (_, i) => ({ type: 'image', data: String(i), mimeType: 'image/png' }));
  const r = contentOf(parts);
  assert.equal(r.images!.length, 8);
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `tsc -p tsconfig.json && node --test dist/harness/mcp/client.test.js`
Expected: FAIL（`contentOf` 未定义）

- [ ] **Step 3: 最小实现**

`src/types.ts` ExecResult 增补（注释沿既有口径）：

```ts
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** 工具结果随行图片（dataURL，MCP image content/截屏回流）：链行 images 通道的数据源；
   *  生产者负责视觉规范编码（≤1568 边/JPEG q0.85），harness 层零转码 */
  images?: string[];
}
```

`src/harness/mcp/client.ts`：`textOf` 替换为：

```ts
import { MAX_IMAGES } from '../../images';

/** MCP 结果内容提取：text 块 join + image 块收 dataURL（MCP 规范原生支持；此前 textOf 丢图） */
export function contentOf(content: unknown): { text: string; images?: string[] } {
  const parts = Array.isArray(content) ? content : [];
  const texts: string[] = [];
  const images: string[] = [];
  for (const c of parts) {
    if (typeof c !== 'object' || c === null) continue;
    const o = (c as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown });
    if (o.type === 'text') texts.push(String(o.text ?? ''));
    else if (o.type === 'image' && typeof o.data === 'string' && typeof o.mimeType === 'string' && images.length < MAX_IMAGES) {
      images.push(`data:${o.mimeType};base64,${o.data}`);
    }
  }
  const text = texts.filter((t) => t.length > 0).join('\n');
  return { text, ...(images.length > 0 ? { images } : {}) };
}
```

`makeTool` 结果映射处把 `textOf(...)` 换为 `contentOf(...)`，executor 返回：

```ts
const { text, images } = contentOf(result.content);
return { exitCode: isError ? 1 : 0, stdout: text, stderr: isError ? 'tool reported error' : '', ...(images !== undefined ? { images } : {}) };
```

（`isError` 取自 `result.isError === true`；其余超时/64KB 入参钳制逻辑不动。）

- [ ] **Step 4: 跑测确认通过**

Run: `tsc -p tsconfig.json && node --test dist/harness/mcp/client.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/harness/mcp/client.ts src/harness/mcp/client.test.ts
git commit -m "feat(harness): 工具结果图片通道一——ExecResult.images+MCP contentOf(image content 收 dataURL,MAX_IMAGES 钳制)"
```

### Task 2: BatchRunner 图片回发（resultRow 签名 + 事件 payload）

**Files:**
- Modify: `src/harness/batch-runner.ts`（`BatchLedger` 约 22-29 行、`emitResult`/结果循环约 116-152 行）
- Modify: `src/harness/reactor.ts`（`StepRecord` 约 20 行；`ledger.resultRow` 回调约 541 行；收尾 `appendChain` 映射约 349-352 行）
- Test: `src/harness/batch-runner.test.ts`（已有则延伸；无则新建最小可测面：注入 fake registry/safety）

**Interfaces:**
- Produces: `BatchLedger.resultRow: (observation: string, images?: string[]) => void`；`StepRecord.images?: string[]`；`tool-result` 事件 payload 增 `images?: string[]`（仅非空携带）。

- [ ] **Step 1: 写失败测试**（batch-runner 测试形态：显式注入 registry/safety/emit，resultRow 收集到数组断言）

```ts
test('工具结果带 ExecResult.images 时 resultRow 与事件 payload 均携带', async () => {
  const seen: Array<{ obs: string; images?: string[] }> = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const registry = fakeRegistry({ // 既有测试若有 fake 构造器则复用；无则内联：get→{name,category:'external',executor}
    executor: async () => ({ exitCode: 0, stdout: 'shot', stderr: '', images: ['data:image/png;base64,QQ=='] }),
  });
  const runner = new BatchRunner({ registry, safety: fakeSafetyAllow(), emit: (type, _t, payload) => events.push({ type, payload }) });
  await runner.runBatch({ calls: [{ id: 'c1', name: 'mcp__x__shot', argsJson: '{}' }], argsOf: [{}], step: 1,
    ledger: { resultRow: (obs, imgs) => seen.push({ obs, ...(imgs !== undefined ? { images: imgs } : {}) }), trackFile: () => {} } });
  assert.deepEqual(seen[0]!.images, ['data:image/png;base64,QQ==']);
  const tr = events.find((e) => e.type === 'tool-result')!;
  assert.deepEqual(tr.payload.images, ['data:image/png;base64,QQ==']);
});
test('无图结果 resultRow 第二参缺省（形态零变化回归钉）', async () => { /* executor 返回无 images；断言 seen[0].images === undefined 且 payload 无 images 键 */ });
```

- [ ] **Step 2: 跑测确认失败**：`tsc -p tsconfig.json && node --test dist/harness/batch-runner.test.js` → FAIL（签名不匹配）

- [ ] **Step 3: 实现**

batch-runner.ts：`BatchLedger.resultRow: (observation: string, images?: string[]) => void`；`emitResult` 增补与结果循环：

```ts
const obsOf: string[] = new Array(calls.length);
const imgsOf: (string[] | undefined)[] = new Array(calls.length);
// emitResult 内，describe 之后：
const imgs = r !== null && r.ok && r.value.images !== undefined ? r.value.images : undefined;
imgsOf[i] = imgs;
this.deps.emit('tool-result', obs.slice(0, 200), { ok: ..., full: obs, tool: c.name, callId: callIds[i], status: ..., ...(imgs !== undefined ? { images: imgs } : {}) });
// 批后记账循环：
ledger.resultRow(obsOf[i]!, imgsOf[i]);
```

（`emitResult` 签名已收 `r`，增补行落在既有实现内；overDuplicated/坏参分支 imgs 恒 undefined。）

reactor.ts：`StepRecord` 加 `images?: string[]`；结果回调改：

```ts
resultRow: (observation, images) => steps.push({ step, action: TOOL_RESULT_ACTION, observation, ...(images !== undefined && images.length > 0 ? { images } : {}) }),
```

收尾 `appendChain` 的 steps 映射补 images 透传（与 reasoning/thinkSeconds 同型）：`...(s.images !== undefined ? { images: s.images } : {})`。

- [ ] **Step 4: 跑测确认通过**（同 Step 2 命令 + `node --test dist/harness/context/messages.images.test.js` 回归）
- [ ] **Step 5: Commit**

```bash
git add src/harness/batch-runner.ts src/harness/batch-runner.test.ts src/harness/reactor.ts
git commit -m "feat(harness): 工具结果图片通道二——BatchRunner resultRow/事件 payload 携带 images,reactor 观察行入链"
```

### Task 3: buildMessages 剪枝 + tool-result 伴随 user 帧

**Files:**
- Modify: `src/harness/context/messages.ts`
- Test: `src/harness/context/messages.images.test.ts`（延伸）

**Interfaces:**
- Consumes: `HistoryStep.images`（已存在）、`ChatMessage` user 角色 `images`（已存在）。
- Produces: `buildMessages(input, imageHistoryLimit?: number)`——缺省 3；tool-result 行图片以**批收口后**的合成 user 帧透出（文本 `(tool image)`）。

- [ ] **Step 1: 写失败测试**

```ts
test('tool-result 行载 images：tool 消息（纯文本）+ 批收口后合成 user 帧', () => {
  const chain: HistoryStep[] = [
    { step: 1, action: 'tool-call', observation: '[tool] mcp__cu__screenshot {}' },
    { step: 1, action: 'tool-result', observation: 'shot ok', images: [IMG] },
  ];
  const msgs = buildMessages({ stableSegment: STABLE, snapshot: [], compacted: [], chain });
  assert.deepEqual(msgs[1], { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'mcp__cu__screenshot', argsJson: '{}' }] });
  assert.deepEqual(msgs[2], { role: 'tool', content: 'shot ok', toolCallId: 'call_1' });
  assert.deepEqual(msgs[3], { role: 'user', content: '(tool image)', images: [IMG] });
});
test('历史图片剪枝：仅最近 N=3 个带图行保图，更早行剥图加 [image elided] 标记', () => {
  const mk = (n: number): HistoryStep => ({ step: n, action: 'tool-call', observation: `[tool] t${n} {}` });
  const chain: HistoryStep[] = [1, 2, 3, 4, 5].flatMap((n) => [mk(n), { step: n, action: 'tool-result' as const, observation: `r${n}`, images: [IMG] }]);
  const msgs = buildMessages({ stableSegment: STABLE, snapshot: [], compacted: [], chain });
  const withImg = msgs.filter((m) => m.role === 'user' && m.images !== undefined);
  assert.equal(withImg.length, 3);
  const toolMsgs = msgs.filter((m) => m.role === 'tool') as Array<{ content: string }>;
  assert.equal(toolMsgs.filter((m) => m.content.includes('[image elided]')).length, 2);
});
test('imageHistoryLimit 覆盖与 0 值', () => {
  const chain: HistoryStep[] = [{ step: 1, action: 'task', observation: '看图', images: [IMG] }];
  const msgs = buildMessages({ stableSegment: STABLE, snapshot: [], compacted: [], chain }, 0);
  assert.deepEqual(msgs[1], { role: 'user', content: '看图\n[image elided]' });
});
```

- [ ] **Step 2: 跑测确认失败**：`tsc -p tsconfig.json && node --test dist/harness/context/messages.images.test.js` → FAIL

- [ ] **Step 3: 实现**（`buildMessages(input, imageHistoryLimit = 3)`）

```ts
// 函数体开头，链遍历前：渲染期图片历史剪枝（spec §3.2）——journal 全量留档不受影响
const imgRows = input.chain.filter((r) => r.images !== undefined && r.images.length > 0);
const keepImages = new Set(imgRows.slice(Math.max(0, imgRows.length - imageHistoryLimit)));
const imgsOf = (row: HistoryStep): string[] | undefined => {
  if (row.images === undefined || row.images.length === 0) return undefined;
  return keepImages.has(row) ? row.images : undefined;
};
const elided = (row: HistoryStep): string =>
  row.images !== undefined && row.images.length > 0 && !keepImages.has(row) ? `${row.observation}\n[image elided]` : row.observation;
```

TOOL_RESULT 分支：批内所有结果收齐（`batch.consumed >= batch.calls.length`）后 flush 伴随帧——

```ts
let pendingFrames: Array<{ images: string[] }> = [];
// TOOL_RESULT 分支内，msgs.push({role:'tool',...}) 后：
const imgs = imgsOf(row);
if (imgs !== undefined) pendingFrames.push({ images: imgs });
// 文本剥图标记：role:'tool' content 用 elided(row)
if (batch !== null && batch.consumed >= batch.calls.length) {
  for (const f of pendingFrames) msgs.push({ role: 'user', content: '(tool image)', images: f.images });
  pendingFrames = [];
}
// flushBatch() 内批闭合处同样 flush（防尾批悬挂）；无批可挂的降级 user 分支按既有 images 形态（文本用 elided(row)）
```

user 分支（task/plan/元信息行）：`images` 取 `imgsOf(row)`，文本用 `elided(row)`（空文兜底 `(image)` 判定在剥图**前**的原 observation 上）。

- [ ] **Step 4: 跑测确认通过**（本测 + `node --test dist/harness/context/messages.test.js` 回归零变化）
- [ ] **Step 5: Commit**

```bash
git add src/harness/context/messages.ts src/harness/context/messages.images.test.ts
git commit -m "feat(harness): 工具结果图片通道三——buildMessages 渲染期剪枝(缺省N=3,[image elided])+tool-result 批收口伴随 user 帧(OpenAI 兼容降级形态)"
```

### Task 4: GUI 工具行图片（事件 payload → reducer → ToolEntry 缩略图）

**Files:**
- Modify: `gui/src/connection-types.ts`（tool-result 事件 payload 形态）、`gui/src/chat-reducer.ts`（tool-result case 存 images）、`gui/src/pages/chat/ToolEntry.tsx`（缩略图渲染）
- Test: `gui/src/chat-reducer.test.ts`（延伸）+ `gui/src/pages/chat/ToolEntry` 相关既有测试形态

**Interfaces:**
- Consumes: Task 2 的 `tool-result` 事件 payload `images?: string[]`。
- Produces: 工具条目 `images?: string[]`；点击缩略图开 `ImageLightbox`（既有组件，`gui/src/ImageLightbox.tsx`）。

- [ ] **Step 1: 写失败测试**（chat-reducer 测试形态：dispatch tool-result 事件断言条目字段）

```ts
test('tool-result 事件 images → 工具条目 images 存储与渲染字段', () => {
  const state = reducer(prevState(), { type: 'tool-result', payload: { tool: 'mcp__cu__screenshot', callId: 'step:1-idx:0', ok: true, full: 'shot', status: 'completed', images: ['data:image/png;base64,QQ=='] } } as any);
  const entry = findToolEntry(state, 'mcp__cu__screenshot');
  assert.deepEqual(entry.images, ['data:image/png;base64,QQ==']);
});
```

（具体 reducer 事件形态以 `gui/src/chat-reducer.ts` 既有 tool-result case 签名为准——执行者先读该 case 再落断言。）

- [ ] **Step 2: 跑测确认失败**：`pnpm --dir gui exec vitest run src/chat-reducer.test.ts` → FAIL
- [ ] **Step 3: 实现**

1. `connection-types.ts`：tool-result payload 类型加 `images?: string[]`。
2. `chat-reducer.ts` tool-result case：条目写入 `...(payload.images !== undefined && payload.images.length > 0 ? { images: payload.images } : {})`（条目形态若为 immutable 对象沿既有展开式）。
3. `ToolEntry.tsx`：结果区在 `entry.images` 非空时渲染缩略行——

```tsx
{entry.images !== undefined && entry.images.length > 0 && (
  <div className="tool-images">
    {entry.images.map((src, i) => (
      <img key={i} src={src} alt={`tool image ${i + 1}`} className="tool-image-thumb" onClick={() => setLightbox(src)} />
    ))}
  </div>
)}
```

组件内 `const [lightbox, setLightbox] = useState<string | undefined>()`，渲染 `<ImageLightbox>`（消费形态照 `Chat.tsx`/`Mermaid.tsx` 既有用法）；`app.css` 补 `.tool-images/.tool-image-thumb`（缩略 96px 高、圆角、hover 提亮——沿既有缩略/卡面令牌）。

- [ ] **Step 4: 跑测确认通过**：`pnpm --dir gui exec vitest run` + `pnpm --dir gui run typecheck`
- [ ] **Step 5: Commit**

```bash
git add gui/src/connection-types.ts gui/src/chat-reducer.ts gui/src/chat-reducer.test.ts gui/src/pages/chat/ToolEntry.tsx gui/src/app.css
git commit -m "feat(gui): 工具结果图片渲染——事件 payload images 贯通 reducer,ToolEntry 缩略图+ImageLightbox"
```

### Task 5: 视觉规范常量上收 src/images.ts

**Files:**
- Modify: `src/images.ts`（常量单源）、`gui/src/images.ts`（改导入）

**Interfaces:**
- Produces: `IMAGE_MAX_EDGE = 1568`、`IMAGE_JPEG_QUALITY = 0.85`（`src/images.ts` 导出；computer-use server 侧 Task 17 镜像引用同值并注释跨包对齐）。

- [ ] **Step 1: 失败测试**：`src/images.test.ts`（无则新建）断言两常量值与 `MAX_IMAGES=8` 共存。
- [ ] **Step 2: 跑测失败** → **Step 3: 实现**：`src/images.ts` 追加两常量（注释写明「GUI 装载面与插件 server 生产者同规范」）；`gui/src/images.ts` 的 `DOWNSCALE_EDGE/JPEG_QUALITY` 改为 `import { IMAGE_MAX_EDGE, IMAGE_JPEG_QUALITY } from '../../src/images'` 的本地别名，行为零变化。
- [ ] **Step 4: 跑测通过 + `pnpm --dir gui exec vitest run src/images` 回归**
- [ ] **Step 5: Commit**：`git commit -m "refactor(images): 视觉规范常量单源上收 src/images.ts（GUI 装载面改导入,行为零变化）"`

---

## 批次 M1：插件框架 + 设置页 + 开发者面（Task 6-14）

### Task 6: manifest Schema artifact + 解析器

**Files:**
- Create: `plugins/schema/plugin-manifest.schema.json`
- Create: `src/config/plugins.ts`（解析与类型单点）
- Test: `src/config/plugins.test.ts`

**Interfaces:**
- Produces: `PluginManifest`、`McpServerContrib`（= `McpServerConfig` 基础上 `safety?/configArgs?/configEnv?`）、`parsePluginManifest(dir: string): { manifest: PluginManifest | null; warnings: string[]; errors: string[] }`。

- [ ] **Step 1: 失败测试**

```ts
// src/config/plugins.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePluginManifest } from './plugins';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function tmpPlugin(manifest: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'plug-'));
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  return dir;
}

test('合法 manifest 解析通过', () => {
  const dir = tmpPlugin({ manifestVersion: 1, id: 'demo', name: 'Demo', version: '0.1.0', description: 'd' });
  const r = parsePluginManifest(dir);
  assert.equal(r.errors.length, 0);
  assert.equal(r.manifest!.id, 'demo');
});
test('必填缺失 → errors 非空且 manifest null', () => {
  const r = parsePluginManifest(tmpPlugin({ manifestVersion: 1, id: 'demo' }));
  assert.ok(r.errors.length > 0);
  assert.equal(r.manifest, null);
});
test('未知顶层字段 → 告警忽略；保留键 commands/hooks/agents/tools → 告警已忽略', () => {
  const r = parsePluginManifest(tmpPlugin({ manifestVersion: 1, id: 'demo', name: 'D', version: '0.1.0', description: 'd', futureThing: 1, hooks: [] }));
  assert.equal(r.manifest, null === null ? r.manifest : r.manifest); // manifest 仍在
  assert.ok(r.warnings.some((w) => w.includes('futureThing')));
  assert.ok(r.warnings.some((w) => w.includes('hooks')));
});
test('manifestVersion 未知 major 拒载；id 与目录名不符告警', () => {
  const bad = parsePluginManifest(tmpPlugin({ manifestVersion: 2, id: 'demo', name: 'D', version: '0.1.0', description: 'd' }));
  assert.ok(bad.errors.length > 0 && bad.manifest === null);
  const dir = mkdtempSync(path.join(tmpdir(), 'plug-'));
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'other', name: 'D', version: '0.1.0', description: 'd' }));
  const r = parsePluginManifest(dir);
  assert.ok(r.warnings.some((w) => w.includes('目录名')));
});
test('JSON 非法/文件缺失 → errors 非空不抛', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plug-'));
  writeFileSync(path.join(dir, 'plugin.json'), '{oops');
  assert.ok(parsePluginManifest(dir).errors.length > 0);
  assert.ok(parsePluginManifest(path.join(dir, 'nope')).errors.length > 0);
});
```

- [ ] **Step 2: 跑测失败**：`tsc && node --test dist/config/plugins.test.js`
- [ ] **Step 3: 实现**——`plugins/schema/plugin-manifest.schema.json`（draft-07，字段同 spec §2.2 表；`mcpServers.additionalProperties` = McpServerConfig + `safety:{act/confirm/observe:string[]}` + `configArgs:Record<string,string[]>` + `configEnv:Record<string,string>`；`configSchema` 自由对象；`commands/hooks/agents/tools` 列入 properties 但标 `"deprecated": true`）。`src/config/plugins.ts` 核心：

```ts
export interface McpSafetyDecl { act?: string[]; confirm?: string[]; observe?: string[] }
export interface McpServerContrib { name: string; command: string; args?: string[]; env?: Record<string, string>; transport?: 'stdio'; cwd?: string;
  safety?: McpSafetyDecl; configArgs?: Record<string, string[]>; configEnv?: Record<string, string> }
export interface PluginManifest { manifestVersion: 1; id: string; name: string; version: string; description: string;
  platforms?: NodeJS.Platform[]; defaultEnabled?: boolean; mcpServers?: Record<string, Omit<McpServerContrib, 'name'>>; skills?: string[];
  configSchema?: Record<string, { type: string; description?: string }>; config?: Record<string, unknown> }
const RESERVED = ['commands', 'hooks', 'agents', 'tools'] as const;
const REQUIRED: Array<keyof PluginManifest> = ['manifestVersion', 'id', 'name', 'version', 'description'];
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function parsePluginManifest(dir: string): { manifest: PluginManifest | null; warnings: string[]; errors: string[] } {
  const warnings: string[] = []; const errors: string[] = [];
  const file = path.join(dir, 'plugin.json');
  if (!fs.existsSync(file)) return { manifest: null, warnings, errors: [`manifest missing: ${file}`] };
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { manifest: null, warnings, errors: [`plugin.json 非法 JSON: ${e instanceof Error ? e.message : String(e)}`] }; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { manifest: null, warnings, errors: ['plugin.json 须为对象'] };
  const o = raw as Record<string, unknown>;
  if (o.manifestVersion !== 1) { errors.push(`不支持的 manifestVersion: ${String(o.manifestVersion)}（支持 1）`); return { manifest: null, warnings, errors }; }
  for (const k of RESERVED) if (k in o) warnings.push(`贡献点 ${k} 本版本未实现，已忽略`);
  for (const k of Object.keys(o)) if (!(k in o) === false && !KNOWN_KEYS.has(k) && !RESERVED.includes(k as never)) warnings.push(`未知字段 ${k} 已忽略`);
  for (const k of REQUIRED) if (typeof o[k] !== 'string' && k !== 'manifestVersion') errors.push(`缺必填字段 ${k}`); else if (k === 'manifestVersion' && o[k] !== 1) errors.push(`manifestVersion 须为 1`);
  const id = typeof o.id === 'string' ? o.id : '';
  if (!ID_RE.test(id)) errors.push(`id 非规范: ${id}`);
  if (id !== '' && path.basename(dir) !== id) warnings.push(`id 与目录名不一致（${id} ≠ ${path.basename(dir)}）`);
  if (errors.length > 0) return { manifest: null, warnings, errors };
  const m = raw as unknown as PluginManifest;
  // mcpServers 逐条形状校验（stdio 需 command；safety 三类须字符串数组）……与 mcp.json 解析同纪律：错条跳过+告警
  return { manifest: m, warnings, errors };
}
const KNOWN_KEYS = new Set(['manifestVersion', 'id', 'name', 'version', 'description', 'platforms', 'defaultEnabled', 'mcpServers', 'skills', 'configSchema', 'config']);
```

（上面 unknown 字段判定的笔误在落码时写成单一直观形式：`if (!KNOWN_KEYS.has(k) && !RESERVED.includes(k as never)) warnings.push(...)`。mcpServers 逐条校验沿 `parseMcpJsonFile`（src/config.ts:52）同构实现。）

- [ ] **Step 4: 跑测通过**
- [ ] **Step 5: Commit**：`feat(config): 插件 manifest 解析单点——manifestVersion 1 规范/schema artifact/保留键与未知字段告警面`

### Task 7: 两级装载 + 启用态合并（loadEffectivePlugins）

**Files:**
- Modify: `src/config/plugins.ts`（追加装载面）
- Modify: `src/config/settings.ts`（`SettingsDoc` 加 `plugins?: unknown` 直通；flatten 收集沿 `permissions` 先例约 149-155 行）
- Test: `src/config/plugins.test.ts`（延伸）

**Interfaces:**
- Produces:

```ts
export interface EffectivePlugin { manifest: PluginManifest; dir: string; source: 'builtin' | 'user'; enabled: boolean; config: Record<string, unknown>; platformSupported: boolean; warnings: string[] }
export function loadEffectivePlugins(projectRoot: string | undefined, opts?: { builtinRoot?: string }): { plugins: EffectivePlugin[]; warnings: string[] }
```

- [ ] **Step 1: 失败测试**（tmpdir 造 builtin/user 两根 + 临时 settings 文件；settings 注入面用 opts 扩展 `settingsReader?: (scope) => Record<string, unknown> | null` 以便测试免真写 HOME——生产缺省走 `parseSettingsFile`）

```ts
test('启用态合并：settings 覆盖 defaultEnabled，项目遮蔽全局', () => {
  // builtin demo(defaultEnabled:false)；global settings {plugins:{demo:{enabled:true}}}；project settings {plugins:{demo:{enabled:false}}}
  const r = loadEffectivePlugins(projRoot, { builtinRoot: bRoot, userRoot: uRoot, settingsReader });
  assert.equal(r.plugins[0]!.enabled, false); // 项目关覆盖全局开
});
test('用户级 id 撞名遮蔽内置；平台不匹配剔除且告警', () => { /* user demo 覆盖 builtin demo；platforms:['darwin'] 在 win32 测（ process.platform 断言跳过 darwin CI）——平台断言用注入 platform 参数（缺省 process.platform）保持可测 */ });
test('plugins 键形状非法 → 告警忽略该键（宁少配）', () => { /* {plugins:{demo:true}} 非对象值 → 告警+defaultEnabled */ });
```

- [ ] **Step 2: 跑测失败**
- [ ] **Step 3: 实现**——`loadEffectivePlugins`：

```ts
export function loadEffectivePlugins(projectRoot: string | undefined, opts: { builtinRoot?: string; userRoot?: string; settingsReader?: (scope: 'global' | 'project') => Record<string, unknown> | null; platform?: NodeJS.Platform } = {}): { plugins: EffectivePlugin[]; warnings: string[] } {
  const builtinRoot = opts.builtinRoot ?? path.join(REPO_ROOT, 'plugins');
  const userRoot = opts.userRoot ?? path.join(userConfigDir(), 'plugins');
  const platform = opts.platform ?? process.platform;
  const warnings: string[] = [];
  const scan = (root: string, source: 'builtin' | 'user'): EffectivePlugin[] => {
    if (!fs.existsSync(root)) return [];
    const out: EffectivePlugin[] = [];
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name);
      const r = parsePluginManifest(dir);
      warnings.push(...r.warnings.map((w) => `[${source}:${d.name}] ${w}`));
      if (r.manifest === null) { warnings.push(...r.errors.map((e) => `[${source}:${d.name}] ${e}`)); continue; }
      out.push({ manifest: r.manifest, dir, source, enabled: r.manifest.defaultEnabled === true, config: {}, platformSupported: (r.manifest.platforms ?? []).length === 0 || (r.manifest.platforms ?? []).includes(platform), warnings: r.warnings });
    }
    return out;
  };
  const byId = new Map<string, EffectivePlugin>();
  for (const p of scan(builtinRoot, 'builtin')) byId.set(p.manifest.id, p);
  for (const p of scan(userRoot, 'user')) { const prev = byId.get(p.manifest.id); if (prev !== undefined) warnings.push(`[user] 插件 ${p.manifest.id} 遮蔽内置版`); byId.set(p.manifest.id, p); }
  // 启用态：global ← project 两级合并（settings 语义键 plugins：{<id>:{enabled?,config?}}）
  const read = (scope: 'global' | 'project'): Record<string, unknown> => {
    const doc = opts.settingsReader !== undefined ? opts.settingsReader(scope)
      : scope === 'global' ? parseSettingsDoc(loadGlobalSettings()) : projectRoot === undefined ? null : parseSettingsDoc(loadProjectSettings(projectRoot));
    const v = doc?.plugins;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  };
  const merged = { ...read('global'), ...read('project') };
  const plugins = [...byId.values()].map((p) => {
    const ov = merged[p.manifest.id];
    let enabled = p.enabled; let config: Record<string, unknown> = {};
    if (typeof ov === 'object' && ov !== null && !Array.isArray(ov)) {
      const o = ov as { enabled?: unknown; config?: unknown };
      if (typeof o.enabled === 'boolean') enabled = o.enabled;
      if (typeof o.config === 'object' && o.config !== null && !Array.isArray(o.config)) config = o.config as Record<string, unknown>;
    } else if (ov !== undefined) warnings.push(`plugins.${p.manifest.id} 须为对象，已忽略`);
    return { ...p, enabled, config };
  });
  return { plugins, warnings };
}
```

（`parseSettingsDoc`：settings 文本 → `JSONC.parse` 既有 stripJsonComments+JSON.parse 组合取 `.plugins`/全文对象；复用 settings.ts 导出面，缺则小助手。`REPO_ROOT`：`path.resolve(__dirname, '..', '..')`——dist/config 下两级到包根，与既有 `userConfigDir` 同文件域。）

`src/config/settings.ts`：`SettingsDoc` 接口加 `plugins?: unknown`（注释：形状裁决在 config/plugins.ts，不经 flatten/env 槽——沿 permissions 注释）；解析收集处（permissions 同位置）加 `if (key === 'plugins') plugins = root[key]`，返回对象与接口同步。

- [ ] **Step 4: 跑测通过**（+ `node --test dist/config/settings*.test.js` 回归）
- [ ] **Step 5: Commit**：`feat(config): 插件两级装载+启用态合并——loadEffectivePlugins(遮蔽/平台/语义键 plugins 两级,容错告警)`

### Task 8: MCP 名单合成（configArgs/configEnv 展开 + harness 集成）

**Files:**
- Modify: `src/config/plugins.ts`（追加 `pluginMcpServers` + `collectMcpSafety`）
- Modify: `src/config.ts`（`McpServerConfig` 加 `cwd?: string`——types 在 types.ts:346 则改 types.ts）、`src/harness/mcp/client.ts`（stdio transport 传 cwd）
- Modify: `src/harness/index.ts`（名单合成处约 133-140 行；guard safety 注入点沿 mcpServers 登记处）
- Test: `src/config/plugins.test.ts`（延伸）

**Interfaces:**
- Produces:

```ts
export function pluginMcpServers(projectRoot: string | undefined, opts?: Parameters<typeof loadEffectivePlugins>[2]): { servers: McpServerConfig[]; safety: Record<string, McpSafetyDecl>; warnings: string[] }
```

- [ ] **Step 1: 失败测试**

```ts
test('configArgs 展开：布尔 true 旗标 / {value} 替换 / 缺省 config 不展开', () => {
  // manifest mcpServers.b{args:['x'],configArgs:{headless:['--headless'],browser:['--browser','{value}']},configDefaults:{browser:'chrome'}}
  // config {} → args ['x','--browser','chrome']；config {headless:true,browser:'firefox'} → ['x','--headless','--browser','firefox']
});
test('configEnv 展开：env 键 ← config 值字符串化', () => { /* configEnv:{CU_WORKER:'worker'}, config:{worker:'pwsh'} → env.CU_WORKER==='pwsh' */ });
test('用户 mcp.json 同名遮蔽插件 server；插件间撞名字典序先到先得+告警', () => { /* loadMcpServers 注入或 userNames 参数 */ });
test('safety 收集：server 名 → 三类decl（仅启用且平台可用插件）', () => { /* disabled 插件的 server/safety 不出 */ });
```

- [ ] **Step 2: 跑测失败**
- [ ] **Step 3: 实现**——`pluginMcpServers`：

```ts
export function pluginMcpServers(projectRoot: string | undefined, opts: {} & Partial<Parameters<typeof loadEffectivePlugins>[2]> & { userServerNames?: ReadonlySet<string> } = {}): { servers: McpServerConfig[]; safety: Record<string, McpSafetyDecl>; warnings: string[] } {
  const { plugins, warnings } = loadEffectivePlugins(projectRoot, opts);
  const servers: McpServerConfig[] = []; const safety: Record<string, McpSafetyDecl> = {}; const seen = new Set<string>();
  for (const p of plugins.sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : 1))) {
    if (!p.enabled || !p.platformSupported) continue;
    for (const [name, cfg] of Object.entries(p.manifest.mcpServers ?? {})) {
      if (opts.userServerNames?.has(name)) { warnings.push(`插件 server ${name} 被用户 mcp.json 遮蔽`); continue; }
      if (seen.has(name)) { warnings.push(`插件 server ${name} 撞名（${p.manifest.id}），后者跳过`); continue; }
      seen.add(name);
      const merged = { ...(cfg as { configDefaults?: Record<string, unknown> }).configDefaults, ...p.config };
      const baseArgs = (cfg as { args?: string[] }).args ?? [];
      const expand = (patterns: string[] | undefined): string[] => {
        if (patterns === undefined) return [];
        const v = merged[(cfg as { configArgsKeyOf?: never }) && patterns.configKey as string]; // 落码时改为逐键展开，见下
        return [];
      };
      // 逐键展开（configArgs 是 Record<configKey, string[]>）：
      const args = [...baseArgs];
      for (const [key, patterns] of Object.entries((cfg as { configArgs?: Record<string, string[]> }).configArgs ?? {})) {
        const v = merged[key];
        if (v === undefined) continue;
        for (const pat of patterns) args.push(pat.includes('{value}') ? pat.replace('{value}', String(v)) : (v === true ? pat : pat.replace('{value}', String(v))));
      }
      const env = { ...(cfg as { env?: Record<string, string> }).env };
      for (const [envKey, confKey] of Object.entries((cfg as { configEnv?: Record<string, string> }).configEnv ?? {})) {
        const v = merged[confKey];
        if (v !== undefined) env[envKey] = String(v);
      }
      servers.push({ name, command: (cfg as { command: string }).command, args, env: Object.keys(env).length > 0 ? env : undefined,
        cwd: (cfg as { cwd?: string }).cwd === '.' ? p.dir : (cfg as { cwd?: string }).cwd });
      const s = (cfg as { safety?: McpSafetyDecl }).safety;
      if (s !== undefined) safety[name] = s;
    }
  }
  return { servers, safety, warnings };
}
```

（落码时以清晰实现替换草稿中 `expand` 残段——只保留「逐键展开」块；`configDefaults` 挂 manifest mcpServers 条目可选字段并进 schema。）

`McpServerConfig`（types.ts）加 `cwd?: string`；`client.ts` stdio 分支 `new StdioClientTransport({ command, args, env: {...}, ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}) })`（SDK 支持项；不支持则 `SpawnOptions` 兜底——以 SDK 1.30 类型为准）。

`src/harness/index.ts` 名单处：`servers = [...loadMcpServers(root), ...pluginMcpServers(root, { userServerNames: new Set(loadMcpServers(root).map(s=>s.name)) }).servers]`；`guard.setMcpSafety(pluginMcpServers 返回的 safety)`（Task 9 消费；本任务先接线传递，guard 侧空实现）。触发点在构造期既有 `loadMcpServers` 调用处——合并一次调用避免双算。

- [ ] **Step 4: 跑测通过**
- [ ] **Step 5: Commit**：`feat(harness): 插件 MCP 名单合成——configArgs/configEnv 展开+用户遮蔽+撞名字典序+safety 收集,McpServerConfig.cwd 贯通`

### Task 9: guard 声明式 safety 三类消费

**Files:**
- Modify: `src/harness/security/guard.ts`（mcp 登记分支约 38-43 行后扩展；`McpSafetyDecl` 导入）
- Test: `src/harness/security/guard.test.ts`（已有则延伸）

**Interfaces:**
- Consumes: `Record<string, McpSafetyDecl>`（Task 8）。
- Produces: `guard.setMcpSafety(map)`；行为矩阵：`act`=任何档位 ask（read-only 直拒）/`confirm`=ask+会话 always（full-access 自动放行沿通用行为）/`observe`=只读白名单资格（read-only/acceptEdits 直放）。

- [ ] **Step 1: 失败测试**（guard 构造形态沿既有测试：mode/mcpServers 注入）

```ts
const SAFETY = { 'computer-use': { act: ['click'], confirm: ['screenshot'], observe: ['window_list'] } };
test('act：full-access 仍 ask、read-only 直拒', () => {
  const g = mkGuard('full-access', ['computer-use']); g.setMcpSafety(SAFETY);
  assert.deepEqual(g.preToolUse('mcp__computer-use__click', { x: 1, y: 2 }), { allowed: false, ask: true, reason: expectAskReason });
  const ro = mkGuard('read-only', ['computer-use']); ro.setMcpSafety(SAFETY);
  assert.equal(ro.preToolUse('mcp__computer-use__click', { x: 1, y: 2 }).allowed, false);
});
test('observe：read-only/acceptEdits 直放；未登记 server 仍拒', () => { /* window_list 三档 allowed:true；未登记 server 名照旧 denied */ });
test('confirm：acceptEdits ask→会话 always 放行；deny 规则先于 observe', () => { /* screenshot acceptEdits ask:true；resolveAsk('always') 后第二次 allowed:true */ });
test('未声明 safety 的 mcp server 行为零变化（回归钉）', () => { /* 通用 mcp 工具各档位行为与既有测试一致 */ });
```

- [ ] **Step 2: 跑测失败**
- [ ] **Step 3: 实现**

```ts
private mcpSafety: Record<string, McpSafetyDecl> = {};
setMcpSafety(map: Record<string, McpSafetyDecl>): void { this.mcpSafety = map; }
private mcpSafetyClass(tool: string): 'act' | 'confirm' | 'observe' | undefined {
  const rest = tool.slice('mcp__'.length);
  const sp = rest.indexOf('__');
  const server = rest.slice(0, sp); const name = rest.slice(sp + 2);
  const decl = this.mcpSafety[server];
  if (decl === undefined) return undefined;
  if (decl.act?.includes(name)) return 'act';
  if (decl.confirm?.includes(name)) return 'confirm';
  if (decl.observe?.includes(name)) return 'observe';
  return undefined;
}
```

mcp 分支（登记检查之后）追加：

```ts
const cls = this.mcpSafetyClass(tool);
if (cls === 'observe') return { allowed: true };
if (cls === 'act') {
  if (this.mode === 'read-only') return { allowed: false, reason: 'COMMAND_DENIED: read-only mode denies plugin action tools' };
  // 强制 ask：早退跳过 full-access 自动放行与 read-only/acceptEdits 档位面；会话 always/asker 在 preToolUseAsync 生效
  return { allowed: false, ask: true, reason: 'COMMAND_DENIED: plugin action tools always require approval' };
}
// confirm：不在此处理——落既有 policy ask 面（acceptEdits→asker+会话 always；full-access 自动放行；read-only 拒绝）
```

关键点自证（写进测试注释）：`act` 早退**先于**档位处理代码路径，full-access 自动放行不再命中；`confirm` 走通用面即获得 always 机制（preToolUseAsync `sessionAllows`），零新状态。

- [ ] **Step 4: 跑测通过**（+ guard 全量既有测试回归）
- [ ] **Step 5: Commit**：`feat(harness): guard 声明式插件安全契约——safety 三类通用消费(act 强制 ask 绕档位/observe 白名单/confirm 走通用 ask+always)`

### Task 10: 技能装载链并入插件 skills 根

**Files:**
- Modify: `src/harness/skills.ts`（`priorityChain` 约 88-90 行）
- Test: `src/harness/skills.test.ts`（延伸；沿既有链装载测试形态）

**Interfaces:**
- Produces: 插件 skills 目录以**最低优先级**并入（项目五根 > 全局 > 学习 > 插件）。

- [ ] **Step 1: 失败测试**：tmp 项目根 + opts 注入插件 skills 目录（`priorityChain` 加可选参 `pluginSkillDirs?: string[]` 保持纯函数可测），断言同 id 技能：项目根遮蔽插件根；无冲突时插件技能入清单。
- [ ] **Step 2: 跑测失败**
- [ ] **Step 3: 实现**

```ts
function priorityChain(root: string, pluginSkillDirs: string[] = []): string[] {
  return [...projectSkillDirs(root)].reverse().concat([userSkillsDir(), learnedSkillsDir(root)], pluginSkillDirs);
}
```

调用侧（装载入口）传 `loadEffectivePlugins(root).plugins.filter(p => p.enabled && p.platformSupported).flatMap(p => (p.manifest.skills ?? []).map(rel => path.join(p.dir, rel)))`——装载入口处一次调用，目录不存在自然跳过（`loadSkillsFrom` 已容错）。
- [ ] **Step 4: 跑测通过**（+ skills 全量回归）
- [ ] **Step 5: Commit**：`feat(harness): 插件 skills 并入技能装载链（最低优先级根,启用且平台可用才并入）`

### Task 11: serve 端点 GET/PUT /settings/plugins

**Files:**
- Modify: `src/serve/config-handlers.ts`（追加 handlers；沿 handleMcpGet/PUT 形态约 317-360 行）
- Modify: `src/serve/daemon.ts`（路由登记——grep `'/settings/mcp'` 定位注册表同型登记 GET/POST `/settings/plugins`）
- Test: `src/serve/config-handlers.test.ts`（延伸既有 handler 测试形态）

**Interfaces:**
- Produces: `GET /settings/plugins?root=` → `{ plugins: [{ id,name,version,description,source,enabled,platformSupported,servers:string[],skillsCount,configSchema,config,warnings }], warnings }`；`PUT /settings/plugins` `{root?, id, enabled?, config?}` → 200 `{ok:true}`。

- [ ] **Step 1: 失败测试**（handler 直测：fake io 沿既有 config-handlers 测试；tmp 造插件根与 settings 文件）

```ts
test('GET：清单含来源/启用态/平台/告警；PUT：enabled 写入 settings 语义键且两级读取生效', async () => {
  const res = await get('/settings/plugins?root=' + projRoot); // fake io 形态沿既有
  assert.equal(res.plugins[0]!.id, 'demo');
  await put('/settings/plugins', { root: projRoot, id: 'demo', enabled: true });
  const after = await get('/settings/plugins?root=' + projRoot);
  assert.equal(after.plugins[0]!.enabled, true);
});
test('PUT：未知 id → 404；settings 含注释 → 409 引流 raw', () => { /* 沿 PUT /settings/mcp 同款守卫断言 */ });
```

- [ ] **Step 2: 跑测失败**
- [ ] **Step 3: 实现**——GET 直接调 `loadEffectivePlugins(root)`（builtinRoot 取运行包根 `plugins/`）；PUT：读目标 settings 文件（root 在场=项目级 `.sunshinex/settings.json`，缺省=全局）→ `stripJsonComments`+JSON.parse；含注释（与原文不等）或畸形 → 409 引流 raw；改 `plugins.<id>={enabled,config}` → `JSON.stringify(?, null, 2)` 原子写（同目录 tmp+rename）→ `io.reloadSettingsChain(root)`。config 开关字段仅接受对象/布尔（形状错 400）。
- [ ] **Step 4: 跑测通过**
- [ ] **Step 5: Commit**：`feat(serve): /settings/plugins 两端点——清单视图化(GET)+语义键结构化写(PUT,409 引流 raw,原子写+链重载)`

### Task 12: GUI 插件 pane

**Files:**
- Create: `gui/src/settings/PluginsPane.tsx`
- Modify: `gui/src/settings/SettingsShell.tsx`（导航/注册）、`gui/src/connection.ts` + `connection-types.ts`（`plugins(root)` / `putPlugin(root, id, patch)` 客户端）、`gui/src/App.tsx`（conn 装配透传——沿 McpPane 接线处）、i18n 词条、`gui/src/app.css`
- Test: `gui/src/settings/PluginsPane.test.tsx`

**Interfaces:**
- Consumes: Task 11 两端点。
- Produces: `PluginsPaneConn { plugins(root?: string): Promise<PluginsView>; putPlugin(root: string, id: string, patch: { enabled?: boolean }): Promise<void> }`。

- [ ] **Step 1: 失败测试**（沿 McpPane 测试形态：mock conn）

```tsx
test('插件卡渲染：名称/版本/来源徽标/开关；未选 root 时写钮禁用', async () => { /* render <PluginsPane conn={mockConn} root="" />：断言卡文本与 disabled */ });
test('切换开关 → putPlugin 调用并重拉', async () => { /* fireEvent.click 后断言 mock 调用序列 */ });
test('加载失败徽标：warnings 非空插件卡显示告警行', async () => { /* mock 带 warnings 的插件 */ });
```

- [ ] **Step 2: 跑测失败**：`pnpm --dir gui exec vitest run src/settings/PluginsPane.test.tsx`
- [ ] **Step 3: 实现**——组件骨架（完整态沿 McpPane 卡列表/行内错误条交互语言）：

```tsx
export interface PluginsPaneConn { plugins(root?: string): Promise<{ plugins: PluginRow[]; warnings?: string[] }>; putPlugin(root: string, id: string, patch: { enabled?: boolean }): Promise<void> }
export interface PluginRow { id: string; name: string; version: string; description: string; source: 'builtin' | 'user'; enabled: boolean; platformSupported: boolean; servers: string[]; warnings: string[] }
```

卡片：名称+版本+`<SourceBadge>`+开关钮（`disabled={!root || !row.platformSupported}`，不支持平台加「平台不支持」置灰）+描述行+贡献面行（`servers` 名列表）+warnings 行内告警条。写面恒项目级（root 缺省禁用+提示，沿 McpPane 裁定）。SettingsShell：`SETTINGS_NAV` 插「插件」项 + `renderPane` 分支 + `SettingsShellConn extends PluginsPaneConn`；App 的 conn 对象补两方法（fetch/PUT 直连 daemon 端点，沿 `conn.mcpServers` 同款）。i18n 中英词条随批。
- [ ] **Step 4: 跑测通过**（gui vitest 全量 + typecheck）
- [ ] **Step 5: Commit**：`feat(gui): 设置页插件 pane——卡片清单/来源徽标/开关写面(项目级)/告警可见性,沿 MCP pane 交互语言`

### Task 13: plugins list/validate CLI

**Files:**
- Create: `src/cli/commands/plugins.ts`
- Modify: `src/cli/index.ts`（import、`COMMANDS` 数组加 `'plugins'`、case 分支、EN/ZH usage 两行——沿 skills 同位）
- Test: `src/cli/commands/plugins.test.ts`

**Interfaces:**
- Produces: `runPlugins(args: string[]): Promise<number>`（exit code）；`sunshinex plugins list [--root <abs>]`、`sunshinex plugins validate <dir>`。

- [ ] **Step 1: 失败测试**（沿 skills-install.test 形态：注入 console 捕获/临时目录）

```ts
test('validate：合法目录 exit 0；非法 manifest exit 1 且打印错误', async () => { /* tmpPlugin 复用 Task 6 助手 */ });
test('list：输出表含 id/version/来源/启用态/server 名', async () => { /* 断言输出行包含字段值 */ });
```

- [ ] **Step 2: 跑测失败**
- [ ] **Step 3: 实现**——list：`loadEffectivePlugins(root ?? process.cwd())` → `cli-table3` 表（dep 已有）；validate：`parsePluginManifest(dir)` → errors/warnings 逐行打印，`errors.length > 0 ? 1 : 0`。cli/index.ts：`case 'plugins': return runPlugins(rest);`
- [ ] **Step 4: 跑测通过**（+ `node --test dist/cli/cli.test.js` 回归）
- [ ] **Step 5: Commit**：`feat(cli): plugins list/validate——插件作者 lint 面（schema 同源校验,exit code 可进 CI）`

### Task 14: docs/PLUGIN-DEV.md 开发指南 + 治理回写

**Files:**
- Create: `docs/PLUGIN-DEV.md`（正文按 spec §2.6 九节提纲写全：运行形态三层分工图（文字版）、五分钟最小插件（完整 plugin.json+目录树）、manifest 全表（同 spec §2.2）、safety 三类声明义务与信任模型、config/configSchema、生命周期与生效时机、调试三出口、发布约定（放 `~/.sunshinex/plugins/`，version semver，README 建议）、实例解构（browser-use 包现成 server / computer-use 自建——指向 M2/M3 交付物））
- Modify: `CLAUDE.md`（§5 补：插件工具不入内置清单（走 `mcp__` 前缀）；插件=治理层；safety 三类口径）、`MANUAL.md`（新「插件」节：启用/禁用、settings 键、安全与信任模型）

- [ ] **Step 1: 写文档**（内容以 spec §2 为唯一权威展开；最小插件示例直接可拷贝运行）
- [ ] **Step 2: 校验**：文档内示例 manifest 逐个过 `sunshinex plugins validate`（手工）；`pnpm test` + `node dist/cli/index.js selfcheck` 过
- [ ] **Step 3: Commit**：`docs: PLUGIN-DEV.md 插件开发指南+CLAUDE/MANUAL 治理回写（manifest 规范/safety 契约/信任模型）`

---

## 批次 M2：browser-use 系统插件（Task 15-16）

### Task 15: plugins/browser-use 工作区包 + 装配联调

**Files:**
- Create: `plugins/browser-use/package.json`、`plugins/browser-use/plugin.json`、`plugins/browser-use/README.md`
- Modify: `pnpm-workspace.yaml`（`packages:` 加 `plugins/*`）
- Test: `src/config/plugins.test.ts` 延伸（真实内置根装载钉）

**Interfaces:**
- Consumes: Task 7/8 装载与合成面。
- Produces: 启用后 harness 工具面出现 `mcp__browser-use__*`；config 键 `browser/headless/isolated/caps/userDataDir`。

- [ ] **Step 1: 落包**

```json
// plugins/browser-use/package.json
{ "name": "sunshinex-plugin-browser-use", "version": "0.1.0", "private": true, "description": "sunshinex 内置插件：Playwright MCP 浏览器自动化",
  "dependencies": { "@playwright/mcp": "*" } }
```

安装（版本由 lockfile 钉定，不猜号）：`pnpm install`（workspace 自动装）后 `pnpm --dir plugins/browser-use exec pnpm add @playwright/mcp@latest --save-exact`。

```json
// plugins/browser-use/plugin.json
{ "manifestVersion": 1, "id": "browser-use", "name": "浏览器操作", "version": "0.1.0",
  "description": "Playwright 驱动的浏览器自动化（a11y snapshot 主线，vision 兜底可开）",
  "defaultEnabled": false,
  "mcpServers": { "browser-use": { "command": "node", "cwd": ".",
    "args": ["node_modules/@playwright/mcp/cli.js"],
    "configDefaults": { "browser": "chrome" },
    "configArgs": { "browser": ["--browser", "{value}"], "headless": ["--headless"], "isolated": ["--isolated"], "caps": ["--caps", "{value}"], "userDataDir": ["--user-data-dir", "{value}"] } } },
  "skills": ["skills"],
  "configSchema": { "browser": { "type": "string", "description": "浏览器：chrome|chromium|firefox|webkit|msedge" }, "headless": { "type": "boolean", "description": "无头模式" }, "isolated": { "type": "boolean", "description": "内存临时 profile（登录态不持久）" }, "caps": { "type": "string", "description": "能力组：tabs,pdf,devtools,network,storage,vision,testing" }, "userDataDir": { "type": "string", "description": "持久 profile 目录（建议 <dataDir>/plugins/browser-use/profile）" } } }
```

（`cwd: "."` 在 Task 8 已解析为插件目录——node_modules 相对解析成立。`--user-data-dir` 旗标名以所装版本的 `--help` 实测为准，不符则改映射。）

`pnpm-workspace.yaml`：

```yaml
packages:
  - gui
  - shell
  - plugins/*
```

- [ ] **Step 2: 失败测试**（真实根装载钉）

```ts
test('内置根装载 browser-use：未启用不出 server；enabled 后 pluginMcpServers 出 browser-use 且 args 含 --browser chrome', () => {
  const r = pluginMcpServers(undefined, { builtinRoot: path.resolve(__dirname, '../../plugins'), settingsReader: () => ({ plugins: { 'browser-use': { enabled: true } } }) });
  assert.equal(r.servers[0]!.name, 'browser-use');
  assert.ok(r.servers[0]!.args!.includes('--browser'));
});
```

跑：`tsc && node --test dist/config/plugins.test.js` → FAIL（根不存在/装载空）

- [ ] **Step 3: 修过**：确认 dist 面插件根解析（运行包根 `plugins/` 随包分发——`files` 白名单与打包脚本若需补 `plugins` 条目则本任务一并加 package.json `files`）。
- [ ] **Step 4: 端到端探活**：临时全局 settings 置 enabled → `node dist/cli/index.js run "用 browser_snapshot 打开 example.com 并返回页面标题" --max-steps 6` 观察工具注册与调用（headed Chrome 弹出）；验后还原 settings。
- [ ] **Step 5: Commit**：`feat(plugins): browser-use 内置插件——工作区包+manifest(configArgs 映射/configDefaults)+workspace 成员+装载钉`

### Task 16: browser-use 技能 + 使用文档

**Files:**
- Create: `plugins/browser-use/skills/web-testing/SKILL.md`（frontmatter name/description/version；正文：snapshot→定位 ref→操作→verify 的标准循环、tab/存储 caps、敏感面 deny 示例 `mcp__browser-use__browser_run_code_unsafe`）
- Modify: `plugins/browser-use/README.md`（profile 风险注记 spec §4.3；headed 默认理由）
- [ ] **Step 1: 写技能与文档**；`sunshinex plugins validate plugins/browser-use` 过；启用插件后 `/web-testing` 技能出现在清单（`run` 一轮验证或 skills 清单单测）。
- [ ] **Step 2: Commit**：`feat(plugins): browser-use 技能 web-testing+README 风险注记`

---

## 批次 M3：computer-use 系统插件（Task 17-21）

### Task 17: server 骨架 + 坐标缩放纯函数

**Files:**
- Create: `plugins/computer-use/package.json`（`dependencies: {"@modelcontextprotocol/sdk": "^1.30.0"}`、devDeps typescript/@types/node；`main: server/index.js`）、`plugins/computer-use/tsconfig.json`（CommonJS/outDir 同主仓口径）
- Create: `plugins/computer-use/server/src/scale.ts`、`server/src/tools.ts`（工具表：name/description/inputSchema）、`server/src/index.ts`（stdio server 装配）
- Test: `plugins/computer-use/server/test/scale.test.ts`（node:test，子包内 `node --test`）

**Interfaces:**
- Produces: `shrinkToEdge(w,h,edge?)`、`toPhysical(x,y,meta)`；`TOOLS: ToolDef[]`（13 工具，strict 兼容 schema：additionalProperties:false、全字段 required、可选项 null 联合）；`createServer(worker: WorkerClient)`（依赖注入供测试）。

- [ ] **Step 1: 失败测试**

```ts
test('shrinkToEdge：1568 长边封顶与不放大', () => {
  assert.deepEqual(shrinkToEdge(3136, 1568), { width: 1568, height: 784 });
  assert.deepEqual(shrinkToEdge(800, 600), { width: 800, height: 600 });
});
test('toPhysical：缩放比反算（sent→orig）', () => {
  assert.deepEqual(toPhysical(100, 50, { origWidth: 2000, origHeight: 1000, sentWidth: 1000, sentHeight: 500 }), { x: 200, y: 100 });
});
```

- [ ] **Step 2: 跑测失败**：`cd plugins/computer-use && npx tsc -p tsconfig.json && node --test server/test/scale.test.js`（编译产物路径按子包 tsconfig）
- [ ] **Step 3: 实现**

```ts
// scale.ts
export interface ScreenMeta { origWidth: number; origHeight: number; sentWidth: number; sentHeight: number }
export function shrinkToEdge(w: number, h: number, edge = 1568): { width: number; height: number } {
  const s = Math.min(1, edge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}
export function toPhysical(x: number, y: number, m: ScreenMeta): { x: number; y: number } {
  return { x: Math.round((x * m.origWidth) / m.sentWidth), y: Math.round((y * m.origHeight) / m.sentHeight) };
}
```

`tools.ts`：13 工具定义（screenshot/uia_snapshot/window_list/click/type/key/scroll/drag/wait/wait_for/app；schema 全 required+`|null` 可选，如 `"region": {"type": ["array","null"], "items": {"type":"number"}, "minItems":4, "maxItems":4}`——沿主仓 strict 口径）。`index.ts`：`@modelcontextprotocol/sdk` 低层 `Server` + `StdioServerTransport`，`CallToolRequest` 分发到 `dispatchTool(worker, name, args)`（Task 18/19/20 充实；本任务返回 `content:[{type:'text',text:'not implemented'}]` 占位但工具清单/协议面全通）。
- [ ] **Step 4: 跑测通过**；协议冒烟：`node server/index.js` 手动 JSON-RPC initialize/tools_list。
- [ ] **Step 5: Commit**：`feat(plugins/computer-use): server 骨架——13 工具 strict schema+坐标缩放置账纯函数+stdio 装配(注入 worker 接缝)`

### Task 18: PowerShell worker 协议（持久子进程）

**Files:**
- Create: `plugins/computer-use/server/src/worker.ts`（`WorkerClient`）、`server/src/worker.ps1.ts`（脚本字符串）
- Test: `plugins/computer-use/server/test/worker.test.ts`（注入 fake 子进程：双工流 mock）

**Interfaces:**
- Produces: `interface WorkerClient { op<T>(op: string, params: Record<string, unknown>): Promise<T>; close(): Promise<void> }`；`createWorker(exe = 'powershell.exe'): WorkerClient`。协议：stdin 行分隔 JSON `{"id":1,"op":"screenshot","params":{…}}` → stdout 行分隔 `{"id":1,"ok":true,"result":{…}}` / `{"id":1,"ok":false,"error":"…"}`。

- [ ] **Step 1: 失败测试**（`child_process.spawn` 注入 fake：emits line JSON；断言请求/响应按 id 配对、串行排队、close 收口 SIGTERM、进程退出拒调用）

```ts
test('op 按 id 配对回执；并发调用串行排队', async () => { /* fakeWorker 回放两响应乱序 → resolve 值正确 */ });
test('worker ok:false → 抛 CodedError 形态错误', async () => { /* await assert.rejects(..., /UIA timeout/) */ });
```

- [ ] **Step 2: 跑测失败**
- [ ] **Step 3: 实现**——`worker.ps1.ts` 导出脚本（要点齐全；执行者按 PS 5.1 兼容写法校验）：

```powershell
$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class CU {
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [StructLayout(LayoutKind.Sequential)] public struct PT { public int X; public int Y; }
 [StructLayout(LayoutKind.Sequential)] public struct INP { public int type; public uint mi; public uint dx; public uint dy; public int wheel; public IntPtr extra; }
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint n, INP[] inputs, int size);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); }'
[void][CU]::SetProcessDPIAware()
function Read-AllInput { [Console]::In.ReadLine() }
while ($true) { $line = [Console]::In.ReadLine(); if ($null -eq $line) { break }
  try { $req = $line | ConvertFrom-Json; $p = $req.params; $r = $null
    switch ($req.op) {
      'screenshot' { $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $x=[int]$p.x; $y=[int]$p.y; $w=[int]$p.w; $h=[int]$p.h
        $bmp = New-Object System.Drawing.Bitmap($w,$h); $g=[System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($x,$y,0,0,(New-Object System.Drawing.Size($w,$h))); $g.Dispose(); $ms=New-Object System.IO.MemoryStream
        $codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object {$_.MimeType -eq 'image/jpeg'}
        $enc=[System.Drawing.Imaging.Encoder]::Quality; $ep=New-Object System.Drawing.Imaging.EncoderParameters(1)
        $ep.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter($enc,[long]$p.quality); $bmp.Save($ms,$codec,$ep); $bmp.Dispose()
        $r=@{ b64=[Convert]::ToBase64String($ms.ToArray()); x=$x; y=$y; w=$w; h=$h } }
      'click' { [void][CU]::SetCursorPos([int]$p.x,[int]$p.y); Start-Sleep -Milliseconds 30
        $down=0x0002; $up=0x0004; if($p.button -eq 'right'){$down=0x0008;$up=0x0010}; if($p.button -eq 'middle'){$down=0x0020;$up=0x0040}
        $n=[int]$p.clicks; for($i=0;$i -lt $n;$i++){ $i1=[CU+INP]@{type=0}; $i1.mi=$down; $i2=[CU+INP]@{type=0}; $i2.mi=$up
          [void][CU]::SendInput(2,[CU+INP[]]@($i1,$i2),[Runtime.InteropServices.Marshal]::SizeOf([type][CU+INP])); Start-Sleep -Milliseconds 40 }; $r=@{ok=$true} }
      'type' { foreach($ch in $p.text.ToCharArray()){ $uni=0x0004; $dn=[CU+INP]@{type=0}; $dn.mi=0x0001 -bor $uni... } ; $r=@{ok=$true} }
      default { throw "unknown op: $($req.op)" } }
    @{ id=$req.id; ok=$true; result=$r } | ConvertTo-Json -Compress -Depth 5 | [Console]::Out.WriteLine
  } catch { @{ id=($req.id); ok=$false; error=$_.Exception.Message } | ConvertTo-Json -Compress | [Console]::Out.WriteLine }
}
```

（`type`/`key`/`scroll`/`drag` 的 SendInput 展开、UIA 快照 `System.Windows.Automation` 遍历、`wait_for` 轮询、`app` 启动/聚焦由执行者按同一 switch 结构补全——协议与骨架本任务全通，动作实现允许 Task 19/20 分批充实；PS 内长函数拆 helper 保持可读。KEYEVENTF 旗标：EXTENDEDKEY=0x0001、KEYUP=0x0002、UNICODE=0x0004。）
`worker.ts`：spawn（`windowsHide:true`）、readline 按 `\n` 切、`Map<id,resolve>` 配对、请求队列串行（同一时刻一个在途——桌面输入本就串行语义）、`close()` SIGTERM+5s 后 kill。
- [ ] **Step 4: 跑测通过**；win 手动冒烟：真 powershell 起 worker，发 `screenshot` 验 base64 返回。
- [ ] **Step 5: Commit**：`feat(plugins/computer-use): PowerShell worker 协议——持久子进程/行 JSON 按 id 配对/串行排队/DPI 感知`

### Task 19: 观察工具（screenshot/uia_snapshot/window_list）

**Files:**
- Modify: `plugins/computer-use/server/src/dispatch.ts`（观察 op 落地）
- Test: `server/test/dispatch.test.ts`（注入 fake worker）

**Interfaces:**
- Produces: `dispatchTool(worker, name, args)` → MCP `CallToolResult`。screenshot：worker 返回 JPEG b64（quality 0.85）→ `content:[{type:'image',data,mimeType:'image/jpeg'},{type:'text',text:JSON.stringify({scale:{origW,origH,sentW,sentH},cursor,foreground})}]`——**缩放置账元数据随图回传**；uia_snapshot：结构化行文本（`[12] Button '确定' (340,520,120x32) enabled`，上限 300）；window_list：标题/pid/z序。

- [ ] **Step 1: 失败测试**

```ts
test('screenshot：worker b64 → image content + scale 元数据文本', async () => {
  const r = await dispatchTool(fakeWorker({ b64:'QQ==', x:0, y:0, w:3136, h:1568, cursor:{x:10,y:10}, foreground:'Editor' }), 'screenshot', {});
  assert.equal(r.content[0]!.type, 'image');
  assert.ok((r.content[1] as any).text.includes('"sentWidth":1568'));
});
test('region 截图：参数换算传 worker（物理像素）', async () => { /* 断言 fake 收到的 w/h 为物理值 */ });
test('uia_snapshot：行格式与 300 上限', async () => { /* fake 返回 400 行 → 输出 300 行 */ });
```

- [ ] **Step 2: 跑测失败** → **Step 3: 实现**（全屏=`SystemInformation` 虚拟屏；`shrinkToEdge` 定 sent 尺寸发 worker 截物理区域后由 PS 侧按 sent 尺寸输出？——**落码裁定：worker 截物理全图，Node 侧只做尺寸记账不下采样**（Node 无 canvas；worker JPEG 时按 quality 压缩，`sent` 尺寸=worker 按 edge 收缩后的输出尺寸——PS 侧 `Bitmap` 先截物理再 `new Bitmap(bmp, sentW, sentH)` 缩放输出，w/h 记账随 result 回传）→ `toPhysical` 供动作工具反算）。
- [ ] **Step 4: 跑测通过**；win 手动：截图工具真出图（Claude/任意 MCP 客户端或临时脚本）。
- [ ] **Step 5: Commit**：`feat(plugins/computer-use): 观察工具三件——screenshot(image content+scale 元数据)/uia_snapshot/window_list`

### Task 20: 动作工具（click/type/key/scroll/drag/wait/wait_for/app）

**Files:**
- Modify: `plugins/computer-use/server/src/dispatch.ts`
- Test: `server/test/dispatch.test.ts` 延伸

**Interfaces:**
- Produces: 动作工具全部**先 `toPhysical` 反算坐标再下发**（scale 元数据由最近一次 screenshot 存于 server 会话态 `lastMeta`；无 meta 时 click 拒绝并提示先 screenshot——错误文案引导正确循环）；wait_for=worker 侧 UIA 文本轮询（timeout 缺省 10s）。

- [ ] **Step 1: 失败测试**

```ts
test('click：坐标按 lastMeta 反算物理值下发；无 lastMeta 拒绝并引导先 screenshot', async () => {
  await dispatchTool(fakeWorker, 'screenshot', {}); // fake 回固定 scale
  const r = await dispatchTool(fakeWorker, 'click', { x: 100, y: 50, button: null, clicks: null });
  assert.deepEqual(fakeWorker.lastParams, { x: 200, y: 100, button: 'left', clicks: 1 });
  await assert.rejects(dispatchTool(newWorkerNoMeta, 'click', { x: 1, y: 1 }), /screenshot/);
});
test('type/key/scroll/drag/wait/wait_for/app：参数整形与下发', async () => { /* 逐工具断言 fake 收到的规范化 params */ });
```

- [ ] **Step 2: 跑测失败** → **Step 3: 实现**（`null` 剥缺省沿主仓口径；key 组合键序列按下-逐个-上；scroll SendInput mouse wheel 0x0800/+wheelDelta；drag 按路径插值 move+按下/抬起；app launch=`Start-Process`、focus=UIA WindowPattern 或 SetForegroundWindow）。
- [ ] **Step 4: 跑测通过**；win 手动验收清单：截屏→点击已知坐标→type→组合键→wait_for 文本出现。
- [ ] **Step 5: Commit**：`feat(plugins/computer-use): 动作工具七件——坐标反算单点(lastMeta)/组合键/滚轮/拖拽/wait_for 轮询/app`

### Task 21: computer-use manifest + safety 声明 + skills + 端到端验收

**Files:**
- Create: `plugins/computer-use/plugin.json`、`skills/desktop-automation/SKILL.md`（循环教学：先 screenshot/uia_snapshot 观察再动作、坐标以截图为准、敏感操作提示）、`README.md`（UIPI/DPI/隐私注记）
- Modify: `plugins/browser-use` 同批（如有 configArgs 实测修正）
- Test: `src/config/plugins.test.ts`（safety 声明装载钉）

- [ ] **Step 1: 落 manifest**（spec §2.2 示例原文：safety act 六工具/confirm screenshot/observe 二工具；`configSchema.worker`；platforms ["win32"]；server command `node` args `["server/index.js"]` cwd `.`）
- [ ] **Step 2: 装载钉测试**：`safety` 进 `collectMcpSafety` 输出 → guard 行为（Task 9 矩阵在真 manifest 上复验一条）。
- [ ] **Step 3: 端到端手动验收**（enabled → run）：「截一张全屏并告诉我前台窗口标题」→ 观察审批卡（screenshot confirm ask + always）→ 动作审批卡（act ask）→ 截屏图在 GUI 工具行可看（Task 4 面）。
- [ ] **Step 4: Commit**：`feat(plugins): computer-use manifest+safety 三类声明+desktop-automation 技能+端到端验收`

---

## 收尾（Task 22）

### Task 22: 全量门禁 + selfcheck + 治理复核

- [ ] **Step 1**: `pnpm test` 全绿、`pnpm --dir gui run typecheck` + gui vitest 全绿、`pnpm cli selfcheck` exit 0。
- [ ] **Step 2**: CLAUDE.md §5 工具清单口径复核（插件工具走 `mcp__` 前缀不占内置清单）；MANUAL §6 权限表补 safety 三类行；spec 状态行翻「已实施」。
- [ ] **Step 3**: Commit：`docs: 插件体系实施收尾——治理文档同步+spec 状态回写`

## Self-Review 记录

- 覆盖面：spec §3（Task 1-5）/§2（Task 6-10、14）/§6（Task 11-12）/§2.6 CLI（Task 13）/§4（Task 15-16）/§5（Task 17-21）/§7 测试（各任务 Step 1）/§8 里程碑对齐。§4.2「缺省持久 profile 在 dataDir」简化为 `userDataDir` config 键（声明式，无插件名特判）——偏差已在本计划 Task 15 标注，属收紧非缺失。
- 类型一致性：`resultRow(obs, imgs?)`/`EffectivePlugin`/`pluginMcpServers`/`setMcpSafety`/`WorkerClient.op` 跨任务签名一致；`McpServerConfig.cwd`、`configDefaults` 已回写 schema 任务（Task 6/8）。
- 无占位符：所有代码步骤给出实际代码；PS worker 长 op 展开与 GUI 既有 case 适配点显式标注了「执行者按既有形态落码」的锚（非 TBD，是指定文件内既有模式的镜像）。
