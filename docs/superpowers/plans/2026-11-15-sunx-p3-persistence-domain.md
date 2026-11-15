# Sunx P3（持久化域隔离）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一 Sunx = 一持久化项目域。Sunx 会话的全部持久化（链/转录/品性/任务台账+日志/团队板/记忆/调度/挂起审计）落独立数据目录 `~/.sunshinex/sunx/<journalId>/data/`；同 root 的普通会话项目数据、其他 Sunx 域与之**零共享**（含 memory 子树）。工作 root 仍为原项目路径（**工作树共享不变**——隔离的是持久化，不是活儿）。

**Architecture:** 数据目录从「按 root 推导」升级为「按会话注入」。Harness 装配期 `dataDir = opts.dataDir ?? resolveDataDir(base)` 单点化（7 处消费点换单变量）；Sunx 会话出生即铸 journalId 并绑定域目录（放弃惰性建档——持久化实体语义：出生即存在）；域容器 `~/.sunshinex/sunx/` 独立于 `projects/`（workspaces 枚举/清扫/归档清扫天然不波及）。GUI 数据源改向：SUNX 组/总览页改扫 sunx 域枚举端点，普通项目组列表零污染。

**Tech Stack:** TypeScript（node:test 根包 + vitest GUI）；无新依赖。

**Spec:** 本文档即规格（P3 抽屉项提前立项）。**用户裁定（2026-11-15）**：①不需要迁移 ②不需要兼容旧 sunx 档（存量 kind=sunx 档留在原 root 数据目录，不再进 SUNX 组——弃置可手工清理）③一 Sunx 一持久化项目，工作地址可相同 ④与同 root 的普通项目和其他 Sunx 完全隔离（含记忆）。
**关联:** P1/P2 已落地的 kind 装配/attach 重铸/唤醒/调度/恢复轮全部随会话走，零改动（除 Task 1 的 dataDir 注入缝与 Task 2 的域绑定）。

## Global Constraints

- **普通会话零变化（最高约束）**：`opts.dataDir` 缺席路径（全部 standard 装配 + TUI + CLI）行为与今日逐字节相同——`resolveDataDir(root)` 仍是缺省推导；`/workspaces`、`/sessions?root=`、RECENTS/项目组/归档等普通面零变化。
- **标准纪律**：TypeScript strict；中文注释+裁定日期；每批提交 conventional commits 中文；只 stage 自己的文件（并行会话在途改动绝不入提交）；全量门禁四项（根包/selfcheck/gui test/gui e2e），预存抖动按 P1 协议处置（standalone×3 / stash 对照）。
- **提示词恒英文**；GUI 铁律全套。
- **working root 语义不可漂移**：sandbox cwd/safePath 信任根/perception/worktree 锚全部继续绑 `opts.root`（工作树共享不变）——只有持久化数据面走域目录。任何把工作路径也换掉的实现都是 Critical。
- P1 遗留义务随本计划清偿：sunx 装配 `learnSkills: off`（编排轮不沉淀伪技能——P2 终审建议）。

---

### Task 1: Harness dataDir 注入缝——装配单点化

**Files:**
- Modify: `src/harness/index.ts`（`HarnessOptions.dataDir?: string`；构造期 `const dataDir = opts.dataDir ?? resolveDataDir(base)` 单点；7 处 `resolveDataDir(base)` 消费点换单点变量：FileStore/writeSnapshot/TaskRegistry/工具输出归档/插件宿主/McpHost 日志/`this.dataDir` 字段）
- Modify: memory 装配链（grep `MemoryStore(`/memory pipeline 的 dataDir 推导点——同样吃注入；若 MemoryStore 内部自推 resolveDataDir(root)，加可选 dataDir 参数）
- Modify: `src/session/runtime.ts`（`KernelRuntimeOpts.dataDir?` 透传 buildHarness）
- Test: harness 既有套件追加（注入域→tasks/ledger/memory/快照 sink 全落域目录；缺席→缺省路径逐字节不变）

**Interfaces:**
- Produces: `Harness.dataDir`（既有字段）语义=「本会话持久化域目录」；注入时=域目录，缺席=resolveDataDir(root) 既有值。
- 学习沉淀：sunx 装配同时 `learnSkills: false`（P2 遗留义务清偿——编排轮不沉淀伪技能；域目录下 learned/ 不生成）。

- [ ] Step 1 失败测试：注入 dataDir → TaskRegistry 台账/任务日志/MemoryStore/输出归档全落域目录；缺席 → 路径与今日一致（基线锚）
- [ ] Step 2 落地 + 定向跑 + 提交（`feat(harness): dataDir 注入缝——持久化域单点化`）

---

### Task 2: sunx 持久化域——出生即铸档 + 域绑定 + 重开链

