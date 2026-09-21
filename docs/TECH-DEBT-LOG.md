# 技术债清理台账（TECH-DEBT-LOG）

> 本文件记录**历次清理的执行内容**与**未偿债项登记（待办债项区）**，处理规则见 `docs/TECH-DEBT.md`。每次清理收尾时在此追加一行，该行的「清理后 HEAD」即为下一次清理的默认基线。

## 记录格式

| 日期 | 基线 | 清理后 HEAD | 账本 | 范围与结果 |
|---|---|---|---|---|

- **基线**：本次清理所用的起点 commit（首次可为「含本账的提交」）。
- **范围与结果**：动了哪些文件/类别、残留复查结论、验证方式与结论（如 selfcheck + 单测全绿）。

## 台账

| 日期 | 基线 | 清理后 HEAD | 账本 | 范围与结果 |
|---|---|---|---|---|
| 2026-09-08 | 含本账的首次提交 | 同左（改动随该提交入库） | 记录债 | 全仓去厂商化：`.env.example` 示例值、README 两处表述、probe 脚本注释与日志 ×4、测试夹具键名（DEEPSEEK→TEST）；`docs/superpowers/` 历史存档按规则保留。残留 grep 归零；selfcheck exit 0，单测 165/165 通过 |
| 2026-09-08 | 8b11e60 | d457809 | 记录债 E/B + 代码债 G | 全仓技术债审计后按双账本当轮清轻债：CLAUDE.md §3 目录树同步实况（E）、§2 补 pnpm test/cli、§7 忽略清单补 .longtask/（B）；删零引用死文件 storage/store.ts、types.ts 死枚举收敛（LoopResult.retry 零产出移除、ToolCategory.network 降注释预留，engine.test 桩值同步）（G·轻）。验证：build 零错、165/165 全绿。遗留中级别债（登记待后续批次）：装配根 buildDeps 上移出 cli 层、错误模型契约统一（Result vs catch-reply）、感知跳过集与 .gitignore 单源化、解析类纯逻辑直接单测（config/agents/skills/loader）、真实模型 e2e 资产化 |
| 2026-09-08 | c656a05 | f14facf（台账行随紧随提交入库） | 记录债 B + 代码债 J·中/补充 | 三批次偿还 D1-D4：装配根上移 src/runtime.ts（e299a66）；SCAN_SKIP_DIRS 单源化+绑定测试锚点+补 .superpowers 漂移（0fc4283）；错误通道分域契约与装配根条款入规 CLAUDE.md §4、过期占位句移除（f14facf）；解析器单测 config/skills/plugins/agents 四件套 +9 用例、loader 非法 JSON 降级（f14facf）。过程与治理：批次3 首入库带 4 红测（链式命令未设门禁），根因为测试侧断言语义与夹具路径错误（实现无罪），修正后 amend 并确立 fail 0 硬门禁；54 个 root 属主源文件删除重建归位 sandbox（内容零变更），修复沙箱 EACCES 写入受限。验证：build 零错、175/175 全绿。待办债项区 D1-D4 翻 closed，D5 维持 deferred |
| 2026-09-09 | d457809 | 4f09461（台账行随紧随提交入库） | 记录债 | 增量判定 d457809..HEAD（阶段四知识库/MCP/技能沉淀/成本账本批次，81 文件）后当轮清账本一 5 项：`.env.example` 补 KB_BACKEND/KB_DATA_DIR/EMBEDDING_* 注释示例并标注 OPENAI_* 逐键回退语义（A）；CLAUDE.md §5 MCP SDK 边界句更新为 stdio/streamable http/sse 三传输（B/F）；§3 目录树补 ledger.ts 与 skills/learned.ts（E）；README 架构树同步实况（补 runtime.ts/mcp/knowledge/ledger/learned、删悬空 memory.ts、builtin 清单补 webfetch/kb_search）（B/E）；ROADMAP 进度行去厂商化「DeepSeek 兼容」→「OpenAI 协议兼容供应商」（F）。账本二增量复查无新增实债（G–K 全类无；chunk.ts 导出常量属配置面声明、mock-mcp 双脚本协议帧重复属测试物料独立运行设计，均留证不动刀）；遗留 D5 维持 deferred。残留 grep 复查：活文档「未启用」/悬空 memory.ts/厂商键名均归零。验证：build 零错、selfcheck OK（含 learned/usage 行）、299/299 全绿 |
| 2026-09-19 | 4f09461 | 1b2b384（台账行随紧随提交入库） | 记录债 B/E/F + 代码债 G/I/J/L | 增量判定 4f09461..HEAD（308 文件 +43806/−1719）分账本结论：账本一零漂移（CLAUDE.md/README/TUI-MANUAL 结构与配置面已随各特性线同步，settings.json 示例与解析器实况一致）；账本二增量扫描 as any/注释掉的代码零命中，TODO×2 属测试物料字面量，console.log 均在 CLI 输出面合法。待办债项 D6–D15 全数收口：D6 model-error 的 done 帧不再以 assistant 终答重复入档+对照用例；D7 UsageAdapter 正量夹具使 tokenCap 分支可达（换回忽略 usage 的实现必红）；D8 GraphRunResult.stopReason 契约注释钉死（undefined=非护栏越限）；D9 评估定案维持规划段无独立上限（各步骤 Reactor 缺省 200 步承载、plan.test 钉子锁定该口径）；D10 PLAN_TASK_LABEL 导出常量+reportIncomplete 收敛三处「note+非空即推」重复；D11 describeIncomplete 显式全覆盖+never 编译期守卫+未知值兜底文案；D12 六处跨行重复 import 与 graph 测试冗余 as cast 清零；D13 UsageAdapter.calls 补消费断言+graph 角色 tokenCap 对称覆盖（runtime.test 旧「步数 200」耦合断言已随 tier 批次重写消失）；D14 复核定案维持原位（无跨层直接消费，移入 types.ts 反抬层级）；D15 本表两行历史误落行归位（本次执行）。验证：tsc strict 零报错、全量 955/955（fail 0、skipped 0）、selfcheck OK（skills 26/learned 24）。改动集已随 1b2b384 入库（并发 TUI 显示线 10 文件随批注明）、台账行随 3db1bbb 回填；已推送 origin/dev1（本地与远程同步 0/0），工作区干净 |

