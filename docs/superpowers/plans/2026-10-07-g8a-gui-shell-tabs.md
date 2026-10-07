# G8a GUI 壳重构(三栏布局+标签框架+项目分组左栏)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 依 G8 spec §1/§2/§3/§7(G8a 行)建立 gui 设计系统并把 App 重组为三栏:左项目分组菜单 / 中 Chat 主区 / 右多标签侧栏(标签框架+文件/任务两类标签),Home 全页退役。

**Architecture:** 标签框架=纯状态层(tab-state.ts:开/关/切/判重/单例/每会话独立)+注册表(registry.tsx:类型→组件,新类型零壳层改动)+标签条 UI(TabStrip)。App 壳从「home|chat 两页+会话内三 tab」改为恒三栏;板/委派投影与播种窗机制(G5/G6)原样平移,消费方从 Board 页换成任务标签。

**Tech Stack:** React 18 + vitest(jsdom, globals)+ @testing-library/react + lucide-react(新增,唯一新依赖)+ 单 CSS 设计令牌(app.css)。

**Spec:** `docs/superpowers/specs/2026-10-07-gui-redesign-design.md`(v8)——本计划实现其 §7 G8a 行;§2 终端/目录(G8b)、Diff/Agents/Web(G8d)、设置(G8c)不在本批。

## Global Constraints

- **主仓零改动**:G8a 不动 src/ 任何文件(设置/pty/tree 全是后续批次)。
- gui 唯一新依赖 `lucide-react`;**node-pty/@xterm 不许出现**(G8b)。
- **既有测试钩子 class 原名保留**(workspace-toggle/ws-slug/ws-count/session-list/attach/token-gate/topbar/conn-dot/session-tabs 退役项除外);新增结构一律 `sx-` 前缀。
- 设计令牌暗色优先,单文件 `gui/src/app.css`,main.tsx import;禁 CSS-in-JS/其他 css 文件。
- 右栏默认宽 420px,拖拽 clamp 200..720;新会话默认开「任务」单例标签;标签态每会话独立。
- 快捷键:Alt+W 关当前标签、Ctrl+Alt+←/→ 切标签;Esc 不动(既有语义)。
- 逐任务只跑聚焦测试(`pnpm --dir gui exec vitest run <file>`);全量 gui 套件+e2e 只在 T8 收口跑(**watchdog 协议:阻塞式子代理禁跑全量**)。
- 提交规约 `feat(gui): …`;`git add` 仅列本任务文件(**并行会话在库,绝不 add 未点名文件**)。
- 节点版本/脚本:gui 命令一律 `pnpm --dir gui …`(Windows Git Bash)。

## File Structure

```
gui/src/
  app.css                      [T1 新增] 设计令牌+sx- 基础样式
  main.tsx                     [T1 改] import app.css
  tabs/
    tab-state.ts               [T2 新增] 标签纯状态(纯函数,零 React)
    tab-state.test.ts          [T2 新增]
    registry.tsx               [T3 新增] TabTypeEntry 注册表(G8a 注册 file/tasks 两类)
    TabStrip.tsx               [T3 新增] 标签条 UI(含 + 菜单/折叠钮/快捷键)
    tab-strip.test.tsx         [T3 新增]
  sidebar/
    ProjectMenu.tsx            [T4 新增] 左栏项目分组菜单(Home 职能内化)
    project-menu.test.tsx      [T4 新增]
  pages/
    Home.tsx                   [T5 删除]
    Files.tsx                  [T6 不改] FileTab 直接复用
    Board.tsx                  [T6 不改] TasksTab 直接复用
  App.tsx                      [T5/T6 改] 三栏壳+标签态+投影平移
  chat-reducer.ts              [T7 改] applyChatEvent 入口过滤 payload.subagent
  chat-reducer.test.ts         [T7 改] 增用例
  e2e.test.ts                  [T5 改 导航适配]/[T6 改 增场景]
```

---

### Task 1: 设计系统基建(app.css 令牌 + lucide-react)

**Files:**
- Create: `gui/src/app.css`
- Modify: `gui/src/main.tsx`
- Modify: `gui/package.json`(经 pnpm add,不手编)

**Interfaces:**
- Produces: CSS 自定义属性令牌面(`--bg-0/--bg-1/--bg-2/--fg-0/--fg-1/--border/--accent/--ok/--warn/--err`)与 `sx-` 基础类——T3/T4/T5 的样式类全部依赖此文件,类名以此处定义为准。

- [ ] **Step 1: 安装 lucide-react**

```bash
pnpm --dir gui add lucide-react
```

预期:gui/package.json dependencies 增 `lucide-react`。

- [ ] **Step 2: 写 app.css(完整内容)**

