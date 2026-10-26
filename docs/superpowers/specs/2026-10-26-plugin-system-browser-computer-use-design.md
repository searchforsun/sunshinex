# 插件体系 + browser use / computer use 系统插件设计（工具结果图片通道前置）

- 日期：2026-10-26
- 状态：设计待用户评审（brainstorming 产出；方向裁定=用户：立插件体系、两能力作为系统自带插件、设置页可开关；未答细节按本 spec 缺省裁定，评审可翻）
- 范围：src/config（plugins 语义键）、src/harness（插件装配 + MCP 客户端图片提取 + guard 声明式安全消费）、src/types（ExecResult.images 等）、src/serve（设置端点）、gui（设置页插件 pane + 工具行图片渲染）、plugins/（新工作区目录：两个内置插件，其一含自建 MCP server）+ plugins/schema（manifest JSON Schema）+ plugins CLI（list/validate）+ docs/PLUGIN-DEV.md（插件开发指南）
- 前置关系：图片功能（2026-10-26 已交付）打通了**用户随行图片**全链（`src/images.ts` 单源 → `SteerLine/SessionEvent/HistoryStep.images` → `buildMessages` 多模态 user 行 → wire image_url 块）；本设计补全**工具观察图片回流**这半边（截屏能力的生命线），并以「插件」为治理层承载 browser use / computer use 两个能力。
- 业界调研锚点（2026-10-26 三路调研，详见会话记录）：浏览器自动化事实标准 = Playwright MCP（a11y snapshot+ref 主线，vision 兜底）；桌面自动化收敛动作面（screenshot/click/type/key/scroll/drag/wait）；结构优先、视觉兜底为工程共识；OpenAI 兼容协议 `role:"tool"` 消息无图片通道，业界标准变通 = 图片随合成 user 帧注入（与既有链行图片通道同形）；高危桌面动作业界共识 = 默认人工确认 + 能力默认关。

## 1. 决策记录与方案选型

**用户裁定（2026-10-26）**：

1. 不做游离的「托管 MCP 配置」，立**插件体系**：browser use / computer use 作为**系统自带插件**（bundled plugins）。
2. 设置页新增**插件配置**，两能力可关闭/启用。
3. 「优化当前的插件系统」落地为：现分散的扩展机制（内置工具 / mcp.json / 技能）语义不变，**其上叠加统一治理层**。
4. 插件层按**开发者可参与的标准**建设（2026-10-26 二次裁定）：manifest 规范化（版本化 schema、校验与清单 CLI、JSON Schema artifact）+ 插件开发指南文档（`docs/PLUGIN-DEV.md`）——第三方与用户可自由开发更多插件，内置两插件只是框架的首批消费者与实例解构。

**方案对比**：

| 方案 | 形态 | 取舍 |
|------|------|------|
| **A. 插件=治理/分发层（选定）** | 插件贡献 mcpServers + skills + 开关 + 设置面；能力后端仍是进程外 MCP server | 治理与执行分离，贴合「单一数据流、动作只从 Tool 出、必经安全链」；进程隔离天然；框架由两插件即首批消费者验证 |
| B. 插件=进程内原生工具加载器 | 插件 TS 模块动态 import 注册 harness 工具 | 能力进 harness 进程：无隔离、Landlock/安全链根基被绕开面扩大、动态加载与打包复杂度高——否 |
| C. 无插件层，mcp.json 预置 + settings 硬编码开关 | 最省 | 「插件」不成立，第三/四个能力无挂靠点，设置页无统一面——否 |

**缺省裁定（用户评审可翻）**：两插件 `defaultEnabled` 均为 **false**（能力显式 opt-in，规则无例外）；computer use v1 **Windows 先行**；computer-use server v1 **零原生依赖**（持久 PowerShell worker），后续可换原生实现而动作面不变。

## 2. 插件框架

### 2.1 插件形态与目录布局（标准）

