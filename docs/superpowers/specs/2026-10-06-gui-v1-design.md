# 5B GUI v1 设计规格(daemon + Web UI)

- **日期**:2026-10-06
- **状态**:已实施交付（2026-11-23 D83 批二状态回写核证：MANUAL.md CLI 命令表 sunshinex serve 行 + MANUAL-GUI.md 全册现行口径 + src/serve/daemon.ts 与 gui/ 工作区包在座；原状态行留档：「- **状态**:设计定稿,待评审,未实施」）
- **来源**:设计对话(三假设经用户「继续」放行:壳路线 daemon+Web 先行 / 协议 SessionEvent 直通 / 看板并入 v1)
- **关联**:`docs/ROADMAP.md`(阶段五 5B)、`docs/superpowers/specs/2026-10-04-multi-agent-orchestration-design.md`(§10.4 GUI 投影三边界、§13 P3)、`src/tui/runtime.ts:44-46`(daemon 接缝预留注释)
- **定位**:ROADMAP 5B「GUI 设计规格(复用 SessionEvents 事件面与 asker 契约,三面同源)」的正式落地件;编排 spec P3 的验收载体
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 交付 GUI v1 全链（G1–G7 五批 + 壳批次）：`sunshinex serve` daemon + 浏览器工作台——对话页（流式/提交/中断/steer）、审批与问询卡、任务看板（列表/DAG 双视图 + gate 审批 + teammate 侧栏，编排 spec P3 验收逐条兑现）、代码预览与 write diff；后接 Electron 桌面壳（托盘驻留/全局快捷键/NSIS 打包）交付。
- 会话中心模型（2026-10-06 用户修正、对标 Codex，推翻 v1 单会话裁定）：应用为入口、会话为中心、工作目录是会话属性；同 root 多会话并存，`--root` 降级为启动预选。
- 关键取舍「三面同源第四面」：协议 = SessionEvent 原样直通 + 既有 asker/审批接缝序列化，零 GUI 专用中间事件词汇；问询/审批走 WS 封装帧而不造新事件类型；GUI 增补需求一律先回事件面/接缝层评审（TUI 免费受益）。
- 投影复用取舍：看板/委派复用主仓纯函数投影直接跑浏览器，chat 投影新建；不复用 TuiState/预渲染 ANSI——渲染债不跨端，TUI 与 GUI 并行维护、共享到事件面为止。
- 依赖克制与安全面：主仓仅新增 ws（零传递依赖），WS 单向下行 + HTTP 全控制面（控制面可缓存可测）；回环绑定 + token 鉴权，无远程暴露。
- 迁移语义裁定（G-D10）：GUI/TUI = 同一事件流两个投影，交互美学参照 Codex 工作台；迁移 = 跨时间自由切换（同工作区交替使用、板/teams/journal 数据同源），非同时双开。

## 现行真值

MANUAL-GUI.md 全册（GUI 现行使用口径）；CLAUDE.md §13 交互面构建规范（GUI 组件选型登记与架构边界）、§2 常用命令（serve / gui:build / 桌面端部署与重装）。
