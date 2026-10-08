# GUI 产品面重构(C1-C6)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GUI 按 Codex 产品面重构:侧栏双区 IA、思考链+mermaid+双语对话区、命令面板+权限/模型 pills、设置行式重排、全局去冗余;TUI 25 命令全量承载;daemon 新增命令/切换/回退端点。

**Architecture:** C1 先落 daemon 底层(`GET /commands` 单点下发、`command` 直跑通道、model/tier/effort/mode 切换、steer cancel/rewind/fork/memory-rm、snapshot 增段);C2-C6 逐区消费。命令实现**操作共享 runtime 单点**(与 TUI 同源),分支体从 `tui/session.ts handleSlash` 移植(pushMsg → collector),禁复制逻辑。

**Tech Stack:** TS strict(CommonJS 主仓)+ React 18/vitest(gui);新依赖仅 `mermaid`(gui,懒加载)。

**Spec:** `docs/superpowers/specs/2026-10-08-gui-product-surface-g10-design.md`(§6 端点面、§7 映射总表为验收清单)。

## Global Constraints

- 单一 CSS 文件(app.css U-D10);阴影只留浮层(spec §5)。
- 无底层不做 UI;`/terminal-setup` 显式 N/A;`/help` 由命令面板自带。
- 命令清单唯一源:`src/tui/slash-commands.ts` 的 `SLASH_COMMANDS`/`slashCommandDescriptions()`——gui 永不内嵌副本,防漂移钉子用例(Task 1)。
- chrome 双语走 `src/i18n.ts` 的 `t(en,zh)`,语言源 = settings `language` 键。
- 每任务:`pnpm build`(根)零错 + `pnpm test` 全量绿(gui 侧另跑 `cd gui && pnpm test`);一任务一 commit(`feat(gui): G10-Cx-...` / `feat(serve): G10-C1-...`)。
- 不碰用户工作区未提交文件(`src/cli/index.ts` 长期有本地改动,add 时显式列文件)。

---

### Task 1: `GET /commands` 命令清单端点(C1a)

**Files:**
- Modify: `src/serve/daemon.ts`(路由表 + handler)
- Test: `src/serve/commands.test.ts`

**Interfaces:**
- Produces: `GET /commands`(auth)→ `{ commands: string[]; descriptions: Record<string, string> }`;descriptions 为当前语言 `t()` 求值面。
- Consumes: `tui/slash-commands.ts` 的 `SLASH_COMMANDS`、`slashCommandDescriptions()`。

- [ ] **Step 1: 失败测试(含防漂移钉子)**

`src/serve/commands.test.ts`:

```ts
import { describe, it, expect } from 'node:test';
import { SLASH_COMMANDS } from '../tui/slash-commands';
// handler 直接单测(薄端点):抽出 listCommands() 纯函数供路由与测试共用
import { listCommands } from './commands';

describe('GET /commands 命令清单单点', () => {
  it('与 TUI SLASH_COMMANDS 逐字同源(防漂移钉子)', () => {
    const { commands, descriptions } = listCommands();
    expect(commands).toEqual(SLASH_COMMANDS);
    for (const c of commands) {
      expect(descriptions[c.startsWith('/') ? c.slice(1) : c]).toBeTruthy();
    }
  });
  it('排除集不进清单(terminal-setup 为 TUI 专属 → 仍在清单但 GUI 面板置灰,由 GUI_EXCLUDED 约定)', () => {
    const { commands } = listCommands();
    expect(commands).toContain('/terminal-setup'); // 单源完整下发;置灰判定归 gui
  });
});
```

(测试运行器:主仓为 `node --test`,文件放 `src/serve/commands.test.ts`,走 `pnpm test` 全量。)

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test 2>&1 | grep commands`
Expected: FAIL(`./commands` 不存在)

- [ ] **Step 3: 实现**

Create `src/serve/commands.ts`:

```ts
import { SLASH_COMMANDS, slashCommandDescriptions } from '../tui/slash-commands';

/** GET /commands 数据面:清单与本地化描述唯一出口(gui 命令面板数据源)。
 *  单源 = tui/slash-commands.ts;此处零副本,重命名/增删命令自动同步。 */
