# 技能即命令——`/<技能id>` 动态命令面实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `/<技能id>` 动态斜杠命令——裸形式仅加载（链尾追+去重）、带意图确定性加载后一步派发标准环；内置命令零触碰、`/skill` 选择卡保留为浏览兜底、学习沉淀运行期即时注册（零持久注册表）。

**Architecture:** 三单元——① 新建共享单点 `src/tui/slash-commands.ts` 承载内置命令清单（App 重导出保持既有 import 路径，session 消费同一单点，化解 App→session 循环依赖）；② `slashCandidates(buffer, extra?)` 增可选参纯函数 + App Tab 循环改合并池（extra 空时逐字节等价）；③ session 增 `skillCommandIds()` 注册单点与 `loadSkill(id)` 加载单点（从现 `skillFlow` 尾段提取），`handleSlash` 尾部增技能命令分发，`slashHelp` 调用时追加技能段。

**Tech Stack:** TypeScript strict + React(ink) + node:test；零新依赖、零接口变更、模型工具清单零新增（零前缀断点）。

## Global Constraints

- 规格来源：`docs/superpowers/specs/2026-09-22-skill-as-command-design.md`（D1–D9 裁决、错误面、验收矩阵 A1–A11、YAGNI 清单）；裁决冲突以规格为准
- 门禁：每任务 `pnpm build`（tsc strict 零报错）→ 定向测试绿；Task 4 收尾 `pnpm test` 全量 fail 0 + `pnpm selfcheck` OK
- 测试同目录就近放置（CLAUDE.md §5）；定向跑法 `pnpm build && node --require ./scripts/test-env.cjs --test <dist 下测试文件>`
- 写链面恒英文单语（CLAUDE.md §15）：`[Skill] …` 头行沿既有格式；上屏回执与 /help 技能段文案一律 `t(en, zh)` 双语运行期求值
- 内置命令清单内容与顺序零漂移：`slash-commands.ts` 数组字面量逐字节照搬 App.tsx:27 现值；既有 `App.input.test.tsx` 断言（`deepEqual(slashCandidates('/'), SLASH_COMMANDS)`、Tab 邻位 `/tasks → /skill → /new`、`/new → /resume`）全部原样保留作回归钉
- 加载通道全复用先例（2026-09-22-skill-command-filterable D2/D3/D4）：resolve → `appendChain([{ action: 'skill', observation }])` 链尾追 + 链上去重 + resolve 失败 warn；`setSkillBlock`/`pendingSkill`（loop skillRef 一次性首帧槽）零触碰
- id 安全字符集（D2）：`/^[a-z0-9][a-z0-9_-]*$/`；命令 token = id，展示名（frontmatter name）仅入卡与 /help
- 提交纪律：每任务独立提交、`git add` 显式 pathspec；工作区存在并发线 WIP，严禁 `git add -A`

## 现场勘误登记（规格→计划核实修正）

