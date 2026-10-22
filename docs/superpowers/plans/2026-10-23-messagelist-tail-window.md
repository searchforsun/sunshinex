# D48 立项:MessageList 尾部窗口渐进回放

> 立项日期 2026-10-23。登记:docs/TECH-DEBT-LOG.md D48(性能·重)。

## 问题

MessageList 对 `entries` 全量渲染(`groupEntriesByDay(entries).flatMap`,无虚拟化无上限):
长会话(2k+ 条目)DOM 无界增长——滚动/重渲染渐卡、内存无界。主仓 TUI 有 tail-rewrite
2000 条上限,GUI 无对应面。

## 方案裁决:尾部窗口 + 渐进回放(非全量虚拟化)

两候选中取尾部窗口,理由:
1. **回归面**:全量虚拟化(react-virtuoso 类)与本流 UI 的贴底跟随/seg-collapse 分组/run 折叠/
   流式分域/归并动画深度耦合,动刀即回归三十余测试与 e2e;尾部窗口是纯渲染截取,上述机制零接触。
2. **架构对齐**:主仓 TUI tail-rewrite 上限口径同构(尾部窗口+更早内容按需取回),无第二范式。
3. **交互形态**:会话流是底部追加型日志,热区恒在尾部;头部历史是冷数据,渐进回放(点按展开)
   即可,无需任意跳转的常驻虚拟化。

## 设计

- `RENDER_WINDOW_DEFAULT = 300` / `RENDER_WINDOW_STEP = 300`(MessageList 模块常量)。
- `visibleCount` state(默认 300):`cut = entries.length - visibleCount`,渲染 `entries.slice(cut)`
  + 头部「显示更早的 M 条」按钮(点击 visibleCount += STEP 渐进回放)。
- **切点回退**:cut 落在 run 折叠隐区(Worked 头后的隐藏行)会劈开折叠组——回退到首个非隐藏
  边界(hiddenKeys 逐键回退),折叠组随头完整保留。
- **视口锚定**:展开前记 (scrollHeight, scrollTop),渲染后 `scrollTop += ΔscrollHeight`
  (useLayoutEffect)——用户视口不动,内容向顶部生长。
- 会话切换随 Chat remount 自然重置(App `key={openSessionId}`)。
- 流式尾部追加不受影响(窗口从尾部计)。

## 验收标准

1. 长会话(320+ 条目)渲染 DOM 条目数 ≤ 窗口值,头部「显示更早」行在场且计数正确。
2. 点击步进回放:条目数增加、全部回放后头部行消失。
3. 会话 < 300 条:零行为变化(无头部行)。
4. 既有测试全绿(run 折叠/工具聚合/流式分域/贴底锚定零改动咬合)。

## 批次

- **批1(本批)**:窗口+切点回退+渐进回放+视口锚定+测试。
- **批2(可选,后续)**:切点对 seg 边界的精确吸附、滚动到顶自动回放(交互打磨,视使用反馈)。
