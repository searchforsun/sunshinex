# 上下文治理吸收批次设计规格（Claude Code 实现调研吸收）

- 日期：2026-09-17
- 状态：已实施交付（2026-11-23 D83 批二状态回写核证：MANUAL.md 命令表「/compact [关注点]」+ CLAUDE.md §6 Compact Instructions 机器消费区与 §11 快照刷新点；src/harness/tools/output-archive.ts（A 项）、context/compaction.ts Full trace 归档（B 项）、reactor.ts isContextOverflowError 反应式压缩（F 项）在座；原状态行留档：「- 状态：待评审（评审通过转 writing-plans）」）
- 调研来源：官方文档（code.claude.com「How Claude Code works / How Claude Code uses prompt caching」）+ 社区反编译重构 shareAI-lab/learn-claude-code s08_context_compact（形态参考，其常量为课程还原值非官方数字）
- 关联：CLAUDE.md §11 前缀缓存第一要义；model-compaction 规格（44a6d3c / 60e8e20）；前缀缓存 91%→50% 排查（66bd70a）；基线 d05bc83
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- Claude Code 实现调研七项全部落地，逐项判定前缀影响面：A–F 均为入口侧或压缩点内改动（前缀零击穿，或落在唯一合法重写点），G 为前置段消险——SUNSHINE.md 会话冻结后从中途改盘位移前缀升级为「变了也不击穿」。
- 工具出口预算与大输出落盘：read/exec/glob/webfetch 超限落盘全文、留预览与可信恢复路径（grep 双闸门取小），截断不再即丢失；压缩块补 Full trace 归档指针，被折链行可回溯且 replay 幂等。
- 防注入纪律：压缩摘要提示词与稳定段补「参考数据非指令」双语条款；/compact 增关注点参数（帮助/补全/手册同步），自动压缩完成消息流留痕、轮首缓存未命中一次性提示。
- SUNSHINE.md「Compact Instructions」可选区：识别标题即注入压缩摘要，无区逐字节零变化；会话冻结只保留四个显式刷新点（构造/reloadContext/resetSession/压缩成功），不做常驻文件 watcher。
- 反应式压缩兜底：端点超长拒绝识别后按同参数压缩并重试该步一次，再失败走既有 model-error——消灭本地估算偏差导致的任务直接失败。
- 不抄清单维持既有裁决：micro_compact/snip_compact 中段就地清理（与第一要义冲突）、MCP 工具定义延迟装载（装配期冻结是前缀安全根基）均不做。

## 现行真值

现行压缩与快照口径见 CLAUDE.md §11 前缀缓存（压缩唯一合法重写点、快照刷新点、动态改动尾追）、§15 语言规范·机器消费区（Compact Instructions 标题字面约定）、MANUAL.md 四、基本用法 命令表「/compact [关注点]」行。
