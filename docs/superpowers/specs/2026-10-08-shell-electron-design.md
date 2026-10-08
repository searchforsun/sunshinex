# 桌面壳(Electron)设计规格——壳批次 H

- **日期**:2026-10-08
- **状态**:设计定稿 v1(H1-H4 全量交付收官)
- **来源**:用户会话既定后置项——「壳批次(后置):Tauri/Electron 选型+打包+托盘/快捷键|独立 spec 立项」(gui-v1 spec §12+ROADMAP 5B);G8 spec U-D7「真原生 webview 归壳批次」
- **关联**:`2026-10-06-gui-v1-design.md` §12 壳批次行、`2026-10-07-gui-redesign-design.md` U-D7/终局归档

## 0. 选型裁定:Electron(事实锚定)

- **主进程=Node → daemon 进程内装配**:`import { GuiDaemon } from '<dist>/serve/daemon.js'` 直跑,零 sidecar 打包面(Tauri 无 Node 运行时,须把 daemon+node_modules+node-pty 原生件打成独立发行物再 externalBin 挂靠——Windows 下 SEA/单文件打包与原生模块组合面复杂)。
- **纯 TS 仓零 Rust 工具链**:本机实测无 cargo/rustc;Tauri 需 Rust+MSVC 配对安装,构建链引入第二语言运行时。
- **node-pty 在 Electron 主进程可用**:electron-builder 自动按 Electron ABI rebuild 原生模块。
- **代价(明示)**:安装体积 ~200MB(Chromium 内嵌);开发者桌面工具口径接受。**Tauri 记为未来瘦身路径**(届时 sidecar 方案独立再评),非本批范围。
- 原生 webview 兑现口径:壳内 `window.open` 经 `setWindowOpenHandler` 开新 **BrowserWindow=原生窗口**——GUI Web 标签「外开」在壳内自动升级为原生窗(U-D7 兑现);页内 iframe 面不变(浏览器引擎即 Electron,天花板同源)。

## 1. 架构

```
shell/(pnpm workspace 新成员)
  src/main.ts        主进程入口:单实例锁→daemon 装配→BrowserWindow→托盘→快捷键→生命周期
  src/daemon.ts      GuiDaemon 进程内装配(port:0 动态+token 生成+staticRoot 指 dist-gui)+close 钩子
  src/tray.ts        托盘(显示主窗/退出)+菜单状态
  src/lib/*.ts       纯逻辑(可单测):boot 决策/appUrl 构造/菜单项归约/退出序
  build/             electron-builder 配置(NSIS+图标+extraResources 清单)
  assets/            tray.ico / icon.ico(最小图资,仓内提交)
scripts/shell-smoke.mjs   打包产物冒烟(启动→窗口→自动退出,退出码 0)
```

- **数据流**:main → GuiDaemon.start({port:0, token}) → `{port, token}` → `window.loadURL('http://127.0.0.1:<port>/?token=<token>')`(G3 既有 URL token 门面,localStorage 持久既判)。daemon 静态面 staticRoot=打包资源内 dist-gui。
- **生命周期**:关窗=隐藏驻留(托盘常驻,daemon 保持,会话/PTY 不中断);托盘「退出」=有序收口(daemon.close() 有界等待→app.quit);第二实例=聚焦既有窗(singleInstanceLock)。
- **快捷键(v1 一枚)**:`Alt+Shift+S` 全局唤起主窗(失焦/隐藏态皆可)。

## 2. 打包(electron-builder)

- win NSIS 安装器+portable 两产物;appId/productName `sunshinex`(交付实况:electron-builder 26,portable 须显式 `artifactName` 补字样,否则缺省名与 NSIS Setup 难辨且 dist-smoke 通配落空)。
- extraResources(交付实况):`app-dist/`(esbuild 双入口——主仓 dist 的 daemon.js+runtime.js 各出一件自含 CJS 束,external 仅 node-pty,ws/MCP SDK/markdown 系纯 JS 全内联)+`node-pty/` 单树(prepare-pty-resource 白名单装配,顶层恰 `lib/prebuilds/package.json/LICENSE` 四件,test/ts 源码面零携带,LICENSE=MIT 再分发随附)+`dist-gui/`(gui 纯静态 vite 产物,零 node_modules);壳主进程自身 esbuild 打单 CJS `out/main.cjs` 入 app.asar(external 仅 electron;daemon 经运行时动态 import 加载 app-dist,不进主束)。设计期「dist/ 直携」弃——运行时 require/spawn 面与 pnpm symlink 解析均不可入 asar。
- 原生模块:`npmRebuild:false`(N-API ABI 稳定零重编,H1/H2 冒烟+portable 冒烟实证)——node-pty 1.1.0 为 node-addon-api 构建,ABI 跨 Electron/Node 版本稳定;npmRebuild 走 node-gyp 全量重建(win 下慢且引入工具链依赖)故关。
- 镜像双 env 口径:`ELECTRON_MIRROR`(electron zip 本体)+`ELECTRON_BUILDER_BINARIES_MIRROR`(winCodeSign/nsis 等 builder 二进制),缺任一即有 github 直拉慢/超时面。
- 主仓根 scripts:`shell:dev`(先 build 主仓+gui,再 electron .)/`shell:dist`(全构建+electron-builder)。

