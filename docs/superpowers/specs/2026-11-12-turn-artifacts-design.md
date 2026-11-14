# 轮末产物卡与产物库（turn artifacts）设计

日期：2026-11-12　分支：dev1　状态：已交付（2026-11-14 kind 化改宗 + 双网兜底 + 声明工具 `report_artifacts`）

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

**2026-11-14 kind 化改宗裁定（用户：「文件锚定狭隘——网址/启动命令/入口类产物非文件可表达」「对标 codex 什么类型都可以当产物」）**：产物 kind 化三类判别（file/url/command），模型显式声明工具 `report_artifacts` 为 kind/title/desc 唯一来源，声明面**不限白名单**（代码文件为主交付物时亦可声明——对齐 Codex「代码也上卡」语义）；自动三网只产 file 类且限白名单（降噪角色不变）。§0-2 的「非代码口径」自此仅约束自动网。

## 1. 不变量（唯一裁决规则）

> **产物集合由单一声明面在 run 收口时定形（`report_artifacts` 模型声明 ∪ write/edit 写盘声明 ∪ bash 双网兜底，按 `artifactKey` 去重：声明 > 差集 > 扫描），随 `RunMeta.artifacts` 落档重放；轮末卡区与产物库 tab 只是同一份 artifacts 的两个只读投影——任何渲染端不自行推导产物集合。**

## 2. 分层

| 层 | 职责 | 落点 |
|---|---|---|
| 类型登记 | `Artifact` 判别联合（kind 化）、`RunMeta.artifacts` 字段、交付物白名单常量 | `src/types.ts`（共享登记点惯例） |
| 内核工具面 | write/edit 落盘声明收集（白名单过滤 + 去重）+ `report_artifacts` 声明工具：`ArtifactCollector` 类仿 `write-snapshot.ts` 注入模式，装配期注入工具面 | 新增 `src/harness/tools/artifact-collector.ts`；`src/harness/tools/builtin.ts`（`commitFileWrite` 单点调钩 + `report_artifacts` 工具） |
| session（共享） | 收集器装配与 run 收口 drain、`sanitizeArtifacts`（与 `sanitizeTurn` 同位）、runmeta 帧扩字段 | `src/serve/session.ts`、`src/session/entry.ts`、`src/session/seglog.ts`（行映射/读侧合入） |
| serve | bash 兜底双网并入；`GET /session/:id/artifacts` 聚合端点 | `src/serve/session.ts`、新增 `src/serve/artifacts-handlers.ts`、`src/serve/daemon.ts` 路由 |
| 壳/打开 | `/app/open` 新 id `default`（系统关联打开） | `src/serve/editors-handlers.ts` |
| GUI 投影 | chat-reducer 摄入、轮末卡区（`ArtifactCardView` kind 三分支共用件）、产物库 tab、分类器/标签同形副本、分体钮共用件 | `gui/src/chat-reducer.ts`、`gui/src/pages/chat/`、`gui/src/pages/Artifacts.tsx`（新）、`gui/src/tabs/registry.tsx`、`gui/src/artifacts.ts`（新） |

TUI 零改动（runmeta 帧 TUI 已收；产物卡渲染为非目标，§7）。

## 3. 数据面

### 3.1 类型（2026-11-14 kind 化改宗：file/url/command 判别联合）

```ts
/** 产物（2026-11-14 kind 化,用户裁定「文件锚定狭隘——网址/启动命令/入口类产物非文件可表达」）：
 *  kind 判别三类;title/desc 仅声明面携带(模型给的人话名/说明,卡面一二行优先展示) */
export type ArtifactSource = 'write' | 'edit' | 'bash' | 'tool';
export type Artifact =
  | { kind: 'file'; path: string; source: ArtifactSource; callId?: string; title?: string; desc?: string }
  | { kind: 'url'; url: string; source: 'tool'; title?: string; desc?: string }
  | { kind: 'command'; command: string; source: 'tool'; title?: string; desc?: string };
/** 产物身份键（合流/去重单点）：file=path(归一 /),url=原串,command=trim */
export function artifactKey(a: Artifact): string { /* f:/u:/c: 前缀判别 */ }
```

