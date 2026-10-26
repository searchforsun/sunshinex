# computer-use — sunshinex 内置插件（桌面操作）

自建 MCP server（`node` stdio 直启，零原生 npm 依赖）驱动的 Windows 桌面自动化：**Node 协议面 + 持久 PowerShell worker 执行器**。观察以结构化 UIA 元素清单（`uia_snapshot`）为主线、截屏（`screenshot`）兜底；动作走 SendInput 键鼠注入（`mcp__computer-use__*` 工具族）。worker 为系统自带 `powershell.exe`（PS 5.1 兼容脚本经环境变量注入，不落盘、不触执行策略），目标机**无需额外安装运行时之外的东西**。

## 缺省与启用

- 缺省**未启用**（`defaultEnabled: false`）且 `platforms: ["win32"]`（非 Windows 平台设置页自动置灰）：settings 语义键 `plugins.computer-use.enabled: true` 后生效。
- 插件目录是 pnpm workspace 包：目标机首次启用前需补装 server 依赖（MCP sdk）——`pnpm --dir plugins/computer-use install`（开发机随 workspace `pnpm install` 已就位）。连接失败走装配警告单降级，不 crash。

## 工具面与安全三类（safety）

manifest 声明三类（spec §2.2 manifest 字段表 safety 声明，§2.4 声明式安全契约，guard 通用消费，无 server 名特判）：

| safety 类 | 工具 | guard 行为 |
| --- | --- | --- |
| `observe`（只读） | `uia_snapshot`、`window_list` | 三档直放（deny 规则仍最先） |
| `confirm`（硬确认） | `screenshot` | 通用 ask 面 + 会话级 always（一次放行全会话） |
| `act`（直接执行） | `click`、`type`、`key`、`scroll`、`drag`、`app` | **任何档位强制 ask，full-access 不豁免**（可被会话显式 always 豁免） |
| （未声明） | `wait`、`wait_for` | 走通用 MCP 审批行为（fail-closed 兜底；纯延时/轮询无直接 IO 副作用） |

`app` 两动作（launch=开始菜单名或可执行路径拉起进程、focus=按标题子串把已有窗口置前台）——launch 即启动任意程序（ShellExecute 语义），属直接执行类故入 act。桌面操作步步落在真实用户环境上，act 恒问线是有意为之：**免审批 ≠ 免问线**。

## 已知边界

- **UIPI / 完整性级别**：worker 以非提权运行，对管理员（提权）窗口的键鼠注入与 UIA 读取受 Windows UIPI 限制——输入可能静默无效、UIA 读取受限（UAC 安全桌面场景 SendInput 送达数校验会显式报错，不静默谎报成功）。
- **DPI 感知已处理**：截屏与坐标全在物理像素域（VirtualScreen 原点/尺寸 + 缩放置账），模型坐标以**最近一次截图回传的 `scale` 元数据**为基准反算，高 DPI 缩放下无需用户干预。
- **`wait_for` 为元素 Name 级**：UIA 轮询按元素 Name 子串匹配——窗口正文若不进 UIA Name（如打包版 Notepad 的编辑区），正文级等待需改用可变 Name 元素（TabItem 标题脏态等）或截图比对兜底。
- **`display` 参数 not implemented**：多显示器选择显式报错（诚实面），全屏/虚拟屏全域截屏可用，区域用 `region` 物理像素四元组表达。
- **uia_snapshot desktop scope 为顶层概览**：只列桌面顶层元素（窗口级），控件级请切 `scope:"window"`。

## config（v1 后置项）

`config.worker`（PowerShell 可执行名，缺省 `powershell.exe`）**接线后置**：当前 server 主入口固定 `createWorker()` 缺省参数拉起 `powershell.exe`，config 值尚无透传通道——manifest 未声明该 configSchema 键，勿配置（配了也不生效）。接线后本节同步更新。

## 隐私注记

- **截图绕过文本脱敏**：`screenshot` 回流的是整屏位图，屏幕上显示的一切（含密码框外的敏感文本、聊天记录）都原样进模型上下文，文本脱敏链覆盖不到；confirm 类每次确认 + 会话 always 即用户对这一面的显式授权。
- **屏幕文字 = 注入载体**：屏幕/窗口内渲染的任何文字（网页、文档、弹窗）都可能进模型上下文构成 prompt injection 面；兜底即 act 类强制审批——即使模型被诱导，键鼠动作每次仍需真人放行。
- 截图经压缩回传（长边 1568px / JPEG q0.85）；历史图片按 settings `imageHistoryLimit`（缺省 3）渲染期剪枝，journal 全量留档。

详细使用文档见 MANUAL.md 插件章节；技能教程见随附 `skills/desktop-automation/`（先观察后动作的标准循环与坐标基准教学）；插件开发规范见 PLUGIN-DEV.md。
