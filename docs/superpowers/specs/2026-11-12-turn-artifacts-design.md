# 轮末产物卡与产物库（turn artifacts）设计

日期：2026-11-12　分支：dev1　状态：草案（三题口径已裁定；spec 待用户审阅）

## 0. 背景与现状

对标（2026-11-12 调研轮）：Codex 桌面端的三层结构——①线程内联产物卡（文件/产物名 + "Open in ▾"，出现在助手提到或改动该文件的位置）；②轮末 "Edited N files" 汇总卡（每文件 diff 统计 + 轮内 Undo/Review），明确取向是**卡片保持 summary-level，细节委托给面板/编辑器**；③Artifacts 侧栏（Project summary pane：plans/sources/outputs/artifacts 一处看，富预览 PDF/表格/演示文稿/图片）。打开交互语义 = 应用内预览为默认，"Open in ▾" 下拉才选外部应用。

现状链路（代码实证）：

- run 收尾元数据：`runmeta` 帧（`src/types.ts:293-294`）广播 + journal 落档同步 pump；`RunMeta`（`src/session/entry.ts:18`）已带 `changes`（git 变动增量）与 `turn`（轮次 checkpoint 前后像 blob hash）；落档/重放往返有测试兜底（`src/serve/turn-changes.test.ts:101`）。
- 内核写盘单点：`write`/`edit` 两工具收口在 `commitFileWrite`（`src/harness/tools/builtin.ts:139`），verb 区分 `written`/`edited`——声明钩的自然落点。
- bash 面增量：run 收尾已算出「收尾差集 = 本轮 bash 面增量」（`src/serve/session.ts:1026`）——skill 脚本产件（pdf/pptx/xlsx 类交付物主要产出通道）的唯一可见面。
- GUI 轮尾渲染：`EntryViews.tsx:727-737` 现 render 序 = `RunChangesBar`（改动统计条，`RunFooter.tsx:54-235`）→ `RunFooter`（复制/fork/统计）；改动条是 diff 统计语义，不承载「产出物」。
- 打开组件：顶栏 `sx-open-split` 分体钮（`ChatTopbar.tsx:357-384`）主钮经 `POST /app/open` 开默认应用，caret 开 `SessionRowMenu` 浮层（`gui/src/sidebar/session-row-menu.tsx:30-90`，条目全参数化，全 app 4+ 处在用）列 `GET /app/editors` 实装项（explorer 恒有/vscode/cursor，原生图标 PNG 缓存）；顶栏菜单项点击**仅设默认不启动**（反误触裁定，`ChatTopbar.tsx:188-189`）。
- 侧栏预览：`openTabInSession('file',{path})`（`App.tsx:514-527`）自动展开右栏 + 去重 + 聚焦；文本 Monaco 只读 + md 格式化预览，图片扩展名 base64 dataURL 直显（2026-10-26 落，`Files.tsx:200-201`、`src/serve/file-handlers.ts:248-276`）。
- 图标：`FileIcon`（`gui/src/file-icon.tsx`）离线 vscode-icons 全集，size prop 任意放大；无扩展名→人类类目标签映射。

缺口：本轮交付物（文档/图片/表格/演示/数据）没有专属呈现与聚合入口；改动条不区分「产出物」与「代码改动」；历史轮产物无处可查。

用户裁定（2026-11-12，三题口径）：

1. **产物是正式新能力**：要有专属聚合入口（对标 Codex Artifacts 面板），不是复用改动数据的换皮；
2. **收录范围 = 非代码交付物**：文档/图片/表格/演示/数据进产物，代码文件不进（改动条管代码语义）；
3. **识别 = 内核显式声明为主**（write/edit 工具面声明）+ bash 收尾差集白名单兜底（纯声明会漏掉 skill 脚本产件——hybrid 为硬理由，非偏好）。

布局与打开裁定（2026-11-12 同日前置对话）：

- 单卡独占整行；多卡 `repeat(auto-fit, minmax(360px, 1fr))` 网格（750 常态档即两列，窄处自动单列）；子卡 `min-width: 0`；单轮 >8 张折叠（前两行 + 展开全部，复用改动条折叠交互模式）；
- 主钮「打开」= 侧栏预览（`openTabInSession`）；▾ 菜单项 = **立即以该目标打开**（与顶栏「仅设默认」刻意区分：卡片菜单是单文件动作，顶栏是设置位）。

## 1. 不变量（唯一裁决规则）

