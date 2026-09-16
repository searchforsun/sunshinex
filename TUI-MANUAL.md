# SunshineX TUI 使用手册

交互式会话终端：在终端里用自然语言下达任务，模型流式作答、工具实时执行、写操作经审批裁决、复杂目标先规划后执行。

## 一、开发环境运行（源码）

前置：Node.js ≥ 22.9、pnpm（`corepack enable` 即有）。

```bash
pnpm install        # 首次
pnpm cli tui        # 启动（脚本内置构建，无需单独 build）
pnpm cli tui <dir>  # 在指定项目目录打开会话
```

其他源码命令：`pnpm cli selfcheck`（骨架自检）、`pnpm test`（全量单测）。

## 二、正式安装使用（npm 全局）

```bash
npm install -g https://github.com/searchforsun/sunshinex/releases/download/v0.1.0/sunshinex-agent-0.1.0.tgz
# 或 npm registry 正式发布后：npm install -g sunshinex-agent；或本地 npm pack 后装 tgz
sunshinex                        # 任意目录直接进入终端
sunshinex --mode=manual          # 指定权限模式（缺省 manual）
sunshinex --language=zh          # 界面与提示词语言（缺省 en 英文版；zh 全中文）
sunshinex --tier=large           # 模型档位（small|medium|large；会话内 /model 切换，SUNSHINEX_TIER 可设缺省）
sunshinex ../my-project          # 指定项目目录（= sunshinex tui <dir>，对标 claude <dir>）
```

升级：重装新版 Release 链接即覆盖；发版维护流程见 README「发版」。

## 三、模型配置（两种方式通用）

任选其一或并用，优先级：已导出环境变量 > 项目级 > 全局级。

| 级别 | 位置 | 适用 |
| --- | --- | --- |
| 全局 | `~/.sunshinex/.env` | 一份配置，任何目录可用（推荐） |
| 项目 | 项目根 `.env` | 某项目用不同模型/供应商 |

```bash
SUNSHINEX_API_KEY=sk-...
SUNSHINEX_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4   # 任意 OpenAI 协议兼容端点
SUNSHINEX_MODEL=glm-5.3-flash
```

**上下文窗口（可选）**：`SUNSHINEX_CONTEXT_WINDOW`（单位 tokens）设为所用模型的最大上下文（如 1M 窗口模型设 `1000000`），状态栏「ctx 250k/1M（25%）」按此计算占用百分比；不设置时按 200k 内建缺省（该值同时是自动压缩的触发基准）。

**模型档位（可选）**：会话内 `/model small|medium|large` 切换（缺省走主模型）；`--tier` 启动参数或 `SUNSHINEX_TIER` 设会话缺省档。配置 `SUNSHINEX_MODEL_SMALL` / `SUNSHINEX_MODEL_MEDIUM` / `SUNSHINEX_MODEL_LARGE`（OpenAI 协议模型名，端点与密钥复用主配置）后，各档位路由到对应模型，未配置的档位回退主模型。档位是用户级会话参数、整场恒定：系统不做自动换档，换档（=换模型）由你显式触发。分子优先采用端点真实回传的 prompt_tokens（本地估算兜底）。会话链跨任务与跨步骤持续增长（对标 Claude Code 全对话保留）：任务指令行、全量执行轨迹与结论行依次尾追，上下文占用随之上升；仅在触发上下文压缩时回落为「压缩块 + 存续链」口径。

## 四、基本用法

- 输入文字回车即提交；运行中继续输入自动排队；行尾单个 `\` 回车为多行续行。
- 消息流元素：`░` 用户输入 · `✻ Thought for Ns` 思考摘要 · `●` 工具调用 + `⎿ ✓` 结果行 · 正文 Markdown 排版渲染；状态栏显示 tokens / ctx 占用 / 耗时 / cache 命中 / todo 进度 / 状态词（idle/running 等英文状态）。
- 历史回看：终端滚动缓冲保留全部输出；过程行按「正文与阶段锚点」分段折叠（后面的过程隶属前面的正文），`Tab` 切换折叠/展开、`Ctrl+O` 展开最近详情全文，运行中可切。

### 子代理（spawn）

主链可派发子代理执行独立子工作，最终报告作为工具结果返回；≥2 个相互独立的子工作应在同一轮并行派发。

- 三种形态：预设角色（`agent_id` 直取 planner / developer / tester / reviewer）、注册子代理（`agents/{id}/agent.md`：frontmatter `name` + 正文即职责框定，装配期一次性加载）、内联临时（仅 `prompt`）。
- 自包含约束：子代理看不到当前对话，`prompt` 需写明目标、关键事实、路径、约束与验收。
- 私有执行：子代理过程步骤不进会话链，终态仅一行 `[标签]` 结论回写；未完成时回写补丁行，主链可继续接管。
- 并发护栏：同层并发上限 4，超限显式拒绝；同名并发自动消歧为 `label#N`（事件标识与结论行一致）；子代理预算随宿主任务换算。
- 显示形态：运行中在输入框上方为每个子代理显示恒定 4 行迷你面板（头部 `✻ [label]` 动画行 + 实时流式尾 3 行，轮转不撑高）；结束后面板消失，整段转录折叠归档进该次 `● [SPAWN]` 调用行——`Ctrl+O`（内容深度）或 `Tab`（历史展开）重放全文。

