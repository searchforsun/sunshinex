# 归档会话保留期与缓存清理（Archive Retention & Cache Clear）设计方案

- 日期：2026-11-21　分支：dev1　状态：**待用户审阅**
- 需求来源（2026-11-21 用户）：设置页增加清理归档会话的设置项——可设置归档会话保存的天数，到期自动清理，每天定时后台自动清理过期归档会话记录；增加清理缓存按钮，可在搜索框和托盘里快捷清理缓存，并正确识别哪些是缓存。
- 关联规格：`2026-11-20-scheduled-tasks-design.md`（ScheduleEngine 注入形态先例）、`2026-10-21 归档面`（`handleSessionArchive`/`handleSessionsArchived`）、CLAUDE.md §13 持久化分层、§15 语言规范。
- **口径声明（AskUserQuestion 未获答复，按推荐缺省执行，实现注记随码）**：①`images-cache`/`tool-outputs` 按「引用型缓存」处理——不进一键清理，仅设置页带警示单独清；②归档保留天数缺省 30 天，0 = 永不清理；③托盘/搜索一键清仅清「安全缓存」档。

---

## 0. 一句话定位

> **两条独立维护线**：①daemon 侧**保留期清扫器**——按语义键 `archiveRetentionDays` 每天扫一次全部工作区 + sunx 域，把归档超过 N 天的会话走既有 `purgeSession` 真清；②daemon 侧**缓存清点单点**——一份登记表识别「哪些是缓存」，`GET /cache` 报体积、`POST /cache/clear` 受控清理，设置页/搜索框/托盘三个入口共用同一端点，Chromium HTTP 缓存经壳 IPC 补位。

不碰主链、不新增会话形态、不引入第三方依赖（全 fs/node: 内置）。

---

## 1. 需求拆解

| 用户原话 | 设计含义 |
|---|---|
| 设置项：归档会话保存天数 | 新语义键 `archiveRetentionDays`（槽 `SUNSHINEX_ARCHIVE_RETENTION_DAYS`），设置页「存储」分组数字行，缺省 30，0 = 永不 |
| 到期自动清理 | 清扫器按 `archived:true && now − archivedAt > days` 判过期，命中走 `purgeSession` 真清（含 gui/tui 面档、tasks 台账、teams 目录级联，与删除端点同落点） |
| 每天定时后台清理 | daemon 侧定时器：启动延迟 5 分钟首扫 → 每 24h 一扫；last-run 戳落 `~/.sunshinex/retention-state.json`，daemon 重启即补扫错过的日期 |
| 搜索框/托盘快捷清理缓存 | `SearchAction` 注入「清理缓存」条目 + 托盘菜单②组加「清理缓存」项（`TrayAction` 增 `clear-cache`） |
| 正确识别哪些是缓存 | 缓存登记表单点（三档口径，§3），绝不触碰用户数据族显式列出 |

---

## 2. 非目标（本期不做）

- 不做逐会话粒度的原图回收（`images-cache` 内容寻址、跨会话共享，逐档引用扫描代价高——原图统一归缓存清理面管）。
- 不做定时清理的钟点配置（每天 = 启动 + 24h 节拍 + 补扫，不暴露「每天几点」设置项）。
- 不做浏览器登录态清理（webview 分区 `persist:sx-*` 的 cookie/localStorage 是用户数据，只清 HTTP cache）。
- 不做回收站/软删除——`purgeSession` 即真清（与既有删除端点同口径）。
- 不做缓存体积常驻监控——体积按需遍历计算（GET 触发），不缓存不轮询。

---

## 3. 缓存识别口径（登记表单点）

单点 `src/serve/cache-inventory.ts`：登记表（id / 安全档位 / 目录解析）+ 体积计算 + 受控清理。三档：

### 3.1 安全缓存（safe，一键清；可再生或纯暂存，零用户可感损失）

| id | 落点 | 说明 |
|---|---|---|
| `pty-replay` | `<userConfigDir>/pty-replay/` | 终端回放缓冲（pty-replay-store.ts 单点落盘） |
| `editor-icons` | `<userConfigDir>/gui/editor-icons/` | 编辑器图标缓存（可再生） |
| `compaction-archives` | 各 `<dataDir>/archives/` | 压缩折链全量归档——会话 jsonl 为逐字节权威（CLAUDE.md §3），归档仅安全镜像 |
| `tool-outputs` | 各 `<dataDir>/tool-outputs/` | 超限工具输出原文——链上留预览+恢复路径，清后旧恢复路径失效（预览仍在，判定安全档下限） |
| `plugin-logs` | 各 `<dataDir>/plugins/logs/` | MCP 宿主日志 |
| `computer-use-screenshots` | 各 `<dataDir>/plugins/computer-use/screenshots/` | 电脑操作截图暂存 |
| `http-cache` | Chromium（壳 IPC） | 主窗 session + 全部 `persist:sx-*` webview 分区的 `clearCache()`——cookie/登录态不动 |

### 3.2 引用型缓存（unsafe，仅设置页带警示单独清）