export function listCommands(): { commands: string[]; descriptions: Record<string, string> } {
  return { commands: [...SLASH_COMMANDS], descriptions: slashCommandDescriptions() };
}
```

`src/serve/daemon.ts`:路由表增 `{ method: 'GET', path: '/commands', auth: true, run: async (_req, res) => this.send(res, 200, listCommands()) }`;文件头 import `listCommands`。

- [ ] **Step 4: 测试通过 + 提交**

Run: `pnpm test`
Expected: 全绿

```bash
git add src/serve/commands.ts src/serve/commands.test.ts src/serve/daemon.ts
git commit -m "feat(serve): G10-C1a GET /commands 命令清单单点下发(TUI 单源零副本+防漂移钉子用例)"
```

---

### Task 2: 运行中切换端点 model/tier/effort/mode + snapshot 增段(C1b)

**Files:**
- Modify: `src/serve/session.ts`、`src/serve/daemon.ts`
- Read(权威单源,移植缝): `src/tui/commands-model.ts`
- Test: `src/serve/session-switch.test.ts`

**Interfaces:**
- Produces: `POST /session/:id/model {model?: string}`、`…/tier {tier}`、`…/effort {effort}`、`…/mode {mode: 'dontAsk'|'manual'|'plan'}`;全部 409(no such session)/400(体畸形)口径同既有端点。
- Produces: snapshot 顶层增 `model?: string`(switcher label/currentId)、`tier?/effort?`、`mode: 'dontAsk'|'manual'|'plan'`。
- 切换语义:**下一轮请求生效**(TUI /model 同语义),非法 id → `{error:'unknown model'}` 400。

- [ ] **Step 1: 失败测试**

`src/serve/session-switch.test.ts`(用 e2e 的 startDaemon 模式:`src/e2e.test.ts` 的 startDaemon 为样板,ScriptedAdapter 换 ModelSwitcher 桩):

```ts
import { ModelSwitcher } from '../model/catalog';
// 桩装配:daemon model = new ModelSwitcher({ default: scripted, choices: [{id:'a/m1',...},{id:'a/m2',...}], ... })
it('POST /session/:id/model 切换内芯且 snapshot 回显', async () => {
  await post(`/session/${sid}/model`, { model: 'a/m1' });
  const snap = await getJson(`/session/${sid}/snapshot`);
  expect(snap.model).toBe('a/m1');
});
it('未知模型 id 400 不动现状', async () => {
  const res = await post(`/session/${sid}/model`, { model: 'nope' });
  expect(res.status).toBe(400);
  expect((await getJson(`/session/${sid}/snapshot`)).model).not.toBe('nope');
});
it('POST …/mode 循环三态回显', async () => {
  for (const mode of ['manual', 'plan', 'dontAsk'] as const) {
    await post(`/session/${sid}/mode`, { mode });
    expect((await getJson(`/session/${sid}/snapshot`)).mode).toBe(mode);
  }
});
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**

`serve/session.ts` 增字段与方法(对齐 TUI `commands-model.ts` 的切换缝——该文件为权威,若其实现为「换 opts.model 引用/调 switchTo」则同形移植):

```ts
/** 会话级运行时切换面(G10):下一轮请求生效(TUI /model 同语义)。
 *  model: adapter 为 ModelSwitcher 时 switchTo,否则 409 not switchable(装配即单模型)。 */
setModel(id: string | undefined): boolean {
  const sw = this.resolveSwitcher();
  if (sw === null) return false;
  return sw.switchTo(id);
}
private resolveSwitcher(): ModelSwitcher | null {
  let a: unknown = this.opts.model;
  while (a instanceof ModelRouter) a = (a as ModelRouter).currentAdapter?.(); // tier 路由透传(接缝以实机为准,见下)
  return a instanceof ModelSwitcher ? a : null;
}
setMode(mode: 'dontAsk' | 'manual' | 'plan'): void { this.mode = mode; } // 实例字段,buildRuntime 每轮读
```

`mode` 消费点:session 提交装配 harness 的现有 `mode` 传参改读 `this.mode`(每轮读 → 下一轮生效)。`tier/effort`:镜像 `commands-model.ts` 对 tier router / effort 的设置函数(该文件内已有 TUI 实现函数则直接 import 复用;若有 UI 耦合则移植纯逻辑部分到 `src/serve/session-switch.ts` 并被 TUI 与 serve 共用——**改 TUI 为调用共享函数**,禁双实现)。

snapshot 组装处增:`model: resolveSwitcher()?.currentId() ?? undefined, tier, effort, mode: this.mode`。

- [ ] **Step 4: 全绿 + 提交**

```bash
git add src/serve/session.ts src/serve/session-switch.test.ts src/serve/daemon.ts src/tui/commands-model.ts
git commit -m "feat(serve): G10-C1b 运行中切换端点(model/tier/effort/mode,下一轮生效)+snapshot 回显段;TUI 切换缝收共享单点"
```

