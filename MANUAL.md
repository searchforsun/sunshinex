# Sunshinex 使用手册（CLI + TUI）

终端里的 AI Agent：用自然语言下任务，模型流式作答、工具实时执行，写操作需你审批，复杂目标先规划后执行。

本手册覆盖 CLI 启动与 TUI 交互全量用法；图形界面见 [MANUAL-GUI.md](MANUAL-GUI.md)；架构、开发与部署见 [README.md](README.md)。

要求：Node.js ≥ 22.9。

## 一、安装与启动

**源码运行**

```bash
pnpm install           # 首次安装
pnpm cli               # 启动（内置构建，无需单独 build）
pnpm cli <目录>        # 在指定项目目录打开会话（路径形态参数：/abs、./x、../x）
pnpm cli selfcheck     # 骨架自检
pnpm test              # 全量单测
```

**正式安装（npm 全局）**

```bash
npm install -g https://github.com/searchforsun/sunshinex/releases/download/v0.6.0/sunshinex-agent-0.6.0.tgz
# npm ≥ 12 报 EALLOWREMOTE（allow-remote 缺省 none）时二选一：
#   加开关：npm install -g --allow-remote=all <上面的链接>
#   或先下载再本地装（allow-file 缺省 all，不受此限）：curl -LO <链接> && npm install -g ./sunshinex-agent-0.6.0.tgz
```

**命令总表**

| 命令 | 作用 |
| --- | --- |
| `sunshinex` | 当前工作区启动 TUI（缺省形态） |
| `sunshinex /path/to` | 指定目录启动 TUI（位置参数=路径形态：`/abs`、`./x`、`../x`、`a/b`） |
| `sunshinex --workdir=/path/to` | 同上，flag 形态 |
| `sunshinex help` | 显示用法（`--help` / `-h` 同义） |
| `sunshinex selfcheck` | 骨架自检 |
| `sunshinex run <dir> --goal="..."` | 标准验收修正环（非 done 退出码 1） |
| `sunshinex pipeline <dir> --goal="..." [--yes]` | 五节点流水线 gate 审批（`--yes` 跳过交互直接批准） |
| `sunshinex serve [目录] [--port=N] [--token=T] [--manual]` | 启动 GUI daemon（HTTP+WebSocket，浏览器访问 GUI；缺省绑定回环且免鉴权，显式 `--token` 才启用鉴权、`--port` 缺省 7788、`--manual` 预选会话以 acceptEdits 权限档装配；详见 [MANUAL-GUI](MANUAL-GUI.md)）。安全口径：回环绑定为第一道（不对外监听）；免鉴权档下浏览器侧其他页面可发跨站简单 POST 触及 daemon 全部端点（含打开编辑器等本机操作）——单用户本机工具的登记接受面；不可信同机环境请启用 `--token` |
| `sunshinex skills install <git-url \| owner/repo \| 本地目录> [--force]` | 安装技能到全局技能根 `~/.sunshinex/skills`（同名已存在缺省跳过，`--force` 覆盖） |
| `sunshinex kb-index [目录]` | 构建知识库索引（对目录内 md/txt 走计费 embedding；缺省当前工作区，`node_modules` 与隐藏目录跳过；`kb_search` 检索源，见第二节 KB 配置） |
| `sunshinex plugins list [--root <目录>] \| enable\|disable <id> [--scope=global\|project]` | 插件清单与启停：两级装载结果（id / 版本 / 来源 / 启用态 / 贡献面 / 告警），见 6.4 |
| `sunshinex plugins validate <目录>` | 校验插件目录 manifest（错误 / 告警逐行上屏，exit code 判过；开发面，详见 `docs/PLUGIN-DEV.md`） |
| `sunshinex mcp` / `agents` / `providers` / `settings` / `skills list` | MCP 服务器 / 子智能体 / 模型提供方 / 设置键 / 技能清单的命令行管理面（增删改查 / 启停 / 批准 / 探活），见下方「资源管理子命令」 |

**资源管理子命令**（MCP / 子智能体 / 插件 / 提供方 / 技能 / 设置键）

六个命令族，其中 mcp / agents / providers / settings 四族共用同一套作用域定位：`--scope=global|project`（缺省 `project`，锚定当前工作目录）、`--root <目录>` 覆盖工作目录；写项目级时 `.sunshinex/` 不存在会自动建。plugins 启停同样带 `--scope=global|project`；skills list 的 `--scope` 词表为 `all|project|global`（视图过滤，非写面定位）。`--json` 供脚本消费。表格输出 / exit code（0 成功 / 1 用法错或写失败）。

注意：`list` 的 `--scope` 不是行过滤——`sunshinex mcp list --scope=project`（含缺省）返回全合并视图（项目 + 全局，含 `scope`/`遮蔽` 标注列，与 GUI/REST 同源同口径），仅 `--scope=global` 时过滤只看全局条目；`agents list` 同此语义，`providers list` 恒为合并视图（`--scope` 不参与行过滤）。

| 命令族 | 子命令 | 说明 |
| --- | --- | --- |
| `sunshinex mcp` | `list` / `add <名> --command=<命令> [--arg=a]… [--env=K=V]…` 或 `--url=<地址>` / `remove` / `enable` / `disable` / `test <名>` / `approve` / `deny <名>` | MCP 服务器登记表增删改查；`test` 探活（握手 + tools/list）；`approve`/`deny` 写项目批准阀（见第二节 mcp.json）；项目级 `add` 会提示首次装载需批准 |
| `sunshinex agents` | `list` / `add <id> --name=<名称> [--description=<描述>] [--memory] [--isolation=worktree] [--executor=internal-team\|external-cli] [--body-file=<路径>]` / `remove` / `enable` / `disable <id>` | 子智能体目录管理；启停写 agent.md 的 `enabled` 行（见 5.3） |
| `sunshinex plugins` | `list [--root <目录>]` / `validate <目录>` / `enable` / `disable <id> [--scope=global\|project]` | 插件清单 / manifest 校验 / 启停（写 settings `plugins` 键，见 6.4） |
| `sunshinex providers` | `list` / `add <名> --base-url=<地址> --models=m1,m2,…` / `set <名>`（增量更新，同 add 字段）/ `remove` / `key <名>`（隐藏输入写 env 块）/ `test <名>`（探测 `<baseUrl>/models`）| 模型提供方管理；模型行二级：`providers model add\|remove\|move <源> <模型> [--tier=small\|medium\|large] [--direction=up\|down]`——清单序即缺省序（首位=默认模型），`--tier` 标注档位路由 |
| `sunshinex skills` | `list [--scope=all\|project\|global] [--json]`（另有 `install` 见上表） | 沿来源链列技能（project/user/learned/plugin 分组 + 遮蔽标注） |
| `sunshinex settings` | `get <键>` / `set <键> <值> [--scope=global\|project]` | 读语义设置键（打印生效值与来源）/ 写键；未知键报未知设置键错误并退出码 1 |

**启动参数**（全部命令通用）

