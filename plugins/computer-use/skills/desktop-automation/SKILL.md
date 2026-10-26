---
name: 桌面自动化
description: 用 computer-use 插件（MCP + PowerShell worker）驱动 Windows 桌面：先 screenshot/uia_snapshot 观察再动作的标准循环、坐标以最近一次截图 scale 元数据为基准、wait_for 省步数与敏感操作审批提示
version: 0.1.0
---

# 桌面自动化（computer-use 插件）

本技能随 computer-use 插件装载，教模型用 `mcp__computer-use__*` 工具族观察和操作 Windows 桌面。主线是**结构化 UIA 观察**：元素清单带 id/类型/名称/矩形，直接按坐标与名称出牌；截屏是兜底与视觉核对面。

前置：插件已启用且在 Windows（settings 语义键 `plugins.computer-use.enabled: true`；缺省关）。工具实际出牌名带前缀，即 `mcp__computer-use__screenshot` 等，下文用短名。

## 标准循环（先观察，后动作）

1. **观察**：优先 `uia_snapshot`（scope 缺省 `window`=前台窗口元素清单，`desktop`=桌面顶层概览）——读结构化元素（ControlType/Name/BoundingRect/enabled）定位控件、读文本，比截图便宜且可精确锚定；需要看视觉布局/图形界面时用 `screenshot`。`window_list` 列顶层窗口（标题/pid/Z 序/前台标记），找窗与核前台用它。
2. **对窗**：目标窗口不在前台时先 `app`（`focus` 按标题子串置前台；`launch` 拉起新进程）——键鼠输入永远落在前台窗口，先聚焦再动作。
3. **动作**：`click`（坐标点击，双击 `clicks:2`）、`type`（逐字符输入，`\n` 即回车）、`key`（组合键如 `["Ctrl","Shift","Esc"]`）、`scroll`（滚轮，可带坐标）、`drag`（两点拖拽：选区/滑块/搬窗）、`app`。
4. **验证**：`wait_for`（等 UIA 文本出现/消失，单调用内部轮询）或重取 `uia_snapshot`/`screenshot` 核对落点。

每轮动作都可能改变屏幕：**截图会过期**。下一轮点击前若屏幕可能已变（点了菜单、切了窗），必须重新截图再出坐标。

## 坐标基准（最易翻车点）

- click/scroll/drag 的坐标全部以**最近一次成功截图回传的 `scale` 元数据**为基准（`scale.sentWidth/sentHeight` 即你看到的那张图的像素空间）——server 侧自动反算回物理屏幕坐标，你不要自己做任何缩放置账。
- **谁截图谁坐标**：坐标只在「紧接其后」有效；中间插了任何改变屏幕的动作就作废，重截。
- 无有效截图时动作类（click/scroll/drag/type）直接报错引导先截图——看到该错误就先 `screenshot`，不要重试同一坐标。
- `uia_snapshot` 的 BoundingRect 是物理像素，与截图坐标系不同源：按元素操作优先走「截一张图 → 在图上对元素位置出坐标」。

## 省步数

- `wait_for` 优先于 `wait`+重截轮询：launch/点击后等某个文本出现，一次 `wait_for {target:"完成", timeout:15}` 顶掉「wait 2s → screenshot → 再 wait」的盲轮；`mode:"disappear"` 等加载指示消失同理。
- 只需定位控件/读文本时 `uia_snapshot` 优先于截图——省图片预算也免坐标换算。
- `screenshot` 支持按物理像素 `region [l,t,r,b]` 截局部（注意：region 截图的坐标基准仍是该张图自身的像素空间）。

## 审批与敏感操作

- **act 类（click/type/key/scroll/drag/app）任何档位强制审批**——每次点击、每次键入都会出审批卡，这是有意设计：键鼠直达真实用户环境。批量操作前先和用户对齐序列，减少逐拍打断；用户对某工具选「本会话总是放行」后该工具不再重复问。
- **screenshot 是 confirm 类**：首次出审批卡，用户「总是放行」后全会话直通。
- `uia_snapshot`/`window_list` 只读直放。`wait`/`wait_for` 未声明类别，走通用审批面。
- 桌面上可能有真人正在使用：动作序列尽量聚焦自己 launch 的窗口（标题唯一可核），避免在用户前台窗口盲点盲打；结束前把拉起的窗口收尾（关闭或还原）。

## 失败引导

- 动作报「先截图」类错误 → 先 `screenshot` 再出牌（见坐标基准）。
- `app focus` 报找不到窗口 → `window_list` 核对实际标题（启动慢时先 `wait_for` 窗口标题出现）。
- `key` 报 unknown key name → 查键名表（修饰键 Ctrl/Alt/Shift/Win；反斜杠等部分 OEM 键名不受支持，用组合替代）。
- 提权（管理员）窗口：注入可能静默无效、UIA 受限——动作后必须验证（截图/uia 核对落点），无效即换非提权路径，不要反复重试。

## 端到端小示例

打开记事本输入并验证（act 首次要过审批）：

```
app { "action": "launch", "target": "notepad" }      → 过审批，回 pid
wait_for { "target": "记事本", "timeout": 10 }        → 窗口就绪
screenshot {}                                         → scale 元数据 + 前台标题
click { "x": 640, "y": 400 }                          → 坐标取自上一张图，落编辑区
type { "text": "hello desktop" }
uia_snapshot {}                                       → 核对文本/脏态标记落地
```
