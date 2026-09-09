# 阶段四设计：MCP 生态与全场景能力

> 日期：2026-09-08
> 状态：已实施交付（实施链 083ac89 → 09a1983 → f27848e/90221e0/ba34f27 → 4985d1d/dd32ebb/5ff88fe/484bd2b/5f0de97/899c35e → 6458479/85ca7f9 → be9b0e4/c6ec58b/ad166e3；终态门禁 build 0 / 256-256-0 / selfcheck 0，R6 回退未触发）
> 上游：`docs/Arch-Plan.md` §2.1.4/§3.5/§4.2–4.5、`docs/ROADMAP.md` 阶段四、统一运行时主链（零旁路）
> 基线：HEAD `ace3fd4`，全量 175/175/0，src 中无 MCP/向量/技能调度实现（grep 证实）

## 1. 定位与设计立场

阶段四是**生态开放层**：把第三方工具（MCP）、知识检索（向量库）、可复用任务模板（技能）接进既有主链，补齐 v1.0「能力对标」的最后一批运行时能力。

设计立场（有机结合，非能力拼接）：

- **单一执行面**：MCP 工具、kb_search、目录 grep、webfetch 全部经 `ToolRegistry` 注册、走同一条 SafetyChain，**不新增任何旁路**。第三方工具与内置工具对 Loop/Graph 完全同构。
- **技能是上下文而非代码**：技能调度 = 首帧 context 注入（Claude Code 式），不是独立执行通道；Loop/Graph 语义零改动。
- **能力并入既有面**：git/数据库等开发操作由 exec 工具覆盖，不造平行专项工具（避免同能力双通道）。
- **数据可控优先**：知识库索引内容只在用户显式指定时采集；embedding 端点可配置为本地 OpenAI 兼容实现（如 Ollama），实现全本地化。
- **外部依赖可插拔（v2 增补）**：一切外部依赖（向量存储、embedding 提供方、MCP 传输与 SDK、模型后端）一律收敛在内部接口之后——缺省零依赖实现，替换后端不改主链；模型层已是既有范例（OpenAI/Scripted/Stub 三实现同接口）。每个接缝配一致性测试套件，可插拔性由「第二个真实后端通过套件」证明，而非口头接口（落地样例见 §3.4）。

## 2. 现状与差距

| 项 | 现状 | 差距 |
| --- | --- | --- |
| `src/harness/tools.ts` | 统一注册表 + SafetyChain（guard→路径判界→mask 出口）✓ | 无 external/network 类别；`CANONICAL_TOOL_NAMES` 硬编码五内置名 |
| `src/harness/tools/builtin.ts` | read/write/grep/glob/exec 五件套 | grep 仅单文件正则；无网络工具 |
| `src/model/adapter.ts` | 三档路由 + 回退、UsageHooks.onUsage ✓ | 静态绑定无决策依据；无流式；成本/命中率不可观测 |
| `src/harness/context/` | window/compaction/session/三级缓存 ✓ | 命中率无计数出口；前缀顺序未固定（provider 端 KV 缓存不友好） |
| 知识库 | 无（FileStore 纯 JSON KV，零向量痕迹） | 全新子系统：embedding 客户端、分块、索引、检索 |
| `src/harness/skills.ts` | loadSkills 发现 + frontmatter 解析 ✓ | 未接入装配根；无参数化；无调度语义 |
| MCP | 无 | 客户端、生命周期、安全策略、配置面全新 |

## 3. 核心设计

### 3.1 MCP 客户端与工具接入（推荐默认：官方 SDK）

依赖 `@modelcontextprotocol/sdk`（stdio 传输优先），按 8b11e60 依赖政策登记入 package.json 与 CLAUDE.md。理由：协议正确性（握手/能力协商/schema）是「标准 MCP 工具可注册并调用」验收的前提，自研 JSON-RPC 子集存在协议漂移风险；HTTP/SSE 传输本阶段留接口不实现。