`RunMeta.artifacts?: Artifact[]`（可选字段，旧档缺场 = 无产物）。GUI 侧同形局部声明于 `gui/src/artifacts.ts`（惯例同 `ChangeFile`：「gui 侧另有同形声明不引」）。**旧档迁移（读取侧一次性,非双轨）**：`sanitizeArtifacts` 对 kind 化前落档的 `{path,source}` 行升级为 `kind:'file'`——历史会话卡片照常渲染。

### 3.2 交付物白名单（非代码，单点常量；**2026-11-14 起仅约束自动三网**——声明面 `report_artifacts` 任意 kind 不限白名单,语义由模型负责+存在性校验兜底）

| 类目 | 扩展名 |
|---|---|
| 文档 | md / txt / pdf / rst |
| 图片 | png / jpg / jpeg / webp / gif / svg |
| 表格 | xlsx / xls / csv / tsv |
| 演示/富文档 | pptx / ppt / docx / doc |
| 数据 | json / yaml / yml / toml / xml |

代码类（ts/js/py/java/…）明确不进自动网。白名单常量内核侧落 `src/types.ts` 同文件；GUI 侧分类器 + 类目标签映射（「文档 · MD」形态：类目词 + 大写扩展名）落 `gui/src/artifacts.ts`，带纯函数测试。

### 3.3 内核声明点（自动网）

`commitFileWrite`（`builtin.ts:139`）落盘成功后：扩展名命中白名单 → 调注入的 `ArtifactCollector`（`src/harness/tools/artifact-collector.ts`，类仿 `WriteSnapshotCollector`：内存清单、drain 落盘、零工具面变化）记 `{kind:'file', path, source: 'write'|'edit'（按 verb）, callId}`。**同 run 同路径多次写保留末次**（末个 callId + 末个 source；先 write 后 edit 视同一条）。宿主 run 收口 `drain()` 并入 `RunMeta.artifacts`，经既有 runmeta 帧广播 + journal 落档。缺省不注入 = 无产物（CLI 一次性 run 等宿主零改动可选接入）。

### 3.4 bash 兜底（2026-11-14 口径放宽：双网）

run 收尾聚合处：bash 候选来自**两网并集，按 artifactKey 去重（声明 > 差集 > 扫描）**，64 帽（声明集在先）：

1. **git 差集网**：收尾差集中白名单命中的**新建**文件（`session.ts:1026` 面，git 项目可见面）；
2. **mtime 轮窗扫描网**（2026-11-14 用户实测 copy.png 缺卡补，`scanDeliverableFiles`）：有界遍历项目根（跳 node_modules/点目录，深 6 层/2 万条目封顶），白名单扩展名 + mtime 落 `[run起点-2s, 收尾+2s]` 即候选。

放宽理由：**默认工作区非 git**（实测 `Temp\sunshinex-default` 无 .git），差集网整面为空，bash 产件（skill 脚本产件主通道）全漏；扫描网同时覆盖 ignored 文件与未跟踪修改两类差集盲区。扫描网含修改（无前后像语义可判，凡轮窗内白名单文件即候选）；差集网自身仍只收新建。git 项目两网并集，同一文件不双记。

### 3.5 钳制与净化

- 单 run `artifacts` ≤ 64 条：声明集在先、兜底补足至帽，溢出静默截断（极端轮防炸）；
- `sanitizeArtifacts`（`entry.ts`，与 `sanitizeTurn` 同位同模式——seglog 行映射/`runMetaOf` 读侧合入）：kind 判别逐类校验（file=path+source 枚举；url=http(s) 形态；command=非空；title/desc 截 120），旧档 `{path,source}` 行读取侧升级 `kind:'file'`，脏行丢弃；
- 缩略图沿既有图片面（`MAX_IMAGE_CHARS` 8MB）；无新权限面（写入走既有权限闸，打开走 `/app/open` 白名单）。

### 3.6 声明工具 `report_artifacts`（2026-11-14 kind 化改宗新增，用户裁定「文件锚定狭隘——网址/启动命令/入口类产物非文件可表达」）