| 参数 | 说明 |
| --- | --- |
| `--mode=read-only\|acceptEdits\|full-access` | 权限档，缺省 `acceptEdits`（见第六节） |
| `--language=en\|zh` | 界面语言，缺省 `en`；只影响界面，模型侧文本恒英文 |
| `--tier=small\|medium\|large` | 模型档位，缺省 `medium`；会话内可用 `/model-tier` 切换 |
| `--effort=none\|minimal\|low\|medium\|high\|xhigh\|max` | 缺省思考强度（reasoning_effort）；端点不支持时按阶梯自动降级，会话内可用 `/model-effort` 切换 |
| `--continue` | 直接续接最近一次会话（按会话档时间自动判定，TUI 专属，与 `--worktree` 互斥） |
| `--resume` | 启动时弹会话选择卡恢复既有会话（TUI 专属，与 `--continue`/`--worktree` 互斥） |
| `--worktree[=<name>]` | 在隔离 git worktree 内启动（裸旗标自动命名；干净树随会话自动清理，脏树保留待处置，见 5.5） |
| `--workdir=<dir>` | 目录来源 flag 形态；与位置路径同传时本 flag 优先 |

无法识别的裸词报错不启动（`无法识别命令，使用 sunshinex help 查看使用方法`）。

升级：重装新版 Release 链接即覆盖。

## 二、配置（settings.json）

两个位置任选，同时存在时项目级覆盖全局级：

| 级别 | 文件 | 生效范围 |
| --- | --- | --- |
| 全局 | `~/.sunshinex/settings.json` | 本机所有项目（配一次） |
| 项目 | `<项目>/.sunshinex/settings.json` | 仅该项目（已在 .gitignore） |

生效优先级（高 → 低）：**已导出环境变量 > 项目 settings.json > 全局 settings.json > 内置缺省**。

**作用域统一规则**：MCP、子智能体、插件、技能四类资源一律**项目遮蔽全局**（同名/同 id 时项目生效，视图标注遮蔽关系，见第三节目录树）；settings 语义键维持上面的填充链，两个结构化键的两级遮蔽口径不同：`providers` 按**整键**（项目写了该键——含空数组——则整键以项目为准，不做逐项深合并）；`plugins` 按**插件 id 逐条**（`{...全局记录, ...项目记录}` 键级浅并——项目只覆写它点名的插件，未点名的沿用全局记录；同 id 记录整面替换、config 不深并）。

最小可用配置（可直接复制使用；任意 OpenAI 协议兼容端点均可，如 BigModel、DeepSeek、OpenRouter、vLLM 本地部署等）：

```json
{
  "version": 1,
  "providers": [
    { "name": "bigmodel", "baseUrl": "https://open.bigmodel.cn/api/paas/v4", "models": [{ "model": "glm-4.7" }] }
  ],
  "env": { "SUNSHINEX_API_KEY": "sk-…" }
}
```

模型配置唯一事实源 = `providers` 列表：缺省模型恒为**第一个 provider 的第一个 model**（清单序即优先级）。语义键表以本节模板为准——拼写错误或表外键（含 `model` / `dataDir` 等形近历史键）一律按未知键同判（启动打一条通用未知键告警、不生效），模型配置一律写 `providers` 列表；没配 `providers` 时直接 `export SUNSHINEX_MODEL=…` / `SUNSHINEX_BASE_URL=…` 的单模型环境变量形态仍可用。

修改配置后新开会话生效（运行中会话不热切换；GUI 设置页的实时刷新只影响面板显示，见第三节「配置实时同步」）。

下面是**全部可配置项**（供查改；`//` 与 `/* */` 注释可原样保留——settings.json 容忍 JSONC 注释；尾随逗号不在此列、仍按严格 JSON 报错；不需要的项整行删除即用缺省）：

```jsonc
{
  "version": 1,

  // ── 模型 ──────────────────────────────────────────────
  "providers": [                                     // 模型配置唯一事实源（多源多模型清单；/model 选择卡数据源；项目级整键覆盖全局级）
    {                                                // 每项 = 一个源：name + baseUrl + models（contextWindow / reasoningEffort 为该源各模型缺省，可省）
      "name": "deepseek",
      "baseUrl": "https://api.deepseek.com",
      "contextWindow": 64000,                        // 源级缺省窗口
      "reasoningEffort": "high",                     // 源级缺省思考强度 none|minimal|low|medium|high|xhigh|max
      "models": [
        { "model": "deepseek-chat" },                             // 最简对象形态（窗口/强度/图片能力回退源级）；清单序即缺省序——第一源第一模型 = 默认模型
        { "model": "deepseek-flash", "contextWindow": 128000, "reasoningEffort": "low", "supportsImages": false, "tier": "large" }  // 逐项覆盖源级（supportsImages=false 声明纯文本模型；tier 标注供 /model-tier 档位路由选中，small|medium|large 可省）
      ]
    },
    {
      "name": "bigmodel",
      "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
      "models": [{ "model": "glm-4.7" }]
    }
  ],
  "tier": "medium",                                  // 缺省档位 small|medium|large（/model-tier 按上面 tier 标注选中对应模型，无标注回默认）
  "contextWindow": 200000,                           // 全局窗口 tokens（未按模型配置时的回退；1M 模型填 1000000）
  "reasoningEffort": "high",                         // 缺省思考强度 none|minimal|low|medium|high|xhigh|max；留空 = 不下发（用端点默认）；端点不支持时按阶梯自动降级
  "imageHistoryLimit": 3,                            // 工具结果图片渲染半径：链上仅最近 N 个带图行保图入模型上下文（0-50 整数，0 = 全部剥图留文本标记）

  // ── 长任务 ────────────────────────────────────────────
  "maxSteps": 400,                                  // Reactor 单 run 步数上限
  "maxLoopIterations": 200,                         // Loop 修正环节点执行步上限
  "maxGraphNodes": 1000,                            // Graph 全链路节点步累计上限
  // "maxTokens": 2000000,                          // 主链单次提交 token 硬顶（累计用量量纲）；缺省不设——预算是兜底不是限制，护栏交给步数与墙钟
  // "subagentTokenCap": 1000000,                   // 子智能体 token 硬顶（独享值，不继承主链剩余）；缺省不设
  // "teamTokenCap": 1000000,                       // 团队 token 硬顶（主代理团队侧限额，用满后新任务排队，见 5.6）；缺省不设
  // "compactionThreshold": 80,                    // 上下文压缩阈值（10–95 整数百分比，缺省 80 = 占用达 80% 即自动压缩）
  "agentTeams": "on",                                // 智能体团队能力 on|off（关=不注入 agent_team_* 工具；GUI 隐藏「智能体团队」页签）；缺省 on

  // ── 界面 ──────────────────────────────────────────────
  "language": "en",                                  // 界面语言 en|zh（--language 参数优先）

  // ── 记忆与技能沉淀 ────────────────────────────────────
  "autoMemory": "on",                                // 持久记忆总开关 on|off
  "learnedSkills": "on",                             // 技能沉淀开关 on|off
  "learnedSkillLimit": 50,                           // 沉淀技能条数上限（1..1000）
  "disabledSkills": "",                              // 停用技能：逗号分隔的技能目录绝对路径（设置·技能页卡片开关读写；缺省全部加载）
  "memoryIdleKickMs": 300000,                        // 后台沉淀的空闲兜底节拍（毫秒）
  "stepDigestMaxSteps": 20,                          // 后台提取的材料预算，一般无需修改
  "stepDigestItemChars": 120,
  "stepDigestTotalChars": 1500,

  // ── 知识库 / 嵌入 / 搜索 ──────────────────────────────
  // 索引经 kb-index 命令显式构建（CLI `sunshinex kb-index <目录>` 或 TUI `/kb-index [目录]`）：索引走计费 embedding，不自动重建
  "kbBackend": "local-json",                         // local-json | sqlite-vec
  "kbDataDir": "",                                   // 知识库目录；留空 = 数据目录/kb
  "embeddingBaseUrl": "",                            // 嵌入服务；留空 = 回退主模型同名字段
  "embeddingModel": "",
  "websearchProvider": "bing-html",                  // bing-html（缺省）| duckduckgo | bing；bing 需 SUNSHINEX_BING_API_KEY
  "websearchEndpoint": "",                           // 搜索端点覆盖；留空 = 提供方缺省

  // ── 目录覆盖（留空即用缺省，见第三节）────────────────
  "projectsDir": "",                                 // 项目数据根（各工作区分目录的父级）；留空 = ~/.sunshinex/projects，可指向任意盘
  "userSkillsDir": "",                               // 全局技能目录
  "globalSunshine": "",                              // 全局约定 SUNSHINE.md 所在目录
  "shell": "",                                       // 命令执行 shell（POSIX 兼容）；Windows 留空自动探测 Git Bash，无则 PowerShell，末位 cmd 兜底

  // ── 权限规则与信任目录（deny/allow 语法见「六、权限模式与审批」）──
  "permissions": {
    "deny": ["Write(*.pem)", "Bash(rm -rf*)", "Read(**/.env)"],  // 命中即拒；两级合并取并集，项目级不可解除全局级
    "allow": ["Write(src/**)"],                                  // 命中免审批
    "additionalDirs": ["../lib-shared"]                          // 信任目录：读写同项目根；运行期经 /add-dir、--add-dir 追加
  },

  // ── 安全语义键 ────────────────────────────────────────
  "readFence": "off",                                // 开启后信任域外读取也需审批（acceptEdits 档）/ 拒绝（其余档）
  "sandbox": "on",                                   // Linux 下 exec 经 Landlock 内核围栏；off 一键关
  "isolation": "",                                   // 隔离口径声明 landlock|container|host；留空自动探测（selfcheck 上屏）

  // ── 插件 ──────────────────────────────────────────────
  "plugins": {                                       // 插件启用态与配置（见 6.4）；两级 per-id 项目遮蔽全局（同 id 记录整面替换，config 不深并）
    "browser-use": { "enabled": true }                 // 内置插件只有开关（enabled 缺省 = manifest defaultEnabled）；config 仅对用户级插件生效
  },

  // ── 项目 MCP 批准阀（approve/deny 动作自动维护，一般无需手改）──
  // "mcpApprovals": { "<项目slug>": ["github"] },    // 已批准的项目 MCP 服务器（按项目记，见下节）
  // "mcpDenied": { "<项目slug>": ["不可信源"] },     // 已拒绝的：不再询问、装载器直接跳过

  // ── 密钥（只写这里）──────────────────────────────────
  "env": {
    "SUNSHINEX_API_KEY": "sk-…",                     // 模型密钥（providers 各源缺专用密钥时也回退这里；无 providers 的单模型 env 形态也读它）
    "SUNSHINEX_API_KEY_DEEPSEEK": "sk-…",            // 按源专用密钥：SUNSHINEX_API_KEY_<大写源名>（有则优先于主密钥；providers key 子命令写这里）
    "SUNSHINEX_EMBEDDING_API_KEY": "",               // 嵌入密钥；留空 = 回退主密钥
    "SUNSHINEX_BING_API_KEY": ""                     // Bing 搜索密钥（websearchProvider=bing 时用）
  }
}
```

