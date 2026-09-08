# CLAUDE.md

本文件是 SunshineX 项目的 AI 协作规范，供智能体与开发者共同遵守。
它是项目的「工作说明书」，优先于模型默认行为；冲突时以本文件为准。

## 1. 项目概览

- 名称：SunshineX —— 通用 AI Agent 工程化骨架
- 范式：Harness / Loop / Graph 三层嵌套
- 技术栈：TypeScript（strict）+ Node.js，CommonJS 模块
- 定位：云端推理，本地负责编排、执行、安全与记忆
- 对标：OpenAI Codex / Claude Code / Hermes

## 2. 常用命令

```bash
pnpm build      # 编译 TS 到 dist/（tsc -p tsconfig.json）
pnpm start      # 运行入口（node dist/index.js）
pnpm selfcheck  # 编译并运行骨架自检
pnpm test      # 编译 + 全量单测（node --test）
pnpm cli       # CLI 执行面（内置自动构建，自动装载 .env）
pnpm install   # 安装依赖
```

> 包管理器统一 pnpm：版本由 `packageManager` 字段钉定（Node 自带 corepack，`corepack enable` 后直接使用 `pnpm`）；项目 `.npmrc` 已将 store 固定在仓内 `.pnpm-store`，沙箱等 HOME 不可写环境开箱即用。

## 3. 目录结构

```text
src/
  index.ts            # npm/pnpm start 入口（自动装载 .env）
  cli/                # CLI 执行面（selfcheck / run / pipeline）
  types.ts            # 全局共享类型
  result.ts           # Result 统一结果类型
  runtime.ts          # 运行时装配根（buildDeps：CLI/TUI/GUI 三面共用）
  config.ts           # SUNSHINE.md 解析器
  config/env.ts       # 零依赖 .env 装载（已导出环境变量优先）
  harness/
    index.ts          # Harness 门面
    perception.ts     # 项目感知（目录/依赖/SUNSHINE.md/Git）
    reactor.ts        # 最小闭环引擎（observe→think→act）
    skills.ts         # 技能加载（skills/{id}/skill.md）
    tools.ts          # 工具注册表（MCP 挂载点）
    tools/builtin.ts  # 内置工具（read/write/grep/glob/exec）
    memory-lifecycle.ts # 统一记忆生命周期
    security/         # guard/policy/modes/sandbox/dryrun/chain
    context/          # loader/rules/window/session/auto-memory/memory-lifecycle
  loop/
    engine.ts         # Loop 闭环引擎（生成→校验→修正）
    nodes.ts          # 四类节点（Agent/Check/Gate/Router）+ /goal 判据
    templates.ts      # 三大模板（重构/测试闭环/代码审查）
  graph/
    engine.ts         # DAG 拓扑执行（含环检测）
    nodes.ts          # 四类节点（loop/agent/gate/ci）
    agents.ts         # 多角色子 Agent
    workflow.ts       # WorkflowDef 装配
    templates.ts      # 五节点软件工程流水线
  model/adapter.ts    # 模型适配 + 三档算力路由
  storage/            # 本地 JSON 存储底座（adapter.ts）
  plugins/loader.ts   # 插件加载（plugins/{id}/plugin.json）
skills/               # 用户技能目录
plugins/              # 用户插件目录
SUNSHINE.md          # 项目业务配置
```

## 4. 架构约定

- 分层依赖方向：graph → loop → harness → model / storage / plugins
- Graph 节点可嵌入 Loop 子流程，二者都运行在 Harness 底座之上
- 插件与技能通过「目录约定」加载，第三方工具经 MCP 接入
- 错误通道分域：工具与安全域返回 `Result`（可预期失败显式化）；引擎（Reactor/Loop/Graph）在节点边界 `catch` 后转为节点状态与 `reply` 字段（不可预期失败集中化），两条通道不得跨域混用
- 运行时装配收敛于 `src/runtime.ts`（buildDeps），交互面（CLI/TUI/GUI）只做参数解析与呈现，新增交互面复用同一装配根

## 5. 编码规范

- TypeScript 开启 strict，禁止无理由使用 any
- 一个文件只承担一个职责，模块边界清晰
- 所有 IO（文件/网络/命令）集中在对应 adapter/store 内
- 写操作前评估影响面；改动后运行 `pnpm selfcheck` 自检
- 新增共享类型需在 `src/types.ts` 登记
- 依赖引入原则：零依赖不是硬规则。优先 node: 内置模块；允许引入优秀且必要的第三方依赖。引入标准：解决真实问题、维护活跃、类型完善（或随附 .d.ts）、许可证兼容、依赖面（含传递依赖）可控；引入时登记 `package.json`、在 README/Arch-Plan 标注用途，并跑全量 build/test 验证
- **已登记依赖**：`@modelcontextprotocol/sdk` ^1.30.0 —— MCP 官方客户端（stdio 传输）。用途：阶段四第三方工具接入（懒 spawn → 握手身份校验 → tools/list → tools/call）；边界：依赖收敛于 `src/harness/mcp/client.ts` 接缝内（替换客户端实现不动主链），仅本地 stdio spawn，HTTP/SSE 传输未启用；回退预案：自研最小 stdio JSON-RPC 客户端同接口（spec §6-R6）

## 6. 技能与插件规范

- 技能：`skills/{id}/skill.md`，含 frontmatter（name/description/version）与正文
- 插件：`plugins/{id}/plugin.json`，声明 id/name/version/entry
- 加载器只做发现与解析，不执行副作用；执行由 Harness 统一调度

