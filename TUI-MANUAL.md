# SunshineX TUI 使用手册

终端里的 AI Agent：用自然语言下任务，模型流式作答、工具实时执行，写操作需你审批，复杂目标先规划后执行。

要求：Node.js ≥ 22.9。

## 一、安装与启动

**源码运行**

```bash
pnpm install           # 首次安装
pnpm cli tui           # 启动（内置构建，无需单独 build）
pnpm cli tui <目录>    # 在指定项目目录打开会话
pnpm cli selfcheck     # 骨架自检
pnpm test              # 全量单测
```

**正式安装（npm 全局）**

```bash
npm install -g https://github.com/searchforsun/sunshinex/releases/download/v0.1.0/sunshinex-agent-0.1.0.tgz
sunshinex              # 任意目录直接进入终端
sunshinex <目录>       # 指定项目目录（= sunshinex tui <目录>）
```

**启动参数**

| 参数 | 说明 |
| --- | --- |
| `--mode=manual\|plan\|dontAsk` | 权限模式，缺省 `manual`（见第五节） |
| `--language=en\|zh` | 界面语言，缺省 `en`；只影响界面，模型侧文本恒英文 |
| `--tier=small\|medium\|large` | 模型档位，缺省 `medium`；会话内可用 `/model` 切换 |
| `--continue` | 续接最近一次会话 |

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

下面是**全部可配置项**（供查改；注释仅供说明，实用时请连同注释一并删除，不需要的项整行删除即用缺省）：

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
  "structuredOutput": "json_schema",                 // json_schema | json（端点不支持时用） | off

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
  "dataDir": "",                                     // 运行时数据目录；整目录直指，优先级高于 projectsDir
  "userSkillsDir": "",                               // 全局技能目录
  "globalSunshine": "",                              // 全局约定文件
  "shell": "",                                       // 命令执行 shell（POSIX 兼容）；Windows 留空自动探测 Git Bash，无则 PowerShell，末位 cmd 兜底

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

## 三、目录与文件

**全局级 `~/.sunshinex/`**

```
~/.sunshinex/
├── settings.json               # 全局配置（第二节）
├── SUNSHINE.md                 # 个人全局约定，跨所有项目生效（对标 ~/.claude/CLAUDE.md）
├── skills/<id>/SKILL.md        # 全局技能，跨项目共享
└── projects/<工作区>/data/     # 各项目的运行时数据（按启动目录自动隔离）
    ├── sessions/               # 会话日志（/resume、--continue 据此恢复）
    ├── sessions-active.json    # 最近会话指针
    ├── memory/                 # 持久记忆：MEMORY.md 索引 + <slug>.md 记录
    ├── skills/                 # 自动沉淀的学习技能
    ├── runs/                   # 任务账本（/status 与状态栏统计）
    ├── kb/                     # 知识库数据
    ├── tool-outputs/           # 超长工具输出的完整原文（正文只留预览 + 路径）
    └── archives/               # 压缩时折叠的链行归档
```

`projects/` 这一层不限家目录所在盘：`projectsDir` 指到哪，各工作区的数据就落哪（如 `"projectsDir": "D:\\sunshinex-projects"`），逐工作区分目录的隔离与防撞名语义不变——家目录分区吃紧或想把运行数据放独立盘时用。需要整目录直指单个位置时用 `dataDir`（优先级更高，不再按工作区分目录）。两者都留空即缺省形态。

**项目级 `<项目>/`**

```
<项目>/
├── SUNSHINE.md                 # 项目约定（/init 生成或手写）
├── .sunshinex/
│   ├── settings.json           # 项目级配置（覆盖全局；已在 .gitignore）
│   └── skills/<id>/SKILL.md    # 项目技能
└── 兼容技能根（可选；同名技能按下述优先级就近生效）
    ├── .agents/skills/<id>/SKILL.md   # 优先级：.sunshinex > .agents > .claude > .codex > .cursor
    ├── .claude/skills/<id>/SKILL.md
    ├── .codex/skills/<id>/SKILL.md
    └── .cursor/skills/<id>/SKILL.md
```

- 技能标准形态统一为 `{根}/skills/{id}/SKILL.md`，正文前 frontmatter 写 `name` 与 `description`。
- 技能生效顺序：项目级 > 全局级 > 学习级（沉淀产物恒垫底）。
- 文件操作被限制在启动目录内，越界路径直接拒绝；家目录不可写时，运行时数据自动回退到项目内 `.data/`。

## 四、基本用法

