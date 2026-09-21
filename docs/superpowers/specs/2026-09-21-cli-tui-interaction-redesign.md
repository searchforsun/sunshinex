# TUI 斜杠命令选择题化 + CLI 入口判界 + 文档职责拆分 · 设计规格

- 日期：2026-09-21
- 状态：设计经用户四轮逐项裁决收敛终版，待评审
- 上游：askquestion 选择器线 D6 预留批次（decision/project.askquestion_selector_design）；CLI 目录直进裁决修订（decision/project.cli_dir_direct_entry）
- 关联：TUI-MANUAL 分门别类重组（工作区未提交改动，随本线文档批次一并收口）

## 1. 背景与目标

TUI 内部命令仍保留「命令+子命令」与显式参数手填形态（`/model large`、`/memory off`、`/resume 3`、`/memory rm <slug>`），与已落地的选择器交互（权限卡、plan 卡、/resume、/rewind、/fork、AskQuestion）割裂；CLI 入口仍存在 `tui` 子命令与「未知词视为目录」兜底。本设计收口三件事：

1. **TUI 斜杠命令选择题化**：枚举型参数一律选择卡交互，禁止手填；
2. **命令面扁平化 + CLI 入口判界统一**：子命令拆为连字符独立命令，废除 `tui` 子命令与目录兜底，不识别一律报错不启动；
3. **文档职责拆分**：`MANUAL.md`（使用手册：CLI+TUI）与 `README.md`（架构、亮点、开发、部署）分工。

## 2. 范围

- TUI：`src/tui/session.ts` 斜杠分发与选择卡装配、分页机制、Tab 补全清单、`/help`
- CLI：`src/cli/index.ts` 入口判界重构、`--workdir` flag、`src/tui/entry.ts` 接线
- 文档：`TUI-MANUAL.md` → `MANUAL.md` 改名扩写、`README.md` 职责重排、全仓引用面同步
- 不改：`ask_question` 工具面、权限卡/plan 卡既有交互、模型档位与记忆业务逻辑、journal 斜杠即时建档（自动承接新命令）

## 3. 关键裁决

| # | 裁决 | 内容 |
|---|---|---|
| D1 | 命令面扁平化 | 废除「命令+子命令」形态，子命令拆为连字符独立命令，终表 18 条（§4） |
| D2 | 禁止兼容 | 命令只认裸形式：一切带参枚举形态与不在清单的命令词统一回执「无法识别命令，使用 /help 查看使用方法」（warn 级），不弹卡、不执行、零引导 shim、不做转发，参数解析路径整体删除 |
| D3 | /model 卡 | 三档单选（small/medium/large），当前档标注，即选即切，Esc 取消零变化 |
| D4 | /model-effort 卡 | 7 档 + default 共 8 项单选，即选即切；回执回显实际生效档（取自 adapter 探测缓存） |
| D5 | /memory-rm 多选 | 多选卡 Space 勾选、Enter 批删、Esc 取消；空索引守卫先行；删除逐条幂等，回执成功/失败计数 |
| D6 | 分页 | 选择卡选项 >8 时卡尾「More…」翻页项；/resume 与 /memory-rm 共用同一分页机制，取代「仅列 8 条、更早用 /resume <id>」手填通道 |
| D7 | 会话开关 | /memory-on / /memory-off 两条独立幂等命令（无参直执行） |
| D8 | 自由文本保留 | /plan <目标>、/goal <目标>、/compact [关注点]、/memory-add <内容> 为自由文本参数，不在枚举范围、保留手填 |
| D9 | CLI 入口判界 | 废除 `tui` 子命令与「未知词视为目录」兜底；位置参数只认路径形态；`--workdir=<路径>` flag 形态；不识别报错不启动（§6） |
| D10 | 文档职责拆分 | MANUAL.md=使用手册（CLI+TUI）；README.md=架构、亮点、开发、部署（§7） |

## 4. TUI 命令面终表（18 条）

