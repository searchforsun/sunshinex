# 三级技能目录实施计划

- 日期：2026-09-18
- 规格：`docs/superpowers/specs/2026-09-18-skills-three-tier-dirs-design.md`
- 执行方式：会话内联 TDD（fork/子代理/goal 三先例同款）

## 0. 锚点事实（2026-09-18 沙箱实测）

- selfcheck 输出 `skills: 21 loaded, resolve=ok` / `learned: 19`，其中 **21 = 项目根 `skills/` 2 个（example-skill、hello-sunshine）+ 学习根 19 个**；沙箱 HOME 不可写，学习根实际落 `<root>/.data/skills/`（`.data/` 已 gitignore）。
- 生产代码仅两处引用旧用户根：`src/harness/skills.ts:51`（loadSkills）与 `:67`（createSkillsFacade）；`learnedSkillsDir()`（:31）学习路径不变。
- `userConfigDir()` = `os.homedir()/.sunshinex`（src/config/env.ts:41，无 mkdir）。
- 测试引用旧根的文件：`skills.test.ts`、`skills.merge.test.ts`、`skills.resolve.test.ts`、`loop/skill-ref.test.ts`；`learned.test.ts` / `reactor.settle.test.ts` / `data-dir.test.ts` 断言 `.data/skills` 学习路径（**不变**）。
- perception `SCAN_SKIP_DIRS`（src/harness/perception.ts:14）现无 `.sunshinex`。

## 1. 全局约束

- 生产代码只动 `src/config/data-dir.ts`（新增 userSkillsDir）与 `src/harness/skills.ts`（三根合并 + 回退链）；`learned.ts` 与装配面（harness/index.ts 的 createSkillsFacade 签名）零改动。
- 装配/提示词面零触碰：技能块置尾注入、前缀缓存语义不受影响（规格 §4）。
- 测试卫生：新用例一律 HOME + USERPROFILE 双变量重定向临时目录（Windows 先例，d05bc83），学习根用 SUNSHINEX_DATA_DIR 重定向。
- 他线 WIP 零触碰零卷入：`src/harness/memory/`、`src/tui/session/`、`.gitignore` 若属他线改动不入本线提交（git add 仅点名路径）。
- 门禁三绿：tsc strict 零报错、全量测试 fail 0、selfcheck OK（`skills 21` / `learned 19` 迁移前后不变）。

## 2. 任务拆分（TDD 循环）

### T1 userSkillsDir() 解析与覆盖

- 红（`src/config/data-dir.test.ts` 追加）：
  1. `userSkillsDir()` === `userConfigDir()/skills`（HOME+USERPROFILE 重定向）；
  2. `SUNSHINEX_USER_SKILLS_DIR` 显式覆盖生效（resolve 绝对路径）。
- 绿：`src/config/data-dir.ts` 新增 `userSkillsDir()`——`SUNSHINEX_USER_SKILLS_DIR` 覆盖 > `userConfigDir()/skills`；不 mkdir、不做模块级缓存（注释登记「技能根缺失是常态，装载靠 existsSync 容忍」）。

### T2 skills.ts 三根合并 + resolve 回退链

- 红（重构 `skills.test.ts` / `skills.merge.test.ts` / `skills.resolve.test.ts`）：
  1. loadSkills 三根合并：`<root>/.sunshinex/skills` + `userSkillsDir()` + `learnedSkillsDir()`，就近遮蔽 项目>全局>学习；
  2. resolve 回退链：项目未注册→全局→学习命中；项目根 SKILL_PARAM_MISSING 不回退（语义钉死）；
  3. 旧 `<root>/skills/` 零扫描残留断言（旧位置放同名技能不被装载）；
  4. SUNSHINEX_USER_SKILLS_DIR 重定向后全局根合并生效。
- 绿：`skills.ts`——loadSkills 改三根（项目根 `path.join(root, '.sunshinex', 'skills')`、全局 `userSkillsDir()`、学习根不变）；createSkillsFacade 的 resolve 链改 项目→全局→学习（仅 SKILL_NOT_FOUND 回退）；learnedCount 学习根单根口径不变。

### T3 物料迁移 + perception + selfcheck 锚点

1. `git mv skills/example-skill skills/hello-sunshine .sunshinex/skills/`，旧 `skills/` 目录删除（上新删旧，无兼容扫描）；
2. perception `SCAN_SKIP_DIRS` 增 `'.sunshinex'`；
3. `loop/skill-ref.test.ts` 物料路径改 `.sunshinex/skills/greet`；T2 涉及的测试构造路径全部同步；
4. selfcheck 复跑：`skills: 21 loaded` / `learned: 19` 迁移前后不变（学习技能不受影响）。
- 验收：`git status` 中 `.sunshinex/skills/` 入库、旧 `skills/` 零残留。

### T4 文档同步

- CLAUDE.md §3 目录树（`skills/` 行改 `.sunshinex/skills/`）+ §6 技能规范（三级根与优先级口径）；
- README 技能段、TUI-MANUAL「数据与目录」段补三级根；
- `.env.example` 注释形态补 `SUNSHINEX_USER_SKILLS_DIR`（缺省 `~/.sunshinex/skills`，测试/多实例覆盖用）。

## 3. 验收矩阵（规格 §6 映射）

| 规格 §6 | 落点 |
|---|---|
| 1 项目根 `.sunshinex/skills` 命中、旧根零残留 | T2 用例 3 + T3 迁移 |
| 2 全局根命中（list/resolve） | T2 用例 1/2 |
| 3 三级同 id 就近遮蔽 | T2 用例 1 |
| 4 回退链 + PARAM_MISSING 不回退 | T2 用例 2 |
| 5 SUNSHINEX_USER_SKILLS_DIR 覆盖 | T1 用例 2 + T2 用例 4 |
| 6 selfcheck 21/19 不缩水 | T3 复跑 |
| 7 三绿门禁 | 每任务收口 + 终验 |

## 4. 不做（YAGNI，承规格 §7）

- 旧路径兼容扫描、技能清单常驻提示词、跨设备同步、技能市场。

## 5. 过程纪律

- 单文件单编辑串行重放（并行写入竞态两次先例：structured_output_impl、model_compaction）；
- 提交拆分：规格+计划一笔 docs 提交；T1–T4 按任务粒度各自提交；全量门禁通过后待用户推送指令。
