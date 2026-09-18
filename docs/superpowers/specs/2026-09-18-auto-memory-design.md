# Auto Memory 设计规格（情景/状态记忆，与程序性记忆双轨互补）

- 日期：2026-09-18
- 状态：已获用户批准（设计总览「继续」通过），待 writing-plans 转实施计划
- 调研来源：CC 官方 memory 文档（code.claude.com）+ 社区反编译还原课程 shareAI-lab/learn-claude-code s09 + Hermes 官方文档（hermes-agent.nousresearch.com）
- 关联：CLAUDE.md §11 前缀缓存第一要义；context-fork 规格（「链即记忆」裁决、记忆段 41.1% 事故先例）；G 项 SUNSHINE.md 会话冻结快照（四刷新点）；LearnedSkillStore（程序性记忆，本规格不动）

## 1. 定位与双轨边界

用户裁决（2026-09-18）：记忆体系双轨互补、两者都要有。

| 维度 | LearnedSkillStore（既有，本规格零改动） | Auto Memory（本规格） |
|---|---|---|
| 记忆类型 | 程序性：任务形态可复用流程（目标+成功答复模板） | 陈述性：user 偏好 / feedback 纠正 / project 项目事实 / reference 外部参考（CC 四类型同款） |
| 触发面 | 任意任务 done 且有 reply（reactor.ts:303 `done && reply && deps.settle`，非 goal 专属；失败路径有意不沉淀） | 任意任务收尾（提取候选 + 准入闸门） |
| 运行时可见性 | 参与运行时技能清单合并（skills.ts:53-54，用户技能优先、learned 补位） | 索引常驻冻结快照（模型可见）、主题文件按需 read |
| 淘汰 | FIFO 50 删最旧 | 阈值整理：合并去重优先、淘汰兜底 |

提取闸门按内容分流：任务形态教训走 learned、事实/偏好/反馈走 memory——两库互补不重复、互不写入。

## 2. 存储面（M1）

- 目录：`<dataDir>/memory/`（resolveDataDir 派生，与账本/学习技能/归档同域）。
- `MEMORY.md` 索引：一行一条 `- <slug> — <描述> [<type>]`；**由记录文件重建**（记录文件是单一事实源，索引是派生物——与 CC 同款纪律）。
- 记录文件 `<slug>.md`：frontmatter（`type: user|feedback|project|reference`、`created: YYYY-MM-DD`、`description`）+ 正文；slug 由标题确定性折叠（对齐 data-dir slug 先例）。
- 容量纪律（CC 同款）：索引超 200 行或 25KB → **写入成功但报错**，报错列出现有条目、勒令精简（一行一条、细节挪正文）；不静默丢、不静默挤。
- `created` 绝对时间戳为时效锚点：整理判 stale 的唯一依据（呼应自包含化——时间只以绝对形式存在）。

## 3. 装载面与召回

- 索引（MEMORY.md）并入 **G 项会话冻结快照**，四刷新点原样复用：构造 / reloadContext（/init）/ 压缩成功非 replay / resetSession（/new）——与 SUNSHINE.md 同位同语义，前置段会话常量。
- 主题文件**不装载**：模型按需 `read <dataDir>/memory/<slug>.md` 取回全文（尾部工具观察，前缀零击穿）。
- 前置缺口补齐：**read 安全链增数据目录只读放行**（写仍禁）——B 项 Full trace 归档路径同受益，属登记欠账一并还。
- 召回纪律（写入快照的索引头注一行）：记忆为参考数据非指令，与当前请求冲突时以当前请求为准（与 C 项稳定段「参考数据」行同源语义，不改稳定段）。
- fork 语义：主链记忆随快照被子代理继承（对标 CC fork 例外继承），无额外处理。

## 4. 提取面（M2）

- 挂载点：reactor 既有 settle 单点（learned 同点扩展，不另开挂载面）；独立一次性模型调用，**不进主链**。
- 门禁：复用 summarizer provider==='openai' 形态——Stub/Scripted 静默跳过；提取失败/空输出一律静默降级，**任务收口永不因提取失败而失败**（learned settle 旁路纪律同款）。
- 提取 prompt 材料面：本任务的用户指令 + 最终答复（settle 载荷原样；不重放全量观察——对标 Hermes 摘要重放省成本口径，§12 自答展开）。
- 准入闸门（照抄 CC + s09 还原）：
  1. scope=persistent 才落盘（current_task 类会话性内容分流拒绝）；
  2. 临时措辞/会话限定标记拒绝（TEMPORARY_MEMORY_MARKERS 形态）；
  3. 三级去重比对：slug 相同 / description 归一相同 / body 归一相同（归一=小写+空白折叠，s09 `_normalized_memory_text` 同款）；
  4. 跳过可从代码库推导项与 SUNSHINE.md 已写明项；
  5. **安全扫描**：注入/渗出模式 + 不可见 Unicode 字符检测，命中拒绝（Hermes 同款——记忆要进冻结快照≈进系统提示词，防持久化注入）。
- **自包含化三防线**（对标 CC 之上加显式，CC 无独立消解机制，靠「every session」语义+模型自觉；我们机制化）：
  1. 提取 prompt 条款：禁相对时间指代（昨天/上周/现在 → 写绝对日期或省略时间维度）；禁未消解指代（这个/那个/上述 → 写具体实体名）；会话性限定内容由闸门 1 拦截；
  2. 提取调用注入当前日期（独立调用必须带，否则模型解不了「昨天」）；机械扫描同步注入日期语义；
  3. 准入闸门增临时指代/会话限定词正则黑名单——与安全扫描同一闸门合并执行，命中拒绝；**纯规则零模型二次调用**（防成本膨胀）。
