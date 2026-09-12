@CLAUDE.md

# 项目名称
sunshinex

# 架构原则
- 三层嵌套：Graph 编排层可嵌入 Loop 子流程，均运行于 Harness 底座之上
- 云端推理，本地编排/执行/安全/记忆
- 插件与技能通过目录约定加载，MCP 协议接入第三方工具

# 编码规范
- 使用 TypeScript，开启 strict 模式
- 模块按 harness / loop / graph / model / storage / plugins 分层
- 写操作前先评估影响面，改动后自检
