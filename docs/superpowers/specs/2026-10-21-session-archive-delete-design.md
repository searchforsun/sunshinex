# 会话归档与受控删除设计(/archive · /delete)

- 日期:2026-10-21
- 状态:已批准(会话内分段评审,用户逐段确认)
- 轮次:会话整理能力首轮(brainstorming 产出;承接 G14.2xx 刷新恢复/归档语义空缺)
- 裁定记录:用户裁定——①归档标记落共享层旁车 meta(方案 A,B/C 否);②GUI 既有删除入口(顶栏 Delete、侧栏行 hover 垃圾桶)全部退役,删除只存在于归档页;③归档后方可删除,删除=真清文件(旧「daemon 回收留 journal」语义退役);④`/archive` 与 `/delete` TUI/GUI 公用;⑤撤销归档不设 TUI 命令(GUI 归档页/顶栏撤销足够);⑥归档页数据范围=当前 daemon 服务根下全部工作区,跨工作区聚合、行标注来源项目。

---

## 1. 背景与问题

会话档(`<projects 根>/<slug>/data/sessions/<journalId>.jsonl + .meta.json`)只有「存在/删除」两态,没有组织层:

- 侧栏会话列表随时间无限增长,陈旧会话无法收纳(只能靠眼力忽略);
- 删除入口有两处(会话顶栏 Delete、侧栏行 hover 垃圾桶),语义是「daemon 内存回收、journal 保留」——既不能真正清理磁盘,又随时可对任何会话误触;
- 双面无「归档」概念:TUI/GUI 对会话生命周期管理的唯一手段就是上述半删。

业界对标(Claude Code / 常规 IM 工作台):归档=轻量标记态,归档会话移出主列表但完整可用,删除是归档之后的受控重操作。

## 2. 目标与非目标

**目标**

- 会话新增 **archived 标记态**(纯标记,零行为差异):落共享层旁车 meta,TUI/GUI 同源可见;
- `/archive`、`/delete` 两条斜杠命令,TUI/GUI 公用(命令清单单源 + 底层操作共享函数);
- GUI:侧栏行 hover 归档(行内二次确认)、顶栏 Delete 退役换归档、「项目」组头归档页(跨工作区聚合、标注来源项目、行内撤销/红删除二次确认)、主列表与最近会话滤除归档;
- 删除门禁:未归档 409;归档态删除=真清全部会话档(journal + meta + 两面私有档)。

**非目标**

- 不做自动归档策略(按时间/按项目批量归档);
- 不做 TUI `/unarchive` 命令(⑤);TUI `/resume` 与主列表同口径滤除归档会话,GUI 归档页是唯一归档浏览面;
- 不做跨 daemon 服务根聚合(⑥)——GUI 一次只连一个 daemon;
- `side` 辅助会话(/btw 旁路档)不设归档入口(本就被全列表滤除,不阻拦直接打标)。

## 3. 方案选型(归档标记落哪)

| 方案 | 落点 | 结论 |
|---|---|---|
| **A(采纳)** | `SessionSidecarMeta`(`data/sessions/<journalId>.meta.json`)加 `archived`/`archivedAt` | 与 `side` 辅助标记同款先例;列表零重放直读;TUI/GUI 天然同源;符合 CLAUDE.md §13 分层裁定(归档=两面共有语义,禁面私有副本) |
| B | journal 行类型(可重放) | `listSessions` 现为零重放直读 meta 的性能设计,为低频状态破坏它不值 |
| C | `gui/` 面私有 | 违反 §13——换交互面即丢,排除 |

## 4. 数据层(共享单点,`src/tui/session-journal.ts`)

```ts
export interface SessionSidecarMeta {
  // …既有键不动…
  /** 归档标记(2026-10-21):纯标记态——主列表/RECENTS/TUI /resume 滤除,会话本体零行为差异 */
  archived?: boolean;
  /** 归档时刻 epoch ms(归档页排序;撤销即删键) */
  archivedAt?: number;
}
```

- `SIDECAR_KEYS` 扩两键;`SIDECAR_BOOL_KEYS` 加 `archived`(`archivedAt` 走既有 number 校验通道);坏档容错语义照旧(值型不合法即弃键)。
- 新增共享帮手(与 `writeSessionMeta` 同文件,daemon/TUI 共同消费):
  - `markSessionArchived(dataDir, id, archived: boolean)`——写 `archived` + `archivedAt`(撤销时两键同删);
  - `purgeSession(dataDir, id)`——真清单点:删 `<id>.jsonl` + `<id>.meta.json` + `gui/sessions/<id>.json`(+ `tui/` 会话私有档若有则清;工作区级 `tui/ui-state.json` 不触)。文件缺失静默跳过(幂等),目录随之清空则移除。
- `listSessions` 直读 meta 即得归档态,消费方按需滤除(见 §5/§7)。

