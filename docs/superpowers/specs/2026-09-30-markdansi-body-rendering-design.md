# 正文流式渲染 markdansi 替换（正文路径先行 + 子代理转录统一）设计

日期：2026-09-30 · 状态：已裁决（范围=正文先行、预览=纯行级打字机+表格缓冲期表头原文、**子代理转录渲染同批统一**） · 前置：markdansi 0.3.4 已入依赖（4f2a69a）

## 一、背景与选型（并入原 docs/spike-markdansi.md spike 报告）

正文流式渲染补丁链（reply-flusher 切块/结构守候/完结位判据、LiveArea 预览窗/包络/恒高、cont/空白并块/margin 折叠、hardWrap/alignTable/markdownRowCount 正文预算——2026-09-29/30 约 15 个提交）在成型前未做 §13 开源优先选型调研。spike（0.3.4 实测）验证 [markdansi](https://www.npmjs.com/package/markdansi)（steipete，MIT，2025-11 首发、15 release、2026-09-14 活跃，Node≥22）可整链替换：

- **绿项**：`createMarkdownStreamer({ render })` 逐字符 push——散文行即到即发、表格缓冲至闭合整块框线输出、围栏缓冲+wrap、未闭合表格零外泄；GFM 表格边框/内距/截断内建；`highlighter(code, lang)` hook 接现有 highlight.js；`strip()` 导出供行数实账。ink 接法有先例：react-ink-markdown 源码实证 markdansi ANSI 输出直接作 `<Text>` children（string-width 计宽剥 ANSI、渲染原样输出）。
- **红项（内容层保留）**：段落超长行不折（实测 5000/200000 列直出）→ 本 spec 的 `wrapAnsiLines` 兜底；单列表格头（无内部竖线）不被 hold 当普通行即发→边缘容忍并回馈上游 issue；全角表格符号（`|───|`/`｜`/`：---`）不识别→归一上移（见三.3）。

## 二、目标与非目标

**目标**：流式 reply 的「切块决策 + Static 正文渲染」换 markdansi——streamer 片段（自带 ANSI）即 Static 条目；打字机=行级（每行完成瞬间上屏）；表格缓冲期动态区显示已到表头/数据行原文，闭合瞬间整块替换。**子代理转录渲染同批统一**（2026-09-30 用户裁决「子 agent 的正文渲染也是相同的逻辑」）：运行视图（ChildInspector）、归档回看（ChildTranscript/ChildInspector archived）、SPAWN 展开转录（ToolRow）的 text 段全部换 markdansi，消除同会话双渲染器观感割裂。

**非目标（跟进批次）**：工具行 detail 观察文本（4 空格缩进裸文本形态，本非 Markdown）、思考 detail、其他 MarkdownText 消费面。

## 三、架构与数据流

### 1. 主链

```
token → live.reply（不变）
      → preprocess(normalize 全角)（从 markdown.ts 导出复用，session 层上移）
      → streamer.push(源)   ← 替换 flushReply/stableReplySegment 全部切点语义
        返回完整片段（ANSI）→ pushMsg('assistant', 片段, { ansi: true })
      → MessageList Static：<Text>{item.text}</Text>（ansi 条目分流）
```

- `ChatItem` 增 `ansi?: true`：text 承载**渲染结果**（非 markdown 源）。渲染分流：ansi 条目直嵌 `<Text>`；其余走现有 MessageRow。journal 按原样序列化（resume 回放照显；已印行不随 resize 重折，与现状 Static 语义一致）。
- **done/seal 收口 = `streamer.finish()`**：冲刷残余片段即尾段——终稿 dedup 天然成立（streamer 不重不发），`committedLen` 水位与「终稿兜底补齐」路径退役。非流式（done 直接带全文）：push(finalText)+finish 一次完成。工具边界旁白封口（sealReply）同走 finish。
- **未完结构预览**：`tailPartial(src)` 纯函数（~30 行，识别尾部未完结构起点：已开启表格/未闭合围栏/未换行行），返回原文供动态区 `MdBufferPreview` 显示（管道符/围栏原文形态）。与旧 flusher 结构识别同源但只读不切。

### 2. 组件改动

| 单元 | 动作 |
|------|------|
| `session.ts` | +streamer 实例（每回合 reset）、preprocess 上移、done/seal=finish、ansi 标记入档；−flushReply/committedLen/appendBlankToLastReply/replyContPending |
| `MessageList.tsx` | +ansi 条目渲染分流、+MdBufferPreview（live.reply 期间挂动态区）；−正文条目的 MarkdownText 调用；账本：ansi 条目 `printedEntryLines` = `strip(text).split('\n').length` |
| 新 `md-ansi.ts`（src/tui/） | `wrapAnsiLines(fragment, width)`（slice-ansi+string-width 按显示宽折行，ANSI 安全）、`tailPartial(src)`、`renderMd(src, width)`（markdansi render + preprocess 归一 + wrapAnsiLines 兜底，单点出口） |
| `ChildInspector.tsx` | text 段（闭合 md 段与未闭合尾段预览）从 MarkdownText 换 `renderMd` 直嵌 `<Text>`；结构行（●/⎿/✻/输入带）保持自绘 |
| `ChildTranscript.tsx` | md 段（TranscriptSegView）从 MarkdownText 换 `renderMd`；detail 序列化**继续存源 markdown**（归档格式零变更、旧档兼容） |
| `LiveArea.tsx` | reply 分支退役（仅剩 thinking 6 行窗）；App 的 previewCap/envelope/onPreviewUsed 链退役 |
| `reply-flusher.ts` | **整文件退役**（含全部测试） |
| `markdown.ts` | preprocess 归一导出复用（渲染面不动，留待后续批次清理） |

**子代理统一的关键简化**：不需要 streamer 状态——子代理事件流的「流式」由视图层对未闭合尾段每帧一次性 `render()` 承载（markdansi 微秒级、memo 友好，react-ink-markdown 先例），session 的 transcript/detail 持续存源 markdown，归档与旧档回放零迁移。

### 3. 内容层保留物

- 全角归一：preprocess 从「markdown.ts 内部」导出、session push 前调用（markdansi 用 marked，不经过我们 preprocess，必须上移）。
- 超长行护栏：`wrapAnsiLines` 在 Static 条目进 Text 前兜底（ink Static 渲染走 yoga 计宽，20 万列爆栈不回归）。

## 四、错误处理与回退

- streamer/render 抛异常：该片段降级为转义裸文本入档（不丢内容、不中断回合）。
- 回退：git revert 本批次（不设运行时开关，YAGNI）；接缝收敛满足 §5 台账「替换实现不动主链」。

## 五、已知风险与降级

1. `finish()` 对未闭合结构（围栏/表格流中中断）的冲刷形态未实测——迁移批次第一步先探针定形；不可接受则 flush 前补结构闭合。
2. 长围栏生成期预览为原文非高亮（现状为实时高亮）——接受降级；后续可给 MdBufferPreview 的围栏态加局部 render。
3. marked vs markdown-it 解析差异（GFM 边缘语法）——正文路径实测回归覆盖；顿号列表等中文归一随 preprocess 上移一并保留。

## 六、测试策略

- streamer 片段序列：1/3/8/20 字符步进恒同块、源不丢不重（沿用 spike 探针口径固化为测试）。
- MdBufferPreview：表格已开（表头+数据行原文在位）、闭合瞬间替换、围栏原文、散文未完行。
- `wrapAnsiLines`：20 万列不爆栈、ANSI 码不切坏（strip 后行宽恒 ≤ width）。
- 子代理统一：ChildInspector 运行视图（结构行混排 + text 段 markdansi）、归档回看（detail 源 markdown 照旧序列化、渲染换 renderMd）、旧档 detail 回放、ToolRow SPAWN 展开转录。
- 旧档兼容：cont/非 ansi 条目混排回放、resume 回放。
- done=finish 收口：终稿无重复（流式+非流式两态）、工具边界旁白先于工具行。

## 七、迁移批次步骤（writing-plans 输入）

1. finish() 冲刷形态探针（风险 1 定形）
2. `md-ansi.ts`（renderMd/wrapAnsiLines/tailPartial）+ 单测
3. session 集成（streamer/preprocess 上移/finish 收口/ansi 入档）+ 单测
4. MessageList（分流/MdBufferPreview/账本口径）+ 单测
5. 子代理渲染统一（ChildInspector/ChildTranscript 换 renderMd；detail 序列化不动）+ 单测
6. 退役（reply-flusher 文件、LiveArea reply 分支、envelope 链、相关测试更新）
7. 全量门禁 + 真机验证清单（逐行打字机/表格整块/围栏整块/无闪频/子代理视图与主链观感一致/旧档回放）

## 八、验收标准

- 流式正文行级上屏；表格闭合瞬间整块框线；缓冲期表头/数据行原文可见
- 子代理运行视图/归档回看/SPAWN 展开转录的表格、围栏、列表形态与主链一致（同一 renderMd 出口）
- 拼接无损：发射源覆盖 === 终稿（strip 后全文一致）
- 20 万列无空格行不崩；门禁 fail 0；旧档回放零回归（子代理 detail 旧档零迁移）