插件 = 一个目录 + `plugin.json` + 附带资源。标准目录布局：

```text
<plugin-id>/
  plugin.json     # 必需：manifest（§2.2）
  README.md       # 可选：设置页详情/文档入口
  skills/         # 可选：贡献技能（SKILL.md 目录，与主仓技能同规范）
  …               # 后端实现物位置自由（server 源码/构建产物/指向外部命令均可）
```

两处装载根：

- **内置**：`<repo>/plugins/<id>/plugin.json`（随包分发；pnpm 工作区新目录，与 gui/shell 平级）
- **用户级**：`~/.sunshinex/plugins/<id>/plugin.json`（同格式）。v1 无市场、无 install 命令：**安装 = 把目录放进该根，卸载 = 删除**；`skills install` 式分发后置。

### 2.2 manifest 规范（manifestVersion 1）

顶层 **`manifestVersion: 1`** 为前向兼容锚：同 major 更高 minor 接受并告警；未知 major 拒载并告警。字段表：

| 字段 | 必填 | 约束 |
|------|------|------|
| `manifestVersion` | 是 | `1` |
| `id` | 是 | `^[a-z0-9]+(-[a-z0-9]+)*$`（与技能 id 同规范）；须等于目录名，不符告警 |
| `name` / `version` / `description` | 是 | version 走 semver 口径（展示与排序用） |
| `platforms` | 否 | `process.platform` 值数组；缺省全平台，不匹配 = 不可用（设置页置灰） |
| `defaultEnabled` | 否 | 缺省 `false`；仅 settings 未配置时初值 |
| `mcpServers` | 否 | 键 = server 名，值 = `McpServerConfig`（command/args/env/transport/url）+ 可选 `safety`（§2.4） |
| `skills` | 否 | 插件内技能目录（相对插件根），并入技能装载链（优先级最低） |
| `configSchema` | 否 | 键 → `{type, description}`；v1 仅设置页展示，不强校验 config 值 |
| 保留键 `commands` / `hooks` / `agents` / `tools` | — | v1 未实现的贡献点：出现即告警「已忽略」（名字保留，前向兼容） |

校验与容错纪律（沿 mcp.json「宁可少配不可错配」）：未知顶层字段告警忽略；必填缺失/类型矛盾整个插件跳过并告警。**校验规则单源固化**：`plugins/schema/plugin-manifest.schema.json`（JSON Schema draft-07）随包分发——装载器、校验 CLI、编辑器补全/第三方预检同源消费。告警三出口：daemon 日志 + plugins CLI + 设置页告警徽标（§6）。

示例（computer-use，含 §2.4 声明式安全）：

```jsonc
{
  "manifestVersion": 1,
  "id": "computer-use",
  "name": "桌面操作",
  "version": "0.1.0",
  "description": "Windows 桌面观察与操作（UIA 结构化优先 + 截屏兜底）",
  "platforms": ["win32"],
  "defaultEnabled": false,
  "mcpServers": {
    "computer-use": {
      "command": "node", "args": ["dist/plugins/computer-use/server.js"],
      "safety": { "act": ["click", "type", "key", "scroll", "drag", "app"], "confirm": ["screenshot"], "observe": ["uia_snapshot", "window_list"] }
    }
  },
  "skills": ["skills"],
  "configSchema": { "worker": { "type": "string", "description": "PowerShell 可执行名（缺省 powershell.exe）" } }
}
```

### 2.3 装载、遮蔽与启用态

- **id 撞名**：用户级遮蔽内置（与技能五根遮蔽链、mcp.json 项目遮蔽全局同构）。
- **插件间 server 名撞名**：按 id 字典序装载，先到先得，后到告警跳过；用户 mcp.json 恒最高优先（遮蔽一切插件同名 server）。
- **启用态**：settings.json 语义键 `plugins`（两级：全局 `~/.sunshinex/settings.json` 与项目级 `.sunshinex/settings.json`，项目遮蔽全局，缺省 = manifest `defaultEnabled`）：