```css
/* G8a 设计令牌(spec §3):暗色优先;亮色后置=换值即可 */
:root {
  --bg-0: #0d1117;      /* app 背景 */
  --bg-1: #161b22;      /* 面板 */
  --bg-2: #21262d;      /* 浮层/hover */
  --fg-0: #e6edf3;      /* 主文本 */
  --fg-1: #8b949e;      /* 次文本 */
  --border: #30363d;
  --accent: #4493f8;
  --ok: #3fb950;
  --warn: #d29922;
  --err: #f85149;
  --radius: 6px;
  --font-ui: ui-sans-serif, system-ui, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  background: var(--bg-0);
  color: var(--fg-0);
  font: 13px/1.5 var(--font-ui);
}
button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
button:disabled { opacity: 0.5; pointer-events: none; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* 三栏壳(T5 消费) */
.sx-shell { display: flex; height: 100%; }
.sx-menu { width: 240px; flex: none; background: var(--bg-1); border-right: 1px solid var(--border); display: flex; flex-direction: column; }
.sx-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.sx-sidebar { flex: none; background: var(--bg-1); border-left: 1px solid var(--border); display: flex; flex-direction: column; position: relative; }
.sx-resizer { position: absolute; left: -4px; top: 0; width: 8px; height: 100%; cursor: col-resize; z-index: 5; }
.sx-resizer:hover, .sx-resizer.active { background: color-mix(in srgb, var(--accent) 30%, transparent); }

/* 标签条(T3 消费) */
.sx-tabstrip { display: flex; align-items: center; gap: 2px; padding: 4px 6px; border-bottom: 1px solid var(--border); overflow-x: auto; flex: none; }
.sx-tab { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: var(--radius); color: var(--fg-1); white-space: nowrap; }
.sx-tab:hover { background: var(--bg-2); }
.sx-tab.active { background: var(--bg-2); color: var(--fg-0); }
.sx-tab-close { display: inline-flex; padding: 0 2px; border-radius: 3px; color: var(--fg-1); }
.sx-tab-close:hover { color: var(--fg-0); background: var(--border); }
.sx-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: var(--radius); color: var(--fg-1); flex: none; }
.sx-iconbtn:hover { background: var(--bg-2); color: var(--fg-0); }
.sx-menu-pop { position: absolute; top: 36px; right: 8px; z-index: 10; background: var(--bg-2); border: 1px solid var(--border); border-radius: var(--radius); padding: 4px; min-width: 140px; }
.sx-menu-pop .sx-menuitem { display: flex; width: 100%; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 4px; text-align: left; }
.sx-menu-pop .sx-menuitem:hover { background: var(--bg-1); }
.sx-tabbody { flex: 1; min-height: 0; overflow: auto; }

/* 左栏项目分组(T4 消费) */
.sx-menu-head { padding: 10px 12px; font-weight: 600; border-bottom: 1px solid var(--border); }
.sx-groups { flex: 1; overflow-y: auto; padding: 6px 0; }
.sx-group-head { display: flex; width: 100%; align-items: center; gap: 6px; padding: 5px 12px; color: var(--fg-0); }
.sx-group-head:hover { background: var(--bg-2); }
.sx-group-head .sx-count { color: var(--fg-1); font-size: 12px; margin-left: auto; }
.sx-session-row { display: flex; width: 100%; align-items: center; gap: 6px; padding: 4px 12px 4px 28px; color: var(--fg-1); text-align: left; }
.sx-session-row:hover { background: var(--bg-2); color: var(--fg-0); }
.sx-session-row.active { background: var(--bg-2); color: var(--fg-0); box-shadow: inset 2px 0 0 var(--accent); }
.sx-menu-foot { border-top: 1px solid var(--border); padding: 8px 12px; display: flex; align-items: center; gap: 8px; color: var(--fg-1); }
.sx-welcome { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--fg-1); }
```

- [ ] **Step 3: main.tsx 引入**

在 `gui/src/main.tsx` 顶部(react 导入之后)加:

```ts
import './app.css';
```

- [ ] **Step 4: 验证既有面零破坏**

```bash
pnpm --dir gui exec vitest run src/chat-reducer.test.ts && pnpm --dir gui run typecheck
```

预期:全过(CSS/依赖零行为面)。

- [ ] **Step 5: Commit**

```bash
git add gui/src/app.css gui/src/main.tsx gui/package.json gui/pnpm-lock.yaml
git commit -m "feat(gui): G8a-T1 设计系统基建——app.css 暗色令牌+sx- 基础类+lucide-react 依赖"
```

---

### Task 2: 标签框架纯状态(tab-state.ts)

**Files:**
- Create: `gui/src/tabs/tab-state.ts`
- Test: `gui/src/tabs/tab-state.test.ts`

**Interfaces:**
- Produces(T3/T5/T6 消费,签名逐字):

```ts
export type TabTypeId = 'file' | 'diff' | 'tasks' | 'agents' | 'directory' | 'terminal' | 'web';
export interface TabParams { readonly path?: string; readonly callId?: string; readonly url?: string; readonly cols?: number; readonly rows?: number; }
export interface TabInstance { readonly uid: string; readonly type: TabTypeId; readonly params: TabParams; }
export interface TabSessionState {
  readonly tabs: readonly TabInstance[];
  readonly activeUid: string | null;
  readonly collapsed: boolean;
  readonly width: number;   // 200..720
}
export type TabStates = Readonly<Record<string, TabSessionState>>;  // key = sessionId
export const DEFAULT_TAB_WIDTH = 420;
export function emptyTabSession(): TabSessionState;                       // tabs=[] activeUid=null collapsed=false width=420
export function ensureSession(states: TabStates, sessionId: string, registry: SingletonProbe): TabStates;
// 无该会话→建并开 tasks 单例('tasks' 注册 singleton=true 时);已有→原样返回
export interface SingletonProbe { isSingleton(type: TabTypeId): boolean; resolveKey(type: TabTypeId, params: TabParams): string; }
export function openTab(states: TabStates, sessionId: string, type: TabTypeId, params: TabParams, probe: SingletonProbe): TabStates;
// 判重:probe.resolveKey 相同的既有标签→仅置 active;单例类型→既有同类型标签置 active;否则追加+置 active
export function closeTab(states: TabStates, sessionId: string, uid: string): TabStates;
// 关活动标签→右侧邻标承继活动位(无右取左);关非活动→活动不变;清空→activeUid=null
export function setActive(states: TabStates, sessionId: string, uid: string): TabStates;
export function cycleTab(states: TabStates, sessionId: string, dir: 1 | -1): TabStates;
// 活动位 ±1 环回;tabs 空/单例不动
export function setCollapsed(states: TabStates, sessionId: string, collapsed: boolean): TabStates;
export function setWidth(states: TabStates, sessionId: string, width: number): TabStates;  // clamp 200..720
```

uid 规约:`type + ':' + resolveKey(type, params)`(无参标签 key 为 `''`→uid=`'tasks:'`)。

- [ ] **Step 1: 写失败测试(gui/src/tabs/tab-state.test.ts 全量)**

