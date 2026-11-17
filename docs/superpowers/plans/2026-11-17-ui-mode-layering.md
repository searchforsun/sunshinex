# UI 模式分层（开发者模式开关）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一个「开发者模式」布尔开关，把 GUI 里面向开发者的入口按「只做减法」原则收起，让 C 端默认界面回到 Codex 式简洁，同时不改任何业务逻辑、数据流与视觉体系。

**Architecture:** 新增 `gui/src/developer-mode.ts` 偏好模块，完全复刻既有 `concise-mode.ts` 形态（localStorage + `html[data-developer-mode]` + `ui-pref-sync` 双写 + `useSyncExternalStore`），消费方一律 `useDeveloperMode()`。所有可见性改动都是渲染层条件：设置导航分组、设置行、右栏「+」菜单、空态快捷入口、顶栏计数按钮组、composer「+」面板分区。

**Tech Stack:** React 18 + TypeScript + Vite + Vitest（jsdom）+ @testing-library/react；包管理器 pnpm；工作目录 `gui/`。

**Spec:** `docs/superpowers/specs/2026-11-17-ui-mode-layering-design.md`（执行时与计划同读；spec 的「只做减法 / 不做加法 / 视觉不动」是硬约束）

## Global Constraints

- **只做减法**：不新增入口、不新增提示、不新增示例内容、不新增徽标、不新增动效（spec §10）。
- **不改视觉**：不动圆角/阴影/字体/token；不新增 CSS 规则。新增控件一律复用既有 class（`sx-menuitem`/`sx-plus-row`/`sx-setting-row` 等）。
- **不新增设置键**：开发者模式是 GUI 本地偏好（localStorage + `/app/gui-state` 公共档），不走 daemon `putSettings`，不改 `SEMANTIC_KEYS`。
- **单一消费面**：所有组件只通过 `useDeveloperMode()` 读，不各自读 localStorage/设置。
- **默认关**：`readDeveloperMode()` 缺省 `false`。
- **术语不改**（2026-11-17 用户裁定）：「审查」「思考强度/effort」保持现状，不做任何文案改写；卡片/菜单/顶栏标签沿用现有 `t()` 字符串。
- 测试命令：`cd gui && pnpm vitest run <file>`；类型检查 `cd gui && pnpm run typecheck`。

---

### Task 1: 开发者模式偏好模块与双写接线

**Files:**
- Create: `gui/src/developer-mode.ts`
- Modify: `gui/src/ui-pref-sync.ts:13-55`（LOCAL_KEYS / UiPrefAppliers / APPLY_REMOTE 三处）
- Modify: `gui/src/use-appearance-sync.ts:65-78`（initUiPrefSync appliers）
- Test: `gui/src/developer-mode.test.ts`

**Interfaces:**
- Consumes: `notifyUiPref(key, value)` from `./ui-pref-sync`
- Produces:
  - `readDeveloperMode(): boolean`
  - `applyDeveloperMode(on: boolean): void`
  - `useDeveloperMode(): boolean`
  - ui-pref-sync 键名 `developerMode`（本地 key `sunshinex.developer-mode`，值 `'1'`/`'0'`）

- [ ] **Step 1: 写失败测试**

创建 `gui/src/developer-mode.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { applyDeveloperMode, readDeveloperMode } from './developer-mode';

describe('developer-mode 偏好', () => {
  beforeEach(() => {
    localStorage.clear();
    applyDeveloperMode(false);
  });

  it('缺省关闭(未设置即关)', () => {
    localStorage.clear();
    expect(readDeveloperMode()).toBe(false);
  });

  it('开启写 localStorage 与根 data 属性,关闭清除属性', () => {
    applyDeveloperMode(true);
    expect(localStorage.getItem('sunshinex.developer-mode')).toBe('1');
    expect(document.documentElement.dataset.developerMode).toBe('1');
    applyDeveloperMode(false);
    expect(localStorage.getItem('sunshinex.developer-mode')).toBe('0');
    expect(document.documentElement.dataset.developerMode).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd gui && pnpm vitest run src/developer-mode.test.ts`
Expected: FAIL —— `Cannot find module './developer-mode'`

- [ ] **Step 3: 创建模块**

`gui/src/developer-mode.ts`（结构照抄 `concise-mode.ts`）：

