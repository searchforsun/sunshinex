# 1C 内嵌路由设计：算力档位收敛进 Loop 决策

> 日期：2026-09-05
> 状态：已实施交付（2026-09-05 端到端验收通过：提交链 93fe719 → 9384497；A5 无游离路由经 grep 复核；R4 真实模型档位自报弱为已知边界，scripted 全绿）
> 关联：docs/superpowers/specs/2026-09-04-harness-unified-spine-design.md（统一主链总纲，本阶段对应验收 A5）、docs/superpowers/specs/2026-09-04-harness-spine-1b-depth-design.md（1B 补深度，本阶段档位信号消费其 estimate 产物）
> 执行方式：subagent-driven 逐任务实施（沿用 1A/1B 流程）
> 折叠（D83 批一，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 总纲 A5「无游离路由」收敛交付：ModelRouter 内嵌为 Reactor 内部协作件，生产代码唯一消费方是 Reactor（grep 复核），Harness 外无独立调用路径。
- 档位决策语义：每轮 think 前确定本轮服务档位——模型回复中的合法档位字段作为下一轮一次性偏好优先，无声明时由循环内复杂度信号兜底（上下文占比超阈值升档、开局轻载降档、其余中档），每步实际档位随 StepRecord 可观测、prompt 含档位提示行。
- 关键取舍：档位未绑定时回退默认 adapter 不抛错（仅默认绑定时与 1B 行为等价，「现有用例零改动全绿」为实施红线）；档位提示只进请求串、不进上下文管线，不扰动 1B 压缩 checksum 基线。
- 范围边界：不做真实多模型配置/绑定 DSL（装配方注入即可）、不做执行后端抽象（归 1D）、不做算力成本计量、不改 1B 压缩稳定性语义；graph 层多角色档位策略不在本阶段。

## 现行真值

CLAUDE.md §3 目录结构（model/ router.ts、catalog.ts ModelSwitcher 现行落位）、§11 前缀缓存（用户级会话参数 tier 经 ModelSwitcher 整场恒定或显式切换、模型无自调通道——现行语义已自 1C 的模型自报偏好形态演进）。
