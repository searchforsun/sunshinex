# SunshineX 使用手册（CLI + TUI）

终端里的 AI Agent：用自然语言下任务，模型流式作答、工具实时执行，写操作需你审批，复杂目标先规划后执行。

本手册覆盖 CLI 启动与 TUI 交互全量用法；架构、开发与部署见 [README.md](README.md)。

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
npm install -g https://github.com/searchforsun/sunshinex/releases/download/v0.2.0/sunshinex-agent-0.2.0.tgz
# npm ≥ 12 报 EALLOWREMOTE（allow-remote 缺省 none）时二选一：
#   加开关：npm install -g --allow-remote=all <上面的链接>
#   或先下载再本地装（allow-file 缺省 all，不受此限）：curl -LO <链接> && npm install -g ./sunshinex-agent-0.2.0.tgz
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

**启动参数**（全部命令通用）

| 参数 | 说明 |
| --- | --- |
| `--mode=manual\|plan\|dontAsk` | 权限模式，缺省 `manual`（见第六节） |
| `--language=en\|zh` | 界面语言，缺省 `en`；只影响界面，模型侧文本恒英文 |
| `--tier=small\|medium\|large` | 模型档位，缺省 `medium`；会话内可用 `/model` 切换 |
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

生效优先级（高 → 低）：**已导出环境变量 > 项目 settings.json > 全局 settings.json > 内置缺省**。修改配置后新开会话生效。

最小可用配置（可直接复制使用）：

```json
{
  "version": 1,
  "model": "glm-5.3-flash",
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "env": { "SUNSHINEX_API_KEY": "sk-…" }
}
```

下面是**全部可配置项**（供查改；`//` 与 `/* */` 注释可原样保留——settings.json 容忍 JSONC 注释；尾随逗号不在此列、仍按严格 JSON 报错；不需要的项整行删除即用缺省）：

```jsonc
{
  "version": 1,

  // ── 模型 ──────────────────────────────────────────────
  "model": "glm-5.3-flash",                          // 主模型（任意 OpenAI 协议兼容模型）
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4", // 模型端点
  "tier": "medium",                                  // 缺省档位 small|medium|large
  "modelSmall": "",                                  // 各档绑定的模型；留空 = 该档用主模型
  "modelMedium": "",
  "modelLarge": "",
  "contextWindow": 200000,                           // 模型最大上下文 tokens（状态栏 ctx 分母；1M 模型填 1000000）
  "reasoningEffort": "high",                         // 缺省思考强度 none|minimal|low|medium|high|xhigh|max；留空 = 不下发（用端点默认）；端点不支持时按阶梯自动降级

  // ── 长任务 ────────────────────────────────────────────
  "maxSteps": 400,                                  // Reactor 单 run 步数上限
  "maxLoopIterations": 200,                         // Loop 修正环节点执行步上限
  "maxGraphNodes": 1000,                            // Graph 全链路节点步累计上限

  // ── 界面 ──────────────────────────────────────────────
  "language": "en",                                  // 界面语言 en|zh（--language 参数优先）

  // ── 记忆与技能沉淀 ────────────────────────────────────
  "autoMemory": "on",                                // 持久记忆总开关 on|off
  "learnedSkills": "on",                             // 技能沉淀开关 on|off
  "learnedSkillLimit": 50,                           // 沉淀技能条数上限（1..1000）
  "memoryIdleKickMs": 300000,                        // 后台沉淀的空闲兜底节拍（毫秒）
  "stepDigestMaxSteps": 20,                          // 后台提取的材料预算，一般无需修改
  "stepDigestItemChars": 120,
  "stepDigestTotalChars": 1500,

  // ── 知识库 / 嵌入 / 搜索 ──────────────────────────────
  "kbBackend": "local-json",                         // local-json | sqlite-vec
  "kbDataDir": "",                                   // 知识库目录；留空 = 数据目录/kb
  "embeddingBaseUrl": "",                            // 嵌入服务；留空 = 回退主模型同名字段
  "embeddingModel": "",
  "websearchProvider": "duckduckgo",                 // duckduckgo | bing
  "websearchEndpoint": "",                           // 搜索端点覆盖；留空 = 提供方缺省

  // ── 目录覆盖（留空即用缺省，见第三节）────────────────
  "projectsDir": "",                                 // 项目数据根（各工作区分目录的父级）；留空 = ~/.sunshinex/projects，可指向任意盘
  "userSkillsDir": "",                               // 全局技能目录
  "globalSunshine": "",                              // 全局约定文件
  "shell": "",                                       // 命令执行 shell（POSIX 兼容）；Windows 留空自动探测 Git Bash，无则 PowerShell，末位 cmd 兜底

  // ── 权限规则与信任目录（deny/allow 语法见「六、权限模式与审批」）──
  "permissions": {
    "deny": ["Write(*.pem)", "Bash(rm -rf*)", "Read(**/.env)"],  // 命中即拒；两级合并取并集，项目级不可解除全局级
    "allow": ["Write(src/**)"],                                  // 命中免审批
    "additionalDirs": ["../lib-shared"]                          // 信任目录：读写同项目根；运行期经 /add-dir、--add-dir 追加
  },

  // ── 安全语义键 ────────────────────────────────────────
  "readFence": "off",                                // 开启后信任域外读取也需审批（manual 档）/ 拒绝（其余档）
  "sandbox": "on",                                   // Linux 下 exec 经 Landlock 内核围栏；off 一键关
  "isolation": "",                                   // 隔离口径声明 landlock|container|host；留空自动探测（selfcheck 上屏）

  // ── 密钥（只写这里）──────────────────────────────────
  "env": {
    "SUNSHINEX_API_KEY": "sk-…",                     // 模型密钥（必填）
    "SUNSHINEX_EMBEDDING_API_KEY": "",               // 嵌入密钥；留空 = 回退主密钥
    "SUNSHINEX_BING_API_KEY": ""                     // Bing 搜索密钥（websearchProvider=bing 时用）
  }
}
```