```ts
/**
 * 开发者模式(2026-11-17 用户裁定「使用一个开关就可以控制,可以说是开发者模式」):
 * 关=C 端简洁界面(隐藏终端/高级设置/工程详情类入口);开=完整工程能力。
 * 单一布尔贯穿全产品,不设子开关。持久与其余外观偏好同通路(ui-pref-sync 双写:
 * localStorage 即时层 + /app/gui-state 公共档);html[data-developer-mode] 同步落值供样式面。
 */
import { useSyncExternalStore } from 'react';
import { notifyUiPref } from './ui-pref-sync';

const LS_KEY = 'sunshinex.developer-mode';
const DATA_ATTR = 'developerMode';
const PREF_KEY = 'developerMode';

const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === '1';
  } catch {
    return false;
  }
}

export function readDeveloperMode(): boolean {
  return readStored();
}

function apply(on: boolean): void {
  const root = document.documentElement;
  if (on) root.dataset[DATA_ATTR] = '1';
  else delete root.dataset[DATA_ATTR];
  try {
    localStorage.setItem(LS_KEY, on ? '1' : '0');
  } catch {
    /* 隐私模式等持久化失败:仅内存态生效,不阻断 */
  }
  notifyUiPref(PREF_KEY, on ? '1' : '0');
  for (const fn of listeners) fn();
}

export function applyDeveloperMode(on: boolean): void {
  apply(on);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useDeveloperMode(): boolean {
  return useSyncExternalStore(subscribe, readStored, readStored);
}
```

- [ ] **Step 4: 接线 ui-pref-sync 双写（三处同改）**

`gui/src/ui-pref-sync.ts`：

1. `LOCAL_KEYS` 末尾加一行：
```ts
  developerMode: 'sunshinex.developer-mode',
```
2. `UiPrefAppliers` 类型末尾加一个成员（注意该类型是单行对象字面量，追加 `; developerMode: (v: string) => void ` 改写为合法成员）：
```ts
type UiPrefAppliers = { /* …既有成员… */; developerMode: (v: string) => void };
```
3. `APPLY_REMOTE` 末尾加一行：
```ts
  developerMode: (a, v) => a.developerMode(v),
```

- [ ] **Step 5: 接线启动应用器**

`gui/src/use-appearance-sync.ts`：

1. 顶部 import 区加：
```ts
import { applyDeveloperMode } from './developer-mode';
```
2. `initUiPrefSync(connInstance, { ... })` 对象末尾加：
```ts
      developerMode: (v) => applyDeveloperMode(v === '1'),
```

- [ ] **Step 6: 跑测试与类型检查**

Run: `cd gui && pnpm vitest run src/developer-mode.test.ts && pnpm run typecheck`
Expected: 2 passed；typecheck 无错误（`Record<keyof typeof LOCAL_KEYS, …>` 会强制三处齐全）。

- [ ] **Step 7: 提交**

```bash
git add gui/src/developer-mode.ts gui/src/developer-mode.test.ts gui/src/ui-pref-sync.ts gui/src/use-appearance-sync.ts
git commit -m "feat(gui): 开发者模式偏好模块+公共档双写(2026-11-17 单开关裁定)"
```

---

### Task 2: 设置页「开发者模式」开关行

**Files:**
- Modify: `gui/src/settings/settings-rows.tsx`（新增行组件 + 导出）
- Modify: `gui/src/settings/SettingsForm.tsx:50-61`（`SettingsGroupDef` 加 `developerRow`）、`:183-198`（general pane 首组）、`:552-594`（渲染与空组判定）
- Test: `gui/src/settings/__tests__/SettingsForm.developer.test.tsx`

**Interfaces:**
- Consumes: `useDeveloperMode` 不直接用于本行（行内部用 read/apply），`readDeveloperMode`/`applyDeveloperMode` from `../developer-mode`
- Produces: `DeveloperModeRow`（从 `settings-rows.tsx` 导出）；`SettingsGroupDef.developerRow?: boolean`

- [ ] **Step 1: 写失败测试**

创建 `gui/src/settings/__tests__/SettingsForm.developer.test.tsx`：

```tsx
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsForm, SETTINGS_PANES } from '../SettingsForm';
import type { SettingsFormConn } from '../SettingsForm';

const conn: SettingsFormConn = {
  settings: () => Promise.resolve({ keys: [], permissions: { merged: { deny: [], allow: [], additionalDirs: [] }, project: { deny: [], allow: [], additionalDirs: [] }, global: { deny: [], allow: [], additionalDirs: [] } }, providers: { choices: [], apiKeyPresent: {}, warnings: [] } }),
  putSettings: () => Promise.resolve(),
  memoryStats: () => Promise.resolve({ entries: 0, lastWriteAt: null }),
};

describe('通用页开发者模式开关', () => {
  it('首组渲染「开发者模式」行,拨动即写 localStorage', async () => {
    localStorage.clear();
    render(<SettingsForm conn={conn} root="" pane={SETTINGS_PANES[0]!} />);
    expect(await screen.findByText('Developer mode')).toBeDefined();
    const sw = screen.getByLabelText('developer mode');
    fireEvent.click(sw);
    expect(localStorage.getItem('sunshinex.developer-mode')).toBe('1');
    fireEvent.click(sw);
    expect(localStorage.getItem('sunshinex.developer-mode')).toBe('0');
  });
});
```

