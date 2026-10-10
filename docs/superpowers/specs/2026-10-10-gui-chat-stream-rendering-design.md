# GUI 会话流渲染升级(Codex 对标二轮) · 设计 spec

日期:2026-10-10。前作:[2026-10-08-codex-desktop-1to1-design.md](./2026-10-08-codex-desktop-1to1-design.md)(令牌/形状/动效 token 全部沿用,本文不重复定义)。

用户已裁定:
1. 运行状态行 Codex 同形——完成后保留为「Worked for Xs」历史行(非仅运行中显示)。
2. 展开/折叠与流式输出要有丝滑动效,不要死板。
3. 正文结束后显示操作条:复制、fork 图标 + 步数、tokens、完成时间。
4. 用户气泡下侧加复制/编辑钮;编辑态为 composer 同款浮卡,发送=发送新消息,可取消(推翻 G9 spec §3.1「Edit 钮不做」裁定——交互形态照 Codex,无历史改写语义)。
5. 操作钮一律纯图标,说明走统一样式 Tooltip(不用原生 `title`);截图中的 👍👎/锚点钮不做(无回执端点,复刻纪律「无功能对应物不做」)。
6. Markdown 渲染(正文排版/代码块/表格)按 §5 定靶表统一,当前折行/层级/边线散乱问题收敛。

## 0. 目标与非目标

**目标**:GUI 会话流(`gui/src/pages/Chat.tsx` + `gui/src/chat-reducer.ts` + `gui/src/app.css`)的流式渲染升级——状态行、工具/思考行、正文 markdown、操作条、编辑卡、动效全面对标 Codex,样式走既有令牌,双主题自动适配。

**非目标**:
- daemon 零改动(全部数据 done/tool-result 事件载荷已携带,GUI 侧消费)。
- 不动 TUI 渲染轨;不动 Board/Files/设置面。
- 不做 👍👎 反馈、锚点跳转(无后端对应物)。
- 种子历史条(快照归档)不补 run 标记/工具 input 全文/操作条元数据——快照 md 形态不变,旧轮降级为摘要行展开(Codex 重开历史同样降级)。

## 1. run 状态行(chat-reducer + RunEntryView)

### 1.1 reducer:run 边界条目

- `ChatEntry.kind` 联合增 `'run'`;run 条目 `{ md: '', streaming: true, ts }` 起段。
- `model-start` **仅 idle→running**(run 边界)时插入 `run:<n>` 条目;running 态续轮 model-start 不重复插(与既有 usage 水位「run 内不重置」裁定同构)。
- `done`/`error` 封段(最后一条 streaming run 条):`streaming` 去标,回填:
  - `seconds`:首尾 ts 差取整(无 ts/不足 1s 省略);
  - `steps`/`tokens`:done 载荷 `{ steps, tokensUsed }`(reactor.ts:400,session.ts 泵直通)透传;error 面省略;
  - `endedTs`:收段事件 ts(完成时间渲染源)。
- `seedChatFromSnapshot` 不产 run 条目(快照五 kind 不含 run);key `run:<entries.length>` 保证唯一。
- 中断路径免兜底:interrupt 以 `done`(stopReason=interrupted)收束,run 条目必被封段。

### 1.2 渲染:RunEntryView

- streaming:`◌ Working · 12s · 8.4k tokens`——旋转环(`sx-spin` 沿用)+ 1s tick(组件内 interval,仅 streaming 时挂,卸载即清)+ 会话累计 tokens(`chat.tokens` 传入,仅此组件消费,不破其余条目 memo)。
- 封段后:`✓ Worked for 34s` 淡灰小字(`endedTs` 存在时同时承担 §6 元数据的挂载点,见 §6 布局裁定)。
- Working→Worked 切换 opacity 交叉淡变(§8)。

## 2. 工具行:对齐正文 + 展开 Input/Output

- **对齐**:`.entry`/`.entry-tool`/`.entry-thinking` 左右 padding 统一(8px),三类行与正文同一 x 起点。
- `ToolCallInfo` 增 `result?: string`:`sink.on` 在 `tool-result` 帧(有 callId)旁路暂存**全文**;call 先到 result 后到/result 先到 call 后到均合并进同一槽(部分字段容缺);种子条无槽,回落 md 首行。
- 折叠行不变(`图标 + verb [path] · result 首行`)。
- 展开面(非 write):**Input 段**(`JSON.stringify(info.input, null, 2)`,空对象省略)+ **Output 段**(暂存全文 → 回落 md 首行 → `(无结果)`);段头 11px tertiary 小标 `Input`/`Output`;各段 `pre` `max-height: 280px; overflow: auto` 内部滚动。
- write 工具保持 DiffPanel 双列(diff 面同加 max-height 内滚);path 按钮分流(onOpenDiff/onOpenFile)不变。
- 展开/折叠走 `grid-template-rows 0fr→1fr` + opacity 过渡(§8),替换现 `{expanded && ...}` 硬挂卸。

