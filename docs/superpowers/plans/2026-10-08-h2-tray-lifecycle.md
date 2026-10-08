# H2 托盘+快捷键+驻留/退出序+原生外开 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 依壳 spec §1 生命周期/H2 行:托盘(显示主窗/退出)+关窗驻留(会话/PTY 不中断)+托盘退出有序收口+`Alt+Shift+S` 全局唤起+`setWindowOpenHandler` 原生外开(U-D7 兑现)+second-instance 破窗守卫。

**Architecture:** 纯逻辑抽 lib(lifecycle 归约/托盘菜单/退出序)单测;main 接线侧效果;托盘图标=内嵌 16x16 青色 PNG data URL(免二进制资产,主题同源;H3 打包再落 .ico)。

**Tech Stack:** 全既有(electron 44/esbuild/vitest)。

**Spec:** `docs/superpowers/specs/2026-10-08-shell-electron-design.md`(v1 §1 生命周期/H-D2/H-D5+H1 行已知跟进)。

## Global Constraints

- 主仓/gui 零改动;shell 内:lib 新文件+main.ts 接线+esbuild 不动。
- 驻留序(H-D2):关窗=preventDefault+hide(quitting=false 时);`before-quit` 置 quitting;托盘「退出」→quitting→daemon close 5s 有界→app.quit()。
- 退出序收敛单点 `runQuit()`(幂等守卫,smoke/托盘/信号共用——will-quit 兜底保底)。
- 快捷键:`Alt+Shift+S`(globalShortcut,will-quit 注销)→win 存在则 show+focus(隐藏/最小化皆唤起),破窗(null/isDestroyed)守卫同 second-instance。
- 原生外开(H-D5):主窗 `setWindowOpenHandler`→`{action:'allow',overrideBrowserWindowOptions:{width:1100,height:800}}` 新原生窗;外开窗同走 daemon 域(相对 URL 同源);http(s) 外站同原生窗。
- 托盘:menu=「显示 sunshinex」(show+focus)/「退出」(runQuit);icon=nativeImage.createFromDataURL 内嵌 PNG;tray.setToolTip('sunshinex')。
- watchdog:逐任务聚焦;git add 仅点名。

## File Structure

```
shell/src/lib/lifecycle.ts        [T1] shouldHideOnClose/trayMenu/quit 顺序面
shell/src/lib/lifecycle.test.ts   [T1]
shell/src/lib/tray-icon.ts        [T2] 内嵌 16x16 PNG data URL(青色 #22d3ee 圆点)
shell/src/main.ts                 [T2/T3] 驻留序+托盘+runQuit 单点/快捷键+外开+破窗守卫
```

---

### Task 1: lifecycle 纯逻辑+单测

**Interfaces(T2/T3 消费):**
```ts
// shell/src/lib/lifecycle.ts
export function shouldHideOnClose(quitting: boolean): boolean;
export interface TrayMenuItem { id: 'show' | 'quit'; label: string; enabled: boolean }
export function trayMenu(quitting: boolean): TrayMenuItem[];   // 显示 sunshinex/退出;quitting 时全 disabled(收口中)
export const QUIT_STEPS = ['daemon-close', 'app-quit'] as const;  // 顺序面(文档性常量+测试锁)
```
测试:shouldHide 双态;trayMenu 两态(含 label 文本);QUIT_STEPS 冻结。TDD 红→绿;`pnpm --filter sunshinex-shell run test` 绿。Commit `feat(shell): H2-T1 lifecycle 纯逻辑——驻留判定/托盘菜单/退出序面`。

### Task 2: 驻留序+托盘+runQuit 单点

**Files:** Modify shell/src/main.ts;Create shell/src/lib/tray-icon.ts。

落点:①`let quitting=false; const runQuit=()=>{if(quitting)return;quitting=true;void closeDaemonBounded().finally(()=>app.quit())}`(closeDaemonBounded=daemon.close 5s race,沿 smoke 收口同款;will-quit 兜底改调 runQuit 语义——幂等)②win `close` 事件:`if(shouldHideOnClose(quitting)){e.preventDefault();win.hide()}`③托盘:nativeImage 内嵌 PNG+menu(「显示 sunshinex」→win 守卫 show+focus;「退出」→runQuit)+tooltip;tray 变量持引用防 GC④`before-quit` 若非 runQuit 路径(如系统关机)置 quitting⑤smoke 分支不变(runQuit 复用)。
验证:build+vitest+`node scripts/shell-smoke.mjs`(退出码 0——smoke 走 ready 即退,不触驻留面);**驻留/托盘交互=开发态手验指引一段入报告**(自动化后置:锁+窗口面无 jsdom)。
Commit `feat(shell): H2-T2 托盘+驻留序——关窗隐藏/托盘显示·退出/退出序单点幂等`。

### Task 3: 快捷键+原生外开+破窗守卫

**Files:** Modify shell/src/main.ts。

落点:①`globalShortcut.register('Alt+Shift+S', focusMain)`;focusMain=win 守卫(null/isDestroyed→无窗则不造,日志一行)show+focus;`will-quit`→`globalShortcut.unregisterAll()`②主窗 `webContents.setWindowOpenHandler(()=>({action:'allow',overrideBrowserWindowOptions:{width:1100,height:800}}))`——Web 标签「外开」(window.open)/target=_blank 链接皆原生新窗;新窗同 session 默认(同 daemon 域 cookie/localStorage——token 持久面沿 G3)③second-instance 与 focusMain 共用 `focusMain()` 守卫版(H1 已知跟进清偿)。
验证:同 T2(smoke 0);手验指引(快捷键唤起/外开原生窗)入报告。
Commit `feat(shell): H2-T3 快捷键+原生外开——Alt+Shift+S 唤起/window.open 原生窗/破窗守卫`。

### Task 4: H2 收口

- [ ] 门禁:shell vitest+smoke×2+主仓 daemon 聚焦+gui connection(沿 H1-T5 四道)。
- [ ] spec H2 行注记(`~~H2~~…——~~已交付~~ 2026-10-08(托盘+驻留序+快捷键+原生外开)`)+已知跟进(驻留/托盘/快捷键/外开交互自动化面=手工冒烟指引在报告,Playwright 后置;smoke 预检 out/main.cjs 未补——收 H3 打包面)。
- [ ] Commit `docs(spec): H2 交付注记——托盘驻留序快捷键外开落地`。

---

## Self-Review
1. 覆盖:spec §1 生命周期(H-D2)/托盘/快捷键/原生外开(H-D5)/H1 已知跟进破窗守卫=全;打包面=H3 明确不在。2. 无占位(手验指引=显式交付物非 TBD)。3. 类型一致:TrayMenuItem/QUIT_STEPS/focusMain 守卫版 T1↔T2↔T3 对齐。
