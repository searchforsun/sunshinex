# SunshineX GUI 使用手册（桌面壳 + 浏览器）

图形界面里的 AI Agent：与 TUI（见 [MANUAL.md](MANUAL.md)）共用同一引擎与会话体系——同一 daemon、同一审批链、同一任务看板；GUI 提供项目分组会话管理、多标签工作区（文件 / Diff / 任务 / 子代理 / 终端 / Web）、设置页与桌面体验（托盘常驻、全局快捷键）。

要求：Windows x64（桌面壳）；浏览器模式任意现代浏览器。会话数据与 TUI 完全互通（同一 dataDir/journal 体系）。

---

## 一、版本管理与安装包（与 TUI 一个版本、不同安装包）

**版本单源**：全仓唯一版本号在根 `package.json`（当前 **0.3.1**）。TUI 与 GUI 的所有发行物共享同一版本 tag：

| 通道 | 安装包 | 获取 |
|---|---|---|
| TUI（CLI+终端界面） | `sunshinex-agent-<ver>.tgz`（npm 包） | GitHub Releases（安装命令见 [MANUAL.md](MANUAL.md)） |
| GUI 桌面 | `sunshinex Setup <ver>.exe`（安装器）+ `sunshinex <ver> portable.exe`（免安装单文件） | GitHub Releases / 本地 `pnpm shell:dist` 构建 |

子包版本（gui/shell）由 `pnpm run version:sync` 从根同步（`--check` 校验漂移，`shell:dist` 构建链首自动同步——**产物版本不可能落后于 TUI**）。升版本只改根 `package.json`，重跑 `pnpm shell:dist` 即出同版本 GUI 安装包。

## 二、安装与启动

**① 桌面 App（推荐）**

- **portable**：`sunshinex <ver> portable.exe` 双击即用（单文件约 117MB，自包含引擎+界面；放任意目录）。
- **Setup**：`sunshinex Setup <ver>.exe` 安装（可选安装目录；开始菜单/桌面快捷方式）。
- 启动后自动拉起内置服务并打开主窗——**无需手动输入 token**。关闭窗口=驻留托盘（会话与终端不中断）；托盘右键「退出」才真正收口；`Alt+Shift+S` 随时全局唤起。

**② 浏览器模式**

```bash
pnpm run gui:build        # 一次性：编译引擎 + GUI 静态产物
pnpm serve                # 起服务，打印 http://127.0.0.1:7788 与 token
```

浏览器打开打印的地址，按提示输入 token（URL 带 `?token=` 时自动登录并记住）。

**③ 开发模式**

```bash
pnpm serve                          # 终端 1：服务
pnpm --dir gui dev                  # 终端 2：GUI 热更（直连 7788）
```

**从源码构建安装包**

```bash
pnpm shell:dist     # 全链：版本同步→引擎→GUI→壳→双安装包，产物在 shell/release/
```

> 本机网络受限时需双镜像环境变量（仅环境传入，不进仓配）：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 与 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。构建失败提示里会打印同款命令。

**发版到 GitHub（维护者，与 TUI 同一流程）**：`node scripts/release.mjs [--bump patch|--version X.Y.Z]` —— 同一 Release 同一 tag 上传**三类安装包**（TUI tgz + GUI Setup/portable exe）；版本落库时自动同步子包、验证链含 GUI/e2e/壳冒烟、安装包过产物级冒烟再上传。`--no-gui` 只发 TUI；`--dry-run` 轻量预览附件与链接；同版本重发加 `--clobber`。用法详见脚本 `--help` 与 README 发版段。

## 三、界面总览（三栏）

```
┌────────────┬──────────────────────────┬──────────────┐
│ 项目分组菜单 │  Chat 主区                 │ 多标签工作区   │
│ 工作区=项目  │  消息流（write 条目可开 Diff）│ 目录 文件 Diff │
│ 组内会话列表 │  审批/问询卡                │ 任务 Agents   │
│ +新建/添加   │  输入区（1-6 行自增高）      │ 终端 Web      │
│ 连接态+设置  │                           │ 「+」新开标签  │
└────────────┴──────────────────────────┴──────────────┘
```

- **左栏**：一个项目一个工作区组；组头点击展开/收起（惰加载会话列表）；组内「+」新建会话（目录自动预填该项目，仅选 自动/手动 审批）；底部「+ 添加工作区」选新项目根；⚙ 设置入口。
- **中栏**：对话主区。Enter 发送、Shift+Enter 换行；流式回复带闪烁光标；write 工具条目的路径按钮点击 → 右栏开 **Diff 标签**。
- **右栏**：标签页工作区（可同时开任意多页），「+」菜单按类型新开；「≫」折叠整栏；拖拽左边框调宽（200–720px）。标签态**每会话独立**，新会话默认开「任务」页。

## 四、会话

- **新建**：左栏组内「+」（该项目 root 预填）或「+ 添加工作区」走目录选择器（含 自定义路径 / 手动审批 勾选）。
- **恢复**：会话列表点 **Attach**——从 journal 播种历史（与 TUI `/resume` 同源）。
- **删除**：会话内顶栏 Delete（运行中 409 先停再删；journal 磁盘档案保留）。
- **切换**：左栏点会话行；各会话标签页/看板投影互不串扰。

## 五、右栏标签（七类，「+」可扩展）

