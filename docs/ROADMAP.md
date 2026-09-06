# SunshineX 开发路线图（Roadmap）

> 本文档从全局视角规划 SunshineX 从骨架到 v1.0 的完整落地路径，共 6 个阶段、28 周。
> 依据：《SunshineX 通用 AI Agent 项目工程化设计方案》（docs/Arch-Plan.md）与《统一运行时主链设计》（docs/superpowers/specs/2026-09-04-harness-unified-spine-design.md）。
> 每个阶段以「可交付 + 可自检」为验收原则，阶段未通过自检不得进入下一阶段。

## 1. 总览

- **总目标**：交付 v1.0 个人开发者版（CLI + Electron 桌面端），完整落地 Harness / Loop / Graph 三层范式。
- **总周期**：28 周，6 个阶段。
- **交付形态**：CLI 全局包 + 桌面端安装包（Windows / macOS / Linux）。
- **核心原则**：按层迭代，先 Harness → Loop → Graph，再生态与 GUI，最后测试发布。

## 2. 里程碑总览

| 阶段 | 周期 | 主题 | 核心交付物 |
|------|------|------|-----------|
| 一 | 第 1-6 周 | Harness 底座核心 | 可运行底座 + 项目感知 + 安全沙箱 + 基础工具集 |
| 二 | 第 7-12 周 | Loop Engine 与模板 | Loop 引擎 + 三大场景模板 + CLI 可执行 |
| 三 | 第 13-18 周 | Graph 编排层 | DAG 引擎 + 多角色协作 + 全链路流水线模板 |
| 四 | 第 19-22 周 | MCP 生态与全场景 | MCP 兼容 + 技能系统 + 向量知识库 |
| 五 | 第 23-26 周 | GUI 桌面端 | 桌面端 + 双端数据同步 |
| 六 | 第 27-28 周 | 测试优化与发布 | v1.0 正式版 + 完整文档 + 安装包 |

## 3. 阶段推进与依赖

```mermaid
flowchart TB
  P1["阶段一 Harness 底座<br/>第 1-6 周"] --> P2["阶段二 Loop Engine<br/>第 7-12 周"]
  P1 --> P3["阶段三 Graph 编排<br/>第 13-18 周"]
  P2 --> P3
  P2 --> P4["阶段四 MCP 生态<br/>第 19-22 周"]
  P3 --> P4
  P4 --> P5["阶段五 GUI 桌面端<br/>第 23-26 周"]
  P5 --> P6["阶段六 测试与发布<br/>第 27-28 周"]
```

> 关键依赖：Graph 编排层（阶段三）同时依赖 Harness 底座（阶段一）与 Loop 引擎（阶段二）；MCP 生态（阶段四）依赖 Loop 与 Graph 双线收敛。

## 4. 各阶段详细规划

### 阶段一：Harness 底座核心（第 1-6 周）

**目标**：搭建生产级 Harness 底座，落地项目感知、工具、安全、记忆四大基础能力。

- [x] 项目初始化与工程化规范
- [x] 三级 KV 缓存与上下文管理
- [x] 统一工具框架与内置基础工具集
- [x] 项目深度感知引擎：目录扫描、依赖解析、SUNSHINE.md 配置、Git 读取
- [x] 三级持久化记忆体系
- [x] 分级沙箱与权限管控
- [x] dry-run 预览机制
- [x] 模型适配层与三档算力路由

**交付物**：可运行 Harness 底座、项目感知能力、安全沙箱、基础工具集。
**验收**：`npm run build` + `npm run selfcheck` 通过，四大能力可实例化。

### 阶段二：Loop Engine 与专用模板（第 7-12 周）

**目标**：落地完整 Loop Engine，实现三大专用 Loop 与自我验证机制。

- [x] Loop 核心执行引擎：节点调度、流转控制、状态管理
- [x] 四类核心节点：Agent、Check、Gate、Router
- [x] `/goal` 自我验证机制（规则校验器优先 + 模型判据兜底 + deficit 定向修正）
- [x] 三大专用 Loop 模板：代码重构、测试闭环、代码审查
- [x] 终止控制与成本管控模块（四重终止保护，超支 pause 不伪造完成）
- [ ] CLI 专项命令接入

**交付物**：完整可用 Loop Engine、三大专用场景模板、CLI 可执行。
**验收**：Loop 闭环跑通「生成→校验→修正→终止」，三大模板各可端到端演示。

### 阶段三：Graph 编排层（第 13-18 周）

**目标**：实现 DAG 工作流编排、多角色 Agent 协作、全链路流水线。

- [ ] DAG 工作流核心引擎：节点调度、依赖解析、并发控制
- [ ] 四种流程模式：串行、并行、分支、汇合
- [ ] 多角色子 Agent：规划师、开发者、测试工程师、审查员
- [ ] 软件工程全链路流水线模板
- [ ] CI/CD 集成节点
- [ ] 人工审批节点与错误局部化
- [ ] 工作流模板体系