- 语义键与同名 `SUNSHINEX_*` 环境变量一一对应（`tier` ≡ `SUNSHINEX_TIER`），环境变量仍最高优先。`SUNSHINEX_MODEL` / `SUNSHINEX_BASE_URL` 两个环境槽保持有效——无 `providers` 时直接导出仍按单模型形态装配。
- `providers` 多源清单：TUI 内 `/model` 弹选择卡按 `源/模型` 即选即切（对后续任务生效，状态栏模型段随之更新）；**缺省模型恒 = 清单第一源 × 第一模型**（清单序即优先级，`/model` 卡与 GUI 提供方页首位标「默认」，`/model` 卡无 `default` 选项）。各源密钥按 `SUNSHINEX_API_KEY_<大写源名>` 取（缺省回退 `SUNSHINEX_API_KEY`；`sunshinex providers key <源>` 交互写入）。`supportsImages`（源级/条目级两级，条目覆盖源级）声明模型是否接受图片附件：未声明按支持处理，显式 `false` 时 GUI/TUI 拒收图片并提示「当前模型不支持图片输入」，适配器层同口径拒发（不打必败请求）。
- 每模型窗口与思考强度：`models` 条目可写对象形态 `{ "model": "…", "contextWindow": 128000, "reasoningEffort": "high" }`（源级同名字段为该源缺省，条目级优先，逐项可省）。窗口是压缩预算与状态栏/`/context` 分母——未配置的模型回退全局 `contextWindow` 键 / 内置 200k，切换模型后下一任务按新窗口判定；思考强度是该模型的缺省档（`/model-effort` 会话内覆盖仍最高），未配置回退全局 `reasoningEffort` 键 / 端点缺省。
- 档位路由：models 条目可选 `"tier": "small|medium|large"` 标注，`/model-tier` 与 GUI 档位切换按标注选中对应模型（同档多模型取第一个；无标注/无匹配回缺省模型）（档位标注是 tier 路由的唯一数据源。）
- 空串等价未配置；密钥类一律只放 `env` 块。
- JSON 写错或 `version` 非 1：启动即报错并指出文件路径；未知键告警后忽略。

### MCP 服务器（mcp.json）

MCP 服务器登记在项目级 `.sunshinex/mcp.json` 与全局级 `~/.sunshinex/mcp.json`（`mcpServers` 键，与主流 MCP 客户端格式兼容；项目级同名条目遮蔽全局，与技能装载链同构；登记表为空 = MCP 工具全禁）。可靠性口径：每轮任务入口对各 server 做连通性探活（协议级 ping，1s 封顶），失败 server 同轮重建；运行中调用遇连接断链（server 进程死亡/管道断）自动重连并重试，最多 2 次，穷尽如实回报 `MCP_CONNECT_FAILED`（超时与业务错误不重试）：

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "ghp_…" } },
    "remote": { "url": "https://mcp.example.com/v1", "transport": "http" }
  }
}
```

- stdio 形态：`command` + 可选 `args` / `env`（transport 可省略）；远程形态：`url` + 可选 `transport`（缺省 `http`，支持 `sse`）与 `headers`（请求头，string → string）。两形态通用的可选键：`enabled`（布尔整机开关，`false` 装配期跳过不连接）、`disabledTools`（停用工具短名数组，装配期不注册即模型不可见）；无 scheme 的 `url` 自动补 `http://`。
- 非法条目跳过不抛（缺 command/url、transport 值未知、形态矛盾），装配面宁可少配不错配。

**项目 MCP 批准阀**（安全阀，防克隆仓库自带 mcp.json 自动拉起进程）：项目级条目**首次装载需你批准一次**——批准前不拉起进程、不装载也不遮蔽全局同名条目。批准 / 拒绝记录写在全局 settings 的 `mcpApprovals` / `mcpDenied` 键（按项目 slug 分账）；拒绝过的不再次询问、装载器直接跳过；全局条目是你亲手配的机器级文件，不过阀。批准渠道三选一：

