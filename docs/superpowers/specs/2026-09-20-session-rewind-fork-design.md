# 会话 Rewind + Fork 设计规格（对标 CC /rewind · Codex 不可变分档）

日期：2026-09-20
状态：设计定稿（七节呈现经用户批准；两项范围裁决用户拍板）
自审：2026-09-20 修正三处——分支点边界语义（锚点行不进新档、upToLine=锚点行号−1）、代码回退收集面（含当轮写入 + forkedFrom 血缘上溯）、upToLine=1（仅 header 空档）合法化。
前置：docs/superpowers/specs/2026-09-17-session-persistence-resume-design.md（journal 基建）

## 1. 背景与目标

会话持久化 + resume 线已交付 journal JSONL（schema v1，事件词汇 header/user/msg/chain/compact/todos/model/view）与 /resume、--continue。本特性线在其上补齐时间维度的两个操作：

- **/rewind**：当前会话回退到过去任意任务轮（对话必选、代码可选），被回掉的历史保留、随时可回。
- **/fork**：从任意会话的任意任务轮复制出平行会话，源会话原地不动。

对标：Claude Code /rewind（每条 prompt 一个 checkpoint + 对话/代码恢复）；Codex rollout fork/revert（不可变分档 + 血缘元数据）。

## 2. 对标调研结论

| 维度 | Claude Code | Codex | 本方案取舍 |
|------|------------|-------|-----------|
| 存储形态 | 会话随 checkpoint 保存 | 不可变 rollout JSONL，每行带 ordinal | 沿用本仓 journal JSONL |
| rewind 语义 | 就地恢复（快照过期即失效） | revert=复制前缀到新档（thread id 稳定），原档永存 | Codex 式不可变分档 |
| fork 语义 | 无独立入口 | fork=复制前缀到新文件，元数据记 forked_from_id + forked_from_ordinal_exclusive | 同一原语承载 rewind 与 fork |
| 代码回退 | 每条 prompt 前影子快照，只跟踪自家编辑工具 | 无 | CC 式 write 工具 pre-image 快照 |

核心洞察：Codex 的 rewind 与 fork 底层是同一操作——复制源前缀到锚点 + 新档记血缘 + 切活动指针。本方案收编为单一原语 `branchFrom`。

## 3. 范围

**做**：/rewind（对话 + 代码三态动作）、/fork（含 /resume Fork from… 入口）、journal schema 字段扩展、write 工具 pre-image 影子快照、/resume 血缘标注。

**不做**：见 §12。

## 4. 关键裁决

| # | 裁决 | 依据 |
|---|------|------|
| D1 | 范围=CC 全量：对话回退 + 代码回退同期交付 | 用户裁决 |
| D2 | 语义=Codex 式不可变分档；就地截断否决（原档永存、与 append-only 纪律一致、「回到被回掉的未来」免费获得） | 用户裁决 |
| D3 | 单一原语 branchFrom(source, upToLine, kind)：均产出新档（新 sessionId、header 记 forkedFrom）并切换活动指针，数据面同一；rewind 用户语义=当前会话回到过去（原时间线保留可 /resume），fork 用户语义=复制出平行会话 | 收编 Codex 洞察 |
| D4 | 锚点=user 事件（每任务轮恰一条，天然 checkpoint），不新增事件类型；运行中穿插消息（steering）不产生锚点 | 对标 CC per-prompt 粒度 |
| D5 | schema 扩展=additive 可选字段（header.forkedFrom、user.files），版本号不升——前缀逐字节复制使新档对旧代码即普通会话档 | 封闭词汇纪律约束事件类型枚举；字段扩展在此登记 |
| D6 | 代码快照只跟踪 write 工具；exec 副作用、外部编辑、symlink/hardlink 不跟踪；不是 git 替代 | 与 CC 同口径 |

## 5. 数据面：journal 分档

### 5.1 schema 扩展（v1 内 additive）

- `header` 新增可选 `forkedFrom: { sourceSessionId: string, upToLine: number, kind: 'rewind' | 'fork' }`。
  `upToLine` 为源档 1-based 行号，新档含源档第 1..upToLine 行。分支点语义=锚点行的**起点**：调用方传 `upToLine = 锚点行号 − 1`，锚点 user 事件行不进新档——该轮输入不进链，改由输入框回填、用户重发经正常任务提交进链（对齐 CC 回填语义，避免提示词重复）。
