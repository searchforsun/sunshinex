# 原生 function calling 迁移设计（工具调用协议硬切换）

- 日期：2026-09-20
- 状态：已实施交付（2026-11-23 D83 批二状态回写核证：CLAUDE.md §6「工具参数声明化（function calling strict 口径）」；src/model/adapter.ts tool_calls 流式聚合在座且 §9 删除清单已执行（action-schema.ts/stream-extractor.ts 不存在、structuredOutput 退役 RETIRED_KEYS）；原状态行留档：「- 状态：设计要点经用户三裁决批准（硬切换 / 工具清单迁移 / 独立调用全迁），本规格为批准口径的完整化；实施未开始」）
- 探针证据：`/workspace/probe-so.js`（json_schema strict 可行性）、`/workspace/probe-fc.js`（function calling 能力矩阵）；端点 open.bigmodel.cn · glm-5.3-flash，2026-09-20 实测
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 文本信封协议整体退役、硬切换端点原生 function calling（用户三裁决：硬切换/工具清单迁移/独立调用全迁）：不支持 tools 的端点明示报错、无任何降级档——同一根因缺陷史（并行数组/顶层数组/plain 态灌正文）由端点侧强制约束根治，双协议并存正是要消灭的缺陷载体；strict 探针实证 json_schema 强制路线不可行，约束唯一可靠位置在端点侧。
- 链为唯一事实源不变：消息数组是 buildMessages 纯函数派生视图，journal/压缩/fork 三线语义零迁移平移；每步工具调用增记动作行（完整入参）保消息配对，观察行维持截断口径（两者正交，链增长由既有压缩承载）。
- 工具清单迁 API tools 字段、提示词摘除文本清单（请求级字段零提示词占用，装配期冻结不变）；工具参数 JSON Schema 声明化（按 strict 口径书写，确属自由入参显式登记宽松点，不为佯装严格扭曲表达），MCP inputSchema 直映射。
- 独立小调用全部函数化：loop 判据/压缩摘要/记忆提取/learned 提炼改结构化提交函数，判据三值协议从文本约定变类型约束，消灭「判据输出不可解析」缺陷面；各回退语义不变。
- 删除清单执行：parse 归一层、信封协议段、stream-extractor、structuredOutput 配置键整体退役（RETIRED_KEYS 定向提示、启动不失败）；phase/reply 改来源于 tool_calls 同轮 content 与收束轮 content。
- 前缀缓存对账：system#1 恒冻结、system#2 快照刷新、消息只尾追——三段式不变量逐条平移无新增动态面；相邻步前缀稳定与 fork 首帧严格前缀用例在消息形态下重建。

## 现行真值

现行工具调用协议口径见 CLAUDE.md §5 编码规范（工具参数声明化 strict 口径）、§11 前缀缓存（消息形态三段式不变量）、MANUAL.md 二、配置（OpenAI 协议兼容端点要求）。
