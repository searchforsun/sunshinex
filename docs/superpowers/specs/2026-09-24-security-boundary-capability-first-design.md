# 安全边界能力优先重构设计
- 日期：2026-09-24
- 状态：已实施交付（2026-11-23 D83 批二状态回写核证：MANUAL.md §6 现行口径（缺省全盘读、越界写按档审批、--add-dir 三面、§6.2 permissions 规则面、§6.3 Landlock 沙箱）+ src/config/permissions.ts 与 src/harness/security/landlock.ts 在座；原状态行留档：「- 状态：设计定稿（用户逐项裁决确认）；实施计划待 writing-plans 产出」）
- 关联：CLAUDE.md §5（工具面与依赖台账）、§14（平台兼容性）；7c9f358（settings.json 两级硬保护与 ~/.sunshinex 放行）、b4cede3（worktree 程序化隔离与安全链执行期缝）、d6d9a3e（装配失败警告降级语义先例）、81599cf（两级 JSON 装载形态先例）
> 折叠（D83 批三，2026-11-23）：已交付规格正文折叠为验收短条目——机制细节由活文档（CLAUDE.md/MANUAL.md）承载现行真值，本件只留交付范围与结论；完整正文见本路径提交历史（git log 本文件）。

## 交付结论

- 读边界放开：全盘缺省可读（对标 Claude Code/Codex），可选读围栏键缺省关；敏感路径零缺省黑名单，交用户 deny 规则自定。
- 写边界审批化：root 外写从硬拒改为按档审批（manual=询问且可会话记住、dontAsk=放行、plan=拒）；settings 硬保护、.git 写保护、记忆窄口、worktree 主根拒写语义不动。
- 目录扩展三面同源（CLI flag / TUI 斜杠命令 / settings 配置），扩入目录与项目根同级信任、读写同扩；会话内只增不减。
- exec 内核级写围栏落地：Linux Landlock 先行（预编译二进制随可选依赖分发，省系统包安装步），探测失败降级原样执行 + 警告不阻断；macOS/Windows 维持 host 口径（roadmap）。
- 用户规则面与显式化：settings permissions 结构化键（deny/allow/扩目录）两级合并不遮蔽——项目级不得解除全局 deny；隔离口径三态显式上屏（selfcheck）。
- 关键裁决：能力优先（操作权限不得影响 agent 能力发挥）、单点判定零旁路（路径判界与 exec 围栏各收敛单点）。

## 现行真值

现行口径见 MANUAL.md 六、权限档与审批（6.1 读写范围 / 6.2 规则面 / 6.3 命令执行沙箱）、CLAUDE.md §14 平台兼容性（Landlock Linux-only 与隔离三态）。
