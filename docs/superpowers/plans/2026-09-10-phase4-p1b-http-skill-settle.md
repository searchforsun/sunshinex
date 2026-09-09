# 阶段四 P1-II · MCP HTTP/SSE 传输 + 记忆→技能沉淀闭环 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Stop after each task to review.

- **日期：** 2026-09-10
- **状态：** 待实施
- **上游：** docs/superpowers/specs/2026-09-08-phase4-mcp-ecosystem-design.md §3.1（HTTP/SSE 传输留位）与 §6-R5（技能沉淀闭环开放问题，本期定案）
- **基线：** HEAD `e2a7171`，全量 265/265/0，selfcheck 全行通过，工作树干净
- **执行方式：** 主代理逐任务实施；单任务目标 ≤15 分钟（含红绿测试与提交），预估超限即再拆
- **可行性结论（已实测）：** 已装 `@modelcontextprotocol/sdk@1.30.0` 的 `StreamableHTTPClientTransport` 与 `SSEClientTransport` 均可零配置加载（node -e 冒烟通过）→ 零新增依赖；HTTP/SSE mock 走 node:http 零依赖脚本（对齐 mock-mcp-server.js 先例）

## Global Constraints

- **Tech Stack:** TypeScript 5 strict + CommonJS；测试 `npm run build && node --test dist/**/*.test.js`；零新增运行时依赖
- **接缝纪律：** MCP 传输选择收敛于 `McpHost` 单文件（依赖收敛先例）；沉淀闭环收敛于 `MemoryLifecycle`（唯一记忆面）+ `SkillsFacade`（唯一技能面），禁止旁路
- **向后兼容：** `McpServerConfig` 无 transport 字段 = stdio（既有配置零改动）；用户技能 `skills/` 恒优先于学习技能（用户作品不被机器覆盖）
- **安全缺省：** HTTP/SSE 复用既有 external 闸门（guard 登记制 / mask 出口 / 超时 / 参数体积），不新增豁免；OAuth/授权流不在本期（spec 留位不变）
- **提交前门禁：** `npm run build` 0 报错、全量测试 0 失败、`npm run selfcheck` 通过；每任务独立 commit
- **仅通过 sandbox 工具读写 `/workspace/wt-59f36a81fc`；禁止写 `/skills`。**

---

### Task H1: McpServerConfig 传输字段与解析器扩展（目标 ≤15min）

**Files:**
- Modify: `src/types.ts`、`src/config.ts`
- Create: `src/config.mcp.transport.test.ts`

**Interfaces:**
- `McpServerConfig` 增量：`transport?: 'stdio' | 'http' | 'sse'`、`url?: string`（两者均可选，缺省 = stdio，既有用例零改动）
- `parseMcpServers` 行式扩展：`name | endpoint [| transport:xxx]`——`endpoint` 以 `http://`/`https://` 开头 → `url` 字段且 transport 缺省 `http`；否则为 stdio `command`（transport 缺省 `stdio`）；显式 `transport:sse` 覆盖缺省；非法 transport 值整行跳过不抛（宁少配不错配）

- [ ] Step 1: 失败测试——http URL 行解析出 `{name, url, transport:'http'}`；URL 行 + `transport:sse` → sse；普通命令行缺省 stdio；`transport:bogus` 跳过；缺 name/url/command 跳过
- [ ] Step 2: `npm run build && node --test dist/config.mcp.transport.test.js` 确认红
- [ ] Step 3: 最小实现 types 增量 + 解析分支
- [ ] Step 4: 确认绿 + 全量不回归
- [ ] Step 5: 提交 `feat(mcp): McpServerConfig transport/url 字段与 parseMcpServers 传输感知解析`

---

### Task H2: McpHost 传输工厂——stdio/http/sse 三分支（目标 ≤15min）

**Files:**
- Modify: `src/harness/mcp/client.ts`
- Create: `src/harness/mcp/client.transport.test.ts`

