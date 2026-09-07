# CLI 部署链路加固实施计划（用户本地部署反馈修复）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复用户在新检出仓库执行 `npm run cli` 的两个部署断点：`dist/cli/index.js` 不存在（未自动构建）与 `.env` 缺失（无模板引导）。

**Architecture:** 三处小改动：①`cli` 脚本前置 `npm run build`，与 `test`/`selfcheck` 脚本约定对齐（构建后进 CLI 时支持 `--env-file-if-exists` 容忍缺 .env，stub 场景可离线运行）；②新增 `.env.example` 模板（不含真实密钥），README 指引 `copy .env.example .env`；③探针与文档同步。零新增依赖。

**Tech Stack:** TypeScript（strict，CommonJS）、Node.js 内置能力、零第三方依赖。

## Global Constraints

- TypeScript strict 零报错；提交前必须 `npm run build` 通过（CLAUDE.md §7）。
- 零新增运行时依赖。
- `.env` 已在 `.gitignore`（第 8 行），任何改动不得使其入库；模板文件名必须是 `.env.example`（不被忽略）。
- 提交信息格式沿用仓库惯例（`fix(cli): 中文描述（P2 T7-5)` 等）。
- 改动后验证三件套：`npm test` + `npm run selfcheck` + `node --env-file-if-exists=.env scripts/probe-cli-smoke.js`（探针手动执行，不进门禁）。

---

### Task 1: `cli` 脚本自动构建 + `.env.example` 模板

**Files:**
- Modify: `package.json`（`scripts.cli` 一行）
- Create: `.env.example`
- Modify: `README.md`（Quick Start（CLI）段内的安装指引行）
- Test: 无需新测试文件——属脚本/物料改动，以「构建后 CLI 命令可用 + .env 缺失时命令仍可执行」两条命令级验证覆盖（Task 2 探针回归兜底）。

**Interfaces:**
- Consumes: 既有 `npm run build`（tsc）、`node --env-file-if-exists=.env`（Node 20+ 内置，缺文件时打印 `not found. Continuing without it` 并继续）、`sunshinex selfcheck`（StubAdapter，不依赖 `.env`）。
- Produces: `npm run cli -- <args>` 语义不变，但保证 `dist/cli/index.js` 存在；`.env.example` 含 `OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL` 三个键。

- [ ] **Step 1: 修改 `package.json` 的 `scripts.cli`**

将：

```json
"cli": "node --env-file-if-exists=.env dist/cli/index.js"
```

改为：

```json
"cli": "npm run build && node --env-file-if-exists=.env dist/cli/index.js"
```

（与 `selfcheck` 的 `npm run build && node ...` 约定一致；`--env-file-if-exists` 保证无 `.env` 时 selfcheck/`--model stub` 仍可运行。）

- [ ] **Step 2: 新建 `.env.example`**

```bash
# SunshineX 模型配置（DeepSeek 兼容 OpenAI 协议）
# 复制本文件为 .env 并填入真实值：copy .env.example .env （Windows） / cp .env.example .env
OPENAI_API_KEY=sk-your-key-here
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-v4-flash
```

- [ ] **Step 3: 更新 `README.md` Quick Start（CLI）段**

将首行 `npm install --cache .npm-cache` 之后补一行（保持其余命令不变）：

```markdown
copy .env.example .env   # 填入真实 OPENAI_API_KEY（Windows；macOS/Linux 用 cp）
```

- [ ] **Step 4: 验证（模拟新检出：先删 dist 再跑 CLI）**

```bash
rm -rf dist && npm run cli -- selfcheck
```

Expected: 输出 `not found. Continuing without it`（可容忍）+ 构建零报错 + selfcheck 七行（含 loop/graph 就绪行）。

- [ ] **Step 5: Commit**

```bash
git add package.json .env.example README.md
git commit -m "fix(cli): cli 脚本自动构建 + .env.example 模板——新检出可直接部署（P2 T7-5）"
```

---

### Task 2: 探针与端到端回归

**Files:**
- Modify: `scripts/probe-cli-smoke.js`（sh() 增加 timeout 参数，探针健壮性）
- Test: 无新增测试——以既有 161 项全量单测 + 真实探针跑通为准。

**Interfaces:**
- Consumes: Task 1 的 `npm run cli -- ...`（自动构建语义）；`probe-cli-smoke.js` 现有 `sh(cmd, args)` 封装。
- Produces: 探针在单命令挂死时能在 5 分钟超时并报 FAIL，不再无限阻塞。

- [ ] **Step 1: 修改 `scripts/probe-cli-smoke.js` 的 `sh()`**

将：

```javascript
function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
}
```

改为：

```javascript
function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'inherit'], timeout: 300_000 });
}
```

（`run`/`pipeline` 真实模型单命令上限约 4 分钟，5 分钟超时足够；超时抛错由既有 check() 捕获报 FAIL。）

- [ ] **Step 2: 全量回归**

Run: `npm test && npm run selfcheck`
Expected: 161 项全绿、selfcheck 七行输出。

- [ ] **Step 3: 探针端到端（真实模型，手动执行）**

Run: `node --env-file-if-exists=.env scripts/probe-cli-smoke.js`
Expected: `ok - selfcheck`、`ok - run`、`ok - pipeline`、末行 `CLI smoke OK`，退出码 0。

- [ ] **Step 4: Commit**

```bash
git add scripts/probe-cli-smoke.js
git commit -m "fix(cli): 探针单命令 5 分钟超时保护（P2 T7-6）"
```

---

## Self-Review 记录

- **Spec coverage**：用户反馈的两个断点 → Task 1（未构建 + 缺 .env 引导）、Task 2（探针健壮性）全覆盖；README 部署指引与实际行为一致。
- **Placeholder scan**：无 TBD/TODO；所有步骤含完整命令或文件内容。
- **Type consistency**：`sh()` 仅改 options，不涉签名变更；`scripts.cli` 语义对调用方透明。