> **产物集合由单一声明面在 run 收口时定形（write/edit 写盘声明 ∪ bash 收尾差集白名单兜底，按 path 去重声明优先），随 `RunMeta.artifacts` 落档重放；轮末卡区与产物库 tab 只是同一份 artifacts 的两个只读投影——任何渲染端不自行推导产物集合。**

## 2. 分层

| 层 | 职责 | 落点 |
|---|---|---|
| 类型登记 | `ArtifactFile` 形、`RunMeta.artifacts` 字段、交付物白名单常量 | `src/types.ts`（共享登记点惯例） |
| 内核工具面 | write/edit 落盘声明收集（白名单过滤 + 去重）：`ArtifactCollector` 类仿 `write-snapshot.ts` 的注入模式，装配期注入工具面 | 新增 `src/harness/tools/artifact-collector.ts`；`src/harness/tools/builtin.ts`（`commitFileWrite` 单点调钩） |
| session（共享） | 收集器装配与 run 收口 drain、`sanitizeArtifacts`（与 `sanitizeTurn` 同位）、runmeta 帧扩字段 | `src/serve/session.ts`、`src/session/entry.ts`、`src/session/seglog.ts`（行映射/读侧合入） |
| serve | bash 兜底并入收尾差集；`GET /session/:id/artifacts` 聚合端点 | `src/serve/session.ts`、新增 `src/serve/artifacts-handlers.ts`、`src/serve/daemon.ts` 路由 |
| 壳/打开 | `/app/open` 新 id `default`（系统关联打开） | `src/serve/editors-handlers.ts` |
| GUI 投影 | chat-reducer 摄入、轮末卡区、产物库 tab、分类器/标签同形副本、分体钮共用件 | `gui/src/chat-reducer.ts`、`gui/src/pages/chat/`、`gui/src/pages/Artifacts.tsx`（新）、`gui/src/tabs/registry.tsx`、`gui/src/artifacts.ts`（新） |

TUI 零改动（runmeta 帧 TUI 已收；产物卡渲染为非目标，§7）。

## 3. 数据面

### 3.1 类型

```ts
/** 轮次产物行（2026-11-12 用户裁定「非代码交付物 + 内核显式声明」）：内核写盘时刻声明或
 *  run 收尾 bash 差集兜底并入；随 RunMeta.artifacts 落档重放 */
export interface ArtifactFile {
  /** 项目根相对路径（/ 分隔） */
  path: string;
  /** 声明来源：write/edit=内核工具面写盘声明；bash=收尾差集兜底（callId 缺省） */
  source: 'write' | 'edit' | 'bash';
  /** 末次写入的调用关联（diff 寻址/后续跳转用；bash 兜底无） */
  callId?: string;
}
```

`RunMeta` 增 `artifacts?: ArtifactFile[]`（可选字段，旧档缺场 = 无产物，回放零迁移）。GUI 侧同形局部声明于 `gui/src/artifacts.ts`（惯例同 `ChangeFile`：「gui 侧另有同形声明不引」）。

### 3.2 交付物白名单（非代码，单点常量）

| 类目 | 扩展名 |
|---|---|
| 文档 | md / txt / pdf / rst |
| 图片 | png / jpg / jpeg / webp / gif / svg |
| 表格 | xlsx / xls / csv / tsv |
| 演示/富文档 | pptx / ppt / docx / doc |
| 数据 | json / yaml / yml / toml / xml |

代码类（ts/js/py/java/…）明确不进。白名单常量内核侧落 `src/types.ts` 同文件；GUI 侧分类器 + 类目标签映射（「文档 · MD」形态：类目词 + 大写扩展名）落 `gui/src/artifacts.ts`，带纯函数测试。

### 3.3 内核声明点

`commitFileWrite`（`builtin.ts:139`）落盘成功后：扩展名命中白名单 → 调注入的 `ArtifactCollector`（新 `src/harness/tools/artifact-collector.ts`，类仿 `WriteSnapshotCollector`：内存清单、drain 落盘、零工具面变化）记 `{path, source: 'write'|'edit'（按 verb）, callId}`。**同 run 同路径多次写保留末次**（末个 callId + 末个 source；先 write 后 edit 视同一条）。宿主 run 收口 `drain()` 并入 `RunMeta.artifacts`，经既有 runmeta 帧广播 + journal 落档——重放往返由既有机制承担，补一条往返测试（§8）。缺省不注入 = 无产物（CLI 一次性 run 等宿主零改动可选接入）。

### 3.4 bash 兜底

