---
name: 浏览器 Web 测试
description: 用 browser-use 插件（Playwright MCP）驱动真实浏览器做页面自动化与端到端验证：snapshot→按 ref 定位→操作→verify 的标准循环，含 tab 管理、浏览器形态与会话隔离说明、敏感工具 deny 建议
version: 0.1.0
---

# 浏览器 Web 测试（browser-use 插件）

本技能随 browser-use 插件装载，教模型用 `mcp__browser-use__*` 工具族驱动真实浏览器完成网页操作与验证。主线是**可访问性快照（a11y snapshot）**：模型读结构化页面树并按元素 ref 出牌操作，无需视觉模型即可稳定驱动页面。

前置：插件已启用（settings 语义键 `plugins.browser-use.enabled: true`；缺省关）。工具实际出牌名带前缀，即 `mcp__browser-use__browser_snapshot` 等，下文用短名。

## 标准循环（snapshot 主线）

1. **打开**：`browser_navigate` 传入 URL，进入目标页。
2. **读页**：`browser_snapshot` 取当前页可访问性快照——yaml 形态的 a11y 树，每个可交互元素带 `ref`（如 `s1e3`）。这是操作与定位的唯一依据。
3. **操作**：按快照里的 ref 定位元素出牌——`browser_click`（点击）、`browser_type`（输入文本，`submit: true` 顺带回车提交）、`browser_fill_form`（一次填多个表单字段，优先于逐个 type）、`browser_select_option`（下拉）、`browser_hover`（悬停）、`browser_press_key`（按键）。
4. **验证**：`browser_wait_for`（等文本出现 / 等文本消失，写操作后先等再断言）→ 断言族 `browser_verify_text_visible` / `browser_verify_element_visible` / `browser_verify_value`（值断言，checkbox 用 "true"/"false"）。断言族恒可用。
5. **查错**：行为不符预期时看 `browser_console_messages`（页面 console 输出）与 `browser_network_requests`（请求清单，`filter` 按 URL 正则筛）。

每轮操作都会改变页面：**ref 会过期**。下一轮定位前必须重新取快照，拿着旧 ref 出牌要么报错要么点错位。

## snapshot 省钱与过期

- **`browser_find` 优先**：只在当前页快照里按文本（大小写不敏感子串）或正则检索，返回命中节点及根路径上下文。只需定位一个元素拿它的 ref 时，比整页 snapshot 便宜得多——大页面上先 find，找不到再 snapshot。
- 整页 `browser_snapshot` 只在「需要通读页面结构 / 列举可操作项」时取；支持 `depth` 限深、`target` 限子树，可进一步控预算。
- `browser_take_screenshot` 截图仅供人看与视觉核对，**不能拿截图出牌**——操作永远走 snapshot ref。
- 截图/快照/下载等输出文件统一落在本会话的 `<项目 data>/plugins/browser-use/output/<会话>/`(显式 `filename` 也落这里),工具结果里给的是**绝对路径**——直接用该路径 Read/引用,不要在项目目录里搜索或猜相对路径。

## tab 管理

`browser_tabs` 四个动作：`list` / `new`（可带 url）/ `close`（带 index）/ `select`（带 index）。点击触发新开窗口、弹窗、`target=_blank` 链接都会产生新 tab：操作后若「页面没反应」，先 `browser_tabs list` 看是否实际开了新页，再 `select` 切过去继续。

## 浏览器形态与会话隔离

浏览器由运行环境自动决定,无需也无法配置:桌面应用=侧栏内置浏览器(你操作的就是用户眼前的侧栏页签),网页端=系统默认浏览器,命令行=无头浏览器。每个会话有独立的浏览器状态(Cookie/登录/本地存储/页签互不相通),重启后保留——在本会话登录过的网站下次仍是登录态;其他会话的页签对你不可见。

## 敏感面与 deny 建议

两个工具等价于把代码交给浏览器进程执行，不受信页面上有注入风险，严格的权限档建议直接禁掉：

- `browser_run_code_unsafe`：在 Playwright server 进程执行任意 JS（**RCE 等价**）。
- `browser_evaluate`：在页面内执行 JS 表达式。

settings.json 的 `permissions.deny` 示例（规则语法 `mcp__<server>__<tool>`，可尾 `*` 通配；两级合并取并集，项目级不可解除全局级）：

```json
{
  "permissions": {
    "deny": ["mcp__browser-use__browser_run_code_unsafe", "mcp__browser-use__browser_evaluate"]
  }
}
```

被 deny 后这些工具命中即拒，其余 browser-use 工具不受影响。另注意持久 `userDataDir` 即登录态凭据面（详见插件 README 的 Profile 与安全注记）。

## 端到端小示例

打开页面并断言标题文本：

```
browser_navigate { "url": "https://example.com" }
browser_verify_text_visible { "text": "Example Domain" }
```

带交互的完整一轮：

```
browser_navigate → browser_snapshot（通读，记下表单各字段 ref）
→ browser_fill_form（按 ref 批量填） → browser_click（提交钮 ref）
→ browser_wait_for（等成功提示文本出现）
→ browser_verify_text_visible / browser_verify_value（断言落地态）
→ browser_console_messages（确认无新增报错）
```