| id | 落点 | 警示 |
|---|---|---|
| `images-cache` | 各 `<dataDir>/images-cache/` | 附件原图唯一副本（journal 只存路径引用，images-cache.ts 头注裁定）——清理后历史消息图片不可查看、模型不可重读 |

`tool-outputs` 归安全档（预览在链上，损失可接受）但登记表允许 GUI 按档位区分展示；若用户后续裁定改列引用型，只动登记表一行。

### 3.3 绝不触碰（用户数据，登记表外显式注释）

`sessions/`、`memory/`、`skills/`、`kb/`、`teams/`、`tasks/`、`workspace.json`、`serve-token`、`settings.json`、`mcp.json`、`schedules.json`、`retention-state.json`、`gui/ui-state.json` 族、`plugins/browser-use/profile/`（内置浏览器登录态）、webview 分区 cookie/localStorage。

### 3.4 扫描范围

per-workspace 类目录 = `projectsRoot()` 全部 slug 的 `<slug>/data` + `sunxContainerDir()` 各域 `<jid>/data`（与归档列表同形扫描）；全局类落 `userConfigDir()`。`GET /cache` / `POST /cache/clear` 恒跨全部工作区（缓存是全局性维护动作，不按当前会话工作区切分）。

---

## 4. 归档保留期清扫器（`src/serve/retention.ts`）

### 4.1 设置键

`SEMANTIC_KEYS` 增 `archiveRetentionDays: 'SUNSHINEX_ARCHIVE_RETENTION_DAYS'`（settings.ts 唯一权威；GET/PUT /settings 与设置面自动可达）。解析口径：整数值，两级语义——**未设键→30（缺省启用，需求「到期自动清理」即缺省期望）**；设 `0`→显式永不清理；设负值视同 0。设置行 desc 双语注明「0 = 永不清理，缺省 30 天」。

### 4.2 纯件与扫描

- `selectExpiredArchived(rows, now, retentionDays)`：纯函数，返回过期 journal id 集（`archived===true && archivedAt 为有限数 && now − archivedAt > days×86400_000`）。
- 扫描面：`projectsRoot()` slug 枚举 + `sunxContainerDir()` 域枚举（同形第 4 处——为不加剧 D89 同构债，slug/dataDir 枚举抽 `listWorkspaceDataDirs()` 小帮手由本文件与 `sessions-list-handlers` 共用）。
- 命中即 `purgeSession(dataDir, jid)` + `purgeSideJournals(dataDir, jid)`（side 全家同清，与删除面级联一致）。
- **跳过在座会话**：daemon 注入 `isKnownSession(jid)` 谓词（runtime 表按 `attachedJournalId` 反查）——运行中/在座会话本轮跳过（下轮再判），不做运行时回收（删除端点的 async teardown 流程不适合后台批量面）。
- 逐项容错：单会话清失败记数不阻断整轮；整库不可读静默零命中。

### 4.3 定时与补扫

- 依赖注入形态同 ScheduleEngine（`now`/`setTimeout` 可注入）。
- 启动：daemon `start()` 尾部（`scheduleEngine.start()` 之后）布防——延迟 5 分钟首扫（不拖启动），此后每 24h 一扫；`close()` 收定时器。
- 补扫：`~/.sunshinex/retention-state.json`（`SUNSHINEX_DATA_DIR` 重定向同 schedules.json 口径）记 `lastRunAt`；布防时若 `now − lastRunAt ≥ 24h` 即刻补扫（不等 5 分钟延迟）——覆盖长期未启动后首启场景。
- 运行结果：`{ ranAt, days, scanned, purged: [{slug|'sunx', jid}], failed }` 写回 state 文件，`GET /cache` 透出（设置页「上次自动清理」行）。控制台一行日志（`[retention]`）。

---

## 5. 缓存端点（daemon 路由表）

- `GET /cache` → `{ total, categories: [{ id, safe, size, files }], retention: { days, lastRunAt, lastCleaned } }`。体积按需 `fs.statSync` 遍历（目录缺席=0，不建目录）；`retention.days` 读槽实时值。
- `POST /cache/clear` `{ categories?: string[] }` → 缺省 = 全部 safe 档（不含 `http-cache`——Chromium 归壳侧）；逐项清（rm 目录内容保留目录本身，幂等），返回 `{ cleared: [{ id, freed }], failed: [{ id, error }] }`。请求含 unsafe 档 id 时照清（设置页警示后动作）——端点不二次拦截，警示责任在 UI。
- handler 收口 `src/serve/cache-handlers.ts`（ConfigHandlerIo 同款薄 io 接缝），路由注册 daemon.ts 路由表 `/cache` 族。
- daemon 回执恒英文（§15）；双语标签由 GUI 本地映射表承接（id 稳定）。

---

## 6. 壳侧（Chromium HTTP 缓存 + 托盘）