```jsonc
{ "plugins": {
    "browser-use": { "enabled": true, "config": { "headless": true } },
    "computer-use": { "enabled": false }
} }
```

- **config**：自由对象原样透传给插件（server env 注入/装配参数），插件自校验；`configSchema` 供设置页渲染表单（v1 只读展示）。
- 新文件 **`src/config/plugins.ts`**（单点）：manifest 解析 + 两级装载 + 启用态合并 + `loadEffectivePlugins(root): EffectivePlugin[]`（`{manifest, enabled, config, source: 'builtin'|'user'}`）。`SettingsDoc` 加 `plugins?: unknown` 直通字段，形状裁决在本文件（沿 `permissions` 语义键先例：settings.ts 不裁形状、告警容错）。

### 2.4 声明式安全契约（safety 三类，guard 通用消费）

插件对其贡献的工具自声明风险类别，guard 按**通用机制**消费——取代对具体 server 名的特判（任何插件可用，内置无特权）：

| 类别 | 语义 | guard 行为 |
|------|------|-----------|
| `act` | 有副作用的动作 | **任何档位强制 ask，full-access 不豁免**（硬问线，位于档位判定之前，沿 Bash 破坏命令硬底线先例；deny 规则仍最先） |
| `confirm` | 读但隐私敏感/高频需一次放行 | 默认 ask + 会话级 always（`allowKey` 既有机制，一次放行全会话） |
| `observe` | 纯只读观察 | read-only 白名单资格（对齐 Read/Grep/Glob），acceptEdits 直放 |

- **未声明 safety** 的插件 server：走既有通用 MCP 行为（登记制 + PolicyEngine 规则 + `'mcp'` 审批卡 + 档位判定）——用户 mcp.json 的 server 恒走通用行为，零变化。
- **信任模型**（写入 PLUGIN-DEV）：safety 是**作者自声明**，harness 不语义校验工具实际行为；审批交互、权限规则、插件开关是治理面；**安装第三方插件 = 信任其进程**。文档要求作者如实声明并说明每类理由。

### 2.5 harness 集成点

- **MCP 名单合成**（`src/config.ts` `loadMcpServers` 消费处 / `McpHost` 装配）：最终名单 = 用户 mcp.json（项目∪全局）∪ **已启用插件**的 mcpServers。server 名撞名：用户 mcp.json 遮蔽插件（用户自定义优先，遮蔽就近原则一贯）。工具名照旧 `mcp__<server>__<tool>`，如 `mcp__browser-use__browser_click`。
- **guard 登记制**（guard.ts `mcpServers` 名单）：合成后名单自动含启用插件 servers——`mcp__` 工具「未登记即拒」硬底线零改动。
- **技能并入**：插件 skills 目录作为技能装载链最低优先级根追加（`src/harness/skills.ts` 装载根数组尾部）。
- **懒装配与收口**：进程生命周期仍由 `McpHost` 既有 stdio 管理承载（`mcpReady()` 懒装配 / `mcpClose()` 收口），插件层**零新进程模型**；禁用插件 = 不进名单 = 不 spawn。
- 子智能体派生（`deriveChildRegistry`）自动继承 MCP 工具，零改动。

### 2.6 开发者面：CLI 与开发指南

- **CLI**（`src/cli/commands/plugins-*.ts`，复用装载单点 `src/config/plugins.ts`）：
  - `sunshinex plugins list [--root <abs>]`：表格输出 id/version/来源/启用态/平台可用性/server 名/技能数/告警；
  - `sunshinex plugins validate <dir>`：对任意目录跑 manifest 校验（schema 单源），逐条输出错误/告警——插件作者的 lint 工具，exit 0/1 可进 CI。
