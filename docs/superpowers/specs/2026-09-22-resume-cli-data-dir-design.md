# 会话恢复对标 CC：活动指针收编 + resume 子命令 + 数据目录口径收敛 设计规格

> 日期：2026-09-22 ｜ 状态：已实施交付（2026-11-23 D83 批二状态回写核证：MANUAL.md 启动旗标表 --continue/--resume 行 + src/tui/entry.ts --resume 旗标与互斥 fail-fast、journal 测试断言目录树无 sessions-active.json 指针；原状态行留档：「状态：待用户评审」）
> 关联：`docs/superpowers/specs/2026-09-17-session-persistence-resume-design.md`（会话持久化基座）、`2026-09-20-session-rewind-fork-design.md`（rewind/fork）、`2026-09-21-cli-tui-interaction-redesign.md`（CLI 判界与命令风格）、`2026-09-22-event-level-journal-persistence-design.md`（事件级落盘）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 活动指针 sessions-active.json 概念整体退出（含全部写入点与文档存在史）：最近会话解析统一为会话档 mtime 降序首项——多实例并发下唯一会被互相覆盖的单值竞态消除；--continue 用户语义不变、实现换源。
- 新增 --resume 启动旗标对标 CC：启动即弹会话选择卡（复用 /resume 卡片形态与通道，候选口径一致）；Esc=放弃恢复以新会话继续、空列表回执后进新会话；与 --continue、--worktree 同传 fail-fast，恢复语义择一。
- SUNSHINEX_DATA_DIR 收口为开发测试专用口：用户面文档摘除该环境变量，换盘仍以 projectsDir 为唯一用户口——多实例分区判定为伪需求（会话档天然按 id 隔离、共目录共存即 CC 形态），开发测试通道零改动。
- 边界正交零扩散：/rewind /fork 与 TUI 内 /resume 维持现状；memory/账本/技能为项目级共享资产语义不变；提示词与装配面零触碰、无新增动态面。
- YAGNI 登记：按 id/名称直恢复（待有命名机制再议）、会话删除/清理命令、跨项目会话搜索、指针文件兼容读取（存量指针即死数据）均不做。

## 现行真值

现行恢复入口见 MANUAL.md 一、安装与启动（启动旗标表 --continue/--resume 行）、三、目录与文件（sessions 会话档目录与恢复口径）。