| 渠道 | 操作 |
| --- | --- |
| GUI | 设置页「MCP」项目作用域下待确认卡（「待确认」徽标 + 确认 / 拒绝按钮） |
| TUI | 启动加载后非阻塞提示未批准项；`/mcp` 面板看「待确认」徽标，`/mcp approve <名>` / `/mcp deny <名>` |
| CLI | `sunshinex mcp list` 标注 pending；`sunshinex mcp approve <名>` / `deny <名>`（写全局 settings） |

`mcp.json` 的增删改查走 `sunshinex mcp` 子命令（见第一节「资源管理子命令」）或 GUI 设置页；手编文件同样有效。

## 三、目录与文件

**全局级 `~/.sunshinex/`**

```
~/.sunshinex/
├── settings.json               # 全局配置（第二节；含 providers / plugins / mcpApprovals / mcpDenied）
├── mcp.json                    # 全局 MCP 服务器登记（被项目级 .sunshinex/mcp.json 同名遮蔽；不过批准阀）
├── plugins/<id>/               # 用户级插件（plugin.json + 资源；同 id 遮蔽内置，见 6.4）
├── agents/<id>/agent.md        # 全局子智能体（frontmatter 可选 enabled，缺省开；见 5.3）
├── SUNSHINE.md                 # 个人全局约定，跨所有项目生效（对标 ~/.claude/CLAUDE.md）
├── skills/<id>/SKILL.md        # 全局技能，跨项目共享
└── projects/<工作区>/data/     # 各项目的运行时数据（按启动目录自动隔离）
    ├── sessions/               # 会话日志（/resume、--resume、--continue 据此恢复）
    ├── teams/<journalId>/      # 会话级智能体团队/板/inbox（与 journal 同键；新会话空板）
    ├── memory/                 # 持久记忆：MEMORY.md 索引 + <slug>.md 记录
    ├── skills/                 # 自动沉淀的学习技能
    ├── worktrees/              # worktree 隔离工作树（见 5.5）与登记表 registry.json
    ├── runs/                   # 任务账本（/status 与状态栏统计）
    ├── tasks/                  # 后台任务：任务日志 <id>.log + 会话账本 ledger-<journalId>.jsonl（重开/重启可回溯）
    ├── kb/                     # 知识库数据
    ├── tool-outputs/           # 超长工具输出的完整原文（正文只留预览 + 路径）
    └── archives/               # 压缩时折叠的链行归档
```

`projects/` 这一层不限家目录所在盘：`projectsDir` 指到哪，各工作区的数据就落哪（如 `"projectsDir": "D:\\sunshinex-projects"`），逐工作区分目录的隔离与防撞名语义不变——家目录分区吃紧或想把运行数据放独立盘时用。留空即缺省形态（`~/.sunshinex/projects`）。

> `SUNSHINEX_DATA_DIR` 是**开发与测试专用**的环境变量重定向口，用户配置面以 `projectsDir` 为准（换盘、分区都走它）。

**项目级 `<项目>/`**

```
<项目>/
├── SUNSHINE.md                 # 项目约定（/init 生成或手写）
├── .sunshinex/
│   ├── settings.json           # 项目级配置（覆盖全局；已在 .gitignore）
│   ├── mcp.json                # 项目级 MCP 服务器登记（同名遮蔽全局；首次装载过批准阀；可提交入库共享）
│   ├── skills/<id>/SKILL.md    # 项目技能（原生项目技能根；.agents/.claude/.codex 同形兼容根也装载）
│   └── agents/<id>/agent.md    # 项目子智能体（唯一项目落位；见 5.3）
└── （历史旧位置 <项目>/agents/ 的子智能体条目在首次装载/列举时一次性自动迁入 .sunshinex/agents/）
```

- 技能标准形态统一为 `{根}/skills/{id}/SKILL.md`，正文前 frontmatter 写 `name` 与 `description`。
- 技能生效顺序：项目级 > 全局级 > 学习级（沉淀产物垫底）。
- 文件读取缺省全盘开放；写入信任项目根与已登记信任目录，越界写走审批或拒绝（详见第六节）。

**配置实时同步（serve/GUI）**：`sunshinex serve` 运行期间监听全局 `~/.sunshinex/`（settings.json / mcp.json / agents / plugins）与各活跃项目的 `.sunshinex/`（settings / mcp / skills / agents）及 `.agents/.claude/.codex` 兼容技能根的 skills/；文件改动（手编、CLI 写、另一窗口 GUI 写）经 300ms 防抖合并后以 WS `config-changed` 帧广播，打开中的设置页自动刷新（≤1s）；daemon 自身的结构化写做回环抑制，不产生多余刷新。CLI 与 TUI 是一次性进程不做监听——它们写盘后由 GUI 跟上，GUI 写后 CLI / TUI 下次读盘即见。监听不可用（网络盘 / 权限）时降级为打开页面即读，功能不阻塞。

## 四、基本用法

| 界面元素 | 含义 |
| --- | --- |
| `░` | 你的输入 |
| `✻ Thought for Ns` | 思考摘要（`Tab` 展开） |
| `● [VERB]` / `⎿ ✓` `⎿ ✗` | 工具调用行 / 结果行 |
| 系统提示行 | 状态回执（暗色）；`!` 黄色为警示、`✗` 红色为失败（帮助/回执等普通信息不加警示色） |
| 正文 | 模型答复（Markdown 渲染） |
| 状态栏 | tokens · ctx 占用 · turns·steps · 模型名 · effort · cache 命中 · todo 进度 · 状态（耗时只在上方活动行以可读时长显示，如 1h 21m 30s） |

