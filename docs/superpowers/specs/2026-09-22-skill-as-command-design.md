# 技能即命令——`/<技能id>` 动态命令面设计（CC/Hermes 同款）

- 日期：2026-09-22
- 状态：设计定稿（三项关键裁决经问卷收束：撞名内置优先 / 裸形式仅加载 / 确定性加载）
- 关联：`specs/2026-09-22-skill-command-filterable-design.md`（/skill 选择卡与链尾追先例，本线全量复用其 D2/D3/D4/D9 语义）、CLAUDE.md §6（技能装载）、§11（前缀缓存第一要义）、§15（外观双语/写链恒英文）

## 1. 背景与目标

现技能用户侧唯一入口是 `/skill` 两步式（选择卡浏览 → 选定加载）。对齐业界主路径「技能名即命令、意图内联」：

- Claude Code（官方 Skills 文档一手实证）：*"Claude uses skills when relevant, or you can invoke one directly with /skill-name"*；目录名即命令；bundled skills 是 prompt-based——客户端展开正文+参数替换（`arguments`/`$name`）+动态注入（`` !`cmd` ``），模型拿到成品指令；加载后 *"content stays in context across turns"*。
- Hermes（README CLI 快速参考）：*"/\<skill-name\> — invoke a skill"*；`-s <skill> -q "…"` 启动预载；`/skills` 浏览兜底。

关键结论（业界唯一形态）：**斜杠 token 从不原样转发给模型**，均由客户端确定性展开注入；模型自主加载（按 description 匹配意图）是另一条并行通道。CC 甚至提供 `disable-model-invocation: true` 关掉自主通道只留直调——反证加载确定性靠客户端保证。

本特性线交付：`/\<技能id\>` 动态命令——裸形式仅加载、带意图一步到位；`/skill` 选择卡保留为浏览兜底；学习沉淀运行期即时注册（零持久注册表）。

## 2. 关键裁决

| # | 裁决 | 内容 |
|---|------|------|
| D1 | 撞名 | **内置优先**：与 20 条内置命令词同名的技能不注册为命令，仍可经 `/skill` 卡加载；输入该名即内置命令（分发序内置分支先行拦截，「撞名专用提示」按构造不可达），零新增提示面。**有意偏差登记**：CC 允许本地技能覆盖内置命令（"Your skill replaces the bundled command, but not its aliases"），本线不开放——我方技能含学习沉淀（运行期自动写入、用户未逐个审），静默遮蔽 `/resume` 等核心命令风险不可控；claude.ai 同步技能永不覆盖的同款保守立场 |
| D2 | 命令 token | = 技能 **id**（目录名）。id 含安全字符集 `[a-z0-9-_]` 之外字符者不注册（仍可经卡加载）。frontmatter name（展示名，可含中文/空格）仅用于卡片与 `/help` 展示，不作命令词 |
| D3 | 裸形式 | `/<id>` = **仅加载**：全量复用先例 D2 通道（resolve 后正文 `action='skill'` appendChain 链尾追，头行 `[Skill] <name> (id=<id> v=<version>)`）与 D3 去重（链上同 id 已加载 → 回执零副作用）。回执后模型随任务自判，不追问意图（用户裁决：加载后模型自己判断） |
| D4 | 带意图 | `/<id> <意图>` = **确定性加载 + 意图原样派发**：先走 D3 通道加载（已加载则幂等跳过注入），再以意图文本原样 `runTaskFlow` 走标准环（与 `/goal`/`/plan` 同款解析：`text.slice(cmd.length).trim()`）。一步到位，零额外模型回合 |
| D5 | 守卫 | 运行中一律拒绝（沿既有命令语义）；内置命令严格裸形式守卫（FREE_TEXT_ARGS 白名单）逐字节不动；`/<id> `（纯空格尾参）= 裸形式 |
| D6 | 注册表单点 | 新增 `SessionController.skillCommandIds(): string[]`：`skills.list()` 每次现读磁盘（学习沉淀即时可见、零缓存失效问题）→ 按 D1（内置命令词集合排除）与 D2（字符集过滤）筛选 → id 字典序返回。内置命令词集合以共享单点 `src/tui/slash-commands.ts` 为唯一源（App 重导出保持既有 import 路径，session 自共享模块导入）；session 分发、App 补全、slashHelp 同源消费 |
| D7 | 补全 | `slashCandidates(buffer, extra?: string[])` 增可选参纯函数：缺省等价现行为（既有断言零破坏）；extra 为已过滤技能命令池。App 持有 `skillExtra` 快照、回合边界刷新（不逐键读盘）；Tab 循环池 = 内置在前 + 技能 id 字典序 |
| D8 | /help | `slashHelp()` 调用时求值，内置清单后追加「Skills:」段：`  /<id>` + name + 描述截 128（沿 formatSkillsIndex 口径）、id 字典序；技能池为空不显示该段 |
| D9 | 前缀与语言 | 加载通道全复用先例：链尾追零击穿、链行头恒英文（§15）；上屏回执与提示 t() 双语；不进模型工具清单（模型侧 skill 工具已有同能力，工具清单零新增 → 零前缀断点） |

