# H3 打包(electron-builder NSIS/portable+图标+资源面+产物冒烟)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 依壳 spec §2/H3 行:electron-builder win NSIS 安装器+portable 双产物;daemon 树打包态=esbuild 双入口 CJS 束(external node-pty)+node-pty 单树资源;图标仓内生成提交;portable 产物冒烟进门禁;shell:dist 全链脚本。

**Architecture:** 打包态资源布局 `resources/{app-dist/{daemon.cjs,runtime.cjs}, dist-gui/**, node_modules/node-pty/**}`;主进程 asar(out/main.cjs 既有);**node-pty 零 rebuild**——N-API ABI 稳定(H1/H2 冒烟已实证 Electron 44 宿主直用仓内预编译二进制),electron-builder npmRebuild 关闭。

**Tech Stack:** electron-builder(新 devDep,仅 shell 包)+esbuild 既有+node 生成 .ico。

**Spec:** `docs/superpowers/specs/2026-10-08-shell-electron-design.md`(v1 §2/H-D4)。

## Global Constraints

- 主仓/gui 源零改动;shell 内自由;根 package.json 仅增 `shell:dist` 一 script。
- **网络镜像口径**(沿 H1 ELECTRON_MIRROR 先例):electron-builder 二进制(nsis/winCodeSign)github 下载在本机超时——`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` **仅环境变量传,零仓内配置**;报告记录。
- 产物冒烟=portable exe `--shell-smoke` 退出码 0(spawn 直跑,超时 60s);NSIS 静默装自动化后置(记 spec 已知跟进)。
- daemon.ts 动态 import **interop 容错**:`const m = await import(...); const GuiDaemon = m.GuiDaemon ?? m.default?.GuiDaemon;`(CJS 束 cjs-lexer 形状面);buildModel 同。
- watchdog:逐任务聚焦;git add 仅点名;产物目录(release/)gitignore。

## File Structure

```
scripts/gen-shell-icon.mjs        [T1] 生成 256x256 PNG→包 ICO 壳→assets/icon.ico
shell/assets/icon.ico             [T1] 仓内提交(青色圆点·暗底圆角方)
shell/esbuild.mjs                 [T2] 增第二段:dist 双入口→build/app-dist/*.cjs(external node-pty)
shell/src/lib/paths.ts(+test)     [T2] packaged 臂改 app-dist/{daemon,runtime}.cjs
shell/src/daemon.ts               [T2] interop 容错(具名/默认回退)
shell/electron-builder.yml        [T3] appId/productName/win·nsis·portable/extraResources/files/asar/npmRebuild:false
shell/package.json                [T3] electron-builder devDep+description/author 元数据+dist script
scripts/shell-dist-smoke.mjs      [T3] portable exe 冒烟
根 package.json                   [T3] shell:dist
```

---

### Task 1: 图标资产(生成器+仓内提交)