- 提交：回车；行尾单个 `\` 回车为多行续行；`Shift+Enter` / `Alt+Enter` 插入换行不提交（Shift+Enter 需终端键位绑定——Windows Terminal 首次用 `/terminal-setup` 自动配置，kitty 协议终端原生支持）；运行中继续输入自动排队。
- 图片附件：`Ctrl+V` 直读剪贴板图片（Windows 经 PowerShell/macOS 经 osascript/Linux 经 wl-paste→xclip 回退），或整行粘贴图片文件路径（复制文件后终端粘贴的路径文本自动转附件）；附件以 `[Image 1] [Image 2]` chips 显于输入行上侧，空缓冲 `Backspace` 逐个弹出，上限 8 张（溢出提示）；纯图无文本也可发送。发出后消息区按 Claude Code 形态显示 `[Image 1]` 占位标记（图上文下），图片本体经 dataURL 随消息进模型上下文（终端不渲染图片内容）；运行中带图输入自动排队，轮收束补跑不丢图。
- 历史回看：`Tab` 折叠/展开过程行（按正文与阶段分段折叠），`Ctrl+O` 展开当前一个轮次（自最近一次输入起）的全部工具与思考行详情全文。

**会话命令**（输入 `/` 后按 `Tab` 补全；命令只认裸形式，带参枚举形态与不在清单的命令统一回执「无法识别命令，使用 /help 查看使用方法」）

| 命令 | 作用 |
| --- | --- |
| `/help` | 命令清单 |
| `/init` | 分析项目，生成或补全 `SUNSHINE.md`（已存在时只补缺失项，不改动既有内容） |
| `/goal <目标>` | 标准验收修正环，见 5.2 |
| `/plan <目标>` | 先规划后执行，见 5.1 |
| `/status` | 会话与账本摘要 |
| `/terminal-setup` | 一键配置终端键位：Windows Terminal 写入 Shift+Enter 换行绑定并解绑 Alt+Enter（写前备份、幂等）；未找到 WT 时给 VSCode 指引 |
| `/tasks` | 列出后台任务（id/类型/状态/标签与输出文件路径，输出用 `read` 查看——GUI 任务面板附末 4KB 尾读；账本随会话持久化，重开/重启可回溯；后台 exec 与后台子智能体产生，模型以 `task_wait` / `task_stop` 等待或停止——仅台账 exec/spawn；板任务走 `agent_team_task_wait` / `agent_team_task_stop`，见 5.6） |
| `/skill` | 插入技能引用（浏览兜底）：选择卡列出可用技能（`↑`/`↓` 选择、输入即筛选、`Esc` 取消），选定把 `/技能id ` 插入输入框（可补意图后一并提交），不直接载入上下文 |
| `/<技能id>` | 技能软引用（消息内文本）：在消息中书写 `/技能id`（可后接任务意图），模型按 skills 清单匹配后经 `skill` 工具软加载；技能不再注册为命令、无 Tab 补全（命令面仅纯内置命令——2026-11-04 agents-teams 目录规格 §4） |
| `/model` | 切换模型：选择卡列出 `providers` 多源清单（`源/模型` 即选即切，首项标注「默认」（缺省模型=首源首模型）、当前项标注，对后续任务生效）；未配置 `providers` 时给配置指引 |
| `/mcp` | MCP 服务器面板：两级清单卡（名称/作用域/启用状态点/遮蔽标注/审批态，项目待确认服务器带「待确认」徽标与批准指引）；`/mcp enable|disable|approve|deny <名称>` 就地启停（写所在作用域 mcp.json）与项目批准阀审批（写全局 settings），执行后回显并重绘；新增/编辑经 `sunshinex mcp` 子命令 |
| `/agents` | 子智能体面板：两级位置清单卡（id/作用域/遮蔽标注/启用状态/描述）；`/agents enable|disable <id>` 就地启停（写所在作用域 agent.md enabled 行）；新增/编辑经 `sunshinex agents` 子命令 |
| `/teams` | 智能体团队面板：两级清单卡（id/作用域/遮蔽标注/启用状态/成员与缺失成员警示），只读——编辑经 GUI 设置（Agent Teams）或 CLI catalog API（面板不做表单）；消息中以 `$<agent-id>` 点名智能体、`#<team-id>` 引用团队（引用未匹配在册条目时发送侧给一条提示，原文照发） |
| `/plugins` | 插件面板：内置+用户两级清单卡（id/启用状态/来源段/平台可用性）；`/plugins enable|disable <id>` 写项目 settings 插件启用键；配置与安装经 `sunshinex plugins` 子命令 |
| `/providers` | 模型提供方面板：只读清单卡（源名/模型数/密钥槽在场状态/默认源标注）+ 编辑引导（`sunshinex providers` 子命令或 `$EDITOR settings.json`；面板不做表单） |
| `/model-tier` | 切换模型档位：选择卡三档即选即切（当前档标注，对后续任务生效）；各档实际选中的模型 = providers models 条目的 `tier` 标注（同档取第一，无标注回缺省模型） |
| `/model-effort` | 切换思考强度：选择卡七档 + default，回执实际生效档 |
| `/add-dir <目录>` | 向会话追加信任目录（读写同项目根，本会话内生效；另见 6.1 的 `--add-dir` 与配置面） |
| `/kb-index [目录]` | 构建知识库索引（缺省当前工作区；对目录内 md/txt 走计费 embedding，完成后 `kb_search` 本会话即时可用；同 `sunshinex kb-index`） |
| `/compact [关注点]` | 立即压缩上下文，可指定优先保留的内容；接近窗口上限时也会自动压缩 |
| `/context` | 上下文构成报表：各段（系统提示词稳定段 / SUNSHINE.md 指令 / 技能清单 / 记忆索引 / 压缩摘要 / 会话链 / 待注入技能块）的估算 token 大小与占窗口比例，会话链再按动作细分（task / reply / tool-call / tool-result…）；只读观测，不改变上下文 |
| `/memory` | 列出持久记忆 |
| `/memory-add <内容>` | 添加记忆（与自动提取同一写时闸门） |
| `/memory-rm` | 删除记忆：多选卡 Space 勾选、Enter 批删、Esc 取消；>8 条支持输入筛选（`Esc` 先清词再取消） |
| `/memory-gc` | 立即整理记忆 |
| `/memory-on` / `/memory-off` | 本会话开启/关闭持久记忆（`/new` 后恢复缺省） |
| `/rewind` | 回退当前会话到任意历史任务轮，见 5.4 |
| `/fork` | 从任意历史轮复制出平行会话，见 5.4 |
| `/btw <问题>` / `/side` | 辅助问答：fork 整档旁路一次性回答提问（答案以 `⪽` 旁白行落屏，主链上下文零污染）；`/side` 为 `/btw` 别名 |
| `/archive` | 归档当前会话：移出主列表与最近会话（档保留不删；TUI `/unarchive`、GUI 顶栏已归档徽标或左栏归档会话页可撤销）；运行中不可用 |
| `/unarchive` | 撤销归档：选择卡列出已归档会话（归档时间降序，输入即筛选），选中即撤销——会话回到主列表与 `/resume`；GUI 命令通道作用于当前会话（跨会话撤销走归档会话页） |
| `/delete` | 删除当前会话：须先 `/archive`（未归档时提示先归档）；清会话档全家（含面板私有档）并开新会话，不可恢复；运行中不可用 |
| `/new` | 新会话（清消息、待办与上下文；记忆与账本保留） |
| `/resume` | 恢复已保存会话：选择卡（`↑`/`↓` 选择、`Enter` 恢复、`Esc` 取消），>8 条支持输入筛选（`Esc` 先清词再取消）；消息、待办、档位、上下文与未投递排队行全还原 |

**任务形态与专项能力**各自成节：plan（5.1）、goal 验收修正环（5.2）、子智能体（5.3）、会话回退与分叉（5.4）、Worktree 隔离（5.5）；权限模式与审批（六）、中断与运行控制（七）、快捷键（八）。

## 五、任务形态与专项能力

### 5.1 plan 模式

计划模式是流程标记（非权限档）：武装后每次提交=调研 run（只读强制），模型调研完经 `exit_plan` 出牌，确认卡批准后**同一 run 无感继续实施**（无需重发任务）。`exit_plan` 是**通用提案工具**（2026-11-04）——任何权限档可调，审批面就是计划卡本体。

