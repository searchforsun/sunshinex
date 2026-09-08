# 阶段四 MCP 生态与全场景能力 实施计划（P0）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec `docs/superpowers/specs/2026-09-08-phase4-mcp-ecosystem-design.md`（v2，24b4719）的五模块：MCP 官方 SDK 接入、工具面扩展（目录 grep + webfetch）、路由可观测/缓存计数/流式、本地向量知识库（可插拔后端，缺省 local-json）、技能模板调度；对应验收 §4-1…4-7。

**Architecture:** 全部新能力汇入既有统一运行时主链（Context→Loop→Tool→Safety→Memory），零旁路：新工具一律经 `ToolRegistry.register` + `SafetyChain`；技能是上下文注入非执行通道；知识库经内置工具 `kb_search` 消费。外部依赖可插拔：`@modelcontextprotocol/sdk` 收敛于 `McpHost` 接缝内；向量后端经注册表按 `KB_BACKEND` 装配。

**Tech Stack:** TypeScript 5.x（strict）、Node.js ≥22.9 内置 `node --test`、CommonJS；唯一新增运行时依赖 `@modelcontextprotocol/sdk`（仅 T6 安装，锁定版本，登记 CLAUDE.md；安装失败走 R6 预案回退自研 stdio JSON-RPC 子集，`McpHost` 接口不变）。

## Global Constraints

- 测试仅用 `node --test`；`tsconfig` 保持 strict；模块 CommonJS，import 用相对路径。
- 每任务红绿 TDD：先写失败测试 → 确认红 → 最小实现 → 确认绿 → 独立 commit。
- 提交前门禁：`npm run build` 0 报错、全量测试 0 失败、`npm run selfcheck` 通过。
- 安装依赖须 `npm install --cache .npm-cache`（HOME 不可写）；`.npm-cache/`、`.data/`、`node_modules/`、`dist/` 不入库；`.env` 键新增不入库。
- 缺省交付零依赖路径：sqlite-vec/chromadb 不进 P0（P1 独立 plan）；`KB_BACKEND` 指向未注册后端装配期 fail-fast，禁止静默回退。
- 外部工具安全闸门：`mode: 'dontAsk'` 不豁免（白名单空 = 全禁、参数体积上限、单次超时、结果统一过 mask 出口）。
- 仅通过 sandbox 工具读写 `/workspace/wt-59f36a81fc`；禁止写 `/skills`。

---