## 3. 思考行:内联流动预览 + 展开吸底

- 折叠行:`Brain` 图标 + 「思考中…/思考 Ns」+ **内联预览**——取 md 末个非空行,尾锚定渲染(`direction: rtl` + `overflow: hidden` + `white-space: nowrap`):流式追加时新内容自右推入、旧文向左流出(「往前流动」);左缘 `mask-image` 线性渐隐(淡出替代硬裁切)。
- 展开:全文 `pre` 包进内滚容器 `max-height: 320px; overflow-y: auto`;streaming 时 effect 逐帧吸底(直设 `scrollTop`,不走平滑——逐 token 跟手不平滑抖动)。
- 展开/折叠同 §2 grid 过渡;chevron 旋转沿用 `--ease-enter`。

## 4. 系统行图标

| 行 | 图标(lucide,12px) |
|---|---|
| thinking | `Brain` |
| notice(通用) | `Info` |
| notice(委派 `✻` 前缀) | `Bot` |
| notice(agent 消息 `[a → b]` 前缀) | `MessageSquare` |
| error | `AlertCircle` |

图标为行首前置装饰(md 原文不动);工具行既有 `TOOL_ICONS` 映射保留。

## 5. Markdown 渲染定靶(mdComponents + CodeBlock)

### 5.1 正文排版(`.entry` 域)

| 项 | 目标值 |
|---|---|
| 行距/段距 | 正文 line-height 1.65;段距 8px |
| 标题阶梯 | h1 17px / h2 15.5px / h3 14px / h4 13px,600 字重;前 16px 后 8px |
| 行内码 | 12px mono、前景 6% 井底、`radius-xs`、padding 1px 5px |
| 列表 | li 间距 3px、缩进 20px、标记色 secondary |
| 引用 | 左条 3px(border 色)、fg-secondary |
| hr | border-subtle、上下 12px |
| 链接/图片 | accent;图片 max-width 100% + `radius-md` |

### 5.2 代码块(CodeBlock 组件,替换裸 `pre`)

- `mdComponents.pre` 分流:`language-mermaid` → MermaidBlock(§5.4);其余 `language-xxx` → CodeBlock(hljs 高亮);无语言围栏 → CodeBlock 无语言标(plaintext 不自动检测)。
- 卡体:`surface-code` 底 + 1px `border-subtle` + `radius-md`;头部栏 32px(语言名 11px tertiary 左,复制图标钮右,hover 浮现)。
- 代码:**`white-space: pre` + `overflow-x: auto`,禁止折行**(现 `pre-wrap+anywhere` 强折行是排版错乱主因);12.5px/1.7 mono;padding 12px 14px。
- 高亮:`highlight.ts` 增 `highlightByLang(code, lang)` 导出(异常回落 `escapeHtml`——注入面纪律不变);令牌走既有 `--syntax-*` 双主题表。
- 流式:`memo` 按 code 串缓存高亮结果;复制成功图标切换 `✓` 1.5s(§7 Tooltip 规范)。

### 5.3 表格

- `mdComponents.table` → `.table-wrap`(`overflow-x: auto` + 1px `border-subtle` + `radius-md` 圆角裁切)。
- th:`surface-soft` 底、600、12px、padding 6px 12px;td:padding 6px 12px;**只留横线去竖线**;偶数行前景 2% 斑马纹;表 margin 8px 0。

### 5.4 Mermaid(MermaidBlock 包裹)

