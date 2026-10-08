# Codex 桌面端 1:1 复刻(B1-B5)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GUI(`gui/`)视觉与交互语言对 Codex 桌面端 1:1——双主题令牌、壳层次、胶囊行制、用户消息右胶囊、浮卡 composer、浮面制弹层。

**Architecture:** B1 先落主题机制(`html[data-theme]` + `gui/src/theme.ts` + 首 paint 引导)与新令牌表(新旧并存);B2 全量迁移 app.css 规则到新令牌并删旧令牌;B3-B5 逐组件重构形状与交互(壳/侧栏 → 会话流含 Chat.tsx DOM 改动 → composer → 打磨)。每任务独立可交付、测试全绿、单独提交。

**Tech Stack:** React 18 + Vite + vitest + @testing-library/react(gui);纯 CSS 单文件约束(app.css)。

**Spec:** `docs/superpowers/specs/2026-10-08-codex-desktop-1to1-design.md`(实现依据;数值来源 `docs/superpowers/specs/2026-10-08-codex-desktop-audit.md` §二/§三)。

## Global Constraints

- 单一 CSS 文件:全部样式只在 `gui/src/app.css`(U-D10);superellipse 经 `@supports` 渐进。
- 复刻纪律(spec §0):不加无功能入口(权限/模型 pill、消息 Edit 钮不做);信息架构不动。
- TS strict;测试与被测同目录;`t(en,zh)` 双语仅外观——本计划 GUI 文案沿用现有中文面,不引入新英文硬编码 UI 文案(复制钮「复制/已复制/未复制」为外观中文,与现 GUI 一致)。
- 每任务收口:`cd gui && pnpm test`(vitest run,pretest 自带 typecheck+根 tsc)全绿;最终 `pnpm build`(根)。
- 提交粒度:每任务一 commit,消息 `feat(gui): G9x-...` 风格(沿仓内惯例);不碰 `src/cli/index.ts` 等无关改动。

---

### Task 1: 主题机制与双主题令牌(新旧并存)

**Files:**
- Create: `gui/src/theme.ts`、`gui/src/theme.test.ts`
- Modify: `gui/index.html`、`gui/src/settings/SettingsShell.tsx`、`gui/src/app.css`(仅头部令牌段:在 `:root` 旧块之前插入新令牌块;旧块原样保留,Task 2 删)

**Interfaces:**
- Produces: `readThemePref(): ThemePref`、`applyTheme(pref: ThemePref): void`、`watchSystemTheme(pref: ThemePref, onChange?): () => void`,`type ThemePref = 'system' | 'light' | 'dark'`(Task 8 ThemeSelect 已在此建,复用)。
- Produces: 新 CSS 令牌(--surface 系/--fg 系/--border 系/--accent/--ok/--warn/--err/--ok-solid/--err-solid/--bubble-user/--radius-*/--elev-*/--ease-*/--dur-*/--chat-max/--thread-gutter/--row-h/--toolbar-h/--syntax-*)。Task 2 起全部规则只消费这些。

- [ ] **Step 1: 写 theme 失败测试**

`gui/src/theme.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyTheme, readThemePref, watchSystemTheme } from './theme';

describe('theme 主题偏好', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.dataset.theme = '';
  });

  it('缺省 system;非法存储值回落 system', () => {
    expect(readThemePref()).toBe('system');
    localStorage.setItem('sunshinex.theme', 'bogus');
    expect(readThemePref()).toBe('system');
  });

  it('applyTheme 落 html[data-theme] 并持久', () => {
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('sunshinex.theme')).toBe('light');
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('system 态按 matchMedia 落属性(matchMedia 缺失回落暗色)', () => {
    const spy = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    window.matchMedia = spy as unknown as typeof window.matchMedia;
    applyTheme('system');
    expect(document.documentElement.dataset.theme).toBe('light');
    delete (window as { matchMedia?: unknown }).matchMedia;
    applyTheme('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('watchSystemTheme:非 system 返回解绑即空;system 挂监听', () => {
    expect(watchSystemTheme('dark')).toBeTypeOf('function');
    const mq = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    window.matchMedia = vi.fn().mockReturnValue(mq) as unknown as typeof window.matchMedia;
    const off = watchSystemTheme('system');
    expect(mq.addEventListener).toHaveBeenCalled();
    off();
    expect(mq.removeEventListener).toHaveBeenCalled();
    delete (window as { matchMedia?: unknown }).matchMedia;
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd gui && pnpm test src/theme.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 theme.ts**

```ts
/** 主题偏好(G9 Codex 1:1 spec §1.1):三态持久 localStorage['sunshinex.theme'];
 *  applyTheme 落 html[data-theme](CSS 双主题块的切换面);system 态经 matchMedia 求值。 */

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'sunshinex.theme';

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function systemDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(pref: ThemePref): void {
  const dark = pref === 'dark' || (pref === 'system' && !systemDarkLightable());
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* 隐私模式等持久化失败:仅内存态生效,不阻断 */
  }
}