模型显式声明产物，**任意 kind 不限白名单**（语义由模型负责；file 落盘存在性校验防虚报，url http(s) 形态，command 非空，1-16 项，title/desc 用户语言）。schema 依房子公约：全字段进 required、可选项 null 联合（strict 兼容不变量钉桩口径）。声明条 source 钉 `'tool'`，合流时**遮蔽同 artifactKey 的推导条**并在卡前部展示；category `'read'`（纯内存登记零 IO 副作用）。提示词引导走工具 description 本体（收尾前登记主交付物；代码文件为主交付物时亦可声明——对齐 Codex「代码也上卡」语义）。自动三网保持白名单降噪角色不变，声明层补的是**意图与描述**。

## 4. GUI 轮末卡区（ArtifactsStrip）

### 4.1 位置与结构

`EntryViews.tsx` render 序：**助手正文 → ArtifactsStrip → RunChangesBar → RunFooter**。`footerRun.artifacts` 非空且 `conn/sessionId` 在场才渲染节（子智能体转录面无 conn 注入=自然不渲染）。节头仅右侧「全部产物」链接（`openTabInSession('artifacts')`；2026-11-14 用户裁定去「本轮产物 (N)」头文字、链接灰字降存在感）。

### 4.2 卡解剖（kind 三分支见 §4.5）

32px 圆角图标块 + 第一行（声明 `title` 优先,缺省基名/主机/命令首段；ellipsis + title 悬停全名）+ 第二行（声明 `desc` 优先,缺省类目标签「文档 · MD」）+ 右侧动作区。file 类：图标块=FileIcon 20px（白名单位图=32px 圆角缩略图 lazy 直显）。

### 4.3 网格与折叠

容器 `repeat(auto-fit, minmax(min(360px, 100%), 1fr))`（2026-11-14 用户裁定 `min()` 内联=窄容器卡宽跟随容器）行距 16px 列距 8px——1 卡独占整行、≥2 卡宽处两列（750 常态档即两列）、窄处自动单列；子卡 `min-width: 0`。单轮 >8 张：折叠为前两行 +「展开全部」（复用 RunChangesBar 折叠交互模式）；`auto-fit`（非 `auto-fill`）折叠空轨道保证单卡整行。

### 4.4 历史轮与子智能体

- `artifacts` 随 runmeta 落档重放（chat-reducer 既有 runmeta 摄入路径扩一字段），历史会话卡片照常渲染，零持久化新工作；
- 轮末卡区只渲染**主链 run** 的 artifacts；子 run 的产物仅进产物库（§6.4）。

> **2026-11-14 终审裁定**：fork 子代理与团队成员的写盘经共享 executor 闭包并入主轮 artifacts（其 run 不产 runmeta 行，独立归账后置）；主链卡区语义=「本轮（含委派）产出」——上条「子 run 的产物仅进产物库」的分流后置；产物库聚合面（§6.2 本就含子 run）不受影响。排除方案评估过否：fork 子面 `derive()` 浅克隆共享 executor 闭包，闭包既持装配期收集器也持装配期安全链（执行期链不入 write/edit 执行器），唯一内核既有执行上下文信号（`tasks.ts` ownerStorage 异步作用域）只包 spawn fork、不包团队成员与 loop/graph fork 面——补全需重构 fork 执行管线，超终审修复范围，故按本裁定改语义（spec 即真相）。

### 4.5 卡面 kind 三分支（2026-11-14 kind 化改宗，`ArtifactCardView` 共用件）

| kind | tile | 第一行 | 第二行 | 主钮 | ▾/副钮 |
|---|---|---|---|---|---|
| file | FileIcon(白名单位图=缩略图) | title??基名 | desc??「类目 · EXT」 | 侧栏预览 | 已装应用+系统默认 |
| url | Globe | title??主机+路径 | desc??「网站」 | **右栏 Web 页签内嵌打开** | 系统浏览器（`openExternalUrl`） |
| command | Terminal | title??命令首段 | desc??「命令」 | **复制命令**（useCopyFeedback 回显） | — |

第一行/第二行口径：声明 `title`/`desc` 优先，缺省按 kind 推导。url 主钮走既有 Web 页签（webview 内嵌,免外跳）；副钮系统浏览器；command 主钮仅复制不自动执行（声明命令未经审批闸,自动执行属后置）。

## 5. 打开交互（复用顶栏组件）

### 5.1 主钮「打开」（file 类）