```ts
import { describe, it, expect } from 'vitest';
import {
  emptyTabSession, ensureSession, openTab, closeTab, setActive, cycleTab,
  setCollapsed, setWidth, DEFAULT_TAB_WIDTH, type TabStates, type SingletonProbe,
} from './tab-state';

/** 判重/单例探针(T3 registry 提供真实现;此处 stub 同口径:file 按 path,tasks 单例) */
const probe: SingletonProbe = {
  isSingleton: (t) => t === 'tasks',
  resolveKey: (t, p) => (t === 'file' ? p.path ?? '' : t === 'web' ? p.url ?? '' : ''),
};

describe('tab-state 纯逻辑(spec §1 标签模型)', () => {
  it('ensureSession:新会话缺省开 tasks 单例;已有会话原样', () => {
    const s = ensureSession({}, 's1', probe);
    expect(s.s1.tabs.map((t) => t.type)).toEqual(['tasks']);
    expect(s.s1.activeUid).toBe('tasks:');
    const again = ensureSession(s, 's1', probe);
    expect(again).toBe(s); // 引用相等=未动
  });

  it('openTab:file 按 path 判重——重开同 path 聚焦不重复', () => {
    let s = ensureSession({}, 's1', probe);
    s = openTab(s, 's1', 'file', { path: 'a.ts' }, probe);
    s = openTab(s, 's1', 'file', { path: 'b.ts' }, probe);
    s = openTab(s, 's1', 'file', { path: 'a.ts' }, probe);
    expect(s.s1.tabs).toHaveLength(3); // tasks + a + b
    expect(s.s1.activeUid).toBe('file:a.ts');
  });

  it('openTab:单例类型(tasks)重开=聚焦既有', () => {
    let s = ensureSession({}, 's1', probe);
    s = openTab(s, 's1', 'file', { path: 'a.ts' }, probe);
    s = openTab(s, 's1', 'tasks', {}, probe);
    expect(s.s1.tabs).toHaveLength(2);
    expect(s.s1.activeUid).toBe('tasks:');
  });

  it('openTab:无参非单例(terminal)每次新开一页', () => {
    let s = ensureSession({}, 's1', probe);
    s = openTab(s, 's1', 'terminal', {}, { ...probe, isSingleton: () => false, resolveKey: (t, p) => (t === 'file' ? p.path ?? '' : t === 'terminal' ? `n${s.s1.tabs.length}` : '') });
    expect(s.s1.tabs.filter((t) => t.type === 'terminal')).toHaveLength(1); // 探针给序号判重,此处验证追加行为
  });

  it('closeTab:关活动标签→右侧邻标承继;清空→null', () => {
    let s = ensureSession({}, 's1', probe);
    s = openTab(s, 's1', 'file', { path: 'a.ts' }, probe);
    s = openTab(s, 's1', 'file', { path: 'b.ts' }, probe);
    s = closeTab(s, 's1', 'file:b.ts');       // 关活动(b)→右无→左承继(a)
    expect(s.s1.activeUid).toBe('file:a.ts');
    s = closeTab(s, 's1', 'file:a.ts');
    s = closeTab(s, 's1', 'tasks:');
    expect(s.s1.tabs).toHaveLength(0);
    expect(s.s1.activeUid).toBeNull();
  });

  it('cycleTab:±1 环回;单标签不动', () => {
    let s = ensureSession({}, 's1', probe);
    s = openTab(s, 's1', 'file', { path: 'a.ts' }, probe);
    expect(cycleTab(s, 's1', 1).s1.activeUid).toBe('tasks:');   // file→tasks(环回)
    expect(cycleTab(s, 's1', -1).s1.activeUid).toBe('file:a.ts');
  });

  it('标签态每会话独立', () => {
    let s = ensureSession({}, 's1', probe);
    s = openTab(s, 's1', 'file', { path: 'a.ts' }, probe);
    const s2 = ensureSession(s, 's2', probe);
    expect(s2.s2.tabs.map((t) => t.type)).toEqual(['tasks']);
    expect(s2.s1.tabs).toHaveLength(2); // s1 未被 s2 操作扰动
  });

  it('setWidth clamp 200..720;setCollapsed 切换', () => {
    const s = ensureSession({}, 's1', probe);
    expect(setWidth(s, 's1', 99).s1.width).toBe(200);
    expect(setWidth(s, 's1', 999).s1.width).toBe(720);
    expect(setWidth(s, 's1', 500).s1.width).toBe(500);
    expect(setCollapsed(s, 's1', true).s1.collapsed).toBe(true);
  });

  it('emptyTabSession 缺省面', () => {
    const e = emptyTabSession();
    expect(e.tabs).toHaveLength(0);
    expect(e.activeUid).toBeNull();
    expect(e.collapsed).toBe(false);
    expect(e.width).toBe(DEFAULT_TAB_WIDTH);
  });
});
```

- [ ] **Step 2: 跑测确认失败**

```bash
pnpm --dir gui exec vitest run src/tabs/tab-state.test.ts
```

预期:FAIL(模块不存在)。

- [ ] **Step 3: 实现 tab-state.ts**

按 Interfaces 签名逐条实现(纯函数,不可变更新;`openTab` 判重逻辑:先查 `probe.resolveKey` 相同 uid 的既有标签→setActive;单例→查同 type;追加新 `TabInstance{uid: type+':'+key}` 置 active。`closeTab` 活动承继:删后取 `min(关闭索引, tabs.length-1)` 处标签)。全部导出与 Interfaces 一致。

- [ ] **Step 4: 跑测通过**

```bash
pnpm --dir gui exec vitest run src/tabs/tab-state.test.ts
```

预期:PASS(9 例)。

- [ ] **Step 5: Commit**

```bash
git add gui/src/tabs/tab-state.ts gui/src/tabs/tab-state.test.ts
git commit -m "feat(gui): G8a-T2 标签框架纯状态——开/关/切/判重/单例/每会话独立/clamp 宽"
```

---

### Task 3: 标签注册表 + 标签条 UI + 右栏壳

**Files:**
- Create: `gui/src/tabs/registry.tsx`
- Create: `gui/src/tabs/TabStrip.tsx`
- Test: `gui/src/tabs/tab-strip.test.tsx`