## 5. daemon 接口(`src/serve/daemon.ts` + `session-handlers.ts`)

| 路由 | 语义 |
|---|---|
| `POST /session/:id/archive` body `{archived?: boolean}` | 缺省 true;`markSessionArchived`;running 409(先停再归档,与 delete 同门禁);会话不存在 404 |
| `GET /sessions/archived` | 跨工作区扫描 serve 根下各 slug 的 `data/sessions/*.meta.json`,返回 `{slug, workspaceName, id(journalId), title, updatedAt, archivedAt}[]`,按 `archivedAt` 降序——归档页数据源,来源项目标注出于此 |
| `POST /session/:id/delete`(语义升级) | **未归档 409**(文案「先归档后再删除」);归档态:daemon 内存会话先回收(现逻辑)→ `purgeSession` 真清文件;running 依旧 409 |

- 旧「journal 保留」语义退役:原语义的职责(下架但留档可重开)由归档态接管;删除即彻底消失。
- `handleSessions` / `handleSessionsRecent`:服务端滤除 `archived === true`(与 `side` 同款滤除位)——GUI 侧栏、最近会话、TUI `/resume` 三处消费方口径自动一致,归档会话从主列表消失但 attach/重开链路不设限。

## 6. 命令面(`/archive` · `/delete`,TUI/GUI 公用)

- `src/tui/slash-commands.ts`:`SLASH_COMMANDS` 追加 `'/archive'`、`'/delete'`,`slashCommandDescriptions()` 补双语描述(`/help` 文案同源)。
- TUI(`commands-session.ts`):`/archive` 对当前会话 `markSessionArchived(true)`,回执「已归档」;运行中报错「先停止运行再归档」。`/delete`:未归档报错「先归档后再删除(/archive)」;归档态 `purgeSession` + 清内存态,软重置到新会话(等价 `/new` 落点)。
- GUI:命令面板经 `GET /commands` 自动获得两命令(supported 清单含 daemon 侧解释),提交走 daemon 路由——与按钮同一条链;**清单、描述、底层操作三层共用,无平行实现**。

## 7. GUI 交互(对齐用户 mockup)

- **侧栏会话行 hover**:垃圾桶退役 → 归档箱图标;点击 → 行内红色「确认」二次确认(现 delete 确认形态复用);running 会话点击提示「先停止运行」。
- **会话顶栏**:Delete 退役 → 归档钮(同二次确认);已归档会话顶栏显示「已归档」徽标 + 撤销归档钮(会话内一键撤销)。
- **归档页**:「项目」组头加归档箱图标钮进入;整页视图(与欢迎页同导航层级)。两行式行:标题 + 来源项目小字(来自 §5 接口的 `workspaceName`);行 hover 右侧 `[撤销归档] [红色删除]`,红删除行内二次确认;点击行 = 切换到来源工作区(复用既有工作区切换链)后按既有 attach(journalId) 链正常打开会话——归档会话聊天零差异。
- **主列表**:archived 滤除(§5 服务端滤除直达);最近会话组同口径。

## 8. 边界与错误处理

- **running 矩阵**:归档/删除对 running 会话一律 409,GUI 侧按钮禁用态 + 提示;TUI 报错文案。
- **app 指针兜底**:指针指向已删会话——恢复链既有容错(journal 缺失即不恢复),无需新逻辑;
- **并发**:删除前先回收 daemon 内存会话再清文件(现 delete 顺序保留);归档为纯 meta 写,无内存态;
- **缺档**:归档接口对 journal 缺失 404 不静默;purge 幂等(缺文件跳过)。

## 9. 测试计划

| 层 | 断言 |
|---|---|
| journal 层 | archived/archivedAt 读写与撤销删键;坏档容错(类型不合法弃键);purge 清理清单断言(jsonl/meta/gui 私有档消失,工作区级不触)与幂等 |
| daemon 路由 | archive/unarchive 打标回读;running 409;delete 门禁(未归档 409 → 归档后 200 且文件消失);`GET /sessions/archived` 跨工作区聚合与排序;`/sessions`、`/sessions/recent` 滤除归档 |
| TUI slash | /archive 打标回执;/delete 未归档报错、归档态删除后软重置;/help 与面板清单含新命令 |
| GUI | 侧栏行归档确认流;顶栏徽标+撤销;归档页渲染(来源项目标注/撤销/红删除确认);点击归档行切工作区开会话;主列表滤除;typecheck + 全量门照跑 |

## 10. 交付形态

共享层 1 文件(session-journal)+ daemon 2 文件 + TUI 命令 2 文件 + GUI 约 6 文件(connection/ChatTopbar/侧栏/归档页/App)+ 各层钉测;`pnpm test` + GUI 全量 + typecheck 门全绿后交付,提交前用户浏览器实测验收。