- 容器 hover 显两枚图标钮:**放大**(`Maximize2`)/**复制**(源码);纯图标 + Tooltip。
- 放大 = lightbox:fixed 遮罩(暗化 65%)+ svg contain 居中;淡入 + 轻微缩放入场;点击遮罩/Esc 关闭(Esc 监听随开关挂卸);内容为 `<Mermaid>` 复渲染(模块级缓存,零额外拉包)。
- 渲染失败/超时回落原文代码块的既有降级不变(fallback 态两钮仍在)。

## 6. 正文尾部操作条(run 元数据条)

- **挂载点裁定**:操作条挂在**该 run 的末条 assistant 条目**之下(「正文结束后」字面语义);run 条目本身只承担状态行(run 条目插在活动之前,元数据向后取)。末条判定为渲染层纯投影:对每条 assistant 条目,若**其后最近的 run 条目已封段**(或其为流尾且 status idle 且自身非 streaming),则为 run 末条;元数据取该枚 run 条目的封段值。

> 勘误(2026-10-10 终审):run 条目在活动条目之前插入,「其后最近的 run 条目」应为「其前最近的已封段 run 条目」——实现以此为准。

- 内容(左→右):`⧉ 复制`(复制该条 md)/ `⑂ 分叉`(接既有 `onFork`,未配不渲染)/ 分隔留白 / `12 steps · 8.4k tokens · 15:56`(run 封段的 steps/tokens/endedTs,HH:mm 格式;数据缺省逐项省略)。
- 交互:hover 浮现(opacity 过渡);纯图标 + Tooltip;复制成功 `✓` 1.5s。
- memo 纪律:元数据经 prop 传入单条 ChatEntryView,仅该条重渲染。

## 7. 用户气泡:编辑/复制 + 行内编辑卡

- 气泡 hover 操作行(既有 `user-actions` 位)增**编辑**钮;两钮均图标化 + Tooltip(替换现「图标+文字」样式)。
- 编辑态:气泡原位替换为 composer 同款浮卡(`surface-elevated` + `--radius-composer` + `--elev-composer`,占满流区宽),内含预填 textarea(自增高,`autoFocus`)+ 取消(`×`)/发送(`↑`)圆形钮。
- 键位:Enter 发送 / Shift+Enter 换行 / Esc 取消(与 composer 键位一致)。
- **发送 = 新消息**:Chat 抽 `submitText(text)`(现 send() 的分流段:idle→`sessionSubmit` / running→`sessionSteer` / plan→`/plan`),composer 与编辑卡共用;本地追加新 user 回显条,原条不改写。
- 取消:`×`/Esc 丢弃草稿回气泡;切换淡入过渡(§8)。

## 8. 动效(全局一律走既有 token)

| 场 | 形态 |
|---|---|
| 展开/折叠(工具/思考) | `grid-template-rows 0fr→1fr` + opacity,`--dur-relaxed --ease-enter` |
| 新条目入场 | 淡入 + 4px 上移,0.2s(每条目一次,流式正文不逐字动画) |
| 思考预览流动 | 尾锚定天然流动 + 左缘 mask 渐隐 |
| 状态行切换 | Working→Worked opacity 交叉淡变 |
| lightbox | 遮罩淡入 + 内容 scale 0.96→1 |
| Tooltip | opacity 过渡 + 0.3s 延迟(防掠过闪现) |
| 复制反馈 | 图标切 `✓` 1.5s,无文字弹层 |

- 全部被既有 `prefers-reduced-motion` 全局降级覆盖,零额外代码。
- Tooltip 实现:`data-tip` + CSS `::after`(统一类 `.sx-tip`):`surface-elevated` 面、`--radius-sm`、`--elev-prominent`、11px tertiary、图标上方 4px;可达性 `aria-label` 保留(title 不用)。

## 9. 错误处理与降级

- hljs 高亮异常 → `escapeHtml` 原文(注入面纪律:产出经转义才能进 `dangerouslySetInnerHTML`)。
- mermaid 拉包失败/渲染超时 → 既有回落原文(5s 竞速不变);lightbox 内复渲染失败 → 关闭回容器态。
- run 条目 `seconds/steps/tokens/endedTs` 缺省逐项省略,不渲染 `undefined` 字面量。
- 编辑卡提交失败 → 走既有 error 条路径(与 composer 同);草稿不丢(卡片保持编辑态)。
- 工具 result 全文暂存仅内存(`toolInputs` 同生命周期,reseed 即清),不入 journal。

## 10. 测试与验收

- **chat-reducer.test.ts**:run 边界五例(idle 插入/续轮不重插/done 封段计秒+载荷透传/error 封段/无 run 直答不补插+多轮各自成段/seed 不产 run)。
- **Chat.test.tsx 增**:状态行 streaming/封段文本;工具展开 Input+Output 文本与内滚容器;思考折叠预览/展开容器;CodeBlock 语言标+复制写剪贴板;表格 wrap 容器;mermaid 两钮与 lightbox 开关;run 尾操作条元数据+fork 回调;编辑卡发送(submitText 路径)/Esc 取消;notice/error 图标类;Tooltip `aria-label` 在场。
- **既有断言兼容**:`.tool-summary` 文本含 verb/result、`.sx-stream-cursor` 进出场、`.entry-notice` 文本、`.user-bubble` 契约保持;**已知必改点**——操作钮 `title`→`aria-label` 迁移触及既有 title 查询断言(Chat.test.tsx `button[title="Copy"]`/`findByTitle('Copy')` 等改按 aria-label 查询),属最小改。
- 验收命令:`cd gui && npx tsc -p . && npx vitest run`;手动双主题过一遍 §5 定靶表。

## 11. 分批交付序

1. **B1 reducer+状态行**:§1(run 条目、RunEntryView、tick)——后续批次的元数据源。
2. **B2 工具/思考行**:§2+§3+§4(对齐、Input/Output 展开、预览流动、图标)。
3. **B3 markdown 面**:§5(CodeBlock/表格/MermaidBlock)+ §6(尾部操作条)。
4. **B4 编辑卡**:§7(submitText 抽取复用)。
5. **B5 动效收口**:§8 全量落 CSS + §10 全量验收。

每批 TDD(先测后码),批内绿再进下批;全部样式随批归 `app.css` 追加段(单一 CSS 文件约束 U-D10)。
