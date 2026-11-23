# 桌面壳(Electron)设计规格——壳批次 H

- **日期**:2026-10-08
- **状态**:已实施交付（2026-11-23 D83 批二状态回写核证：CLAUDE.md §3 shell/ 条目与 §13「GUI 桌面壳 Electron 已引入」+ MANUAL-GUI.md §安装/启动与退出现行口径；shell/src（main/daemon/preload）与 electron-builder.yml 在座；原状态行留档：「- **状态**:设计定稿 v1(H1-H4 全量交付收官)」）
- **来源**:用户会话既定后置项——「壳批次(后置):Tauri/Electron 选型+打包+托盘/快捷键|独立 spec 立项」(gui-v1 spec §12+ROADMAP 5B);G8 spec U-D7「真原生 webview 归壳批次」
- **关联**:`2026-10-06-gui-v1-design.md` §12 壳批次行、`2026-10-07-gui-redesign-design.md` U-D7/终局归档
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 选型裁定 Electron（对照 Tauri 事实锚定）：主进程=Node 使 daemon 进程内装配零 sidecar 打包面、纯 TS 仓不引入 Rust 工具链、node-pty 原生件主进程可用；代价 ~200MB 安装体积明示接受，Tauri 记为未来瘦身路径（届时独立再评）。
- H1-H4 四批同日交付收官：壳骨架（单实例锁+daemon 进程内装配+URL token 门+BrowserWindow）、托盘常驻+`Alt+Shift+S` 全局唤起+关窗驻留（会话/PTY 不中断，退出收敛托盘单点）+`window.open` 升级原生窗（G8「真原生 webview 归壳批次」兑现）、electron-builder NSIS+portable 双产物打包、全量门禁收口（主仓/gui/e2e/shell/双冒烟全绿）。
- 打包关键取舍：壳主进程 esbuild 单 CJS 入 asar + extraResources 携自含束与纯静态前端产物；原生模块零重编（N-API ABI 跨版本稳定，`npmRebuild:false` 实证）——「dist 直携」与全 asar 内嵌两替代方案均否决（运行时 require 面与原生件卸载面不可入 asar）。
- 冒烟自动化以 `--smoke` 旗标（窗口 ready 后自动退出、退出码判过）替代 Playwright-electron 进门禁；交互自动化/NSIS 静默装/签名证书与 prebuilds 平台瘦身登记缓议终局归档（不再挂任务）或发布前项。

## 现行真值

CLAUDE.md §2 常用命令（桌面端部署与重装、壳链铁律、打包输出恒 shell/release）；CLAUDE.md §3 目录结构（shell/ 工作区包条目）；CLAUDE.md §13 组件选型表（GUI 桌面壳 Electron 与壳工程化 esbuild+electron-builder）。
