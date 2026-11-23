# 第一阶段设计：Harness 底座核心

> 日期：2026-09-03
> 状态：已实施交付（2026-09-05 端到端验收通过：基础闭环提交链 7ab5584→c095dcc；后续按统一主线路线 1A-1E 与安全/预算深化，见各子阶段 spec/plan 回写；真实场景验证报告 docs/superpowers/reports/2026-09-05-phase1-real-scenario-report.md）
> 关联：docs/ROADMAP.md 阶段一、README.md 第五章
> 折叠（D83 批一，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 交付 Harness 底座最小可运行闭环：项目感知（目录/依赖/SUNSHINE.md/Git）、统一工具框架（注册表 + read/write/grep/exec/glob 内置工具）、三态安全规则（allow/ask/deny + PreToolUse 决策点 + 沙箱 + dry-run）、上下文与记忆管理（分层指令 + 自动记忆 + 上下文窗口），四大能力经唯一 Harness 门面对外聚合，上层只依赖门面。
- 落地最小 Reactor（observe→think→act→observe）作为阶段一验收载体，并与阶段二 Loop Engine 划清边界：只做最薄线性循环 + maxSteps/预算保底，不做节点调度与四重终止。
- 关键取舍「混合可插拔」：核心零新增 npm 依赖（仅 Node 内置模块），存储/沙箱/模型走 adapter 接口、预留 SQLite/Docker/MCP 挂载点；模型调用以内置 fetch 直连 OpenAI 兼容 API，无 key/无网络按 Scripted→Stub 降级链兜底、不阻断自检。
- 安全原则：权限由运行时强制、不由模型决定——SUNSHINE.md 是上下文（引导行为），SecurityGuard 才是强制（enforcement）；所有工具统一经 preToolUse→沙箱→dry-run 链，安全与预览能力对全部工具生效。
- 上下文与记忆吸收 Claude Code 成熟设计：指令是上下文不是强约束、记忆「索引+主题文件」分离、path-scoped 规则按需加载、窗口近限自动压缩；压缩稳定性机制（分块确定性、摘要可重现、checksum 校验）阶段一即验收，真实 LLM 摘要以「截断+结构化」近似、留待阶段二接入。
- 验收门槛：tsc strict 构建零报错、node --test 全绿、selfcheck 覆盖四大能力实例化与一次端到端工具调用、危险命令被拦截返回结构化错误、reactor.run 端到端闭环（真实推理或 scripted 驱动）。

## 现行真值

CLAUDE.md §3 目录结构（src/harness/ 各模块现行落位）、§4 架构约定（graph→loop→harness→model/storage 分层依赖）、§5 编码规范（strict、IO 集中 adapter/store、测试与 selfcheck）。
