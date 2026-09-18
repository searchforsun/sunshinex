# 项目级技能目录兼容链规格（.cursor < .codex < .claude < .agents < .sunshinex）

- 日期：2026-09-18
- 状态：定稿待评审；用户无异议答复「继续」转 writing-plans（预计 3 任务 TDD），代码实施未开始
- 关联：`docs/superpowers/specs/2026-09-18-skills-three-tier-dirs-design.md`（三级根规格，本文件只修订其「项目级根」一维，全局级/学习级/优先级/回退链/装配面语义全部承袭不动）
- 用户裁决：兼容序 `.cursor` < `.codex` < `.claude` < `.agents` < `.sunshinex`（左侧被右侧遮蔽）；`.agents` 按业界事实标准读 `AGENTS.md`；同名去重、就近遮蔽

## 1. 背景

三级根规格（2026-09-18 早前批）已把项目级定为单一根 `<项目>/.sunshinex/skills/`。用户追加裁决：项目级应**兼容业界既有 AI 工具目录**——用户在混用 Claude Code / Codex / Cursor 的仓库里，技能已散落在各家的项目级目录中，SunshineX 应直接装载复用，不要求用户再拷贝一份；同目录冲突按兼容序右侧优先。调研核实（2026-09-18，Claude Code 官方文档 / agentskills.io 官方规范 / Cursor 官方文档 / agents.md 官方站）：

- Claude Code（Agent Skills 开放标准）：项目级 `.claude/skills/{name}/SKILL.md`，YAML frontmatter（description 必填推荐、name 缺省取目录名），目录名=命令名；`.claude/commands/*.md` 旧格式仍兼容
- Cursor：项目规则 `.cursor/rules/*.mdc`（frontmatter 仅 `description`/`globs`/`alwaysApply`，.mdc 为硬要求、纯 .md 被忽略）；官方「技能」属用户级非项目级
- Codex / AGENTS.md 生态（agents.md，Linux 基金会托管）：`AGENTS.md` 为纯 Markdown 指令文件，**无 skills 目录概念**
- Agent Skills 开放标准（agentskills.io）：`{name}/SKILL.md` + frontmatter（name/description）+ 可选 scripts/references/assets 附带资源

## 2. 设计裁决

| # | 裁决 | 理由 |
|---|------|------|
| D1 | 项目级根改为**兼容链**（升序装载、右侧遮蔽）：`.cursor` < `.codex` < `.claude` < `.agents` < `.sunshinex` | 用户裁决；.sunshinex 为原生形态恒最优先，业界目录按生态成熟度让位 |
| D2 | `.claude`：`.claude/skills/{id}/SKILL.md` 直读 | 官方规范与 SunshineX frontmatter 同构，零转换 |
| D3 | `.claude` 附带兼容 `.claude/commands/{name}.md`（单文件=技能正文，id 取文件名词干） | 官方「commands 已并入 skills、旧格式持续工作」；SunshineX 已有单文件形态先例，装载成本低 |
| D4 | `.cursor`：`.cursor/rules/*.mdc` 单文件直读为技能正文，id 取文件名词干 | Cursor 官方硬性口径 .mdc 才有效；frontmatter 差异字段忽略，正文纯 Markdown 天然兼容 |
| D5 | `.codex` 读 `{id}/SKILL.md`（大小写不敏感：`SKILL.md` 优先、`skill.md` 兜底）；**不识别根 `AGENTS.md` 单文件** | Codex 生态向 Agent Skills 标准靠拢；AGENTS.md 是指令/上下文文件（无 frontmatter、无按需加载语义），按技能装载会污染技能清单 |
| D6 | `.agents`：读 `AGENTS.md`（同 D5 优先级口径），不识别 `skills/` 子目录 | 用户裁决 + 生态事实；同理由否决 skills 子目录误读 |
| D7 | 去重=**同名就近遮蔽**（list 恒一、resolve 就近命中），与既有项目>全局>学习遮蔽语义同构；`.sunshinex` 命中即吞掉全部兼容根同名项 | 用户裁决「做好去重」；与 §11 技能置尾注入零交互 |
| D8 | frontmatter 缺失降级：无 frontmatter 的 .mdc/.md 单文件按缺省清单（name=文件词干、description=正文首行非空行） | Cursor .mdc 常无 name 字段；Claude Code 官方同款降级口径 |
| D9 | `.agents`/`.codex` 的 `AGENTS.md` 解析出多个 `## 标题` 小节**不拆分**，整文件=一个技能（id=agents/codex 域内取 'agents'/'codex'） | 用户裁决 D6；标题拆分是启发式、污染清单、首版不做并登记 YAGNI |
| D10 | 装配面零改动：兼容链合并在装载层完成，技能块仍置尾一次性注入 | 前缀缓存第一要义（§11），与三级根规格 §4 同承袭 |