**Interfaces:**
- 私有 `makeTransport(cfg): Transport`：stdio → `StdioClientTransport({command, args})`（现行为原样）；`http` → `StreamableHTTPClientTransport({url})`；`sse` → `SSEClientTransport({url})`
- 失败语义不变：连接失败 → `MCP_CONNECT_FAILED`（含 URL 不可达 fail-fast）；握手身份校验（serverInfo.name = 配置名）对三种传输一视同仁
- 依赖继续收敛于本文件（import 仅此处出现）

- [ ] Step 1: 失败测试——不可达 http URL → `MCP_CONNECT_FAILED`；`transport` 缺省行为与既有 stdio 用例一致（回归由全量套件保障）
- [ ] Step 2: 确认红
- [ ] Step 3: 最小实现三分支工厂（switch 收敛一处）
- [ ] Step 4: 确认绿 + 全量不回归
- [ ] Step 5: 提交 `feat(mcp): McpHost 传输工厂——streamable http / sse 分支接入既有握手与闸门链`

---

### Task H3: 零依赖 HTTP/SSE mock server（目标 ≤15min）

**Files:**
- Create: `scripts/mock-mcp-http-server.js`

**Interfaces:**
- node:http 零依赖；协议面对齐 mock-mcp-server.js（initialize → tools/list 单 echo 工具 → tools/call）；`--name <name>` 改写 serverInfo.name
- `--mode http`（缺省）：POST 单端点收 JSON-RPC 请求，`application/json` 单响应回包（streamable http 最小面）
- `--mode sse`：GET 端点推 `text/event-stream`，先发 `event: endpoint` 告知 POST 地址，后续 JSON-RPC 响应以 `event: message` 帧推送（对齐 SDK SSEClientTransport 协议）
- `port 0` 监听 + 实际端口输出 stdout（测试用临时端口）

- [ ] Step 1: 冒烟脚本自测（curl/原始 fetch 往返 initialize + tools/list）
- [ ] Step 2: 确认协议帧与 SDK 客户端期望一致
- [ ] Step 3: 实现并跑通两种模式冒烟
- [ ] Step 4: 提交 `test(mcp): 零依赖 HTTP/SSE mock server（streamable http 与 sse 双模式）`

---

### Task H4: HTTP/SSE 端到端集成测试 + 文档状态同步（目标 ≤15min）

**Files:**
- Create: `src/harness/mcp/client.http.e2e.test.ts`
- Modify: `docs/superpowers/specs/2026-09-08-phase4-mcp-ecosystem-design.md`（§3.1 留位句改为已交付；§6-R5 待 S 线收口后一并更新）

**Interfaces:**
- e2e 双用例（对齐 client.register/call 测试风格）：http 模式 mock 起临时端口 → `McpHost.registerTools()` 注册 `mcp__<name>__echo` → 经 `registry.execute` + `SafetyChain` 调用 → mask 出口断言；sse 模式同链路
- finally 关闭 host 与 mock server（端口不泄漏）

- [ ] Step 1: 失败测试——http 与 sse 两用例（注册链 + 安全链调用 + mask）
- [ ] Step 2: 确认红
- [ ] Step 3: 确认绿（H2/H3 实现已就位，本任务以集成验证为主）
- [ ] Step 4: spec §3.1 状态同步（HTTP/SSE 传输已交付；OAuth 仍留位）
- [ ] Step 5: 提交 `test(mcp): HTTP/SSE 端到端集成（注册→安全链→mask 出口）+ spec §3.1 状态同步`

---

### Task S1: 学习技能写入面 LearnedSkillStore（目标 ≤15min）

**Files:**
- Create: `src/harness/skills/learned.ts`、`src/harness/skills/learned.test.ts`

**Interfaces:**
- `LearnedSkillStore(root)`：写入 `.data/skills/{id}/skill.md`（.data 已 gitignore，学习产物不入库）
- `settle(goal: string, reply: string): Result<string>`——确定性 slug 化 goal（非安全字符折叠为 `-`，截长 40）为 id；撞名追加 `-2/-3…`；frontmatter：`name: 沉淀:<goal 前 30 字>`、`description`、`version: 0.1.0`、`kind: prompt`、`params:` 空、`source: learned`；body 模板含 goal 与 reply（各截断 2000）
- 目录上限 50（对齐 CAP.skill）：超限删最旧（mtime 序）