（测试基准语言钉 en，见 `src/test-setup.ts`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd gui && pnpm vitest run src/settings/__tests__/SettingsForm.developer.test.tsx`
Expected: FAIL —— 找不到 `Developer mode`

- [ ] **Step 3: 添加行组件**

`gui/src/settings/settings-rows.tsx`：

1. 顶部 import 区加：
```ts
import { applyDeveloperMode, readDeveloperMode } from '../developer-mode';
```
2. 在 `UsageStatsRow` 附近追加：

```tsx
/** 开发者模式行(2026-11-17 用户裁定「一个开关控制」):关=C 端简洁界面
 *  (隐藏终端/高级设置/工程详情类入口);开=完整工程能力。持久经 developer-mode.ts */
const DeveloperModeRow = (): JSX.Element => (
  <DarkSurfaceRow
    label={t('Developer mode', '开发者模式')}
    desc={t('Show terminal, advanced settings, and other tools for developers.', '显示终端、高级设置等面向开发者的能力。')}
    aria="developer mode"
    read={readDeveloperMode}
    apply={applyDeveloperMode}
  />
);
```
3. 底部 `export { ... }` 列表加 `DeveloperModeRow,`。

- [ ] **Step 4: 加组标志与首组**

`gui/src/settings/SettingsForm.tsx`：

1. import 行（第 7 行）加 `DeveloperModeRow`：
```ts
import { CodeFontRow, ConciseModeRow, DarkBubblesRow, DarkCodeRow, DeveloperModeRow, FontRow, PaletteRow, ThemeRow, UiFontRow, UiModeRow, UsageStatsRow, ZoomRow } from './settings-rows';
```
2. `SettingsGroupDef` 加字段：
```ts
  readonly developerRow?: boolean;
```
3. `general` pane 的 `groups` 数组首项插入：
```ts
      { title: { en: 'Developer mode', zh: '开发者模式' }, developerRow: true, fields: [] },
```
4. 渲染条件（第 554 行）与组内首行（第 561 行附近）各改一处：
```ts
          if (visible.length === 0 && !(q === '' && (g.themeRow || g.zoomRow || g.paletteRow || g.fontRow || g.developerRow))) return null;
```
```tsx
                {g.developerRow && q === '' && <DeveloperModeRow />}
```

- [ ] **Step 5: 跑测试与类型检查**

Run: `cd gui && pnpm vitest run src/settings/__tests__/SettingsForm.developer.test.tsx && pnpm run typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add gui/src/settings/settings-rows.tsx gui/src/settings/SettingsForm.tsx gui/src/settings/__tests__/SettingsForm.developer.test.tsx
git commit -m "feat(gui): 通用页开发者模式单开关(2026-11-17 裁定)"
```

---

### Task 3: 设置导航分层 + 路径/执行环境独立 pane + SourceBadge 收起

**Files:**
- Modify: `gui/src/settings/SettingsShell.tsx:87-118`（导航分组加 `advanced` 标志并重排）、`:149-152`（回退到通用）、导航渲染处（按 `advanced` 过滤）
- Modify: `gui/src/settings/SettingsForm.tsx:183-198`（移除 Paths / Command execution 两组）、新增 `paths` pane 定义、行渲染 SourceBadge 条件（第 581 行）
- Modify: `gui/src/settings/__tests__/SettingsForm.path.test.tsx:31,44`（改为按 id 找 paths pane）
- Test: `gui/src/settings/__tests__/SettingsShell.advanced.test.tsx`

**Interfaces:**
- Consumes: `useDeveloperMode()` from `../developer-mode`
- Produces: pane id `'paths'`（标题 `Paths & shell / 路径与执行环境`）；`SETTINGS_GROUPS` 组对象新增可选 `advanced?: boolean`

- [ ] **Step 1: 写失败测试**

创建 `gui/src/settings/__tests__/SettingsShell.advanced.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsShell } from '../SettingsShell';
import { applyDeveloperMode } from '../../developer-mode';

