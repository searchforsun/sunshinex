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
- 子任务粒度：每个子任务（Task xN）执行目标 ≤15 分钟（含红绿测试与提交）；预估超限即再拆，禁止跨域合并成大任务。

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

- [x] Step 1: 失败测试——目录 grep 命中多文件并按 glob 过滤、超 200 行截断断言；webfetch 白名单外拒绝、名单内（本地 mock http server）命中并截断；`external` 类工具在白名单空时 evaluate 拒绝
- [x] Step 2: 确认红
- [x] Step 3: 最小实现（grep 递归复用 `glob` 遍历逻辑；webfetch 用 `fetch` + 白名单闸门 + 截断）
- [x] Step 4: 确认绿 + 全量不回归
- [x] Step 5: 提交 `feat(tools): 目录级 grep（glob 过滤+行上限）与 webfetch（域名白名单闸门）`（已完成：09a1983 实现 + ddde526 死代码清理，基线 199/199/0）（已完成：09a1983 + ddde526 死代码清理，基线 199/199/0）

---

### Task 3: 路由可观测、缓存计数与模型流式（按 ≤15min 拆分为 3a/3b/3c）

---

### Task 3a: session 缓存命中率计数 + selfcheck 行（目标 ≤15min）

**Files:**
- Modify: `src/harness/context/session.ts`、`src/cli/commands/selfcheck.ts`
- Create: `src/harness/context/session-hitrate.test.ts`

**Interfaces:**
- `SessionStore` 增量：hit/miss 计数器 + `hitRate(): number`（零样本返回 0）
- selfcheck 追加「缓存命中率」汇总行（无样本显示 0.0，不得崩溃）

- [x] Step 1: 失败测试——hit/miss 计数、hitRate 边界（含零样本）
- [x] Step 2: 确认红
- [x] Step 3: 最小实现 + selfcheck 汇总行
- [x] Step 4: 确认绿 + 全量不回归
- [x] Step 5: 提交 `feat(context): session 缓存命中率计数与 selfcheck 汇总行`（已完成：f27848e）

---

### Task 3b: RouteHint 决策留痕（目标 ≤15min）

**Files:**
- Modify: `src/model/adapter.ts`
- Create: `src/model/route-decision.test.ts`

**Interfaces:**
- `ModelRouter.route(hint?: { complexity?: 'low'|'mid'|'high'; role?: string }): RouteDecision`，`RouteDecision { tier, reason }`；reason 说明依据（hint 命中或缺省回退）；决策随返回值供 run 层留痕

- [x] Step 1: 失败测试——complexity/role 各档映射 + 缺省回退 + reason 非空
- [x] Step 2: 确认红
- [x] Step 3: 最小实现（静态映射，不引入启发式）
- [x] Step 4: 确认绿 + 全量不回归
- [x] Step 5: 提交 `feat(model): RouteHint 决策留痕——route(hint) 返回 tier+reason`（已完成：90221e0）

---

### Task 3c: completeStream 流式（SSE 零依赖，目标 ≤15min）

**Files:**
- Modify: `src/model/adapter.ts`
- Create: `src/model/stream.test.ts`

**Interfaces:**
- `ModelAdapter.completeStream(req, onDelta: (t: string) => void): Promise<Completion>`——OpenAI 适配器 `stream: true`，SSE 解析（`for await` body reader 按 `\n\n` 分帧、`data: [DONE]` 终止、delta 提取）；`ScriptedAdapter` 逐字吐出；`complete()` 签名不动

- [x] Step 1: 失败测试——scripted 逐 token 序列断言；SSE 分帧解析以注入 reader 桩测试（不发真实网络）
- [x] Step 2: 确认红
- [x] Step 3: 最小实现
- [x] Step 4: 确认绿 + 全量不回归
- [x] Step 5: 提交 `feat(model): completeStream 流式——SSE 零依赖解析 + scripted 逐字输出`（已完成：ba34f27，本地 http SSE mock 全链路含跨 chunk 半帧用例，基线 214/214/0）

---

### Task 4: 向量知识库核心（按 ≤15min 拆分为 4a–4f）

---

### Task 4a: chunkMarkdown 分块器（目标 ≤10min）

**Files:**
- Create: `src/harness/knowledge/chunk.ts`、`chunk.test.ts`

