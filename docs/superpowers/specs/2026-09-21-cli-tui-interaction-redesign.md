# TUI 斜杠命令选择题化 + CLI 入口判界 + 文档职责拆分 · 设计规格

- 日期：2026-09-21
> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：MANUAL.md §四 命令表「命令只认裸形式」口径与选择卡族（/model、/model-effort、/memory-rm 多选、/memory-on|/memory-off）现行真值、src/cli/index.ts --workdir 入口判界在座、MANUAL.md/README.md 文档职责拆分既成；原状态行留档：「- 状态：设计经用户四轮逐项裁决收敛终版，待评审」）
- 上游：askquestion 选择器线 D6 预留批次（decision/project.askquestion_selector_design）；CLI 目录直进裁决修订（decision/project.cli_dir_direct_entry）
- 关联：TUI-MANUAL 分门别类重组（工作区未提交改动，随本线文档批次一并收口）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 一件收口三面：TUI 斜杠命令选择题化（枚举型参数一律选择卡交互、禁止手填）、命令面扁平化+CLI 入口判界统一、文档职责拆分（MANUAL.md=使用手册（CLI+TUI），README.md=架构/亮点/开发/部署）。
- 命令面终表 18 条扁平命令，废除「命令+子命令」形态：/model 三档单选卡、/model-effort 八项单选卡（回执实际生效档）、/memory-rm 多选批删卡（Space 勾选/Enter 批删）、/memory-on|off 幂等直执行；选项超 8 项走「More…」分页，/resume 与 /memory-rm 共用同一分页机制。
- 「禁止兼容」裁决：命令只认裸形式——带参枚举形态与清单外命令统一回执「无法识别命令」，零引导 shim、零转发、参数解析路径整体删除；自由文本命令（/plan /goal /compact /memory-add）保留手填不在枚举范围。
- CLI 入口判界：废除 `tui` 子命令与「未知词视为目录」兜底；位置参数只认路径形态、目录可走 `--workdir=` flag、裸词报错不启动；run/pipeline 首位参数与顶层同规则（同传时 --workdir 优先）。
- 文档拆分落地：TUI-MANUAL.md git mv 改名扩写为 MANUAL.md 并补 CLI 章，README.md 职责重排，全仓引用同步 grep 零残留。
- 验收 9 条：各选择卡交互（即选即切/Esc 取消/空索引守卫）、分页跨页勾选累积、带参形态统一拒绝、/help 与 Tab 补全和 18 条清单一致、CLI 裸词/路径/flag 三态启动、文档拆分零残留、tsc strict+全量+selfcheck 绿。

## 现行真值

MANUAL.md §四 基本用法（「命令只认裸形式」口径与 18 条会话命令表）、MANUAL.md §一 安装与启动（CLI 启动形态与全局 flags）、MANUAL.md §二 配置（/model 选择卡的 providers 数据源）。