```ts
// src/harness/mcp/client.ts —— MCP 宿主（懒连接；错误走分域 Result 契约）
export interface McpServerConfig { name: string; command: string; args?: string[]; env?: Record<string, string>; }
export interface McpToolRef { server: string; name: string; description?: string; inputSchema: unknown; }

export class McpHost {
  constructor(servers: McpServerConfig[], registry: ToolRegistry, chain: SafetyChain);
  registerTools(): Promise<number>;   // 逐 server：connect → tools/list → registry.register
  async close(): Promise<void>;       // 进程退出钩子调用
}
```

- **命名与类别**：工具规范名 `mcp__<server>__<tool>`（业界惯例，天然隔离内置命名空间）；`ToolCategory` 新增 `'external'` 与 `'network'`（复活 d457809 注释预留位）。
- **安全策略**（guard 增补 external/network 分支）：
  - external：服务器白名单 = SUNSHINE.md `mcpServers` 清单本身；调用参数 JSON 体积上限（默认 64KB）；单工具超时（默认 30s）；白名单空 = 全禁。
  - network：webfetch 域名白名单（SUNSHINE.md `network.allowlist`），缺省空 = 禁用。
  - 结果统一过 `maskResult`（链上既有唯一脱敏出口，零改动复用）。
  - `mode: 'dontAsk'` 下外部工具不豁免以上闸门（免审批 ≠ 免策略）。
- **配置面**：SUNSHINE.md 新增「MCP 服务器」「网络白名单」分区，行式条目（`name | command | args...`），由 `src/config.ts` 新增专用解析函数产出 `McpServerConfig[]`——既有解析器保持「分区 + 按行收集」纯文本语义不变，单一配置入口不破。
- **生命周期**：首次 `registerTools` 懒 spawn；server 崩溃/调用失败返回 `Result.fail`（错误局部化接管，不拖垮 Loop/Graph）。
- **测试**：零网络——仓库内脚本 mock stdio JSON-RPC server，覆盖 handshake → tools/list → 注册 → 经链调用 → 脱敏/超时/越权断言。

### 3.2 内置工具集扩展

| 工具 | 变更 | 说明 |
| --- | --- | --- |
| grep | 目录级升级：path 支持目录，新增 glob 过滤参数，递归遍历 | 复用 safePath 判界；结果行数上限（默认 200 行）防爆炸；对齐 Claude Code 检索体验的关键缺口 |
| webfetch | 新增（category `network`） | 域名白名单闸门；正文长度上限；mask 出口 |
| git/db 专项 | **不做** | exec 已覆盖；能力并入既有执行面 |

### 3.3 模型路由、缓存与流式

- **可观测路由**：`router.route(hint?: RouteHint)` 增量接口，hint 携带复杂度/角色信号（Graph 角色预设已产出建议档位，此处收敛为正式入参）；决策记录 `RouteDecision { tier, reason }` 随 run 结果返回并落 ledger。
- **成本与命中率记账**：UsageHooks 聚合到 harness 层 per-run ledger（storage key `runs/<id>`）；session 缓存增加 hit/miss 计数器；selfcheck 输出汇总行。
- **前缀稳定化**：context 组装器固定 system 与工具 schema 段顺序，提升 provider 端 KV 前缀缓存命中（DeepSeek/OpenAI 隐式缓存均受益）。
- **流式提前**（推荐默认：纳入本阶段）：`ModelAdapter.completeStream(req, onDelta): Promise<Completion>`，SSE 解析零依赖（body reader 按 `data:` 行切分）；scripted/stub 适配器同步支持（scripted 逐字吐出）；既有 `complete()` 签名不动——此接缝即「外部依赖可插拔」在模型层的既有范例（多后端同接口）。理由：阶段五 TUI 硬依赖 token 流，接口改造放在本阶段（路由/缓存同域施工）比留到阶段五风险低。