**Interfaces:**
- Consumes: T2 `tab-state.ts` 全部导出。
- Produces(T5/T6 消费,签名逐字):

```ts
// registry.tsx
export interface TabServices {   // App 投影面(G8a:任务标签消费;后续批次按需扩)
  readonly board: import('../projection').TaskBoardState;
  readonly delegations: readonly import('../projection').Delegation[];
  readonly team: readonly { name: string; busy: boolean }[];
  readonly onReview: (taskId: string, approved: boolean) => void;
}
export interface TabRenderProps {
  readonly conn: import('../connection').Connection;
  readonly sessionId: string;
  readonly params: import('./tab-state').TabParams;
  readonly services: TabServices;
}
export interface TabTypeEntry {
  readonly id: import('./tab-state').TabTypeId;
  readonly group: 'content' | 'session' | 'tools';
  readonly title: (params: import('./tab-state').TabParams) => string;
  readonly resolveKey: (params: import('./tab-state').TabParams) => string;
  readonly singleton: boolean;
  readonly render: (props: TabRenderProps) => JSX.Element;
}
export const TAB_REGISTRY: readonly TabTypeEntry[];  // G8a:file/tasks 两类
export function tabEntry(id: import('./tab-state').TabTypeId): TabTypeEntry;
export function registryProbe(): import('./tab-state').SingletonProbe;  // TAB_REGISTRY 装配的探针

// TabStrip.tsx
export interface TabStripProps {
  readonly tabs: readonly import('./tab-state').TabInstance[];
  readonly activeUid: string | null;
  readonly collapsed: boolean;
  readonly disabled?: boolean;          // 无会话:整条灰
  readonly onSelect: (uid: string) => void;
  readonly onClose: (uid: string) => void;
  readonly onNew: () => void;           // + 菜单内选中类型由菜单直调 onOpenType
  readonly onOpenType: (type: import('./tab-state').TabTypeId) => void;
  readonly onToggleCollapse: () => void;
  readonly onCycle: (dir: 1 | -1) => void;
  readonly onCloseActive: () => void;
}
export function TabStrip(props: TabStripProps): JSX.Element;
```

- [ ] **Step 1: 写失败测试(gui/src/tabs/tab-strip.test.tsx 全量)**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabStrip } from './TabStrip';
import { TAB_REGISTRY, registryProbe } from './registry';
import { ensureSession, openTab } from './tab-state';

const base = {
  onSelect: vi.fn(), onClose: vi.fn(), onNew: vi.fn(), onOpenType: vi.fn(),
  onToggleCollapse: vi.fn(), onCycle: vi.fn(), onCloseActive: vi.fn(),
};

describe('TAB_REGISTRY(G8a 两类)', () => {
  it('注册 file/tasks;file 按 path 判重多实例,tasks 单例', () => {
    expect(TAB_REGISTRY.map((e) => e.id)).toEqual(['file', 'tasks']);
    const file = TAB_REGISTRY[0]!;
    expect(file.singleton).toBe(false);
    expect(file.resolveKey({ path: 'a.ts' })).toBe('a.ts');
    expect(file.title({ path: 'a.ts' })).toBe('a.ts');
    const tasks = TAB_REGISTRY[1]!;
    expect(tasks.singleton).toBe(true);
    expect(tasks.title({})).toBe('任务');
  });
  it('registryProbe 与注册表同口径', () => {
    const p = registryProbe();
    expect(p.isSingleton('tasks')).toBe(true);
    expect(p.isSingleton('file')).toBe(false);
    expect(p.resolveKey('file', { path: 'x' })).toBe('x');
  });
});