`openTabInSession('file', {path})`：自动展开右栏 + 去重 + 聚焦；文本 Monaco/md 预览、图片 dataURL 直显（均已存在）。目录路径走既有重路由（`openDirectoryPath`）。无会话席位的打开路径复用 `openFileFromTree` 的 pending 队列语义。文件已被删 → 预览 404 既有错误面承接。url 类主钮=右栏 Web 页签（§4.5）；command 类主钮=复制（§4.5）。

### 5.2 ▾ 菜单

`SessionRowMenu`（顶栏同款浮层，坐标锚定 + 缩放归一）：列 `GET /app/editors` 实装项（资源管理器定位 / VS Code / Cursor，原生图标 PNG）+ 新增「系统默认」档。**菜单项点击 = 立即以该目标打开**（`POST /app/open {path, id, root?}`）——与顶栏「选中仅设默认」的反误触语义刻意区分：卡片菜单是单文件动作。外部打开失败走既有 `onOpError` 通道。

### 5.3 「系统默认」档

`/app/open` 新 id `default` 进白名单：Windows spawn `cmd /c start "" <path>` detached（`explorer.exe <文件>` 只定位不关联打开，故须独立一档）；macOS `open`、Linux `xdg-open` 对应接入，平台分支随 editors-handlers 既有平台面惯例。顶栏编辑器菜单**不**加此项（顶栏是「外部编辑器默认」设置位，系统默认与编辑器语义不同层）。

### 5.4 分体钮共用件

「打开 ▾」抽共用组件（主钮 + caret + SessionRowMenu 装配），轮末卡 file 类、产物库行同用；与顶栏 `sx-open-split` 的差异仅在语义（立即开 vs 设默认），样式同源。url/command 类卡不用此分体钮（各走 §4.5 专钮）。

## 6. 产物库（聚合入口）

### 6.1 tab 与行

`TAB_REGISTRY` `artifacts` 类型（singleton + REFRESHABLE）；行卡复用 `ArtifactCardView` 三分支（§4.5）；点行名 = file 类侧栏预览、url 类 Web 页签。跨 run 按 `artifactKey` 去重保留最新。

### 6.2 端点

`GET /session/:id/artifacts` → `{ items: (Artifact & {runSeq, endedTs?})[] }`：扫 journal 的 runmeta 行展平，**按 artifactKey 去重保留最新轮**（库语义），runSeq 倒序。与既有 `/session/:id/changes`（session-changes.ts）同构。含子 run。

### 6.3 刷新

进 tab 拉取（程序化开签即触发面板刷新 nonce，`REFRESHABLE_TAB_TYPES` 既有机制）+ 页签刷新钮重拉；无新旁路帧（复用既有 runmeta WS 面）。runmeta 帧到达时开着页签的自动重拉属后置（当前轮收尾后经刷新钮/重进页签取新——产品面足够，避免页签层订事件流的复杂度）。

### 6.4 空态

「暂无产物——助手产出的文档/图片/表格/网址/启动命令等会出现在这里」。

## 7. 非目标与边界

- **不做**（YAGNI）：TUI 产物卡渲染（runmeta 帧 TUI 已收，渲染后置）；产物版本时间线；收藏/检索；缩略图磁盘缓存（lazy 现拉）；skill 显式登记 API（声明 + bash 兜底已覆盖）；改动条与产物卡合并（两语义分立：改动 = diff 统计，产物 = 产出物）；command 卡自动执行（声明命令未经审批闸,复制/终端手动承接）。
- **无 git 项目**：bash 兜底第二网（mtime 轮窗扫描,2026-11-14 补,见 §3.4）不依赖 git——非 git 项目 bash 产件照常入卡；git 差集第一网缺席即为空,两网并集语义不变。
- **文案**：中文硬编码，与现 GUI 一致（不走 i18n 面）。
- **权限**：零新权限面。

## 8. 测试面

