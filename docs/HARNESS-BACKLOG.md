# Harness 五要素评估与待优化项（HARNESS-BACKLOG）

> 2026-09-19 按「工具 / 上下文（记忆）/ 门禁（安全）/ 评测（优化）/ 容错（恢复）」五要素框架完成的一次实盘评估：代码现状逐项核验 + 业界最佳实践对标，结论沉淀为本文待优化项清单。
> 评估基线 HEAD `9623a4e`（工作区另含全局配置线未提交改动，不影响本文结论）。待优化项落地后在同轮提交中翻转状态并补提交号；本文只记评估结论与债项，不承载处理规则（技术债处理规则另见 `docs/TECH-DEBT.md`）。

## 一、评估口径与信源

- 代码证据全部取自本仓实盘核验（文件与行为级），引用行号以基线 HEAD 为准。
- 业界信源，前三份原文已核读，第四份 PDF 在沙箱不可解析、仅登记不作为对照依据：

| 信源 | 对标要点 |
|---|---|
| Anthropic《Building Effective Agents》（2024-12） | agent=带环境反馈的循环；工作流五模式（chaining/routing/parallelization/orchestrator-workers/evaluator-optimizer）；ACI 工具工程（防呆、测试模型如何使用工具）；guardrails 与沙盒测试；evals 先行 |
| Manus《Context Engineering for AI Agents》（2025-07） | KV-cache 命中率是生产 agent 第一指标；append-only + 前缀稳定；遮蔽而非移除工具；文件系统作终极上下文；压缩必须可恢复；保留错误在上下文中；todo.md 复述目标对抗 lost-in-the-middle |
| LangChain《Memory for Agents》（2024-10，CoALA 口径） | 记忆分程序性/语义/情景；更新分 hot path 与 background 双通道 |
| OpenAI《A practical guide to building agents》 | PDF 未能解析，未核读原文，不作为对照依据 |

## 二、五要素总览

| 要素 | 完成度 | 结论 |
|---|---|---|
| ① 工具 | ★★★★☆ | 统一执行面 + ACI 意识领先；缺「模型如何使用工具」的质量评估闭环（O6） |
| ② 上下文（记忆） | ★★★★★ | 全链最强项：KV-cache 三段式比 Manus 文章所述更体系化；缺 recitation（O4） |
| ③ 门禁（安全） | ★★★★☆ | 分层完整；网络工具带超时+下载量护栏；进程内沙箱非 OS 级隔离（O7 登记取舍） |
| ④ 评测（优化） | ★★★☆☆ | 结构性短板：观测面与护栏在，任务级质量评估为零（O3/O5） |
| ⑤ 容错（恢复） | ★★★★☆ | fail-bounded + 诚实终态达业界水准；主链模型调用带瞬时错自动重试 |

## 三、逐要素评估

### ① 工具

**已完成 / 做得好**

- `ToolRegistry` 统一执行面：工具只声明不执行、安全链执行期注入；`derive()` 提供 fork 子集面（子代理工具面剔除 spawn 防递归派生）。23 项内置工具 + MCP 官方 SDK 三传输（stdio/http/sse）+ 握手身份校验，均有测试。
- ACI 工程对标 Anthropic「在 SWE-bench 上花在优化工具上的时间多于整体提示词」：read 工具 `L100-125` 行段读取（越界钳制、非法形态报 `INVALID_ARG` 防呆而非模糊失败）；exec 溢出截断 + 全量落盘回显路径；结构化输出 action-schema 信封与提示词协议段逐行同源；工具清单按名排序进稳定段。

**待优化**

- 无「模型实际如何使用工具」的误用观测与数据回流（Anthropic：test how the model uses your tools）——依赖 O3 基准集承载。

### ② 上下文（记忆）

**已完成 / 做得好**

- 前缀缓存第一要义（CLAUDE.md §11）三段式：会话开始装载冻结快照 → 运行中一律尾追 → 轮次起点主动探测（`checkConstantsDrift` + confirmPlan 即时探测）。Manus 三条缓存实践逐条覆盖且更体系化（过期/冲突补丁行语义、四刷新点收敛、动态面全仓审计）；探针实证 41.1% → 97.9%。
- 记忆双轨对齐 CoALA/LangGraph：learned 技能=程序性、auto memory=陈述性（提取挂 settle 单点、五重准入闸门、`/memory` 命令族），均已落地；异步管线与 memory_write 主通道为已定稿设计（9623a4e）待实施。
- 压缩可恢复（Manus 原则）：模型驱动六要素摘要 + 失败回退确定性 + Full trace 归档留指针；不可再生事实保具体弃叙事（d919e07）。保留错误在上下文中（Manus 原则）实现一致。

**待优化**

- Recitation 缺失（O4）：Manus 以 todo.md 复述把全局目标推进模型近期注意力，对抗长循环（其任务平均 50 次工具调用）的 lost-in-the-middle；本项目仅 /goal 判据每轮评估部分覆盖，普通任务长循环无目标重申机制。可做成合法尾追行，零前缀击穿。

### ③ 门禁（安全）

**已完成 / 做得好**

- `SafetyChain` 单点：guard 守门 → realpathSync 路径边界（符号链接解析）→ 后端执行 + 6 类凭据出口掩码。
- `PolicyEngine` 三态 deny→ask→allow 首匹配；manual/plan/dontAsk 三模式；破坏性命令清单（dd/fdisk/关机族、`curl|sh` 管道下载执行）任何模式不可豁免。
- `ProcessSandbox` 平台 shell 解析单点（SUNSHINEX_SHELL → Git Bash → PowerShell → ComSpec → POSIX sh）；dry-run 预览；数据目录窄口（Write 仅 `memory/**` 放行）；spawn 免审批但子调用逐个过安全链；MCP 握手身份校验。

