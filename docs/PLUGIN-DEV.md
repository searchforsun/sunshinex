# Sunshinex 插件开发指南（PLUGIN-DEV）

> 面向插件作者与维护者。规范唯一权威：`docs/superpowers/specs/2026-10-26-plugin-system-browser-computer-use-design.md` §2；运行时与校验单点 `src/config/plugins.ts`（本文与代码不一致时以代码为准并修文档）。用户使用面（启用/禁用/审批交互）见 `MANUAL.md` §6.4。

## 1. 插件是什么：三层分工与运行形态

插件 = 一个目录 + `plugin.json`（manifest）+ 附带资源。插件本身**不含任何被 harness 加载的运行时代码**——只声明「贡献什么、默认开不开、怎么审批」；能力后端是进程外 MCP server：

| 层 | 承担 | 载体 |
| --- | --- | --- |
| 治理层（插件框架） | 谁能进来：manifest 规范、两级装载与遮蔽、启用开关、审批与 safety 声明消费 | `plugin.json` + settings 语义键 `plugins` + guard |
| 协议层（MCP） | 怎么对话：JSON-RPC over stdio | MCP 官方 SDK（harness 侧客户端） |
| 后端层（你的实现） | 怎么干活：任意 stdio MCP server | 你的进程（命令自定） |

运行形态：

- harness 装配期把**已启用插件**的 mcpServers 合入最终名单（用户 mcp.json 恒优先，遮蔽插件同名 server），随 `McpHost` 既有 stdio 管理懒装配（会话首次 run 前连接注册）与收口（会话结束 `mcpClose`）——插件层零新进程模型；禁用 = 不进名单 = 不 spawn。
- 工具以 `mcp__<server>__<tool>` 进入模型工具面，与用户 mcp.json 登记的 server 同一通道；guard 登记制「未登记即拒」硬底线零改动（合成名单自动含启用插件的 server）。
- 插件还可贡献技能目录（装载链最低优先级，§4.2）与 configSchema（设置页展示，§5）。

## 2. 五分钟最小插件

**目录与 manifest**

```text
hello-mcp/
├── plugin.json     # 必需
└── server.js       # 任意 stdio MCP server（本例假定已就绪）
```

```json
{
  "manifestVersion": 1,
  "id": "hello-mcp",
  "name": "Hello MCP",
  "version": "0.1.0",
  "description": "最小插件样例：把任意 stdio MCP server 包成插件",
  "defaultEnabled": false,
  "mcpServers": {
    "hello": { "command": "node", "args": ["server.js"], "cwd": "." }
  }
}
```

`id` 须等于目录名（不符告警不拒载）；`cwd: "."` = 插件根。

**放哪个根**（二选一）

| 根 | 位置 | 来源标记 |
| --- | --- | --- |
| 内置（随包分发） | `<仓库>/plugins/<id>/` | `builtin` |
| 用户级 | `~/.sunshinex/plugins/<id>/` | `user` |

安装 = 把目录放进根；卸载 = 删除目录。同 id 用户级整体遮蔽内置级（告警点名）。

**验证三步**

```bash
sunshinex plugins validate ~/.sunshinex/plugins/hello-mcp   # error:/warn: 逐行；exit 0/1（可进 CI）
sunshinex plugins list                                       # id/version/来源/启用/平台/server/告警 表格
# 第三步：开启——GUI 设置页「插件」开关，或手编 settings.json（MANUAL §6.4）
```

生效时机 = **下次会话装配**（运行中会话不热插拔，见 §6）。

**发布约定**：`version` 走 semver 口径（展示与排序用，运行时不做严格 semver 校验）；目录内建议附 `README.md`（设置页详情入口、safety 声明理由）；v1 无市场、无 install 命令——分发即让用户把目录放进用户级根。

## 3. manifest 规范全表（manifestVersion 1）

`manifestVersion` 恒为整数 `1`，非 `1` 拒载；同 major 演进走可选字段（未知字段告警忽略），不改此锚值。

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `manifestVersion` | 是 | 恒 `1` |
| `id` | 是 | `^[a-z0-9]+(-[a-z0-9]+)*$`（与技能 id 同规范）；须等于目录名，不符告警 |
| `name` / `version` / `description` | 是 | 均非空字符串；version 走 semver 口径（展示与排序） |
| `platforms` | 否 | `process.platform` 值数组；缺省全平台，不匹配 = 不可用（设置页置灰、装配剔除） |
| `defaultEnabled` | 否 | 缺省 `false`；仅 settings 未配置该插件时作初值 |
| `mcpServers` | 否 | 键 = server 名，值 = 贡献条目（§4.1） |
| `skills` | 否 | 插件内技能目录（相对插件根，§4.2） |
| `configSchema` | 否 | 键 → `{type, description}`；v1 仅设置页展示，不强校验 config 值（§5） |
| `commands` / `hooks` / `agents` / `tools` | — | 保留贡献点名（v1 未实现）：出现即告警「已忽略」，名字留作前向兼容 |

