# 会话恢复对标 CC：活动指针收编 + resume 子命令 + 数据目录口径收敛 设计规格

> 日期：2026-09-22 ｜ 状态：待用户评审
> 关联：`docs/superpowers/specs/2026-09-17-session-persistence-resume-design.md`（会话持久化基座）、`2026-09-20-session-rewind-fork-design.md`（rewind/fork）、`2026-09-21-cli-tui-interaction-redesign.md`（CLI 判界与命令风格）、`2026-09-22-event-level-journal-persistence-design.md`（事件级落盘）

## 1. 背景与目标

- 显式活动指针 `sessions-active.json` 是多实例并发下唯一会被互相覆盖的单值会话状态（后写者覆盖，`--continue` 指到另一实例的会话）；Claude Code 无此文件，「最近会话」按会话档元数据解析。
- `SUNSHINEX_DATA_DIR` 当前登记为「测试与多实例自行分区」口；多实例分区属伪需求——会话档天然按 id 隔离、共目录共存即 CC 形态，该变量实际只有开发测试消费（run-tests.js / test-env.cjs 钉 `.data-test`）。
- CC 的恢复形态（官方 CLI reference 已核实）：`-c/--continue` = 续接当前目录最近会话；`-r/--resume` = 按 id/名称恢复，无参时弹交互式会话选择器。本项目 `--continue` 已有、缺「弹列表选择」入口（TUI 内 `/resume` 需先进会话再操作）。

目标：指针概念整体退出、最近会话解析统一走会话档 mtime、补 `sunshinex resume` 启动命令对标 CC、DATA_DIR 收口为开发测试专用口。

## 2. 关键裁决

| # | 裁决 | 依据 |
|---|------|------|
| D1 | `sessions-active.json` 概念整体退出：`ACTIVE_POINTER`/`readActivePointer`/`writeActivePointer` 与全部写入点（建档/轮转/续挂/分档 5 处）删除；文档与目录树零存在史。最近会话解析统一为 `listSessions()`（mtime 降序）首项 | 对标 CC `-c`；消除多实例指针竞态 |
| D2 | 新增 CLI 名词子命令 `sunshinex resume`：启动 TUI 并立即弹出会话选择卡（复用 askUser/OptionSelector 通道与 `/resume` 卡片形态：↑↓ 移动、Enter 恢复、Esc 取消、数字快选）；Esc=放弃恢复以新会话继续；列表空=回执「无可恢复的会话」后进新会话。目录参数与顶层判据一致（`resume <dir>` / `--workdir=`） | 对标 CC `--resume` 无参选择器 |
| D3 | `--continue` 用户语义不变（续接最近会话），实现切到 mtime 口径；`resume` 与 `--continue` 同传按参数冲突 fail-fast 报错 | 命令面最小增量 |
| D4 | `SUNSHINEX_DATA_DIR` 定位为开发测试专用口：`data-dir.ts` 解析链①保留，注释改正向表述「开发与测试专用重定向」；MANUAL.md 数据目录段该环境变量摘除（换盘仍以 `projectsDir` 为唯一用户口）；settings 退役提示机制保持 | 用户无感知；开发测试通道（run-tests/test-env）不动 |
| D5 | 边界正交：`/rewind` `/fork` 与 TUI 内 `/resume` 等会话内枚举交互维持现状；多实例并发同工作区=共目录共存（会话档按 id 隔离、memory/账本/技能为项目级共享资产，语义不变） | CC 同形态；改动面收敛 |

## 3. 改动落点

| 落点 | 改动 |
|------|------|
| `src/tui/session-journal.ts` | 删 `ACTIVE_POINTER`/`readActivePointer`/`writeActivePointer`；`SessionJournal.startId/attach` 与 `branchFrom` 去指针写入；模块头注释同步 |
| `src/tui/session.ts` | `resumeLatest()`（`--continue`）改 `listSessions(dataDir)[0]`；新增 `resumePicker()`：会话启动流程中按 `opts.resumePicker` 弹选择卡（排除斜杠自建空档口径与 `/resume` 现有过滤一致），选定走既有 `attachSession` 恢复路径 |
| `src/cli/index.ts` | `resume` 子命令分支：解析目录/`--workdir`、与 `--continue` 互斥校验、传 `resumePicker: true` 进 TUI 装配；USAGE 双语同步 |
| `src/config/data-dir.ts` | 解析链①注释正向化（开发测试专用）；逻辑不动 |
| `src/config/settings.ts` | RETIRED_KEYS 注释口径同步（正向表述） |
| `MANUAL.md` | 目录树摘 `sessions-active.json` 行；数据目录段环境变量句摘除；命令表补 `sunshinex resume`（CLI 段）；`--continue` 行补「按最近会话自动续接」口径 |
| `README.md` | 如有 `--continue`/目录树提及则同步（实施时核实） |
| `scripts/run-tests.js`、`scripts/test-env.cjs` | 零改动（开发测试通道现形态即终态） |

## 4. 测试计划（TDD）

1. journal 钉子：建档/轮转/续挂/分档后 `dataDir` 目录树无指针文件（readdir 断言）；既有指针读写用例删除。
2. `--continue` mtime 口径：两档场景取 mtime 最新；空目录回执提示并新会话（沿用现断言形态，实现换源）。
3. `resume` 选择卡：列表渲染（排除当前/空档）、Enter 恢复选定档、Esc 新会话、空列表回执；CLI `resume` 与 `--continue` 同传报错、目录判据与顶层一致（裸词报「无法识别命令」）。
4. 既有 rewind/fork/journal 套件回归（指针删除后零残留断言跑全量）。

前缀缓存：本线纯会话管理面与配置注释，提示词与装配面零触碰，无新增动态面。

## 5. 验收矩阵

| # | 断言 |
|---|------|
| 1 | 全仓 `sessions-active`/`ActivePointer` 零命中（代码+文档） |
| 2 | `--continue` 在多会话目录恢复 mtime 最新一档 |
| 3 | `sunshinex resume` 弹选择卡、Esc/空列表两分支行为正确 |
| 4 | `resume` + `--continue` 同传报参数冲突 |
| 5 | MANUAL/README 目录树与命令表与实现一致、环境变量用户面零残留 |
| 6 | `pnpm build` + 全量测试 + `pnpm selfcheck` 三门禁全绿 |

## 6. YAGNI 登记

- `resume <session-id>` 按编号直恢复：CC 支持 id/名称直恢，本项目会话 id 为时间戳长串、v1 仅选择器，按名恢复待有命名机制再议。
- 会话删除/清理命令、跨项目会话搜索：不做（CC 的 project purge/全机搜索超出单机单项目形态）。
- 指针文件的兼容读取：不做（存量指针文件留在盘上即死数据，恢复口径自会话档推导）。