const conn = {
  settings: () => Promise.resolve({ keys: [], permissions: { merged: { deny: [], allow: [], additionalDirs: [] }, project: { deny: [], allow: [], additionalDirs: [] }, global: { deny: [], allow: [], additionalDirs: [] } }, providers: { choices: [], apiKeyPresent: {}, warnings: [] } }),
  putSettings: () => Promise.resolve(),
  memoryStats: () => Promise.resolve({ entries: 0, lastWriteAt: null }),
  settingsRaw: () => Promise.resolve({ content: null }),
  putSettingsRaw: () => Promise.resolve(),
  settingsMcp: () => Promise.resolve({ servers: [] }),
  putSettingsMcp: () => Promise.resolve(),
  settingsAgents: () => Promise.resolve({ agents: [] }),
  putSettingsAgents: () => Promise.resolve(),
  settingsProvidersOp: () => Promise.resolve(),
  settingsPermissionsOp: () => Promise.resolve(),
  settingsBody: () => Promise.resolve({ body: '' }),
  appGuiState: () => Promise.resolve({ state: {} }),
  saveAppGuiState: () => Promise.resolve(),
} as unknown as Parameters<typeof SettingsShell>[0]['conn'];

describe('设置导航高级组分层', () => {
  it('普通态不渲染高级导航项;开启开发者模式后渲染', async () => {
    applyDeveloperMode(false);
    const { unmount } = render(<SettingsShell conn={conn} root="" onBack={vi.fn()} />);
    expect(screen.queryByText('MCP')).toBeNull();
    unmount();
    applyDeveloperMode(true);
    render(<SettingsShell conn={conn} root="" onBack={vi.fn()} />);
    expect(await screen.findByText('MCP')).toBeDefined();
    applyDeveloperMode(false);
  });
});
```

（若 `SettingsShellConn` 类型比上表窄，按 `settings/SettingsShell.tsx` 顶部 interface 逐项补齐——测试桩必须是结构完整对象。若导入报错，直接 `as any` 收口，仅测试文件使用。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd gui && pnpm vitest run src/settings/__tests__/SettingsShell.advanced.test.tsx`
Expected: FAIL —— 普通态仍能查到 `MCP`

- [ ] **Step 3: 导航分组加 advanced 标志并重排**

`gui/src/settings/SettingsShell.tsx`，把 `SETTINGS_GROUPS` 整体替换为：

```ts
const SETTINGS_GROUPS: ReadonlyArray<{ readonly group: { readonly en: string; readonly zh: string } | ''; readonly advanced?: boolean; readonly items: ReadonlyArray<{ readonly id: string; readonly title: { readonly en: string; readonly zh: string } }> }> = [
  {
    group: { en: 'General', zh: '通用' },
    items: [
      { id: 'general', title: { en: 'General', zh: '通用' } },
      { id: 'providers', title: { en: 'Models & providers', zh: '模型与提供方' } },
      { id: 'shortcuts', title: { en: 'Shortcuts', zh: '快捷键' } },
    ],
  },
  {
    group: { en: 'Advanced', zh: '高级' },
    advanced: true,
    items: [
      { id: 'limits', title: { en: 'Context & limits', zh: '上下文与限额' } },
      { id: 'memory', title: { en: 'Memory', zh: '记忆' } },
      { id: 'global-rules', title: { en: 'Global norms', zh: '全局规范' } },
      { id: 'kb', title: { en: 'Knowledge & search', zh: '知识库与搜索' } },
      { id: 'paths', title: { en: 'Paths & shell', zh: '路径与执行环境' } },
      { id: 'skills', title: { en: 'Skills', zh: '技能' } },
      { id: 'mcp', title: { en: 'MCP', zh: 'MCP' } },
      { id: 'plugins', title: { en: 'Plugins', zh: '插件' } },
      { id: 'agents', title: { en: 'Agents', zh: '智能体' } },
      { id: 'teams', title: { en: 'Agent Teams', zh: '智能体团队' } },
      { id: 'permissions', title: { en: 'Permissions', zh: '权限' } },
      { id: 'raw', title: { en: 'Advanced', zh: '高级' } },
    ],
  },
];
const SETTINGS_NAV = SETTINGS_GROUPS.flatMap((g) => g.items);
/** 高级组 pane id 集(普通态回退锚点) */
const ADVANCED_IDS = new Set(SETTINGS_GROUPS.filter((g) => g.advanced === true).flatMap((g) => g.items.map((i) => i.id)));
```

- [ ] **Step 4: 导航渲染按模式过滤 + 切回通用**

在 `SettingsShell` 组件内（`const [activePane, setActivePane] = ...` 之后）加：

```ts
  const dev = useDeveloperMode();
  /** 普通态停在高级 pane(如刚关掉开关)时回退到通用,避免渲染不可见页面 */
  useEffect(() => {
    if (!dev && ADVANCED_IDS.has(activePane)) setActivePane('general');
  }, [dev, activePane]);
```

导航渲染处（原 `SETTINGS_GROUPS.map` 外层）改为先过滤：

```tsx
        {SETTINGS_GROUPS.filter((g) => g.advanced !== true || dev).map((g) => (
```