run 收尾聚合处（`session.ts:1026` 收尾差集 = bash 面增量）:**差集中白名单命中的新建文件**并入 `source:'bash'`（callId 缺省）；与声明集按 path 去重，**声明优先**（同路径既有声明条不覆盖）。修改类交付物不经兜底进来（只声明面收），原因：差集无前后像语义，修改标注不可靠，且修改的代码文件 majority 落改动条——产物面只对「新产出的交付物」兜底。

### 3.5 钳制与净化

- 单 run `artifacts` ≤ 64 条：声明集在先、兜底补足至帽，溢出静默截断（极端轮防炸）；
- `sanitizeArtifacts`（`entry.ts`，与 `sanitizeTurn` 同位同模式——seglog 行映射/`runMetaOf` 读侧合入）：path 串校验 / source 枚举收敛，脏行丢弃；
- 缩略图沿既有图片面（`MAX_IMAGE_CHARS` 8MB）；无新权限面（写入走既有权限闸，打开走 `/app/open` 白名单）。

## 4. GUI 轮末卡区（ArtifactsStrip）

### 4.1 位置与结构

`EntryViews.tsx:727-737` render 序改为：**助手正文 → ArtifactsStrip → RunChangesBar → RunFooter**。`footerRun.meta.artifacts` 非空才渲染节。节头：「本轮产物 (N)」+ 右侧「全部产物 →」链接（`openTabInSession('artifacts')`，程序化开 tab 自动展开右栏——既有语义）。

### 4.2 卡解剖

32px 圆角图标块（`FileIcon` 20px，surface-soft 底）+ 文件名（白、加粗，ellipsis + title 悬停全名）+ 类目标签「文档 · MD」（灰，`gui/src/artifacts.ts` 分类器）+ 右侧「打开 ▾」分体钮（§5）。图片扩展名：图标块换 32px 圆角缩略图（`GET /session/:id/file` 图片分支 base64，`<img loading="lazy">`，多图轮不阻塞首帧）。

### 4.3 网格与折叠

容器 `display:grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap:8px`——1 卡独占整行、≥2 卡宽处两列（750 常态档即两列，每卡 ~371px）、窄处自动单列；子卡 `min-width: 0`。单轮 >8 张：折叠为前两行 +「展开全部」（复用 RunChangesBar 折叠交互模式）；`auto-fit`（非 `auto-fill`）折叠空轨道保证单卡整行。

### 4.4 历史轮与子智能体

- `artifacts` 随 runmeta 落档重放（chat-reducer 既有 runmeta 摄入路径扩一字段），历史会话卡片照常渲染，零持久化新工作；
- 轮末卡区只渲染**主链 run** 的 artifacts；子 run 的产物仅进产物库（§6.4）。

## 5. 打开交互（复用顶栏组件）

### 5.1 主钮「打开」

`openTabInSession('file', {path})`：自动展开右栏 + 去重 + 聚焦；文本 Monaco/md 预览、图片 dataURL 直显（均已存在）。目录路径走既有重路由（`openDirectoryPath`）。无会话席位的打开路径复用 `openFileFromTree` 的 pending 队列语义。文件已被删 → 预览 404 既有错误面承接。

### 5.2 ▾ 菜单

`SessionRowMenu`（顶栏同款浮层，坐标锚定 + 缩放归一）：列 `GET /app/editors` 实装项（资源管理器定位 / VS Code / Cursor，原生图标 PNG）+ 新增「系统默认」档。**菜单项点击 = 立即以该目标打开**（`POST /app/open {path, id}`）——与顶栏「选中仅设默认」的反误触语义刻意区分：卡片菜单是单文件动作。外部打开失败走既有 `onOpError` 通道。

### 5.3 「系统默认」档

`/app/open` 新 id `default` 进白名单：Windows spawn `cmd /c start "" <path>` detached（`explorer.exe <文件>` 只定位不关联打开，故须独立一档）；macOS `open`、Linux `xdg-open` 对应接入，平台分支随 editors-handlers 既有平台面惯例。顶栏编辑器菜单**不**加此项（顶栏是「外部编辑器默认」设置位，系统默认与编辑器语义不同层）。

### 5.4 分体钮共用件

「打开 ▾」抽共用组件（主钮 + caret + SessionRowMenu 装配），轮末卡、产物库行同用；与顶栏 `sx-open-split` 的差异仅在语义（立即开 vs 设默认），样式同源。

## 6. 产物库（聚合入口）

### 6.1 tab 与行