### 3.4 本地向量知识库（可插拔后端；缺省零依赖 JSON + 余弦）

```text
src/harness/knowledge/
  embed.ts      # EmbeddingProvider 接口 + OpenAI 兼容默认实现（/embeddings；.env 键 EMBEDDING_BASE_URL/EMBEDDING_API_KEY/EMBEDDING_MODEL，缺省回退 OPENAI_*；DeepSeek 无此端点，需另行配置）
  chunk.ts      # Markdown 感知分块：标题/段落聚合，块 ≤1200 字符，重叠 ~100 字符
  store.ts      # VectorStore 接口 + 后端注册表 + LocalJsonVectorStore（FileStore 之上，归一化向量 + 暴力余弦）
  backends/
    sqlite-vec.ts  # 可选后端（P1 独立任务）：SQLite 系向量检索，驱动以最小 spike 定案
  index.ts      # KnowledgeBase：indexDir(dir) / search(query, topK) / stats()；按 KB_BACKEND 配置装配后端
```

- **后端可插拔**：`VectorStore` 是唯一存储接缝，后端经注册表按配置装配（`.env` 键 `KB_BACKEND`，缺省 `local-json`）；新增后端 = 一个实现文件 + 注册一行，主链零改动。候选：`local-json`（零依赖缺省与回归基线）/ `sqlite-vec`（better-sqlite3 + sqlite-vec 预编译，或 Node ≥22.9 内置 `node:sqlite`，以最小 spike 择一）/ chromadb（仅留位，不引入）。
- **一致性测试套件**：`store.conformance.ts` 定义全后端必过的契约用例（写入/召回/TopK 语义/持久化/损坏恢复）；缺省后端与新后端共用同一断言集——可插拔由「第二个真实后端全绿」证明，而非口头接口。
- **EmbeddingProvider 同接缝可插拔**：接口仅 `embed(texts): Promise<number[][]>`；默认指向 OpenAI 兼容端点，可换本地推理或桩实现（测试注入），换装不触及知识库与其余主链。
- **主链接入**：内置工具 `kb_search`（category `read`，仅本地索引检索；查询向量化属 model 域调用）——Loop/Graph/Reactor 经同一工具面消费知识，不开旁路。
- **数据可控口径（明示）**：索引仅覆盖用户显式指定目录；分块文本将发送至所配置 embedding 端点；端点可指向本地实现实现全本地化；`.env` 不入库（既有纪律）。
- **规模与交付节奏**：`local-json` 暴力余弦适用于 ≤5 万块，先行交付并作为回归基线；`sqlite-vec` 后端在核心链路验收后作为 P1 任务补入，成功信号 = conformance 全绿 + 1 万块检索 P95 两位数毫秒。**已交付（P1）**：`node:sqlite` + sqlite-vec 零编译路线（spike 择定），conformance 双后端全绿；1 万块 P95 基准留后续实测（plans/2026-09-09-phase4-p1-sqlite-vec.md）。
- **降级与 fail-fast**：未配置 embedding 端点时 `kb_search` 返回 `Result.fail` 明确提示配置缺失，不阻塞其他工具；`KB_BACKEND` 指向未注册后端时装配期即报错，不静默回退。
- **测试**：EmbeddingProvider 以桩注入（不发真实网络）；conformance 套件对 `local-json` 全绿；自检用例对已知文档断言 top-3 命中。

### 3.5 技能模板调度

- **语义**：技能 = 参数化上下文模板。调度 = `skillRef` 注入首帧 context，Loop/Graph 执行语义零改动。
- **Manifest 扩展**：`SkillManifest` 增加 `params?: string[]`（正文 `{{param}}` 占位符清单）与 `kind: 'prompt'`（本阶段仅此一种）。
- **接口增量**：