（保持既有 `<div>`/按钮结构不变，仅外层 map 换源。）

import 区加：
```ts
import { useDeveloperMode } from '../developer-mode';
```

- [ ] **Step 5: 抽出 paths pane**

`gui/src/settings/SettingsForm.tsx`：

1. `general` pane 的 `groups` 中删除 `Paths` 与 `Command execution` 两组（`dirPath(...)` 与 `filePath('shell')` 随之移走）。
2. 在 `general` pane 对象之后追加新 pane：

```ts
  {
    id: 'paths',
    title: { en: 'Paths & shell', zh: '路径与执行环境' },
    groups: [
      {
        title: { en: 'Paths', zh: '路径' },
        fields: [dirPath('projectsDir'), dirPath('sunxDir'), dirPath('userSkillsDir'), dirPath('globalSunshine')], // 语义键 sunxDir（SUNSHINEX_SUNX_DIR 写槽）：容器切换对新建 Sunx 生效，既有域不迁移
      },
      { title: { en: 'Command execution', zh: '命令执行' }, fields: [filePath('shell')] },
    ],
  },
```
3. 行渲染 SourceBadge 改条件（第 581 行）——普通态一律不渲染：

```tsx
                          {dev && row.source !== 'global' && row.source !== 'default' && <SourceBadge source={row.source} />}
```

并在组件内取模式：
```ts
  const dev = useDeveloperMode();
```
import 区加：
```ts
import { useDeveloperMode } from '../developer-mode';
```

- [ ] **Step 6: 更新既有路径/过滤测试的 pane 定位**

`gui/src/settings/__tests__/SettingsForm.path.test.tsx`：文件内定义

```ts
const pathsPane = SETTINGS_PANES.find((p) => p.id === 'paths')!;
```
两处 `render(<SettingsForm conn={conn} root="" pane={SETTINGS_PANES[0]} />)` 改 `pane={pathsPane}`。

`gui/src/settings/__tests__/SettingsForm.filter.test.tsx`：两个用例改渲染 paths pane，并把只属于通用页的断言替换掉。具体：

1. 文件内加 `const pathsPane = SETTINGS_PANES.find((p) => p.id === 'paths')!;`
2. 第一个用例体替换为：

```tsx
    const { conn } = connOf(viewOf([keyRow('projectsDir'), keyRow('userSkillsDir'), keyRow('globalSunshine'), keyRow('shell')]));
    render(<SettingsForm conn={conn} root="/w/proj" pane={pathsPane} />);
    expect(await screen.findByText('Shell')).toBeDefined();
    expect(screen.getByText('Projects directory')).toBeDefined();
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'shell' } });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.getByText('Shell')).toBeDefined();
      expect(screen.queryByText('Projects directory')).toBeNull();
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: '' } });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.getByText('Projects directory')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
```
3. 第二个用例：`pane={SETTINGS_PANES[0]}` 改 `pane={pathsPane}`，其余断言不变。

- [ ] **Step 7: 跑测试与类型检查**

Run: `cd gui && pnpm vitest run src/settings/__tests__/SettingsShell.advanced.test.tsx src/settings/__tests__/SettingsForm.path.test.tsx src/settings/__tests__/SettingsForm.filter.test.tsx && pnpm run typecheck`
Expected: 全部 PASS

- [ ] **Step 8: 提交**

```bash
git add gui/src/settings/SettingsShell.tsx gui/src/settings/SettingsForm.tsx gui/src/settings/__tests__/SettingsForm.path.test.tsx gui/src/settings/__tests__/SettingsShell.advanced.test.tsx
git commit -m "feat(gui): 设置导航分层+路径执行环境独立 pane(普通态不渲染高级组)"
```

---

### Task 4: 右栏「+」菜单四常驻 + 「更多 | 收起」

**Files:**
- Modify: `gui/src/tabs/TabStrip.tsx:284-311`（菜单过滤与末行）
- Test: `gui/src/tabs/tabstrip-menu.test.ts`

**Interfaces:**
- Consumes: `useDeveloperMode()`
- Produces: `menuEntryVisible(id: string, opts: { dev: boolean; showMore: boolean; welcomeOnly: boolean }): boolean`（导出，测试与渲染共用）

- [ ] **Step 1: 写失败测试**