## 待办债项

> 未偿债项在此逐条登记（编号/账本/状态/描述/证据/偿还动作/登记来源）；偿还后在同轮提交中翻转状态并补「关联提交」。本区与上方清理记录互不掺杂。

**当前无未偿债项**（2026-09-19 清理批次收口：D1–D4、D6–D15 已偿清归档；D5 转长期挂起登记，不属活动待办）。新增债项按下表格式登记。

| 编号 | 账本 | 状态 | 描述 | 证据 | 偿还动作 | 登记来源 |
|---|---|---|---|---|---|---|

### 归档（D1–D15）

| 编号 | 终态 | 关联提交 | 摘要 |
|---|---|---|---|
| D1 | closed | e299a66 | 装配根 buildDeps 上移 src/runtime.ts 作唯一 composition root，CLI 层仅参数解析 |
| D2 | closed | 0fc4283 | 感知 SCAN_SKIP_DIRS 单源化 + 绑定测试锚点 + 补 .superpowers |
| D3 | closed | f14facf | 错误通道分域契约入规 CLAUDE.md §4（实现收敛按登记原文另批） |
| D4 | closed | f14facf | 解析器单测五件套（config/agents/skills/plugins-loader/cli parseArgs）+9 用例 |
| D5 | deferred（长期挂起） | —（需真实 key 单独批次，不进门禁） | 真实模型 e2e 未资产化；有真实 key 时以 scripts/e2e-real 手动门另启 |
| D6 | closed | 1b2b384 | model-error 的 done 帧不再以 assistant 终答重复入档 + 对照用例 |
| D7 | closed | 1b2b384 | UsageAdapter 正量夹具使 tokenCap 分支可达（换回忽略 usage 旧实现必红） |
| D8 | closed | 1b2b384 | stopReason 契约钉进类型层（护栏类终止必带原因、undefined=非护栏越限） |
| D9 | closed | 1b2b384 | 评估定案维持规划段无独立上限（各步骤 Reactor 缺省 200 步承载、plan.test 钉子锁定） |
| D10 | closed | 1b2b384 | PLAN_TASK_LABEL 导出常量 + reportIncomplete 收敛三处「note+非空即推」重复 |
| D11 | closed | 1b2b384 | describeIncomplete 显式全覆盖 + never 编译期守卫 + 未知值兜底不静默 |
| D12 | closed | 1b2b384 | 六处跨行重复 import 合并 + graph 测试冗余 as cast 摘除 |
| D13 | closed | 1b2b384 | UsageAdapter.calls 补消费断言 + graph 角色 tokenCap 对称覆盖 |
| D14 | closed | 1b2b384 | 复核定案维持原位（无跨层直接消费，移入 types.ts 反抬层级） |
| D15 | closed | 1b2b384 | 台账两行历史误落行归位 + 「本区之后」注记摘除 |

## 已知取舍与教训登记（迁自规范文档）

> 规范与文档正文只保留正向规则；历史教训、接受性取舍与选型注记迁入本节集中登记，供追溯与后续立项，不占用模型上下文注意力。

| 编号 | 类别 | 内容 | 迁出来源 |
|---|---|---|---|
| T1 | 历史教训 | 文本信封协议：靠提示词约束模型输出分布属开集、补丁修不完，退役改原生 function calling（核心契约零兼容） | CLAUDE.md §5/§11 |
| T2 | 历史教训 | memory 每步双写曾把相邻步前缀命中率压至 41.1% → 记忆段整体退出提示词（链即记忆） | CLAUDE.md §11 |
| T3 | 历史教训 | 手写 `startsWith(root + path.sep)` 判界：只归一一侧即前缀恒失配、静默全拒（裁决记录见 `memory/paths.ts` 头注）→ 一律走 `isWithin` | CLAUDE.md §14 |
| T4 | 取舍（接受） | Windows 超时不级联子进程树：`killSignal` 只及直接子进程（POSIX `SIGTERM` / Windows `TerminateProcess`），超时后可能残留孤儿进程；主链唯一子进程调用即 `exec` 且多为短命，接受现状；彻底收口（`taskkill /T /F`、Job Object、POSIX 进程组）属跨平台进程管理独立议题，单独立项论证，不做顺手补丁 | CLAUDE.md §14 |
| T5 | 历史教训 | `STATUS_LABEL` / `SLASH_HELP` 模块级常量冻结曾在加载期冻死语言 → `t()` 调用时求值 | CLAUDE.md §15 |
| T6 | 历史教训 | Git for Windows 缺省 `core.autocrlf=true`，缺 `.gitattributes` + `.editorconfig` 时一次提交即可引入整文件 CRLF 重写 → 双管机器强制 | CLAUDE.md §14 |
| T7 | 历史教训 | 测试编入宿主 shell 方言的失效面：Windows 无 Git Bash 时 `ls`/`cat` 不可用、内联 `node -e` 引号被字面量化、断言恒真失去判别力 → 测试命令一律脚本文件或跨 shell 命令承载 | CLAUDE.md §14 |
| T8 | 选型注记 | BrowserView 自 Electron 30 起弃用 → GUI 内嵌浏览器采用 WebContentsView | CLAUDE.md §13 |
