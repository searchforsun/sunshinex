# Auto Memory 设计规格（情景/状态记忆，与程序性记忆双轨互补）

- 日期：2026-09-18
- 状态：已实施交付（2026-11-23 D83 批二状态回写核证：MANUAL.md §二 autoMemory 键+§四 /memory 命令族+CLAUDE.md §3 harness/memory/ 登记；代码 src/harness/memory/（store/extractor/consolidate/pipeline）在座；原状态行留档：「- 状态：已获用户批准（设计总览「继续」通过），待 writing-plans 转实施计划」）
- 调研来源：CC 官方 memory 文档（code.claude.com）+ 社区反编译还原课程 shareAI-lab/learn-claude-code s09 + Hermes 官方文档（hermes-agent.nousresearch.com）
- 关联：CLAUDE.md §11 前缀缓存第一要义；context-fork 规格（「链即记忆」裁决、记忆段 41.1% 事故先例）；G 项 SUNSHINE.md 会话冻结快照（四刷新点）；LearnedSkillStore（程序性记忆，本规格不动）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 交付陈述性自动记忆（CC 四类型：user 偏好 / feedback 纠正 / project 项目事实 / reference 外部参考），与既有程序性记忆 LearnedSkillStore 双轨互补——提取闸门按内容分流：任务形态教训走 learned、事实/偏好/反馈走 memory，两库互补不重复、互不写入。
- 存储「索引+主题文件」分离：MEMORY.md 索引由记录文件重建（记录文件单一事实源），常驻成本（200 行/25KB 容量纪律：超限写入成功但报错勒令精简，不静默丢不静默挤）与内容深度解耦；主题文件不装载，模型按需 read 召回。
- 装载=索引并入会话冻结快照（与 SUNSHINE.md 同位同语义、四刷新点复用），运行中零记忆写进 prompt——前缀缓存零击穿，与 41.1% 记忆段中段双写事故的本质区别正在于此。
- 提取挂任务收口单点、独立一次性模型调用不进主链；准入闸门五道：scope 过滤、临时措辞拒绝、三级归一去重、跳过可推导/已写明项、注入渗出与不可见 Unicode 安全扫描（记忆要进冻结快照≈进系统提示词，防持久化注入）；提取失败静默降级，任务收口永不因提取失败而失败。
- 自包含化三防线（对标 CC 之上机制化）：禁相对时间与未消解指代——提取条款+当前日期注入+临时指代正则黑名单合并执行，纯规则零二次模型调用。
- 整理双入口（记录数达阈值自动 + /memory gc 手动）走同一清洗合并；冲突以新覆旧；整理前快照备份、失败回滚重建索引——记忆永不因整理失败而丢失；/memory 命令族（列出/添加/删除/整理）同批交付。

## 现行真值

MANUAL.md §二 配置（autoMemory 语义键）与 §四 基本用法（/memory 命令族现行口径）；CLAUDE.md §3 目录结构（src/harness/memory/ 落位）；CLAUDE.md §11 前缀缓存（记忆索引进冻结快照、变更尾追）。