```ts
// harness/skills.ts
export interface ResolvedSkill { manifest: SkillManifest; body: string; }
export function resolveSkill(skillsDir: string, id: string,
  params?: Record<string, string>): Result<ResolvedSkill>;   // 未注册 id / 缺参数 → fail

// loop 请求侧：LoopNode / Reactor 请求可携 skillRef: { id, params? }
// 装配：runtime.buildDeps 增加 loadSkills 装入，Harness 暴露 skills.list/get
```

- **装配接线**：`buildDeps` 调用 `loadSkills(root/skills)`；示例技能随仓库交付（`skills/examples/`），selfcheck 以 scripted 模型走通一次 skillRef 调度。
- **记忆→技能自动沉淀**：不做，转开放问题（§6-R5）。

### 3.6 类型与依赖登记

- `src/types.ts`：`ToolCategory` 扩展（`external`/`network`）、`RouteDecision`、`KbHit`、`SkillRef`、`McpServerConfig`。
- `CLAUDE.md`：依赖登记段落新增 `@modelcontextprotocol/sdk`（用途/边界/替代方案）。

## 4. 验收标准（量化）

1. **MCP 全链路**：mock stdio server 完成 handshake → tools/list → 注册 → 经安全链 tools/call；断言：白名单外 server 拒绝、超时返回 fail、结果脱敏、`mcp__` 命名无冲突。
2. **工具面**：目录 grep（glob 过滤 + 行上限）与 webfetch（白名单外拒绝、正文截断）链上测试通过。
3. **路由/缓存/流式**：RouteDecision 随 run 可查；selfcheck 输出缓存命中率与成本汇总；completeStream 在 scripted 下逐 token 回调断言通过。
4. **知识库**：示例文档集 index → search top-3 命中注入用例；未配置端点时明确降级；conformance 套件对 `local-json` 全绿；`KB_BACKEND` 指向未注册后端时装配期 fail-fast 断言。
5. **技能调度**：示例技能经 skillRef 完成 scripted 任务；缺参数/未注册 id 给出明确错误。
6. **门禁**：`npm run build` 0 报错、全量测试 0 失败、selfcheck 全绿（新增 mcp/tools/kb/skill 四行）。
7. **文档同步**：ROADMAP 阶段四测试基线数修正（164→当时实测）、CLAUDE.md 依赖登记。

## 5. 边界与不做

- MCP HTTP/SSE 传输与 OAuth 授权流（接口留位，实现随需）
- CLI 专项命令（chat/edit/test/review/doc）→ 阶段五与 TUI 同面交付（推荐默认，见 §6-R1）
- 记忆→技能自动沉淀闭环
- 缺省路径外的任何强制依赖：`sqlite-vec`/chromadb 仅作为可插拔后端按需引入（§3.4），缺省交付保持零依赖
- 知识库多集合权限、远端知识库、增量爬取

## 6. 风险与开放问题

| # | 项 | 状态/缓解 |
| --- | --- | --- |
| R1 | 待裁决项已全部定案：① MCP=官方 SDK（1.30.0 入册，R6 未触发）；② 知识库=可插拔后端，缺省 `local-json` 与 `sqlite-vec`（P1）均已交付且 conformance 双后端全绿；③ 范围=五条+流式提前（ba34f27）、CLI 留阶段五 | 实施期逐条落地；任一推翻仅影响对应小节，架构与接缝不动 |
| R2 | SDK 依赖体积与供应链审计 | 锁定版本；登记用途边界；stdio 传输仅本地 spawn |
| R3 | embedding 端点不可用 | kb_search 明确降级（Result.fail），不阻塞主链 |
| R4 | dontAsk 模式下外部工具误放行 | 白名单空=全禁 + 参数体积/超时双闸门；策略测试覆盖 |
| R5 | 技能沉淀闭环（成功任务 → 技能模板） | 开放问题，随阶段五记忆深化再设计 |
| R6 | 官方 SDK 与 Node ≥22.9 兼容性 | 实施首任务先做连通性冒烟，失败则回退自研 stdio 子集（备选方案已在 R1-①） |
