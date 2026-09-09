# 阶段四 P1 · sqlite-vec 可插拔后端 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Stop after each task to review.

- **日期：** 2026-09-09
- **状态：** 待实施
- **上游：** docs/superpowers/specs/2026-09-08-phase4-mcp-ecosystem-design.md §3.4 / §5-R5（P1 项，已实施交付的 P0 之外首个后端）
- **基线：** HEAD `31a504c`，全量 256/256/0，selfcheck 全行通过，工作树干净
- **执行方式：** subagent-driven 逐任务实施；单任务目标 ≤15 分钟（含红绿测试与提交），预估超限即再拆
- **可行性结论（已实测）：** Node 22.14 `node:sqlite` 开箱可用（DatabaseSync + loadExtension）；`sqlite-vec@0.1.9` npm 可达且内含可加载扩展二进制 → 零编译、零新增驱动依赖；vec0 需 loadExtension 后可用（未加载时 `no such module: vec0` 属预期）

## Global Constraints

- **Tech Stack:** TypeScript 5 strict + CommonJS；测试 `npm run build && node --test dist/**/*.test.js`；零深依赖，依赖一律 `npm install --cache .npm-cache`
- **复用契约：** `VectorStore` 接口与 `store.conformance.ts` 契约套件（4b/4c 已交付）是唯一验收口径；`KB_BACKEND` 注册表（未注册装配期抛错）是唯一切换点
- **错误通道：** 后端故障返回 `Result.fail`（分域契约），禁止抛异常跨引擎边界、禁止静默回退
- **仅通过 sandbox 工具读写 `/workspace/wt-59f36a81fc`；禁止写 `/skills`。**

---

### Task G1: 驱动 spike——vec0 加载与选型结论落库（目标 ≤15min）

**Files:**
- Modify: `package.json`（devDependencies 登记探测结论用包）、`CLAUDE.md`（依赖登记段）
- Create: `scripts/sqlite-vec-probe.js`、`scripts/sqlite-vec-probe.test.js`

**Interfaces:**
- 冒烟脚本：`:memory:` 打开 DatabaseSync → `loadExtension(require.resolve('sqlite-vec'))` → 建 `vec0` 虚拟表（float[4]）→ 插入 2 向量 + KNN 查询（`MATCH` + `k = ?`）往返断言

- [ ] Step 1: 安装 `sqlite-vec`（npm install --cache .npm-cache，锁版本）
- [ ] Step 2: 失败测试——probe 断言（vec0 建表/插入/KNN 往返）
- [ ] Step 3: 确认红 → 写 probe 脚本至绿
- [ ] Step 4: 确认绿 + 全量不回归
- [ ] Step 5: 提交 `feat(knowledge): sqlite-vec 驱动 spike——vec0 loadExtension 冒烟 + 选型落库（node:sqlite 零编译路线）`

**验收：** probe 绿；CLAUDE.md 依赖登记含「sqlite-vec（P1 向量后端扩展，经 node:sqlite loadExtension 加载；边界：单进程本地）」。

---

### Task G2: SqliteVecStore 实现（目标 ≤15min）

**Files:**
- Create: `src/harness/knowledge/store.sqlite-vec.ts`
- Modify: `src/harness/knowledge/store.ts`（注册表登记 `sqlite-vec` 工厂，读 `KB_DATA_DIR`）

**Interfaces:**
- `SqliteVecStore implements VectorStore`——vec0 虚拟表持久化于 `KB_DATA_DIR/vectors.db`；`upsert(id, vec, meta)` / `search(vec, topK): KbHit[]`（vec0 `MATCH` KNN，距离→相似度语义与 local-json 对齐：分值越大越相关）/ `size()` / `load()`（幂等重开）/ `flush()`

- [ ] Step 1: 失败测试——构造 + upsert/search/size 基本语义（临时目录）
- [ ] Step 2: 确认红
- [ ] Step 3: 最小实现
- [ ] Step 4: 确认绿
- [ ] Step 5: 提交 `feat(knowledge): SqliteVecStore——vec0 KNN 后端 + KB_BACKEND 注册`

---

### Task G3: conformance 全绿 + KB_BACKEND 切换用例（目标 ≤15min）

**Files:**
- Create: `src/harness/knowledge/store.sqlite-vec.conformance.test.ts`
- Modify: `src/harness/knowledge/index.ts`（`KB_BACKEND=sqlite-vec` 时 KnowledgeBase 装配切换，缺省仍 local-json）

**Interfaces:**
- `runVectorStoreConformance(create)` 契约套件直接跑 sqlite-vec 后端（写入/召回/TopK/幂等/持久化/损坏恢复全绿）——损坏恢复用例：锁库/坏文件 → `Result.fail` 而非崩溃
- 切换用例：`KB_BACKEND=sqlite-vec` 下 KnowledgeBase index/search 语义与 local-json 一致

- [ ] Step 1: 失败测试——conformance 套件 + 切换用例
- [ ] Step 2: 确认红
- [ ] Step 3: 补齐后端缺口至全绿
- [ ] Step 4: 确认绿 + 全量不回归
- [ ] Step 5: 提交 `feat(knowledge): sqlite-vec 过 conformance 契约 + KB_BACKEND 切换`

---

### Task G4: 文档收口 + 终验（目标 ≤15min）

**Files:**
- Modify: `docs/ROADMAP.md`（P1 项状态 + 测试基线数）、`docs/superpowers/plans/2026-09-08-phase4-mcp-ecosystem.md`（P1 段勾选/状态）、`docs/superpowers/specs/2026-09-08-phase4-mcp-ecosystem-design.md`（§5-R5 状态）

- [ ] Step 1: ROADMAP 基线数修正为实测值；两处文档状态同步
- [ ] Step 2: 全量门禁：`npm run build` 0 报错、`node --test` 全绿、`npm run selfcheck` 全行通过
- [ ] Step 3: 提交 `docs(phase4-p1): ROADMAP/计划/spec 状态同步——sqlite-vec 后端交付`

---

## 验收对照（spec §5-R5）

| 契约 | 承接任务 |
|------|----------|
| KB_BACKEND 切换第三后端，接口零改动 | Task G2/G3 |
| conformance 契约套件复用全绿 | Task G3 |
| 零编译依赖（node:sqlite + 扩展加载） | Task G1 |
| 文档与路线图同步 | Task G4 |

## 边界（本计划不做）

- MCP HTTP/SSE 传输、记忆→技能沉淀闭环（P1 其余两项，另立 plan）
- 向量量化/IVF 索引性能优化（vec0 暴力 KNN 已满足当前量级）