**Interfaces:**
- `chunkMarkdown(text): string[]`——标题/段落聚合，块 ≤1200 字符、重叠 ~100

- [x] Step 1: 失败测试——标题聚合/超长切分/重叠边界/空文本
- [x] Step 2: 确认红
- [x] Step 3: 最小实现
- [x] Step 4: 确认绿
- [x] Step 5: 提交 `feat(knowledge): Markdown 感知分块器 chunkMarkdown`（已完成：4985d1d，基线 219/219/0）

---

### Task 4b: VectorStore 接缝 + 注册表 + local-json 后端（目标 ≤15min）

**Files:**
- Create: `src/harness/knowledge/store.ts`、`store.test.ts`

**Interfaces:**
- `VectorStore`：`upsert(id, vec, meta)` / `search(vec, topK): KbHit[]` / `size()` / `load()` / `flush()`
- `registerVectorBackend(name, factory)` + `createVectorBackend(name)`——未注册 → 装配期抛错（fail-fast，禁静默回退）
- `LocalJsonVectorStore`：FileStore 之上，向量归一化 + 暴力余弦

- [x] Step 1: 失败测试——注册/创建/未注册 fail-fast；upsert→search topK 语义；归一化余弦排序
- [x] Step 2: 确认红
- [x] Step 3: 最小实现
- [x] Step 4: 确认绿
- [x] Step 5: 提交 `feat(knowledge): VectorStore 接缝——注册表 fail-fast + local-json 余弦后端`（已完成：dd32ebb，基线实测 225/225/0）

---

### Task 4c: conformance 契约套件（目标 ≤10min）

**Files:**
- Create: `src/harness/knowledge/store.conformance.ts`、`store.local-json.conformance.test.ts`

**Interfaces:**
- `runVectorStoreConformance(create: () => VectorStore)`——写入/召回/TopK 语义/持久化/损坏恢复；P1 sqlite-vec 复用同一套件

- [x] Step 1: 失败测试——套件对 local-json 跑，暴露缺口（如损坏恢复）为红
- [x] Step 2: 确认红
- [x] Step 3: 补齐 local-json 缺口至全绿
- [x] Step 4: 确认绿
- [x] Step 5: 提交 `feat(knowledge): VectorStore conformance 契约套件——local-json 全绿`（已完成：5ff88fe，损坏恢复降级归属后端边界；基线实测 226/226/0，注：5ff88fe 提交信息中误记 232，以此为准）

---

### Task 4d: KnowledgeBase 编排（目标 ≤15min）

**Files:**
- Create: `src/harness/knowledge/index.ts`、`index.test.ts`

**Interfaces:**
- `KnowledgeBase { indexDir(dir): Promise<number>; search(query, topK): Promise<KbHit[]>; stats() }`——indexDir：读目录 md/txt → chunk → embed → upsert；search：query→embed→topK；`EmbeddingProvider` 桩注入，不发真实网络

- [x] Step 1: 失败测试——临时目录索引后已知查询 top-3 命中
- [x] Step 2: 确认红
- [x] Step 3: 最小实现
- [x] Step 4: 确认绿
- [x] Step 5: 提交 `feat(knowledge): KnowledgeBase 编排——indexDir/search/stats（桩注入）`（已完成：484bd2b，含分块器句子边界演进，基线 231/231/0）

---

### Task 4e: OpenAICompatEmbeddings 默认 Provider（目标 ≤10min）

**Files:**
- Create: `src/harness/knowledge/embed.ts`、`embed.test.ts`

**Interfaces:**
- `OpenAICompatEmbeddings implements EmbeddingProvider`——`POST {EMBEDDING_BASE_URL}/embeddings`（Bearer 鉴权、model 取 `EMBEDDING_MODEL`，缺省回退 `OPENAI_*`），批量入参；测试用本地 http server 或注入 fetch 桩

- [x] Step 1: 失败测试——请求头/体断言 + `data[].embedding` 提取 + 非法响应 fail
- [x] Step 2: 确认红
- [x] Step 3: 最小实现
- [x] Step 4: 确认绿
- [x] Step 5: 提交 `feat(knowledge): OpenAICompatEmbeddings 默认 Provider——/embeddings 批量适配`（已完成：5f0de97，基线 235/235/0）

---

### Task 4f: kb_search 内置工具 + selfcheck 行（目标 ≤15min）

