# 全局配置 settings.json 化设计规格

- 日期：2026-09-19
- 状态：待评审
- 前置裁决（用户已定，本规格只做展开与收口）：①形态=语义键 + env 透传块（混合式，对标 Claude Code）；②优先级=环境变量 > 项目 .env > settings.json > 内置缺省（项目覆盖全局）；③兼容=硬切换（settings.json 为唯一全局配置源，删除全局 .env 读取）；④层级=两级（全局 `~/.sunshinex/settings.json` + 项目级 `.sunshinex/settings.json`）

## 1. 背景与动机

现状全局配置为 `~/.sunshinex/.env`（`src/config/env.ts` 的 `userConfigDir()` + `loadGlobalEnv()`，`src/cli/index.ts:82` 与 `src/index.ts:5` 两入口接线），与项目 `.env` 共用 dotenv 解析；全部键位为扁平 `SUNSHINEX_*` 环境变量，下游全部经 `process.env` 消费。

问题：JSON 设置文件承载「设置」是行业主流形态（Claude Code / Gemini CLI 均为 settings.json，Codex 为 config.toml）；`.env` 的行业定位是部署期环境变量与密钥载体。迁移目标不是消灭 `.env`，而是：设置项升级进 settings.json、密钥获得官方容身之所（env 透传块）、项目级 `.env` 照旧。

## 2. 行业对标

| 工具 | 全局设置 | 密钥 |
|---|---|---|
| Claude Code | `~/.claude/settings.json`（语义键 + env 块，user/project/local 三级） | settings 的 env 块 / apiKeyHelper / 环境变量 |
| Codex CLI | `~/.codex/config.toml` | `auth.json` 独立文件 |
| Gemini CLI | `~/.gemini/settings.json` | 环境变量 / keychain |
| SunshineX 现状 | `~/.sunshinex/.env` | 同一个文件 |

## 3. 目标形态

全局与项目级同一 schema（camelCase 语义键 + `env` 透传块）：

```json
{
  "version": 1,
  "model": "glm-5.3-flash",
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "tier": "medium",
  "contextWindow": 1000000,
  "language": "zh",
  "env": {
    "SUNSHINEX_API_KEY": "sk-…",
    "SUNSHINEX_BING_API_KEY": "…"
  }
}
```

## 4. 关键裁决

- **D1 混合形态**：语义键 + `env` 透传块。装载时语义键按映射表**展平写回对应 `SUNSHINEX_*` 的 `process.env` 缺省槽**，下游 20+ 消费点零改动；env 块承载密钥与尚未语义化的键，键名即 `SUNSHINEX_*` 原名。
- **D2 优先级链**：已导出环境变量 > 项目根 `.env` > 项目级 settings.json > 用户级 settings.json > 内置缺省。实现沿用「后装者只填缺省」语义（`loadEnv` 同款），入口装载顺序 `loadEnv()` → `loadProjectSettings()` → `loadGlobalSettings()`，顺序即优先级。
- **D3 同文件内语义键 > env 块**：语义键是设置的正名，env 块是兜底透传；同一 `SUNSHINEX_*` 槽两者同现时语义键胜出。
- **D4 两级层级 + 项目级安全缺省**：全局 `~/.sunshinex/settings.json` 与项目级 `<启动目录>/.sunshinex/settings.json`。项目级文件**加入 `.gitignore`**（env 块可含密钥，安全缺省对齐 `.env` 处理）；单机工具不设可共享分层（见 §10 YAGNI）。
- **D5 硬切换**：删除 `loadGlobalEnv()` 与全局 `~/.sunshinex/.env` 读取；`userConfigDir()` 保留（数据目录与全局技能根仍依赖）。
- **D6 密钥不设语义键**：凡 `*API_KEY` 一律不进语义键清单，只走 env 块或环境变量（对标 Claude Code 将密钥放 env 块的定位，设置与凭据分离）。
- **D7 容错语义**：文件缺失静默跳过（对齐 `loadEnv` 现状）；**畸形 JSON fail-fast**——stderr 报错（含文件路径与解析错误）后 `process.exit(1)`，不静默吞（对标会话持久化版本守卫先例：配置读不出来必须让用户知道，静默降级会演变成「key 没生效」的排查泥潭）；未知语义键忽略 + stderr 一行告警；值类型非字符串/数字告警忽略。
- **D8 版本守卫**：可选 `version` 字段，缺省视为 1；非 1 拒载 fail-fast（同 D7 通道），为未来 schema 演进留闸门。
- **D9 language 语义键**：新增 `SUNSHINEX_LANGUAGE` 环境槽，优先级 `--language` 启动参数 > `SUNSHINEX_LANGUAGE` > 缺省 en。这是唯一需要下游接线新增的键（CLI `parseLanguage` 回退链加一档）；其余语义键展平落槽即生效，零下游改动。