创建 `gui/src/tabs/tabstrip-menu.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { menuEntryVisible } from './TabStrip';

const o = (dev: boolean, showMore = false, welcomeOnly = false): { dev: boolean; showMore: boolean; welcomeOnly: boolean } => ({ dev, showMore, welcomeOnly });

describe('「+」菜单分层(2026-11-17 四常驻+更多|收起)', () => {
  it('普通态只露四常驻', () => {
    for (const id of ['tasks', 'artifacts', 'web', 'sidechat']) expect(menuEntryVisible(id, o(false))).toBe(true);
    for (const id of ['diff', 'plans', 'agents', 'bgtasks', 'memory', 'learned', 'terminal', 'sunxboard']) expect(menuEntryVisible(id, o(false))).toBe(false);
  });
  it('点更多后其余八项可见', () => {
    for (const id of ['diff', 'plans', 'agents', 'bgtasks', 'memory', 'learned', 'terminal', 'sunxboard']) expect(menuEntryVisible(id, o(false, true))).toBe(true);
  });
  it('开发者模式全平铺', () => {
    for (const id of ['diff', 'plans', 'agents', 'bgtasks', 'memory', 'learned', 'terminal', 'sunxboard', 'tasks', 'artifacts', 'web', 'sidechat']) expect(menuEntryVisible(id, o(true))).toBe(true);
  });
  it('欢迎页只开能落地的:普通=浏览器;开发者=浏览器+终端', () => {
    expect(menuEntryVisible('web', o(false, false, true))).toBe(true);
    expect(menuEntryVisible('terminal', o(false, false, true))).toBe(false);
    expect(menuEntryVisible('tasks', o(false, false, true))).toBe(false);
    expect(menuEntryVisible('terminal', o(true, false, true))).toBe(true);
    expect(menuEntryVisible('tasks', o(true, false, true))).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd gui && pnpm vitest run src/tabs/tabstrip-menu.test.ts`
Expected: FAIL —— `menuEntryVisible` 未导出

- [ ] **Step 3: 实现纯函数与菜单接线**

`gui/src/tabs/TabStrip.tsx`：

1. 在 `MENU_HIDDEN` 之后加：

```ts
/** 常驻四项(2026-11-17 用户裁定「待办,产物,浏览器,辅助对话 这四个常驻」) */
const RESIDENT_MENU: ReadonlySet<string> = new Set(['tasks', 'artifacts', 'web', 'sidechat']);

/** 「+」菜单可见性单点(纯函数——渲染与测试共用):
 *  普通态=四常驻,「更多」展开其余;欢迎页(无会话)只开能落地的 web(终端仅开发者模式)。 */
export function menuEntryVisible(id: string, opts: { dev: boolean; showMore: boolean; welcomeOnly: boolean }): boolean {
  if (opts.welcomeOnly) {
    if (id === 'web') return true;
    if (id === 'terminal') return opts.dev;
    return false;
  }
  return opts.dev || opts.showMore || RESIDENT_MENU.has(id);
}
```

2. 组件内加状态与模式：
```ts
  const dev = useDeveloperMode();
  const [showMore, setShowMore] = useState(false); // 会话内记忆(组件挂载期)
```
import 区加：
```ts
import { useDeveloperMode } from '../developer-mode';
```

3. 菜单过滤（第 286 行）替换为：

```tsx
            const entries = TAB_REGISTRY.filter((e) => e.group === g && !MENU_HIDDEN.has(e.id) && !(hiddenMenuIds?.has(e.id) ?? false) && menuEntryVisible(e.id, { dev, showMore, welcomeOnly }));
```

4. 在 `{GROUP_ORDER.map(...)}` 之后、portal 结束前加末行：

```tsx
          {!dev && (
            <button type="button" role="menuitem" className="sx-menuitem" aria-expanded={showMore} onClick={() => setShowMore((v) => !v)}>
              {showMore ? t('Collapse', '收起') : t('More', '更多')}
            </button>
          )}
```

- [ ] **Step 4: 跑测试与既有标签条测试**

Run: `cd gui && pnpm vitest run src/tabs/tabstrip-menu.test.ts src/tabs/tab-strip.test.ts`
Expected: PASS（既有用例点「Todos」仍可见——它在四常驻内）

- [ ] **Step 5: 提交**

```bash
git add gui/src/tabs/TabStrip.tsx gui/src/tabs/tabstrip-menu.test.ts
git commit -m "feat(gui): 「+」菜单四常驻+更多收起(2026-11-17 裁定)"
```

---

### Task 5: 空态「打开标签页」快捷入口按模式定死

**Files:**
- Modify: `gui/src/App.tsx:4`（图标 import 已齐）、`:1208-1234`（快捷卡片数组）、App.tsx 顶部 import 区、`AppShell` 内取模式
- Test: `gui/src/tab-empty-cards.test.ts`

**Interfaces:**
- Consumes: `useDeveloperMode()`
- Produces: `emptyTabCardIds(welcome: boolean, dev: boolean): readonly string[]`（从 `App.tsx` 导出）

