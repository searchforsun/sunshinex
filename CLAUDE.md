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
npm run build      # 编译 TS 到 dist/（tsc -p tsconfig.json）
npm run start      # 运行入口（node dist/index.js）
npm run selfcheck  # 编译并运行骨架自检
npm install        # 安装依赖
```

> 注意：本环境 HOME 不可写，安装依赖需 `npm install --cache .npm-cache`。

## 3. 目录结构

```text
src/
  index.ts            # 入口 + --selfcheck 自检
  types.ts            # 全局共享类型
  config.ts           # SUNSHINE.md 解析器
  harness/
    skills.ts         # 技能加载（skills/{id}/skill.md）
    memory.ts         # 三级记忆（working/episodic/skill）
    tools.ts          # 工具注册表（MCP 挂载点）
  loop/engine.ts      # Loop 闭环引擎（生成→校验→修正）
  graph/
    engine.ts         # DAG 拓扑执行（含环检测）
    agents.ts         # 多角色子 Agent
  model/adapter.ts    # 模型适配 + 三档算力路由
  storage/store.ts    # 本地 JSON 存储底座
  plugins/loader.ts   # 插件加载（plugins/{id}/plugin.json）
skills/               # 用户技能目录
plugins/              # 用户插件目录
SUNSHINE.md          # 项目业务配置
```

## 4. 架构约定

- 分层依赖方向：graph → loop → harness → model / storage / plugins
- Graph 节点可嵌入 Loop 子流程，二者都运行在 Harness 底座之上
- 插件与技能通过「目录约定」加载，第三方工具经 MCP 接入
- 业务逻辑尚未落地处均为占位实现，替换时保持现有接口不变

## 5. 编码规范

- TypeScript 开启 strict，禁止无理由使用 any
- 一个文件只承担一个职责，模块边界清晰
- 所有 IO（文件/网络/命令）集中在对应 adapter/store 内
- 写操作前评估影响面；改动后运行 `npm run selfcheck` 自检
- 新增共享类型需在 `src/types.ts` 登记

## 6. 技能与插件规范

- 技能：`skills/{id}/skill.md`，含 frontmatter（name/description/version）与正文
- 插件：`plugins/{id}/plugin.json`，声明 id/name/version/entry
- 加载器只做发现与解析，不执行副作用；执行由 Harness 统一调度

## 7. 提交与验证

- 提交前必须通过 `npm run build`（tsc 严格模式零报错）
- 涉及加载/解析逻辑时，补充示例物料并确保 `--selfcheck` 输出正确
- `.npm-cache/`、`.data/`、`node_modules/`、`dist/` 不入库

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
- 部署一致性：本地与服务器代码一致，交付前校验；改动后按本项目约定验证（`npm run build` + `npm run selfcheck`）。

## 11. 长任务设计取向

本项目对标 Claude Code / Codex 等明星 agent 产品的**长任务能力**：任务由完成判定（验收标准、修正环收敛）驱动，而非由保守的步数/超时中断驱动。对标基线：明星产品代理轮次无人工步数上限、命令可后台长跑、以完成与预算为界——本项目缺省值按同量级取值，上限仅为安全网。

- **缺省放宽原则**：超时、轮次、步数、预算的缺省值按「真实长任务」量级取值——模型调用超时 600s（深度推理 + 长生成）、命令执行超时 1800s（install/build/test 套件）、命令输出缓冲 32MB、Reactor 200 步（对标「无步数上限、完成驱动」）、修正环 100 轮 / 1M tokens / 2 小时、全链路 500 节点步 / 2M tokens / 4 小时。宁可放宽缺省，不靠保守中断制造假失败。
- **放宽不等于无界**：预算记账、错误局部化、fail-bounded 语义全部保留——上限是安全网而非期望路径；长任务的正确形态是「宽预算 + 验收收敛」，而非「频繁触界中断」。
- **新增参数时**：缺省值须按长任务场景论证并对齐上述量级；测试与探针可用显式小值构造边界用例，但不得因测试便利反推缩水产品缺省值；**各层缺省须同量级一致——单层缩水即整链瓶颈**（入口/模板层的显式覆盖值视同产品缺省，须同等论证）。
- 已知长任务敏感点：模型慢响应（adapter timeoutMs）、长命令执行（sandbox exec 超时与 maxBuffer）、复杂多文件任务（Reactor maxSteps、Loop 修正环轮数、Graph 全链路终止参数）、各 CLI 命令与模板内嵌节点的显式覆盖值。调整任一处须同步评估其余层级的一致性。