/** systemDark 的可降级形态:matchMedia 缺失(jsdom/旧 WebView)按暗色处理 */
function systemDarkLightable(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function watchSystemTheme(pref: ThemePref, onChange?: (pref: ThemePref) => void): () => void {
  if (pref !== 'system' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const fn = (): void => {
    applyTheme('system');
    onChange?.('system');
  };
  mq.addEventListener('change', fn);
  return () => mq.removeEventListener('change', fn);
}
```

注:`systemDark` 与 `systemDarkLightable` 重复——实现时只留一个 `systemDark()`(逻辑如上单函数),此处两名为笔误防线:落地为

```ts
function systemDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}
export function applyTheme(pref: ThemePref): void {
  const dark = pref === 'dark' || (pref === 'system' && !systemDark());
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  /* 持久化同上 */
}
```

(测试第 3 例「matchMedia 缺失回落暗色」即由 `!systemDark()` 承载。)

- [ ] **Step 4: 跑测试确认通过**

Run: `cd gui && pnpm test src/theme.test.ts`
Expected: PASS(4 例)

- [ ] **Step 5: index.html 首 paint 引导(防 FOUC)**

`gui/index.html` 的 `<head>` 内、`<title>` 之后插入:

```html
<script>
  (function () {
    var pref = 'system';
    try { pref = localStorage.getItem('sunshinex.theme') || 'system'; } catch (e) {}
    var dark =
      pref === 'dark' ||
      (pref !== 'light' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  })();
</script>
```

- [ ] **Step 6: ThemeSelect 挂进 SettingsShell**

`gui/src/settings/SettingsShell.tsx`:顶部 import 增 `import { applyTheme, readThemePref, watchSystemTheme } from '../theme'; import type { ThemePref } from '../theme';` 与 `import { useEffect, useState } from 'react';`(useState 已有则并)。文件内(nav 组件定义之前)加:

```tsx
/** 外观主题(G9 spec §1.1):三态持久;system 态跟随系统(watch 卸载解绑) */
function ThemeSelect(): JSX.Element {
  const [pref, setPref] = useState<ThemePref>(readThemePref);
  useEffect(() => watchSystemTheme(pref), [pref]);
  return (
    <div className="sx-theme-row">
      <label htmlFor="theme-select">外观</label>
      <select
        id="theme-select"
        aria-label="theme"
        value={pref}
        onChange={(e) => {
          const p = e.target.value as ThemePref;
          setPref(p);
          applyTheme(p);
        }}
      >
        <option value="system">跟随系统</option>
        <option value="light">亮色</option>
        <option value="dark">暗色</option>
      </select>
    </div>
  );
}
```

左栏 JSX 中 `.sx-settings-project` div 之后、`<ul className="sx-settings-nav">` 之前插一行 `<ThemeSelect />`。

- [ ] **Step 7: app.css 插入新令牌块(旧块暂留)**

`gui/src/app.css` 文件头(原 `/* G8a 设计令牌 ... */ :root {` 之前)插入(spec §1.2 全量;light 覆盖块只列差异,其余继承 dark 块):

```css
/* ===== G9 Codex 1:1 双主题令牌(spec §1.2;值源 audit §2)===== */
:root {
  color-scheme: dark;
  --surface: #181818;
  --surface-under: #000;
  --surface-elevated: #212121;
  --surface-soft: #303030;
  --surface-code: #101010;
  --fg: #dfdfdf;
  --fg-secondary: color-mix(in srgb, var(--fg) 70%, transparent);
  --fg-tertiary: color-mix(in srgb, var(--fg) 50%, transparent);
  --fg-on-solid: #0d0d0d;
  --border: color-mix(in srgb, var(--fg) 8%, transparent);
  --border-subtle: color-mix(in srgb, var(--fg) 5%, transparent);
  --border-strong: color-mix(in srgb, var(--fg) 16%, transparent);
  --accent: #339cff;
  --accent-strong: #0285ff;
  --ok: #40c977;
  --warn: #ff8549;
  --err: #ff6764;
  --ok-solid: #00a240;
  --err-solid: #e02e2a;
  --bubble-user: color-mix(in srgb, var(--fg) 8%, transparent);
  --radius-xs: 5px;
  --radius-sm: 7.5px;
  --radius-md: 10px;
  --radius-lg: 12.5px;
  --radius-xl: 15px;
  --radius-2xl: 20px;
  --radius-composer: 22px;
  --radius-row: 9999px;
  --elev-card: 0 4px 16px rgba(0, 0, 0, 0.2);
  --elev-prominent: 0 0 0 0.5px var(--border-strong), 0 3px 7.5px rgba(0, 0, 0, 0.18), 0 0 20px rgba(0, 0, 0, 0.2);
  --elev-composer: 0 0 0 1px rgba(0, 0, 0, 0.04), 0 2px 8px rgba(0, 0, 0, 0.04), 0 4px 80px 8px rgba(0, 0, 0, 0.024),
    inset 0 0 1px 0 rgba(255, 255, 255, 0.2);
  --ease-enter: cubic-bezier(0.19, 1, 0.22, 1);
  --ease-exit: cubic-bezier(0.8, 0, 0.4, 1);
  --dur-basic: 0.15s;
  --dur-relaxed: 0.3s;
  --chat-max: 800px;
  --thread-gutter: 16px;
  --row-h: 29px;
  --toolbar-h: 46px;
  --syntax-comment: #b9b9b9;
  --syntax-keyword: #f8a6c8;
  --syntax-literal: #f1a275;
  --syntax-string: #83d197;
  --syntax-variable: #b897f4;
  --syntax-attr: #f9dc78;
  --syntax-name: #63a8f8;
  --font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, 'SF Mono', menlo, consolas, 'Liberation Mono', monospace;
}
[data-theme='light'] {
  color-scheme: light;
  --surface: #fff;
  --surface-under: #f9f9f9;
  --surface-elevated: #fff;
  --surface-soft: #f3f3f3;
  --surface-code: #fcfcfc;
  --fg: #1a1c1f;
  --fg-on-solid: #fff;
  --bubble-user: color-mix(in srgb, var(--fg) 5%, transparent);
  --accent-strong: #0169cc;
  --ok: #00a240;
  --warn: #e25507;
  --err: #e02e2a;
  --elev-card: 0 4px 16px rgba(0, 0, 0, 0.05);
  --elev-prominent: 0 0 0 0.5px var(--border-strong), 0 3px 7.5px rgba(0, 0, 0, 0.04), 0 0 20px rgba(0, 0, 0, 0.05);
  --elev-composer: 0 0 0 1px rgba(0, 0, 0, 0.04), 0 2px 8px rgba(0, 0, 0, 0.04), 0 4px 80px 8px rgba(0, 0, 0, 0.024);
  --syntax-comment: #4f4f4f;
  --syntax-keyword: #ab4f7a;
  --syntax-literal: #ac4f23;
  --syntax-string: #3a843f;
  --syntax-variable: #643cae;
  --syntax-attr: #b8802b;
  --syntax-name: #1f4e94;
}
```

注意:旧令牌块里已有 `--border`(实色 `#30363d`)与新块重名——**旧块中的 `--border` 定义行删除**(新块同名单一来源),旧块其余(--bg-0/1/2、--fg-0/1、--accent、--ok、--warn、--err、--radius、--font-*)原样保留给存量规则,Task 2 迁移后整块删除。`--fg-secondary` 等派生 token 经 `color-mix(var(--fg)…)` 自动随主题,light 块无需重复。

- [ ] **Step 8: 全量测试 + 提交**

Run: `cd gui && pnpm test`
Expected: 全绿(既有用例不受影响——旧令牌仍在,渲染未变)

```bash
git add gui/src/theme.ts gui/src/theme.test.ts gui/index.html gui/src/settings/SettingsShell.tsx gui/src/app.css
git commit -m "feat(gui): G9-Codex1:1 B1a 主题机制(html[data-theme]+theme.ts+首paint引导+设置外观行)+双主题令牌表(新旧并存,Task2 迁移删旧)"
```

---

### Task 2: 全规则令牌迁移(sweep)——B1 收口

**Files:**
- Modify: `gui/src/app.css`(全部规则段)

**Interfaces:**
- Consumes: Task 1 新令牌。
- Produces: app.css 零旧令牌引用、零旧色值;此后所有批次只写新令牌。

- [ ] **Step 1: 按语境映射迁移每条规则**

逐段改写(选择器不动,只换属性值;「悬停 8% 底」=`color-mix(in srgb, var(--fg) 8%, transparent)`):

| 现规则(选择器 · 属性) | 改为 |
|---|---|
| `body` · background / color | `var(--surface-under)` / `var(--fg)` |
| `.sx-shell` · (无 bg,继承 body) | 不动 |
| `.sx-menu`, `.sx-sidebar` · background | `var(--surface-under)` |
| `.sx-main` · 增 `background: var(--surface)` | 主面与侧栏分层(Task 3 再加圆角) |
| `.sx-tab:hover`/`.sx-iconbtn:hover`/`.sx-group-head:hover`/`.sx-session-row:hover`/`.sx-settings-nav-item:hover`/`.dir-entry:hover`/`.dir-parent:hover`/`.sx-tree-row:hover`/`.teammate:hover`/`.sx-menuitem:hover`/`.sx-add-workspace:hover` · background | `color-mix(in srgb, var(--fg) 8%, transparent)` |
| 卡类 background(`.sx-provider-card`/`.sx-mcp-card`/`.sx-agent-card`/`.sx-agent-builtin`/`.sx-perm-col`/`.sx-settings-rows`/`.sx-subagent-card`/`.task-row`/`.board-detail`/`.team-sidebar`/`.pending-card`/`.modal-body`/`.token-gate`/`.sx-menu-foot`/`.sx-card-form`/`.sx-menu-pop`/`.board-dag`) | `var(--surface-elevated)` |
| 顶条类(`.chat-topbar`/`.board-topbar`/`.files-bar`/`.sx-web-bar`) · background | `var(--surface)` |
| 代码井类 background(`.entry pre`/`.sx-agent-body pre`/`.sx-subagent-lines`/`.sx-raw-editor`/`.dirpicker-list`/`.sx-pty`) | `var(--surface-code)` |
| 输入类 background(`.sx-settings-project select`/`.sx-setting-input`/`.sx-card-form input,select,textarea`/`.sx-web-url`/`.files-path`/`.dirpicker-path`/`.dirpicker-custom input`/`.card-custom`/`.sx-setting-input`(G8f 段 bg-0)/`.sx-raw-controls select,button`/`.sx-web-open,.sx-web-ext,.sx-web-reload`/`.files-load`/`.dirpicker-custom button`/`.dirpicker-foot button`/`.sx-settings-save` 以外按钮面/`.view-toggle` track/`.sx-chip`/`.session-chip`/`.sx-kbd`/`.sx-count`) | `var(--surface-soft)`(chip/kbd/count 类小徽用 8% mix 亦可,统一先 soft,B5 收敛) |
| `.sx-settings-save` · background(青实心) | `var(--fg)`;color → `var(--fg-on-solid)`;hover → `color-mix(in srgb, var(--fg) 90%, var(--surface))` |
| 全部 `var(--bg-0)` 残余 | 按「代码井→`--surface-code`、输入→`--surface-soft`、底→`--surface-under`」归位 |
| 全部 `var(--bg-1)` 残余 | `var(--surface-elevated)` |
| 全部 `var(--bg-2)` 残余 | 悬停→8% mix;控件面→`var(--surface-soft)` |
| 全部 `var(--fg-0)` / `var(--fg-1)` | `var(--fg)` / `var(--fg-secondary)`(占位/说明类文字可 `--fg-tertiary`,B5 微调) |
| 全部 `var(--accent-strong)` | `var(--accent)`(B5 起悬停改 mix 叠加制) |
| 全部 `var(--radius)` | `var(--radius-md)` |
| `.sx-session-dot.running`/`.conn-dot.conn-open`/`.sx-src-project::before` 等 accent 点 | `var(--accent)`(值已换蓝,规则不动) |
| `.sx-tab.active` · border accent 描边+15% 混底 | `background: color-mix(in srgb, var(--fg) 8%, transparent); border: none`(G9 软底制) |
| `::-webkit-scrollbar-thumb` · background | `color-mix(in srgb, var(--fg) 30%, transparent)`;hover → `var(--border-strong)` |
| 增 `::selection { background: color-mix(in srgb, var(--accent) 30%, transparent); }` | 新规则 |
| `.files-view .hljs-*` 七行映射 | keyword 类→`var(--syntax-keyword)`;string/attr→`--syntax-string`;number/literal→`--syntax-literal`;comment→`--syntax-comment`;title/name→`--syntax-name` |

- [ ] **Step 2: 删除旧令牌块**

`gui/src/app.css` 头部旧 `:root { --bg-0: ... --font-mono: ... }` 整块删除(--border 行 Task 1 已删);顶部注释改写为指向新令牌段。

- [ ] **Step 3: 门禁 grep**

Run: `grep -nE 'var\(--bg-[012]\)|var\(--fg-[01]\)|--accent-strong|var\(--radius\)' gui/src/app.css; grep -cE '#0d1117|#161b22|#21262d|#30363d|#22d3ee|#06b6d4|#e6edf3|#9aa7b3' gui/src/app.css`
Expected: 前者无输出,后者 `0`

- [ ] **Step 4: 测试 + 双主题目检 + 提交**

Run: `cd gui && pnpm test && pnpm build`
`cd gui && pnpm dev` 打开浏览器:设置 → 外观切亮/暗,全页面无旧青蓝/无破色。

```bash
git add gui/src/app.css
git commit -m "feat(gui): G9-Codex1:1 B1b 全规则令牌迁移+旧令牌退役(透明度边框制/滚动条/selection/hljs 双主题语法色;grep 门禁零残留)"
```

---

### Task 3: 壳与侧栏结构(B2)

**Files:**
- Modify: `gui/src/app.css`(壳/左栏/顶条/TabStrip 段)

**Interfaces:** Consumes Task 1 令牌。纯 CSS,零 TSX。

- [ ] **Step 1: 壳层次与主面圆角**

`.sx-main` 增:`border-top-left-radius: var(--radius-lg); overflow: hidden;`(主面压在 under 侧栏上的浮层感);`.sx-menu`/`.sx-sidebar` 去 `border-right`/`border-left` 实线(分层靠明度差);`.sx-sidebar` 保持 existing 拖拽宽度逻辑。

- [ ] **Step 2: 侧栏胶囊行制**

```css
.sx-group-head, .sx-settings-nav-item, .sx-add-workspace { border-radius: var(--radius-row); }
.sx-group-head { padding: 0 10px; height: var(--row-h); }
.sx-group-head.active { background: color-mix(in srgb, var(--fg) 8%, transparent); box-shadow: none; }
.sx-session-row { height: var(--row-h); padding: 0 10px; margin: 0 8px 0 28px; border-radius: var(--radius-row); }
.sx-session-row.active { background: color-mix(in srgb, var(--fg) 8%, transparent); box-shadow: none; }
.sx-session-dot { width: 6px; height: 6px; }
.sx-session-dot.running { background: var(--fg-secondary); border: none; animation: sx-spin 1s linear infinite; }
@keyframes sx-spin { to { transform: rotate(360deg); } }
/* spinner 环形态:6px 点改 10px 圆环缺口感 */
.sx-session-dot.running { width: 10px; height: 10px; border: 1.5px solid var(--fg-tertiary); border-top-color: var(--fg); background: transparent; }
```

(实现时保留后一规则形态:10px 圆环旋转;删前一 `background` 行。)

`.sx-menu-foot` 去卡片(`background/border/border-radius` 删,`margin:0; padding: 8px 12px;`);`.sx-settings-back` 圆角 `--radius-sm`。

- [ ] **Step 3: 顶条极简**

`.chat-topbar`/`.board-topbar`:去 `border-bottom`、`background: transparent`;`height: var(--toolbar-h); padding: 0 12px;`。`.chat-topbar .back`/`.delete` 去 `border`:`padding: 2px 8px; border-radius: var(--radius-sm); color: var(--fg-secondary);`,hover `background: color-mix(in srgb, var(--fg) 8%, transparent); color: var(--fg);`。`.session-chip` 去 `border`(soft 底保留)。

- [ ] **Step 4: TabStrip 对齐**

`.sx-tabstrip` 去 `border-bottom`;`.sx-tab` hover/active 用 8% mix(与 Task 2 一致);`.sx-iconbtn` hover 同;`.sx-menu-pop` 圆角 `--radius-lg`、`box-shadow: var(--elev-prominent)`。

- [ ] **Step 5: 目检 + 测试 + 提交**

Run: `cd gui && pnpm test && pnpm build`
目检:侧栏黑、主面左上圆角、行 hover 胶囊、运行会话转环。

```bash
git add gui/src/app.css
git commit -m "feat(gui): G9-Codex1:1 B2 壳与侧栏(主面左上大圆角浮层感/侧栏零分割线/29px 胶囊行制/运行会话旋转环/顶条极简 ghost 化/TabStrip 软底制)"
```

---

### Task 4: 条目时间戳与日期分组纯函数(B3a)

**Files:**
- Modify: `gui/src/chat-reducer.ts`(`ChatEntry` 增 `ts`;十处条目创建点透传)
- Create: `gui/src/chat-groups.ts`、`gui/src/chat-groups.test.ts`

**Interfaces:**
- Produces: `ChatEntry.ts?: number`(epoch ms);`groupEntriesByDay(entries: readonly ChatEntry[], now?: Date): ChatDayGroup[]`,`interface ChatDayGroup { key: string; label: string; entries: ChatEntry[] }`(Task 5 消费)。

- [ ] **Step 1: 写分组失败测试**

`gui/src/chat-groups.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { groupEntriesByDay } from './chat-groups';
import type { ChatEntry } from './chat-reducer';

const e = (key: string, ts?: number): ChatEntry => ({ key, kind: 'assistant', md: key, ...(ts !== undefined ? { ts } : {}) });
const NOW = new Date(2026, 9, 8, 12); // 2026-10-08
const d = (month: number, day: number, year = NOW.getFullYear()): number => new Date(year, month - 1, day, 10).getTime();

describe('groupEntriesByDay 日期分组', () => {
  it('同日条目归组,标签「M月D日周X」', () => {
    const g = groupEntriesByDay([e('a', d(10, 8)), e('b', d(10, 8))], NOW);
    expect(g).toHaveLength(1);
    expect(g[0]!.entries.map((x) => x.key)).toEqual(['a', 'b']);
    expect(g[0]!.label).toMatch(/10月8日周/);
  });

  it('跨日切组;无 ts 条目贴前组(首条无 ts 入无标组)', () => {
    const g = groupEntriesByDay([e('x', d(10, 7)), e('y'), e('z', d(10, 8))], NOW);
    expect(g).toHaveLength(2);
    expect(g[0]!.entries.map((x) => x.key)).toEqual(['x', 'y']);
    expect(g[0]!.label).toMatch(/10月7日周/);
  });

  it('跨年条目标签含年份', () => {
    const g = groupEntriesByDay([e('a', d(1, 10, NOW.getFullYear() - 1))], NOW);
    expect(g[0]!.label).toContain(`${NOW.getFullYear() - 1}年1月10日`);
  });

  it('全部无 ts:单一无标组(不渲染分隔行)', () => {
    const g = groupEntriesByDay([e('a'), e('b')], NOW);
    expect(g).toHaveLength(1);
    expect(g[0]!.label).toBe('');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd gui && pnpm test src/chat-groups.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 chat-groups.ts**

```ts
import type { ChatEntry } from './chat-reducer';

/** 会话流日期分组(Codex 形:跨日插居中日期分隔;spec §3.2)。纯投影:无 ts 条目贴前组
 *  (首条无 ts 入无标组,label='' 渲染面跳过分隔行)。 */
export interface ChatDayGroup {
  key: string;
  label: string;
  entries: ChatEntry[];
}

export function groupEntriesByDay(entries: readonly ChatEntry[], now: Date = new Date()): ChatDayGroup[] {
  const sameYear = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
  const crossYear = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  const groups: ChatDayGroup[] = [];
  for (const e of entries) {
    const day = typeof e.ts === 'number' && e.ts > 0 ? dayKeyOf(new Date(e.ts)) : undefined;
    const last = groups[groups.length - 1];
    if (day === undefined) {
      if (last !== undefined) last.entries.push(e);
      else groups.push({ key: 'none', label: '', entries: [e] });
      continue;
    }
    if (last !== undefined && last.key === day) {
      last.entries.push(e);
      continue;
    }
    const d = new Date(e.ts!);
    groups.push({ key: day, label: d.getFullYear() === now.getFullYear() ? sameYear.format(d) : crossYear.format(d), entries: [e] });
  }
  return groups;
}

function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd gui && pnpm test src/chat-groups.test.ts`
Expected: PASS(4 例)

- [ ] **Step 5: ChatEntry 透传 ts**

`gui/src/chat-reducer.ts`:
1. `ChatEntry` 增字段 `/** 条目时间(epoch ms;日期分隔投影源;种子条透传快照,事件条透传 e.ts) */ ts?: number;`
2. 十处创建点补 ts(行号约):`appendUserMessage`(L54,签名增第三参 `ts?: number`,`ts: ts ?? Date.now()`,同步在 `Chat.tsx` send() 调用处传 `Date.now()`);`onToken` 新条(L144,`ts: Date.now()`——流式条开条时刻);`onDone` 独立条(L159,`ts: e.ts`);`onError`(L167,`ts: e.ts`);`onToolCall` 新条(L181,`ts: e.ts`);`onToolResult` 两处新条(L194、L203,`ts: e.ts`);`notice` 分支(L238,`ts: e.ts`);`delegation-*`(L255,`ts: e.ts`);`agent-message`(L260,`ts: e.ts`);`seedChatFromSnapshot`(L60,`ts: m.ts`)。
   `e.ts` 为 `SessionEvent.ts?: number`(epoch ms,`src/types.ts` 已声明),`typeof e.ts === 'number' ? e.ts : undefined` 直接透传即可(字段可选)。

- [ ] **Step 6: reducer 测试补断言 + 全量**

`gui/src/chat-reducer.test.ts` 增一例:

```ts
it('条目透传事件 ts;种子条透传快照 ts', () => {
  let s = applyChatEvent(initialChatState(), { type: 'done', text: 'hi', ts: 1728380000000 } as SessionEvent);
  expect(s.entries[0]!.ts).toBe(1728380000000);
  s = seedChatFromSnapshot([{ seq: 1, ts: 1728380001000, kind: 'user', md: '> yo' }], 'idle');
  expect(s.entries[0]!.ts).toBe(1728380001000);
});
```

(按该文件既有 import 形态并入;`as SessionEvent` 若既有桩类型不匹配则按文件内现行构桩方式调整字段。)

Run: `cd gui && pnpm test`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add gui/src/chat-reducer.ts gui/src/chat-groups.ts gui/src/chat-groups.test.ts gui/src/chat-reducer.test.ts
git commit -m "feat(gui): G9-Codex1:1 B3a ChatEntry 透传 ts(十创建点)+ groupEntriesByDay 日期分组纯函数(同日归组/跨日切组/跨年标签/无 ts 贴前组,4 例单测)"
```

---

### Task 5: 用户消息右胶囊 + 日期分隔渲染 + 空态构图(B3b)

**Files:**
- Modify: `gui/src/pages/Chat.tsx`、`gui/src/app.css`(会话流段)
- Test: Create `gui/src/pages/Chat.test.tsx`

**Interfaces:**
- Consumes: Task 4 `groupEntriesByDay`。
- Produces: DOM 契约——用户条 `div.entry.entry-user > div.user-bubble + div.user-actions > button.user-action[title=复制]`;分隔行 `div.chat-day-sep[role=separator]`;后续批次不得破坏这些钩子。

- [ ] **Step 1: 写渲染失败测试**

`gui/src/pages/Chat.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Chat } from './Chat';
import type { ChatSink } from './Chat';
import type { Connection } from '../../connection';

const sinkRef = { current: null as ChatSink | null };
const DAY1 = new Date(2026, 0, 10, 10).getTime();
const DAY2 = new Date(2026, 0, 11, 10).getTime();

function connOf(messages: Array<{ seq: number; ts?: number; kind: 'user' | 'assistant'; md: string }>): Connection {
  return {
    sessionSnapshot: () => Promise.resolve({ messages, status: 'idle', board: { tasks: [] }, delegations: [], team: [], pending: [], lastSeq: 0 }),
    sessionSubmit: () => Promise.resolve(),
    sessionSteer: () => Promise.resolve(),
    sessionInterrupt: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(),
    fetchDiff: () => Promise.resolve({ oldContent: '', newContent: '' }),
    replyApproval: () => Promise.resolve(),
    replyAsk: () => Promise.resolve(),
  } as unknown as Connection;
}

describe('Chat 会话流 Codex 形(B3b)', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
  });

  it('用户条目渲染右胶囊:entry-user 容器 + user-bubble 气泡 + 复制钮', async () => {
    render(<Chat conn={connOf([{ seq: 1, ts: DAY1, kind: 'user', md: '> 你好' }])} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    expect(await screen.findByText('你好')).toBeTruthy();
    const entry = document.querySelector('.entry-user')!;
    expect(entry.querySelector('.user-bubble')).toBeTruthy();
    expect(entry.querySelector('button[title="复制"]')).toBeTruthy();
  });

  it('复制钮写入剪贴板(剥 > 前缀)', async () => {
    const user = userEvent.setup();
    render(<Chat conn={connOf([{ seq: 1, ts: DAY1, kind: 'user', md: '> 你好' }])} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />);
    await user.click(await screen.findByTitle('复制'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('你好');
  });

  it('跨日条目间渲染一条居中日期分隔;同日不渲染', async () => {
    const { unmount } = render(
      <Chat conn={connOf([{ seq: 1, ts: DAY1, kind: 'user', md: '> a' }, { seq: 2, ts: DAY2, kind: 'assistant', md: 'b' }])} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />,
    );
    expect((await screen.findAllByRole('separator'))).toHaveLength(1);
    unmount();
    render(
      <Chat conn={connOf([{ seq: 1, ts: DAY1, kind: 'user', md: '> a' }, { seq: 2, ts: DAY1, kind: 'assistant', md: 'b' }])} sessionId="s1" connState="open" onBack={() => {}} sinkRef={sinkRef} />,
    );
    await screen.findByText('b');
    expect(document.querySelectorAll('.chat-day-sep')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd gui && pnpm test src/pages/Chat.test.tsx`
Expected: FAIL(user-bubble/复制钮/分隔行不存在)

- [ ] **Step 3: Chat.tsx 实现**

1. import 增:`import { Copy } from 'lucide-react';`(并入既有 lucide 行)、`import { groupEntriesByDay } from '../chat-groups';`、`import { useEffect, useRef } from 'react';`(并入既有 react 行)。
2. `ChatEntryView` 之前新增:

```tsx
/** 用户条目(Codex 形,spec §3.1):右对齐胶囊(前景 5%/8% 底)+ 下方 hover 浮现复制钮;
 *  Edit 钮不做(无会话回退功能,spec §0 非目标)。md 的 `> ` 引用形态在胶囊内平铺。 */
function UserEntryView({ entry }: { entry: ChatEntry }): JSX.Element {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const copy = (): void => {
    const text = entry.md.replace(/^> ?/gm, '');
    navigator.clipboard?.writeText(text).then(
      () => setCopied('ok'),
      () => setCopied('fail'),
    );
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied('idle'), 1500);
  };
  return (
    <div className="entry entry-user">
      <div className="user-bubble">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.md}</ReactMarkdown>
      </div>
      <div className="user-actions">
        <button type="button" className="user-action" title={copied === 'fail' ? '未复制' : '复制'} onClick={copy}>
          <Copy size={12} strokeWidth={1.75} aria-hidden="true" />
          {copied === 'ok' ? '已复制' : copied === 'fail' ? '未复制' : '复制'}
        </button>
      </div>
    </div>
  );
}
```

3. `main.chat` 内条目渲染改分组(现 `chat.entries.map(...)` 整体替换):

```tsx
{groupEntriesByDay(chat.entries).flatMap((g) => [
  g.label !== '' ? (
    <div key={`day:${g.key}`} className="chat-day-sep" role="separator" aria-label={g.label}>
      {g.label}
    </div>
  ) : null,
  ...g.entries.map((entry) =>
    entry.kind === 'tool' ? (
      <ToolEntryView
        key={entry.key}
        entry={entry}
        info={toolInfoOf(entry)}
        conn={conn}
        sessionId={sessionId}
        callId={callIdOf(entry)}
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff}
      />
    ) : entry.kind === 'user' ? (
      <UserEntryView key={entry.key} entry={entry} />
    ) : (
      <ChatEntryView key={entry.key} entry={entry} />
    ),
  ),
])}
```

4. `send()` 内 `appendUserMessage(c, text)` → `appendUserMessage(c, text, Date.now())`。
5. 删除 `ChatEntryView` 中已不可达的 user 分支样式依赖(无——ChatEntryView 保持通用,分流在上;零改)。

- [ ] **Step 4: CSS(会话流段)**

`gui/src/app.css` 的 G8f-Codex 对标段中 `.entry` 族改写/增补:

```css
/* 用户消息右胶囊(Codex 形,spec §3.1):右对齐 + 前景透明度底 + hover 下方浮现复制 */
.entry-user { display: flex; flex-direction: column; align-items: flex-end; font-weight: 400; }
.entry-user .user-bubble {
  max-width: 80%;
  background: var(--bubble-user);
  border-radius: var(--radius-composer);
  padding: 8px 12px;
}
.entry-user .user-bubble blockquote { margin: 0; padding: 0; border: none; }
.entry-user .user-actions { display: flex; gap: 4px; margin-top: 4px; opacity: 0; transition: opacity var(--dur-basic) var(--ease-enter); }
.entry-user:hover .user-actions, .entry-user:focus-within .user-actions { opacity: 1; }
.entry-user .user-action {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; border-radius: var(--radius-sm);
  color: var(--fg-tertiary); font-size: 12px;
}
.entry-user .user-action:hover { background: color-mix(in srgb, var(--fg) 8%, transparent); color: var(--fg); }
/* 日期分隔行(Codex 形:居中灰小字) */
.chat-day-sep { align-self: center; margin: 8px 0; font-size: 12px; color: var(--fg-tertiary); }
/* 会话流尺度对齐(spec §3.3):流区限宽居中 + 条目距 16px */
.chat { max-width: calc(var(--chat-max) + 2 * var(--thread-gutter)); margin: 0 auto; width: 100%; gap: 16px; }
```

(删旧 `.entry-user { border-left…font-weight:500 }` 与 `.entry-user blockquote` 旧规则。)

- [ ] **Step 5: 空态构图(Codex 形)**

`.chat-empty` 改居中:`.chat-empty-title { font-size: 22px; }`(其余已有);不改 TSX。

- [ ] **Step 6: 全量测试(修波及断言)+ 提交**

Run: `cd gui && pnpm test`
若 `App.test.tsx` 等既有用例断言 `entry-user` 内直接文本结构,按新 DOM 修(气泡内文本仍可 `getByText` 命中,预计零改;有断言 `.entry-user` 祖先含 blockquote 的改为 `.user-bubble`)。

```bash
git add gui/src/pages/Chat.tsx gui/src/pages/Chat.test.tsx gui/src/app.css
git commit -m "feat(gui): G9-Codex1:1 B3b 用户消息右对齐胶囊(hover 浮现复制,lucide Copy)+居中日期分隔行+会话流限宽 800 居中+空态构图(3 例渲染单测)"
```

---

### Task 6: 工具行/代码块/diff/审批卡浮面化(B3c)

**Files:**
- Modify: `gui/src/app.css`(工具条目/entry markdown/diff/审批卡段)

**Interfaces:** 纯 CSS;DOM 钩子不变(类名不动)。

- [ ] **Step 1: 工具折叠行裸行化**

```css
.entry-tool { background: transparent; padding: 2px 8px; border-radius: var(--radius-sm); font-size: 13px; }
.entry-tool .tool-summary { color: var(--fg-secondary); padding: 2px 6px; border-radius: var(--radius-row); font: 13px var(--font-ui); }
.entry-tool .tool-summary:hover { background: color-mix(in srgb, var(--fg) 5%, transparent); color: var(--fg); }
.entry-tool .tool-detail { border-left: 2px solid var(--border); }
.entry-tool .tool-detail, .tool-result {
  background: var(--surface-code); border: none; border-radius: var(--radius-md);
  font: 12px/1.6 var(--font-mono); padding: 8px 10px;
}
.tool-path { color: var(--accent); border-radius: var(--radius-xs); }
```

- [ ] **Step 2: markdown 与行内码**

```css
.entry p { margin: 0 0 8px; }
.entry h1, .entry h2, .entry h3, .entry h4 { font-size: 14px; line-height: 20px; font-weight: 600; margin: 12px 0 8px; }
.entry blockquote { border-left: 2px solid var(--border); color: var(--fg-secondary); padding-left: 9px; }
.entry :not(pre) > code {
  background: color-mix(in srgb, var(--fg) 8%, transparent);
  border-radius: var(--radius-xs); padding: 1px 4px; font-size: 0.92em;
}
.entry pre { background: var(--surface-code); border: none; border-radius: var(--radius-md); font: 12px/1.6 var(--font-mono); padding: 8px 10px; }
.entry th, .entry td { border-color: var(--border-subtle); }
```

- [ ] **Step 3: 审批/ask 卡浮面化**

```css
.pending-card {
  background: var(--surface-elevated);
  border: none;
  border-radius: var(--radius-xl);
  box-shadow: var(--elev-card);
  padding: 10px 12px;
}
.pending-card .card-title { font-size: 13px; font-weight: 600; }
.pending-card .approve { background: var(--ok-solid); color: #fff; border: none; border-radius: var(--radius-sm); padding: 3px 12px; }
.pending-card .approve:hover:not(:disabled) { background: color-mix(in srgb, var(--ok-solid) 88%, #fff); }
.pending-card .deny { border: none; color: var(--err); border-radius: var(--radius-sm); padding: 3px 12px; }
.pending-card .deny:hover:not(:disabled) { background: color-mix(in srgb, var(--err) 12%, transparent); }
.pending-card .always, .pending-card .primary, .pending-card button { /* ghost 缺省 */ }
.pending-card .always:hover:not(:disabled), .pending-card .primary:hover:not(:disabled),
.pending-card .card-actions button:hover:not(:disabled) { background: color-mix(in srgb, var(--fg) 8%, transparent); }
.pending-cards { border-bottom: none; max-width: calc(var(--chat-max) + 2 * var(--thread-gutter)); margin: 0 auto; width: 100%; }
```

(实现时:删旧 `.approval-card/.ask-card` 的 warn/accent 实线边规则与 approve/deny/always 三色描边;ghost 缺省规则合并为一行,禁重复声明。)

- [ ] **Step 4: DiffTab 双列对齐**

`.sx-diff-tab .diff-col`:`background: color-mix(in srgb, var(--surface) 94%, var(--fg)); border: none; border-radius: var(--radius-md); font: 12px/1.8 var(--font-mono);`(Codex diff-surface 公式);`.sx-diff-badge/.sx-diff-truncated` 保留语义色,边改 `color-mix(…12%)`。

- [ ] **Step 5: 测试 + 目检 + 提交**

Run: `cd gui && pnpm test && pnpm build`;目检工具行/审批卡/代码块。

```bash
git add gui/src/app.css
git commit -m "feat(gui): G9-Codex1:1 B3c 工具行裸行化(胶囊 hover+代码井展开)/markdown 间距与行内码对齐/审批卡浮面化(实心 ok 主钮+ghost)/diff 面 Codex 公式底色"
```

---

### Task 7: composer 浮卡与圆钮(B4)

**Files:**
- Modify: `gui/src/pages/Chat.tsx`(footer 结构)、`gui/src/app.css`(composer 段)

**Interfaces:**
- Produces: 发送/停止钮 aria-label `send`/`stop`(保留可查询性);`.composer > .message-input + .composer-foot` 结构。

- [ ] **Step 1: footer 结构改造**

`gui/src/pages/Chat.tsx` import 增 `ArrowUp, Square`(并入 lucide 行)。footer JSX 整体替换:

```tsx
<footer className="composer">
  <textarea
    aria-label="message input"
    className="message-input"
    value={input}
    rows={Math.min(6, Math.max(1, (input.match(/\n/g) ?? []).length + 1))}
    placeholder={running ? '插入运行中会话…' : '给 sunshinex 一个任务…'}
    disabled={connState !== 'open' || seeding}
    onChange={(e) => setInput(e.target.value)}
    onKeyDown={(e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        send();
      }
    }}
  />
  <div className="composer-foot">
    {running ? (
      <button type="button" className="send" aria-label="stop" title="停止" onClick={interrupt}>
        <Square size={12} strokeWidth={2.5} aria-hidden="true" />
      </button>
    ) : (
      <button type="button" className="send" aria-label="send" title="发送" onClick={send} disabled={connState !== 'open' || seeding}>
        <ArrowUp size={16} strokeWidth={2.25} aria-hidden="true" />
      </button>
    )}
  </div>
</footer>
```

- [ ] **Step 2: CSS(浮卡)**

```css
/* composer 浮卡(Codex 形,spec §4):elevated 面 + 三层海拔 + 22px 超椭圆;@supports 渐进 */
.composer {
  flex: none; display: flex; flex-direction: column; gap: 2px;
  width: calc(100% - 32px); max-width: calc(var(--chat-max) + 32px);
  margin: 0 auto var(--thread-gutter); padding: 8px 12px 8px;
  background: var(--surface-elevated);
  border-radius: var(--radius-composer);
  box-shadow: var(--elev-composer);
}
@supports (corner-shape: superellipse(1.5)) {
  .composer { corner-shape: superellipse(1.5); }
}
.composer .message-input { background: transparent; border: none; border-radius: 0; padding: 4px 4px; resize: none; min-height: 20px; line-height: 20px; }
.composer .message-input:focus { border: none; outline: none; }
.composer .message-input::placeholder { color: var(--fg-tertiary); opacity: 0.6; }
.composer-foot { display: flex; justify-content: flex-end; }
.composer .send {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0;
  border-radius: 9999px; border: none;
  background: var(--fg); color: var(--fg-on-solid);
  transition: background var(--dur-basic) var(--ease-enter);
}
.composer .send:hover:not(:disabled) { background: color-mix(in srgb, var(--fg) 88%, var(--surface)); }
.composer .send:disabled { opacity: 0.4; }
.composer .stop { /* 同 .send 类,运行中同钮位 */ }
```

(删旧 `.composer` 段与 `.composer .send/.stop` 描边规则;G8f 段 `.composer .message-input` 12px 圆规则一并删除。)

- [ ] **Step 3: 测试 + 提交**

Run: `cd gui && pnpm test`
既有用例若以文本 `Send`/`Stop` 查询该钮,改按 `aria-label` 查询(`getByRole('button', { name: 'send' })`)——逐处更新,不删测试。

```bash
git add gui/src/pages/Chat.tsx gui/src/app.css
git commit -m "feat(gui): G9-Codex1:1 B4 composer 浮卡(elevated+三层海拔+22px 超椭圆渐进+占位 60%)+28px 圆形实心发送/停止钮(↑/■,aria-label send/stop)"
```

---

### Task 8: 打磨收尾(B5)——菜单浮面/动效统一/终验

**Files:**
- Modify: `gui/src/app.css`(弹层/动效/残余段)

- [ ] **Step 1: 弹层浮面制**

`.sx-menu-pop`:`border: none; border-radius: var(--radius-2xl); box-shadow: var(--elev-prominent); backdrop-filter: blur(16px); padding: 4px;`;
`.sx-menu-pop .sx-menuitem`:`border-radius: var(--radius-lg); padding: 5px 10px;` hover 8% mix;
`.sx-toast`:`background: var(--surface-elevated); border: none; border-radius: var(--radius-xl); box-shadow: var(--elev-prominent);`;
`.dirpicker-list` 容器 `border: none; background: var(--surface-code); border-radius: var(--radius-md)`;
`.sx-theme-row`(Task 1 引入)补:`display:flex; align-items:center; gap:8px; padding: 8px 12px; color: var(--fg-secondary); font-size: 12px;` 与其 `select` 控件面(`var(--surface-soft)` 底、`--radius-sm` 圆、无边框)。

- [ ] **Step 2: 动效与 reduced-motion**

全局过渡统一:`.sx-chevron, .sx-tree-chevron { transition: transform var(--dur-basic) var(--ease-enter); }`;文件尾增:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; }
}
```

- [ ] **Step 3: 悬停叠加制收尾**

B1 遗留的 `--accent-strong` 描边悬停(若 Task 2 映射后仍有 hover 弱区分处):统一改 `color-mix(in srgb, var(--fg) 8%, transparent)` 底制;grep 门禁:`grep -nE 'accent-strong|var\(--radius\)[^,-]' gui/src/app.css` → 无输出。

- [ ] **Step 4: 视觉对拍终验**

`cd gui && pnpm dev`,对照 `docs/superpowers/specs/2026-10-08-codex-desktop-audit.md` §四 18 项差距表逐项核对(暗/亮两主题各过一遍:壳层次/侧栏胶囊/会话流/胶囊用户消息/composer/审批卡/弹层/滚动条);走 visual-judge 渲染页评审截图。

- [ ] **Step 5: 全量收口 + 提交**

Run: `cd gui && pnpm test && pnpm build`;根目录 `pnpm build`

```bash
git add gui/src/app.css
git commit -m "feat(gui): G9-Codex1:1 B5 打磨收尾(弹层浮面制+动效曲线统一+reduced-motion+悬停叠加制门禁;18 项差距对拍闭合)"
```

---

## Self-Review 记录

- **Spec 覆盖**:spec §1(Tasks 1-2)、§2(Task 3)、§3(Tasks 4-6)、§4(Task 7)、§5(Task 8)、§6 降级(@supports/主题引导/复制失败——Task 1 Step 5、Task 7 Step 2、Task 5 Step 3)、§7 测试(各任务内 + Task 8 Step 4 对拍)逐条有落点。superellipse、防 FOUC、reduced-motion 均在。
- **占位符**:无 TBD;Task 2 映射表即迁移内容本体;Task 4 Step 5 的「行号约」配合函数名定位,创建点逐一列举。
- **类型一致性**:`groupEntriesByDay(entries, now?)`/`ChatDayGroup` 在 Task 4 定义、Task 5 消费一致;`ThemePref` Task 1 定义、Task 8 复用;aria-label `send`/`stop` 与测试指引一致。