**Files:**
- Modify: `src/harness/tools/builtin.ts`、`src/cli/commands/selfcheck.ts`
- Create: `src/harness/tools/kb-search.test.ts`

**Interfaces:**
- `kb_search`（category `read`）：入参 `{ query, topK? }`；embedding 未配置 → `Result.fail('kb_not_configured')` 降级不阻塞；结果过 mask 出口

- [x] Step 1: 失败测试——配置齐（桩）返回 topK；未配置降级 fail；category=read
- [x] Step 2: 确认红
- [x] Step 3: 最小实现 + selfcheck 知识库行
- [x] Step 4: 确认绿 + 全量不回归
- [x] Step 5: 提交 `feat(knowledge): kb_search 内置工具——未配置降级 + selfcheck 行`（已完成：899c35e，工具域 CodedToolError 带码错误通道，基线 239/239/0）

---

### Task 5: 技能模板调度（按 ≤15min 拆分为 5a/5b）

---

### Task 5a: resolveSkill 参数化解析 + 示例技能（目标 ≤15min）

**Files:**
- Modify: `src/harness/skills.ts`
- Create: `src/harness/skills.resolve.test.ts`、`skills/hello-sunshine/skill.md`（示例落点修正：加载器为平铺 `{id}` 目录语义，`examples/` 嵌套目录会被当作单层 id 过滤，实际物料放平铺路径）

**Interfaces:**
- `resolveSkill(skillsDir, id, params?): Result<ResolvedSkill>`，`ResolvedSkill { manifest, body }`；未注册 id / `{{param}}` 缺参 → fail（明确错误）；示例技能 frontmatter 含 `kind: prompt`、`params: name`

- [x] Step 1: 失败测试——命中/未注册/缺参三态 + `{{name}}` 替换
- [x] Step 2: 确认红
- [x] Step 3: 最小实现 + 示例技能物料
- [x] Step 4: 确认绿
- [x] Step 5: 提交 `feat(skills): resolveSkill 参数化解析——三态语义 + 示例技能`（已完成：6458479，白名单外占位符原样保留，实测基线 244/244/0）

---

### Task 5b: skillRef 首帧注入 + 装配接线 + selfcheck（目标 ≤15min）

**Files:**
- Modify: `src/loop/engine.ts`、`src/runtime.ts`、`src/cli/commands/selfcheck.ts`
- Create: `src/loop/skill-ref.test.ts`

**Interfaces:**
- Loop 请求可携 `skillRef: SkillRef`；assemble 首帧注入解析后正文（参数已替换）；Loop/Graph 执行语义零改动
- `runtime.buildDeps`：`loadSkills(root/skills)` 装入 Harness，暴露 `skills.list()/get(id)`

- [x] Step 1: 失败测试——scripted 任务带 skillRef 输出含正文标记；未注册 id fail；不带 skillRef 不回归
- [x] Step 2: 确认红
- [x] Step 3: 最小实现（注入 + 接线 + selfcheck 技能调度行）
- [x] Step 4: 确认绿 + 全量不回归
- [x] Step 5: 提交 `feat(skills): skillRef 首帧注入 + buildDeps 装配接线 + selfcheck 行`（已完成：85ca7f9，LoopDeps.skills 解析接缝失败即 failed + ContextManager 一次性技能槽消费即清，基线 248/248/0）

---

### Task 6: MCP 官方 SDK 接入（按 ≤15min 拆分为 6a/6b/6c）

---

### Task 6a: mock stdio JSON-RPC server（目标 ≤10min）

**Files:**
- Create: `scripts/mock-mcp-server.js`

**Interfaces:**
- 纯 Node 零依赖 stdio JSON-RPC：`initialize` → `tools/list`（echo 工具）→ `tools/call`；`--delay <ms>` 慢速模式（超时用例）；`--name <name>` 改名（越权用例）；按行 JSON 解析、按行回写

- [x] Step 1: 脚本冒烟——echo 往返 + 慢速延迟生效断言（--delay 实测 624ms，--name 改名生效）
- [x] Step 2: 提交 `test(mcp): mock stdio JSON-RPC server——echo/慢速/改名三模式（零网络）`（已完成：be9b0e4）

---

### Task 6b: SDK 安装 + McpHost 注册链（目标 ≤15min）

**Files:**
- Modify: `package.json`、`CLAUDE.md`（依赖登记段）
- Create: `src/harness/mcp/client.ts`、`client.register.test.ts`

