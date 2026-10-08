# H1 壳骨架(shell 包+daemon 进程内装配+窗口+单实例+冒烟)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 依壳 spec §1/§2/H1 行:shell workspace 包+esbuild 主进程+GuiDaemon 进程内装配(port:0 动态+token)+BrowserWindow(URL token 门面)+单实例锁+shell:dev/单测/--shell-smoke 自动退冒烟。

**Architecture:** 主进程只打包 shell 自有源(esbuild→out/main.cjs);daemon 与 buildModel 经**运行时动态 import dist 产物**(dev=仓内 dist/;打包态=resources,零 daemon 树打包面、node-pty 原生件不进 bundle)。纯逻辑抽 lib 单测;冒烟=electron 启动→窗口 ready→有序退出码 0。

**Tech Stack:** Electron(新 devDep,仅 shell 包)+esbuild+vitest(node env);主仓源零改动(仅 workspace/根 scripts 两处登记)。

**Spec:** `docs/superpowers/specs/2026-10-08-shell-electron-design.md`(v1)。

## Global Constraints

- 主仓改动白名单:**仅** pnpm-workspace.yaml(packages 增 `shell`)+根 package.json(scripts 增 `shell:dev`/`shell:smoke`)——src/ 零改动;gui 零改动。shell/ 全新目录自管依赖(electron/esbuild/vitest/typescript/@types/node——devDeps 全落子包,沿 G2「主仓零依赖新增」既判)。
- daemon 装配口径(serve.ts 同源):`new GuiDaemon({ model: buildModel({}), staticRoot })`+`start({ port: 0 })`→`{port, token, close}`;staticRoot=dev 仓根 dist-gui(解析自 shell/ 上溯)。**不写 serve-token 带外文件**(token 在内存直传 URL;打印一行入口提示沿 serve 惯例)。
- appUrl 逐字:`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`。
- 单实例:`app.requestSingleInstanceLock()` 失败→`app.quit()`;second-instance→聚焦既有窗(H1 最小:show+focus;托盘驻留态 H2)。
- --shell-smoke:argv 含旗标→窗口 `once('ready-to-show')` 后有序收口(daemon.close() 有界 5s→app.exit(0));15s 总超时守卫 exit 1。
- electron 安装(postinstall 下载二进制)若超时:实现者以 timeout 600 重试一次,再败 STOP 报 BLOCKED 带输出。
- watchdog:逐任务聚焦;git add 仅点名。

## File Structure

```
pnpm-workspace.yaml            [T1] packages: [gui, shell]
package.json                   [T1] shell:dev/shell:smoke scripts
shell/package.json             [T1] name sunshinex-shell;main out/main.cjs;scripts dev/build/test/smoke
shell/tsconfig.json            [T1] module ESNext/bundled types(node+electron)
shell/esbuild.mjs              [T3] bundle src/main.ts→out/main.cjs(platform node/cjs/target node20/external 空——自有源全包)
shell/src/lib/paths.ts         [T2] resolveDaemonPaths(isPackaged, resourcesPath, devRepoRoot?)→{daemonEntry, buildModelEntry, staticRoot}
shell/src/lib/app-url.ts       [T2] appUrl(port, token)
shell/src/lib/smoke.ts         [T2] parseSmokeArgv(argv): {smoke:boolean}
shell/src/daemon.ts            [T3] startDaemon():动态 import daemonEntry/buildModelEntry→GuiDaemon 装配→start({port:0})→{port,token,close}
shell/src/main.ts              [T3] 锁→whenReady→startDaemon→BrowserWindow(1200x800,min 960x600)→loadURL(appUrl)→smoke 分支;will-quit→daemon close 兜底
shell/src/lib/*.test.ts        [T2] vitest 单测(paths/appUrl/smoke)
scripts/shell-smoke.mjs        [T4] 冒烟门禁(spawn electron . --shell-smoke,15s,退出码判)
```

---

### Task 1: workspace+shell 包骨架+依赖安装验通

**Files:** Modify pnpm-workspace.yaml+根 package.json;Create shell/package.json+shell/tsconfig.json。

**Interfaces:** Produces:`pnpm --filter sunshinex-shell …` 可用;devDeps=electron+esbuild+vitest+typescript+@types/node;scripts:dev=`electron .`/build=`node esbuild.mjs`/test=`vitest run`/smoke=`node ../../scripts/shell-smoke.mjs`(T4 落脚本);根 scripts:shell:dev=`pnpm --filter sunshinex-shell run dev`/shell:smoke 同式。

- [ ] Step 1: workspace 增 shell;shell/package.json(tsconfig:module ESNext/moduleResolution Bundler/types ["node"]/strict)。
- [ ] Step 2: `pnpm install`(workspace 联装;electron 二进制下载;timeout 600,再败 BLOCKED)。
- [ ] Step 3: 验通:`pnpm --filter sunshinex-shell exec electron --version` 输出版本号;`pnpm --filter sunshinex-shell exec tsc --version`。
- [ ] Step 4: Commit(`chore(shell): H1-T1 shell 包骨架——workspace 纳管+electron/esbuild/vitest 落装`)。

### Task 2: lib 纯逻辑+单测

**Files:** Create shell/src/lib/paths.ts+app-url.ts+smoke.ts+对应 .test.ts。