- [ ] Step 1: 失败测试——写入后 `parseSkillFrontmatter` 可读回；同名 goal 二次 settle 得 `-2`；中文/特殊字符 slug 确定性；超 50 删最旧
- [ ] Step 2: 确认红
- [ ] Step 3: 最小实现
- [ ] Step 4: 确认绿 + 全量不回归
- [ ] Step 5: 提交 `feat(skills): LearnedSkillStore——成功任务沉淀为学习技能模板（.data/skills，FIFO 50）`

---

### Task S2: Reactor 成功沉淀钩子 + Harness 装配（目标 ≤15min）

**Files:**
- Modify: `src/harness/reactor.ts`、`src/harness/index.ts`
- Create: `src/harness/reactor.settle.test.ts`

**Interfaces:**
- `ReactorDeps` 增可选 `settle?: (r: { goal: string; reply: string }) => void`
- 触发规则（确定性）：仅 `done === true && reply` 时调用一次；maxSteps 耗尽 / 模型失败路径不触发；settle 抛错吞掉并 `memory.record('settle', ...)` 记 episodic（沉淀失败不倒灌任务成败）
- Harness 装配：`LearnedSkillStore` 注入 Reactor（构造可选开关 `learnSkills?: boolean`，缺省 true；测试可关）

- [ ] Step 1: 失败测试——stub 模型 done 路径触发 settle 一次且产物可被 frontmatter 解析；失败路径零触发；settle 抛错不影响 RunResult
- [ ] Step 2: 确认红
- [ ] Step 3: 最小实现钩子与装配
- [ ] Step 4: 确认绿 + 全量不回归
- [ ] Step 5: 提交 `feat(reactor): 成功任务沉淀钩子——done 路径一次 settle，失败零触发，装配缺省开启`

---

### Task S3: SkillsFacade 双根合并 + selfcheck 可观测（目标 ≤15min）

**Files:**
- Modify: `src/harness/skills.ts`、`src/cli/commands/selfcheck.ts`
- Create: `src/harness/skills.merge.test.ts`

**Interfaces:**
- `createSkillsFacade(root)` 升级双根：用户 `skills/` 与学习 `.data/skills/` 合并；id 撞名用户恒优先（学习产物同 id 被遮蔽，不抛）
- `list()`/`get()`/`resolve()` 三能力均可见学习技能；`resolve` 学习技能按 frontmatter params/kind 走同一三态语义
- selfcheck 追加「学习技能」行（`learned: N`，无目录显示 0 不崩溃）

- [ ] Step 1: 失败测试——学习技能可 resolve；用户同 id 遮蔽学习产物；无 .data/skills 目录零影响；selfcheck 行存在
- [ ] Step 2: 确认红
- [ ] Step 3: 最小实现合并与 selfcheck 行
- [ ] Step 4: 确认绿 + 全量不回归
- [ ] Step 5: 提交 `feat(skills): SkillsFacade 双根合并（用户优先）+ selfcheck 学习技能行`

---

### Task G1: 闭环收口——spec §6-R5 定案 + ROADMAP 同步 + 终验门禁（目标 ≤15min）

**Files:**
- Modify: `docs/superpowers/specs/2026-09-08-phase4-mcp-ecosystem-design.md`（§6-R5：开放问题 → 本期定案方案摘要）、`docs/ROADMAP.md`（阶段四「技能模板体系完善」勾选注记「P1：记忆→技能沉淀闭环已交付」）

**Steps:**

- [ ] Step 1: 全量门禁——build 0 / 全量测试 0 失败 / selfcheck 通过（记录终态基线）
- [ ] Step 2: spec §6-R5 写入定案（LearnedSkillStore + Reactor 钩子 + 双根合并三件套；自动技能筛选/AI 语义聚类仍留阶段五）
- [ ] Step 3: ROADMAP 阶段四条目同步
- [ ] Step 4: 提交 `docs(phase4-p1b): G1——spec §6-R5 技能沉淀闭环定案 + ROADMAP 同步 + 终验门禁记录`