- **开发指南**：`docs/PLUGIN-DEV.md`（M1 随框架同批交付），提纲：
  1. 插件是什么：运行形态（进程外 MCP server + 治理层）与三层分工（治理=谁能进来/开关/审批，协议=怎么对话，后端=怎么干活）；
  2. 五分钟最小插件：目录 + plugin.json + 指向任意 stdio MCP server；
  3. manifest 规范全表（同 §2.2）+ JSON Schema 引用（编辑器补全/预检）；
  4. 贡献点：mcpServers（含 safety 三类声明规范与如实声明义务）、skills；
  5. config/configSchema 与设置页展示；
  6. 生命周期与状态（discovered → enabled → active；生效时机 = 下次会话装配）；
  7. 调试：`plugins validate/list`、探活（`/settings/mcp/probe` 同源）、daemon 日志告警出口；
  8. 安全契约与信任模型（作者自声明 + 审批交互 + 安装即信任）；
  9. 实例解构：browser-use（把现成 npm MCP server 包成插件）与 computer-use（自建 server）对照。

### 2.7 明确不做（YAGNI）

插件市场/安装命令、进程内原生工具贡献 API（方案 B，保留键已留位）、hooks/commands/agents 贡献面、插件间依赖、版本协商、运行中会话热插拔。上述留扩展点不实现。

## 3. 工具结果图片通道（M0'，两能力共同前置）

### 3.1 数据通路

| 环节 | 现状 | 改动 |
|------|------|------|
| `ExecResult`（types.ts） | 仅 exitCode/stdout/stderr/timedOut | 加 `images?: string[]`（dataURL，复用 `src/images.ts` 校验规范；图片属观察非退出态，error 亦可带图） |
| MCP client `textOf`（client.ts:22-28） | image content 块被丢弃 | 改 `contentOf`：text 块 join + image 块收 `data:<mimeType>;base64,<data>` 入 `ExecResult.images`（MCP 规范原生支持 image content，此为纯客户端补全）；图片数钳制沿 `MAX_IMAGES` |
| registry.execute（tools.ts:130-167） | 返回 ExecResult | 透传 images（`maskResult` 只处理文本，图片不脱敏——隐私注记见 §6.6） |
| reactor 观察回填（StepRecord → appendChain） | `StepRecord{observation}`；**appendChain 已收 `images`**（chain-ledger.ts:18，用户行通道已通） | `StepRecord` 加 `images?`，appendChain 映射补一字段（reactor.ts:349-352 处） |
| buildMessages（messages.ts:146-150） | 行载 images → 多模态 user 消息（空文行 `(image)` 兜底） | 工具观察行文本照走 tool 消息；行载图片复用既有通道透出——OpenAI 兼容端点即业界标准的「合成 user 帧」形态（实施时核工具行分叉细节，plan 阶段任务） |
| GUI（ToolEntry） | 用户消息图片已渲染；工具行无 | 工具行图片缩略格，点开复用 `ImageLightbox`（已有组件） |

### 3.2 历史图片治理（渲染期剪枝，journal 不动）

截图循环每步一张，历史图片会击穿上下文预算（业界口径：1080p ≈ 1.1k–1.9k tokens/张）。策略抄 Anthropic 官方 demo（`only_n_most_recent_images`）：

- **buildMessages 渲染期**：链行按序只保留**最近 N 行**的 images（缺省 N=3，settings 语义键 `imageHistoryLimit`），更早行图片剥为文本标记 `[image elided]`（该行文本观察保留）。确定性、无状态、journal 全量留档不受影响（回放/审计完整）。
- **压缩（compaction/summarizer）**：v1 不特殊处理——图片行进压缩段时按文本摘要化，图不进摘要（压缩产物本就纯文本；渲染期剪枝已把图压到 N 张内）。
- **生产者编码规范**：图片 ≤1568px 长边 / JPEG q0.85（与 GUI 用户图片装载面同规范，`gui/src/images.ts` 常量上收到 `src/images.ts` 共享）；browser-use 截图走 `browser_take_screenshot` 自带压缩，computer-use server 自行缩放。harness 层恒零转码（图片功能「任何一层不再二次转码」纪律延续）。

