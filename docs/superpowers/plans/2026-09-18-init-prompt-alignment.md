# /init 提示词对标实施计划

- 日期：2026-09-18
- 规格：`docs/superpowers/specs/2026-09-18-init-prompt-alignment-design.md`（提交 62777d0 / d7a65f1 / d66dbcb / 6ef605a / c94a212，用户答复「ok」批准）
- 执行方式：会话内联 TDD（fork / 子代理 / goal / 技能三级目录四先例同款；如需子代理驱动见文末交接）

**Goal:** 把 `/init` 提示词从「四句任务契约」重写为「覆盖大纲 + 证据要求 + 写法要求 + 写回契约」的七层任务书，使生成的 `SUNSHINE.md` 覆盖对标 CLAUDE.md 的项目事实面（60–120 行），且不锚定任何标题、不写死任何语言。

**Architecture:** 改动收敛在单一纯函数 `sunshineInitGoal(root, exists)`：它只产出 goal 文本，不做 IO、不新增工具、不改签名、不改调用点。`/init` 提示词经 fork 注入（`session.ts` 的 `runTaskFlow` 走 `scope:'fork'`），全文落在 fork 尾追、不进主链、不动稳定段——这是大纲可以写长的前提。

**Tech Stack:** TypeScript（strict）+ node:test；既有 i18n 基座 `pick(en, zh)`（`src/i18n.ts:28`，别名 `t`）。

## Global Constraints

- 只改三个文件：`src/harness/sunshine-init.ts`、`src/harness/sunshine-init.test.ts`、`TUI-MANUAL.md`。**不新增文件**，不改 `src/tui/session.ts`（`/init` 分支第 632 行调用点原样）、`src/config.ts`、`src/harness/context/loader.ts`。
- 函数签名不变：`sunshineInitGoal(root: string, exists: boolean): string`（`src/harness/sunshine-init.ts:11`）。
- 零新增依赖、零新增工具、零新增环境变量（原子工具优先，工具清单属稳定段）。
- 提示词内**不得出现任何标题字面**（行首 `#{1,6}` + 空格），不得出现机器消费区标题（`Compact Instructions` / `压缩指令` / `MCP 服务器`），不得出现双语并列字面（D2 / D9 / D10）。
- 提示词**不得写产出语言条款**（不出现「用中文 / 写成英文 / 中文项目写中文」类措辞）；产出语言由模型按项目自判（D8、CLAUDE.md §15）。
- 通用性钉子保持：不出现生态专名（`package.json`、包管理器名、框架名）（D6）。
- 既有 5 个英文锚点必须存活：`from scratch`、`never fabricate`、`refine`、`as-is`、`wholesale`（既有断言不改）。
- 单文件单次编辑：同一文件的两处改动**串行**执行，禁止同轮并行编辑同一文件（本仓 `reactor.ts` 并行写入竞态先例）。
- 提交只点名本线三个路径，不卷入他线 WIP（`src/tui/session/`、`src/harness/memory/`、`.gitignore` 等）。
- 门禁三绿：`pnpm build` tsc strict 零报错；全量测试 fail 0；`pnpm selfcheck` OK。

## 0. 锚点事实（2026-09-18 沙箱实测）

- `src/harness/sunshine-init.ts` 现为 5 行 `pick()` 拼接（L1 任务落点、L2 文件性质一句话、L3 真实性底线、L4 完善语义、L5 收尾），签名与调用点如上。
- `src/harness/sunshine-init.test.ts` 现 2 个用例（新建语义 / 完善语义），断言面：落点绝对路径、`/from scratch/`、`/never fabricate/`、`!/package\.json/`、`!/以 - 开头/`、`/refine/`、`/as-is/`、`/wholesale/`。
- i18n 导出面：`Language` / `getLanguage()` / `setLanguage()` / `t(en, zh)` / `pick = t` / `parseLanguage()`（`src/i18n.ts:10-31`）；进程级缺省 `en`。
- 编译产物：`tsconfig` `rootDir: src` → `outDir: dist`，定向测试跑 `node --test dist/harness/sunshine-init.test.js`。
- 手册落点：`TUI-MANUAL.md:71`（`/init` 命令表行）、`:132`（数据目录段 SUNSHINE.md 描述，现含「可含可选 `## Compact Instructions`（或 `## 压缩指令`）区」）。
- 规格 §4.1 A 档 5 类 / §4.2 B 档 6 类 / §4.3 写法要求 9 条 / §5 七层行数表 / §6 写回契约 5 步 / §9 验收矩阵 10 条。

## 1. 任务拆分（TDD 循环）

### T1 提示词七层重写：覆盖大纲 + 证据要求 + 写法要求 + 完善写回契约

**Files:**
- Modify: `src/harness/sunshine-init.ts`（全文重写函数体）
- Test: `src/harness/sunshine-init.test.ts`（追加 2 个用例）