- [ ] **Step 1: 写失败测试**

创建 `gui/src/tab-empty-cards.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { emptyTabCardIds } from './App';

describe('空态快捷入口(2026-11-17 裁定)', () => {
  it('普通:欢迎页只浏览器;会话内浏览器+辅助对话', () => {
    expect(emptyTabCardIds(true, false)).toEqual(['web']);
    expect(emptyTabCardIds(false, false)).toEqual(['web', 'side']);
  });
  it('开发者:欢迎页终端+浏览器;会话内审查+浏览器+终端+辅助对话', () => {
    expect(emptyTabCardIds(true, true)).toEqual(['terminal', 'web']);
    expect(emptyTabCardIds(false, true)).toEqual(['diff', 'web', 'terminal', 'side']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd gui && pnpm vitest run src/tab-empty-cards.test.ts`
Expected: FAIL —— `emptyTabCardIds` 未导出

- [ ] **Step 3: 实现并接线**

`gui/src/App.tsx`：

1. import 区加：
```ts
import { useDeveloperMode } from './developer-mode';
```
2. 在文件顶层（`export function App()` 之前）加：

```ts
/** 空态快捷入口 id 序列(2026-11-17 用户裁定,按模式定死;终端/审查普通态不上快捷入口) */
export function emptyTabCardIds(welcome: boolean, dev: boolean): readonly string[] {
  if (welcome) return dev ? ['terminal', 'web'] : ['web'];
  return dev ? ['diff', 'web', 'terminal', 'side'] : ['web', 'side'];
}
```
3. `AppShell` 内加：
```ts
  const dev = useDeveloperMode();
```
4. 空态卡片数组替换为（保持既有图标与 onClick 映射，仅按 id 序列分发）：

```tsx
                  {emptyTabCardIds(isWelcome, dev).map((key) => {
                    const cards: Record<string, [LucideIcon, string, () => void]> = {
                      web: [Globe, t('Browser', '浏览器'), (): void => openTabInSession('web')],
                      terminal: [SquareTerminal, t('Terminal', '终端'), (): void => openTabInSession('terminal')],
                      side: [MessageCircle, t('Side chat', '辅助对话'), (): void => startSideChat()],
                      diff: [GitCompare, t('Review', '审查'), (): void => openTabInSession('diff')],
                    };
                    const [Icon, label, onClick] = cards[key]!;
                    return (
                      <button key={key} type="button" className="sx-tab-empty-card" onClick={onClick}>
                        <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                        <span>{label}</span>
                      </button>
                    );
                  })}
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `cd gui && pnpm vitest run src/tab-empty-cards.test.ts && pnpm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add gui/src/App.tsx gui/src/tab-empty-cards.test.ts
git commit -m "feat(gui): 空态快捷入口按开发者模式定死(普通=浏览器/浏览器+辅助对话)"
```

---

### Task 6: 顶栏动态计数按钮组按模式收起

**Files:**
- Modify: `gui/src/pages/chat/ChatTopbar.tsx:461`（ChatDynButtons 渲染条件）、import 区

**Interfaces:**
- Consumes: `useDeveloperMode()`
- Produces: 无新导出

- [ ] **Step 1: 实施（单行门控，行为由既有 ChatDynButtons「空 blocks 返回 null」保证）**

1. import 区加：
```ts
import { useDeveloperMode } from '../../developer-mode';
```
2. 组件内（`const { fixedTitle, ... } = props;` 之后）加：
```ts
  const dev = useDeveloperMode();
```
3. 第 461 行改为：
```tsx
        {dev && <ChatDynButtons blocks={blocks ?? []} onOpenTab={onOpenTab} />}
```

- [ ] **Step 2: 跑既有顶栏/应用测试与类型检查**

Run: `cd gui && pnpm vitest run src/App.test.tsx && pnpm run typecheck`
Expected: PASS（既有断言不涉及动态计数按钮组在普通态的存在性；若 App.test 有相关用例，改为断言普通态不渲染 `aria-label="live counters"`）

- [ ] **Step 3: 提交**

```bash
git add gui/src/pages/chat/ChatTopbar.tsx
git commit -m "feat(gui): 普通态收起顶栏动态计数按钮组"
```

---

### Task 7: composer「+」面板次级分区收起

**Files:**
- Modify: `gui/src/composer/ComposerPlusPanel.tsx:210-350`（分区包裹与开关行）、import 区
- Test: `gui/src/composer/composer-plus-panel.test.tsx`

**Interfaces:**
- Consumes: `useDeveloperMode()`
- Produces: 无新导出

- [ ] **Step 1: 写失败测试**

创建 `gui/src/composer/composer-plus-panel.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ComposerPlusPanel } from './ComposerPlusPanel';
import { applyDeveloperMode } from '../developer-mode';