`TAB_REGISTRY` 新 `artifacts` 类型；行式列表（与 Files 页同密度）：图标块 + 名称 + 类目标签 + 来源轮标注（run 序/相对时间）+「打开 ▾」（§5.4 共用件紧凑变体）；点击行 = 侧栏预览。

### 6.2 端点

`GET /session/:id/artifacts` → `{ items: [{path, source, callId, runSeq, ts}] }`：扫 journal 的 runmeta 行展平，**按 path 去重保留最新轮**（库语义），ts 倒序。与既有 `/session/:id/changes`（session-changes.ts）同构。含子 run。

### 6.3 刷新

进 tab 拉取（程序化开签即触发面板刷新 nonce，`REFRESHABLE_TAB_TYPES` 既有机制）+ 页签刷新钮重拉；无新旁路帧（复用既有 runmeta WS 面）。runmeta 帧到达时开着页签的自动重拉属后置（当前轮收尾后经刷新钮/重进页签取新——产品面足够，避免页签层订事件流的复杂度）。

### 6.4 空态

「本轮暂无产物」+ 一句说明（产物 = 助手产出的文档/图片/表格等交付物）。

## 7. 非目标与边界

- **不做**（YAGNI）：TUI 产物卡渲染（runmeta 帧 TUI 已收，渲染后置）；产物版本时间线；收藏/检索；缩略图磁盘缓存（lazy 现拉）；skill 显式登记 API（声明 + bash 兜底已覆盖）；改动条与产物卡合并（两语义分立：改动 = diff 统计，产物 = 产出物）。
- **无 git 项目**：bash 兜底依赖的收尾差集来自 session-changes 既有面，git 缺席时随该面既有语义降级，不新增特殊分支。
- **文案**：中文硬编码，与现 GUI 一致（不走 i18n 面）。
- **权限**：零新权限面。

## 8. 测试面

- **内核**：声明单点测试（write 交付物记 / write 代码不记 / edit 交付物记 / 同路径多次写保留末次 / 大小写扩展名命中）；`artifacts` 随 runmeta 落档→重放往返测试（照 `turn-changes.test.ts:101` 模式）。
- **serve**：`sanitizeArtifacts` 净化测试；bash 兜底并入测试（白名单命中/未命中/声明优先去重/64 帽截断）；`GET /session/:id/artifacts` 端点测试（空 / 多轮 / 跨 run 去重保最新 / 含子 run）。
- **GUI**：`gui/src/artifacts.ts` 分类器与标签纯函数测试；chat-reducer 对 artifacts 字段的摄入测试。
- **手动验收清单**：写 md → 卡出现；脚本产 png → 兜底并入且 source=bash；主钮 → 侧栏预览并聚焦；▾ → 系统默认打开；历史会话回放 → 卡照常；>8 张 → 折叠展开；产物库 tab 与轮末卡集合一致；子 run 产物只进库不进卡。

## 9. 文件触点清单（预计）

| 文件 | 改动 |
|---|---|
| `src/types.ts` | `ArtifactFile` + `RunMeta.artifacts` + 白名单常量 |
| `src/harness/tools/artifact-collector.ts`（新） | `ArtifactCollector` 类（仿 WriteSnapshotCollector 注入模式：内存清单/去重/drain） |
| `src/harness/tools/builtin.ts` | `commitFileWrite` 声明钩（白名单过滤 + 调收集器） |
| `src/session/seglog.ts` | `sanitizeArtifacts`（与 sanitizeTurn 同位同模式） |
| `src/serve/session.ts` | 收集器接线、bash 兜底并入、runmeta 帧扩字段 |
| `src/serve/artifacts-handlers.ts`（新） | `GET /session/:id/artifacts` 聚合端点 |
| `src/serve/daemon.ts` | 路由挂载 |
| `src/serve/editors-handlers.ts` | `/app/open` 新 id `default`（平台分支） |
| `gui/src/artifacts.ts`（新） | 同形类型 + 分类器 + 类目标签映射 |
| `gui/src/chat-reducer.ts` | runmeta artifacts 摄入 |
| `gui/src/pages/chat/ArtifactsStrip.tsx`（新） + `EntryViews.tsx` | 轮末卡区 + render 序接线 |
| `gui/src/pages/Artifacts.tsx`（新） + `gui/src/tabs/registry.tsx` | 产物库 tab + 注册 |
| 分体钮共用件（新，gui/src/ 内聚位） | 「打开 ▾」主钮 + caret + SessionRowMenu 装配 |
| `gui/src/app.css` | 卡区/网格/行样式 |