### 3.3 用户图片消息上限

截屏回流走 `ExecResult.images`，不受 `MAX_IMAGES=8` 交互面钳制约束（该钳制只管提交面）；单张体积上限校验复用 `MAX_IMAGE_CHARS`。

## 4. browser-use 插件（plugins/browser-use/）

### 4.1 后端

- `@playwright/mcp` **钉版**为该插件目录的依赖（插件目录 = 工作区包），经 `node <…>/node_modules/@playwright/mcp/cli.js` 直启——运行时零 npx 网络依赖。
- manifest：`manifestVersion: 1`、`defaultEnabled: false`、`platforms: ["win32","darwin","linux"]`、server 名 `browser-use`（safety 不声明——浏览器操作走既有通用 MCP 审批行为）。

### 4.2 缺省参数与 config

| 项 | 缺省 | config 键 |
|----|------|-----------|
| 浏览器 | `--browser chrome`（复用系统 Chrome，零内核下载） | `browser` |
| 有头/无头 | headed（抗反爬、验证码可人工兜底） | `headless: false` |
| profile | 持久 `<dataDir>/plugins/browser-use/profile`（登录态跨会话） | `isolated: false`（true 切 `--isolated` 内存 profile） |
| caps | core+tabs（a11y snapshot 主线） | `caps`（network/storage/devtools/vision 默认不开） |

设置页可改，写入 settings 语义键 `plugins["browser-use"].config`，装配期映射为 server args。

### 4.3 使用形态与安全

- 工具面即 Playwright MCP 全集（`browser_navigate/snapshot/click/type/fill_form/wait_for/tabs/…`）；主线 a11y snapshot + ref，免 vision 高成本。
- 安全：走既有 MCP 通道（guard 登记制 + PolicyEngine 规则 `mcp__browser-use__*` 直名/尾 `*` + `'mcp'` 审批卡）；建议文档给出敏感面 deny 示例（如 `deny mcp__browser-use__browser_run_code_unsafe`、`browser_evaluate`）。
- profile 风险注记（写入 MANUAL 使用节）：持久 profile 意味着用户登录态（cookie/session）对 agent 可用——便利与风险同源；敏感站点操作建议 `isolated: true` 或站点 deny 规则兜底。
- 浏览器进程生命周期随 server 进程；headed 模式 Playwright MCP 从不超时——文档注明会话结束随 harness `mcpClose()` 收口。

## 5. computer-use 插件（plugins/computer-use/）

### 5.1 后端：自建 MCP server（工作区包）

- 布局：`plugins/computer-use/`（manifest + `skills/` 教程技能占位 + `server/` TS 源），构建产物 `dist/plugins/computer-use/server.js`，manifest 以 `node` stdio 直启，**含 safety 三类声明**（§2.2 示例——guard 硬问线由声明驱动，无 server 名特判）。
- 架构：**Node MCP server（协议+安全元数据）+ 持久 PowerShell worker（执行器）**。server 启动时 spawn 一个 `powershell.exe`（系统自带，免 pwsh 依赖）子进程，行分隔 JSON 协议通信；`Add-Type`（SendInput/GDI P-Invoke、UIA）worker 启动期一次编译，规避逐调用 500ms+ 编译开销。零原生 npm 依赖（nut.js 已转商业订阅，社区 fork 引入原生绑定打包面——后置，动作面不变可替换）。
- `platforms: ["win32"]`；macOS（TCC 屏幕录制/辅助功能权限硬门槛）与 Linux（AT-SPI/ydotool）后置，manifest 声明即设置页自动置灰。

### 5.2 动作面（收敛集，确切参数）

观察类（只读）：

