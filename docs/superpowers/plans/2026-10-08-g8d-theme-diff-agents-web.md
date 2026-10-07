# G8d 主题统一(青色)+ Diff/Agents/Web 标签 + 交互清单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 依 G8 spec v9 §3(U-D21 主题裁定)+§2 Diff/Agents/Web 行+§5 交互清单+§7 G8d 行:青色主题令牌重定与全组件圆润简约 polish、Diff/Agents/Web 三类标签接线、交互人性化清单落地、G8c 遗留小项(agents 全文端点/退役键告警)。

**Architecture:** 主题=app.css 令牌单源换值+组件类 polish 巡检(测试钩子类名零迁移,既有套件即回归面);Diff/Agents/Web=registry 三新条目复用 G8a 框架;Agents 事件面=gui 侧纯 reducer 消费既有 payload.subagent 流(G8a-T7 已入口过滤,本批接住)。

**Tech Stack:** 全既有(零新依赖)。

**Spec:** `docs/superpowers/specs/2026-10-07-gui-redesign-design.md`(v9)。

## Global Constraints

- 主仓改动白名单:src/serve/daemon.ts+daemon.test.ts(agents 全文端点);其余零改动。gui 白名单:gui/src/app.css/tabs/(registry/DiffTab/AgentsTab/WebTab/agent-activity)/pages/Chat.tsx(connection 既有 fetchDiff 已有)/connection.ts/App.tsx/App.test.tsx/settings/RawPane.tsx/e2e.test.ts。越界即违规。
- 主题令牌(U-D21 逐字):`--accent: #22d3ee`(hover/pressed `#06b6d4`);`--radius: 10px` 基准+pill/Badge `999px`+图标钮 8px;`--fg-1: #9aa7b3`;间距 12px 基准;xterm 主题(XTERM_THEME 字面量)与 conn-dot 在线态同步 accent;**测试钩子类名零迁移**(既有 199+17 套件即回归门)。
- Diff 标签:registry 'diff'(by callId 多实例);Chat write 条目 path 钮改开 diff 标签(spec §2 Diff 行);渲染复用既有 diff-panel.tsx 逻辑(fetchDiff 既有)。
- Agents 标签:registry 'agents' 单例;gui/src/tabs/agent-activity.ts 纯 reducer(按 label 聚合 payload.subagent 事件:token/tool-call/tool-result→卡状态+最近 20 行 mini 转录);App 事件分流接住(G8a-T7 过滤的事件喂此 store);onUsage 冗余守卫清理(G8a 缓议)。
- Web 标签:registry 'web'(by url 多实例);iframe sandbox="allow-scripts allow-forms allow-same-origin allow-popups"+外开钮(window.open)+刷新+加载失败提示(title 提示,jsdom 不渲染 iframe 内容属预期)。
- 交互清单(spec §5 剩余项):textarea 自增高(1-6 行,Shift+Enter 换行/Enter 提交——G8a 已迁 textarea,本批补自增高)/流式光标 1.5px 闪烁竖线/状态条重排(图标+数字组)/gate ⚠ Badge 组件/hover 一致性巡检/空态文案统一。
- watchdog:逐任务聚焦测试,T6 全量;git add 仅点名;提交规约 feat(gui)/feat(serve)。

## File Structure

```
gui/src/app.css                [T1] 令牌重定+polish 段
gui/src/tabs/registry.tsx      [T2/T3/T4] 三新条目(+图标)
gui/src/tabs/DiffTab.tsx       [T2] +pages/Chat.tsx 接线改开 diff
gui/src/tabs/agent-activity.ts [T3] 纯 reducer(+test)
gui/src/tabs/AgentsTab.tsx     [T3] 卡+mini 转录
gui/src/tabs/WebTab.tsx        [T4] iframe+外开
gui/src/App.tsx                [T3] 事件分流+TabStrip 图标补 TerminalSquare
gui/src/pages/Chat.tsx         [T5] textarea 自增高/流式光标/状态条/Badge
gui/src/connection.ts          [T3] agentBody()
gui/src/settings/RawPane.tsx   [T5] 退役键告警列表(高级面)
gui/src/e2e.test.ts            [T6] 新场景
src/serve/daemon.ts(+test)     [T3] GET /settings/agents/body
```

---

### Task 1: 青色主题令牌重定 + 组件 polish 巡检