---

### Task 3: `command` 直跑通道(C1c)

**Files:**
- Create: `src/serve/session-commands.ts`
- Modify: `src/serve/session.ts`、`src/serve/daemon.ts`
- Test: `src/serve/session-commands.test.ts`

**Interfaces:**
- Produces: `POST /session/:id/command {line}`;支持集 `COMMAND_SUPPORT`(spec §6):`/init /status /compact /context /tasks /kb-index /memory /memory-add /memory-gc /memory-on /memory-off /add-dir /goal /plan /skill`;不支持 → 400 `{error:'unsupported command'}`;运行中 `/plan /goal /compact` 等 idle-only 命令 → 409(文案同 TUI)。输出全部走既有事件流(notice/system 条),HTTP 仅 `{ok:true}`。
- Consumes: Task 2 的 mode;共享 runtime 单点。

- [ ] **Step 1: 失败测试**

```ts
it('/status 经 command 通道产出 notice 条', async () => {
  await post(`/session/${sid}/command`, { line: '/status' });
  await waitForEvent((e) => e.type === 'notice' && /session|会话/.test(e.text ?? ''));
});
it('不支持命令 400', async () => {
  expect((await post(`/session/${sid}/command`, { line: '/terminal-setup' })).status).toBe(400);
});
it('运行中 idle-only 命令 409', async () => { /* fire 长任务后 */ 
  expect((await post(`/session/${sid}/command`, { line: '/compact' })).status).toBe(409);
});
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**

Create `src/serve/session-commands.ts`:

```ts
/** command 通道(G10 spec §6):TUI handleSlash 分支的 daemon 移植层。
 *  纪律:操作共享 runtime 单点;纯函数(formatContextBreakdown 等)import 复用;
 *  pushMsg → collector.notice();禁复制 TUI 逻辑体。 */
export const COMMAND_SUPPORT = new Set(['/init', '/status', '/compact', '/context', '/tasks', '/kb-index', '/memory', '/memory-add', '/memory-gc', '/memory-on', '/memory-off', '/add-dir', '/goal', '/plan', '/skill']);
const IDLE_ONLY = new Set(['/init', '/compact', '/goal', '/plan', '/memory-gc', '/memory-on', '/memory-off']);