| 类别 | 命令 | 交互形态 |
|---|---|---|
| 会话 | `/help` `/status` `/new` `/init` | 无参直执行（不变） |
| 会话 | `/resume` `/rewind` `/fork` | 选择卡（/rewind /fork 沿用；/resume 移除参数解析） |
| 任务 | `/plan <目标>` `/goal <目标>` `/compact [关注点]` | 自由文本手填（D8 保留） |
| 模型 | `/model` | 选择卡：三档单选即选即切（§5.1） |
| 模型 | `/model-effort` | 选择卡：8 项单选（§5.2） |
| 记忆 | `/memory` | 无参列索引（查看态） |
| 记忆 | `/memory-add <内容>` | 自由文本手填（D8 保留） |
| 记忆 | `/memory-rm` | 多选卡批量删（§5.3） |
| 记忆 | `/memory-gc` | 直接触发整理（既有守卫：需真实模型、非空索引） |
| 记忆 | `/memory-on` `/memory-off` | 幂等直执行（会话内开关，D7） |

## 5. 选择卡交互

### 5.1 /model

- 选项：`small` / `medium` / `large`，description 注各档绑定模型名或「回退主模型」
- 卡标题显示当前档（如「切换模型档位 · 当前 medium」）；单选即选即提交，切换回执新档；Esc 取消零变化
- 未配置按档绑定时三档 description 均为回退主模型语义，照常可选

### 5.2 /model-effort

- 选项：`none` `minimal` `low` `medium` `high` `xhigh` `max` `default` 共 8 项（单卡不超 8 项上限）
- `default` = 清除覆盖回适配器缺省；当前覆盖档在卡标题标注
- 切换回执回显**实际生效档**（端点不支持时的探测降级结果，取自 adapter 探测缓存），与请求档不一致时一并说明

### 5.3 /memory-rm

- 多选卡：label=slug、description=type + description + created；Space 勾选、Enter 提交批删、Esc 取消零删除
- 空索引守卫先行：回执「暂无记忆」不弹卡
- 删除逐条幂等（store.remove 循环），回执「已删除 N 条（失败 M 条）」；部分失败不阻断其余条目

### 5.4 分页（D6）

- 选项 >8 时卡尾追加「More…」翻页项（末页为「Back…」），单选/多选语义不变
- 多选翻页：跨页勾选态在会话侧累积，Enter 提交全部已勾选
- 消费面：/resume（会话列表）、/memory-rm（记忆列表）；装配收编为选择卡辅助单点，禁止各命令自行拼分页

## 6. CLI 命令风格统一（D9）

### 6.1 命令总表

```bash
sunshinex                                    # 当前工作区启动 TUI（缺省形态）
sunshinex /path/to                           # 指定目录启动 TUI（位置参数=路径形态）
sunshinex --workdir=/path/to                 # 同上，flag 形态
sunshinex help                               # 用法（--help / -h 同义）
sunshinex selfcheck                          # 骨架自检
sunshinex run <dir> --goal="..."             # 验收修正环（goal 走 --goal flag，非位置参数）
sunshinex run <dir> --goal="..." --worktree[=<name>]   # 在隔离 worktree 内跑修正环
sunshinex pipeline <dir> --goal="..." [--yes]          # 五节点流水线，gate 审批交互（--yes 跳过交互直接批准）
```

全局 flags（全部命令通用）：`--mode=manual|plan|dontAsk`、`--language=en|zh`、`--tier=small|medium|large`、`--effort=none|…|max`、`--continue`（续接最近会话；TUI 专属，与 --worktree 互斥）、`--worktree[=<name>]`、`--workdir=<路径>`（新增）。

### 6.2 判界规则