**JSON Schema artifact**：`plugins/schema/plugin-manifest.schema.json`（JSON Schema draft-07，随包分发）——装载器、校验 CLI、编辑器补全/第三方预检同源消费。编辑器补全用法：VS Code 工作区设置配 `"json.schemas": [{ "fileMatch": ["plugin.json"], "url": "./plugins/schema/plugin-manifest.schema.json" }]`；或在 manifest 内直接写 `"$schema"` 指向该文件（解析器按未知字段告警忽略，不拒载）。

**容错纪律**（沿 mcp.json「宁可少配不可错配」；校验单点 `parsePluginManifest`）：

| 级别 | 触发 | 行为 |
| --- | --- | --- |
| errors → 整插件跳过 | 文件缺失 / 非法 JSON / 根非对象 / `manifestVersion`≠1 / 必填五元缺失或非字符串 / `version` 空串 / `id` 不符规范 | 拒载，告警带原因 |
| warnings → 不拒载 | `id`≠目录名 / 保留贡献点 / 未知顶层字段 / 可选键坏值（剔除该键，缺省语义不变） / `mcpServers` 坏条目（跳过该条） | 告警继续 |

mcpServers 条目两级容错：**声明面 fail-closed**——`safety` 在场但形状矛盾 → 整条跳过（不落半份声明：丢 safety 继续跑，会让本该硬确认的工具静默失去问线）；**功能面 fail-soft**——`args`/`env`/`cwd`/`configArgs`/`configEnv`/`configDefaults` 坏值 → 该键告警忽略，条目保留。

解析产物为逐字段重建的干净对象：未知字段与保留键不进产物。`plugin.json` 为**严格 JSON**（注释、尾随逗号、BOM 均非法——与 settings.json 容忍 JSONC 注释不同，留意）。

## 4. 贡献点

### 4.1 mcpServers（MCP server + safety 声明）

条目 = `McpServerConfig` 形态 + 插件扩展键：

| 键 | 必填 | 语义 |
| --- | --- | --- |
| `command` | 是 | stdio 启动命令；`transport` 出现 `http`/`sse` 该条告警跳过（远程 server 支持后置） |
| `args` | 否 | 启动参数（configArgs 展开前的基参） |
| `env` | 否 | 子进程环境变量：叠加继承宿主环境，同键覆盖宿主 |
| `transport` | 否 | 缺省 `stdio`（v1 仅此一种） |
| `cwd` | 否 | 子进程工作目录；`"."` = 插件根（装载期解析为插件根绝对路径）。其它相对路径按 harness 进程 cwd 解析、跨机不可靠——优先 `"."` 或绝对路径 |
| `safety` | 否 | 声明式安全三类（§8）；形状矛盾整条跳过 |
| `configArgs` | 否 | config 键 → 参数模板数组（展开规则 §5） |
| `configEnv` | 否 | env 键 → config 键（值装配期字符串化透传子进程） |
| `configDefaults` | 否 | config 键缺省值（settings 同键浅合并覆盖） |

server 名即工具前缀段（`mcp__<server名>__<工具名>`）。撞名裁定：用户 mcp.json 恒最高（遮蔽一切插件同名 server）；插件间按 id 字典序装载、先到先得，后到告警跳过。

### 4.2 skills

- `skills` = 相对插件根的**目录数组**；每个目录按技能装载链根消费，内含 `{id}/SKILL.md`（frontmatter 与正文同主仓技能规范，见 CLAUDE.md §6）。
- 优先级整链最低：项目级五根 > 全局级 > 学习级 > 插件；id 撞名就近遮蔽，被遮蔽者静默让位。
- 仅 enabled 且平台可用的插件并入；目录缺失/为空静默跳过。

## 5. config 与 configSchema

settings 语义键（两级：全局 `~/.sunshinex/settings.json` 与项目级 `.sunshinex/settings.json`，项目遮蔽全局）：

```jsonc
{ "plugins": {
    "hello-mcp": { "enabled": true, "config": { "port": 4000, "verbose": true, "tag": "x" } }
} }
```

- **记录级整面替换**：项目记录整体遮蔽全局记录（config 不深并）；settings 未配置该插件 → `defaultEnabled` 兜底；坏记录（非对象）告警忽略。
- **装配期展开**（以如下 manifest 为例）：