### Task 1: 类型与配置脚手架（全计划地基）

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`（SUNSHINE.md 分区解析）
- Modify: `src/config/env.ts`（KB/embedding 键）
- Create: `src/config.mcp.test.ts`、`src/config.kb.test.ts`

**Interfaces:**
- `ToolCategory = 'read' | 'write' | 'bash' | 'network' | 'external'`
- 新增类型：`RouteDecision { tier: ModelTier; reason: string }`、`KbHit { id; text; score }`、`SkillRef { id: string; params?: Record<string, string> }`、`McpServerConfig { name; command; args?; env? }`、`EmbeddingProvider { embed(texts: string[]): Promise<number[][]> }`
- `SkillManifest` 增量：`params?: string[]`、`kind: 'prompt'`
- `parseSunshinex` 增量函数：`parseMcpServers(doc): McpServerConfig[]`（「MCP 服务器」分区，行式 `name | command | args...`）、`parseNetworkAllowlist(doc): string[]`（「网络白名单」分区，每行一个域名）；分区缺省 = 空数组（空 = 全禁，安全缺省）
- env 键：`KB_BACKEND`（缺省 `local-json`）、`EMBEDDING_BASE_URL/EMBEDDING_API_KEY/EMBEDDING_MODEL`（缺省回退 `OPENAI_*`）

- [x] Step 1: 写失败测试——SUNSHINE.md 样例含「MCP 服务器 / 网络白名单」分区，断言解析出 `McpServerConfig[]` 与域名数组；分区缺失断言空数组；非法行断言跳过不抛
- [x] Step 2: `npm run build && node --test dist/config.*.test.js` 确认红
- [x] Step 3: 最小实现 types 增量 + 两个解析函数 + env 键读取
- [x] Step 4: 确认绿（新测试 PASS 且全量不回归）
- [x] Step 5: 提交 `feat(types): 阶段四类型与配置脚手架——network/external 类别、MCP/白名单分区解析、KB/embedding env 键`（已完成：083ac89，基线 183/183/0）

---

### Task 2: 工具面扩展 —— 目录级 grep 与 webfetch

**Files:**
- Modify: `src/harness/tools/builtin.ts`、`src/harness/tools.ts`
- Modify: `src/harness/security/policy.ts`（network/external 策略分支）
- Create: `src/harness/tools/glob.test.ts`、`src/harness/tools/webfetch.test.ts`、`src/harness/security/policy.network.test.ts`

**Interfaces:**
- `grep` 升级：`path` 允许目录（safePath 判界内递归），新增 `glob?: string` 过滤；命中行数上限 200（截断并在结果尾注记 `truncated: true`）
- 新增 `webfetch` 工具（category `network`）：入参 `{ url }`；域名白名单（Task 1 的 `parseNetworkAllowlist`）不在名单 → guard 拒绝；正文截断上限 100_000 字符；结果过 `maskResult` 出口
- 复用既有 `CANONICAL_TOOL_NAMES` 追加 `webfetch` 映射；不新增 git/db 专项工具（exec 已覆盖）

- [ ] Step 1: 失败测试——目录 grep 命中多文件并按 glob 过滤、超 200 行截断断言；webfetch 白名单外拒绝、名单内（本地 mock http server）命中并截断；`external` 类工具在白名单空时 evaluate 拒绝
- [ ] Step 2: 确认红
- [ ] Step 3: 最小实现（grep 递归复用 `glob` 遍历逻辑；webfetch 用 `fetch` + 白名单闸门 + 截断）
- [ ] Step 4: 确认绿 + 全量不回归
- [ ] Step 5: 提交 `feat(tools): 目录级 grep（glob 过滤+行上限）与 webfetch（域名白名单闸门）`

---

### Task 3: 路由可观测、缓存计数与模型流式

**Files:**
- Modify: `src/model/adapter.ts`、`src/harness/context/session.ts`、`src/cli/commands/selfcheck.ts`
- Create: `src/model/stream.test.ts`、`src/model/route-decision.test.ts`、`src/harness/context/session-hitrate.test.ts`

**Interfaces:**
- `ModelRouter.route(hint?: { complexity?: 'low'|'mid'|'high'; role?: string }): RouteDecision`——决策留痕（tier + reason），随 run 结果返回
- `ModelAdapter.completeStream(req, onDelta: (t: string) => void): Promise<Completion>`——OpenAI 适配器以 `stream: true` + SSE `data:` 行解析（零依赖 reader）；`ScriptedAdapter` 逐字吐出；`complete()` 签名不动
- `SessionStore` 增量：`hit/miss` 计数器 + `hitRate(): number`；selfcheck 追加「缓存命中率」汇总行

- [ ] Step 1: 失败测试——scripted `completeStream` 逐 token 回调序列断言；`route(hint)` 决策与 reason 留痕断言；session 命中率计数断言
- [ ] Step 2: 确认红
- [ ] Step 3: 最小实现（SSE 解析：`for await` body reader 按 `\n\n` 分帧、`data: [DONE]` 终止；router 决策记录进 run ledger）
- [ ] Step 4: 确认绿 + 全量不回归
- [ ] Step 5: 提交 `feat(model): RouteHint 决策留痕、completeStream 流式（SSE 零依赖）、缓存命中率计数`

---

### Task 4: 向量知识库核心（local-json，可插拔接缝）

**Files:**
- Create: `src/harness/knowledge/embed.ts`、`chunk.ts`、`store.ts`、`store.conformance.ts`、`index.ts`（+ 各自 `.test.ts`）
- Modify: `src/harness/tools/builtin.ts`（新增 `kb_search`）、`src/cli/commands/selfcheck.ts`

**Interfaces:**
- `EmbeddingProvider`（Task 1 类型）：默认实现 `OpenAICompatEmbeddings`（`POST {EMBEDDING_BASE_URL}/embeddings`，批量入参）；测试以桩注入，不发真实网络
- `chunk.ts`：`chunkMarkdown(text): string[]`——标题/段落聚合，块 ≤1200 字符、重叠 ~100
- `store.ts`：`VectorStore` 接口（`upsert(id, vec, meta)` / `search(vec, topK): KbHit[]` / `size()` / `load()` / `flush()`）+ 后端注册表 `registerVectorBackend(name, factory)` + `createVectorBackend(name)`（未注册 → 抛装配错误，fail-fast）+ `LocalJsonVectorStore`（FileStore 之上，向量归一化 + 暴力余弦）
- `store.conformance.ts`：`runVectorStoreConformance(create: () => VectorStore)`——全后端必过契约（写入/召回/TopK 语义/持久化/损坏恢复），本任务对 `local-json` 全绿，P1 sqlite-vec 复用
- `index.ts`：`KnowledgeBase { indexDir(dir): Promise<number>; search(query, topK): Promise<KbHit[]>; stats() }`
- `kb_search` 内置工具（category `read`）：入参 `{ query, topK? }`；embedding 端点未配置 → `Result.fail('kb_not_configured')` 降级，不阻塞其他工具

- [ ] Step 1: 失败测试——conformance 套件对 local-json 跑红（实现缺失）；chunk 边界用例（标题聚合/超长切分/重叠）；`kb_search` 未配置端点降级断言
- [ ] Step 2: 确认红
- [ ] Step 3: 最小实现（注册表 + local-json + conformance 全绿）
- [ ] Step 4: 确认绿（conformance PASS + 已知文档 top-3 命中用例 PASS）
- [ ] Step 5: 提交 `feat(knowledge): 向量知识库 local-json 后端——可插拔注册表+conformance 契约套件+kb_search 工具`

---

### Task 5: 技能模板调度 —— resolveSkill 与 skillRef 首帧注入

**Files:**
- Modify: `src/harness/skills.ts`、`src/loop/engine.ts`（请求侧 skillRef）、`src/runtime.ts`（buildDeps 接线）、`src/cli/commands/selfcheck.ts`
- Create: `src/harness/skills.resolve.test.ts`、`skills/examples/hello-sunshine/skill.md`

**Interfaces:**
- `resolveSkill(skillsDir, id, params?): Result<ResolvedSkill>`——`ResolvedSkill { manifest; body }`；未注册 id / `{{param}}` 缺参 → `fail`（明确错误信息）
- Loop 请求侧增量：请求可携 `skillRef: SkillRef`，assemble 首帧注入技能正文（参数替换后），Loop/Graph 执行语义零改动
- `runtime.buildDeps`：调用 `loadSkills(root/skills)` 装入 Harness，暴露 `skills.list()/get(id)`
- 示例技能 `skills/examples/hello-sunshine/skill.md`（frontmatter 含 `kind: prompt` 与 `params: name`）；selfcheck 以 scripted 模型走通一次 skillRef 调度并断言注入内容

- [ ] Step 1: 失败测试——resolve 命中/未注册/缺参三态断言；scripted 任务经 skillRef 注入后输出含技能正文标记
- [ ] Step 2: 确认红
- [ ] Step 3: 最小实现（参数 `{{name}}` 替换 + 首帧注入 + 装配接线 + 示例技能）
- [ ] Step 4: 确认绿 + selfcheck 新增技能调度行
- [ ] Step 5: 提交 `feat(skills): 技能模板调度——resolveSkill 参数化 + skillRef 首帧注入 + 装配接线`

---

### Task 6: MCP 官方 SDK 接入（安全闸门 + mock 全链路）

**Files:**
- Modify: `package.json`、`CLAUDE.md`（依赖登记段）
- Create: `src/harness/mcp/client.ts`、`client.test.ts`、`scripts/mock-mcp-server.js`（测试专用 stdio JSON-RPC 脚本，零网络）

**Interfaces:**
- `McpHost { constructor(servers: McpServerConfig[], registry: ToolRegistry, chain: SafetyChain); registerTools(): Promise<number>; close(): Promise<void> }`——懒 spawn、handshake、`tools/list` → `registry.register`，工具规范名 `mcp__<server>__<tool>`（category `external`）
- 调用执行器：单次超时 30s、参数 JSON ≤64KB、白名单 = SUNSHINE.md 服务器清单本身（空 = 全禁）、失败返回 `Result.fail`（分域错误契约，不拖垮 Loop/Graph）
- SDK 安装（首步）：`npm install --cache .npm-cache @modelcontextprotocol/sdk` 并锁版本；**失败回退 R6 预案**：自研最小 stdio JSON-RPC 客户端实现同接口，commit 注明降级
- `mock-mcp-server.js`：实现 `initialize` → `tools/list`（一个 echo 工具）→ `tools/call` 的最小 JSON-RPC server，供测试零网络全链路

- [ ] Step 0: 安装 SDK（或记录回退决策）
- [ ] Step 1: 失败测试——mock server 全链路：handshake → tools/list 注册数断言 → 经 `registry.execute`（走 SafetyChain）调用 echo 返回脱敏结果；越权 server（不在清单）拒绝；慢 server 超时 fail
- [ ] Step 2: 确认红
- [ ] Step 3: 最小实现（McpHost + 策略分支 + `CANONICAL_TOOL_NAMES` 不动，`mcp__` 名走 external 策略）
- [ ] Step 4: 确认绿 + 全量不回归
- [ ] Step 5: 提交 `feat(mcp): McpHost 官方 SDK 接入——external 安全闸门+懒连接+mock stdio 全链路测试`

---

### Task 7: 收口 —— selfcheck 门禁与文档同步

**Files:**
- Modify: `src/cli/commands/selfcheck.ts`、`docs/ROADMAP.md`、`CLAUDE.md`

- [ ] Step 1: selfcheck 新增四行：MCP（服务器清单解析 + mock 注册）、工具面（grep/webfetch）、知识库（conformance + top-3 命中）、技能（skillRef 调度）
- [ ] Step 2: ROADMAP 阶段四测试基线数修正为实测值；CLAUDE.md 目录树增 `harness/mcp/`、`harness/knowledge/`，依赖登记 `@modelcontextprotocol/sdk`（用途/边界/回退）
- [ ] Step 3: 全量门禁：`npm run build` 0 报错、`node --test` 全绿、`npm run selfcheck` 全行通过
- [ ] Step 4: 提交 `chore(phase4): selfcheck 四行门禁 + ROADMAP/CLAUDE.md 文档同步`

---

## P1（后续独立 plan，不在本计划展开）

- **T8 sqlite-vec 可插拔后端**：驱动 spike（`better-sqlite3`+sqlite-vec vs `node:sqlite`）→ `backends/sqlite-vec.ts` → 复跑 `store.conformance.ts` 全绿 → 成功信号：conformance 全绿 + 1 万块检索 P95 两位数毫秒。
- MCP HTTP/SSE 传输、记忆→技能沉淀闭环（spec §5 边界留位）。

## 验收对照（spec §4）

| spec 验收 | 承接任务 |
| --- | --- |
| §4-1 MCP 全链路 | Task 6 |
| §4-2 工具面 | Task 2 |
| §4-3 路由/缓存/流式 | Task 3 |
| §4-4 知识库 | Task 4（sqlite-vec 部分留 P1） |
| §4-5 技能调度 | Task 5 |
| §4-6 门禁 / §4-7 文档 | Task 7（各任务门禁随提交持续验证） |