## 5. 装载语义

- 展平结果按「只填缺省」写入 `process.env`：已导出环境变量不被覆盖、先装层级（项目 `.env`）不被后装层级覆盖——与现行 `loadEnv` 语义完全一致，顺序即优先级。
- 项目级 settings 以**进程启动目录**为基准（与 `loadEnv()` 读 `cwd/.env` 同构，不随 `<dir>` 目标参数漂移），登记为与现状一致的对齐点。
- 值校验不复制：settings 层只做「键在清单内、值为字符串或数字」的形状检查；`tier`/`language`/`structuredOutput` 等取值合法性由既有各域解析器（`parseTier`/`parseLanguage` 等）统一裁决，单一校验权威，不在两层重复。
- `contextWindow` 接受数字或数字字符串，展平时 `String()` 归一。

## 6. 语义键清单 v1

| 语义键 | env 槽 |
|---|---|
| `model` | `SUNSHINEX_MODEL` |
| `modelSmall` / `modelMedium` / `modelLarge` | `SUNSHINEX_MODEL_SMALL/MEDIUM/LARGE` |
| `baseUrl` | `SUNSHINEX_BASE_URL` |
| `tier` | `SUNSHINEX_TIER` |
| `language` | `SUNSHINEX_LANGUAGE`（新槽，见 D9） |
| `contextWindow` | `SUNSHINEX_CONTEXT_WINDOW` |
| `structuredOutput` | `SUNSHINEX_STRUCTURED_OUTPUT` |
| `kbBackend` / `kbDataDir` | `SUNSHINEX_KB_BACKEND` / `SUNSHINEX_KB_DATA_DIR` |
| `dataDir` | `SUNSHINEX_DATA_DIR` |
| `userSkillsDir` | `SUNSHINEX_USER_SKILLS_DIR` |
| `embeddingBaseUrl` / `embeddingModel` | `SUNSHINEX_EMBEDDING_BASE_URL` / `SUNSHINEX_EMBEDDING_MODEL` |
| `websearchProvider` / `websearchEndpoint` | `SUNSHINEX_WEBSEARCH_PROVIDER` / `SUNSHINEX_WEBSEARCH_ENDPOINT` |

规则：即 `.env.example` 全部非密钥键的语义化（`SUNSHINEX_SHELL` 平台逃生口保持仅 env 块/环境变量；`SUNSHINEX_API_KEY`/`SUNSHINEX_BING_API_KEY`/`SUNSHINEX_EMBEDDING_API_KEY` 按 D6 只走 env 块）。

## 7. 实现落点