**Interfaces:**
- Consumes: `pick(en: string, zh: string): string`（`../i18n`）、`path.join`。
- Produces: `sunshineInitGoal(root: string, exists: boolean): string` —— 签名不变，返回 `\n` 连接的七层提示词；`exists=false` 时含 `from scratch`，`exists=true` 时含 `refine`。

- [ ] **Step 1: 写失败测试**

在 `src/harness/sunshine-init.test.ts` 追加（保留既有 2 个用例原样不动）：

```ts
test('sunshineInitGoal：新建语义——覆盖大纲 A/B 档、覆盖率口径、篇幅目标齐备', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-goal-'));
  try {
    const g = sunshineInitGoal(dir, false);
    // L4a 口径声明：大纲是覆盖清单、不是格式
    assert.match(g, /coverage check, not a format/, '必须声明「覆盖清单、不是格式」，结构与命名交模型自定');
    // L3 证据要求
    assert.match(g, /dependency and script definitions/, '证据来源须为生态中性措辞');
    // L4b A 档 5 类
    assert.match(g, /what the project is/);
    assert.match(g, /how to run it/);
    assert.match(g, /how the code is laid out/);
    assert.match(g, /how it is structured/);
    assert.match(g, /how to write code here/);
    // L4c B 档 6 类触发条件
    assert.match(g, /commit-time gates/);
    assert.match(g, /packaging and release/);
    assert.match(g, /extension points/);
    assert.match(g, /version floors/);
    // L5 篇幅目标
    assert.match(g, /60-120 lines/, '篇幅目标必须在场');
    // 既有锚点
    assert.match(g, /from scratch/);
    assert.match(g, /never fabricate/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sunshineInitGoal：去标题锚定、提示词单语、不写产出语言条款（D2/D8/D9/D10）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-goal-'));
  try {
    const g = sunshineInitGoal(dir, false);
    assert.ok(!/^#{1,6}\s/m.test(g), '不出现标题字面锚点');
    assert.ok(!/Compact Instructions|压缩指令|MCP 服务器/.test(g), '不锚定机器消费区标题（D9）');
    assert.ok(!/[\u4e00-\u9fff]/.test(g), 'en 提示词不得混入中文（D10）');
    assert.ok(!/in Chinese|in English|用中文|写成中文|中文项目/.test(g), '不写产出语言条款（D8）');

    setLanguage('zh');
    try {
      const gz = sunshineInitGoal(dir, false);
      assert.match(gz, /依赖与脚本定义/, 'zh 侧同结构、同覆盖项');
      assert.match(gz, /提交前门禁/);
      assert.match(gz, /60–120 行/);
      assert.ok(!/^#{1,6}\s/m.test(gz), 'zh 侧同样无标题字面锚点');
      assert.ok(!/Compact Instructions|压缩指令|MCP 服务器/.test(gz), 'zh 侧不锚定机器消费区标题');
    } finally {
      setLanguage('en');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

test('sunshineInitGoal：完善语义——读全文、既有行原样保留、只补缺失、整体写回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-goal-'));
  try {
    fs.writeFileSync(path.join(dir, 'SUNSHINE.md'), '# 项目名称\n既有项目\n');
    const g = sunshineInitGoal(dir, true);
    assert.match(g, /read it in full first/, '未读全文不得落笔');
    assert.match(g, /as-is/, '既有行原样保留');
    assert.match(g, /append only what is missing/, '只补缺失覆盖项');
    assert.match(g, /do not rewrite it wholesale/, '不得整体推翻');
    assert.match(g, /in one go/, '合并结果一次性写回，禁止分次写盘');
    assert.ok(!/^#{1,6}\s/m.test(g), '完善语义下同样不锚定标题');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

同时把文件头 import 补一行：

```ts
import { setLanguage } from '../i18n';
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/harness/sunshine-init.test.js`
Expected: FAIL —— 新增 3 用例失败（现提示词无 `coverage check, not a format`、无 `60-120 lines`、无 `依赖与脚本定义`、无 `read it in full first`），既有 2 用例仍绿。

- [ ] **Step 3: 实现（`src/harness/sunshine-init.ts` 全文替换）**

```ts
/**
 * /init 目标构造器（纯函数）：构造 Claude Code /init 同款的模型驱动分析任务——
 * 模型在主链（Reactor → 工具面）里自行 read/grep 感知代码库并 write 生成/完善 SUNSHINE.md，
 * 写盘经安全链（manual 模式经 asker 审批）。本模块只产出 goal 文本，不做任何 IO。
 */
import * as path from 'path';
import { pick } from '../i18n';