- 语义键与同名 `SUNSHINEX_*` 环境变量一一对应（`model` ≡ `SUNSHINEX_MODEL`），环境变量仍最高优先。
- 空串等价未配置；密钥类一律只放 `env` 块。
- JSON 写错或 `version` 非 1：启动即报错并指出文件路径；未知键告警后忽略。

### MCP 服务器（mcp.json）

MCP 服务器登记在项目级 `.sunshinex/mcp.json` 与全局级 `~/.sunshinex/mcp.json`（`mcpServers` 键，与主流 MCP 客户端格式兼容；项目级同名条目遮蔽全局，与技能装载链同构；登记表为空 = MCP 工具全禁）：

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "ghp_…" } },
    "remote": { "url": "https://mcp.example.com/v1", "transport": "http" }
  }
}
```

- stdio 形态：`command` + 可选 `args` / `env`（transport 可省略）；远程形态：`url` + 可选 `transport`（缺省 `http`，支持 `sse`）。
- 非法条目跳过不抛（缺 command/url、transport 值未知、形态矛盾），装配面宁可少配不错配。

## 三、目录与文件

**全局级 `~/.sunshinex/`**

```
~/.sunshinex/
├── settings.json               # 全局配置（第二节）
├── mcp.json                    # 全局 MCP 服务器登记（被项目级 .sunshinex/mcp.json 同名遮蔽）
├── SUNSHINE.md                 # 个人全局约定，跨所有项目生效（对标 ~/.claude/CLAUDE.md）
├── skills/<id>/SKILL.md        # 全局技能，跨项目共享
└── projects/<工作区>/data/     # 各项目的运行时数据（按启动目录自动隔离）
    ├── sessions/               # 会话日志（/resume、--resume、--continue 据此恢复）
    ├── memory/                 # 持久记忆：MEMORY.md 索引 + <slug>.md 记录
    ├── skills/                 # 自动沉淀的学习技能
    ├── worktrees/              # worktree 隔离工作树（见 5.5）与登记表 registry.json
    ├── runs/                   # 任务账本（/status 与状态栏统计）
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
│   ├── mcp.json                # 项目级 MCP 服务器登记（同名遮蔽全局；可提交入库共享）
│   └── skills/<id>/SKILL.md    # 项目技能
└── 兼容技能根（可选；同名技能按下述优先级就近生效）
    ├── .agents/skills/<id>/SKILL.md   # 优先级：.sunshinex > .agents > .claude > .codex > .cursor
    ├── .claude/skills/<id>/SKILL.md
    ├── .codex/skills/<id>/SKILL.md
    └── .cursor/skills/<id>/SKILL.md
