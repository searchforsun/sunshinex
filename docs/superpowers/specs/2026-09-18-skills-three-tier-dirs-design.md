# 三级技能目录设计规格

- 日期：2026-09-18
- 状态：定稿，待评审；用户无异议答复「继续」转 writing-plans（预计 4 任务 TDD），代码实施未开始
- 关联：`src/harness/skills.ts`、`src/config/data-dir.ts`、CLAUDE.md §3/§6、fork 规格（P4 技能置尾不变）

## 1. 背景与问题

技能装载现状只有两根：

- 用户技能根：`<项目>/skills/`（项目根直下）
- 学习技能根：`~/.sunshinex/projects/<slug>/data/skills/`（LearnedSkillStore 写入面，经代码核实正确）

两个问题：

1. **项目级位置不符**：用户定稿项目级为 `<项目>/.sunshinex/skills/`（与全局 `~/.sunshinex/` 命名一致），现状 `<项目>/skills/` 需迁移；
2. **全局用户级缺失**：全仓无 `~/.sunshinex/skills/` 任何引用——用户手工放置的全局技能不会被装载。

## 2. 决策记录（用户拍板，2026-09-18）

| 决策点 | 结论 | 备注 |
|--------|------|------|
| 项目级目录名 | `.sunshinex/skills/` | 否决 `.sunshinx` 字面拼写（笔误），与全局 `~/.sunshinex/` 命名一致 |
| 全局级路径 | `~/.sunshinex/skills/` | 新增装载根 |
| 学习级位置 | 保留 `~/.sunshinex/projects/<slug>/data/skills/` | 否决提到 slug 直下；运行时产物归 resolveDataDir 单一权威，路径形态对称性让位于单一权威与测试卫生 |
| 优先级 | 项目级 > 全局级 > 学习级 | 作用域越近优先，id 撞名就近遮蔽，学习产物恒垫底 |
| 实施顺序 | 先落设计规格，再转实施计划（TDD） | — |
| 旧 skills/ 处置 | 迁移 + 删除旧目录 | 上新删旧，无四根并存过渡期 |

## 3. 目标三级根（定稿）

| 级别 | 路径 | 性质 | 写入方 |
|------|------|------|--------|
| 项目级 | `<项目>/.sunshinex/skills/` | 手工资产 | 人（手工放置） |
| 全局级 | `~/.sunshinex/skills/` | 手工资产 | 人（手工放置） |
| 学习级 | `~/.sunshinex/projects/<slug>/data/skills/`（HOME 不可写回退项目 `.data/skills`） | 运行时产物 | LearnedSkillStore.settle()（FIFO 上限） |

语义边界：项目根与全局根是**人手工放置的资产**，学习根是**模型沉淀的运行时产物**——位置差异正承载这个区别（学习级随 resolveDataDir：`SUNSHINEX_DATA_DIR` 覆盖、测试钉 `.data-test` 防污染、HOME 不可写回退全部天然生效）。

## 4. 装载与解析语义

- 装载 = 现扫磁盘（`loadSkillsFrom` 每次现读，无启动期常驻注册表），三级根合并清单；
- id 撞名就近遮蔽：项目级 > 全局级 > 学习级，被遮蔽者静默让位、不报错；
- resolve 回退链：项目根命中（含 `SKILL_PARAM_MISSING`）不回退；仅 `SKILL_NOT_FOUND` 才逐级回退全局根 → 学习根；
- `SUNSHINEX_DATA_DIR` 覆盖语义不变（学习根随 resolveDataDir）；全局根新增 `SUNSHINEX_USER_SKILLS_DIR` 显式覆盖（测试与多实例场景），缺省不主动 mkdir（技能根缺失是常态，装载靠 existsSync 容忍缺失）；项目根无 override（项目根本身即定位）；
- 提示词装配面零改动：技能块仍置尾一次性注入（fork 规格 P4 裁决），三级合并在装载层完成，相邻帧前缀稳定性不受影响。

## 5. 改动面

1. `src/config/data-dir.ts`：新增 `userSkillsDir()`（= `userConfigDir()/skills`；`SUNSHINEX_USER_SKILLS_DIR` 显式覆盖；不做模块级缓存；缺省不 mkdir）
2. `src/harness/skills.ts`：`loadSkills` 三根合并；resolve 回退链 项目→全局→学习（仅 SKILL_NOT_FOUND 回退）；`learnedCount` 保持学习根单根口径
3. `src/harness/skills/learned.ts` 及技能写入面：零改动（学习级路径不变）
4. perception：`SCAN_SKIP_DIRS` 补 `.sunshinex/`（防把项目级技能当业务文件报告）
5. selfcheck 技能物料：仓库 `skills/` 21 个技能整体迁移至 `.sunshinex/skills/`
6. 文档：CLAUDE.md §3 目录结构与 §6 技能规范、README、TUI-MANUAL 三级目录口径同步
7. 测试：三根合并/遮蔽/回退/覆盖用例（HOME/USERPROFILE 双变量重定向，对齐 data-dir 测试卫生先例）

## 6. 验收矩阵

1. 项目根 `.sunshinex/skills/{id}/skill.md` 装载命中；旧 `<项目>/skills/` 扫描整体移除、零残留
2. 全局根命中：项目级缺失时全局技能可 resolve、可 list
3. 就近遮蔽：三级同 id，list 恒一、resolve 落项目根
4. 回退链：项目未注册→全局未注册→学习命中；项目根 SKILL_PARAM_MISSING 不回退
5. `SUNSHINEX_USER_SKILLS_DIR` 覆盖全局根生效
6. selfcheck 技能计数仍为 21（迁移后三根合并口径不缩水）
7. 全量门禁：tsc strict 零报错、全量测试 fail 0、selfcheck OK

## 7. 不做（YAGNI）

- 不做旧路径兼容扫描（上新删旧，无过渡期）
- 不做技能清单常驻提示词（模型自主发现/触发，独立特性线；fork P4 置尾裁决不受影响）
- 跨设备同步、技能市场不做

## 8. 实施计划预告

预计 4 任务 TDD：

- T1 `userSkillsDir()` 解析与 override + 测试卫生（HOME/USERPROFILE 重定向）
- T2 skills.ts 三根合并 + 回退链 + 遮蔽用例
- T3 selfcheck 物料迁移 `.sunshinex/skills/` + perception 跳过 + 技能计数钉 21
- T4 文档同步（CLAUDE.md §3/§6、README、TUI-MANUAL）