### 会话命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 命令清单 |
| `/init` | 分析项目，生成/完善 SUNSHINE.md |
| `/goal <目标>` | 运行完整验收修正环（标准环：agent→check→repair）；目标即条件——一句可度量的终态（对话里可自证），复杂目标可内嵌 `（验收标准：t1=…）` 多判据 |
| `/status` | 会话与账本摘要 |
| `/plan <目标>` | 先规划后执行（见第六节） |
| `/compact` | 立即压缩上下文（当前模型生成六要素交接摘要，模型失败自动回退） |
| `/model [small\|medium\|large]` | 查询/设置模型档位（对后续任务生效） |
| `/new` | 新会话（清消息与待办、清空会话链与压缩摘要、清除审批登记；记忆与账本保留） |

`/goal` 直达 Loop 标准验收修正环（对标 CLI `sunshinex run`）：目标即验收条件，判据模型逐轮评估三值裁决（满足 / 未满足 / 不可满足——判定不可满足即终止并给出理由）；判据服务不可用时自动重试 3 次后暂停，重跑 `/goal` 续走（会话链保留上下文）；修正全程走会话主链，终态回执含轮数/验收项/tokens。

## 五、权限模式与审批

| 模式 | 语义 |
| --- | --- |
| `manual`（缺省） | 只读自动放行；写操作/网络/命令挂审批卡 |
| `plan` | 只读模式，写操作直接拒绝 |
| `dontAsk` | 自动批准（受信场景） |

审批卡出现时按键裁决：`y` 放行一次 · `a` 本会话放行 · `n` 拒绝。
硬底线任何模式生效：破坏性命令（`dd`/`fdisk`/`shutdown` 等）与下载执行管道直接拦截。

## 六、plan 模式：先规划后执行

`/plan <目标>` → 模型产出计划确认卡 → `y` 逐项执行（`▶ Step n/N` 落屏）、`n` 放弃。执行中下方待办卡默认显示当前进行项一行；按 `Tab` 切到展开模式（或任务收束后）显示全量清单勾选详情。各步骤在同一任务上下文中连续执行：模型每轮只见「前序结论 + 当前指令」，计划全文与阶段编号不进模型上下文（防模型自行重排步骤）；相邻步骤前缀缓存连续，状态栏 tokens/缓存命中率为整场累计。
单项失败宁停不误：失败项保持未勾选，剩余步骤暂停并说明原因，等待下一步指令。

## 七、快捷键

| 按键 | 作用 |
| --- | --- |
| `Enter` | 提交；行尾 `\` 为续行 |
| `Tab` | `/` 前缀时补全命令；否则切换历史折叠/展开 |
| `↑` / `↓` | 输入历史（最近 100 条） |
| `←` / `→` | 光标移动；`Home`/`End`（`Ctrl+A`/`Ctrl+E`）跳首尾 |
| `Backspace` / `Delete` | 退格 / 删除光标处字符 |
| `Ctrl+C` | 退出 |

> 等待审批/待确认计划时输入被拦截：按 `y`/`a`/`n` 或 `y`/`n` 直接裁决。

## 八、故障排查

| 现象 | 处理 |
| --- | --- |
| 启动即报模型错误 / 答复均为错误 | 检查项目级或全局 `~/.sunshinex/.env` 的 `SUNSHINEX_API_KEY`/`SUNSHINEX_BASE_URL`/`SUNSHINEX_MODEL` |
| 输入无反应 | 处于等待审批/待确认计划：按 y/a/n 裁决 |
| 任务长时间运行 | 多步工具调用属正常；含审批的任务在等你按键 |
| 写操作总被拒 | 当前为 plan 只读模式：重启换 `--mode=manual` 或 `dontAsk` |
| 看不到思考内容 | 端点未回传 reasoning 字段，属静默降级，不影响答复 |
| 窗口缩放后残影 | 触发整屏重绘（200ms 防抖收敛），微调窗口即可再次触发 |
| 想回看很久之前的输出 | 终端滚动缓冲保留全部历史；`Tab` 折叠/展开、`Ctrl+O` 展开最近详情全文 |

## 九、数据与目录

- 会话所有文件操作被约束在启动目录（root）内，越界路径拒绝。
- 运行时数据（账本/记忆/学习技能/知识库）落盘用户级目录 `~/.sunshinex/projects/<工作区>/data`：按启动目录隔离、不污染项目（对标 Claude Code 项目数据形态）；`SUNSHINEX_DATA_DIR` 可整体覆盖。
- 家目录不可写（沙箱/只读 HOME）时回退启动目录内 `.data/`；旧版项目内 `.data` 不自动迁移，可手动拷贝或以 `SUNSHINEX_DATA_DIR` 指向旧目录沿用。
- `SUNSHINE.md`：项目业务配置，启动时装载进模型上下文。