```

- 技能标准形态统一为 `{根}/skills/{id}/SKILL.md`，正文前 frontmatter 写 `name` 与 `description`。
- 技能生效顺序：项目级 > 全局级 > 学习级（沉淀产物垫底）。
- 文件读取缺省全盘开放；写入信任项目根与已登记信任目录，越界写走审批或拒绝（详见第六节）。

## 四、基本用法

| 界面元素 | 含义 |
| --- | --- |
| `░` | 你的输入 |
| `✻ Thought for Ns` | 思考摘要（`Tab` 展开） |
| `● [VERB]` / `⎿ ✓` `⎿ ✗` | 工具调用行 / 结果行 |
| 系统提示行 | 状态回执（暗色）；`!` 黄色为警示、`✗` 红色为失败（帮助/回执等普通信息不加警示色） |
| 正文 | 模型答复（Markdown 渲染） |
| 状态栏 | tokens · ctx 占用 · turns·steps · 模型名 · cache 命中 · todo 进度 · 状态（耗时只在上方活动行以可读时长显示，如 1h 21m 30s） |

- 提交：回车；行尾单个 `\` 回车为多行续行；运行中继续输入自动排队。
- 历史回看：`Tab` 折叠/展开过程行（按正文与阶段分段折叠），`Ctrl+O` 展开最近一组的详情全文。

**会话命令**（输入 `/` 后按 `Tab` 补全；命令只认裸形式，带参枚举形态与不在清单的命令统一回执「无法识别命令，使用 /help 查看使用方法」）

| 命令 | 作用 |
| --- | --- |
| `/help` | 命令清单 |
| `/init` | 分析项目，生成或补全 `SUNSHINE.md`（已存在时只补缺失项，不改动既有内容） |
| `/goal <目标>` | 标准验收修正环，见 5.2 |
| `/plan <目标>` | 先规划后执行，见 5.1 |
| `/status` | 会话与账本摘要 |
| `/tasks` | 列出后台任务（id/类型/状态/标签与输出文件路径；后台 exec 与后台子代理产生，模型以 `read` 查看输出、以 `task_stop` 工具停止） |
| `/skill` | 加载技能进上下文：选择卡列出可用技能（`↑`/`↓` 选择、输入即筛选、`Esc` 取消），选定即载入、本会话重复加载回执已加载 |
| `/<技能id>` | 技能即命令：裸形式仅加载（语义同 `/skill` 选定）；带意图 `/<id> <意图>` 加载后一步派发任务；撞名内置命令的技能不注册（内置优先，仍经 `/skill` 卡加载）；命令 token=技能 id，限 `[a-z0-9][a-z0-9_-]*`；Tab 补全与 `/help` 技能段同步列出 |
| `/model` | 切换模型档位：选择卡三档即选即切（当前档标注，对后续任务生效） |
| `/model-effort` | 切换思考强度：选择卡七档 + default，回执实际生效档 |
| `/compact [关注点]` | 立即压缩上下文，可指定优先保留的内容；接近窗口上限时也会自动压缩 |
| `/memory` | 列出持久记忆 |
| `/memory-add <内容>` | 添加记忆（与自动提取同一写时闸门） |
| `/memory-rm` | 删除记忆：多选卡 Space 勾选、Enter 批删、Esc 取消；>8 条支持输入筛选（`Esc` 先清词再取消） |
| `/memory-gc` | 立即整理记忆 |
| `/memory-on` / `/memory-off` | 本会话开启/关闭持久记忆（`/new` 后恢复缺省） |
| `/rewind` | 回退当前会话到任意历史任务轮，见 5.4 |
| `/fork` | 从任意历史轮复制出平行会话，见 5.4 |
| `/new` | 新会话（清消息、待办与上下文；记忆与账本保留） |
| `/resume` | 恢复已保存会话：选择卡（`↑`/`↓` 选择、`Enter` 恢复、`Esc` 取消），>8 条支持输入筛选（`Esc` 先清词再取消）；消息、待办、档位与上下文全还原 |

**任务形态与专项能力**各自成节：plan（5.1）、goal 验收修正环（5.2）、子代理（5.3）、会话回退与分叉（5.4）、Worktree 隔离（5.5）；权限模式与审批（六）、中断与运行控制（七）、快捷键（八）。

## 五、任务形态与专项能力

### 5.1 plan 模式

`/plan <目标>` → 生成计划确认卡（选择器形态：`↑` / `↓` 移动，`Enter` / `Space` 选定）→ `y` 或选「执行计划」逐项执行（`▶ Step n/N`），`n` / `Esc` 放弃。
执行中待办卡默认只显示当前进行项，`Tab` 展开完整清单（✓ 已完成 / ▸ 进行中 / ○ 未开始）；运行中模型可经 `todo_write` 工具自主维护清单（全量替换、同刻恰一项进行中），待办卡实时跟随；某项失败即暂停剩余步骤并说明原因。

### 5.2 goal 验收修正环

`/goal <目标>`：目标即验收条件，模型逐轮自评（满足 / 未满足 / 不可满足），未满足轮的差距作为下轮指引。
复杂目标可内嵌 `（验收标准：…）` 多判据。判据服务不可用时自动重试 3 次后暂停；重跑 `/goal <同一目标>` 续走。

### 5.3 子代理（spawn）

模型可派发子代理并行处理独立子任务，过程不占用主链，只回写一行结论。

- 运行中：每个子代理在输入框上方显示 4 行实时面板。
- 结束后：整段记录折叠进 `● [SPAWN]` 调用行（单行摘要含步数/耗时尾注）；`Ctrl+B` 浏览模式下 `Enter` 展开为 `▾` 头行 + 缩进转录全文（再按收拢）；`Tab` / `Ctrl+O` 可重放全文。
- 展开状态跨窗口缩放保留；`/resume` 恢复后回落折叠。
- 自定义角色：放 `agents/{id}/agent.md`（frontmatter `name`、正文写职责）；可声明 `isolation: worktree` 获得独立工作树（见 5.5）。

### 5.4 会话回退与分叉（/rewind · /fork）

**`/rewind` 回退**：回退当前会话到任意历史任务轮，恢复粒度=任务轮起点；锚点轮的输入自动回填输入框、可编辑重发；被回掉的后续轮次**保留在原会话**，`/resume` 随时找回。
恢复内容三选：

| 选项 | 范围 |
| --- | --- |
| `code and conversation` | 对话 + 代码 |
| `conversation only` | 仅对话 |
| `code only` | 仅代码 |

代码回退只跟踪 write 工具改写的文件（pre-image 影子快照，存于数据目录 `sessions/_blobs/`）；exec 命令副作用与外部编辑不跟踪——**不是 git 替代**。

**`/fork` 分叉**：从任意历史轮复制出平行会话并切换过去，源会话原样保留；`/resume` 列表中分叉会话带 `↳ fork from …` 血缘标注。

### 5.5 Worktree 隔离

把改动限制在独立 git 工作树内，主工作区零改动。三个入口：

| 入口 | 用法 |
| --- | --- |
| 启动旗标 | `--worktree[=<name>]`：启动即进入隔离树（裸旗标自动命名） |
| 会话内对话 | 说「在隔离 worktree 里做……」模型即调 worktree 工具 `create` 切换；`exit` 返回主工作区；`list` 查看登记（plan 模式下仅 `list` 可用） |
| 子代理声明 | agent.md frontmatter `isolation: worktree` 或 spawn 入参声明，子代理获得独立树；工作区非 git 仓时静默降级为主工作区执行 |

生命周期：树落数据目录 `worktrees/<name>/`、分支 `worktree-<name>` 从当前 HEAD 分叉。干净树随会话自动清理（含分支），脏树保留并标记待处置；CLI 非交互路径一律保留。


## 六、权限模式与审批

| 模式 | 语义 |
| --- | --- |
| `manual`（缺省） | 只读自动放行；写文件 / 联网 / 执行命令弹审批卡 |
| `plan` | 只读模式，写操作直接拒绝 |
| `dontAsk` | 自动批准（受信场景） |

审批卡与确认卡均为选择器形态（对标 Claude Code）：`↑` / `↓` 移动高亮，`Space` / `Enter` 选定，数字 `1`–`3` 直达；单键快捷 `y` 放行一次 · `a` 本会话放行 · `n` 拒绝 仍然可用，`Esc` = 拒绝。

**AskQuestion 问询卡**：模型可经内置 `ask_question` 工具主动向你提问（单选 / 多选 / 「Other…」自由输入），键位同上（多选 `Space` 勾选、`Enter` 提交全部勾选）；`Esc` 放弃作答，模型收到「已跳过」并自行调整。无交互终端的 CLI 场景回落为编号输入，完全 headless 时自动按跳过处理。
任何模式下硬性拦截：破坏性命令（`dd` / `fdisk` / `shutdown` 等）与「下载即执行」管道。

### 6.1 读写范围

| 面 | 行为 |
| --- | --- |
| 读取 | 缺省全盘开放；`readFence` 开启后信任域外读取同样走审批（manual 档）/ 拒绝（其余档） |
| 写入 | 信任项目根与信任目录；越界写按权限模式：manual 审批 / plan 拒 / dontAsk 放行 |
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

## 七、中断与运行控制

- 运行状态实时显示：任务运行中，输入框上方状态行分三态——思考中（帧动画 + 耗时）、工具执行前/审批挂起（`● [工具名]` 逐调用一行，审批挂起标注 awaiting approval）、正文输出中（静默，流式正文即状态）；调用完成即转为消息流中的结果行。

| 动作 | 效果 |
| --- | --- |
| 运行中 `Esc` / `Ctrl+C` | 中断当前任务回输入态（已完成步骤保留在会话链上，续输新任务即可继续） |
| 待审批 / 待确认计划时 `Esc` | 按拒绝 / 放弃处理 |
| 运行中输入自然语言 | 自动排队，任务收口后按序执行（穿插提示词） |
| 运行中且输入为空按 `↑` | 撤回全部未投递的排队行回输入框，可编辑重排或清空丢弃；已插入上下文的行不可撤回 |
| 退出 | 空闲时清空输入再按 `Ctrl+C` |
| 不识别的命令 | 回执「无法识别命令，使用 /help 查看使用方法」（warn 级；命令只认 /help 所列形态） |

## 八、快捷键

| 按键 | 作用 |
| --- | --- |
| `Enter` | 提交（行尾 `\` 续行） |
| `Tab` | `/` 开头时补全命令；否则切换历史折叠 / 展开（含待办卡） |
| `Ctrl+O` | 展开最近一组的详情全文 |
| `Ctrl+B` | 子代理浏览模式：`↑/↓` 在 SPAWN 调用行间移动高亮，`Enter` 展开/折叠该行（思考与工具转录），`Esc` 退出；运行中不可进入 |
| `↑` / `↓` | 输入历史（最近 100 条）；运行中且输入为空：`↑` 撤回排队（见第七节） |
| `←` / `→`、`Home` / `End` | 光标移动（`Ctrl+A` / `Ctrl+E` 跳首尾） |
| `Backspace` / `Delete` | 删除字符 |
| `Ctrl+C` | 退出（运行中为中断当前任务，见第七节） |

## 九、故障排查

| 现象 | 处理 |
| --- | --- |
| 启动报模型错误 / 答复均为错误 | 检查 `settings.json` 的 `model`、`baseUrl` 与 `env.SUNSHINEX_API_KEY`（全局或项目级） |
| 输入没反应 | 正在等待审批或计划确认：按 `y` / `a` / `n` |
| 写操作总被拒 | 当前是 `plan` 只读模式：重启换 `--mode=manual` |
| 看不到思考过程 | 端点未回传 reasoning 字段，属正常降级，不影响答复 |
| 窗口缩放后花屏 / 残影 | 微调窗口大小再触发一次整屏重绘 |
| 想回看很久之前的内容 | 终端滚动缓冲保留全部输出；`Tab` / `Ctrl+O` 展开查看 |
��部输出；`Tab` / `Ctrl+O` 展开查看 |