**交付物**：Graph 编排引擎、多角色协作、全链路流水线模板。
**验收**：DAG 环检测生效，多角色协作流水线可编排执行，Loop 子流程可嵌入 Graph 节点。

### 阶段四：MCP 生态与全场景能力（第 19-22 周）

**目标**：兼容 MCP 协议，完善全场景业务能力，优化体验。

- [ ] MCP 协议兼容，支持第三方工具接入
- [ ] 补充内置工具集，覆盖开发全场景
- [ ] 优化模型路由与缓存策略
- [ ] 本地向量知识库增强
- [ ] 技能模板体系完善

**交付物**：MCP 兼容、全场景基础能力、技能系统。
**验收**：标准 MCP 工具可注册并调用，技能模板可被 Harness 统一调度。

### 阶段五：GUI 桌面端（第 23-26 周）

**目标**：完成 Electron 桌面端，实现可视化交互。

- [ ] 对话交互、代码预览、diff 对比
- [ ] 工作流可视化编排与实时监控
- [ ] 项目记忆管理、技能管理、插件管理
- [ ] 双端数据同步：配置、任务、记忆、日志
- [ ] 系统托盘、全局快捷键、消息通知

**交付物**：完整功能桌面端、双端数据互通。
**验收**：CLI 与 GUI 双端共享同一数据底座，核心功能可视化可用。

### 阶段六：测试优化与发布（第 27-28 周）

**目标**：全量测试、性能优化、打包发布。

- [ ] 全功能单元测试、集成测试、安全测试
- [ ] 性能优化：缓存命中率、响应速度、内存占用
- [ ] 跨平台打包：Win/Mac/Linux 安装包、CLI 全局包
- [ ] 完善文档：开发文档、使用文档、插件开发手册

**交付物**：v1.0 正式版本、完整文档、安装包。
**验收**：全量测试通过，三平台安装包可安装运行。

## 5. 当前进度

阶段一（Harness 底座核心）已全部完成：

- [x] 工程骨架（package.json / tsconfig / .gitignore）
- [x] 项目规范（CLAUDE.md / SUNSHINE.md）
- [x] 核心类型与配置解析器（src/types.ts / src/config.ts）
- [x] Harness 底座（perception / reactor / tools / security / context / memory / skills）
- [x] Loop / Graph / Model / Storage / Plugins 模块占位
- [x] 示例技能与插件（skills/example-skill、plugins/demo）
- [x] 骨架自检（`npm run selfcheck` 通过）
- [x] 阶段一其余任务（三级 KV 缓存、项目深度感知引擎、沙箱与 dry-run 等）
- [x] 模型 SDK 接入 DeepSeek 兼容 OpenAI 协议（`.env` 配置，零新增依赖）

当前基线：`npm run build`（tsc strict）零报错、40 个测试全绿、`npm run selfcheck` 通过。统一运行时主链设计已定稿（`docs/superpowers/specs/2026-09-04-harness-unified-spine-design.md`），按「串主链 → 补深度 → 内嵌路由 → 多后端 → 记忆沉淀」五个阶段（A-E）推进，待拆实施计划。

## 6. 验证策略

| 阶段 | 验证方式 |
|------|---------|
| 一 | `npm run build` + `npm run selfcheck` 零报错 |
| 二起 | 每个 Loop / Graph 模块补充单测，CI 跑通 |
| 六 | 全量单测 / 集成 / 安全测试 + 三平台打包 |

- 每阶段结束必须 `npm run build`（tsc 严格模式零报错）+ `npm run selfcheck` 输出正确。
- 涉及加载 / 解析逻辑时补充示例物料并确保自检覆盖。

## 7. 与目标目录架构的映射

当前骨架 → README 目标目录（阶段推进中逐步对齐）：

| 目标目录 | 当前状态 | 对应阶段 |
|---------|---------|---------|
| `src/agent/harness/` | 已建 `src/harness/`（skills/memory/tools） | 阶段一 |
| `src/agent/loop/` | 已建 `src/loop/`（engine + 四类节点 + 三模板，实装） | 阶段二 ✓ |
| `src/agent/graph/` | 已建 `src/graph/`（engine/agents）占位 | 阶段三 |
| `src/model/` | 已建 adapter + 三档路由占位 | 阶段一 |
| `src/storage/` | 已建 store.ts 占位 | 阶段一 |
| `src/plugins/` | 已建 loader.ts | 阶段四 |
| `src/cli/`、`src/gui/`、`src/server/` | 未建 | 阶段二 / 五 |

> 说明：骨架目录与 README 目标目录存在命名差异（如 `src/harness` vs `src/agent/harness`），随各阶段开发逐步迁移对齐。