export async function runCommand(s: GuiSession, line: string): Promise<'ok' | 'unsupported' | 'busy'> {
  const cmd = line.split(/\s/)[0] ?? '';
  if (!COMMAND_SUPPORT.has(cmd)) return 'unsupported';
  if (IDLE_ONLY.has(cmd) && s.status !== 'idle') return 'busy';
  const arg = line.slice(cmd.length).trim();
  switch (cmd) {
    case '/status': s.collector.notice(statusLine(s)); return 'ok'; // 摘要行:对齐 TUI /status 文案(t() 双语)
    case '/compact': await s.compactNow(); return 'ok';             // 压缩协调器单点(harness context/compaction)
    case '/context': s.collector.notice(formatContextBreakdown(await s.contextBreakdown())); return 'ok';
    case '/tasks': s.collector.notice(formatTasks(s.taskLedgerRows())); return 'ok';
    case '/plan': await s.startPlanFlow(arg); return 'ok';          // 计划确认卡经既有 ask 通道
    case '/goal': await s.runGoalFlow(arg); return 'ok';
    /* /init /kb-index /memory* /add-dir /skill 同形:移植对应 TUI 分支体(源:tui/session.ts handleSlash 同名分支) */
  }
  return 'unsupported';
}
```

移植规则(逐分支,同形改写,`tui/session.ts:704 handleSlash` 为源):TUI `this.pushMsg('system', X)` → `s.collector.notice(X)`;`this.state.status` → `s.status`;harness 调用经 `s.runtimeImpl.harness`(与 steer 同路)。`/plan /goal` 的 flow 函数若为 TUI 私有则提为共享模块(放 `src/tui/flows.ts`,TUI/serve 双消费)。

daemon `handleCommand`:401/404 同既有;`runCommand` 返回映射 `ok→200 {ok:true}`、`unsupported→400`、`busy→409`。

- [ ] **Step 4: 全绿 + 提交**

```bash
git add src/serve/session-commands.ts src/serve/session-commands.test.ts src/serve/session.ts src/serve/daemon.ts src/tui/flows.ts
git commit -m "feat(serve): G10-C1c command 直跑通道(15 命令支持集,idle-only 409,输出走事件流;分支体自 TUI handleSlash 同形移植共享 runtime)"
```

---

### Task 4: steer cancel/queued、rewind、fork、memory/rm(C1d)

**Files:**
- Modify: `src/serve/session.ts`、`src/serve/daemon.ts`、`src/harness`(steering 撤回缝)
- Test: `src/serve/session-queue.test.ts`

**Interfaces:**
- `POST /session/:id/steer/cancel {seq}` → 撤回排队插话;snapshot 增 `queued: Array<{ seq: number; text: string }>`。
- `POST /session/:id/rewind {seq}` → 链/journal 截断到该轮(TUI `/rewind` `branchFlow(this,'rewind')` 语义对齐;成功后 snapshot 重建)。
- `POST /session/:id/fork` → 以当前链分叉新会话,回 `{sessionId}`。
- `POST /memory/rm {ids: string[]}` → 删除记忆条目。

- [ ] **Step 1: 失败测试**:`steer` 两条 → snapshot `queued.length===2` → cancel 一条 → `queued.length===1` 且文本正确;rewind 后 entries 条目数回落;fork 返回新 id 且原会话不动。
- [ ] **Step 2: 确认失败 → Step 3: 实现**:steering 队列撤回——`harness.steering` 为纯内存 FIFO,增 `remove(pred: (text, seq) => boolean)`(保持原实现语义,补撤回单点);queued seq 用递增计数(内存面即可,不入链)。rewind/fork 移植 `tui/session.ts branchFlow` 的链截断/复制纯逻辑(与 Task 3 同纪律;journal 文件操作对齐 SessionJournal 既有 API)。memory/rm 走 memory store 单点。
- [ ] **Step 4: 全绿 + 提交**

```bash
git add src/serve/session.ts src/serve/daemon.ts src/harness src/serve/session-queue.test.ts
git commit -m "feat(serve): G10-C1d steer 撤回+queued 段/rewind/fork/memory-rm 端点(链截断与分支对齐 TUI branchFlow 语义)"
```

---

### Task 5: 侧栏双区 IA(C2)

**Files:**
- Modify: `gui/src/sidebar/ProjectMenu.tsx`、`gui/src/connection.ts`(recentSessions 聚合)、`gui/src/app.css`
- Test: `gui/src/sidebar/project-menu.test.tsx` 增列

**Interfaces:**
- Produces: 连接面 `recentSessions(): Promise<SessionRow & { root: string }[]>`(daemon `GET /sessions/recent`,Task 4 顺手加:聚 projectsRoot 全工作区 mtime 降序 20 条——单点聚合,gui 零拼装)。
- Produces: DOM 契约——`nav.sx-menu > .sx-brand / button.sx-new-chat / .sx-side-head(Projects|Recents) / 行 button.sx-session-row[data-attach] / button.sx-menu-settings`。

- [ ] **Step 1: 失败测试**:welcome 断言「新对话」行在场、Recents 头在场且列出跨工作区最近会话(桩 daemon 两工作区各 1 条)、Settings 底行在场。
- [ ] **Step 2: 实现**:ProjectMenu 重排为 spec §1 结构(品牌行纯文本;新对话=最近激活 root 直建,无则弹既有 mode 菜单;Projects=现有组行;Recents=扁平行,点击 attach 两步);**去组头文件夹图标**(图标收敛)。daemon `handleSessionsRecent`:遍历 projectsRoot 注册表各 dataDir `listSessions` 归并取前 20。
- [ ] **Step 3: 全绿+目检+提交** `feat(gui): G10-C2 侧栏双区 IA(品牌/新对话/Projects/Recents 扁平跨区/Settings;daemon /sessions/recent 聚合)`

---

### Task 6: 思考链 + 工具行图标化 + 顶栏精简(C3a/b)

**Files:**
- Modify: `gui/src/chat-reducer.ts`、`gui/src/pages/Chat.tsx`、`gui/src/app.css`
- Test: `gui/src/chat-reducer.test.ts` 增、`gui/src/pages/Chat.test.tsx` 增

**Interfaces:**
- Produces: `ChatEntry.kind` 增 `'thinking'`?——**否**,保五 kind:thinking 聚合为独立数组外字段 `thinking?: { md: string; seconds?: number }` 挂在 ChatState(每 assistant 轮一条,assistant 首条前渲染);渲染 DOM 契约 `div.entry-thinking > button[title=思考过程]`(收起态文案「思考 Ns」/流入中「思考中…」)。
- 顶栏 DOM 契约:`header.chat-topbar > .chat-title(+.sx-run-spin 运行中) + title tooltip(tokens/steps)+ button.chat-more(⋯菜单:Delete/复制会话链接)`。

- [ ] **Step 1: 失败测试**:`applyChatEvent(reasoning)` 累积 `chat.thinking.md`;done 后 `thinking.seconds` 落定(首 reasoning→done 时差);Chat 渲染 thinking 行收起态;顶栏无「N tokens」字面文本(titles 里含)。
- [ ] **Step 2: 实现**:reducer `case 'reasoning'`(现有 default 忽略处)开/续 thinking 段(model-start 重置);Chat.tsx 线程渲染在每轮 assistant 条前插 `<ThinkingEntry>`(memo);工具行渲染改 `toolIconOf(verb)`(lucide 映射:read→FileText,write→PenLine,exec→Terminal,grep→Search,glob→FolderSearch,其余→Wrench)+动词短语,去 `●/⎿` 字面;顶栏按契约重写。
- [ ] **Step 3: 全绿+提交** `feat(gui): G10-C3 思考链折叠行(reasoning 聚合)+工具行图标化+顶栏精简(tooltip 化 tokens/steps,⋯菜单收 Delete)`

---

### Task 7: mermaid + 双语接线(C3c)

**Files:**
- Modify: `gui/package.json`(dep `mermaid`)、`gui/src/pages/Chat.tsx`(代码块分发)、Create `gui/src/i18n.ts`、`gui/src/Mermaid.tsx`
- 登记:根 `package.json` 说明 + `CLAUDE.md` §5 依赖台账 + §13 选型表(mermaid:会话流 mermaid 图渲染,收敛于 gui 渲染层)

**Interfaces:**
- Produces: `<Mermaid chart={code} />`:懒 `import('mermaid')`,`mermaid.initialize({ startOnLoad:false, theme: data-theme==='dark'?'dark':'default' })`,渲染失败/超时(3s)回落 `<pre>` 原文;ReactMarkdown `components.code` 对 `language-mermaid` 分流。
- Produces: `gui/src/i18n.ts` re-export 主仓 `t`(gui vitest 可跨仓 import `../../src/i18n`?主仓为 CJS——gui `import { t } from '../../src/i18n'` 经 vite 兼容;若类型冲突则以 `const { t } = await import(...)` 装配。语言源:`App` 连接后 `conn.settings()` 读 `language` 键调 `setLanguage(v)`;SettingsForm 保存 language 成功回调同步 setLanguage)。
- [ ] 步骤:依赖引入(`pnpm --dir gui add mermaid`)+ 登记三处;Chat.tsx 代码块分发 + Mermaid 组件(含失败回落测试:mock mermaid reject → 断言 pre 在场);chrome 文案改 `t()` 首批(Chat 顶栏/composer/空态/侧栏头);`setLanguage` 接线测试。
- [ ] 全绿+提交 `feat(gui): G10-C3c mermaid 懒加载渲染(失败回落原文)+chrome 双语接 settings.language`

---

### Task 8: composer 命令面板 + pills + 排队 chips + rewind/fork 钮(C4)

**Files:**
- Create: `gui/src/CommandPalette.tsx`、`gui/src/ComposerPills.tsx`
- Modify: `gui/src/pages/Chat.tsx`、`gui/src/connection.ts`、`gui/src/app.css`
- Test: `gui/src/CommandPalette.test.tsx`、`gui/src/ComposerPills.test.tsx`

**Interfaces:**
- `CommandPalette({ open, commands, onRun })`:输入 `/` 前缀触发;过滤=前缀优先+包含次之;↑↓/Tab/Enter;置灰=daemon 支持集外(command 端点 400 集 + N/A)。数据源 `conn.commands()`(Task 1 端点)。
- `ComposerPills`:权限 pill 三态(切换调 `conn.setSessionMode(sessionId, mode)`,plan 态提交时 line 前缀 `/plan `经 command 通道;快照 mode 回显);模型 pill(清单 `snapshot.model`+providers——`conn.modelChoices()` 复用 ProvidersPane 数据源;二级 tier/effort 菜单调对应端点);轻 toast 复用 `sx-toast`。
- 排队 chips:`snapshot.queued` 渲染于 composer 上方(`.steer-queue`),撤回钮调 `conn.cancelSteer(sessionId, seq)`。
- 用户气泡 hover 增「回到此轮」(title=「编辑并回到此轮 (rewind)」):确认框→`conn.rewind(sessionId, seq)`→重播种;会话行 hover 增「分叉」(fork 后打开新会话)。
- [ ] 步骤:connection 增 5 方法(commands/setSessionMode/setModel/setTier/setEffort/cancelSteer/rewind/fork——按 Task 2-4 端点);面板组件+测试(过滤/键盘/置灰);pills+测试(三态循环/模型切换调用断言);chips+rewind/fork 接线;全绿+提交 `feat(gui): G10-C4 composer 命令面板+权限/模型 pills+排队 chips+rewind/fork`

---

### Task 9: 设置页行式重排(C5)

**Files:**
- Modify: `gui/src/settings/SettingsForm.tsx`、`SettingsShell.tsx`、各 Pane、`gui/src/app.css`
- Test: `gui/src/settings/settings-rows.test.tsx` 增

**Interfaces:**
- Produces: 行渲染器 `SettingRow({ title, desc, control })`;键描述双语表 `KEY_DESCRIPTIONS: Record<string, {en,zh}>`(高频键逐条:language/autoMemory/learnedSkills/kbBackend/sandbox/isolation/readFence/contextWindow/maxTokens/maxSteps…);枚举下拉集 `ENUM_OPTIONS: Record<string, Array<{v,l}>>`(language=en|zh-CN|…、autoMemory/learnedSkills=on|off、kbBackend=sqlite-vec|local-json、sandbox、isolation、readFence 同 TUI 选项)。
- 布局:`.sx-settings-body { max-width: 720px; margin: 0 auto; }`;nav 分组(Personal/Coding/Integrations + Permissions/高级);行 `.sx-setting-row2`(标题+desc 左,控件右);枚举键渲染 `<select>`,其余右对齐定宽输入;**行间 hairline、行组去卡片阴影**。
- 复杂面板(Providers/MCP/Agents/技能/权限/raw):同宽列,卡列表去阴影改行 hairline 分隔。
- [ ] 步骤:渲染器+描述/枚举表(带测试:language 键渲染 select 且选项含 zh;autoMemory 渲染 on/off);SettingsForm 分发行渲染;nav 分组;四个复杂面板重排;全绿+目检+提交 `feat(gui): G10-C5 设置页 Codex 同构(行式控件化/枚举下拉/居中窄列/分组 nav/去卡阴影)`

---

### Task 10: 全局去冗余 + 右栏新面板 + 终验(C6)

**Files:**
- Modify: `gui/src/app.css`、`gui/src/tabs/*`(ContextTab/TasksTab/MemoryTab 新增)、`gui/src/tabs/registry.tsx`、Chat/Board 残余
- Test: 各面板数据面单测

**Interfaces:**
- 右栏新标签:「上下文」(command 通道 `/context` 结构化输出渲染为分段条;首版渲染 notice 文本亦可,结构化二批)、「后台任务」(snapshot.tasks)、「记忆」(snapshot.memoryOverview + memory/rm 多选)。
- 去冗余清单(spec §5 逐条):静态卡 `box-shadow` 全删(保留 composer/菜单/审批卡/模态/toast);无交互图标删除;常显提示文字删除改原生 title;快捷键入 title。
- [ ] 步骤:三面板+registry 注册;去冗余 sweep(grep `box-shadow` 白名单外清零);`pnpm build`+全量测试;hermetic daemon(种子加 reasoning/queued/tasks/memory 数据)浏览器五区对拍+visual-judge 终验;提交 `feat(gui): G10-C6 全局去冗余+右栏上下文/任务/记忆面板+终验对拍`

---

## Self-Review 记录

- **Spec 覆盖**:§1→Task 5;§2→Task 6/7;§3→Task 8(pills/面板/chips/rewind/fork);§4→Task 9;§5→Task 10;§6 端点→Task 1-4;§7 映射→Tasks 8-10(command 支持集)+5(侧栏);§10 风险→Task 7(mermaid 回落)、Task 1(防漂移钉子)。
- **占位符**:Task 2 tier/effort 与 Task 3 分支移植以「权威单源文件 + 移植纪律」表达(实机接缝以 `commands-model.ts`/`handleSlash` 为准,计划给出形状与判定),非 TBD。
- **类型一致**:`setSessionMode/setModel/cancelSteer/rewind/fork/commands` 在 Task 2-4(端点)与 Task 8(消费)同名;`queued/mode/model` snapshot 段 Task 2/4 产出、Task 8 消费一致。