**落点:** scripts/gen-shell-icon.mjs——纯 node 生成 256x256 PNG(暗底 #0d1117 圆角方+青色 #22d3ee 圆点,与托盘同源设计;PNG 手写 zlib/deflate 或 node:zlib)→ICO 壳(ICONDIRENTRY+PNG 帧,Windows Vista+ 支持且 electron-builder 认)→写 shell/assets/icon.ico;跑一次提交产物+生成器(可复现)。验证:文件在场+头部字节(00 00 01 00)+entry 尺寸 256(字节 0);`node scripts/gen-shell-icon.mjs` 幂等重生成 byte-identical(sha256 断言入测试?最小:生成器幂等自检打印)。Commit `feat(shell): H3-T1 应用图标——程序化生成 ICO 仓内提交(青点暗底,可复现)`。

### Task 2: daemon 树打包束+paths/interop

**落点:**
1. shell/esbuild.mjs 增段:入口 `<repoRoot>/dist/serve/daemon.js`+`<repoRoot>/dist/runtime.js`→`shell/build/app-dist/{daemon,runtime}.cjs`(bundle/platform node/format cjs/target node20/external ['node-pty'])——**以 dist 编译产物为入口**(不碰 src);`build:app` script。
2. paths.ts packaged 臂:`resourcesPath/app-dist/daemon.cjs`+`runtime.cjs`+`resourcesPath/dist-gui`(dev 臂不变);paths.test 同步两断言。
3. daemon.ts interop 容错(Constraints 口径)。
验证:shell vitest 绿;`pnpm --filter sunshinex-shell run build && pnpm --filter sunshinex-shell run build:app` 出四产物;dev 冒烟 `node scripts/shell-smoke.mjs` 仍 0(dev 臂零扰)。Commit `feat(shell): H3-T2 daemon 打包束——esbuild 双入口 CJS+node-pty 外置+paths/interop 适配`。

### Task 3: electron-builder 配置+shell:dist+产物冒烟

**落点:**
1. shell/package.json:devDep `electron-builder`(镜像环境变量仅运行时传);`description`/`author`(NSIS 元数据面)/`dist` script=`electron-builder --win`;根 `shell:dist`=`pnpm build && pnpm --dir gui run build && pnpm --filter sunshinex-shell run build && pnpm --filter sunshinex-shell run build:app && pnpm --filter sunshinex-shell run dist`。
2. shell/electron-builder.yml:appId `dev.sunshinex.app`/productName `sunshinex`;directories.output=release(入 .gitignore);files=[out/**,package.json](asar 默认);extraResources=[{from:../dist-gui,to:dist-gui},{from:./build/app-dist,to:app-dist},{from:<node-pty 实目录>,to:node_modules/node-pty}]——node-pty 实目录=dirname(require.resolve('node-pty/package.json')) 以 yml 不可求值→**由 dist script 前置生成 shell/eb-extra.json(electron-builder 支持 extraResources 从 package.json build 段?简化:electron-builder.yml 静列 `from: ../node_modules/node-pty`(pnpm workspace 根 node_modules 有 symlink→electron-builder 跟随符号链?风险)——裁定:dist script 先 `node -e` 复制 node-pty 实目录到 shell/build/node-pty(cp real dir),extraResources from ./build/node-pty(to node_modules/node-pty)——symlink 解析在脚本内 dirname(fs.realpathSync(require.resolve('node-pty/package.json'))) 完成)];win icon assets/icon.ico/target nsis+portable;npmRebuild:false(N-API 释文);nsis oneClick:false allowToChangeInstallationDirectory:true。
3. scripts/shell-dist-smoke.mjs:定位 release/ 下 portable exe(*portable*.exe,electron-builder 命名 `sunshinex X.Y.Z portable.exe`);spawn exe `--shell-smoke`(超时 60s,退出码透传)。
4. 跑通:镜像 env 下 `pnpm shell:dist`(全链,timeout 600;下载慢一次重试)→ release/ 双产物在场+`node scripts/shell-dist-smoke.mjs` **退出码 0**(打包态 daemon 束+node-pty 资源+dist-gui 静态全链实证)。
Commit `feat(shell): H3-T3 electron-builder——NSIS+portable 双产物/资源面/dist 全链/portable 冒烟`。

### Task 4: H3 收口

- [ ] 门禁:shell vitest+dev 冒烟×1+dist 冒烟×1+主仓 daemon 聚焦+gui connection(五道)。
- [ ] spec H3 行注记(`~~H3~~…——~~已交付~~ 2026-10-08(NSIS+portable 双产物/零 rebuild N-API 口径/portable 冒烟)`)+已知跟进(NSIS 酒静默装自动化后置/安装器手验指引入 SDD 报告/node-pty 版本锁升级面[资源随仓 node_modules 取,升 node-pty 需重 dist]/镜像 env 本机口径)。
- [ ] Commit `docs(spec): H3 交付注记——打包落地`。

---

## Self-Review
1. 覆盖:spec §2 全项(双产物/appId/extraResources 三资源/asar 主进程/npmRebuild=false=N-API 释文)/图标/H1 跟进「smoke 预检 out/main.cjs」——**T3 顺手**:shell-smoke.mjs 预检补 out/main.cjs(shell 脚本小改,入 T3 文件面)。2. 无占位(symlink 解析路径已裁定脚本内 realpath)。3. 类型一致:paths packaged 臂↔eb 资源布局↔dist-smoke 定位口径对齐。