- `​/plan`（裸）= 切换到计划模式（武装，幂等可重复发送，任何状态可用——运行中武装对下一次提交生效）；输入框提示随之切换。`/plan off` 退出。
- **出牌协议（挂起工具）**：模型调研完经 `exit_plan` 工具显式提交计划（工具行显示计划名，点击可打开计划文件原文）；计划书同时落盘会话数据目录（`sessions/<会话id>.plan.md`，每轮修订覆盖写，删除会话随之清除）。出牌期间 run 不收口（界面保持运行中），裁决结果作为工具结果回喂。
- **确认卡按钮随当前档自适应**：只读域（计划模式 / 只读模式）三键——`y` 实施（工作区编辑，缺省档）/ `f` 实施（完全访问）/ `n` 重新计划附反馈；可写域（工作区编辑 / 完全访问）两键——`实施`（当前档，无落档切换）/ `重新计划`。批准即按所选档实施（可写域=维持本档），实施进度由模型经 `todo_write` 自主维护（批准时按计划书 Steps 播种）。`Esc` 放弃本轮；空反馈=放弃本轮。
- **重新计划环**：`n` 附反馈 → 模型原地修订 → 再次出牌 → 新卡替换旧卡（单槽不叠卡），自然迭代无轮次上限。
- `/plan <目标>` = 武装并立即按该目标规划。按会话状态三分：空闲立即规划；规划/确认卡在途 → 按新目标重新规划（旧流程中止、旧卡撤）；任务运行中 → 目标入队，当前任务收口后自动转规划（不中断在途工作）。
- 执行中待办卡默认只显示当前进行项，`Tab` 展开完整清单（✓ 已完成 / ▸ 进行中 / ○ 未开始）；待办卡实时跟随；某项失败即暂停剩余步骤并说明原因。

### 5.2 goal 验收修正环

`/goal <目标>`：目标即验收条件，模型逐轮自评（满足 / 未满足 / 不可满足），未满足轮的差距作为下轮指引。
复杂目标可内嵌 `（验收标准：…）` 多判据。判据服务不可用时自动重试 3 次后暂停；重跑 `/goal <同一目标>` 续走。

### 5.3 子智能体（spawn）

模型可派发子智能体并行处理独立子任务，过程不占用主链，只回写一行结论。

- 运行中：每个子智能体在输入框上方显示一行实时面板（`名 · 当前工具/任务`，多个子智能体多行并存）。
- 结束后：整段记录折叠进 `● [SPAWN]` 调用行（单行摘要含步数/耗时尾注）；`Ctrl+B` 浏览模式下 `Enter` 展开为 `▾` 头行 + 缩进转录全文（再按收拢）；`Tab` / `Ctrl+O` 可重放全文。
- 展开状态跨窗口缩放保留；`/resume` 恢复后回落折叠。
- 预算护栏：子智能体不设 token 硬顶（护栏交给步数与墙钟），需要限时配 `subagentTokenCap`（独享值，不继承主链剩余）；步数上限与主链同源（`maxSteps`）。
- 自定义角色：项目级放 `<项目>/.sunshinex/agents/{id}/agent.md`，全局级放 `~/.sunshinex/agents/{id}/agent.md`（frontmatter `name`、正文写职责）；可声明 `isolation: worktree` 获得独立工作树（见 5.5）。frontmatter 可选 `enabled`（缺省 `true`；`false` = 从注册表剔除，等同不存在，`/agents` 面板仍可见可再启用）。两级装载序 后装遮蔽：全局 → 项目新家（同名就近遮蔽）。历史旧位置 `<项目>/agents/` 在首次装载/列举时一次性自动迁入新家（同 id 撞新家按陈旧重复删旧副本），此后盘上只有标准两级。启停与增删改：`/agents` 面板或 `sunshinex agents` 子命令。
- 团队形态：`create_agent_teammate` 工具创建智能体团队成员（长驻，自主认领团队任务，见 5.6）；frontmatter `executor: external-cli` 交外部 CLI 执行体。

### 5.4 会话回退与分叉（/rewind · /fork）

**`/rewind` 回退**：回退当前会话到任意历史任务轮，恢复粒度=任务轮起点；锚点轮的输入自动回填输入框、可编辑重发；被回掉的后续轮次**保留在原会话**，`/resume` 随时找回。
恢复内容三选：

| 选项 | 范围 |
| --- | --- |
| `code and conversation` | 对话 + 代码 |
| `conversation only` | 仅对话 |
| `code only` | 仅代码 |

代码回退只跟踪 write / edit 工具改写的文件（pre-image 影子快照，存于数据目录 `sessions/_blobs/`）；exec 命令副作用与外部编辑不跟踪——**不是 git 替代**。

**`/fork` 分叉**：从任意历史轮复制出平行会话并切换过去，源会话原样保留；`/resume` 列表中分叉会话带 `↳ fork from …` 血缘标注。在 `/resume` 列表选中历史会话后还可选 `Fork from…`，从该会话的任意任务轮二次分叉（目标无需是当前会话）。

### 5.5 Worktree 隔离

把改动限制在独立 git 工作树内，主工作区零改动。三个入口：

| 入口 | 用法 |
| --- | --- |
| 启动旗标 | `--worktree[=<name>]`：启动即进入隔离树（裸旗标自动命名） |
| 会话内对话 | 说「在隔离 worktree 里做……」模型即调 worktree 工具 `create` 切换；`exit` 返回主工作区；`list` 查看登记（plan 模式下仅 `list` 可用） |
| 子智能体声明 | agent.md frontmatter `isolation: worktree` 或 spawn 入参声明，子智能体获得独立树；工作区非 git 仓时静默降级为主工作区执行 |

生命周期：树落数据目录 `worktrees/<name>/`、分支 `worktree-<name>` 从当前 HEAD 分叉。干净树随会话自动清理（含分支），脏树保留并标记待处置；CLI 非交互路径一律保留。

### 5.6 智能体团队与任务协作

任务清单：可设依赖（失败/取消自动拦住下游）与 `retryOf` 重试链；按会话 `journalId` 落盘（`data/teams/<journalId>/`），同会话重启恢复，`/new` 新会话空板。总开关 `agentTeams`（settings / `SUNSHINEX_AGENT_TEAMS`，缺省开）：关则不注册下列团队工具。

**模型工具**（`agentTeams` 开时注入）：`create_agent_team` → `create_agent_teammate` → `create_agent_team_task` / `update_agent_team_task` / `get_agent_team_board` / `send_agent_team_message`；等待与停止板任务用 `agent_team_task_wait` / `agent_team_task_stop`（与通用 `task_wait` / `task_stop` 分域——后者只服务 exec/spawn 台账）。

**对话操作**：

| 你说 | 效果 |
| --- | --- |
| 「拆成任务按依赖跑」 | 建任务，前置完成后自动开始 |
| 「t2 依赖 t1」 | 设置依赖：t1 终态前 t2 保持 pending（失败/取消拦住下游） |
| 「重跑 task-<id>」 | 取消旧任务后以 `retryOf` 重试（新任务接续依赖链） |
| 「取消 t4」 | 取消未开始的任务 |
| 「等跑完」 | 等待并汇报各任务结果 |

**Ctrl+T 团队看板**（与 `Ctrl+B` 互斥）：

| 键 | 作用 |
| --- | --- |
| `↑` / `↓` | 移动 |
| `Enter` | 无动作（任务行选择态；面板无审批卡——审批走会话对话流） |
| `Esc` | 退出 |

行示例：`○ 标题 ← task-run-tests-a8c1 @w1`（行首任务号不上屏，仅作内部锚点）——状态用全 TUI 统一符号：○ 待派 · ▸ 执行中 · ✓ 完成 · ✗ 失败 · ⊘ 取消；`@名字` 为执行者（已执行显实际执行者，未执行显指派）。