| 界面元素 | 含义 |
| --- | --- |
| `░` | 你的输入 |
| `✻ Thought for Ns` | 思考摘要（`Tab` 展开） |
| `● [VERB]` / `⎿ ✓` `⎿ ✗` | 工具调用行 / 结果行 |
| 正文 | 模型答复（Markdown 渲染） |
| 状态栏 | tokens · ctx 占用 · 耗时 · turns·steps · 模型名 · cache 命中 · todo 进度 · 状态 |

- 提交：回车；行尾单个 `\` 回车为多行续行；运行中继续输入自动排队。
- 历史回看：`Tab` 折叠/展开过程行（按正文与阶段分段折叠），`Ctrl+O` 展开最近一组的详情全文。

**会话命令**（输入 `/` 后按 `Tab` 补全）

| 命令 | 作用 |
| --- | --- |
| `/help` | 命令清单 |
| `/init` | 分析项目，生成或补全 `SUNSHINE.md`（已存在时只补缺失项，不改动既有内容） |
| `/goal <目标>` | 标准验收修正环：目标即验收条件，模型逐轮评估（满足 / 未满足 / 不可满足）；复杂目标可内嵌 `（验收标准：…）` 多判据；判据服务不可用时自动重试 3 次后暂停，重跑 `/goal` 续走 |
| `/plan <目标>` | 先规划后执行（见第六节） |
| `/status` | 会话与账本摘要 |
| `/model [small\|medium\|large]` | 查询 / 切换模型档位（对后续任务生效） |
| `/compact [关注点]` | 立即压缩上下文，可指定优先保留的内容；接近窗口上限时也会自动压缩 |
| `/memory` | 持久记忆：无参列索引；`add <内容>` 添加；`rm <slug>` 删除；`gc` 手动整理；`on` / `off` 开关（本会话内，`/new` 后恢复缺省） |
| `/new` | 新会话（清消息、待办与上下文；记忆与账本保留） |
| `/resume [序号\|id]` | 列出或恢复历史会话（消息、待办、档位与上下文全还原） |

**子代理（spawn）**：模型可派发子代理并行处理独立子任务，过程不占用主链，只回写一行结论。运行中每个子代理在输入框上方显示 4 行实时面板；结束后整段记录折叠进 `● [SPAWN]` 调用行，`Tab` / `Ctrl+O` 可重放全文。自定义角色放 `agents/{id}/agent.md`（frontmatter `name`、正文写职责）。

## 五、权限模式与审批

| 模式 | 语义 |
| --- | --- |
| `manual`（缺省） | 只读自动放行；写文件 / 联网 / 执行命令弹审批卡 |
| `plan` | 只读模式，写操作直接拒绝 |
| `dontAsk` | 自动批准（受信场景） |

审批卡按键：`y` 放行一次 · `a` 本会话放行 · `n` 拒绝。
任何模式下硬性拦截：破坏性命令（`dd` / `fdisk` / `shutdown` 等）与「下载即执行」管道。

## 六、plan 模式

`/plan <目标>` → 生成计划确认卡 → `y` 逐项执行（`▶ Step n/N`），`n` 放弃。
执行中待办卡默认只显示当前进行项，`Tab` 展开完整清单；某项失败即暂停剩余步骤并说明原因。

## 七、快捷键

| 按键 | 作用 |
| --- | --- |
| `Enter` | 提交（行尾 `\` 续行） |
| `Tab` | `/` 开头时补全命令；否则切换历史折叠 / 展开（含待办卡） |
| `Ctrl+O` | 展开最近一组的详情全文 |
| `↑` / `↓` | 输入历史（最近 100 条） |
| `←` / `→`、`Home` / `End` | 光标移动（`Ctrl+A` / `Ctrl+E` 跳首尾） |
| `Backspace` / `Delete` | 删除字符 |
| `Ctrl+C` | 退出 |

> 等待审批 / 待确认计划时输入被拦截：直接按 `y` / `a` / `n` 裁决。

## 八、故障排查

| 现象 | 处理 |
| --- | --- |
| 启动报模型错误 / 答复均为错误 | 检查 `settings.json` 的 `model`、`baseUrl` 与 `env.SUNSHINEX_API_KEY`（全局或项目级） |
| 输入没反应 | 正在等待审批或计划确认：按 `y` / `a` / `n` |
| 写操作总被拒 | 当前是 `plan` 只读模式：重启换 `--mode=manual` |
| 看不到思考过程 | 端点未回传 reasoning 字段，属正常降级，不影响答复 |
| 窗口缩放后花屏 / 残影 | 微调窗口大小再触发一次整屏重绘 |
| 想回看很久之前的内容 | 终端滚动缓冲保留全部输出；`Tab` / `Ctrl+O` 展开查看 |
