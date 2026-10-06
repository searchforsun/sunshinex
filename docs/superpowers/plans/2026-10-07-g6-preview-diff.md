# G6 预览+diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 GUI 代码预览+diff 页:daemon `GET /session/:id/file` 只读端点(经 safety 路径判界)、预览页(语法高亮)、write 工具观察行 diff 并排;收编 G5 交接(Board GUI-e2e/newSession mode UI 面/板投影 seq 门)。

**Architecture:** 文件读取经 SessionRuntime 会话的 safety 链判界(与 read 工具同口径,拒绝越界与二进制);diff 数据零新端点——write 工具的 tool-call 帧已携带 input(path/old_string/new_string 现场核 schema),Chat 工具条展开即 diff;预览页 Board 同级 tab 或工具行 path 点击跳转。板投影 seq 门:App 级 board/delegations 投影加种子缓冲(与 Chat 的 pendingRef 同构——seq ≤ snapshot.lastSeq 的帧缓冲后丢,> 的在整替后重放)。

**Tech Stack:** TypeScript strict、React 18、highlight.js(gui 新依赖——主仓已有同名依赖但 gui 自管)、vitest。

**Spec:** `docs/superpowers/specs/2026-10-06-gui-v1-design.md`(§6.4、§12 G6、G5 交接清单)。

## Global Constraints

- 主仓 tsc strict 零报错、`pnpm test` 0 败(全量门禁仅 T3 控制器后台);gui typecheck+test 绿;看门狗 600s 协议。
- /file 端点会话路由(:id);路径判界经该会话 safety 链;二进制拒绝(content 探测前 8KB 含 \0 → 415 `{error:'binary file'}`);文件大小帽 512KB(超 → 413)。
- 事件 payload 结构化禁 ANSI;diff 数据来自既有 tool-call 帧。
- 注释中文决策风格。

## Rulings(计划级)

1. **/file 端点形态**:`GET /session/:id/file?path=<abs|rel>`——**相对路径以会话 root 解**(abs 也须落在判界内);判界用该会话 `harness.safety` 的路径判定(现场核 SafetyChain 读围栏 API——readFile 工具经 sandbox;**daemon 直读用 fs.readFile+safety 判界函数**(chain 的路径判定面,现场核函数名,如 underRoot/resolveSafe),不走 sandbox 读通道——daemon 是进程内可信读者);响应 `{path, content, truncated?: true}`(帽处截断)。
2. **语法高亮**:gui 依赖 `highlight.js`(对齐主仓版本口径 ^11);语言按扩展名映射(最小集 ts/tsx/js/json/md/css/html/py/rs/java/sh/yaml/xml,缺省纯文本);`hljs.highlight(code, {language})` 同步渲染 `<pre><code>`。
3. **diff 并排**:write 工具条(tool kind 条目)展开面板——old_string/new_string 双列 `<pre>`(等宽对齐,零算法依赖;行级差异着色可后置——v1 纯双列+标题行);无 old_string(新文件)只右列。
4. **预览页**:Chat 工具行(call/result)中 write 的 path 文本按钮化 → 打开 Files tab(会话内第三 tab)→ 高亮渲染;直接粘路径输入框也在。
5. **板投影 seq 门**:App 装配 board/delegations 的 onEvent 分支在 seeding 期(快照在途)缓冲帧(与 Chat pendingRef 同构 ref),onSeeded 整替后过滤 `seq ≤ snap.lastSeq` 丢弃、`>` 重放 apply(G5 交接 b 根修——丢一帧增量竞态闭合)。
6. **newSession mode UI 面**:Home 的 New session → DirPicker 确认后加一档「Manual approvals」勾选(缺省关)→ newSession(root, checked?'manual':undefined)(G5 交接 d);e2e 的 fetch 包装器退役改走真面。
7. **Board GUI-e2e**:G5 验收的 e2e 补全——真 daemon create_task(gated) → Board tab → DAG 盒断言 → gate Approve 点击 → 板状态流更新(交接 e)。

---

### Task 1: daemon /file 端点 + gui Files 页 + diff 面板

**Files:**
- Modify: `src/serve/daemon.ts`(/file 端点)
- Create: `gui/src/pages/Files.tsx`、`gui/src/diff-panel.tsx`、`gui/src/highlight.ts`(扩展映射+渲染助手)
- Modify: `gui/src/pages/Chat.tsx`(工具条 write path 按钮化 + diff 展开面板)、`gui/src/App.tsx`(Files tab)、`gui/src/connection.ts`(readFile(sessionId, path) 方法)
- Test: `src/serve/daemon.file.test.ts`(新)、`gui/src/files.test.tsx`(新)、`gui/src/App.test.tsx`(tab 扩)