1. **内置清单来源**：规格初稿 D6 写「session 从 App 模块导入 SLASH_COMMANDS」——经 import 面核实（session.ts 现 import 面无 components/App；App.tsx 已 import `SessionController`），直接导入引入 App→session→App 运行期循环依赖。订正为共享单点 `src/tui/slash-commands.ts`，App `export { SLASH_COMMANDS } from '../slash-commands'` 重导出（既有 `from './App'` import 路径零破坏）。规格 D6 已同步订正。
2. **撞名专用提示**：规格初稿 D1 错误面曾设计「撞名技能输入时给专用提示」——分发序内置分支先行拦截，exact-match 提示按构造不可达。订正为零新增提示面（内置行为照旧，撞名技能仅可经 `/skill` 卡加载）。规格 D1 与错误面已同步订正。
3. **测试驱动面**：`handleSlash` 为 private，统一走 `ctrl.submit()` 公共面（既有 `session.skill.test.ts` 同款）；「运行中」用 `session.steer.test.ts` 的 deferred 门 + `waitFor(status==='running')` 手法。
4. **技能套件隔离**：`session.skill.test.ts` 顶部 `process.env.SUNSHINEX_LEARNED_SKILLS = 'off'`（learned 沉淀关断）+ `SUNSHINEX_DATA_DIR` 钉定私有数据目录——新套件 `session.skill-command.test.ts` 沿用同款前置，防沉淀污染清单断言。
5. **pnpm 停运绕行**：本工作区 pnpm 固定版本引擎损坏（`ERR_PNPM_ENGINE_BIN_MISSING`，10.12.1 可执行缺失），`pnpm build/test/selfcheck` 全部不可用。各脚本实质均为 `tsc -p tsconfig.json` + node 直跑——执行一律改直调等价通道：build=`node_modules/.bin/tsc -p tsconfig.json`，定向测试=`node --require ./scripts/test-env.cjs --test <dist 测试文件>`；Task 4 的 `pnpm selfcheck` 同理改 `node dist/cli/index.js selfcheck`。语义等同，门禁力不降。
6. **并发线覆写事故两起（Task 1 期间，均已当场修复）**：① App.tsx 尾部被并发线追加孤立 JSX 残片（`ate.todos}` 半截，语法级损坏，阻塞全仓 build）——截回 HEAD 尾部形态；② 我方 import 行被并发线覆写吞失（TS2304）——补回后立即提交钉住。后续任务门禁增「diff 范围断言」：build/commit 前先 `git diff --stat` 确认仅含本任务预期 hunks。
7. **Task 2/3 拆界订正**：Task 2 原设计含 `skillExtra` effect 接线，但 `controller.skillCommandIds()` 系 Task 3 产物——Task 2 先行引用必致编译失败。订正：Task 2 交付纯函数面（slashCandidates extra 合并 + Tab 循环抽纯函数 `nextSlashCompletion(buffer, pool)` + `skillExtra` state 初值 `[]`），App effect 接线移交 Task 3 与 session 同批交付；Task 2 期间 skillExtra 恒空 → 运行时行为逐字节等价。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/tui/slash-commands.ts` | 新建 | 内置斜杠命令清单唯一源（数组字面量自 App.tsx:27 照搬） |
| `src/tui/components/App.tsx` | 修改 | 重导出 SLASH_COMMANDS；`slashCandidates` 增 `extra?`；Tab 循环改合并池；`skillExtra` 快照回合边界刷新 |
| `src/tui/components/App.input.test.tsx` | 修改 | extra 合并/内置在前/Tab 跨界循环用例；既有断言零改动 |
| `src/tui/session.ts` | 修改 | `skillCommandIds()`；`loadSkill(id)` 提取（skillFlow 复用）；`handleSlash` 技能分发；`slashHelp` 技能段 |
| `src/tui/session.skill-command.test.ts` | 新建 | 验收矩阵 A1–A8 用例 |
| `src/tui/session.skill.test.ts` | 不改 | skillFlow 改走 loadSkill 后既有用例即回归钉（断言零改动，跑绿即可） |
| `MANUAL.md` | 修改 | 命令总表补技能即命令口径行 |

---

### Task 1: 内置命令清单共享单点

**Files:**
- Create: `src/tui/slash-commands.ts`
- Modify: `src/tui/components/App.tsx`（仅声明行替换为重导出）

**Interfaces:**
- Produces: `export const SLASH_COMMANDS: string[]`（唯一源）；App.tsx `export { SLASH_COMMANDS } from '../slash-commands';`——`App.input.test.tsx` / `session.memory.test.ts` 的 `from './components/App'` import 零改动

- [ ] **Step 1: 新建 `src/tui/slash-commands.ts`**：文件头注释注明「内置斜杠命令唯一源（规格 2026-09-22-skill-as-command D6）：App 重导出保持既有 import 路径，session 消费同一单点；数组内容与顺序零漂移（原 App.tsx:27 照搬）」，数组字面量 20 条逐字节照搬。
- [ ] **Step 2: App.tsx** 删原 `export const SLASH_COMMANDS = [...]` 行，替换为 `export { SLASH_COMMANDS } from '../slash-commands';`；文件内其余引用（slashCandidates、Tab 池）改从重导出符号取值（import { SLASH_COMMANDS } … 或直接用重导出名，保持编译通过即可）。
- [ ] **Step 3: 绿灯**：`pnpm build` + `node --require ./scripts/test-env.cjs --test dist/tui/components/App.input.test.js dist/tui/session.memory.test.js`——既有断言零改动全绿。
- [ ] **Step 4: 提交**：`git add src/tui/slash-commands.ts src/tui/components/App.tsx && git commit -m "refactor(tui): 内置斜杠命令清单上移共享单点 slash-commands.ts（App 重导出零破坏，规格 D6）"`

### Task 2: slashCandidates extra 合并与 Tab 合并池

**Files:**
- Modify: `src/tui/components/App.tsx`
- Modify: `src/tui/components/App.input.test.tsx`

**Interfaces:**
- Produces: `slashCandidates(buffer: string, extra: readonly string[] = []): string[]`（纯函数；extra 为已按 D1/D2 过滤的技能命令池，内置在前、extra 按入参序追加，不去重——skillCommandIds 已排除内置）；App 内 `const [skillExtra, setSkillExtra] = React.useState<string[]>([])`，`React.useEffect(() => { setSkillExtra(controller.skillCommandIds()); }, [controller, state.metrics.sessionTurns])`（挂载 + 回合边界刷新，不逐键读盘）

- [ ] **Step 1: 写失败测试**（App.input.test.tsx 追加；既有用例零改动）：
  - `slashCandidates('/he', ['/hello-world'])` → `['/help', '/hello-world']`（内置在前，A10）
  - `slashCandidates('/', ['/hello-world'])` 长度 = SLASH_COMMANDS.length + 1 且首 20 项 deepEqual SLASH_COMMANDS（A9 变体）
  - Tab 跨界循环：pool 末位技能 token exact 时 Tab 回到 `'/help '`（A11）
- [ ] **Step 2: 实现**：slashCandidates 合并池过滤；Tab 分支 `const pool = [...SLASH_COMMANDS, ...skillExtra]`，exactIdx/candidates 均在池上运算（skillExtra 空时与现行为逐字节等价）；skillExtra 快照 effect。
- [ ] **Step 3: 绿灯**：build + 定向 `App.input.test.js`（既有钉子 + 新用例全绿）。
- [ ] **Step 4: 提交**：`git add src/tui/components/App.tsx src/tui/components/App.input.test.tsx && git commit -m "feat(tui): slashCandidates 增 extra 合并与 Tab 合并池——技能命令进补全面（规格 D7，缺省等价钉）"`

### Task 3: session 注册单点 / 加载单点 / 分发 / help 技能段

**Files:**
- Modify: `src/tui/session.ts`
- Create: `src/tui/session.skill-command.test.ts`

**Interfaces:**
- Consumes: `SLASH_COMMANDS`（自 `./slash-commands`）；`runtime.harness.skills.list()/resolve()`；既有 `runTaskFlow(goal)`（session.ts:839）
- Produces: `skillCommandIds(): string[]`（public；list() 现读磁盘 → `^[a-z0-9][a-z0-9_-]*$` 过滤 + 内置词排除 → id 字典序）；`private loadSkill(id): 'loaded' | 'already' | 'failed'`（回执在内部上屏；skillFlow 选择卡选定后改走此单点，行为零变化）；handleSlash 尾部分发（内置分支全落空后）：token ∈ skillCommandIds → 运行中 warn（D5）→ 裸形式 `loadSkill` / 带意图 `loadSkill` 成功后 `runTaskFlow(text.slice(cmd.length).trim())`（failed 不派发）→ 否则原文案；slashHelp 尾部技能段（D8：`  /<id>` + name + 描述截 128，formatSkillsIndex 口径，空池不显示）

- [ ] **Step 1: 写失败测试**（session.skill-command.test.ts；前置照抄 session.skill.test.ts 头部：SUNSHINEX_LEARNED_SKILLS off + 私有数据目录 + writeSkill/chainEntries/sysTexts 夹具）：
  - A1 裸形式：`submit('/hello-world')` → 链含 action='skill' 条目 + `Skill loaded` 回执；再执行 → `already loaded|已加载` 回执且链条目数不变
  - A2 带意图：`submit('/hello-world 修复登录页')` → 链含 skill 条目 **且** action='task' 条目含「修复登录页」（session.test.ts:375 同观察面）；`await ctrl.waitIdle()`；ScriptedAdapter([{content:'',toolCalls:[]}])（/goal 同款一轮即收）
  - A3 幂等：先裸形式加载，再 `'/hello-world 再跑一次'` → skill 条目仍 1 条 + task 条目在
  - A4 撞名：writeSkill(root,'resume',…) → `submit('/resume')` 不产生 skill 链条目（内置分支拦截；以 dismiss 收尾回填）；`/skill` 卡选项含该技能
  - A5 非法 id：目录名 `Bad.Id` → `skillCommandIds()` 不含；`submit('/Bad.Id')` → 无法识别文案
  - A6 PARAM_MISSING：夹具触发 SKILL_PARAM_MISSING（实施时 grep `src/harness` skills 测试探明占位符/params 触发形态后落夹具）→ warn 回执 + 无 task 条目
  - A7 运行中：deferred 门挂起普通任务 → running 后 `submit('/hello-world')` → 运行中 warn + 零 skill 条目 → 门释放 → idle
  - A8 /help：有技能 → slashHelp 输出含 `Skills:` 段与 `/hello-world`；空技能目录 → 无该段；内置 20 行清单逐行不变
- [ ] **Step 2: 实现 session.ts**（按 Interfaces 逐条；loadSkill 提取时 skillFlow 尾段原样搬运，receipts 文案零变化；import 单点 SLASH_COMMANDS）。
- [ ] **Step 3: 绿灯**：build + 定向 `session.skill-command.test.js` + **既有 `session.skill.test.js` 全绿（零改动回归钉）** + `session.test.js`（/help 相关）。
- [ ] **Step 4: 提交**：`git add src/tui/session.ts src/tui/session.skill-command.test.ts && git commit -m "feat(tui): /<技能id> 动态命令——裸形式仅加载、带意图确定性加载后一步派发（规格 D1-D9）"`

### Task 4: MANUAL.md + 全量回归收尾

- [ ] **Step 1: MANUAL.md** 命令总表 `/skill` 行后补一行技能即命令口径（裸形式/带意图/撞名内置优先/字符集边界）。
- [ ] **Step 2: 全量**：`pnpm test` fail 0 + `pnpm selfcheck` OK。
- [ ] **Step 3: 提交**：`git add MANUAL.md && git commit -m "docs: MANUAL.md 命令总表补 /<技能id> 技能即命令口径"`
