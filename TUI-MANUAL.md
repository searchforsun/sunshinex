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

**模型档位（可选）**：会话内 `/model small|medium|large` 切换（缺省走主模型）；`--tier` 启动参数或 `SUNSHINEX_TIER` 设会话缺省档。配置 `SUNSHINEX_MODEL_SMALL` / `SUNSHINEX_MODEL_MEDIUM` / `SUNSHINEX_MODEL_LARGE`（OpenAI 协议模型名，端点与密钥复用主配置）后，各档位路由到对应模型，未配置的档位回退主模型。档位是用户级会话参数、整场恒定：系统不做自动换档，换档（=换模型）由你显式触发。分子优先采用端点真实回传的 prompt_tokens（本地估算兜底）；plan 模式下每个步骤是独立的最小上下文（跨步骤只保留前序结论），故长 plan 任务的 ctx 为当前步骤占用，远小于状态栏首位的整场 tokens 累计。

## 四、基本用法

- 输入文字回车即提交；运行中继续输入自动排队；行尾单个 `\` 回车为多行续行。
- 消息流元素：`░` 用户输入 · `✻ Thought for Ns` 思考摘要 · `●` 工具调用 + `⎿ ✓` 结果行 · 正文 Markdown 排版渲染；状态栏显示 tokens / ctx 占用 / 耗时 / cache 命中 / todo 进度 / 状态词（idle/running 等英文状态）。
- 历史回看：终端滚动缓冲保留全部输出；过程行按「正文与阶段锚点」分段折叠（后面的过程隶属前面的正文），`Tab` 切换折叠/展开、`Ctrl+O` 展开最近详情全文，运行中可切。

### 会话命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 命令清单 |
| `/init` | 分析项目，生成/完善 SUNSHINE.md |
| `/status` | 会话与账本摘要 |
| `/plan <目标>` | 先规划后执行（见第六节） |
| `/compact` | 立即压缩上下文 |
| `/model [small\|medium\|large]` | 查询/设置模型档位（对后续任务生效） |
| `/new` | 新会话（清消息与待办、清除审批登记） |

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