| 工具 | 入参 | 返回 |
|------|------|------|
| `screenshot` | `region?: [l,t,r,b]`、`display?: int`（缺省主屏） | image content（≤1568 边 JPEG）+ text 元数据（缩放比/光标位/活动窗口标题） |
| `uia_snapshot` | `scope?: 'window'\|'desktop'` | 结构化元素清单文本（id/ControlType/Name/BoundingRect/IsEnabled，交互元素优先，上限 300） |
| `window_list` | — | 顶层窗口清单（标题/pid/前后台） |

动作类（写面）：

| 工具 | 入参 |
|------|------|
| `click` | `x, y, button?: 'left'\|'right'\|'middle'`, `clicks?: 1\|2\|3` |
| `type` | `text`（逐字符 SendInput） |
| `key` | `keys: string[]`（组合键，如 `["Ctrl","Shift","Esc"]`） |
| `scroll` | `direction: 'up'\|'down'`, `amount: int`, `x?, y?` |
| `drag` | `from: [x,y], to: [x,y]` |
| `wait` | `seconds` |
| `wait_for` | `target: string`（UIA 文本）、`mode?: 'appear'\|'disappear'`（缺省 appear；单调用内轮询——抄 Windows-MCP `WaitFor`，实测砍循环步数） |
| `app` | `action: 'launch'\|'focus'`, `target: string`（开始菜单名/可执行路径/窗口标题） |

- **坐标契约**：模型坐标 = 所见截图（缩放后）像素空间；**缩放置账在 server 单点**（发送前记录 `orig↔sent` 比例，模型坐标先反算物理像素再 SendInput；SendInput 绝对坐标按 0–65535 归一）。Anthropic/OpenAI 声明式 display 尺寸、Gemini 0–999 归一化均可在此单点适配。
- worker 已知坑（plan 阶段任务）：DPI 感知（worker 启动即 `SetProcessDPIAwareness(PerMonitorV2)`，否则多屏/缩放坐标错位）；UIPI（非提权进程控不了提权窗口，静默失败——错误文案注明）。

### 5.3 安全设计（本插件的主要工作量）

- **guard 高危硬问线（通用机制，非 computer-use 特判）**：guard 对 `mcp__<server>__<tool>` 查该 server 所属插件的 `safety` 声明（§2.4）——`act` 类工具任何档位强制 ask、full-access 不豁免（沿 Bash 破坏命令硬底线先例，位于档位判定之前）；`observe` 类进只读白名单资格；未声明的 server 走既有通用 MCP 行为。deny 规则仍最先。
- **观察类分级**（由 manifest safety 声明承载）：`uia_snapshot`/`window_list` 声明 `observe`（只读面，read-only 白名单放行）；`screenshot` 声明 `confirm`（屏上可能有密码/他窗内容，隐私敏感，但循环每步都要——默认 ask + 会话级 always 一次放行，否则循环不可用）。
- **审批卡**：v1 复用 `'mcp'` kind（types.ts:327）；专用 kind + 卡片增强（动作摘要/目标窗口）后置。
- **总开关 = 插件开关**（默认关）：禁用即不注册工具，模型不可见、guard 未登记即拒——双保险。
- **隐私与注入注记**（写入 MANUAL）：截图绕过 `maskResult` 凭据脱敏（文本管道不覆盖图片），文档明示风险；屏幕文字会进模型上下文，截图即注入载体——v1 靠动作类强制 ask 兜底，注入过滤后置。
- **接管设计**（文档化，v1 不实现独立工具）：用户物理动鼠标即夺回（SendInput 与物理输入天然竞争），`screenshot` 元数据回传前台窗口名供人核。

## 6. 设置页「插件」pane

- **端点**（`src/serve/config-handlers.ts`，对标 MCP pane 先例 G8c-T4）：
  - `GET /settings/plugins?root=`：`loadEffectivePlugins` 两级合并清单 + 每项 `source`（builtin/user）/`platformSupported`/`running`（该 harness 实例是否已装配）。
  - `PUT /settings/plugins` `{root?, id, enabled?, config?}`：校验插件存在 → settings 语义键结构化原子写（`surgicalSettingsUpdate` 既有面）→ 生效语义 = **下次会话装配生效**（运行中会话不热切换——进程生命周期属 McpHost，热插拔后置）。
