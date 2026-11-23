# 全局配置 settings.json 化设计规格

- 日期：2026-09-19
- 状态：已实施交付（2026-11-23 D83 批二状态回写核证：MANUAL.md §二「配置（settings.json）」两级文件与优先级链+README.md 模型配置节；代码 src/config/settings.ts 在座；原状态行留档：「- 状态：待评审」）
- 前置裁决（用户已定，本规格只做展开与收口）：①形态=语义键 + env 透传块（混合式，对标 Claude Code）；②优先级=环境变量 > 项目 .env > settings.json > 内置缺省（项目覆盖全局）；③兼容=硬切换（settings.json 为唯一全局配置源，删除全局 .env 读取）；④层级=两级（全局 `~/.sunshinex/settings.json` + 项目级 `.sunshinex/settings.json`）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 全局配置升级为 settings.json 两级层级（全局用户级 + 项目级，同一 schema），`.env` 定位收窄为部署期环境变量与密钥载体、项目级 `.env` 照旧。
- 优先级链落定：环境变量 > 项目 `.env` > 项目级 settings > 全局 settings > 内置缺省，实现沿用「后装者只填缺省」语义、装载顺序即优先级；同文件内语义键 > env 块。
- 关键取舍「展平零下游改动」：语义键按映射表展平写回对应 `SUNSHINEX_*` 环境槽缺省值，下游 20+ 消费点零改动即生效；不新建贯穿下游的结构化 Settings 模块（将来确需再整体升级）；密钥一律不设语义键、只走 env 块或环境变量（设置与凭据分离）。
- 容错语义：文件缺失静默跳过；畸形 JSON fail-fast（报文件路径与解析错误后退出）、version 非 1 拒载、未知语义键忽略+stderr 告警——配置读不出来必须让用户知道，静默降级会演变成「key 没生效」的排查泥潭。
- 项目级文件整体 gitignore（env 块可含密钥的安全缺省）；单机工具不做共享/本地分层（登记 YAGNI）。
- 迁移路径：原 `~/.sunshinex/.env` 内容搬入 settings.json——设置类键转语义键、密钥与懒得起名的键原样进 env 块（键名不变）。

## 现行真值

MANUAL.md §二 配置（settings.json 两级文件与优先级链现行口径）；CLAUDE.md §7 提交与验证（SUNSHINEX_* 环境槽是语义键的运行时载体、SEMANTIC_KEYS 唯一权威）；CLAUDE.md §3 目录结构（src/config/settings.ts 装载落位）。
