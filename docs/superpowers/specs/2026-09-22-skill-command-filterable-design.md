# /skill 命令与选择卡 filterable 筛选能力设计

> - 日期：2026-09-22
> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：filterable 筛选能力活文档 MANUAL.md:330/346/353/356 四张清单卡「输入即筛选（Esc 先清词再取消）」现行真值，代码在座——src/tui/components/OptionSelector.tsx:46 filterOptions 纯函数、src/tui/session.ts skillFlow >8 项带 filterable、AskUserRequest.filterable 在座；注记：本规格 D2 的 /skill 硬载注入通道（选择即 appendChain 正文）已被后继规格 2026-11-04-agents-teams-catalog §4.2 退役为「插入引用」（/skill 卡保留为浏览兜底，MANUAL.md:330 载明「不直接载入上下文」），filterable 组件能力不受影响；原状态行留档：「- 状态：设计定稿（用户已批准设计呈现；三项交互裁决与注入通道经问卷/呈现收束）」）
> - 关联：`specs/2026-09-21-cli-tui-interaction-redesign.md`（扁平命令与选择卡先例）、`specs/2026-09-20-askquestion-selector-design.md`（OptionSelector 与 ask_question）、CLAUDE.md §6（技能装载）、§11（前缀缓存第一要义）、§15（外观双语/写链恒英文）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 交付选择卡组件级 filterable 筛选能力：清单卡超阈值（>8 项，与分页阈值同源）启用，按 label+description 大小写不敏感子串过滤——纯函数、零新依赖（否决模糊匹配库，子串够用）；/skill、/resume、/memory-rm 三张清单卡同批接线。
- 键位裁决：可打印字符（含数字）进筛选词、数字快选让位；Esc 两段式（词非空先清词、为空才取消）；词变光标归零；多选卡跨筛选词勾选累积稳定（勾选按原下标换算，不随筛选漂移）。
- 与分页组合：无词走既有分页（More/Back 照旧），有词全量直出隐藏导航，清词回分页态；筛选词为纯 TUI 瞬态不进 session/journal——零前缀断点。
- /skill 交付用户侧技能显式入口（列出可用技能的选择卡，替代此前仅模型自主加载单通道）；注记：其「选择即载入正文进链」注入通道后经 2026-11-04-agents-teams-catalog 退役为「插入引用」（/skill 卡保留为浏览兜底），filterable 组件能力不受影响。
- 固定小卡（审批/plan/ask）零触碰：非 filterable 卡路径逐字节不动（钉子用例锁定）；CLI/TTY 编号回落忽略筛选——筛选是 TUI 键盘分发层能力，对其他面为可选降级。
- 验收：三清单卡 >8 项输入即筛、Esc 先清词再退卡、工具清单零新增、链头行恒英文+上屏回执双语（§15）；既有前缀套件扩展一条锁定尾追零击穿。

## 现行真值

现行筛选交互见 MANUAL.md §四 基本用法命令表（/skill、/resume、/memory-rm、/unarchive 条目「输入即筛选（Esc 先清词再取消）」）；/skill 现行通道（插入引用、不直接载入上下文）见 MANUAL.md §四 /skill 条目。