## 7. 提交与验证

- 提交前必须通过 `pnpm build`（tsc 严格模式零报错）
- 涉及加载/解析逻辑时，补充示例物料并确保 `--selfcheck` 输出正确
- `.pnpm-store/`、`.npm-cache/`、`.data/`、`.longtask/`、`node_modules/`、`dist/` 不入库

## 8. 边界与约束

- 仅使用 sandbox__* 工具操作文件与命令
- 禁止写 /skills，只写 /workspace
- 禁止越狱路径（/tmp、.. 逃逸等）
- 默认无外网；需要外连时由管理员开启会话级网络

## 9. 信息对齐与执行准则

执行任务前先对齐信息，不机械照字面生成结果：

- 信息充分：直接执行，不重复追问。
- 缺失会显著改变结果的关键信息：最多提 3 个关键问题；不影响推进时明确假设、先做探索版再收敛。
- 主动指出用户方案的更优替代与取舍，不盲从原方案。
- 共同未知：转为可验证假设，用最小实验验证（控制单一变量，明确成功/失败信号）。

## 10. 代码修改纪律

- 禁止补丁式修改：追溯根因重构，禁用临时 if/开关变量/复制粘贴兜底；同一 bug 反复 2–3 轮仍复发，即质疑架构与提示词，而非靠代码过滤兜底。
- 代码自解释：命名清晰表意；注释只写业务规则与决策背景（为什么），不复述代码逻辑。
- 无残渣：清理死代码、未用 import/字段、注释掉的代码；上新删旧，不留悬空引用。
- 部署一致性：本地与服务器代码一致，交付前校验；改动后按本项目约定验证（`pnpm build` + `pnpm selfcheck`）。

## 11. 长任务设计取向

本项目对标 Claude Code / Codex 等明星 agent 产品的**长任务能力**：任务由完成判定（验收标准、修正环收敛）驱动，而非由保守的步数/超时中断驱动。对标基线：明星产品代理轮次无人工步数上限、命令可后台长跑、以完成与预算为界——本项目缺省值按同量级取值，上限仅为安全网。

- **缺省放宽原则**：超时、轮次、步数、预算的缺省值按「真实长任务」量级取值——模型调用超时 600s（深度推理 + 长生成）、命令执行超时 1800s（install/build/test 套件）、命令输出缓冲 32MB、Reactor 200 步（对标「无步数上限、完成驱动」）、修正环 100 轮 / 1M tokens / 2 小时、全链路 500 节点步 / 2M tokens / 4 小时。宁可放宽缺省，不靠保守中断制造假失败。
- **放宽不等于无界**：预算记账、错误局部化、fail-bounded 语义全部保留——上限是安全网而非期望路径；长任务的正确形态是「宽预算 + 验收收敛」，而非「频繁触界中断」。
- **新增参数时**：缺省值须按长任务场景论证并对齐上述量级；测试与探针可用显式小值构造边界用例，但不得因测试便利反推缩水产品缺省值；**各层缺省须同量级一致——单层缩水即整链瓶颈**（入口/模板层的显式覆盖值视同产品缺省，须同等论证）。
- 已知长任务敏感点：模型慢响应（adapter timeoutMs）、长命令执行（sandbox exec 超时与 maxBuffer）、复杂多文件任务（Reactor maxSteps、Loop 修正环轮数、Graph 全链路终止参数）、各 CLI 命令与模板内嵌节点的显式覆盖值。调整任一处须同步评估其余层级的一致性。

## 12. 平台兼容性目标

以「一份代码、三平台可部署」为目标：Windows / macOS / Linux（Node.js ≥ 22.9）均可完成安装、构建、自检与 CLI 基础使用；工具命令执行面以 POSIX sh 为基线，Windows 经 Git Bash 原生支持（`resolveShell()` 自动探测，无 Git 时 `ComSpec` 兜底）。

- **版本下限**：Node.js ≥ 22.9（`pnpm cli` 依赖 `--env-file-if-exists`；以 `package.json` 的 `engines` 为准），实测基线 22 LTS 与 24.x。
- **工程约束（编码时强制）**：路径一律 `path.join` / `path.resolve` / `path.relative`，禁止手拼分隔符；子进程执行收敛在 `ProcessSandbox` 单点，平台分支只允许出现在该文件；pnpm scripts 保持零 shell 语法依赖（仅 `&&`）；glob 匹配与产物统一 `/` 分隔——`listFiles` 对 `path.relative` 结果先归一化再匹配（Windows 反斜杠进入正则前转为 `/`，POSIX 为 no-op）。
- **已知差异（如实登记，不虚构兼容）**：`exec` shell 由 `resolveShell()` 按序解析——`SUNSHINEX_SHELL` 覆盖（契约：须 POSIX 兼容，配 `-c` 调用；指向 cmd.exe 等非 POSIX shell 属未定义行为）→ Windows 探测 `Git\bin\bash.exe`（Git Bash）→ 无 Git 时 `ComSpec`（`/c`，仅兜底不崩，sh 语义命令不保证可用）→ POSIX `/bin/sh`；包管理器统一 pnpm（`packageManager` 钉版）；`.npmrc` 已将 store 固定在仓内 `.pnpm-store`，沙箱等 HOME 不可写环境开箱即用；仓库文本为 LF，Node/tsc 对 CRLF 不敏感，禁止提交整文件换行符重写。
- **平台相关改动纪律**：新增任何平台相关行为（路径、进程、信号、权限）须在本节登记差异与结论，并同步复核 README 平台支持矩阵与部署指引。
