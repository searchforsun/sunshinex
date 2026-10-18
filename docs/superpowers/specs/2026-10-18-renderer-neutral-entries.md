# 设计档:内核条目渲染中立化(renderer-neutral entries,2026-10-18)

> 背景:工具行渲染修复(c0b30de)把 `● 名称 {输入JSON}\n⎿ 首行` 定为内核 md 形态——但 `●`/`⎿`
> 本身是 TUI 渲染记号,塞进内核仍是呈现语义漏进数据层。用户裁定:内核层返回的就是结构化数据
> (工具=输入 JSON+输出),不应有渲染记号;**内核条目重构为业界标准形态,不关心渲染层如何渲染**,
> 未来任何渲染层或纯 API 消费者拿到即可识别。状态:**设计定版,实施未开始(P11 单片)**。

## 1. 原则

1. **内核条目=结构化记录**:自由文本类(user/assistant/thinking/notice/error)md 承载**裸内容**
   (无任何前缀/记号/装饰);工具类(kind:'tool')**仅结构字段承载**(name/input/result),md 退役
   (恒空串)——字段已全量在场,md 是冗余的第二真相源,正是双源漂移的根;
2. **呈现记号归渲染层**:`●`(调用行符)/`⎿`(结果行符)/`>`(用户输入符)/首行截断/动词本地化
   (读取/查找…)/图标,全部由 TUI/GUI/未来渲染层自绘——内核零渲染词汇;
3. **业界标准形态**(对标 OpenAI/Anthropic message API 的 self-describing 条目):
   `{kind:'tool', name:'read', input:{path}, result:{text, ok}}`——无 md 也能完整识别;
   `{kind:'user', md:'goal'}`——裸文本即内容;
4. **单真相源**:工具条语义唯一载体=字段;user 内容唯一载体=md 裸文。上一轮「GUI 契约 md」
   与本轮裁定冲突,以本轮为准(渲染契约是渲染层内部事务)。

## 2. 内核条目模型(改后)

| kind | md | 结构字段 | 渲染层职责 |
|---|---|---|---|
| user | **裸文本**(去 `> `) | — | 绘输入符/气泡 |
| assistant | 裸正文(现状) | — | markdown |
| thinking | 裸思考文(现状) | seconds | 耗时摘要/展开 |
| tool | **恒空串** | name/input/result{ text, ok, full? } | `●`/`⎿` 或图标/动词本地化/目标字段/首行截断/展开全文 |
| notice / error | 裸文本(现状) | — | 级别着色/前缀(P10 已裁定归渲染面) |
| run | ''(现状) | meta | 状态行 |

## 3. 各层改动

### 3.1 内核(src/session/entry.ts)

- user 分支:`md: \`> ${text}\`` → `md: text`;
- tool 五装配点:`md: toolMd(...)` → `md: ''`;`toolMd` 函数删除(v2log 同步去引);
- result 字段已是全量(text 全文+full 观测),首行截断是渲染职责——内核零改动。

### 3.2 journal v2(src/session/v2log.ts)

- **写**:tool seg 行 `md:''`(字段随行既有:callId/name/input + seg-update result);user seg 行
  裸文;
- **读(reduceV2Rows,一次性归一)**:tool kind 忽略行面 md(字段权威,旧档记号 md 丢弃);
  user kind 剥行面 `> ` 前缀(旧档归一)——读侧归一是迁移手段,写面单形态,无兼容层;
- seg-update:不再重算 md(纯字段回填)。

### 3.3 TUI(src/tui)

- commands-session entriesToChatItems:user 条剥 `> ` 防御分支删除(装载已归一);
  tool 条本就字段驱动(toolCallLine(name,input)+result.text)零改动;
- live 面零改动(pushMsg 原文/事件驱动 ToolRow);
- `●`/`⎿`/`▶` 记号在 TUI 各组件自绘处原地保留(它们本来就是渲染层的)。

### 3.4 GUI(gui/src)

- chat-reducer mapEntries:user 剥 `> ` 分支退役(内核已裸);tool 三字段直映已有(P4.1);
- ToolEntry:verbOf/resultOf/toolMdInfo 的 **md 解析退役**,改 entry 字段单源
  (name/input/result 皆直映字段;verb=name 本地化在 zhToolName);旧 md 兜底删除——
  字段恒在场(内核装配点全填,装载归一);
- 测试夹具更新:App.test/Chat.test 的 md-only tool 种子条改字段形态。

### 3.5 纯 API 消费者(未来)

GET snapshot 的 messages 即自描述 JSON:工具行无需任何渲染文档即可结构化呈现——本设计的验收
锚点之一。

## 4. 迁移与兼容

- 开发期无兼容承诺(§5 session-kernel spec 既有裁定):写面单形态;旧 v2 档读侧归一
  (tool 记号 md 丢弃/user `> ` 剥除)——字段在旧档中已全量(P2 起随档),零信息损失;
- GUI 上一轮(P4.1/c0b30de)的 toolMd JSON 嵌入随本设计移除——存在时长一天,无外部消费。

## 5. 测试

- kernel.test:user 裸文断言(`> 一`→`一`);tool 五装配点 md==='' 断言(替换全部 `●/⎿` 断言);
- v2log.test:往返等价(live md=''/重放 md='');旧档归一(记号 md+`> ` 前缀行装载);
- TUI:restore 用例(user 条不再剥前缀也正确;tool 条字段渲染回归);
- GUI:chat-reducer(user 裸文直映/字段直映已有);Chat.test 种子条渲染(折叠行目标/展开全文,
  夹具改字段形态);App.test 夹具同步;
- 全量:daemon 套件 0 fail、GUI 0 fail、tsc 双端。

## 6. 风险

1. **md 消费者遗漏**:全仓 grep `verbOf|resultOf|toolMdInfo|startsWith('> ')` 兜底清点
   (实施时编译器+测试双兜底);
2. **旧档 visual 断档**:旧 v2 档 tool 行装载后靠字段渲染,与 live 零差异(字段 P2 起全量)——
   无断档;
3. **anchors/firstUser 面**:user 输入历史走 journal `t:'user'` 行(裸文既有),与 seg md 无涉。
