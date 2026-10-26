# browser-use — sunshinex 内置插件（浏览器操作）

Playwright MCP（`@playwright/mcp`）驱动的浏览器自动化：以可访问性快照（a11y snapshot）为主线供模型读页与操作（导航/点击/填表/截图/PDF 等 `mcp__browser-use__*` 工具），无需视觉模型即可稳定驱动页面；`caps` 配置可按需开启 vision 等能力组兜底。

## 缺省与配置

- 缺省**未启用**（`defaultEnabled: false`）：在 settings 语义键 `plugins.browser-use.enabled: true` 后生效。
- 缺省浏览器 **chrome**（`configDefaults`），且缺省 **headed（有头）模式**：浏览器自动化强依赖真实用户环境语义（登录态、反爬、弹窗交互），无头运行是行为差异最大的常见翻车点，故缺省保持有头、由用户显式降级。

| config 键 | 类型 | 说明 |
| --- | --- | --- |
| `browser` | string | 浏览器：chrome\\|chromium\\|firefox\\|webkit\\|msedge（缺省 chrome） |
| `headless` | boolean | 无头模式（缺省 false，理由见上） |
| `isolated` | boolean | 内存临时 profile（登录态不持久） |
| `caps` | string | 能力组：tabs,pdf,devtools,network,storage,vision,testing |
| `userDataDir` | string | 持久 profile 目录（建议 `<dataDir>/plugins/browser-use/profile`） |

## Profile 与安全注记（spec §4.3）

浏览器 profile 即**高价值凭据面**：持久 `userDataDir` 内含登录态 cookie 与站点凭据，页面内脚本理论上可触达同域凭据。默认关闭即出于此——启用前请确认信任目标站点；如需持久登录态，把 `userDataDir` 指到专用目录而非日常浏览器 profile，避免与个人浏览环境混用。该插件未声明 safety 三类，全部工具走通用 MCP 审批问线（fail-closed 兜底）；`browser_run_code_unsafe`（server 进程任意 JS，RCE 等价）与 `browser_evaluate` 在不受信场景建议入 `permissions.deny`（见技能正文示例）。

## 随附技能

`skills/web-testing/`：面向模型的 Web 测试教程技能（snapshot→按 ref 定位→操作→verify 标准循环、caps 能力组、敏感面 deny 示例），插件启用后经技能装载链自动并入清单（id `web-testing`）。

详细使用文档见 MANUAL.md 插件章节（含**目标机首次启用前的依赖补装步骤**：`pnpm --dir plugins/browser-use install`）；插件开发规范见 PLUGIN-DEV.md。