- `user` 事件新增可选 `files: Array<{ path: string, hash: string, deleted?: true }>`——该轮影子快照增量清单（相对上一锚点）；`hash` 为 pre-image 内容 sha256；`path` 为项目相对路径（POSIX / 分隔，读取时按平台重新拼接）；`deleted: true` 表示写入时文件不存在（新建类写入）。

### 5.2 branchFrom 原语

`branchFrom(sourceSessionId, upToLine, kind) → { newSessionId }`，三步：

1. 读源档第 1..upToLine 行，逐行 JSON 解析校验（任一行解析失败即拒绝——分档要求完整前缀，撕裂容忍仅属重放路径）。
2. 写新档：第 2..upToLine 行与源档逐字节相等；header 行重写——沿用复制出的 header 对象，改写 sessionId 为新 id（生成沿用现机制）、增 forkedFrom 三字段。
3. sessions-active.json 活动指针切到新档（当前两个调用方 /rewind、/fork 均切换；指针写失败则整体报错不生效）。

失败安全：写新档失败 → 源档未动零副作用；指针切换为最后一步。

### 5.3 血缘与重放

- reduceJournal 不感知血缘：新档自含全量前缀，重放逻辑零改动。
- 环不可能产生（前缀复制非引用链）；upToLine 越界（< 1 或 > 源档总行数）拒绝 INVALID_ARG；=1 即仅 header 的空会话档，合法——回退到第 1 轮起点正是此形态。
- /resume 列表读取 header.forkedFrom 展示血缘标注；列表按 .jsonl 后缀过滤，_blobs 目录天然不命中。

## 6. 影子快照（代码回退）

### 6.1 捕获

- write 工具执行路径前置钩子（builtin.ts 单点，经 Harness 注入收集器；非新工具、工具清单零变化、零前缀影响）：每次 write 落盘前把目标文件当前状态记入内存待落清单 `{ path, hash, deleted? }`，blob 内容寻址写 `<dataDir>/sessions/_blobs/<sha256>`（已存在跳过，跨会话去重）。
- 清单落盘时机：任务收口 flush 时，本轮收集的清单随该轮 user 事件 files 字段一并写入（user 事件与 files 同批落盘，无需新事件类型）；blob 在捕获时即写盘、先于清单落地，崩溃仅余无引用孤块（GC 已登记不做，无危害）。

### 6.2 回退算法（Restore code 到分支点 k）

分支点语义=第 k 轮的**起点**（与对话回退同界），恢复目标=第 k 轮开场时的文件状态，**含第 k 轮自身写入的 pre-image**。收集面沿 forkedFrom 血缘链逐层（自身档 → 源档 → 更上层源档；前缀逐字节复制保证行号跨层一致）：自身档取行号 > 目标锚点行号的 user 事件 files；第 i 层祖先取行号 > 其直接子层 `forkedFrom.upToLine` 者（更早部分已物理内含于子层档，不得重复计）。每文件取**血统序最早一次** pre-image（血统顺序即时间顺序）：`deleted: true` → 删除该文件；否则以 hash 取 blob 内容写回。无清单的文件不动。立即回退场景（/rewind 执行序内）源档从新档 header.forkedFrom 解析；对已分叉会话更早锚点的再回退同算法逐层上溯。

### 6.3 边界语义

- 外部编辑过的文件被覆盖属预期，不检测，回执如实列明变化文件（对标 CC「session 级快速恢复、非 git 替代」）。
- blob 缺失（被手动清理）：该文件跳过并在回执列明 skipped，对话回退不受影响。
- blob 不做 GC；容量成本=被改文件大小 × 版本数，个人工具可接受（登记 §12）。

## 7. 交互面（TUI）

### 7.1 /rewind（空闲态可用，运行中拒绝沿 /resume 先例）

1. 锚点选择器：reduceJournal 收集 user 事件（序号 + 首行文本预览），复用 askquestion 线 OptionSelector 组件（T1 已交付；若消费面未收口则按 /resume 现行列表形态降级，组件就绪后收编——计划期裁决）。
2. 二级动作卡（对标 CC）：锚点 k 之后存在非空 files 清单 → `Restore code and conversation / Restore conversation only / Restore code only / Cancel`；否则仅 `Restore conversation / Cancel`。
3. 执行序：branchFrom(当前档, 锚点行号 − 1, 'rewind') → 装载新档（/resume 同路径，对话面就位，锚点轮输入不进档）→ 动作含 code 时对当前工作区执行 §6.2 回退 → 横幅回执「已回退到第 N 轮 · 原会话保留，/resume 可回」→ 被选中锚点的原始输入回填输入框（可编辑重发，经正常任务提交重新进链）。