```json
{
  "manifestVersion": 1,
  "id": "config-demo",
  "name": "Config Demo",
  "version": "0.1.0",
  "description": "演示 configArgs/configEnv/configDefaults 展开语义",
  "mcpServers": {
    "demo": {
      "command": "node",
      "args": ["server.js"],
      "configArgs": {
        "port": ["--port={value}"],
        "verbose": ["--verbose"],
        "tag": ["--tag={value}"]
      },
      "configEnv": { "DEMO_TOKEN": "token" },
      "configDefaults": { "port": 3000, "verbose": false }
    }
  }
}
```

  1. `merged = { ...configDefaults, ...settings config }`（用户值覆盖缺省）；
  2. `configArgs` 逐键展开：值 `undefined` → 整键跳过；模板含 `{value}` → 替换为 `String(值)`；不含 `{value}` → 仅当值为布尔 `true` 才追加纯旗标（非 true 不落参，防字符串误当旗标）；
  3. `configEnv`：值 `String(值)` 注入 env。

  上例 settings config 为 `{ "port": 4000, "verbose": true, "tag": "x" }` 时，最终启动参数 = `["server.js", "--port=4000", "--verbose", "--tag=x"]`；`token` 未配置 → env 不含 `DEMO_TOKEN`；若 `verbose` 落缺省 `false` → 无旗标。
- `config` 为自由对象原样透传（插件自校验）；`configSchema` v1 仅设置页展示，不做预检。

## 6. 生命周期与状态

```text
discovered   两级根扫描发现，manifest 合法入表（非法整插件跳过 + 告警）
  → enabled  settings 两级合并裁决（defaultEnabled 兜底）
  → active   enabled 且平台可用：server 进 MCP 名单 + guard 登记 + skills 链并入
```

- **生效时机 = 下次会话装配**：设置页开关 / 手编 settings 改完对新会话生效；运行中会话不热切换（进程生命周期属 McpHost，热插拔后置）。
- 进程生命周期随 harness：懒装配（首次 run 前 `mcpReady` 连接注册；无启用 server 时零开销直通）→ 会话收尾 `mcpClose` 收口（CLI 收尾 / TUI dispose / daemon 停机同源）。浏览器类有头进程同随此收口。
- `platforms` 不匹配：装载层只标记不丢弃（设置页置灰列示），装配期剔除。

## 7. 调试

**告警三出口**：

| 出口 | 用法 |
| --- | --- |
| plugins CLI | `sunshinex plugins validate <dir>`（单目录校验，`error:` / `warn:` 逐行，exit 0/1 可进 CI）；`sunshinex plugins list [--root <abs>]`（两级装载表格：id/version/来源/启用/平台/server/告警数 + `[warn]` 聚合告警行；`--root` = 项目 settings 锚，缺省 cwd） |
| 设置页 / 端点 | `GET /settings/plugins?root=`：逐插件 id/来源/启用/平台/server/技能数/configSchema/config/warnings + 顶层 warnings；manifest 非法被跳过的插件以告警徽标列于 pane 尾 |
| 会话 / daemon 面 | 装配告警（遮蔽/撞名/坏记录/manifest 告警）并入 harness 警告单——会话面以警示行透出，`selfcheck` 同屏 |

写入端点（设置页背后）：`PUT /settings/plugins {root?, id, enabled?, config?}`——settings 结构化原子写（记录级整面替换）；id 缺失/坏形 → 400；未知 id → 404；目标文件含注释/畸形 JSON/version≠1 → 409（引流 raw 编辑器）。生效语义同上：下次会话装配。

探活：`POST /settings/mcp/probe` `{root?, name}`——对合并清单中同名 server 同源探活（临时装配 + 握手 + tools/list），插件工具装载失败时的第一诊断（root 缺省 = 仅全局清单，与 GET 同裁定；探活名 = 插件贡献的 server 名）。

常见装载失败对照表：

| 报告（validate / list） | 原因与处置 |
| --- | --- |
| `manifest missing` | 目录下无 plugin.json（核对目录名；无 plugin.json 的子目录按非插件条目静默跳过，如随包分发的 `plugins/schema/`） |
| `plugin.json 非法 JSON` | 严格 JSON：注释、尾随逗号、BOM 都非法 |
| `不支持的 manifestVersion` | 只认 `1` |
| `缺必填字段 …` | 补齐五元（均为字符串） |
| `id 非规范` | 改为 `^[a-z0-9]+(-[a-z0-9]+)*$` |
| `id 与目录名不一致` | 告警不拒载；改目录名或 id 保持一致 |
| `贡献点 … 本版本未实现，已忽略` | `commands`/`hooks`/`agents`/`tools` 保留键；可删可留（留着即告警） |
| `mcpServers.<名>: 缺 command` / `transport 仅支持 stdio` | 该条跳过：补 command；远程形态后置 |
| `safety 须为对象（声明矛盾不落半份）` | 该条整条跳过：三类（act/confirm/observe）均须字符串数组 |
| `被用户 mcp.json 遮蔽` / `撞名（…）字典序后者跳过` | server 名冲突：改 server 名或移除用户同名条目 |
| 表格「平台」列 n-a | `platforms` 不含当前平台：装配剔除、设置页置灰 |

