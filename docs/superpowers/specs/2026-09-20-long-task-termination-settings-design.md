# 长任务终止参数收编 settings.json 与缺省放宽 — 设计规格
> 日期：2026-09-20 ｜ 状态：待用户评审 ｜ 线：长任务终止参数（brainstorming → writing-plans）
> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：CLAUDE.md §12 缺省放宽现行口径（Reactor 400 步 SUNSHINEX_MAX_STEPS、修正环 200 轮/12h、全链 1000 节点步/24h、墙钟失控保底不进 settings）＋src/config/termination-config.ts 三解析器与 reactor.ts/graph/agents.ts 缺省 400 在座；原状态行留档：「原无状态行」）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 长任务终止以步数/轮次/节点数为主承载并收编 settings.json 三枚语义键（Reactor 步数/修正环轮数/全链节点步，用户可调）；非法值 fail-fast 显式报错、不静默吞。
- 缺省大幅放宽：Reactor 步数 200→400、修正环 100 轮→200 轮/2h→12h、全链 500→1000 节点步/4h→24h、长任务时间兜底 4h→24h；token 预算不动（paused 可续走，非硬死）。
- 关键裁决：墙钟时长降格为失控保底常量、不进 settings——用户裁决时长限对合法推进的长任务是纯误伤，正确的失控量纲是「无进展」（步数/轮次/token）而非时间。
- 注入收口：两处模板装配与运行入口共用同一解析器（显式入参 > settings 键 > 内置缺省），调用面零触碰；settings 全表钉子 27→30 键同步。
- 验证：解析器套件（合法生效/未设回退/非法 fail-fast）+ 合并序与放宽常量断言 + 文档同步（CLAUDE.md §12/README/TUI-MANUAL）。

## 现行真值

现行口径见 CLAUDE.md §12 长任务设计取向（缺省放宽清单与「墙钟=失控保底」定位）、§3 目录结构（config/termination-config 落位）、MANUAL.md 二、配置（settings 语义键表）。
