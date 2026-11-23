# 会话归档与受控删除设计(/archive · /delete)

- 日期:2026-10-21
> 状态：已实施交付（2026-11-23 D83 批二状态回写核证：MANUAL.md 命令表 /archive·/unarchive·/delete（未归档须先归档门禁）与 MANUAL-GUI.md 归档会话页现行口吻＋src/tui/session-journal.ts archived 键/markSessionArchived 与 src/serve daemon 归档路由钉测在座；原状态行留档：「- 状态:已批准(会话内分段评审,用户逐段确认)」）
- 轮次:会话整理能力首轮(brainstorming 产出;承接 G14.2xx 刷新恢复/归档语义空缺)
- 裁定记录:用户裁定——①归档标记落共享层旁车 meta(方案 A,B/C 否);②GUI 既有删除入口(顶栏 Delete、侧栏行 hover 垃圾桶)全部退役,删除只存在于归档页;③归档后方可删除,删除=真清文件(旧「daemon 回收留 journal」语义退役);④`/archive` 与 `/delete` TUI/GUI 公用;⑤撤销归档不设 TUI 命令(GUI 归档页/顶栏撤销足够);⑥归档页数据范围=当前 daemon 服务根下全部工作区,跨工作区聚合、行标注来源项目。
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 会话档新增 archived 纯标记态：落共享层旁车 meta（方案 A），TUI/GUI 同源可见、会话本体零行为差异；主列表/最近会话/TUI /resume 三处消费方同口径滤除，归档会话从主列表消失但 attach/重开链路不设限。
- /archive 与 /delete 命令面 TUI/GUI 公用（裁定④）：命令清单、描述、底层操作三层共用无平行实现；归档/删除对 running 会话一律 409。
- 删除升级为归档之后的受控重操作（裁定③）：未归档 409（先归档门禁）→ 归档态删除真清全部会话档（journal+meta+两面私有档，缺档幂等跳过、目录随清）——旧「daemon 内存回收、journal 保留」半删语义退役，其「下架但留档可重开」职责由归档态接管。
- GUI 交互对齐用户 mockup：侧栏行 hover 归档（行内二次确认）、顶栏 Delete 退役换归档（裁定②）、「项目」组头归档页（裁定⑥：跨工作区聚合、标注来源项目、行内撤销/红删除二次确认、点行切来源工作区正常打开，归档会话聊天零差异）。
- 关键取舍：归档标记不落 journal 行类型（保 listSessions 零重放直读的性能设计）、不落 GUI 面私有（两面共有语义归共享层）——共享层旁车 meta 单点，撤销即删键。

## 现行真值

现行归档与删除口径见 MANUAL.md 四、基本用法 命令表（/archive·/unarchive·/delete 行）、MANUAL-GUI.md「界面」左栏会话行与「归档会话页」。
