# markdansi 选型 spike 报告（2026-09-30）

§13 开源优先纪律的补课：正文流式渲染补丁链（reply-flusher 切块/结构守候/LiveArea 预览窗/包络/cont/空白并块/hardWrap/alignTable/markdownRowCount 预算，本会话 ~15 个提交）成型前未做选型调研——spike 验证 [markdansi](https://www.npmjs.com/package/markdansi)（steipete，MIT，2025-11 首发、15 release、2026-09-14 仍活跃，Node≥22）是否可整链替换。

## 探针结论（0.3.4 实测）

### 绿项（补丁链目标形态开箱即得）

- **流式语义**：`createMarkdownStreamer({ render })` 逐字符 push——散文行即到即发（打字机）、空行即发、**表格缓冲至闭合整块框线输出**、围栏缓冲 + wrap；未闭合表格期间零发射。
- **GFM 表格**：边框/内距/截断/省略号内建（对齐我们手搓 alignTable）。
- **高亮 hook**：`highlighter(code, lang)` 接现有 highlight.js 无碍。
- **fence 超长行 wrap**：width 约束内折行（对齐 hardWrap 的 fence 分支）。

### 红项（替换批次需保留/补的内容层）

1. **段落超长行不折**：无空格 token 段落直出（实测 5000/200000 列单行）——hardWrap 护栏保留在 preprocess（上游无此能力，考虑回馈 issue）。
2. **单列表格头孤立**：`| 包 |`（无内部竖线）不被 hold 当普通行即发——多列表格不受影响（实测两列起 hold 正确）；边缘容忍或上游 issue。
3. **全角表格符号**：`|───|───|`/`｜`/`：---` 不识别——preprocess 全角归一保留（内容层，与渲染器无关）。

### 架构接法（react-ink-markdown 源码佐证）

- ANSI 输出直接作 ink `<Text>` children：string-width 计宽剥 ANSI、渲染原样输出——ink 3 同构可用。
- react-ink-markdown 刻意**不用 streamer**（一次性 render + memo，「避免流式状态复杂度」）——但我们的 Static 模型恰好适配 streamer：`push()` 返回的完整片段即 Static 条目（自带 ANSI，`<Text>` 包裹），未完成部分留缓冲。
- `strip()` 导出供 tail 账本行数实账（strip 后 split('\n')）。

## 替换批次方案（待排期）

- Static 正文条目：`<Text>{markdansi 片段}</Text>` 替换 MarkdownText（MarkdownText 保留给工具行/子代理转录，跟进批次）。
- reply-flusher 切块（表格守候/围栏缓冲/完结位判据/兜底节奏）→ streamer 语义内建，整文件退役。
- LiveArea 正文预览窗/包络/恒高 pad → streamer 缓冲期内未完内容不外泄，预览缩至未完行（整链大幅简化）。
- cont/空白并块/margin 边界折叠 → append-only 片段无块边界问题，退役。
- 保留：全角归一、段落 hardWrap（红项 1/3）。
- §13 组件表登记：markdansi（TUI Markdown 渲染，收敛于 src/tui/，替换 markdown-it 呈现面——解析仍留 markdown-it 于 detail 回看路径，过渡期双轨）。