| 位置参数形态 | 处置 |
|---|---|
| 绝对路径（`/path/to`、Windows 盘符路径） | 工作目录，启动 TUI |
| 显式相对形态（`.`、`..` 开头、含 `/` 或 `\` 分隔符） | 工作目录，启动 TUI |
| 裸词（无路径分隔符、非已知子命令） | 无法识别命令，使用 sunshinex help 查看使用方法（stderr 双语 t()，非零退出码，不启动） |

- `tui` 子命令废除：resolveInvocation 的 tui 分支与「未知词视为目录」归一逻辑整体删除（删除即无痕）
- flags 与位置参数解耦：`--mode=plan --workdir=/x` 等直通形式不受影响（同传优先级见 run/pipeline 判据条）
- `sunshinex help` 显示统一用法（含启动形态、子命令清单、常用 flag）
- **run/pipeline 目录判据与顶层统一（用户裁决）**：子命令后的首个位置参数同样按上表三形态判界——路径形态合法、裸词报「无法识别命令」；目录亦可改走 `--workdir=` flag（同传时 --workdir 优先，与顶层同规则）；`run <dir>` 缺目录沿用现行用法报错
- 既有 3 条 resolveInvocation 用例（目录直进/目录+flag 混排/子命令透传）反转为「裸词报错不启动 / help 显示用法 / 路径形态与 flag 直通」

## 7. 文档职责拆分（D10）

- `MANUAL.md`（TUI-MANUAL.md git mv 改名扩写）：职责=使用手册（CLI+TUI 怎么用）。章节=CLI 启动与子命令（§6.1 总表）、TUI 交互（现手册九节主体整体并入）、配置 settings.json 使用视角、故障排查
- `README.md` 职责重排：架构、亮点、开发、部署——架构图/设计亮点/扩展机制保留，新增开发段（构建/测试/目录结构）与部署段（安装三来源、发版脚本、平台兼容）；使用细节外链 MANUAL.md，安装段压缩为「三来源安装 + 一句跑起来」门面，启动参数表迁往 MANUAL.md
- 引用面同步：全仓 TUI-MANUAL 引用（README、CLAUDE.md、docs/）改指 MANUAL.md，grep 零残留；TUI-MANUAL.md 文件名退役
- 现工作区 TUI-MANUAL 重组改动（五节任务形态等）属未提交本线文档批次，随本线一并收口改名扩写

## 8. 实现落点

| 落点 | 改动 |
|---|---|
| src/tui/session.ts | handleSlash：新增 /model-effort 与 /memory-{add,rm,gc,on,off} 分支；/model /resume 改弹卡并删参数解析；旧 /memory 子命令解析块整体删除；未知命令统一文案分支 |
| 斜杠清单面 | SLASH 清单 18 条扁平命令；Tab 补全与 /help 每行一条随清单承接 |
| 选择卡装配 | askUser 通道复用（OptionSelector 单选/多选语义现成）；分页收编为选择卡装配辅助单点 |
| src/cli/index.ts | resolveInvocation 判界重构：已知子命令 / 路径形态 / 裸词报错三分支；--workdir 解析；tui 分支删除 |
| src/tui/entry.ts | --workdir 接线（落点收敛入口层单点） |
| 文档 | TUI-MANUAL.md git mv MANUAL.md + 扩 CLI 章；README.md 职责重排；引用面同步 |

## 9. 测试面

- session：/model 卡即选即切与 Esc、/model-effort 8 项与回执生效档、/memory-rm 多选批删/空守卫/分页跨页累积、/memory-on/off 幂等、/memory-gc 既有守卫保持
- session：参数全禁——/model medium、/resume 3、/memory off、/memory add x 等带参形态统一「无法识别」断言；/help 与 Tab 补全 18 条
- cli：resolveInvocation 反转用例（裸词报错/路径形态/help/子命令与 flag 直通/--workdir）
- 文档：引用面 grep 零残留（TUI-MANUAL 全仓零命中）

## 10. 验收矩阵

| # | 验收项 |
|---|---|
| 1 | /model 弹卡三档即选即切，Esc 零变化 |
| 2 | /model-effort 弹卡 8 项，切换回执含实际生效档 |
| 3 | /memory-rm 多选批删 N 条回执 N，Esc 零删；空索引不弹卡 |
| 4 | 选项 >8 分页可用，/resume 与 /memory-rm 共用机制 |
| 5 | /model medium、/resume 3、/memory off 等带参形态统一「无法识别命令」 |
| 6 | /help 与 Tab 补全与 18 条命令面一致 |
| 7 | sunshinex 裸/路径形态/--workdir 三态启动；裸词报错不启动；help 显示用法 |
| 8 | MANUAL.md/README.md 职责拆分到位，全仓 TUI-MANUAL 引用零残留 |
| 9 | 门禁：tsc strict 0 + 全量 fail 0 + selfcheck OK |

## 11. 登记取舍

- CLI 面斜杠命令不存在，TUI 改造零波及 CLI 交互；journal 斜杠即时建档自动承接新命令名，零改动
- /memory-add 内容为自由文本，选择卡不覆盖（D8）
- 分页只前进/后退一页，不做跳页搜索（YAGNI）
- i18n：卡片与报错文案 t() 双语；提示词面零改动（纯交互层），前缀缓存零影响
