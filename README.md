# SunshineX

通用 AI Agent 工程化骨架：云端大模型负责推理，本地负责编排、执行、安全与记忆。采用 Harness / Loop / Graph 三层嵌套范式，对标 Claude Code / OpenAI Codex / Hermes。

## 当前架构

核心是**统一运行时主链**——五个环节按数据流串联成闭环，单一数据流、无旁路，而非多套实现逻辑拼接：

```mermaid
graph LR
  C[1. Context<br/>统一上下文管线] --> L[2. Loop<br/>决策循环]
  L --> T[3. Tool<br/>统一动作面]
  T --> S[4. Safety<br/>统一安全链]
  S --> T
  T --> L
  L --> M[5. Memory<br/>统一记忆生命周期]
  M --> C
```

```text
src/
  index.ts            # 入口 + --selfcheck 自检
  types.ts            # 全局共享类型
  config.ts           # SUNSHINE.md 解析
  result.ts           # Result 统一结果类型
  harness/            # 运行时底座（核心闭环已落地）
    index.ts          # Harness 门面
    perception.ts     # 项目感知（目录/依赖/SUNSHINE.md/Git）
    reactor.ts        # 最小闭环引擎（observe→think→act）
    tools.ts          # 工具注册表
    tools/builtin.ts  # 内置工具（read/write/grep/glob/exec）
    memory.ts         # 三级记忆（待统一收敛）
    skills.ts         # 技能加载
    security/         # guard/policy/modes/sandbox/dryrun
    context/          # loader/rules/auto-memory/window/session
  loop/engine.ts      # Loop 引擎（占位）
  graph/              # DAG 编排（engine/agents，占位）
  model/adapter.ts    # 模型适配 + 三档算力路由
  storage/            # 本地 JSON 存储底座
  plugins/loader.ts   # 插件加载
```

分层依赖：`graph → loop → harness → model / storage / plugins`。Graph 节点可嵌入 Loop 子流程，二者都运行在 Harness 底座之上。

## 设计亮点

- **统一主链，而非能力拼接**：Claude Code 的指令分层/路径规则、Codex 的算力路由/多执行后端、Hermes 的持久记忆/自我验证，均被拆解为「能力本质」后映射到主链对应环节（Context / Loop / Tool / Safety / Memory），通过统一接口协同。
- **单一数据流、无旁路**：上下文只能从 Context 进、动作只能从 Tool 出、执行必经 Safety、记忆只走 Memory，每条验收可证伪（反例即不合格）。
- **工程纪律**：TypeScript strict、CommonJS、`node --test`、TDD 先行、零新增依赖（安全隔离与凭据处理除外）。
- **生产级底座**：项目感知、权限三态（deny→ask→allow）、dry-run、上下文窗口压缩（分块确定性 + checksum）、模型 SDK 可插拔。

## 最终产品形态（v1.0 个人开发者版）

- **双端入口**：CLI 专项命令（`chat/edit/test/review/doc/run`）+ Electron 桌面端。
- **云本地分工**：DeepSeek 兼容 OpenAI 协议（`.env` 配置）负责推理，本地负责编排、执行、安全、记忆，数据可控。
- **三层能力全落地**：Harness 底座 + Loop 自主迭代（生成→校验→修正→终止）+ Graph 多角色协作编排。
- **生产级特性**：dry-run 预览、分级沙箱、三级持久记忆（技能/项目/用户）、MCP 协议兼容、审计回滚。

## 快速开始

```bash
npm install --cache .npm-cache   # HOME 不可写，需指定缓存目录
npm run build                    # tsc 严格模式编译
npm run selfcheck                # 编译 + 骨架自检
npm run start                    # 运行入口（自动从 .env 加载模型配置）
```

## Quick Start（CLI）

```bash
npm install --cache .npm-cache
npm run build
npm run cli -- selfcheck                                   # 骨架自检
npm run cli -- run tests/fixtures/demo --template test-loop \
  --goal "修正 math.test.js 断言使其通过（验收标准：c1=断言 add(1,2)===3）"   # Loop 修正环
npm run cli -- pipeline tests/fixtures/demo --yes \
  --goal "实现 add 函数并保证测试正确（验收标准：c1=math.test.js 断言 add(1,2)===3）"  # 全链路流水线
```

需配置 `.env`（OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL，DeepSeek 兼容 OpenAI 协议）。

## 文档导航

| 文档 | 内容 |
|------|------|
| `docs/Arch-Plan.md` | 架构设计方案与分阶段规划（原 README 全文） |
| `docs/ROADMAP.md` | 开发路线图（6 阶段、28 周） |
| `docs/superpowers/specs/` | 设计 spec（阶段一底座 + 统一运行时主链） |
| `CLAUDE.md` | AI 协作规范 |
| `SUNSHINE.md` | 项目业务配置 |