**Interfaces:**
- `McpHost { constructor(servers, registry, chain); registerTools(): Promise<number>; close(): Promise<void> }`——懒 spawn → handshake → `tools/list` → `registry.register`（规范名 `mcp__<server>__<tool>`，category `external`）
- 首步安装：`npm install --cache .npm-cache @modelcontextprotocol/sdk` 并锁版本；失败走 R6 回退：自研最小 stdio JSON-RPC 客户端同接口，commit 注明降级

- [x] Step 0: 安装 SDK（@modelcontextprotocol/sdk@1.30.0 装成；R6 回退未触发）
- [x] Step 1: 失败测试——mock server 注册链：注册数 + 规范名断言
- [x] Step 2: 确认红
- [x] Step 3: 最小实现
- [x] Step 4: 确认绿
- [x] Step 5: 提交 `feat(mcp): McpHost 官方 SDK 注册链——懒 spawn→握手身份校验→tools/list→mcp__ 规范名注册`（c6ec58b，250/250/0）

---

### Task 6c: 调用闸门 + 全链路（目标 ≤15min）

**Files:**
- Modify: `src/harness/mcp/client.ts`、`src/harness/security/policy.ts`（external 分支）
- Create: `src/harness/mcp/client.call.test.ts`

**Interfaces:**
- 经 `registry.execute`（走 SafetyChain）调用：单次超时 30s、参数 JSON ≤64KB、白名单 = SUNSHINE.md 服务器清单（空 = 全禁）、结果统一 mask、失败 `Result.fail`（分域契约，不拖垮 Loop/Graph）

- [x] Step 1: 失败测试——echo 全链路脱敏；越权 server 拒绝；慢 server 超时 fail；超体积参数拒绝
- [x] Step 2: 确认红
- [x] Step 3: 最小实现（external 策略分支 + 执行器，6b 已内置四闸；本任务补全链路断言与握手身份锚点）
- [x] Step 4: 确认绿 + 全量不回归
- [x] Step 5: 提交 `feat(mcp): 调用闸门全链路——超时/体积/白名单/mask 四闸 + 握手身份校验锚点`（ad166e3，256/256/0）

---

### Task 7: 收口 —— selfcheck 门禁与文档同步（目标 ≤15min）

**Files:**
- Modify: `src/cli/commands/selfcheck.ts`、`docs/ROADMAP.md`、`CLAUDE.md`

- [x] Step 1: selfcheck 新增 MCP 行（清单解析 + mock 注册数）——`mcp : N servers configured, N tools registered`
- [x] Step 2: ROADMAP 阶段四测试基线数修正为实测值（164→256）；CLAUDE.md 目录树增 `harness/mcp/`、`harness/knowledge/`，依赖登记 `@modelcontextprotocol/sdk`（用途/边界/回退，6b 已入）
- [x] Step 3: 全量门禁：`npm run build` 0 报错、`node --test` 全绿、`npm run selfcheck` 全行通过
- [x] Step 4: 提交 `chore(phase4): selfcheck MCP 行 + ROADMAP/CLAUDE.md 文档同步`（本收口批）

---

## P1（后续独立 plan，不在本计划展开）

- [x] **T8 sqlite-vec 可插拔后端（已交付，P1）**：spike 择定 `node:sqlite`+扩展零编译路线；`store.sqlite-vec.ts` vec0 KNN 后端注册 `KB_BACKEND`；conformance 契约套件（含损坏恢复降级）双后端全绿；1 万块检索 P95 基准留后续实测。详见 `plans/2026-09-09-phase4-p1-sqlite-vec.md`（G1 `c47120a` / G2 `5777342` / G3 `03b1444`）。
- MCP HTTP/SSE 传输、记忆→技能沉淀闭环（spec §5 边界留位）。

## 验收对照（spec §4）

| spec 验收 | 承接任务 |
| --- | --- |
| §4-1 MCP 全链路 | Task 6a–6c |
| §4-2 工具面 | Task 2 |
| §4-3 路由/缓存/流式 | Task 3a–3c |
| §4-4 知识库 | Task 4a–4f（sqlite-vec 部分已由 P1 交付） |
| §4-5 技能调度 | Task 5a–5b |
| §4-6 门禁 / §4-7 文档 | Task 7（各任务门禁随提交持续验证） |