| 标签 | 用途 | 要点 |
|---|---|---|
| **目录** | 工作区文件树 | 逐层展开；点文件 → 开「文件」标签；默认忽略 `.git`/`node_modules`/`dist*` |
| **文件** | 只读预览 | 路径输入+语法高亮；越界拒；>512KB 截断横幅；同路径重开=聚焦 |
| **Diff** | write 变更对比 | 双列（pre/post）；新建写单列；按 callId 多实例；环裁后 404 提示 |
| **任务** | TaskBoard 看板 | List/DAG 双视图；gated 任务行内 Approve/Deny；teammate 侧栏忙点 |
| **Agents** | 子代理活动 | 每委派一卡（状态/tokens/当前工具）；点卡展开最近 20 行迷你转录；live 事件流 |
| **终端** | 真 PTY 交互终端 | PowerShell（Windows）；**你直打，不经审批链**；切标签/断线重连恢复屏幕；关标签=终止进程 |
| **Web** | 页面查看 | URL 栏+沙盒 iframe；「外开」在桌面壳=原生新窗口；外站受 X-Frame 限制属预期 |

## 六、设置页（左栏 ⚙）

设置态：左栏变设置导航，主区显示面板，右栏隐藏；「← 返回」回会话。**顶部项目选择器**决定「项目级」面编辑的目标（仅全局=不选项目）。

**十面板**：通用 / 模型与提供方 / 插件：技能·MCP·智能体 / 上下文与限额 / 记忆 / 权限 / 知识库与搜索 / 高级。

- **生效语义（重要）**：保存即写盘并热重载——**新建会话即刻生效**；运行中会话不回改；真环境变量覆盖的键标橙色「env」徽标且禁编（改文件不生效）。每次保存后行内提示「已生效：新建会话起」。
- **来源徽标**：橙 env（真环境变量）/ 蓝 项目（`<项目>/.sunshinex/settings.json`）/ 灰 全局（`~/.sunshinex/settings.json`）/ 无=缺省。
- **MCP 面板**：两级清单（项目遮蔽全局灰显）；「测试连接」单台真探测（返回注册工具数或失败原因）；增删改写项目 mcp.json。
- **智能体（子代理定义）**：内建四角色+目录注册（项目 `<root>/agents/<id>/agent.md` 与全局 `~/.sunshinex/agents/` 两级，项目遮蔽全局）；表单增删改带写前校验。
- **高级**：settings.json / mcp.json **JSONC 原文编辑**（保注释；服务端验证拒存畸形；未知/退役键告警列表透出）。

## 七、审批与问询（手动模式）

manual 会话中写文件/执行命令挂起 → 消息流上方出现 **审批卡**（Allow/Deny）或 **问询卡**（选项/文本）；断线重连卡片自动恢复。与 TUI 审批链同源（回执互认）。

## 八、快捷键

| 键 | 作用域 | 动作 |
|---|---|---|
| `Alt+Shift+S` | 全局（桌面壳） | 唤起主窗（隐藏/失焦皆可） |
| `Alt+W` | 应用内 | 关当前右栏标签 |
| `Ctrl+Alt+←/→` | 应用内 | 切换右栏标签 |
| `Esc` | 应用内 | 折叠右栏 / 退出设置态 |

## 九、生命周期与数据

- **桌面壳**：关窗=托盘驻留（daemon/会话/PTY 存活）；托盘「退出」有序收口（在跑任务中止→资源清理）。
- **数据位置**：与 TUI 一致按项目 root 派生（`workspace.json` 注册表发现）；浏览器模式的连接票据在 `<dataDir>/serve-token`。
- **主题**：青色暗色（#22d3ee 主色）；亮色主题未上线。

## 十、常见问题

| 现象 | 处置 |
|---|---|
| 启动提示构建产物缺失 | 跑 `pnpm run gui:build`（浏览器）或重跑 `pnpm shell:dist`（壳） |
| 端口被占 | serve 已有实例时换端口或先停旧例（`serve-token` 内含 pid） |
| 安装包构建下载超时 | 双镜像 env（见 二·构建） |
| 终端里命令行为怪 | Windows 下是 PowerShell 语义；免审批是你的直打权限，别当 agent 执行链 |
| Web 标签外站空白 | 站点拒嵌（X-Frame-Options）；点「外开」（壳内=原生窗口） |
| Diff 打不开 | 事件环已裁（>512 事件）——条目里直接看 write 内容，或重跑该写 |
| 浏览器里没有托盘/全局键 | 桌面壳专属能力；浏览器模式用标签页常开替代 |
| 版本对不上 | `pnpm run version:sync` 对齐（`--check` 校验） |

## 十一、开发与验证（贡献者）

```bash
pnpm --filter sunshinex-shell run test   # 壳单测
node scripts/shell-smoke.mjs             # 开发态冒烟（启动→就绪→自动退，退出码判）
node scripts/shell-dist-smoke.mjs        # 安装包冒烟（portable exe 同判据）
pnpm --dir gui test && pnpm --dir gui run test:e2e   # GUI 全量+端到端
```

**协议面（浏览器/集成开发者）**：HTTP 同端口承载 API+静态；鉴权 `Authorization: Bearer <token>` 或 WS subprotocol `bearer.<token>`（浏览器路径）；WS 连接即补发缓冲帧（近 512）此后实时推送；会话维端点 `/session/:id/*`（submit/steer/interrupt/reset/snapshot/attach/file/diff/tree/pty/board-review 等），设置端点族 `/settings*`；帧协议详 `docs/superpowers/specs/`（G1/G3/G8 系列）。

已知跟进（终局归档见壳 spec）：NSIS 静默装自动化、Playwright 交互自动化、签名证书与跨平台 prebuilds 瘦身为发布前项。

---

架构与设计文档：`docs/superpowers/specs/`（gui-v1 / gui-redesign / shell-electron）；CLI/TUI 用法：[MANUAL.md](MANUAL.md)；工程总览：[README.md](README.md)。