**Files:** Modify `gui/src/app.css` / `gui/src/tabs/TerminalTab.tsx`(XTERM_THEME 同步)/`gui/src/tabs/TabStrip.tsx`(若 TAB_ICONS 补 terminal——顺 G8b 缓议 SquareTerminal)。

**Interfaces:** Produces: 令牌新值面(--accent #22d3ee/--accent-strong #06b6d4/--fg-1 #9aa7b3/--radius 10px);pill 全圆/图标钮 8px/hover/focus/阴影/留白 polish。

- [ ] Step 1: app.css 重定:①:root 令牌换值(accent/accent-strong/fg-1/radius;bg 系微调可选保持)②sx- 类巡检:标签 pill/badge → 999px;图标钮 8px;菜单浮层阴影 `0 4px 16px rgba(0,0,0,0.4)`+10px 圆;组行/导航去竖 border 以 bg 层次;面板 padding 12px;hover 态统一 --bg-2;focus-visible 2px accent 环不变③conn-dot 在线态 accent 化(在线=accent 点)。
- [ ] Step 2: TerminalTab XTERM_THEME 字面量同步(cursor/selection 用 #22d3ee 系);TabStrip TAB_ICONS 补 `terminal: SquareTerminal`(G8b 缓议清偿)。
- [ ] Step 3: 验证:`pnpm --dir gui exec vitest run`(全量零迁移绿)+`pnpm --dir gui run typecheck`。视觉面=无自动门禁(spec §6 既判),终审人审收口。
- [ ] Step 4: Commit `feat(gui): G8d-T1 青色主题统一——令牌重定+圆润简约 polish+xterm/图标同步`

### Task 2: Diff 标签接线

**Files:** Create `gui/src/tabs/DiffTab.tsx`;Modify `gui/src/tabs/registry.tsx`/`gui/src/pages/Chat.tsx`(tool-path 钮改 onOpenDiff)。

**Interfaces:** registry 'diff':group 'content'/title (p)=>p.callId ?? 'Diff'/resolveKey (p)=>p.callId ?? ''/singleton false/render=(p)=><DiffTab conn sessionId params={callId}/>。Chat 既有 onOpenFile(path) 面改双通道:props 增 onOpenDiff(callId, path)(App 接 openTabInSession('diff',{callId})——**App.tsx 同改**);DiffTab:mount conn.fetchDiff(sessionId, callId)(既有方法)→双列渲染复用 gui/src/diff-panel.tsx 既有导出(读实况选形)/404 no-snapshot 降级单列现内容或错误条;title 显示 path(params 可带 path 传 or 应答 path)。

- [ ] Step 1: 失败测试(App.test 增):write 条目点击→diff 标签开且活动(title=callId 或 path);404 面→错误条;同 callId 重开判重。
- [ ] Step 2: 实现 → [ ] Step 3: vitest src/App.test.tsx 绿+typecheck → [ ] Step 4: Commit `feat(gui): G8d-T2 Diff 标签——write 条目接线/callId 多实例/404 降级`

### Task 3: Agents 标签 + agent-activity reducer + 全文端点

**Files:** Create `gui/src/tabs/agent-activity.ts`+`agent-activity.test.ts`+`gui/src/tabs/AgentsTab.tsx`;Modify `gui/src/App.tsx`(事件分流)/`gui/src/tabs/registry.tsx`/`gui/src/chat-reducer.ts`(onUsage 冗余守卫删)/`gui/src/connection.ts`(agentBody)/`src/serve/daemon.ts`+`daemon.test.ts`(GET /settings/agents/body?id=&scope=)。

**Interfaces:**
```ts
// agent-activity.ts(纯)
export interface AgentActivity { label: string; status: 'running'|'done'|'error'; tokens: number; currentTool?: string; lines: Array<{ kind: 'tool'|'text'|'token'; text: string }> }
export type AgentActivities = Readonly<Record<string, AgentActivity>>;   // key=label
export function applyAgentEvent(s: AgentActivities, e: SessionEvent): AgentActivities;
// e.payload.subagent(标签)+e.type 分派:tool-call→currentTool+lines push;tool-result→status/行;token→tokens 累计+lines push(截 120);delegation-started(label)建卡 running;delegation-ended→done;error 系→error;lines 尾部 20 行滑窗
// connection.ts:agentBody(scope:'project'|'global', id:string, root?:string):Promise<{body:string}>
// daemon:GET /settings/agents/body?scope&id&root →200 {body}(读 <scopeDir>/agents/<id>/agent.md 正文;id 正则守卫;缺 404)
// registry 'agents':单例/group 'session'/render=AgentsTab(activities 经 render props?——App 态提进来:render props services 已有,扩 services.agentActivities?最小:AgentsTab props activities 由 App 侧闭包注入——registry render 签名固定,经 services 增字段 agentActivities 传递)
```
- App 分流:onEvent 中 payload.subagent 在场→applyAgentEvent(setAgentActivities)不入 chatSink(既有入口过滤处接住);onReset/onResetSession 清 activities。
- AgentsPane(T9)编辑装载全文:编辑钮→conn.agentBody(source,id,root)→body 播种(替 bodyPreview;守卫 bodyPreview≥200 分支自然退役为兜底)。
- onUsage 冗余守卫删(chat-reducer.ts 入口过滤已覆盖)。

- [ ] Step 1: 失败测试:agent-activity 纯测(聚合/滑窗 20/状态流转)+App.test(subagent 事件进 activities 不进 Chat 流;AgentsTab 卡渲染)+daemon.test(body 端点往返/404/坏 id)。
- [ ] Step 2: 实现 → [ ] Step 3: 聚焦绿(vitest agent-activity+App+daemon)→ [ ] Step 4: Commit `feat(gui,serve): G8d-T3 Agents 标签——事件聚合 reducer+卡+全文端点+AgentsPane 全文装载`

### Task 4: Web 标签

**Files:** Create `gui/src/tabs/WebTab.tsx`;Modify `gui/src/tabs/registry.tsx`。

**Interfaces:** registry 'web':group 'tools'/title (p)=>p.url ?? 'Web'/resolveKey (p)=>p.url ?? ''/singleton false;WebTab:url 输入框+「打开」/iframe(sandbox 上述四值;key=url 重挂)/「外开」(window.open(url,'\_blank','noopener'))/「刷新」(iframe key bump)/加载失败 title 提示(jsdom 不支持 iframe 加载——测试断言输入/打开/外开钮回调与 url 框架在场即可)。

- [ ] Step 1-4 同环(App.test:url 输入→打开→iframe title=url;同 url 判重)。Commit `feat(gui): G8d-T4 Web 标签——iframe 沙盒/外开/刷新`

### Task 5: 交互清单落地 + 退役键告警

**Files:** Modify `gui/src/pages/Chat.tsx`(textarea 自增高 1-6 行+流式光标+状态条图标数字组+gate ⚠ Badge)/`gui/src/settings/RawPane.tsx`(退役键+未知键告警列表——GET /settings 现不透出 warnings?**最小面:parseSettingsFile flatten warnings 需透出**——裁定:GET /settings 应答增 warnings 字段(未知/退役键 flattenWarnings——daemon 小改+connection 类型+RawPane 渲染;daemon.ts/connection.ts 入白名单))。

- [ ] Step 1: 失败测试:Chat textarea rows 随内容 1-6;流式条末光标类在场(streaming 态);状态条 tokens/steps 图标组;Badge 替代 ⚠ 文本;RawPane 告警列表(桩 warnings 渲染)。
- [ ] Step 2: 实现 → [ ] Step 3: 聚焦绿 → [ ] Step 4: Commit `feat(gui,serve): G8d-T5 交互清单——输入自增/流式光标/状态条/Badge/退役键告警透出`

### Task 6: e2e + 全量门禁 + spec 注记

**Files:** Modify `gui/src/e2e.test.ts`/spec §7 G8d 行。

e2e 两场景:①write 条目→diff 标签全链(真 daemon write 影子快照——既有 write 场景卡片复用,断言双列/标签判重)②Agents 标签 live 卡(taskboard 卡片流跑 delegation→activities 卡在场+mini 转录行)。门禁:gui 全量+e2e(19)+主仓聚焦(daemon/session/pty/subagent)。spec G8d 行划线注记+已知跟进回填(终审后)。

- [ ] Step 1-5 同环。Commit `feat(gui): G8d-T6 e2e+门禁` + `docs(spec): G8d 交付注记`

---

## Self-Review(已执行)
1. 覆盖:v9 §3 令牌/pill/xterm=T1;§2 Diff/Agents/Web 行=T2/T3/T4;§5 剩余=T5;G8c 遗留全文端点+退役键=T3/T5;G8b 缓议 terminal 图标=T1。2. 无占位(T5 warnings 透出已裁定 daemon+connection 面)。3. 类型一致:applyAgentEvent/AgentActivities/agentBody 签名 T3 内自洽;services.agentActivities 扩字段与 registry render 消费一致。