- **内核**：声明单点测试（write 交付物记 / write 代码不记 / edit 交付物记 / 同路径多次写保留末次 / 大小写扩展名命中）；`report_artifacts` 执行面测试（file 存在性校验防虚报/url 形态/command 非空/declare 入收集器）；收集器测试（declare 遮蔽同键推导/键保末次）；`artifacts` 随 runmeta 落档→重放往返测试（照 `turn-changes.test.ts:101` 模式,含 url/command 行）。
- **serve**：`sanitizeArtifacts` 判别校验测试（旧档行升级/file/url/command/坏行弃）；bash 兜底并入测试（白名单命中/未命中/声明优先去重/64 帽截断/三参扫描网）；`GET /session/:id/artifacts` 端点测试（空 / 多轮 / 跨 run 去重保最新 / 含子 run）。
- **GUI**：`gui/src/artifacts.ts` 判别联合+标签+身份键纯函数测试；chat-reducer 对 artifacts 字段的摄入测试。
- **手动验收清单**：写 md → 卡出现；脚本产 png → 兜底并入且 source=bash；主钮 → 侧栏预览并聚焦；▾ → 系统默认打开；历史会话回放 → 卡照常；>8 张 → 折叠展开；产物库 tab 与轮末卡集合一致；起服务/给网址 → 声明后 url 卡(网站)主钮右栏 Web 页签打开；声明启动命令 → command 卡复制。

## 9. 文件触点清单（预计）

| 文件 | 改动 |
|---|---|
| `src/types.ts` | `Artifact` 判别联合（kind 化）+ `artifactKey` + `RunMeta.artifacts` + 白名单常量 |
| `src/harness/tools/artifact-collector.ts`（新） | `ArtifactCollector` 类（仿 WriteSnapshotCollector 注入模式：内存清单/去重/drain/declare） |
| `src/harness/tools/builtin.ts` | `commitFileWrite` 声明钩（白名单过滤 + 调收集器）+ `report_artifacts` 工具注册 |
| `src/harness/tools/builtin.artifacts.test.ts`（新） | 声明钩/根外守卫/report_artifacts 执行面测试 |
| `src/session/seglog.ts` | runmeta 行映射/读侧合入 artifacts |
| `src/tui/session-journal.ts` | JournalEvent `runmeta` 成员扩 `artifacts`（落档面随行扩字段） |
| `src/serve/session.ts` | 收集器接线、bash 兜底双网并入、runmeta 帧扩字段、聚合端点数据面 |
| `src/serve/artifacts-handlers.ts`（新） | `mergeRunArtifacts` 双网并入 + `scanArtifactsJsonl` 聚合扫描 |
| `src/serve/daemon.ts` | 路由挂载 |
| `src/serve/editors-handlers.ts` | `/app/open` 新 id `default` + root 相对解析（平台分支） |
| `gui/src/artifacts.ts`（新） | 同形判别联合 + 分类器 + 类目标签 + 身份键 |
| `gui/src/chat-reducer.ts` | runmeta artifacts 摄入 |
| `gui/src/pages/chat/chat-types.ts` | `ChatProps.onOpenArtifacts`（产物库入口回调随链下泄） |
| `gui/src/tabs/tab-strip.test.tsx` | registry 位置断言（artifacts 页签位次随注册表扩位） |
| `gui/src/pages/chat/ArtifactsStrip.tsx`（新） + `EntryViews.tsx` | 轮末卡区（`ArtifactCardView` 三分支）+ render 序接线 |
| `gui/src/pages/Artifacts.tsx`（新） + `gui/src/tabs/registry.tsx` | 产物库 tab + 注册（onOpenWeb 走 web 页签） |
| `gui/src/pages/chat/OpenSplit.tsx`（新） | 「打开 ▾」主钮 + caret + SessionRowMenu 装配（file 类） |
| `gui/src/connection.ts` | `openInEditor` root 扩参 + `artifacts()` 聚合方法 |
| `gui/src/app.css` | 卡区/网格/行样式 |

## 附. 与 Codex 对标结论（2026-11-14 调研补）

- Codex 产物面 = 系统推导（工具效果记账）为主，非模型自报工具——本设计三网推导与之同构；
- Codex 卡面**不区分代码/非代码**（Edited 卡含代码文件）——本设计经 `report_artifacts` 声明面对齐（代码为主交付物可声明上卡），自动网仍限交付物降噪（用户裁定保留）；
- 网址/命令类非文件产物：文件锚定推导不可表达 → 声明工具 kind=url/command 承接（本设计 §3.6/§4.5）。