/**
 * /init 任务目标（七层：任务落点 / 文件性质 / 探索要求 / 覆盖大纲 / 写法要求 / 新建完善分支 / 收尾）。
 * 大纲只说明「哪些事实不能缺席」，不给任何标题文本——分区命名与组织由模型按项目实况自定；
 * 一份提示词只出现一种语言（pick 按会话语言选定），不并列双语字面；
 * 产出语言由模型按当前项目文档风格自判，提示词不写语言条款（CLAUDE.md §15）。
 */
export function sunshineInitGoal(root: string, exists: boolean): string {
  const p = path.join(root, 'SUNSHINE.md');
  return [
    // L1 任务与落点
    pick(
      `Analyze the current codebase and ${exists ? 'refine' : 'generate'} the project convention file SUNSHINE.md (${p}).`,
      `分析当前代码库，${exists ? '完善' : '生成'}项目约定文件 SUNSHINE.md（${p}）。`,
    ),
    // L2 文件性质（每轮注入，每行都在花 token）
    pick(
      'Every turn reads this file into the agent context, so each line costs tokens: record long-lived project facts only — never history, plans or progress notes.',
      '该文件每轮都会读入 Agent 上下文，每一行都在花 token：只记录长期稳定的项目事实，不写历史、计划与进度。',
    ),
    // L3 探索与证据要求
    pick(
      'Read the project before writing: dependency and script definitions, entry files, configuration, directory layout, CI setup. Every statement must be traceable to something you actually read; never fabricate modules, commands or conventions that do not exist.',
      '落笔前先读项目：依赖与脚本定义、入口文件、配置、目录实况、CI 设置。每条陈述都必须能追溯到真正读过的东西，禁止编造不存在的模块、命令或约定。',
    ),
    // L4a 大纲使用口径
    pick(
      'The outline below is a coverage check, not a format: it lists facts that must not be missing. Headings, order and grouping are yours to decide.',
      '下面的大纲是覆盖清单、不是格式：它列出不能缺席的事实。标题、顺序与组织方式由你自己决定。',
    ),
    // L4b A 档：有证据则必写（5 类）
    pick(
      'Always cover these five when evidence exists: what the project is (name, one-line purpose, stack and runtime, main subsystems); how to run it (install, build, test, single-test filter, run, static check, release — copyable commands with when to use them); how the code is laid out (meaningful paths and what each is for); how it is structured (layers and dependency direction, module boundaries and seams, data and control flow, invariants that must not break); how to write code here (language and strictness, file responsibility, error handling, shared type registration, dependency admission rules).',
      '有证据时，以下五类必须覆盖：项目是什么（名称、一句话定位、技术栈与运行时、主要子系统）；命令怎么跑（安装、构建、测试、单测过滤、运行、静态检查、发布——可复制的命令，并说明何时用）；代码怎么摆（有意义的路径及各自职责）；架构怎么分（分层与依赖方向、模块边界与接缝、数据与控制流、不可破的不变量）；代码怎么写（语言与严格度、文件职责边界、错误处理、共享类型登记、依赖引入标准）。',
    ),
    // L4c B 档：有证据才写（6 类）
    pick(
      'Add these only when the project actually has them: commit-time gates; packaging and release; environment variables or config files and their precedence; extension points (plugins, skills, workflows) and how they load; platform differences and version floors; prohibitions, unwritable areas, permission limits.',
      '只有在项目确实存在时才补这些：提交前门禁；打包与发布；环境变量或配置文件及其优先级；扩展点（插件、技能、工作流）与加载方式；平台差异与版本下限；禁止项、不可写区与权限限制。',
    ),
    // L5 写法与质量
    pick(
      'Keep it dense: one fact per line, written for whoever works here next; give numbers where they exist and relative paths for locations. Skip general advice such as "write clean code", skip inventories that rot quickly, and leave no placeholders or TODO markers. Aim for 60-120 lines; when evidence is missing, omit rather than pad. Write the whole document in a single write when you are done — never in pieces.',
      '写紧凑：一条一行、面向接下来在此工作的人；有数字给数字，位置用相对路径。不写「写清晰的代码」这类通用建议，不写会很快过期的清单，不留占位符或 TODO 标记。目标 60–120 行；没有证据的宁可省略也不要硬凑。收尾时一次性写出完整文档，不要分次写。',
    ),
    // L6 新建 / 完善分支
    exists
      ? pick(
          'The file already exists: read it in full first, then append only what is missing. Keep every existing line as-is — its headings, wording and order included; do not rewrite it wholesale, and do not delete or reword anything already there. Write the merged result back in one go.',
          '该文件已存在：先完整读取，然后只补缺失的内容。既有每一行都原样保留——包括它自己的标题、措辞与顺序；不得整体推翻，不得删除或改写任何既有内容。然后把合并结果一次性写回。',
        )
      : pick('The project does not have this file yet: generate it from scratch.', '当前项目还没有该文件：从零生成。'),
    // L7 收尾
    pick(
      'When done, report in one sentence which facts you added.',
      '完成后用一句话汇报补齐了哪些事实。',
    ),
  ].join('\n');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/harness/sunshine-init.test.js`
Expected: PASS —— 5 个用例全绿（2 既有 + 3 新增）。

- [ ] **Step 5: 提交**

```bash
git add src/harness/sunshine-init.ts src/harness/sunshine-init.test.ts
git commit -m "feat(init): 提示词七层重写——覆盖大纲+证据要求+写法要求+完善写回契约，去标题锚定、单语、篇幅 60-120"
```

### T2 手册口径同步（TUI-MANUAL）

**Files:**
- Modify: `TUI-MANUAL.md:71`（`/init` 命令表行）
- Modify: `TUI-MANUAL.md:132`（数据目录段 SUNSHINE.md 描述）

**Interfaces:**
- Consumes: 无（纯文档）。
- Produces: 无。

- [ ] **Step 1: 改 `/init` 命令表行（第 71 行）**

原文：

```markdown
| `/init` | 分析项目，生成/完善 SUNSHINE.md（写盘后立即重载入会话上下文） |
```

改为：

```markdown
| `/init` | 分析项目后按覆盖大纲（项目是什么/命令怎么跑/代码怎么摆/架构怎么分/代码怎么写）生成或补全 SUNSHINE.md：文件已存在时只追加缺失内容，既有行原样不动；写盘后立即重载入会话上下文 |
```

- [ ] **Step 2: 改 SUNSHINE.md 描述（第 132 行）**

原文（句尾部分）：

```markdown
可含可选 `## Compact Instructions`（或 `## 压缩指令`）区：其中的要求会在压缩摘要时优先保留。
```

改为：

```markdown
可含可选 `## Compact Instructions`（或 `## 压缩指令`）区（**需手工编写，`/init` 不再生成**）：其中的要求会在压缩摘要时优先保留。
```

- [ ] **Step 3: 门禁三绿**

Run: `pnpm build && pnpm test`
Expected: tsc strict 零报错；全量测试 fail 0（本次无测试面新增，用例总数较基线不变）。

Run: `pnpm selfcheck`
Expected: OK（`skills: 21 loaded, resolve=ok`，工具清单按名排序、仍为既有 10 项）。

- [ ] **Step 4: 提交**

```bash
git add TUI-MANUAL.md
git commit -m "docs(manual): /init 按覆盖大纲补全口径 + 压缩保留区改手工编写说明"
```

## 2. 计划自审

**规格覆盖**

| 规格条目 | 落点 |
|----------|------|
| §4.1 A 档 5 类覆盖项 | T1 Step 1 断言 + Step 3 L4b |
| §4.2 B 档 6 类触发条件 | T1 Step 1 断言 + Step 3 L4c |
| §4.3 写法要求（一条一行/数字/相对路径/禁空话/禁易腐清单/无证据不写） | T1 Step 3 L5 |
| §5 七层结构 | T1 Step 3 全文（L1–L7 注释分层） |
| §5 格式契约（Markdown、不锚标题） | T1 Step 3 无标题字面 + Step 1 反向断言 |
| §6 写回契约 5 步 | T1 Step 1 完善语义用例五项断言 + Step 3 L6 |
| §6 边界（`@` 导入行原样保留、过期不删改、幂等） | T1 Step 3 L6「do not delete or reword anything already there」+「只补缺失」 |
| §7 去锚定取舍 | T1 Step 1 反向断言（`Compact Instructions` 等零命中）+ T2 Step 2 手册说明 |
| §8 通用性 / 单语 / 产出语言 / 零新装配面 | Global Constraints + T1 Step 1 断言 |
| §9 验收 1–2、5–7 | T1/T2 用例 |
| §9 验收 10（手册同步） | T2 |
| §10 改动面三文件 | T1/T2 文件清单 |

**占位符扫描**：无 TBD / TODO / 「类似上文」；每个 code step 均为可粘贴原文。

**任务边界**：完善语义的写回契约与提示词正文落在**同一段分支文本**上，评审者无法接受其一而否决另一，故按 right-sizing 合并为 T1；T2 为独立的手册文档面。

**类型与命名一致性**：全程 `sunshineInitGoal(root: string, exists: boolean): string` 与 `pick(en, zh)`，无新增导出面、无改名。

**已知取舍（据实登记，非遗漏）**：去锚定后 `/init` 不再保证写出压缩保留区与 MCP 服务器分区（D9，规格 §7）——需用时手工补写，T2 Step 2 已在手册写明。

## 3. 执行方式

默认会话内联 TDD（本仓四先例同款）。如需子代理驱动，按每任务一个 fresh 子代理 + 任务间复核执行；本计划两任务相互独立（T1 代码面、T2 手册面），可并行派发。