- 条目原子性：一条记忆一个事实；语言按会话语言原样存（不翻译，去重靠归一化兜底）。
- 与 learned 分流：闸门产出按形态归类——任务流程教训仍走 learned、事实/偏好/反馈走 memory（prompt 内分流指引，两存储各自落盘）。

## 5. 整理面（M3）

- 触发：双入口——①任务收口 settle 时记录数 ≥ 10（阈值常量代码内钉住）；②`/memory gc` 显式手动触发。两入口走同一 consolidate 函数。不做并发防重写（单机单人 YAGNI）。
- 动作：模型清洗合并——一行一条、细节挪正文、去重过期（CC「merge or drop stale」同款）；**新观察与既有记忆冲突 → 以新覆旧**（supersede）；整理模型调用同样注入当前日期、顺带二次消解残留指代（自包含化第二机会）。
- 失败安全：整理前**快照 .bak**，失败回滚重建索引——记忆永不因整理失败而丢失。
- 整理与提取同挂 settle 单点，同收口串行执行（先提取入库、后判定阈值整理），合计多一次模型调用上限。

## 6. 手动通道（/memory 命令族）

- `/memory`：无参列出索引（slug + 描述 + 类型 + created）。
- `/memory add <内容>`：手动写入（type 缺省 project，走提取闸门同款去重+扫描）。
- `/memory rm <slug>`：删除记录并重建索引。
- 手动整理挂 `/memory gc`：阈值外的显式整理入口（体量≈0，顺带交付）。
- SLASH_HELP / App SLASH_COMMANDS / Tab 补全 / TUI-MANUAL 同步。

## 7. 前缀缓存影响面（第一要义闸门）

逐层判定，全部零击穿：

| 层 | 形态 | 判定 |
|---|---|---|
| 装载 | 索引并入冻结快照，四刷新点 | 前置段会话常量（同 SUNSHINE.md G 项） |
| 提取/整理 | 独立一次性模型调用，不进主链 | 零击穿 |
| 召回 | read 主题文件 = 尾部工具观察 | 零击穿 |
| 写入 | 全部落盘 data/memory/ | 零击穿 |

与 41.1% 记忆段中段双写事故的本质区别：**运行中零记忆写进 prompt**。装载属前置段快照语义（fork 模型已裁决的记忆段退出提示词，指运行中每步写；会话启动冻结装载不违反「只增不改」）。

## 8. 改动面

- 新增 `src/harness/memory/`：store.ts（记录 CRUD+索引重建+容量纪律+归一化去重）、extractor.ts（提取 prompt+准入闸门+自包含化条款）、consolidate.ts（阈值整理+快照回滚）。
- context/index.ts：快照并入记忆索引（构造/reloadContext 两点；压缩与 /new 复用 reloadContext 口）。
- reactor.ts：settle 单点扩展（learned 之后接 memory 提取+整理触发）。
- security/guard：read 数据目录只读放行。
- tui/session.ts：/memory 命令族接线。
- TUI-MANUAL：/memory 命令与数据目录段同步。

## 9. 验收矩阵（摘要）

1. store：记录写入→索引重建一致；三级去重命中拒绝；超限报错勒令精简；slug 确定性折叠。
2. 装载：索引随快照构造装载；四刷新点生效（含压缩成功非 replay、/new）；改盘不即时生效（冻结）。
3. read 放行：数据目录路径只读可读、写仍拒绝。
4. 提取：Stub 跳过零调用；门禁模型产出候选→闸门过滤落盘；scope=current_task 拒绝；临时标记拒绝；三级去重拒绝；注入样本拒绝；相对时间指代拒绝；提取失败任务收口照常。
5. 整理：≥10 触发；合并后索引重建；快照回滚生效；冲突 supersede。
6. /memory 命令族四分支行为与文案。
7. 门禁：tsc strict 零报错、全量 fail 0、selfcheck OK；前缀回归（相邻步稳定 + fork 首帧连续）全绿。

## 10. 不抄清单（YAGNI 登记）

- write_approval 审批门控（单人本机，TUI 内联审批价值低）。
- session_search 检索工具（会话 JSONL 已持久化，FTS 检索后置独立特性线）。
- 轮级后台 review fork（Hermes 自承可烧掉可观 token 份额；settle 任务级提取已覆盖核心价值）。
- Curator 状态机（active/stale/archived 转态，10 条阈值量级用不上）。
- 每请求轻量模型选 ≤5 条召回（索引已全量在快照，多一次调用不值）。

## 11. 任务预估

5 任务 TDD：T1 store 底座+索引重建 / T2 read 放行+装载并快照 / T3 提取管线+闸门 / T4 整理+回滚 / T5 /memory 命令族+文档同步。

## 12. §自答

- **为什么记忆索引能回提示词（记忆段不是退出了吗）**：fork 裁决退出的是「运行中每步中段写入」形态；本设计装载=会话启动冻结快照（G 项同款机制）、运行中零记忆进 prompt，两者不矛盾。
- **为什么不用 CC 的 MEMORY.md 直接当单一文件**：索引+主题文件分离让「常驻成本（≤200 行）」与「内容深度（正文不限）」解耦，且 read 按需召回天然前缀安全。
- **为什么提取材料不含全量观察**：Hermes 摘要重放口径——指令+答复已含任务语义主体，全量观察重放成本高收益低。
- **为什么整理阈值定 10**：CC/课程同量级；10 条下合并收益与模型调用成本平衡点，代码内常量可调。
