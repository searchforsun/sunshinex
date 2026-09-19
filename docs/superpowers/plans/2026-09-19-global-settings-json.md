# 全局配置 settings.json 化 · 实施计划

- 日期：2026-09-19
- 规格锚点：`docs/superpowers/specs/2026-09-19-global-settings-json-design.md`（ce20069，用户已批准）
- 执行方式：主代理会话内联 TDD（goal / 子代理 / goal 计划三先例同款）
- 基线：全量测试 860/860、selfcheck OK、工作区含他线 WIP 11 文件（本线改动面与其几乎零交集，唯三份文档重叠，协调策略见 §3）

## 0. 全局约束（贯穿全部任务）

1. **TDD 纪律**：每任务先红灯（新语义断言在场并失败）后绿灯（最小实现转绿）；红灯必须真实运行过，禁止以 grep 命中数当闸门（T4-6 事故先例，闸门一律 fail 0 硬断言）。
2. **门禁三件套**：`pnpm build`（tsc strict 零报错）+ 全量测试（fail 0）+ `selfcheck`；收口任务复验一次全量。
3. **定点提交**：每任务 `git add` 仅限本任务文件清单，严禁 `git add -A` / `git add .`；他线 WIP 零触碰。
4. **单文件单编辑**：同一文件同轮不并发两次编辑（structured_output / fork 写入竞态两先例）。
5. **语义纪律**：`process.env` 只填缺省不覆盖（`loadEnv` 同款）；装载顺序即优先级；下游消费面零改动（语义键展平回 `SUNSHINEX_*` 槽）。
6. **测试卫生**：临时目录 `fs.mkdtempSync`；家目录重定向必须 HOME + USERPROFILE 双变量（win32 data-dir 三失败先例）；测试不触碰真实 `~/.sunshinex/`。

## 1. 任务拆分（4 任务 TDD 循环）

### Task 1 — settings 模块与单元用例

落点：新增 `src/config/settings.ts`、新增 `src/config/settings.test.ts`。

**红灯（先行）**——settings.test.ts 用例清单：

1. `parseSettingsFile` 合法文档：语义键与 env 块正确解析；`version` 缺省视为 1 可载。
2. `parseSettingsFile` 文件缺失：返回 `null` 不抛错。
3. `parseSettingsFile` 畸形 JSON：抛错且 message 同时含**文件路径**与解析错误原文。
4. `parseSettingsFile` 根非对象 / `version` 非 1：拒载抛错含路径（fail-fast 语义，D7/D8）。
5. `flattenSettings`：语义键→槽映射正确（抽查 `model`/`baseUrl`/`tier`/`language`/`contextWindow`/`structuredOutput` 六键）；**同槽语义键 > env 块**（D3）；`contextWindow` 数字 `String()` 归一；未知语义键进告警清单不致命；值非 string/number 告警忽略。
6. `applySettings`：只填缺省——已导出环境变量不被覆盖、文件已删场景返回 0；返回 `{ loaded, warnings }`。
7. 路径拼装：`loadProjectSettings(root)` = `<root>/.sunshinex/settings.json`；`loadGlobalSettings()` = `userConfigDir()/settings.json`。

**绿灯**——settings.ts 实现：

- `parseSettingsFile(path)`：`readFileSync` utf8 → `JSON.parse` → 根形状/版本守卫 → `{ semantic, env } | null`；所有抛错路径 message 携带 `path`。
- `SEMANTIC_KEYS` 映射表单点：规格 §6 全表 18 键（含 `language` → `SUNSHINEX_LANGUAGE` 新槽；`*API_KEY` 不在表内，D6）。
- `flattenSettings(doc)`：语义键映射 + env 块合并，同槽语义键胜出；形状检查产出 warnings。
- `applySettings(path)`：parse → flatten → fill-missing 写 `process.env`。
- 零新依赖（`JSON.parse` 内置）；纯 Node 内置模块（fs/path/os 经 env.ts 的 `userConfigDir()`）。

提交：仅上述 2 新文件。

### Task 2 — 入口接线与硬切换

落点：`src/config/env.ts`、`src/config/env.test.ts`、`src/cli/index.ts`、`src/index.ts`、`src/config/settings.test.ts`（补集成用例）。

**红灯**：

8. **四层优先级链**（env.test.ts L47 三级链用例迁移改写为 settings 版，落 settings.test.ts）：HOME/USERPROFILE 重定向临时家目录 + 临时项目目录；全局 settings 层设 `SETT1=from-global-settings`（语义键）/ env 块键；项目 settings 层覆盖其一；项目 `.env` 再覆盖；shell 预导出一键最高；按入口真实顺序 `loadEnv(proj)` → `loadProjectSettings(proj)` → `loadGlobalSettings()` 装载后逐键断言四层胜出关系。
9. **language 槽**：settings `language: "zh"` → `process.env.SUNSHINEX_LANGUAGE === 'zh'`；shell 已导出 `SUNSHINEX_LANGUAGE` 时不被覆盖。

**绿灯**：

