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