**智能体团队成员**（成员=上下文承载体：独立子会话+自有记忆，本身无生命周期、无停止概念；生命周期属于板任务——任务完成成员回归待命。智能体团队 = 多成员共享看板协作的形态，长驻分工用；小探查用 5.3 spawn 一次性子智能体即可；缺省上限 8，环境变量 `SUNSHINEX_MAX_TEAMMATES=<n>` 可调）：

| 操作 | 方法 |
| --- | --- |
| 开 | 「创建智能体团队成员 reviewer」（模型走 `create_agent_teammate`）；或指定 `.sunshinex/agents/{id}/agent.md` 注册角色作框定（项目级/全局级见 5.3） |
| 看 | `Ctrl+B` → `Enter` 转录（行 = `名字 · 当前任务`；转录内每轮任务为灰底内容带，`✉` 行为成员间交流） |
| 打断当前任务 | 转录页两次 `Ctrl+C`（只打断这一个任务，成员保留续认领）；或 `agent_team_task_stop <板任务 id>` / `agent_team_task_stop <成员名>` |
| 消息 | 成员间可互发（`send_agent_team_message`），转录可见 |
| 看板对照 | `Ctrl+B` 行 = `名字 · 当前任务`；`Ctrl+T` 行 = 任务 + 状态符号 + 执行者 |

**预算帽**：环境变量 `SUNSHINEX_TEAM_TOKEN_CAP=<tokens>`；用满后新任务排队，提示 `team budget exhausted`。

**外部执行体**：「交给 claude code 做」→ 只显示起止与结论；停法同上；机器无 claude 命令则任务失败并注明。

**流水线**：`sunshinex pipeline "<目标>"`（计划→开发→测试→评审→交付，交付前 `y/n`）。

## 六、权限档与审批

| 档 | 语义 |
| --- | --- |
| `read-only` | 仅非变异操作放行（读 / 搜索 / 问询 / 待办 / worktree 列表）；写与变异命令直接拒绝并附切档提示 |
| `acceptEdits`（缺省） | 信任域内写文件直放；域外写 / 联网 / 执行命令弹审批卡 |
| `full-access` | 未命中 deny 规则一律自动批准（受信场景；deny 规则与破坏性命令底线仍生效） |

**计划流程**：计划模式（`/plan`，见 5.1）——规划期权限临时覆盖为只读，产出计划书（Markdown）经确认卡批准（按钮随当前档自适应，只读域三选=实施·工作区编辑 / 实施·完全访问 / 重新计划）后同一 run 无感执行；`plan` 是流程标记而非权限档，批准即落所选档。

审批卡与确认卡均为选择器形态（对标 Claude Code）：`↑` / `↓` 移动高亮，`Space` / `Enter` 选定，数字 `1`–`3` 直达；单键快捷 `y` 放行一次 · `a` 本会话放行 · `n` 拒绝 仍然可用，`Esc` = 拒绝。

**AskQuestion 问询卡**：模型可经内置 `ask_question` 工具主动向你提问（单选 / 多选 / 「Other…」自由输入），键位同上（多选 `Space` 勾选、`Enter` 提交全部勾选）；`Esc` 放弃作答，模型收到「已跳过」并自行调整。无交互终端的 CLI 场景回落为编号输入，完全 headless 时自动按跳过处理。
任何模式下硬性拦截：破坏性命令（`dd` / `fdisk` / `shutdown` 等）与「下载即执行」管道。

### 6.1 读写范围

| 面 | 行为 |
| --- | --- |
| 读取 | 缺省全盘开放；`readFence` 开启后信任域外读取同样走审批（acceptEdits 档）/ 拒绝（其余档） |
| 写入 | 信任项目根与信任目录；越界写按权限档：acceptEdits 审批 / read-only 拒 / full-access 放行 |
| 会话放行 | 写审批选 `a`（本会话放行）按**目录**登记，同目录后续写免批 |

信任目录运行期追加：TUI 内 `/add-dir <目录>`，或启动参数 `--add-dir=<目录>`（可重复）；也可配置进 `settings.json` 的 `permissions.additionalDirs`。

### 6.2 规则面（permissions）

`settings.json` 的 `permissions` 键（见第二节字段表）在审批之上叠加规则：

| 键 | 行为 |
| --- | --- |
| `deny` | 命中即拒；两级合并取并集，项目级不可解除全局级 |
| `allow` | 命中免审批 |

规则语法 `Tool(specifier)`：

| 工具面 | specifier 形态 |
| --- | --- |
| 文件工具（Write/Read/Edit） | 路径 glob：`**` 跨段、`*` 不跨段、无 `/` 对文件名匹配（相对项目根） |
| `Bash(...)` | 命令匹配，尾 `*` 为前缀通配 |
| `mcp__<server>__<tool>` | 直名，尾 `*` 通配 |

### 6.3 命令执行沙箱

| 键 | 语义 |
| --- | --- |
| `sandbox` | Linux 下命令执行经 Landlock 内核围栏；`off` 一键关 |
| `isolation` | 隔离口径 `landlock` / `container` / `host`，留空自动探测（selfcheck 上屏） |

known-issue（older Landlock ABI）：较旧内核下如遇 git 或写设备类命令在沙箱内失败，先设置 `SUNSHINEX_SANDBOX=off` 重试即可恢复，并向上游回报该环境信息。

### 6.4 插件（plugins）

插件把进程外 MCP server（浏览器操作、桌面操作等能力）包成可开关的治理单元：manifest 声明贡献什么、默认开不开、工具分几级审批。安装 = 把插件目录放进插件根，卸载 = 删除；`sunshinex plugins list` 看装载结果，`sunshinex plugins validate <目录>` 校验（开发细节见 `docs/PLUGIN-DEV.md`）。

| 根 | 位置 | 说明 |
| --- | --- | --- |
| 内置 | `<安装目录>/plugins/<id>/` | 随包分发 |
| 用户级 | `~/.sunshinex/plugins/<id>/` | 自装插件；同 id 遮蔽内置 |

**目标机安装步骤（内置插件带依赖时）**：包分发不含深层 `node_modules`（npm 打包恒剔除各级 `node_modules`，插件目录到手只剩 manifest/README/package.json）。**两内置插件均已单文件束化**（依赖图内联进各自单文件束，browser-use 现为 `server/index.js`+`server/host.js` 双束（host 为启动入口），目标机零补装——computer-use 用系统 powershell；browser-use 用系统 Chrome，均系统 node 即可）；自装插件依赖在目标机**首次启用前**补装（`pnpm --dir <插件目录> install` 或 npm 同义）。启用失败的表现：会话装配时该 server 连接失败，警告单出现 `assembly failed (browser-use): …`——降级语义，只损失此单 server 的工具，会话照常不中断；补装后**新开会话**即恢复。浏览器形态按运行环境自动定：桌面端（Electron）用内置侧栏页签（builtin）、网页端（serve）用系统默认浏览器（default）、命令行/TUI 用无头浏览器（headless，系统已装 Chrome 通道）——无须配置，也无须另下内核。

**仓库工作区形态（当前版）**：两束产物 gitignore 不入库——checkout 后在插件目录跑一次 `node build.mjs`（`plugins/browser-use`、`plugins/computer-use` 各一，esbuild 构建出 `server/index.js` 与 `server/host.js`——后者为 browser-use manifest 启动入口），否则启用即 `assembly failed`；发版链 `scripts/release.mjs` 已前置该构建，开发机手动跑即可。

**启用/禁用**（改完对新会话生效，运行中会话不热切换）：

