# 项目级技能目录兼容链规格（v2：统一标准形态）

- 日期：2026-09-18（v2 修订，取代同日 v1）
- 状态：待用户评审；无异议答复「继续」转实施（预计 3 任务 TDD），代码实施未开始
- 关联：`docs/superpowers/specs/2026-09-18-skills-three-tier-dirs-design.md`（三级根分层与 项目级>全局级>学习级 优先级承袭不动）
- v2 修订缘由：用户裁决收紧形态适配面——兼容根只认标准形态，异构形态零兼容

## 1. 用户裁决（2026-09-18）

> 哪个项目级别兼容的，都统一使用标准的 .{}/skills/{id}/SKILL.md 其他都不兼容

v1 曾按各家官方形态分别适配（`.cursor` 读 `rules/*.mdc`、`.codex` / `.agents` 读 `AGENTS.md`、`.claude` 兼读 `commands/*.md`）——本版全部撤销：**五个项目级根一律 `{根}/skills/{id}/SKILL.md`**，其余形态不装载、不解析、不降级。

## 2. 设计裁决

| # | 裁决 | 说明 |
|---|------|------|
| D1 | 兼容链五根同构：`.cursor` < `.codex` < `.claude` < `.agents` < `.sunshinex`，每根只读 `{根}/skills/{id}/SKILL.md` | 用户裁决；升序装载、右侧遮蔽（优先级承袭前一轮裁决） |
| D2 | 形态唯一：`{根}/skills/{id}/SKILL.md` | 目录形态与文件名一并统一，含 `.sunshinex` 原生根（与 Agent Skills 官方标准同名；v1 的 `skill.md` 落位同步迁移） |
| D3 | 异构形态零兼容：`.cursor/rules/*.mdc`、`.codex` 与 `.agents` 根 `AGENTS.md`、`.claude/commands/*.md`、任何单文件技能形态一律不装载 | 用户裁决「其他都不兼容」；v1 的 D3/D4/D5/D6/D8/D9 全部撤销 |
| D4 | 文件名大小写容错：`SKILL.md` 优先、`skill.md` 兜底 | 跨平台行为一致所需——Windows / macOS 文件系统本不区分大小写（同名文件），Linux 显式补齐兜底，三平台装载结果一致；属同形态内文件名容错，非异构形态兼容。可单点摘除（严格单形态需同步迁移全部 `skill.md` 物料，仓库内仅 2 个） |
| D5 | 去重：同名就近遮蔽（list 恒一、resolve 落右侧根），与 项目级 > 全局级 > 学习级 同构 | 用户裁决「做好去重」，承袭 |
| D6 | resolve 回退链：`.sunshinex` → `.agents` → `.claude` → `.codex` → `.cursor` → 全局根 → 学习根；仅 SKILL_NOT_FOUND 逐级回退、SKILL_PARAM_MISSING 不回退 | 兼容序右侧优先即回退链左侧优先，语义承袭 |
| D7 | frontmatter 沿现行解析（缺省 name / description 空、version 0.1.0），不新增降级启发式 | v1 的「无 frontmatter 降级取文件词干 / 首行」随 .mdc 适配一并撤销 |
| D8 | 装配面零改动：合并在装载层完成，技能清单冻结段注入与正文置尾注入均不动 | 前缀缓存第一要义（CLAUDE.md §11） |

## 3. 目标形态

装载顺序（左低右高，右侧遮蔽左侧）：

```
<root>/.cursor/skills/{id}/SKILL.md
  -> .codex/skills/{id}/SKILL.md
  -> .claude/skills/{id}/SKILL.md
  -> .agents/skills/{id}/SKILL.md
  -> .sunshinex/skills/{id}/SKILL.md（原生，恒最优先）
  -> ~/.sunshinex/skills/（全局级，承袭）
  -> <dataDir>/skills/（学习级，承袭）
```

- 目录缺失 / 无匹配 = 常态，静默跳过
- 同名 id：右侧根命中即遮蔽左侧，list 恒一
- 异构形态文件（`rules/*.mdc`、`AGENTS.md`、`commands/*.md`）即使存在也不进清单

## 4. 改动面

1. `src/harness/skills.ts`：兼容根序常量（`.cursor` / `.codex` / `.claude` / `.agents` / `.sunshinex` 各自的 `skills/` 子目录，升序）；`loadSkillsFrom` 文件名 `SKILL.md` 优先 + `skill.md` 兜底；`loadSkills` 项目段沿链逐根装载 + seen 滤重（替换现行单根 `.sunshinex/skills`）
2. 仓库物料：`.sunshinex/skills/{example-skill,hello-sunshine}/skill.md` -> `SKILL.md`（git mv，内容零变更）
3. 测试：兼容链遮蔽用例（五根同名）、异构形态零装载钉子（`rules/*.mdc` 与 `AGENTS.md` 就位仍不进清单）、`SKILL.md` 标准名命中、resolve 跨根回退；既有 `skill.md` 物料保持可用（兜底口径）
4. perception `SCAN_SKIP_DIRS` 增 `.cursor` / `.codex` / `.claude` / `.agents`
5. 文档：CLAUDE.md §3 / §6、README、TUI-MANUAL 兼容链口径（统一标准形态 + 五根优先级）

## 5. 验收矩阵

1. 五根同为 `skills/{id}/SKILL.md` 形态，同 id 时 list 恒一且落 `.sunshinex`（最高优先）
2. `.claude/skills/{id}/SKILL.md` 命中（生态标准目录直读，零转换）
3. 异构形态零装载：`.cursor/rules/x.mdc`、`.claude/commands/y.md`、`.agents/AGENTS.md` 就位仍不出现在清单
4. 大小写容错：`SKILL.md` 与 `skill.md` 均可装载（三平台一致）
5. resolve 回退链跨五根 + 全局 + 学习逐级生效，缺参不回退
6. 兼容目录被 perception 跳过（业务文件清单零混入）
7. 门禁：tsc strict 零报错、全量测试 fail 0、selfcheck OK（skills 计数含兼容根装载）

## 6. YAGNI（明确不做）

- 各家异构形态适配（`.mdc` / `AGENTS.md` / `commands/*.md` / 任何单文件技能）
- `AGENTS.md` 的 `## 标题` 拆分为多技能
- 附带资源目录（scripts / references / assets）装载
- frontmatter 字段语义扩展（globs / alwaysApply 等触发控制）

## 7. 实施预告

3 任务 TDD：

- T1 兼容根序 + 装载合并与文件名口径
- T2 遮蔽 / 零装载 / 回退用例
- T3 物料改名 + perception 跳过 + 文档同步