### 7.2 /fork

- 入口 A：/fork 直接调起当前会话锚点选择器 → branchFrom(当前档, 锚点行号 − 1, 'fork') 新 sessionId → 活动指针切新档 → 回执「已从第 N 轮分叉出新会话 \<id\>」，新会话输入框回填锚点原始输入（可编辑重发）。源会话原地保留，进 /resume 列表。
- 入口 B：/resume 选择器选中会话后新增动作 `Fork from…`（可从任意历史会话分叉，目标无需是当前会话），选中后同流程。

### 7.3 /resume 列表标注

血缘会话行尾标注 `fork from \<id 前 8 位\>` / `rewind from \<id 前 8 位\>`；排序与其余行为不变。

### 7.4 键位

双击 Esc 快捷键不做（与中断/清空输入键位冲突）；v1 只走斜杠入口。

## 8. 前缀缓存与恢复不变量

- rewind/fork 只发生在 idle 边界，等价 restoreSession 级链重建（与 /new、/resume 同属合法刷新边界），运行期零回改。
- 钉子断言：分档续写的下一帧 prompt 与源会话锚点时点存档重放的下一帧逐字节一致（复用 restoreSession 钉子形态）。
- 分档文件第 2..upToLine 行与源档逐字节相等（含 files 字段原样保留），防重放语义漂移。

## 9. 错误边界

| 场景 | 语义 |
|------|------|
| 源档缺失 | 报错拒绝，零副作用 |
| 前缀内任一行 JSON 解析失败 | 拒绝（分档要求完整前缀） |
| upToLine 越界 / 指向 header 行 | INVALID_ARG |
| 活动指针写失败 | 整体报错不生效（新档可清理） |
| blob 缺失 | 跳过该文件，回执列明 skipped |
| 运行中调用 /rewind //fork | 拒绝（沿 /resume 运行中守卫先例） |

## 10. 验收矩阵

1. branchFrom：新档第 2..upToLine 行与源档逐字节相等；header 含正确 forkedFrom；源档内容与 mtime 不变。
2. rewind 对话：装载新档后消息流与链同源会话锚点时点一致；下一帧 prompt 逐字节一致（restoreSession 钉子）。
3. rewind 代码：write → 锚点 → 再写（含锚点当轮写入）→ Restore code → 文件回到锚点时点（当轮写入被回退）；新建文件回退为不存在；回执列明变化清单。
4. fork：新会话独立增长与源会话互不影响；/resume 两者均可选且血缘标注正确；Fork from… 可从非活动会话分叉。
5. v1 兼容：无 forkedFrom/files 旧档 load / rewind 照常；旧档 rewind 产物可被不感知新字段的 reduceJournal 重放。
6. 锚点枚举：菜单列出每任务轮（user 事件）含首行预览；运行中调用被拒。
7. 错误边界：越界、前缀行损坏、blob 缺失三态分别拒绝/跳过并如实回执。
8. 血缘上溯：fork 出的会话再 fork 一层，对新会话再 rewind 代码回退，跨两层血缘收集正确（每文件恰取最早 pre-image、不重复应用）。
9. 门禁：pnpm build 零报错 + 全量测试 fail 0 + selfcheck OK。

## 11. 落点与任务预估

- `src/tui/session-journal.ts`：header/user 字段扩展、branchFrom、锚点枚举。
- `src/harness/tools/builtin.ts`：write pre-image 钩子（Harness 注入收集器，非新工具）。
- `src/tui/session-snapshots.ts`（新）：blob store 与回退算法纯模块。
- `src/tui/session.ts`：/rewind、/fork 命令、选择器接线、/resume 血缘标注、restoreSession 复用。
- `TUI-MANUAL.md`、`README.md`。
- 预估 4–5 个 TDD 任务。

## 12. 登记不做（YAGNI）

Summarize from/up to here（锚点化定向压缩）· 双击 Esc 快捷键 · exec 副作用跟踪 · symlink/hardlink 恢复 · blob GC · 跨档 checkpoint 合并视图 · 代码回退的外部改动检测。