**Interfaces(T3 消费,逐字):**
```ts
// paths.ts
export interface DaemonPaths { daemonEntry: string; buildModelEntry: string; staticRoot: string }
export function resolveDaemonPaths(isPackaged: boolean, resourcesPath: string, devRepoRoot: string): DaemonPaths;
// isPackaged→resourcesPath 下 dist/serve/daemon.js+dist/runtime.js+dist-gui;dev→devRepoRoot 同构
// app-url.ts
export function appUrl(port: number, token: string): string;
// smoke.ts
export function parseSmokeArgv(argv: readonly string[]): { smoke: boolean };
```
devRepoRoot 由调用方算(shell/src 上溯两级——main.ts 内 path.resolve(app.getAppPath(),'..','..'))。

- [ ] Step 1: 失败测试(三件纯测:paths 两态/appUrl 逐字+token 编码/smoke 旗标含否定例)→ [ ] Step 2: 红 → [ ] Step 3: 实现 → [ ] Step 4: `pnpm --filter sunshinex-shell run test` 绿 → [ ] Step 5: Commit(`feat(shell): H1-T2 lib 纯逻辑——路径两态/appUrl/冒烟旗标`)。

### Task 3: daemon 装配+主进程+esbuild

**Files:** Create shell/src/daemon.ts+main.ts+esbuild.mjs。

**Interfaces:**
```ts
// daemon.ts
export interface ShellDaemon { port: number; token: string; close(): Promise<void> }
export async function startDaemon(paths: DaemonPaths): Promise<ShellDaemon>;
// const { GuiDaemon } = await import(url.pathToFileURL(paths.daemonEntry).href);
// const { buildModel } = await import(url.pathToFileURL(paths.buildModelEntry).href);
// new GuiDaemon({ model: buildModel({}), staticRoot: paths.staticRoot }).start({ port: 0 })
```
main.ts 序:锁失败 quit→whenReady→resolveDaemonPaths(app.isPackaged, process.resourcesPath, path.resolve(app.getAppPath(),'..','..'))→startDaemon(起败→dialog.showErrorBox+app.quit(1))→new BrowserWindow({width:1200,height:800,minWidth:960,minHeight:600})→loadURL(appUrl)→second-instance→win.show()+focus→smoke 分支(ready-to-show→closeDaemon 5s 有界→app.exit(0);15s setTimeout 守卫 exit 1)→will-quit→close 兜底(幂等)。
esbuild.mjs:entry src/main.ts→out/main.cjs,bundle,platform:'node',format:'cjs',target:'node20',external:[](自有源全内联;daemon 走运行时动态 import 不进 bundle——动态 import 表达式变量化即可保外置)。

- [ ] Step 1: 实现(本任务无新单测面——lib 已测;装配正确性由 T4 冒烟门禁盖)→ [ ] Step 2: `pnpm --filter sunshinex-shell run build` 出 out/main.cjs;`pnpm --filter sunshinex-shell run test` 绿 → [ ] Step 3: Commit(`feat(shell): H1-T3 主进程——daemon 进程内装配/窗口 URL token/单实例/冒烟分支`)。

### Task 4: 冒烟门禁脚本+跑通

**Files:** Create scripts/shell-smoke.mjs;前置:主仓 dist 在场(`pnpm build`)+gui dist-gui 在场(`pnpm --dir gui run build`)。

**Interfaces:** scripts/shell-smoke.mjs:spawn `pnpm --filter sunshinex-shell exec electron . --shell-smoke`(cwd 仓根;env 继承),总超时 30s,退出码 0=过/非 0 或超时=败(exit 1);stdout/stderr 透传。

- [ ] Step 1: 写脚本(先确保 dist/dist-gui 在场——脚本内不自动建,失败提示构建命令)。
- [ ] Step 2: `node scripts/shell-smoke.mjs` 红(无 out/main.cjs 时)→`pnpm --filter sunshinex-shell run build`→再跑**绿(退出码 0,窗口闪现即退)**。若 electron 起/窗口失败→依错误修 main(报告记因);再败 STOP BLOCKED。
- [ ] Step 3: Commit(`feat(shell): H1-T4 冒烟门禁——electron 启动→ready→有序退,退出码判据`)。

### Task 5: H1 收口

- [ ] Step 1: `pnpm --filter sunshinex-shell run test`+`node scripts/shell-smoke.mjs`+主仓聚焦(node --test dist/serve/daemon.test.js)+gui 一道(`pnpm --dir gui exec vitest run src/connection.test.ts`)全绿。
- [ ] Step 2: spec H1 行注记(`~~H1~~…——~~已交付~~ 2026-10-08(壳骨架+冒烟门禁)`,沿 G8 惯例)。
- [ ] Step 3: Commit(`docs(spec): H1 交付注记——壳骨架落地`)。

---

## Self-Review
1. 覆盖:spec §1 架构(进程内装配/URL token/单实例/smoke)+§3 测试(纯逻辑单测+冒烟旗标)+根 scripts=H1 行全量;托盘/快捷键/驻留/打包=H2/H3 明确不在。2. 无占位。3. 类型一致:DaemonPaths/ShellDaemon/appUrl/parseSmokeArgv 签名 T2↔T3↔T4 对齐;动态 import URL 化(ESM/Win 路径)。