**待优化 / 登记取舍**

- 进程内沙箱非 OS 级隔离：与主进程同权限域。dockerode 容器执行已在 GUI 可选增强登记（O7，保持登记不动）。
- 并行「生成/筛查分离」guardrail（Anthropic 模式：独立模型实例审内容）不做：单机通用 agent 属过度设计（O8，登记不做）。

### ④ 评测（优化）

**已完成 / 做得好**

- `RunLedger` per-run 账本（steps/tokens/durationMs/route 落盘）。
- 宽预算长任务缺省（Reactor 400 步、修正环 200 轮/2M tokens/24h、命令 1800s/32MB）+ `guardrailStop` 纯函数终止检查（超时→预算→迭代）。
- 状态栏 cache/ctx/turns/steps 观测面（会话累计口径）；端点探针脚本（probe-usage-frames / probe-context-usage）；工程门禁 tsc strict + 全量测试 + selfcheck。

**待优化**

- 任务级质量评估为零（O3）：无固定任务库、无完成率/人工干预次数量化——五要素唯一「方向已定、决策载体已有（GOAL.md/ROADMAP）、从 0 未动工」的短板。
- `ledger.summary()` 每次全量重读索引逐 id 读文件，O(n) 随 run 数线性劣化（O5，量小不急）。

### ⑤ 容错（恢复）

**已完成 / 做得好**

- 错误双通道分域（Result 显式失败 vs 引擎节点边界 catch，CLAUDE.md §4）。
- 判据错误分级 `classifyJudgeError`（fatal 401/402/403/quota/model not found 不重试→failed-with-reason；recoverable 超时/断连/5xx 重试 ≤3 → paused 显式续走，nodes.ts:39）+ impossible 三值终局防空转。
- 模型超时 600s AbortController；FileStore 双防线（读侧空/撕裂 JSON 回退自愈 + 写侧临时文件 rename 原子替换）；会话日志 JSONL 尾行撕裂重放到上一条完整事件；子代理失败隔离（捕获 → 补丁行 → 父模型决策）；stopReason 显式化、paused 不伪造完成。

**待优化**


## 四、待优化项清单

| 编号 | 优先级 | 事项 | 归属 | 说明与依据 | 状态 |
|---|---|---|---|---|---|
| O1 | P1 | webfetch 加超时 + 下载量上限 | ③⑤ | builtin.ts:151 裸 fetch 无 AbortSignal，res.text() 先全量读入再截断；业界基线：网络调用必带超时；修复一行级 | closed（2026-10-24：AbortSignal 超时 30s〔SUNSHINEX_WEBFETCH_TIMEOUT_MS 旋钮〕+ 2MB 流式截断 readBodyCapped 连接早断；测试 2 例〔慢端点超时/3MB 端点早断〕） |
| O2 | P1 | 模型调用自动重试（指数退避，仅 recoverable 类） | ⑤ | 主链 model-error 直终局 vs 判据侧 MAX_JUDGE_RETRIES=3 先例；收 adapter.ts 单点，长任务抗端点抖动 | closed（2026-10-24：doFetch 单点重试——瞬时网络错/5xx/429 退避 3 次上限〔retryDelayMs cfg 旋钮〕；fatal 4xx/本端硬顶超时/外部中断不重试；测试 3 例含判别力锚） |
| O3 | P1 | 长任务基准集最小版（3–5 个固定任务 + 完成率/人工干预次数脚本化） | ④ | 决策载体已有：GOAL.md L31、ROADMAP L23/L130；五要素唯一结构性短板，从 0 未动工 | closed（2026-10-24：5 固定任务库 src/eval/tasks.ts〔脚本验盘权威〕+ scripts/eval-run.mjs 手动门 + 干预双计数〔guard ask 决策/ask_question 调用〕；wiring 门禁进 pnpm test；glm-5.3-flash 首轮真跑 5/5≈29.4 万 tokens；首轮即抓出答案键错一例——模型算对 total_ms=2834 而初版判据写死 1234,验盘修后复跑绿） |
| O4 | P2 | Recitation：长循环周期性 goal 重申行（尾追承载） | ② | Manus todo.md 对标；零前缀击穿；先小实验验证收益再定形态 | open |
| O5 | P2 | ledger.summary() 增量化 | ④ | 逐 id 全量重读 O(n)；随基准集批次顺手做 | closed（2026-10-24：runs/_summary 缓存档 record 增量维护、summary 单读 O(1)；校验面=索引长度,旧档无缓存/半写一次性重算回填自愈；测试 2 例〔零 run 文件读取判别力锚/迁移+自愈〕） |
| O6 | P3 | 工具误用观测（模型用错工具的数据回流） | ①④ | Anthropic ACI 测试建议；依赖 O3 先落地——O3 已落地（干预双计数/步数/token 观测点在座,run 结果 JSON 可消费） | open |
| O7 | 登记 | OS 级沙箱（dockerode 容器执行） | ③ | 已在 GUI 可选增强登记，本机个人工具形态下保持登记不动 | 登记 |
| O8 | 登记 | 并行生成/筛查分离 guardrail | ③ | Anthropic 模式；单机通用 agent 属过度设计，不做 | 不做 |

## 五、信源

- Anthropic, *Building Effective Agents*: <https://www.anthropic.com/engineering/building-effective-agents>
- Manus, *Context Engineering for AI Agents: Lessons from Building Manus*: <https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus>
- LangChain, *Memory for Agents*: <https://blog.langchain.dev/memory-for-agents/>