const conn = {
  commands: () => Promise.resolve({ commands: ['/help'], descriptions: {}, supported: ['/help'] }),
  skillsGroups: () => Promise.resolve({ groups: [] }),
  tree: () => Promise.resolve({ entries: [] }),
} as unknown as Parameters<typeof ComposerPlusPanel>[0]['conn'];

describe('+ 面板分区收起(普通态)', () => {
  it('普通态命令分区收起,点「浏览命令与技能」展开', async () => {
    applyDeveloperMode(false);
    render(<ComposerPlusPanel conn={conn} onInsert={vi.fn()} />);
    expect(await screen.findByText('Browse commands & skills')).toBeDefined();
    expect(screen.queryByText('Commands')).toBeNull();
    fireEvent.click(screen.getByText('Browse commands & skills'));
    expect(await screen.findByText('Commands')).toBeDefined();
  });
  it('开发者模式全展开', async () => {
    applyDeveloperMode(true);
    render(<ComposerPlusPanel conn={conn} onInsert={vi.fn()} />);
    expect(await screen.findByText('Commands')).toBeDefined();
    applyDeveloperMode(false);
  });
});
```

（`PlusPanelConn` 方法名以 `ComposerPlusPanel.tsx` 顶部 interface 为准逐项补齐；只用到的三个方法给桩即可，其余 `as any` 收口。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd gui && pnpm vitest run src/composer/composer-plus-panel.test.tsx`
Expected: FAIL —— 找不到 `Browse commands & skills`

- [ ] **Step 3: 实现**

`gui/src/composer/ComposerPlusPanel.tsx`：

1. import 区加：
```ts
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useDeveloperMode } from '../developer-mode';
```
2. 组件内（`const filePickRef = ...` 之后）加：
```ts
  const dev = useDeveloperMode();
  const [showTools, setShowTools] = useState(false); // 面板内记忆
```
3. 在附件区 `)}` 之后（第 242 行后）插入开关行：

```tsx
      {/* 2026-11-17 裁定:命令/技能/子智能体/团队四分区普通态收起(逃生面:/ $ # 键盘直达不变) */}
      {!dev && (
        <button type="button" role="menuitem" className="sx-plus-row" aria-expanded={showTools} onClick={() => setShowTools((v) => !v)}>
          {showTools ? <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" /> : <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />}
          <span className="sx-plus-name">{showTools ? t('Hide commands & skills', '收起命令与技能') : t('Browse commands & skills', '浏览命令与技能')}</span>
        </button>
      )}
```
4. 用 `{(dev || showTools) && (<> … </>)}` 包住第 244-289 行（Command/Skills/Sub-agents/Teams 四区）。

- [ ] **Step 4: 跑测试与类型检查**

Run: `cd gui && pnpm vitest run src/composer/composer-plus-panel.test.tsx && pnpm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add gui/src/composer/ComposerPlusPanel.tsx gui/src/composer/composer-plus-panel.test.tsx
git commit -m "feat(gui): composer「+」面板命令技能区普通态收起"
```

---

## Self-Review

**Spec coverage：**
- §0 单开关 → Task 1/2 ✔
- §1.2 清单 → Task 3（设置高级组）、Task 6（计数组）、Task 4/5（标签入口）✔；effort 滑条保留不动（§4.7）✔
- §1.4 Sunx 不改 → 无任务（spec 已裁定不改）✔
- §2 单一 key + 单源消费 → Task 1 ✔
- §3 左栏不动 → 无任务 ✔
- §4.1 顶栏 → Task 6 ✔
- §4.2 工具行不改 → 无任务 ✔
- §4.4 空态内容不新增 → Task 5 只改入口集合 ✔
- §4.5「+」面板 → Task 7 ✔
- §4.6 快捷入口 → Task 5 ✔
- §5.1「+」菜单 → Task 4 ✔
- §5.2 默认页签不动 → 无任务 ✔
- §6 术语 → 不改（2026-11-17 用户裁定）；SourceBadge 收起并入 Task 3 ✔
- §7 设置页 → Task 2/3 ✔
- §8 视觉不动 → 全局约束 ✔
- §10 不做清单 → 全局约束 ✔

**Placeholder scan：** 无 TBD/TODO；所有步骤含可执行命令或代码。

**Type consistency：** `useDeveloperMode(): boolean`、`readDeveloperMode(): boolean`、`applyDeveloperMode(on: boolean): void`、`menuEntryVisible(id, {dev,showMore,welcomeOnly})`、`emptyTabCardIds(welcome, dev)` 全篇一致；设置组标志统一 `developerRow`；导航标志统一 `advanced`。