## 8. 安全契约与信任模型

safety 三类 = 插件作者对所贡献工具的**自声明**风险类别；guard 按**通用机制**消费——任何插件可用、内置无特权（取代对具体 server 名的特判）：

| 类别 | 声明义务 | guard 行为 |
| --- | --- | --- |
| `act` | 有副作用的动作 | **任何档位强制 ask，full-access 不豁免**（硬问线，先于档位判定；read-only 档直接拒；deny 规则仍最先） |
| `confirm` | 读但隐私敏感 / 高频需一次放行 | 落穿既有通用审批：acceptEdits 默认 ask、`a` = 会话级一次放行；full-access 自动放行；read-only 拒 |
| `observe` | 纯只读观察 | 只读白名单资格，各档位直放（对齐 Read/Grep/Glob） |

- 同一工具名落入多类取最严问线（`act` > `confirm` > `observe`，fail-closed）。
- **未声明 safety** 的 server：走既有通用 MCP 行为（登记制 + PolicyEngine 规则 + `'mcp'` 审批卡 + 档位判定）——fail-closed 兜底；用户 mcp.json 的 server 恒走通用行为，零变化。
- 治理面在用户手里：`permissions.deny` 可直名或尾 `*` 拒绝任意 `mcp__<server>__<tool>`（deny 最先，可覆盖 safety 声明）；插件开关 = 总开关，禁用即工具不存在（未注册 + guard 未登记即拒，双保险）。

**信任模型（作者必读）**：safety 是作者自声明，harness 不语义校验工具实际行为——声明即对用户承担义务：`act` 只列真正改动系统状态的工具，`confirm` 只列确有隐私/高频考量的读取，`observe` 只列纯只读工具；逐类取舍理由建议写进插件 README。反过来对用户：**安装第三方插件 = 信任其进程**（server 以你的用户身份运行，无额外沙箱），只安装可信来源的插件。

## 9. 实例解构（规划形态；M2/M3 交付后以仓内 `plugins/<id>/` 为完整实例）

内置首批两插件是框架的首批消费者。交付里程碑前本节为规划形态；M2/M3 交付后以仓内 `plugins/browser-use/`、`plugins/computer-use/`（manifest + README）为完整实例，本文不再重复维护其细节。

### browser-use（M2：包装现成 server）

- 思路：把现成 npm MCP server（`@playwright/mcp`）**钉版**为插件目录依赖（插件目录 = pnpm 工作区包），manifest 以 `node <插件>/node_modules/@playwright/mcp/cli.js` 直启——运行时零 npx 网络依赖；相对路径 + `cwd` 锚定插件根。
- `configArgs` 映射 settings config → server 参数（浏览器选择 / headless / isolated profile / caps），`configDefaults` 给缺省值。
- `safety` 不声明：浏览器操作走既有通用 MCP 审批行为；敏感面建议用户以 deny 规则兜底（如 `deny mcp__browser-use__browser_run_code_unsafe`）。
- 规划字段：`platforms: ["win32", "darwin", "linux"]`、`defaultEnabled: false`、server 名 `browser-use`。

### computer-use（M3：自建 server）

- 思路：`server/` TS 源构建产物经 manifest 以 `node` stdio 直启（Node 协议层 + 持久 PowerShell worker 执行器，零原生 npm 依赖）；`platforms: ["win32"]`（macOS/Linux 后置——manifest 声明即设置页自动置灰）。
- safety 三类声明真实样例（guard 硬问线由声明驱动，无 server 名特判）：

```json
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
      "command": "node",
      "args": ["dist/plugins/computer-use/server.js"],
      "safety": {
        "act": ["click", "type", "key", "scroll", "drag", "app"],
        "confirm": ["screenshot"],
        "observe": ["uia_snapshot", "window_list"]
      }
    }
  },
  "skills": ["skills"],
  "configSchema": { "worker": { "type": "string", "description": "PowerShell 可执行名（缺省 powershell.exe）" } }
}
```

- 分级理由（声明义务示范）：动作类（click/type/key/scroll/drag/app）改系统状态 → `act` 硬问线；`screenshot` 读但屏上可能有密码/他窗内容、且循环每步都要 → `confirm`（会话一次放行保循环可用）；`uia_snapshot`/`window_list` 纯只读 → `observe`（read-only 白名单资格）。

对照：browser-use 示范「包现成 server」（装配与 config 映射为主），computer-use 示范「自建 server」（safety 声明与动作面设计为主）——两类形态覆盖插件开发的主要路径。