## 3. 测试策略

- **纯逻辑单测**(shell/src/lib):boot 决策(锁占用/daemon 起败面)/appUrl 构造(token 注入)/托盘菜单归约/退出序状态机——vitest node 环境(shell 包自带,沿 gui 惯例)。
- **冒烟脚本** scripts/shell-smoke.mjs:dev 形态启动 electron(无头参数化 `--smoke` → main 检测旗标:窗口 once-ready-to-show 后自动退出 0;失败/超时非 0)——进 `shell:test` 门禁。
- 打包产物冒烟:手工/半自动(文档记录;NSIS 静默装+smoke 自动化后置)。
- 既有 gui e2e(19 例)不受壳影响(零 gui 改动;唯一交点=window.open 壳内行为,浏览器内既有测试口径不变)。

## 4. 批次切分(一阶段一 plan)

| 批次 | 范围 |
|---|---|
| ~~H1~~ | 壳骨架:shell 包+esbuild 主进程+daemon 进程内装配+BrowserWindow+URL token+单实例锁+shell:dev/单测+冒烟旗标——~~已交付~~ 2026-10-08(执行注记:壳骨架+daemon 进程内装配+冒烟门禁;electron ^44 内嵌 Node 24)。**已知跟进**:单实例锁被占时 smoke 假绿面(收紧判据后置)/smoke 预检未含 out/main.cjs/taskkill 失败理论挂起/@types node 双实例化妆级/H2 承接:托盘+快捷键+驻留序+原生外开 |
| ~~H2~~ | 托盘+Alt+Shift+S+关窗驻留/托盘退出序+setWindowOpenHandler 原生外开+单测——~~已交付~~ 2026-10-08(执行注记:托盘+驻留序+快捷键+原生外开)。**已知跟进**:驻留/托盘/快捷键/外开=手验指引在 SDD 报告,Playwright 自动化后置;子窗无 min 尺寸/app.exit 路径不注销[进程回收兜底];非 http 外开默认拒;file:// 面记录 |
| ~~H3~~ | electron-builder(NSIS+portable+图标+extraResources+node-pty rebuild)+shell:dist+产物冒烟脚本+文档——~~已交付~~ 2026-10-08(NSIS+portable 双产物/零 rebuild N-API 口径/portable 冒烟进门禁)。**已知跟进**:NSIS 静默装自动化后置/安装器手验指引在 SDD 报告/node-pty 整包未滤平台+自签面=发布前项/镜像双 env 本机口径 |
| ~~H4~~ | 收口门禁(主仓/gui/shell 全量+冒烟)+两 spec/ROADMAP 回写——~~已交付~~ 2026-10-08(壳收官:trimmed 重打包产物级实证+全量门禁+统一回写;门禁=主仓 1781/0+gui 245/0+e2e 19/0+shell 14/0+双冒烟 0+selfcheck OK;另清偿 H1/H3 .gitignore 增行未同步 SCAN_SKIP_DIRS 的双源漂移,G2 先例同型) |

> **缓议终局归档(不再挂任务)**:Playwright 交互自动化后置(驻留/托盘/快捷键/外开=手验指引在 SDD 报告)/NSIS 静默装自动化后置/签名证书+prebuilds 平台瘦身=发布前项/release 目录本地卫生(electron-builder 调试副产物,已忽略面外不入 git)/node-pty 升级需重 dist 且 LICENSE 大小写面(白名单按精确文件名 `LICENSE` 匹配,变体名会漏)。SCAN_SKIP_DIRS 壳三目录条目为名义对齐:perception 走访按裸名匹配,多段条目(shell/out 等)运行时不生效,构建产物仍入感知清单;段感知匹配为后续任务(既有 walker 设计缺口,非壳批引入)。

## 5. 决策记录

| # | 决策 | 放弃的替代 | 依据 |
|---|---|---|---|
| H-D1 | Electron 选型 | Tauri(未来瘦身路径记档) | daemon 进程内装配零 sidecar 面;本机无 Rust 工具链(实测);node-pty 主进程可用;体积代价桌面工具口径接受 |
| H-D2 | 关窗=驻留非退出(托盘常驻) | 关窗即退 | 会话/PTY 生命周期延续;桌面助手惯例(VS Code/Slack 同款);退出收敛到托盘单点 |
| H-D3 | daemon 进程内 import(dist 产物) | 子进程 spawn serve CLI | 单实例锁/生命周期/退出序单点;免双 token 带外交接 |
| H-D4 | 主进程 esbuild 打单 CJS+extraResources 携 dist | 全 asar 内嵌 | node-pty 原生件 asar 卸载面简化;dist 与 daemon 部署形态一致 |
| H-D5 | Web「外开」=BrowserWindow 原生窗(setWindowOpenHandler) | webview tag(废弃面) | U-D7 兑现最小面;Electron 官方弃 webview tag 口径 |
| H-D6 | 冒烟旗标自动化(`--smoke` 自动退出)替代 Playwright-electron | Playwright _electron | 建设成本/CI 无显示面;5s 退出码判据足够 v1;Playwright 后置 |