- **UI**（Settings 页新增 pane，与 MCP/Agents 并列）：插件卡片 = 图标 + 名称/版本 + 描述 + 来源徽标（内置/用户）+ 平台不支持置灰 + 启用开关 + config 展开区（v1 只读 JSON 展示）。开关态写 settings，与 MCP pane 同交互语言。
- **异常可见性**：manifest 非法被跳过的插件以告警徽标列于 pane 尾（「N 个插件加载失败」展开原因）——装载告警三出口（daemon 日志 / plugins CLI / 设置页）之一。
- **TUI**：v1 手编 settings.json（MANUAL 文档化），`/plugins` 命令后置。

## 7. 测试与验收

- **插件框架**：manifest 解析容错（非法跳过告警）/id 规范与目录名一致性/两级遮蔽/启用态合并（全局缺省→全局开→项目关三态）/名单合成（用户 mcp.json 遮蔽插件 server；插件间撞名字典序先到先得+告警）/平台不匹配剔除/manifestVersion 兼容矩阵/保留键告警忽略——TDD 全钉。
- **声明式安全**：三类声明 → guard 行为矩阵钉（`act` 全档位 ask 且 full-access 不豁免 / `confirm` ask + 会话 always 命中 / `observe` 只读白名单）；未声明 server 走通用行为回归钉；用户 mcp.json server 行为零变化钉。
- **开发者面**：JSON Schema artifact 与装载器同源消费钉；`plugins list/validate` 输出与 exit code 锚点。
- **图片通道**：MCP image content → `ExecResult.images`（dataURL 形态/钳制）；StepRecord→appendChain 链路；buildMessages 剪枝（N=3 缺省/`imageHistoryLimit` 覆盖/`[image elided]` 标记/journal 不动钉）；wire 透出复用既有 `messages.images.test` 延伸；工具行消息形态钉（文本 tool 消息 + 图片 user 帧）。
- **computer-use server**：worker 协议单测（mock 子进程）；坐标反算缩放置账钉；动作面 schema strict 兼容。
- **guard**：硬问线分支钉（full-access 下动作类仍 ask/观察类分级/deny 先行/会话 always 命中）。
- **端点与 GUI**：GET/PUT 契约测试 + pane 渲染锚点测试（gui vitest）。
- **治理**：CLAUDE.md §5（插件章节 + 工具清单口径：插件工具不入内置清单，走 `mcp__` 前缀）+ MANUAL（插件配置节、computer-use 安全节、browser-use 使用节）+ selfcheck 通过。

## 8. 里程碑（TDD 分解留 plan）

1. **M0'** 工具结果图片通道（§3，两能力共同前置，独立可交付可回归）。
2. **M1** 插件框架 + 设置页 pane + 开发者面（§2/§6：manifest schema artifact、`plugins list/validate` CLI、`docs/PLUGIN-DEV.md` 开发指南随框架同批交付；先立框架，两插件即首批消费者——避免为具体插件硬编码开关/安全线）。
3. **M2** browser-use 插件（§4；纯装配面，风险最低，先验证框架端到端）。
4. **M3** computer-use 插件（§5；动作面 + guard 硬问线 + PowerShell worker，工作量与风险最大，独立收口）。

## 9. 兼容与红线

- 用户 mcp.json / 技能目录 / 内置工具三机制**语义零变化**；`plugins` 为新增语义键，无 settings 迁移。
- 图片功能全链（用户随行图片）零回归——`messages.images.test` 全钉保留。
- 安全链不变量：动作仍只从 Tool 面出、必经 guard/PolicyEngine；插件未启用 = 工具不存在（非「注册后禁用」）。
- GUI 设置页既有 pane 交互语言不破坏（G8c 设置态壳层次）。
