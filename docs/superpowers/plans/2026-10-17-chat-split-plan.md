# D32 Chat.tsx 上帝组件拆分实施计划（立项方案）

> 状态：**主体已清（批A/批A′/批B 数据部/批C-1…C-5 共九批落库，Chat.tsx 3324→1739，−48%）**；
> 余第六批（Chat() JSX 骨架 dock/composer 分解，需 props 面设计、风险升档）与 filePal UI 部
> 留置裁定（composer 键链域，见台账第二十轮）。进度详见 `docs/TECH-DEBT-LOG.md` D32 行与
> 第十三~二十一轮台账行。
> 台账：`docs/TECH-DEBT-LOG.md` D32（H·重，2026-10-17 清理轮普查登记）。

## 目标与锚点

`gui/src/pages/Chat.tsx` 3300+ 行、91 个 hooks（Chat() 组件本体约 1500 行）混杂
状态机/渲染/命令面板/差异条多职责。拆分为**行为零变化**的渲染件与 hooks 件，
公开导出面（TodoBatch、expandFileRefs、tokenDisplayText 等被 App/测试消费的符号）
保持原路径再导出，消费方零迁移。

**锚点**：gui 全量单测 + e2e（322+ 例，含 Chat.test/App.test/e2e.test 19 组）+
`pnpm --dir gui test` exit 0 门禁；拆分期间每批全绿后交付（D31 四批同 pattern）。

## 现状职责块（落库后需重盘点校准）

| 块 | 现位 | 目标 |
|---|---|---|
| 工具条目渲染器 ToolEntryView | 组件内约 480 行 | `pages/chat/ToolEntry.tsx` |
| 运行尾部操作条 RunChangesBar / run footer | 文件内组件 | `pages/chat/RunFooter.tsx` |
| 命令面板/技能命令数据面（cmdData/skillCmds） | Chat() 内 state+effect | `pages/chat/use-command-palette.ts` |
| 队列面（queued/pauseAndSend/续发泵） | Chat() 内 | `pages/chat/use-queue.ts` |
| 会话事件消费（onEvent 分流/回显/挂起卡重建） | Chat() 内 effect 簇 | `pages/chat/use-session-events.ts` |
| 文件面板（@ 提及/loadWorkspaceFiles/filesCacheRef） | Chat() 内 | `pages/chat/use-file-palette.ts` |
| token 显形/输入高亮 | 已部分共享导出 | 维持现位，落库后复核 |

拆分模式沿 D17（控制器薄委托保公开 API）与 D31（io/deps 注入、叶子模块）：
自定义 hook 返回内聚 state+action 包，Chat() 保留编排与 JSX 骨架。

## 批序（每批一步全绿）

1. **批A 渲染件**：ToolEntryView → ToolEntry.tsx（最大单件，纯渲染+回调 props）。
2. **批B hooks 三件**：use-command-palette / use-queue / use-file-palette。
3. **批C 事件簇**：use-session-events（onEvent 分流最大 effect 群）+ RunFooter。
4. **批D 收尾**：残留导出再导出归位、死代码扫（noUnused 已门禁）、行数复核。

## 验收标准

- `pnpm --dir gui test` 全绿且测试文件零改动（断言面不迁移）；
- Chat.tsx ≤ 800 行（编排+JSX 骨架），单件 ≤ 500 行；
- 公开符号消费方（App.tsx、projection、tests）import 路径零变化；
- 前缀缓存无关（渲染层拆分零触提示词面——CLAUDE §11 不适用本批）。

## 风险与既定裁定

- G14.211 在途（token 显形/思考卡）与本拆分同文件——**必须落库后再动刀**，
  落库前本计划仅立项不执行；
- e2e 静态挂载组对 DOM 结构敏感：渲染件搬运保持 DOM 树与 className 逐字节不变
  （搬移不重排），e2e 19 组为差分门禁；
- 拆分期间禁顺手改行为；发现缺陷登记台账不顺手修（只还债纪律）。