| 落点 | 改动 |
|---|---|
| `src/config/settings.ts`（新增） | `parseSettingsFile`（读盘+版本守卫+形状检查）/ `flattenSettings`（语义键映射 + env 块合并、语义键优先）/ `applySettings`（只填缺省入 `process.env`，返回计数与告警）/ `loadProjectSettings(root?)` / `loadGlobalSettings()`；`JSON.parse` 内置能力，零新依赖 |
| `src/config/env.ts` | 删除 `loadGlobalEnv()`；`userConfigDir()`/`parseDotenv`/`loadEnv` 不动 |
| `src/cli/index.ts:82`、`src/index.ts:4-5` | 装载改三步：`loadEnv()` → `loadProjectSettings()` → `loadGlobalSettings()`；告警经 stderr 逐行输出（`t()` 双语，外观通道） |
| `.gitignore` | 补 `.sunshinex/settings.json`（D4 安全缺省） |
| `README` 全局配置段、`TUI-MANUAL` 模型配置段、`.env.example` 头注 | 全局级指引由 `~/.sunshinex/.env` 改为 `~/.sunshinex/settings.json`；项目级 `.env` 说明保留 |
| `src/config/env.test.ts` | 三级优先级用例改写（旧 `loadGlobalEnv` 断言删除） |

前缀缓存影响：零。配置在装配前载入、成为会话级常量，不新增任何进提示词的动态面。

## 8. 测试计划（TDD）

新建 `src/config/settings.test.ts`：

1. `parseSettingsFile`：合法文档解析出语义键与 env 块；文件缺失返回 null。
2. `flattenSettings`：语义键映射正确；同槽语义键 > env 块；未知语义键进告警清单。
3. `applySettings`：只填缺省不覆盖已导出环境变量；返回装载计数。
4. 畸形 JSON：抛错且信息含文件路径与解析错误。
5. `version` 字段：缺省视为 1 可载；非 1 拒载。
6. 四层优先级链（HOME/USERPROFILE 重定向 + 临时目录，沿用 env.test 既有先例）：shell > 项目 `.env` > 项目 settings > 全局 settings。
7. `contextWindow` 数字归一为字符串槽值。
8. `language` → `SUNSHINEX_LANGUAGE` 槽；CLI `parseLanguage` 回退链新档（`--language` > env > en）补断言。

## 9. 破坏性变更与迁移

- 升级后 `~/.sunshinex/.env` **不再被读取**。迁移 = 原内容搬入 `~/.sunshinex/settings.json`：设置类键建议转语义键（如 `SUNSHINEX_MODEL=x` → `"model": "x"`），密钥与懒得起名的键原样进 `env` 块（键名不变）。
- README 全局配置段给一行迁移说明与等价示例。

## 10. YAGNI 登记

- `settings.local.json` 可共享/本地分层（对标 CC user/project/local 三级）——单机工具后置，项目级已整体 gitignore。
- settings JSON Schema 文件与编辑器补全。
- 配置来源追踪（哪个文件设置了哪个键）与跨文件深合并视图。
- TOML 等其他格式（JSON 足够，零新依赖）。

## 11. 验收矩阵

1. 四层优先级链逐层覆盖与兜底断言通过（测试 6）。
2. 语义键展平后下游消费零改动即生效（如 settings 设 `tier` 后 reactor 读到 `SUNSHINEX_TIER`）。
3. 全局 `.env` 读取路径删除，全仓 `loadGlobalEnv` 零残留。
4. 畸形 JSON 启动即报错退出，错误信息含路径。
5. 项目级 `.sunshinex/settings.json` 不入库（.gitignore 生效）。
6. `pnpm build` + 全量测试 + `selfcheck` 三门禁全绿。
7. README / TUI-MANUAL / .env.example 与实现口径一致。

## 12. 自答

- **为何展平回 env 槽而非新建 Settings 模块贯穿下游**：下游全部经 `process.env` 消费，展平零改动零漂移；将来确需结构化 Settings（类型化嵌套）再整体升级，现不预支。
- **为何项目级整体 gitignore 而非共享/本地分文件**：env 块可含密钥是主要风险源，安全缺省优先；共享分层场景（团队共用项目设置）对单机工具不成立，登记 YAGNI。
- **为何 `language` 特批进首批**：它是真正的用户级个人偏好（界面+提示词语言），且是现有键位中唯一没有 env 槽的设置项；接线量一处（parseLanguage 回退链）。
