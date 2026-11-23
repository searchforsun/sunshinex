# 项目级技能目录兼容链规格（v2：统一标准形态）

- 日期：2026-09-18（v2 修订，取代同日 v1）
- 状态：已实施交付（2026-11-23 D83 批二状态回写核证：CLAUDE.md §6「项目级五根只认 {root}/<根>/skills/{id}/SKILL.md」+ MANUAL.md 目录结构兼容根行；src/harness/skills.ts PROJECT_SKILL_ROOTS_ASC 五根与 SKILL.md 优先/skill.md 兜底在座；原状态行留档：「- 状态：待用户评审；无异议答复「继续」转实施（预计 3 任务 TDD），代码实施未开始」）
- 关联：`docs/superpowers/specs/2026-09-18-skills-three-tier-dirs-design.md`（三级根分层与 项目级>全局级>学习级 优先级承袭不动）
- v2 修订缘由：用户裁决收紧形态适配面——兼容根只认标准形态，异构形态零兼容
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 项目级技能兼容链统一标准形态（用户裁决「其他都不兼容」）：.cursor/.codex/.claude/.agents/.sunshinex 五根一律只认 {根}/skills/{id}/SKILL.md，升序装载、右侧遮蔽，原生 .sunshinex 恒最优先——v1 按各家官方形态分别适配的方案全部撤销。
- 异构形态零兼容：rules/*.mdc、裸 AGENTS.md、commands/*.md 及任何单文件技能形态不装载、不解析、不降级（防回归钉锁定）；frontmatter 沿现行解析，不新增降级启发式。
- 文件名大小写容错：SKILL.md 优先、skill.md 兜底，Windows/macOS/Linux 三平台装载结果一致；属同形态内文件名容错而非异构兼容，可单点摘除。
- 去重与回退承袭三级分层：同名 id 就近遮蔽（list 恒一、resolve 落右侧根）；SKILL_NOT_FOUND 沿五根→全局→学习级逐级回退，SKILL_PARAM_MISSING 不回退。
- 装配面零改动：合并在装载层完成，技能清单冻结段注入与正文置尾注入均不动（前缀缓存第一要义）；兼容目录由 perception 跳过，业务文件清单零混入。

## 现行真值

现行装载口径见 CLAUDE.md §6 技能规范（标准形态与装载面仅限标准形态、五根优先级与回退链）、MANUAL.md 三、目录与文件（项目技能根与兼容根行）。