describe('TabStrip(spec §1 标签条)', () => {
  it('渲染标签 pill(图标+标题+×),活动高亮;点选/点×回调', () => {
    let s = ensureSession({}, 's1', registryProbe());
    s = openTab(s, 's1', 'file', { path: 'a.ts' }, registryProbe());
    const handlers = { ...base, onSelect: vi.fn(), onClose: vi.fn() };
    render(<TabStrip {...handlers} tabs={s.s1.tabs} activeUid={s.s1.activeUid} collapsed={false} />);
    expect(screen.getByTitle('a.ts').className).toContain('sx-tab');
    fireEvent.click(screen.getByTitle('a.ts'));
    expect(handlers.onSelect).toHaveBeenCalledWith('file:a.ts');
    fireEvent.click(screen.getByRole('button', { name: 'close tab a.ts' }));
    expect(handlers.onClose).toHaveBeenCalledWith('file:a.ts');
  });

  it('「+」弹类型菜单,选中回调 onOpenType;「≫」折叠回调', () => {
    const handlers = { ...base };
    render(<TabStrip {...handlers} tabs={[]} activeUid={null} collapsed={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'new tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /文件/ }));
    expect(handlers.onOpenType).toHaveBeenCalledWith('file');
    fireEvent.click(screen.getByRole('button', { name: 'collapse sidebar' }));
    expect(handlers.onToggleCollapse).toHaveBeenCalled();
  });

  it('快捷键:Alt+W 关活动,Ctrl+Alt+→/← 切换', () => {
    const handlers = { ...base };
    render(<TabStrip {...handlers} tabs={[]} activeUid={null} collapsed={false} />);
    fireEvent.keyDown(window, { key: 'w', altKey: true });
    expect(handlers.onCloseActive).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'ArrowRight', ctrlKey: true, altKey: true });
    expect(handlers.onCycle).toHaveBeenCalledWith(1);
    fireEvent.keyDown(window, { key: 'ArrowLeft', ctrlKey: true, altKey: true });
    expect(handlers.onCycle).toHaveBeenCalledWith(-1);
  });

  it('disabled 态:+ 与标签不可点', () => {
    const handlers = { ...base };
    render(<TabStrip {...handlers} tabs={[]} activeUid={null} collapsed={false} disabled />);
    expect((screen.getByRole('button', { name: 'new tab' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测确认失败**

```bash
pnpm --dir gui exec vitest run src/tabs/tab-strip.test.tsx
```

预期:FAIL(两模块不存在)。

- [ ] **Step 3: 实现 registry.tsx**

`TAB_REGISTRY` 两类(G8a):
- `file`:group 'content',title=params.path ?? '文件',resolveKey=params.path ?? '',singleton false,render=`(p) => <Files conn={p.conn} sessionId={p.sessionId} initialPath={p.params.path} />`(import `../pages/Files`;**T6 才接线 App,此处 render 先写好**——Files 组件既有,直接可用)。
- `tasks`:group 'session',title=()=>'任务',resolveKey=()=>'',singleton true,render=`(p) => <Board board={p.services.board} delegations={p.services.delegations} team={p.services.team} onReview={p.services.onReview} onBack={() => {}} />`(import `../pages/Board`)。
- `tabEntry(id)`:查表,缺则 throw(`unknown tab type: ${id}`)。
- `registryProbe()`:由 TAB_REGISTRY 装配 `{isSingleton, resolveKey}`。

- [ ] **Step 4: 实现 TabStrip.tsx**

要点:
- 标签 pill:`<button class="sx-tab{active?' active':''}" title={title}>` 内 `lucide` 类型图标(16px)+标题+`<span role/aria-label="close tab X" class="sx-tab-close"><X size={12}/></span>`(× 的 click `e.stopPropagation()` 后调 onClose)。
- 尾部 `<button aria-label="new tab" class="sx-iconbtn"><Plus size={16}/></button>` → 开 `sx-menu-pop` 菜单(按 group 分节,menuitem=role menuitem,icon+中文名:文件/任务;G8b-d 增类只改注册表);菜单外点关闭。
- 右端 `<button aria-label="collapse sidebar" class="sx-iconbtn">{collapsed?<PanelLeft size={16}/>:<PanelRight size={16}/>}</button>`。
- collapsed 态:只渲染折叠钮一行(无标签)。
- disabled:全部按钮 disabled+整条 `opacity:.5`。
- 快捷键:组件挂载 `useEffect` 绑 window keydown(alt+w→onCloseActive;ctrl+alt+ArrowRight/Left→onCycle(1/-1)),卸载解绑;disabled 时不响应。

- [ ] **Step 5: 跑测通过**

```bash
pnpm --dir gui exec vitest run src/tabs/tab-strip.test.tsx
```

预期:PASS(6 例)。

- [ ] **Step 6: Commit**

```bash
git add gui/src/tabs/registry.tsx gui/src/tabs/TabStrip.tsx gui/src/tabs/tab-strip.test.tsx
git commit -m "feat(gui): G8a-T3 标签注册表(file/tasks)+标签条 UI(+菜单/折叠/快捷键)"
```

---

### Task 4: 左栏项目分组菜单(ProjectMenu)

**Files:**
- Create: `gui/src/sidebar/ProjectMenu.tsx`
- Test: `gui/src/sidebar/project-menu.test.tsx`

**Interfaces:**
- Consumes: `Home.tsx` 的 `HomeConn` 接口(移入本文件重导出为 `ProjectMenuConn`;`connection.ts` 不改)、`DirPicker`(既有)、T1 `sx-menu/sx-groups` 样式。
- Produces(T5 消费,签名逐字):

```ts
export type ProjectMenuConn = Home.tsx 的 HomeConn(原样五方法:workspaces/sessionsOf/dirpicker/newSession/attach);
export interface ProjectMenuProps {
  readonly conn: ProjectMenuConn;
  readonly connState: string;                 // 'connecting'|'online'|'offline'|'reconnecting'(显示态)
  readonly activeSessionId: string;           // '' = 无会话
  readonly activeRoot: string;                // '' = 无(其所属组自动展开)
  readonly onOpenSession: (sessionId: string, root: string) => void;
}
export function ProjectMenu(props: ProjectMenuProps): JSX.Element;
```

**测试钩子类名(保留 Home 既有,零 e2e 迁移)**:`workspace-list`/`workspace-item`/`workspace-toggle`/`ws-slug`/`ws-count`/`session-list`/`session-row`/`session-summary`/`session-meta`/`attach`/`no-root`;新增 sx- 前缀(组行 `sx-group-head`、会话行 `sx-session-row`、底栏 `sx-menu-foot`)。

- [ ] **Step 1: 写失败测试(gui/src/sidebar/project-menu.test.tsx 全量)**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectMenu } from './ProjectMenu';
import type { ProjectMenuConn } from './ProjectMenu';

/** stub conn:一项目组(p1, root 在场)+ 一历史组(p2, root 缺场) */
function makeConn(): ProjectMenuConn & { roots: string[][] } {
  const sessionsOfRoots: string[][] = [];
  const conn: ProjectMenuConn & { roots: string[][] } = {
    roots: sessionsOfRoots,
    workspaces: async () => [
      { slug: 'p1', root: 'D:/w/p1', sessionCount: 1, mtime: Date.now() },
      { slug: 'p2', root: undefined, sessionCount: 0, mtime: Date.now() },
    ] as never,
    sessionsOf: async (root: string) => {
      sessionsOfRoots.push(root);
      return [{ id: 'j1', firstUser: 'demo goal', updatedAt: Date.now() }] as never;
    },
    dirpicker: async () => ({ path: 'D:/w', parent: 'D:', dirs: ['p1'] }),
    newSession: async (root: string, mode?: 'manual') => ({ sessionId: `new-${root}${mode ? '-m' : ''}` }),
    attach: async () => undefined,
  };
  return conn;
}

const open = vi.fn();

function renderMenu(conn: ProjectMenuConn, props?: Partial<Parameters<typeof ProjectMenu>[0]>) {
  return render(
    <ProjectMenu conn={conn} connState="online" activeSessionId="" activeRoot="" onOpenSession={open} {...props} />,
  );
}

describe('ProjectMenu(spec §1 左栏项目分组)', () => {
  it('工作区=组;组头点击展开惰拉 sessions(root 缺场组禁用)', async () => {
    const conn = makeConn();
    renderMenu(conn);
    expect(screen.getByText('p1')).toBeTruthy();
    expect(screen.getByText('p2')).toBeTruthy();
    expect((screen.getByTitle(/root 未登记/) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('p1'));
    expect(await screen.findByText('demo goal')).toBeTruthy();
    expect(conn.roots).toEqual(['D:/w/p1']); // 惰拉:仅展开才请求
  });

  it('Attach 两步(newSession+attach)→ onOpenSession(sessionId, root)', async () => {
    const conn = makeConn();
    renderMenu(conn);
    fireEvent.click(screen.getByText('p1'));
    fireEvent.click(await screen.findByText('Attach'));
    await waitFor(() => expect(open).toHaveBeenCalledWith('new-D:/w/p1', 'D:/w/p1'));
  });

  it('组内「+」新建:mode 弹层选 auto→newSession(root)→onOpenSession', async () => {
    const conn = makeConn();
    renderMenu(conn);
    fireEvent.click(screen.getByText('p1'));
    fireEvent.click(await screen.findByRole('button', { name: 'new session in p1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /auto/i }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('new-D:/w/p1', 'D:/w/p1'));
  });

  it('组内「+」新建:manual→newSession(root,"manual")', async () => {
    const conn = makeConn();
    renderMenu(conn);
    fireEvent.click(screen.getByText('p1'));
    fireEvent.click(await screen.findByRole('button', { name: 'new session in p1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /manual/i }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('new-D:/w/p1-m', 'D:/w/p1'));
  });

  it('activeRoot 组自动展开;当前会话行 active 态', async () => {
    const conn = makeConn();
    renderMenu(conn, { activeSessionId: 'new-D:/w/p1', activeRoot: 'D:/w/p1' });
    const row = await screen.findByText('demo goal');
    expect(row.closest('.sx-session-row')!.className).toContain('active');
  });

  it('「+ 添加工作区」开 DirPicker 模态(测试钩子 class 复用)', async () => {
    const conn = makeConn();
    renderMenu(conn);
    fireEvent.click(screen.getByText('+ 添加工作区'));
    expect(screen.getByTitle('dirpicker') ?? screen.getByText(/目录/)).toBeTruthy();
  });

  it('底栏显示连接态点', () => {
    renderMenu(makeConn());
    expect(screen.getByLabelText('connection: online')).toBeTruthy();
  });
});
```

注:DirPicker 模态断言以其既有渲染面为准(实现时若钩子不同,以 `DirPicker` 现有可定位元素替换该断言行,断言语义不变=模态在场)。

- [ ] **Step 2: 跑测确认失败**

```bash
pnpm --dir gui exec vitest run src/sidebar/project-menu.test.tsx
```

预期:FAIL(模块不存在)。

- [ ] **Step 3: 实现 ProjectMenu.tsx**

结构(逻辑自 Home.tsx 平移,视图改组列表):
- `sx-menu` 容器:`sx-menu-head`(标题「项目」+刷新 iconbtn)→ `sx-groups`(组列表)→ `sx-menu-foot`(连接点 `<span class="conn-dot conn-{connState}" aria-label="connection: {connState}"/>` + 文本)。
- 组行 `workspace-item`:组头 `workspace-toggle sx-group-head`(chevron+`Folder` icon+`ws-slug`+`ws-count`,root 缺场 disabled+title 提示,既有 `no-root` class);展开惰拉 `sessionsOf(root)`(Home 的 slug 守卫照搬:openSlugRef 过期应答丢弃)。
- 会话行 `session-row sx-session-row`(activeSessionId 匹配行加 `active`):`session-summary`(firstUser)+`session-meta`(id+相对时间)+`attach` 钮(两步:newSession(root)→attach→onOpenSession(sessionId, root))。
- 组内「+」钮(`aria-label="new session in {slug}"`,iconbtn `Plus`):弹 mode 菜单(auto=「自动审批」/manual=「手动审批」,role menuitem)→ `newSession(root, mode ?? undefined)` → `onOpenSession(sessionId, root)`;失败组内行内报错。
- 底部固定行「+ 添加工作区」:开 DirPicker 模态(Home 的 modal-overlay 结构原样)→ createSession(root, manual) → onOpenSession。
- 相对时间:简易 `relTime(ts)`(`刚刚/Nm ago/Nh ago/Nd ago`,<1m=刚刚)。

- [ ] **Step 4: 跑测通过**

```bash
pnpm --dir gui exec vitest run src/sidebar/project-menu.test.tsx
```

预期:PASS(7 例)。

- [ ] **Step 5: Commit**

```bash
git add gui/src/sidebar/ProjectMenu.tsx gui/src/sidebar/project-menu.test.tsx
git commit -m "feat(gui): G8a-T4 左栏项目分组菜单——组惰拉/组内新建 root 预填+mode 弹层/添加工作区/连接态底栏"
```

---

### Task 5: App 三栏壳重组(Home 退役 + e2e 导航适配)

**Files:**
- Modify: `gui/src/App.tsx`(重写壳;G5/G6 板投影/播种窗/挂起面机制原样保留)
- Delete: `gui/src/pages/Home.tsx`
- Modify: `gui/src/e2e.test.ts`(仅导航定位与断言适配;场景语义不变)

**Interfaces:**
- Consumes: T2 tab-state 全导出;T3 `TabStrip/TAB_REGISTRY/registryProbe/tabEntry/TabServices`;T4 `ProjectMenu`。
- Produces(T6/T8 消费):App 内部态 `tabStates: TabStates`;helper `openTabInSession(type, params?)`(setTabStates 包 openTab);Chat 挂载 `onOpenFile={(path) => openTabInSession('file', { path })}`;Chat `onBack` 保留(返回=取消选择会话→欢迎空态)。

**App 壳目标结构(TSJSX 骨架,实现按此落):**

```tsx
// page 态:'welcome' | 'chat'(Home 全页退役;无会话=welcome)
<div className="sx-shell">
  <ProjectMenu conn={connInstance} connState={connState}
    activeSessionId={openSessionId} activeRoot={openRoot}
    onOpenSession={openSession} />
  <main className="sx-main">
    {page === 'chat' ? (
      <Chat key={openSessionId} conn={connInstance} sessionId={openSessionId} connState={connState}
        onBack={backHome} sinkRef={chatSinkRef} onSeeded={seedFromSnapshot}
        onOpenFile={(p) => openTabInSession('file', { path: p })} />
    ) : (
      <div className="sx-welcome" aria-label="welcome">
        <p>选择左侧会话,或在工作区分组内新建。</p>
      </div>
    )}
  </main>
  {/* 右栏:会话在场才可用;collapsed 只渲染折叠钮;拖宽 8px 边条(clamp 200..720) */}
  <aside className="sx-sidebar" style={{ width: session ? (tabState.collapsed ? 32 : tabState.width) : 32 }}>
    <TabStrip tabs={tabState.tabs} activeUid={tabState.activeUid} collapsed={tabState.collapsed}
      disabled={page !== 'chat'}
      onSelect={(uid) => setTab((s) => setActive(s, openSessionId, uid))}
      onClose={(uid) => setTab((s) => closeTab(s, openSessionId, uid))}
      onNew={() => {}} onOpenType={(t) => openTabInSession(t)}
      onToggleCollapse={() => setTab((s) => setCollapsed(s, openSessionId, !s[openSessionId]?.collapsed))}
      onCycle={(d) => setTab((s) => cycleTab(s, openSessionId, d))}
      onCloseActive={() => tabState.activeUid && setTab((s) => closeTab(s, openSessionId, s[openSessionId]!.activeUid!))} />
    {page === 'chat' && !tabState.collapsed && tabEntry(activeTab.type).render({ conn, sessionId, params, services })}
  </aside>
</div>
```

改动清单(App.tsx):
1. 删 `sessionTab/filesPath` 态与 `session-tabs` nav/`pane-chat` 结构;Chat 恒挂中栏(仍 key={sessionId})。
2. 增 `openRoot` 态;`openSession(sessionId, root)` 记录;`backHome` 清空;`openFile` 改 `openTabInSession('file', {path})`。
3. 增 `tabStates` 态 + openSession 时 `ensureSession`(默认任务页);Board/Files 不再独立挂载。
4. topbar 退役(brand/连接点移入左栏底栏;TokenGate 不动)。
5. 板投影/boardPendingRef/onApproval/onAsk/onResetSession/seedFromSnapshot 全部原样(零语义变更)。
6. `services` 对象:`{ board, delegations, team, onReview: reviewTask }`(经 useMemo)。
7. 拖宽边条:`sx-resizer` div,mousedown→window mousemove 计算 `clamp(200, startWidth + startX - e.clientX, 720)`(右栏在右侧,向左拖=变宽),mouseup 解绑;setWidth 落态。

**e2e 导航适配(Home→ProjectMenu 选择器映射表,逐处替换):**

| e2e 现用定位 | 新定位 |
|---|---|
| `screen.getByTitle(/root 未登记/)` 等 workspace-toggle 展开钮 | 同名保留(workspace-toggle/ws-slug 原样) |
| Home 右栏详情断言(`workspace-detail`/`detail-root`/`detail-grid`) | **删除该类断言**(详情面板退役;若断言语义=「工作区在场」改断言组头文本) |
| 「New session」按钮(首页头部) → DirPicker 流 | 改:组内「+」钮(`new session in {slug}`)→mode 菜单 auto→DirPicker 仅「+ 添加工作区」流用 |
| `aria-label="home"` / `home-loading` | `aria-label="welcome"` / 欢迎态文本 |
| Chat 返回(回 Home)断言 | 改断言 welcome 在场 |

适配纪律:**只改定位/断言行,不改场景结构与事件序**;每改一处跑该场景确认。

- [ ] **Step 1: 依「改动清单」重写 App.tsx 壳 + 删 Home.tsx**

- [ ] **Step 2: 跑既有聚焦面(chat-reducer/connection/projection 不受影响)+ typecheck**

```bash
pnpm --dir gui run typecheck
```

预期:0 error(Home.tsx 删除后无残留引用)。

- [ ] **Step 3: e2e 逐场景适配并全跑(本任务允许:e2e 是本批改面)**

```bash
pnpm --dir gui run test:e2e
```

预期:11 场景全过(导航已按映射表适配;「New session 经 DirPicker」场景改走「+ 添加工作区」路径)。

- [ ] **Step 4: Commit**

```bash
git add gui/src/App.tsx gui/src/pages/Home.tsx gui/src/e2e.test.ts
git commit -m "feat(gui): G8a-T5 App 三栏壳——Home 退役内化左栏,Chat 恒中栏,右标签栏接线,e2e 导航适配"
```

---

### Task 6: 文件/任务标签接线(默认任务页 + write 条目开文件)

**Files:**
- Modify: `gui/src/App.tsx`(active tab 渲染接线——若 T5 已含渲染行则本任务收敛为验证+e2e)
- Modify: `gui/src/e2e.test.ts`(增 2 场景)

**Interfaces:**
- Consumes: T3 `tabEntry().render`(file=Files 复用/tasks=Board 复用);T2 ensureSession 默认任务页。
- Produces: 运行时行为——新会话右栏默认「任务」页;Chat write 工具条目 path 钮 → 开/聚焦文件标签;重复开同 path 聚焦不重复。

- [ ] **Step 1: e2e 增场景(e2e.test.ts 追加,复用 startDaemon/CARDS 装配模式)**

场景 A「默认任务页+文件标签判重」:建会话→进 chat→断言右栏标签条有活动「任务」标签(`sx-tab active`,title=任务)→Chat write 条目点 path 钮(既有 e2e 的 write 场景卡片复用)→断言文件标签在场且活动(title=path)→Chat 再点同 path→断言标签条文件标签数=1(判重聚焦)。
场景 B「任务标签内看板消费」:跑既有 taskboard 全链卡片(CARDS 同款)→切到任务标签→断言任务行文本在场(既有 Board 断言面)。

- [ ] **Step 2: 跑 e2e 确认新场景失败(或接线缺如)**

```bash
pnpm --dir gui run test:e2e
```

预期:新增 2 场景 FAIL(默认页/判重未落),既有 11 场景 PASS。

- [ ] **Step 3: 补齐 App 接线缺口(ensureSession 默认页/activeTab 渲染/openTabInSession)**

(若 T5 已完整接线则本步为空——以测试红绿为准,不许为绿而改断言。)

- [ ] **Step 4: e2e 全绿(13 场景)**

```bash
pnpm --dir gui run test:e2e
```

- [ ] **Step 5: Commit**

```bash
git add gui/src/App.tsx gui/src/e2e.test.ts
git commit -m "feat(gui): G8a-T6 文件/任务标签接线——默认任务页+write 条目开文件判重聚焦+e2e 两场景"
```

---

### Task 7: chat reducer 入口过滤 payload.subagent

**Files:**
- Modify: `gui/src/chat-reducer.ts`(`applyChatEvent` 入口)
- Modify: `gui/src/chat-reducer.test.ts`(增用例)

**Interfaces:**
- Produces: 行为变更——`e.payload?.subagent` 为 string 的事件(token/tool-call/tool-result/… 全类型)不再进 Chat 主流条目(交 G8d Agents 标签消费);delegation-* 摘要行不受影响(其 payload 无 subagent 标签)。

- [ ] **Step 1: 写失败测试(chat-reducer.test.ts 追加)**

```ts
it('payload.subagent 事件不入主流(G8a:Agents 标签另聚;delegation 摘要行保留)', () => {
  let s = emptyChatState(); // 既有测试同款初始态构造(文件内已有 helper/字面量,随文件现状)
  s = applyChatEvent(s, { type: 'tool-call', ts: 1, payload: { tool: 'read', subagent: 'ap-1' } } as never);
  s = applyChatEvent(s, { type: 'tool-result', ts: 2, payload: { tool: 'read', ok: true, subagent: 'ap-1' } } as never);
  s = applyChatEvent(s, { type: 'token', ts: 3, text: '子代理流字', payload: { subagent: 'ap-1' } } as never);
  expect(s.entries).toHaveLength(0);
  s = applyChatEvent(s, { type: 'delegation-started', ts: 4, payload: { label: '搜库', delegationId: 'd1' } } as never);
  expect(s.entries).toHaveLength(1); // 委派摘要行保留
});
```

(初始态构造以文件内既有测试写法为准——若已有 `makeState`/字面量 helper 则复用,不新造。)

- [ ] **Step 2: 跑测确认失败**

```bash
pnpm --dir gui exec vitest run src/chat-reducer.test.ts
```

预期:新用例 FAIL(tool-call 建了条目)。

- [ ] **Step 3: 实现——applyChatEvent 函数体 switch 前加一行**

```ts
if (typeof e.payload?.subagent === 'string') return s; // 子代理事件另轨(Agents 标签,G8d):主流零条目
```

(注释同步更新函数头「忽略…」清单。)

- [ ] **Step 4: 跑测通过(既有用量过滤用例不破)**

```bash
pnpm --dir gui exec vitest run src/chat-reducer.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add gui/src/chat-reducer.ts gui/src/chat-reducer.test.ts
git commit -m "fix(gui): G8a-T7 子代理事件入口过滤——payload.subagent 不再混入主流条目"
```

---

### Task 8: 批次收口门禁(全量 gui + 主仓聚焦 + spec 注记)

**Files:**
- Modify: `docs/superpowers/specs/2026-10-07-gui-redesign-design.md`(§7 G8a 行标注交付态;不写交付详情——G8e 收官统一回写)

**Interfaces:** 无代码面;本任务=门禁+文档注记。

- [ ] **Step 1: gui 全量套件(含 typecheck/pretest 主仓 tsc 链)**

```bash
pnpm --dir gui test
```

预期:typecheck+主仓 tsc(pretest 链)通过;vitest 全绿(tab-state 9+tab-strip 6+project-menu 7+既有+e2e 13)。

- [ ] **Step 2: e2e 全量**

```bash
pnpm --dir gui run test:e2e
```

预期:13/13。

- [ ] **Step 3: 主仓聚焦回归(G8a 主仓零改动,跑 daemon/gui 接线相邻面防误伤)**

```bash
pnpm build && node --test dist/serve/daemon.test.js dist/serve/session.test.js
```

预期:全过(基线绿,G8a 未触主仓)。

- [ ] **Step 4: spec §7 G8a 行注记**

`| G8a | … |` 行尾追加「~~已交付~~ 2026-10-07(执行注记,详情 G8e 收官统一回写)」样式与本仓 spec 交付行惯例一致(参照 gui-v1 spec §12 划线行格式)。

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-10-07-gui-redesign-design.md
git commit -m "docs(spec): G8a 交付注记——壳/标签框架/项目分组左栏/文件任务标签落地"
```

---

## Self-Review(写后自查已执行)

1. **Spec 覆盖**:G8a 行=设计系统(T1)+三栏壳(T5)+标签框架(T2/T3)+左栏项目分组(T4)+Chat 迁中栏(T5)+文件/任务入标签(T6)+subagent 过滤(T7)+门禁(T8)——§7 G8a 行逐词有任务;§5 交互清单明确归 G8d 不抢做。
2. **占位扫描**:T5 e2e 映射表给出逐处替换表;T6 Step3 声明「以红绿为准」非空话——接线若 T5 已含则测试直接绿,属合法收敛;T4 DirPicker 断言给出语义不变的适配口。无 TBD/「适当处理」。
3. **类型一致**:tab-state 导出名与 T3 测试/T5 消费逐字对齐(`openTabInSession` 为 App 内 helper 非导出);TabServices.board 类型来自 projection 导入链;ProjectMenuProps.onOpenSession 双参(sessionId, root)与 App openSession 一致。