| 方式 | 操作 |
| --- | --- |
| GUI | 设置页「插件」卡片开关（平台不支持置灰；manifest 非法的插件在 pane 尾以告警徽标列出） |
| 手编 settings.json | `plugins` 语义键（见第二节字段表）：`"plugins": { "<id>": { "enabled": true, "config": {} } }`；两级文件项目遮蔽全局，未配置的插件用 manifest `defaultEnabled`（缺省关） |

用户级插件 `config` 原样透传（装配期与 manifest 缺省合并后展开为启动参数/环境变量），`configSchema` 各键含义见设置页展示；内置插件只有开关（settings 遗留 config 一律不生效，设置页内置卡无配置入口）。

**安全与信任模型**：插件作者在 manifest 里对工具自声明三类风险，审批按声明驱动（`permissions.deny` 规则可随时覆盖，规则写法 `mcp__<server>__*`）：

| 声明类别 | 语义 | 审批行为 |
| --- | --- | --- |
| `act` | 有副作用的动作 | 任何权限档都弹审批（`full-access` 也不例外）；`read-only` 档直接拒 |
| `confirm` | 读但隐私敏感 / 高频 | 走常规审批，选 `a` 本会话一次放行 |
| `observe` | 纯只读 | 各档位直放 |

未声明安全类别的插件工具走常规 MCP 审批——fail-closed 兜底，如 computer-use 的 `wait`/`wait_for` 即未声明（纯延时/轮询无直接 IO 副作用，仍照走审批）；总开关 = 插件开关——禁用即工具不存在。**安装第三方插件 = 信任其进程**（以你的用户身份运行），只装可信来源；内置插件缺省全部关闭，显式开启才生效。

## 七、中断与运行控制

- 运行状态实时显示：任务运行中，输入框上方状态行分三态——思考中（帧动画 + 耗时）、工具执行前/审批挂起（`● [工具名]` 逐调用一行，审批挂起标注 awaiting approval）、正文输出中（静默，流式正文即状态）；调用完成即转为消息流中的结果行。

| 动作 | 效果 |
| --- | --- |
| 运行中 `Ctrl+C` | 第一次挂暂停提示（任务不停）；提示在场再按 `Ctrl+C` 中断当前任务回输入态——主链连带子智能体一并中断（已完成步骤保留在会话链上，续输新任务即可继续） |
| 运行中 `Esc` | 暂停提示在场=撤提示继续跑；否则中断当前任务回输入态 |
| 待审批 / 待确认计划时 `Esc` | 按拒绝 / 放弃处理 |
| 运行中输入自然语言 | 自动排队，任务收口后按序执行（穿插提示词） |
| 运行中且输入为空按 `↑` | 撤回全部未投递的排队行回输入框，可编辑重排或清空丢弃；已插入上下文的行不可撤回 |
| 中断（`Ctrl+C` 再按 / `Esc`） | 当前任务停止；已排队未投递的行一并丢弃（回执提示条数） |

**`Ctrl+Q` 排队管理面板**（查看与编辑等待队列，运行中/空闲均可开，`Esc` 关闭）：

| 键 | 作用 |
| --- | --- |
| `↑` / `↓` | 选择条目（`序号. 文本`；带「插入发送」标记的为置首条，下一步立即注入当前轮） |
| `E` | 内联编辑该条（`Enter` 提交、`Esc` 撤改） |
| `D` | 删除该条 |
| `I` | 插入新条目（输入行回车入队） |
| `N` | 直接发送：撤出该条并中断当前轮，立即作为新任务提交 |
| `F` | 置首为「插入发送」 |
| `Ctrl+↑` / `Ctrl+↓` | 上移 / 下移重排 |

队列随会话存档：`/resume` 恢复未投递排队行；serve 模式下 daemon 重启队列保留。

任务由完成判定驱动，护栏只兜底：步数（`maxSteps`）触界终止、墙钟触界失败、token 硬顶（`maxTokens` / `subagentTokenCap`）缺省**不设**、显式配置后触界暂停（可续跑，回执含用量明细）。

## 八、快捷键

| 按键 | 作用 |
| --- | --- |
| `Enter` | 提交（行尾 `\` 续行） |
| `Shift+Enter` / `Alt+Enter` | 插入换行不提交（Shift+Enter 需终端键位绑定，Windows Terminal 首次用 `/terminal-setup` 自动配置；kitty 协议终端原生支持） |
| `Ctrl+V` | 粘贴图片：直读系统剪贴板图片转为附件 chip（`[Image 1]`…，≤8 张）；剪贴板无图给提示。粘贴图片**文件路径**文本同样自动转附件 |
| `Backspace`（空输入时） | 弹出最后一个图片附件 chip |
| `Tab` | `/` 开头时补全命令；否则切换历史折叠 / 展开（含待办卡） |
| `Ctrl+O` | 展开当前一个轮次（自最近一次输入起）的全部工具与思考行全文 |
| `Ctrl+B` | 子智能体浏览模式：`↑/↓` 在 SPAWN 调用行间移动高亮，`Enter` 展开/折叠该行（思考与工具转录），`Esc` 退出；运行中不可进入 |
| `Ctrl+T` | 智能体团队看板：`↑/↓` 在任务行间移动，`Enter` 于门挂起（⚠）行弹 approve / deny 审批卡，`Esc` 退出；与 `Ctrl+B` 互斥（见 5.6） |
| `Ctrl+Q` | 排队管理面板：查看 / 编辑 / 删除 / 插入 / 直接发送 / 置首 / 重排等待队列（见第七节） |
| `↑` / `↓` | 输入历史（最近 100 条）；运行中且输入为空：`↑` 撤回排队（见第七节） |
| `←` / `→`、`Home` / `End` | 光标移动（`Ctrl+A` / `Ctrl+E` 跳首尾） |
| `Backspace` / `Delete` | 删除字符 |
| `Ctrl+C` | 退出（运行中第一次挂暂停提示、再按中断，见第七节） |

## 九、故障排查

| 现象 | 处理 |
| --- | --- |
| 启动报模型错误 / 答复均为错误 | 检查 `settings.json` 的 `providers`（首源 `baseUrl` 与 `env` 密钥槽，全局或项目级）；`/model` 切换后报错则检查该源的 `baseUrl` 与对应密钥槽（`providers test <源>` 可探活） |
| 启动告警「未知语义键 "model" / "dataDir" …」 | 形近历史键与拼错键同判（告警不致命）——模型配置改写 `providers` 列表（见第二节）；未配 providers 时 env 直导出形态仍可用 |
| 输入没反应 | 正在等待审批或计划确认：按 `y` / `a` / `n` |
| 写操作总被拒 | 当前是 `read-only` 档：重启以 `--mode=acceptEdits`（或缺省档）启动 |
| 看不到思考过程 | 端点未回传 reasoning 字段，属正常降级，不影响答复 |
| 窗口缩放后花屏 / 残影 | 微调窗口大小再触发一次整屏重绘 |
| 想回看很久之前的内容 | 终端滚动缓冲保留全部输出；`Tab` / `Ctrl+O` 展开查看 |
| 恢复旧会话报「journal 版本不受支持」 | 会话档已升级 v3 段级格式且不保旧档（开发期裁定，仅认 v:3）；删除数据目录 `sessions/` 下旧档即可（`node scripts/purge-legacy-sessions.mjs` 可列出/`--delete` 清理） |