**Interfaces:**
- Consumes: safety 路径判界(现场核 SafetyChain 公开判定面);tool-call 帧既有 input(payload.input 形态)
- Produces:
  - `GET /session/:id/file?path=` → 200 `{path: string; content: string; truncated?: boolean}` | 403 `{error:'path outside trusted roots'}` | 404(不存在/目录)| 413(>512KB)| 415(二进制)| 400(缺 path)| 404(会话)
  - Connection 增 `readFile(sessionId, path): Promise<FileResp>`
  - `highlightCode(code: string, lang?: string): string`(返回 HTML;扩展映射表);`Files({conn, sessionId, initialPath?})`(输入框+加载+高亮渲染+truncated 标);`DiffPanel({oldStr?: string; newStr: string})`(双列 pre)
  - Chat 工具条:tool 条目展开(折叠态一行 ● label,点击展开 DiffPanel(write)或 result 详情(其他工具);write 的 path 行按钮 → onOpenFile(path) 回调 → App 切 Files tab 带 path

- [ ] **Step 1: 失败测试**——daemon.file:判界内相对/绝对路径 200 内容;越界(../ 逃逸/他根)403;不存在 404/目录 404;>512KB 413+truncated 语义(帽内截断 truncated:true——**裁定:512KB 帽是 413 还是截断?Ruling 1 说截断;统一:≤512KB 全文,>512KB 截断至 512KB+truncated:true(不 413——预览语义,修正 Ruling 1)**;二进制 415;缺 path 400。gui files.test:输入加载渲染(truncated 标)/高亮映射;App:Files tab 切换/initialPath;Chat:write 条目展开 DiffPanel 双列/path 按钮。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **[ ] Step 4: 跑测** `pnpm build && node --test dist/serve/daemon.file.test.js` + `pnpm --filter sunshinex-gui typecheck && pnpm --filter sunshinex-gui test`
- [ ] **Step 5: 提交** `feat(serve/gui): 预览+diff——/session/:id/file 只读端点(safety 判界/二进制拒/512KB 截断);Files 页高亮(hljs);write 工具条 diff 并排面板+path 跳转`

### Task 2: 板投影 seq 门 + mode UI 面 + Board e2e + 门禁回写

**Files:**
- Modify: `gui/src/App.tsx`(board/delegations 种子缓冲)、`gui/src/pages/Home.tsx`+`DirPicker.tsx`(mode 勾选)、`gui/src/e2e.test.ts`(Board e2e + mode 真面迁移)
- Test: `gui/src/App.test.tsx`(seq 门)、`home.test.tsx`(勾选)

**Interfaces:**
- Consumes: T1 全部
- Produces:
  - App board/delegations 投影:seeding 期帧入 `boardPendingRef`(与 Chat pendingRef 同构),onSeeded 后 seq 过滤重放(G5 交接 b——onSeeded 回填窄竞态根修)
  - DirPicker 确认面板增 `manual approvals` checkbox(缺省不勾);Home newSession 传 mode
  - e2e:Board 全链(create_task gated → Board tab → DAG svg 盒+边断言 → Approve 点击 → 板状态更新 List 断言)+ manual 会话建走 UI 勾选(fetch 包装器退役)

- [ ] **Step 1: 失败测试**(App:seeding 期帧缓冲→整替后过滤重放,旧 seq 丢;home:勾选→newSession body 含 mode;e2e 两场景)
- [ ] **Step 2/3** 实现 → **[ ] Step 4** `pnpm --filter sunshinex-gui typecheck && pnpm --filter sunshinex-gui test && pnpm --filter sunshinex-gui run test:e2e`
- [ ] **Step 5: 提交** `feat(gui): 板投影 seq 门(种子竞态根修)+DirPicker manual 勾选(mode UI 面)+Board GUI-e2e 全链`

### Task 3: 全量门禁 + spec 回写(控制器)

- [ ] 主仓 `pnpm test` 后台;`pnpm selfcheck`;GUI spec §12 G6 行回写(含 Ruling 1 修正:512KB 截断非 413);提交 `docs(spec): G6 执行回写`