- 壳 `main.ts`：webview 分区登记——`win.webContents.on('will-attach-webview', …)` 收集 `persist:sx-*` 分区名入 Set；`ipcMain.handle('shell:clear-cache')`：主窗 session `clearCache()` + 已登记分区逐个 `session.fromPartition(name).clearCache()`，返回 `{ ok, partitions }`。启动既有的一次性 `clearCache()`（523de0e8）保留不动。
- `preload.ts`：`sunshinexWindow.clearHttpCache()` 桥出；`env-global.d.ts` 同形补声明（`?.` 容忍浏览器态）。
- 托盘：`TrayAction` 增 `{ kind: 'clear-cache' }`；`TRAY_LABELS` 增 `clearCache`（en 'Clear cache' / zh '清理缓存'）；`trayMenu()` ②组「快捷键」之后插入；`sendTrayAction` 既有通路直达 GUI——主进程已唤窗，GUI 收帧后执行清理并 toast。
- `lifecycle.test.ts` 菜单形状用例同步更新。

---

## 7. GUI 三个入口

### 7.1 设置页「存储」分组

- `settings-groups.ts` 基础组（Basics，恒显）插入 `{ id: 'storage', title: { en: 'Storage', zh: '存储' } }`（「模型与提供方」之后、「快捷键」之前）。
- 新组件 `gui/src/settings/StoragePane.tsx`（SettingsShell renderPane 增 case），两张卡：
  - **归档会话**：保留天数数字行（`data-setting-key="archiveRetentionDays"`；读 `conn.settings()` 行、按 `row.source` 归桶写回，引擎语义同 SettingsForm；desc 说明「0 = 永不清理」）+ 上次自动清理时间行（只读，来自 GET /cache retention）。
  - **缓存**：总占用行 + 逐分类行（双语名 + 体积 + 单独清理钮；safe/unsafe 分区，unsafe 行警示色文案）+「清理缓存」主按钮（一键清全部 safe 档含浏览器 HTTP 缓存）。
- `settings-search.ts` 增静态行条目（`archiveRetentionDays`、`cache`）——搜索「清理缓存/存储」直达对应行。
- `KEY_DESCRIPTIONS` 增 `archiveRetentionDays` 条目（label + en/zh 说明）。

### 7.2 搜索框

`searchActions`（App.tsx 既有注入面）增 `{ id: 'clear-cache', en: 'Clear cache', zh: '清理缓存', run: clearCacheNow }`——一键清 safe 档，toast 回显释放量。

### 7.3 托盘

`trayActionRef` 增 `clear-cache` 分支：调用与搜索框同一 `clearCacheNow` 稳定回调（daemon 清理 + `window.sunshinexWindow?.clearHttpCache?.()` 并行、toast 回显；失败走 `showOpError`）。

- toast 文案（`use-op-error.ts` 扩 `showOpMessage(msg)` 共槽正反两用）：zh「已清理缓存，释放 X」/ en 'Cache cleared — freed X'；`http-cache` 结果并入（壳不可用=浏览器态，静默省略）。

---

## 8. 错误处理

- 清扫/清理单项目失败不阻断整轮（逐项记账；`failed` 数组回传，UI 折叠展示失败 id）。
- 体积遍历遇权限/消失目录按 0 计（`try/catch` 幂等，与 purgeSession 同纪律）。
- 壳 IPC 缺席（浏览器态/旧壳）：`?.` 跳过，仅 daemon 侧清理，toast 不提浏览器缓存。
- retention state 文件坏档：视同未清扫过（补扫一次），不炸启动。

---

## 9. 测试计划

- 主仓（`pnpm test`，数据目录钉 `.data-test`）：
  - `retention.test.ts`：`selectExpiredArchived` 边界（恰满 N 天/未归档/archivedAt 缺失/0 天=全跳）；临时 dataDir 落档→sweep 真清全家（含 side 级联、gui/tui 面档）；在座跳过谓词；补扫（state 文件 lastRunAt 早于 24h）；days≤0 不清。
  - `cache-inventory.test.ts`：登记表枚举（临时 projectsRoot/sunx 容器/userConfigDir 定向）；体积计算；clear freed 记账；unsafe 档不清用户数据族（断言 sessions/memory 目录原样）。
  - `settings.test.ts` 既有键表用例补 `archiveRetentionDays` 槽映射；daemon 路由冒烟（GET /cache 形状）。
- GUI（vitest + testing-library）：StoragePane 渲染（天数行读写、分类行体积、清理按钮调 conn、警示文案）；settings-search 新行条目；trayAction clear-cache 分支单测（App 级）。
- 壳（vitest）：`lifecycle.test.ts` 菜单形状（新项位置/双语标签）。
- 门禁：`pnpm build` → `pnpm test` → `pnpm --dir gui run test` → `pnpm --filter sunshinex-shell run test`；GUI 源码改动 `pnpm gui:build` 后 deploy 生效（壳源码改动须 reinstall）。

---

## 10. 技术债关联

- slug/dataDir 枚举第 4 处同构：抽 `listWorkspaceDataDirs()` 共用帮手，不新登债（D89 既有登记不变）。
- 本设计不新增登记表债务；实现若遇不可收敛点按 docs/TECH-DEBT.md 流程补登。