**Files:**
- Modify: `src/serve/session.ts`（`SessionRuntimeOpts` 增 `dataDir?`；assemble 透传；**sunx 出生即铸 journalId 并建档**——放弃惰性建档（持久化实体语义：出生即存在），`ensureMintedWithBirth` 对 sunx 在构造后立即执行；对外窥 `dataDir`（handler 寻址用，替代 resolveDataDir(root)））
- Modify: `src/tui/session-journal.ts`（journalId 铸造暴露：支持「先铸 id 再惰性建档」或 sunx 直接 start——实现者按现状选最小缝）
- Modify: `src/serve/session-lifecycle.ts`（`createSessionIn` kind='sunx'：铸 id → 域目录 `~/.sunshinex/sunx/<journalId>/data/` mkdir → SessionRuntime 注入 dataDir → **跳过 workspace.json 注册**（sunx 域不进 /workspaces）→ 立即 attachJournal 建档出生；重开路径：`attachSunx(io, journalId)`——扫容器定位域 → 壳 newSession(kind='sunx',dataDir) → attachSessionIn 既有链（reCast/播种/重布防/恢复轮全部复用））
- Modify: `src/config/data-dir.ts`（`sunxDomainDir(journalId)` 落位单点：`~/.sunshinex/sunx/<journalId>/data`）
- Test: daemon 合同——①创建 sunx → 域目录在 `~/.sunshinex/sunx/<jid>/data`（journal/台账/板随档）、projects/ 下无新条目、/workspaces 无污染 ②重开：新 daemon attach → reCast 后全投影存活（P1 ⑪ 既有例改造为域路径）③standard 路径回归锚（注册/惰性建档语义不变）

**Interfaces:**
- `sunxDomainDir(journalId)` 单点（data-dir.ts）；GUI 不感知物理路径（端点寻址 journalId 即可）。
- 同 root 多实体：两个 sunx 绑同一 root → 两个独立域目录，零共享（含 memory）——**验收核心场景**。

- [ ] Step 1 失败测试（上述①②③）
- [ ] Step 2 落地 + 定向跑 + 提交（`feat(serve): sunx 持久化域——出生即铸档/域绑定/重开链`）

---

### Task 3: 列表与端点边界——SUNX 数据源改向

**Files:**
- Modify: `src/serve/sessions-list-handlers.ts` 或新 handler（`GET /sunx/sessions`：扫 sunx 容器全域 meta → rows（id/title/kind/updatedAt/awaiting/liveSessionId 经 daemon 注册表匹配））
- Modify: `src/serve/session-handlers.ts`（charter GET/POST、归档/删除、快照/观测端点：sunx 会话寻址改走 `session.dataDir` 外窥——handler 不再对 sunx 会话 resolveDataDir(root)；attachSunx 端点）
- Modify: `gui/src/connection.ts`/`connection-types.ts`（`sunxSessions()` 取数；attach 链改 `attachSunx`）
- Modify: `gui/src/sidebar/project-menu-sunx.tsx` + `SunxBoardTab.tsx`（SUNX 组/总览页数据源改 sunxSessions；卡片/条目 attach 走新链）
- Test: daemon 合同（枚举/过滤/attach）+ gui 定向（组/总览数据源）

**Interfaces:**
- `GET /sunx/sessions` → `{ sessions: SessionRow[] }`（kind 恒 'sunx'；含 awaiting/live 标注）。
- 归档/删除语义：删除 sunx = purge 整域目录（持久化实体随实例消亡——**裁定**：不留孤档）；归档沿用 meta 标记。

- [ ] Step 1 失败测试：枚举（多域/空容器/live 标注）；charter/删除/归档在 sunx 域寻址正确；gui 数据源切换
- [ ] Step 2 落地 + 定向跑 + 提交（`feat(serve): SUNX 数据源改向——域枚举端点/端点边界`）

---

### Task 4: 隔离验收 e2e + 全量回归

**Files:**
- Test: `src/serve/session.wake.test.ts` 或新 `session.sunx-domain.test.ts`——**核心隔离场景**：同一 root 下建 1 standard + 2 sunx（同名不同实例）→ 断言三域目录互不相同、文件互不可见；sunx A 写记忆 → sunx B/standard 读不到；唤醒/调度/恢复轮在域路径下全链复跑（P1/P2 既有 e2e 迁移到域路径自动通过）
- Gates: `pnpm test` + `pnpm selfcheck` + `pnpm --dir gui test` + `pnpm --dir gui run test:e2e`（预存抖动按既有协议）
- Modify: spec（§11 持久化域模型回写：一 sunx 一域/容器布局/无迁移无兼容裁定）+ MANUAL-GUI（Sunx 持久化说明）

- [ ] Step 1 失败测试（隔离三域场景）
- [ ] Step 2 全量门禁四项
- [ ] Step 3 文档回写 + 提交（`docs(sunx): P3 持久化域收口`）

---

## 场景走查（验收剧本）

| 场景 | 期望 |
|---|---|
| 同 root 建 1 普通 + 2 sunx | 三域目录互不相同；普通会话路径/行为零变化；sunx 域不出现在 /workspaces 与项目组 |
| sunx A 写工作区记忆 → sunx B / 普通会话 | 读不到 A 的记忆（记忆随域隔离——回应用户「避免互相影响记忆」） |
| 编辑品性 → 重启 → 重开 | 品性/链/任务/板全存活（域路径 attach 链） |
| 删除 sunx 实例 | 域目录整体 purge，无孤档 |
| 唤醒/定时/恢复轮 | 全链在域路径下复跑通过（既有 e2e） |

## P3 其余抽屉项（不在本计划）

跨 Sunx 协同（sunx-of-sunx）、外部 CLI 通道进 dispatch 面、注入扫描、`context:'clean'`、cron 周期调度与多槽位、TUI 调度显示 parity。