## 3. 目标形态

- 装载顺序（低→高，右侧遮蔽左侧）：

```
.cursor/rules/*.mdc → .codex/*/SKILL.md → .claude/{skills/{id}/SKILL.md, commands/{id}.md} → .agents/AGENTS.md → .sunshinex/skills/{id}/skill.md → ~/.sunshinex/skills/ → 学习根
```

- resolve 回退链相应扩展：`.sunshinex` 未注册 → `.agents` → `.claude` → `.codex` → `.cursor` → 全局根 → 学习根（兼容序右侧优先即回退链左侧优先，逐级 SKILL_NOT_FOUND 才回退，SKILL_PARAM_MISSING 恒不回退）
- 目录缺失/无匹配文件=常态，静默跳过不告警（loadSkillsFrom 容忍语义不变）
- `SUNSHINEX_USER_SKILLS_DIR`（全局根）与学习根语义不变

## 4. 改动面

1. `src/harness/skills.ts`：新增兼容根解析器单点 `compatProjectSkillDirs(root)`（返回升序 `Array<{dir, kind}>`，kind: 'cursor-mdc'|'codex-skill'|'claude-skill'|'claude-command'|'agents-md'），`loadSkills` 项目段改为沿链逐根装载+seen 滤重；`loadSkillsFrom` 泛化出单文件（.mdc/.md/AGENTS.md）与 SKILL.md 大小写双形态装载
2. `src/harness/skills.merge.test.ts` / `skills.test.ts`：新增兼容链用例（五根并存遮蔽、.claude skills/commands 双形态、.cursor .mdc 无 frontmatter 降级、.agents AGENTS.md 整文件单技能、.sunshinex 遮蔽全部兼容根、resolve 回退链跨兼容根）
3. CLAUDE.md §6、README、TUI-MANUAL「数据与目录」段补兼容链口径
4. perception `SCAN_SKIP_DIRS` 增 `.cursor`/`.codex`/`.claude`/`.agents`（防兼容目录文件混入业务文件感知清单；`.claude`/`.cursor` 本就在 Cursor/Claude 用户仓库中属工具目录）

## 5. 验收矩阵

1. 五根并存同名技能：list 恒一且落 `.sunshinex` 版本；去重不因装载顺序抖动
2. `.claude/skills/{id}/SKILL.md` 装载命中、frontmatter 照常解析；`.claude/commands/{id}.md` 单文件装载为技能
3. `.cursor/rules/*.mdc` 装载、无 frontmatter 降级 name=文件词干；`.md` 被忽略（Cursor 同款口径）
4. `.codex/{id}/SKILL.md` 命中（大小写双形态）；`.agents/AGENTS.md` 整文件单技能
5. resolve 回退链跨兼容根：`.sunshinex` 缺 → `.agents` → `.claude` → `.codex` → `.cursor` → 全局 → 学习
6. 兼容目录被 perception 跳过（业务文件清单零混入）
7. 全量门禁：tsc strict 零报错、全量测试 fail 0（他线 WIP 归属口径不变）、selfcheck OK（skills 计数含兼容根装载）

## 6. YAGNI（首版不做）

- AGENTS.md `## 标题` 拆分为多技能（启发式、污染清单）
- frontmatter 字段语义扩展（globs/alwaysApply 等触发控制）——SunshineX 装载按需注入语义不同
- `.claude/skills` 支持附带资源目录（scripts/references/assets）装载
- 旧 `<项目>/skills/` 路径复活（三级根规格已裁、不回退）