## 3. 组件与数据流

### 3.1 session.ts

1. `skillCommandIds()`：D6 单点。内置词集合从 `SLASH_COMMANDS` 派生（App.tsx 导入既有导出，session 已 import 同模块——避免第二处命令清单漂移）。
2. `loadSkill(id)`：从现 `skillFlow` 尾段提取的单点（去重扫描 → resolve → appendChain → 回执），`skillFlow` 选择卡选定后改走同一点（行为零变化）。
3. `handleSlash` 分发序：内置严格匹配（守卫如旧）→ 未命中且 token ∈ skillCommandIds() → 裸形式 `loadSkill(id)` / 带意图 `loadSkill(id)` 成功后 `runTaskFlow(意图)` → 未命中：撞名内置的技能 id 给专用提示，其余原文案。
4. slashHelp 追加技能段（D8）。

### 3.2 App.tsx

`SLASH_COMMANDS` 常量与 `slashCandidates` 缺省路径逐字节不动；`slashCandidates` 增 `extra?` 合并过滤；Tab 循环改在合并池上（extra 空时行为等价，既有邻位断言钉死）。

### 3.3 types / 其他

零接口变更、零新依赖、模型工具清单零触碰。

## 4. 错误处理

| 场景 | 行为 |
|------|------|
| 运行中 `/<id>` | warn 回执「当前有任务进行中」，零副作用 |
| 裸形式已加载 | info 回执「本会话已加载」，零重复注入（先例 D3） |
| 带意图已加载 | 不重复注入，直接派任务（幂等，意图不丢） |
| resolve SKILL_PARAM_MISSING | warn 回执列缺失参数名（沿先例 D4），不派任务 |
| resolve SKILL_NOT_FOUND | 理论不可达（token 即来自 list()），warn 防御性保留 |
| 撞名内置 | 内置分支先行拦截、行为照旧（专用提示按构造不可达）；该技能仅可经 `/skill` 卡加载 |
| 非法字符 id / 未注册 | 统一「无法识别命令」原文案（零新增面） |

## 5. 验收矩阵

| # | 断言 |
|---|------|
| A1 | `/<id>` 裸形式：journal 链含 `action='skill'` 条目 + 已加载回执；二次执行回执已加载、链条目数不变 |
| A2 | `/<id> <意图>`：链含技能条目 + 任务以意图原文启动（runTaskFlow 观察面） |
| A3 | `/<id> <意图>` 已加载态：链条目数不变 + 任务照常派发 |
| A4 | 技能 id=内置词（如 resume）：`/resume` 走内置（钉子）；`/skill` 卡中该技能仍可选 |
| A5 | id 含非法字符：不注册，输入统一无法识别 |
| A6 | SKILL_PARAM_MISSING：warn + 不派任务 |
| A7 | 运行中：拒绝回执 |
| A8 | /help：有技能含「Skills:」段；无技能无该段；既有 20 行清单零漂移 |
| A9 | `slashCandidates('/')` === SLASH_COMMANDS（缺省等价钉，既有断言不动） |
| A10 | `slashCandidates('/he', ['/hello-world'])` = ['/help', '/hello-world']（内置在前） |
| A11 | Tab 循环含技能命令；`/new → /resume` 既有邻位断言不变 |

## 6. YAGNI（本轮不做，登记留观）

- 命名空间形式 `/ns:skill`（CC claude.ai 同步技能同款）——撞名已用内置优先收口，无嵌套技能源
- `argument-hint` / `arguments` / `$name` 正文替换（CC 参数展开）
- `` !`cmd` `` 动态上下文注入
- `disable-model-invocation` 等技能级 frontmatter 开关
- `/skills browse` 独立浏览命令（`/skill` 卡即浏览兜底）