- `env.ts`：删除 `loadGlobalEnv()`（L45-51 注释与函数体）；`userConfigDir()`/`parseDotenv`/`loadEnv`/`resolveKbEnv` 不动。
- `env.test.ts`：删 `loadGlobalEnv` import 与三级链用例（迁 settings.test.ts 改写）；其余 4 用例不动。
- `cli/index.ts` main()（L79-86 区段）：「三级配置链」注释与装载改三步 `loadEnv()` → `loadProjectSettings()` → `loadGlobalSettings()`；applySettings 告警经 stderr 逐行 `t()` 双语输出（外观通道）；L86 改 `setLanguage(parseLanguage(args.flags.language ?? process.env.SUNSHINEX_LANGUAGE))`——`parseLanguage` 本体不动（'zh' 生效、其余 en，回退链由调用点 `??` 承载）。
- `src/index.ts`（L1-6）：同款三步装载（该入口无 setLanguage）；头注释同步四级链口径。

提交：上述 5 文件。

### Task 3 — 文档与仓库卫生同步

落点：`README.md`、`TUI-MANUAL.md`、`.env.example`、`.gitignore`。

- README「配置对标 Claude Code 用户级惯例」段：全局配置改 `~/.sunshinex/settings.json`，给语义键 + env 块等价示例、四级优先级句、**一行迁移说明**（旧 `~/.sunshinex/.env` 不再读取：设置键转语义键、密钥原样进 `env` 块）。
- TUI-MANUAL §三「模型配置」：全局级行与示例块改 settings.json 形态（env 块放密钥），优先级句改四级；§八故障排查「检查项目级或全局 `~/.sunshinex/.env`」行改 settings.json。
- `.env.example` L1-4 头注：全局级指引改 `~/.sunshinex/settings.json`、优先级句改四级；正文键位注释不动（项目 `.env` 仍是有效载体）。
- `.gitignore`：`.env` 行后补 `.sunshinex/settings.json`（D4 安全缺省；精确文件路径，不影响 `.sunshinex/skills/` 入库与装载）。

提交：4 文件；他线 WIP 处置按 §3.1 现场裁决。

### Task 4 — 全量门禁与自审收口

- 门禁：`pnpm build` 零报错；全量测试 fail 0（预期新增 9±2 用例）；`selfcheck` OK。
- 自审：全仓 `loadGlobalEnv` 零残留（grep 终验）；settings 装载面动态源盘点（配置在装配前载入即会话级常量，确认零进提示词动态面）；本线不触碰 buildPrompt/assemble/链行，前缀缓存零影响复核。
- 收口提交（如有遗留）+ 交付回执（提交清单、门禁结果、迁移说明）。

## 2. 规格裁决 → 任务映射

| 规格裁决 | 落点 |
|---|---|
| D1 混合形态/展平落槽 | T1 映射表 + applySettings |
| D2 四层优先级 | T2 入口三步装载 + 用例 8 |
| D3 同文件语义键 > env 块 | T1 flattenSettings + 用例 5 |
| D4 两级层级 + 项目级 gitignore | T1 路径拼装 + T3 .gitignore |
| D5 硬切换删 loadGlobalEnv | T2 |
| D6 密钥不语义键 | T1 映射表（无 *API_KEY 键） |
| D7/D8 容错三态 + 版本守卫 | T1 parseSettingsFile + 用例 3/4 |
| D9 language 新槽 + 回退链 | T1 映射表 + T2 cli L86 调用点 + 用例 9 |

## 3. 风险与协调登记

1. **文档三文件他线 WIP**：README/TUI-MANUAL/.env.example 当前带他线未提交改动（rules 清退线）。Task 3 编辑叠加于工作区现状之上；提交时若他线仍未落库，按项目「并发 WIP 随批入库并注明」先例（tier 92ab44a 批次先例）随批入库并在提交信息注明归属，或暂缓 Task 3 待他线先落库——执行时按当时 `git status` 现场裁决，不静默卷入。
2. **parseLanguage 兜底形态**：`--language`（裸 flag）解析为 boolean true，`??` 短路仅在 flag 缺省（undefined）时取 env；boolean true 经 parseLanguage 归 en，语义不破。
3. **ignore 精确性**：`.sunshinex/settings.json` 精确到文件路径，`.sunshinex/skills/` 装载与入库不受影响（收口时以 `git check-ignore` 验证）。
4. **测试家目录**：全程 mkdtemp + HOME/USERPROFILE 双重定向，用例结束恢复原值（沿用 env.test 既有先例）。

## 4. 验收矩阵（对齐规格 §11）

1. 四层优先级链逐层覆盖与兜底断言绿（用例 8）。
2. settings 设 `tier`/`baseUrl`/`model` 后既有消费点零改动生效（展平落槽）。
3. 全仓 `loadGlobalEnv` 零残留；全局 `~/.sunshinex/.env` 读取路径不存在。
4. 畸形 JSON / version 非 1 启动即报错退出，message 含文件路径。
5. 已导出环境变量与项目 `.env` 不被 settings 覆盖。
6. 项目级 `.sunshinex/settings.json` 不入库（git check-ignore 命中），`.sunshinex/skills/` 仍正常入库装载。
7. 三门禁全绿（tsc strict 零报错、全量 fail 0、selfcheck OK）。
8. README / TUI-MANUAL / .env.example 与实现口径一致，含迁移说明。
