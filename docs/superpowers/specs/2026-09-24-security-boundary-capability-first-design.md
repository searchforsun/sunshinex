# 安全边界能力优先重构设计

- 日期：2026-09-24
- 状态：设计定稿（用户逐项裁决确认）；实施计划待 writing-plans 产出
- 关联：CLAUDE.md §5（工具面与依赖台账）、§14（平台兼容性）；7c9f358（settings.json 两级硬保护与 ~/.sunshinex 放行）、b4cede3（worktree 程序化隔离与安全链执行期缝）、d6d9a3e（装配失败警告降级语义先例）、81599cf（两级 JSON 装载形态先例）

## 1. 背景与问题清单

| # | 现状 | 问题 |
|---|------|------|
| P1 | resolveSafe 对 root 外读一律硬拒（path escapes project root） | 对标 Claude Code / Codex 均缺省全盘可读（CC 读 fence 为可选开关、Codex read-only 档即全盘读）；诊断日志、系统配置、他仓参考代码读不到，真实能力损失 |
| P2 | root 外写一律硬拒（仅 ~/.sunshinex、记忆窄口、dataDir 例外） | CC 形态是 ask 而非 deny；越界写应是审批流而非能力禁区 |
| P3 | 无目录扩展机制（CC additionalDirectories / --add-dir 等价物缺失） | 多仓联动（读 A 仓写 B 仓）无解，只有 worktree activeRoot 一条路 |
| P4 | exec 无内核级写边界：路径工具防线可被 `echo x > ~/foo` 绕过（CC 官方明言命令文本匹配不是安全边界，靠 OS 沙箱兜底；本仓实际由 Skills Docker 容器兜底但未声明） | 防线是「提示级」而非「边界级」，隔离口径不可见 |
| P5 | PolicyEngine 已有 deny→ask→allow 三态引擎，缺用户配置入口；write 可直写 .git 内部对象 | 「用户可控」缺实质载体；损坏仓库/伪造历史无需审批（CC 列 .git/.claude 为 protected paths） |

## 2. 设计原则（用户裁定）

1. **能力优先**：操作权限设计不得影响 agent 能力发挥——读宽、写明、exec 分档。
2. **用户可控**：控制权交给用户（可配置规则面 + 显式扩权通道），缺省值放宽，靠规则面与档位承载管控。
3. **不为兼容放弃能力**：OS 沙箱本轮落地（Linux Landlock 先行）；跨平台按「各平台最优内核机制 + 不可用降级审批流 + 状态显式上屏」对标形态，不做半成品兼容层。
4. **单点判定**：路径边界判定收敛 resolveSafe 单点，exec 围栏收敛 ProcessSandbox 单点；新增面只挂接既有单点，零旁路。

## 3. 对标基线（调研事实）

### 3.1 权限模型

| 维度 | Claude Code | Codex CLI | SunshineX 现状 |
|------|-------------|-----------|----------------|
| 读 | 工作目录 + additionalDirectories 内免批；目录外读可选 fence（缺省关） | 全盘可读（read-only 档缺省） | root 外一律拒（P1） |
| 写 | 逐次审批；acceptEdits 档自动放行；.git/.claude protected paths | workspace + /tmp 内 OS 级放行 | root 内放行、root 外硬拒（P2） |
| exec | OS 沙箱（macOS Seatbelt / Linux bubblewrap+socat），官方明言文本规则非安全边界 | OS 沙箱（Linux Landlock+seccomp / macOS Seatbelt / Windows 受限令牌） | JS 层检查 + 容器隐性兜底（P4） |
| 用户规则 | deny→ask→allow，settings 持久化，Tool(specifier) 语法 | sandbox_mode + approval_policy 两轴 | 引擎有、入口无（P5） |
| 扩权 | --add-dir / /add-dir / additionalDirectories | workspace 配置 | 无（P3） |
| 降级口径 | 沙箱不可用 Warning 照跑（failIfUnavailable 可设硬门） | 档位显式声明 | 隔离口径未声明（P4） |

### 3.2 跨平台沙箱后端（官方文档原文）

| 平台 | Claude Code | Codex CLI | 本设计 |
|------|-------------|-----------|--------|
| Linux | bubblewrap + socat（系统包安装，Ubuntu 24.04 需 AppArmor 放行 userns） | Landlock + seccomp | Landlock launcher（npm 可选依赖自带静态 musl 二进制，免系统包安装步） |
| macOS | Seatbelt（系统内建） | Seatbelt | host 口径（审批流兜底；Seatbelt 后端进 roadmap） |
| Windows | 原生形态不支持（官方口径走 WSL2） | 受限令牌（实验性，推荐 WSL） | host 口径（同上） |
| 不可用时 | Warning + 无沙箱照跑；`failIfUnavailable=true` 才硬门 | 档位显式 | Warning 降级不阻断（对标 d6d9a3e 语义）+ isolation 上屏 |

结论：两家共同形态 = 各平台最优内核机制 + 不可用降级到审批流 + 状态显式；均未做到原生三平台内核沙箱。本设计在 Linux 侧部署比 CC 更轻（二进制随 npm 可选依赖分发，省去系统包安装步）。

## 4. 关键裁决（用户逐项定调）

| # | 裁决 | 内容 |
|---|------|------|
| D1 | 读边界 | 全盘读放开；敏感路径零缺省黑名单（交用户 deny 规则）；可选读 fence 键（缺省关） |
| D2 | 写边界 | root 外写审批化：manual=ask（'always' 会话记住该目录）、dontAsk=放行、plan=拒；settings.json 两级硬保护、记忆窄口、worktree 主根拒写语义不动 |
| D3 | 目录扩展 | --add-dir：CLI flag + TUI 斜杠命令 + settings additionalDirs 三面同源；读写同扩；扩入目录与 root 同语义 |
| D4 | OS 沙箱 | 本轮实现，Linux Landlock 先行；载体 = @deepseek-ai/node-addon-landlock-run launcher 绑定（Codex 同款 self-restrict-then-exec，预编译静态二进制，不可用降级） |
| D5 | 规则面 | settings.json permissions 结构化键（deny/allow/additionalDirs）；两级合并不遮蔽（数组并集，项目不得解除全局 deny）；语法 Tool(specifier) |
| D6 | .git 保护 | 项目级 .git/** 纳入写硬保护（与 settings.json 同层）；git 状态变更走 exec git（有判界三查与审批） |
| D7 | 交付形态 | brainstorming 产出 spec → writing-plans 产出实施计划 |

## 5. 设计方案

### 5.1 工具面判定序（resolveSafe 单点）

```text
[产品硬底线]  settings.json 两级写保护 → .git/** 写保护 → 记忆窄口 → worktree 主根拒写
[用户规则]    deny 命中即拒 → allow 命中即放（均在硬底线未命中前提下求值）
[读分支]      全盘放行；fence 开启时 root 外读 manual=ask、其余档=拒
[写分支]      root ∪ additionalDirs ∪ ~/.sunshinex 放行；root 外 manual=asker、dontAsk=放行、plan=拒
```

- 求值顺序即安全序：硬底线恒拒（用户规则只可收窄、不可放宽）；用户 deny 先于 allow（同时命中以 deny 为准）；allow 命中即免批（越过 ask 通道与档位门槛），plan 档只读语义不被 allow 放宽。
- **会话放行集**：asker `'always'` 决策把目录记入会话级放行集（内存态、链克隆共享引用，与 guard 同生命周期），同时喂工具面写分支与 landlock 可写根——工具面与 exec 面对齐同一目录集。临时扩权走 'always'，持久扩权走 settings additionalDirs，分工明确（YAGNI：不做放行集持久化）。
- asker 缺失（无交互面）+ manual + root 外写 → 拒（宁停不误，对标既有 asker 失败语义）。
- 前缀缓存零影响：本设计零提示词装配面改动（§11 不触发）。

### 5.2 permissions 规则面（settings.json 结构化键）

```json
{
  "permissions": {
    "deny": ["Write(*.pem)", "Bash(rm -rf*)", "Read(**/.env)", "mcp__legacy__*"],
    "allow": ["Write(**/fixtures/**)"],
    "additionalDirs": ["../lib-shared"]
  }
}
```

- 语法 `Tool(specifier)`：文件工具 = 路径 glob（路径 `/` 归一后匹配；`*` 不跨段、`**` 跨段、无 `/` 的模式对 basename 匹配，gitignore 风格）；`Bash(...)` = 命令前缀匹配；`mcp__<server>__<tool>` 直名（尾 `*` 通配）。
- 两级装载**合并不遮蔽**：全局 `~/.sunshinex/settings.json` + 项目 `.sunshinex/settings.json` 数组拼接去重——deny 取并集，项目级不得解除全局 deny（对标 CC 层级合并语义）。装载形态对标 `loadMcpServers`（81599cf 先例），单级形状非法 → 该级 warning 跳过。
- settings.ts 增结构化解析支路：permissions 键保留对象原值、独立于 env 槽映射（现 flattenSettings 只收 string/number，结构化值直接续传）。SEMANTIC_KEYS 新增 `readFence`（SUNSHINEX_READ_FENCE，onOff，缺省 off）、`sandbox`（SUNSHINEX_SANDBOX，on|off，缺省 on；`require` 保留 roadmap）与 `isolation`（SUNSHINEX_ISOLATION，container|host|auto，缺省 auto，消费见 §5.5）。
- 消费分两处、共享同一装载产物与匹配单点：路径工具在 resolveSafe（归一路径做 glob 匹配），Bash/网络/MCP 工具在 guard 既有 specifier 通道（PolicyEngine 装配期注入规则）。
- settings.json 模型不可写（7c9f358 硬保护）→ 规则面天然纯用户控制。

### 5.3 目录扩展（--add-dir）

- 三面同源：CLI `--add-dir <path>`（可重复）/ TUI `/add-dir <path>` 斜杠命令 / settings `permissions.additionalDirs`；装配期 realpath 归一后并入扩目录集。
- 扩目录集与 root 同语义：读写同级信任（用户显式扩权即表达信任）；settings/.git 保护与 landlock 可写根同样覆盖；resolveSafe 单点消费。
- 会话级 /add-dir 只增不减、会话内恒定。

### 5.4 OS 沙箱（landlock 接缝）

- 新接缝 `src/harness/security/landlock.ts`：适用性探测（平台二进制在位 + 内核 landlock ABI 探测通过）→ ProcessSandbox spawn 经 launcher（self-restrict-then-exec：launcher 先自我限制再 exec 目标命令，PATH 解析交 launcher）→ 探测失败/不可用降级原样 spawn + Warning。
- 可写根 = root/activeRoot ∪ additionalDirs ∪ 会话放行集 ∪ ~/.sunshinex ∪ dataDir ∪ `os.tmpdir()`；读不限；网络本轮不限（Landlock ABI4 TCP 限制进 roadmap）。
- 与判界三查叠加不冲突：三查在 JS 层（cwd 锚定/GIT_* 环境/git 指针），launcher 在内核层（文件写围栏），两层独立生效、前台后台共用闸门（RuntimeSafetyGate 视图内消费）。
- `SUNSHINEX_SANDBOX=off` 一键关沙箱（用户显式全权通道）；off 或不可用时 isolation 口径相应回退。
- 依赖引入（§5 原则逐项过）：`@deepseek-ai/node-addon-landlock-run` + 平台二进制包（linux-x64/arm64）入 optionalDependencies（esbuild 同款 per-platform 可选依赖模式，非 Linux 平台零安装负担）；BSD-3-Clause；维护活跃（2026-09 仍在更新、月下载 70 万+）；JS 接缝负责解析/探测/CLI 契约。依赖台账登记：用途 = exec 内核级写围栏；收敛边界 = landlock.ts 单点；回退预案 = SANDBOX=off 回 JS 层检查 + 容器口径。

### 5.5 隔离口径显式化（selfcheck）

- selfcheck 新增 `isolation :` 行：`SUNSHINEX_ISOLATION` 显式声明（container|host|auto，缺省 auto）优先；auto = landlock 探测成功 → `landlock`，容器标记（/.dockerenv）→ `container`，否则 `host`。
- 部署文档（README/MANUAL/PLATFORM）声明职责分层：Skills Docker 容器部署即边界层；宿主形态由审批流（manual）与规则面兜底。

### 5.6 错误与降级语义

- landlock 围栏导致的命令失败照常回传 stderr（模型可见被拒路径自行调整）；本轮不做 CC 式 unsandboxed-retry 重试参数（roadmap）。
- launcher 探测失败 / spawn 失败 → 原样 spawn + Warning 上屏（对标 MCP 降级语义 d6d9a3e），装配与任务执行均不阻断。

## 6. 模块与数据流

| 模块 | 改动 |
|------|------|
| src/config/permissions.ts（新） | loadPermissions 两级装载合拢；规则匹配单点（path glob / Bash 前缀 / mcp 直名） |
| src/config/settings.ts | permissions 结构化解析支路；SEMANTIC_KEYS + readFence/sandbox |
| src/types.ts | PermissionsConfig、SandboxIsolation、会话放行集类型登记 |
| src/harness/security/chain.ts | resolveSafe 判定序重排（§5.1）；会话放行集（克隆共享引用） |
| src/harness/security/guard.ts | permissions 注入 PolicyEngine（Bash/网络/MCP 通道） |
| src/harness/security/landlock.ts（新） | 探测/包装/降级接缝 |
| src/harness/security/sandbox.ts | ProcessSandbox 消费 landlock 接缝（RuntimeSafetyGate 视图内） |
| runtime.ts / cli / tui | --add-dir、/add-dir、permissions 装配接线 |
| selfcheck.ts | isolation 行 |
| docs / package.json | §14 平台差异登记、§5 依赖台账行、README/MANUAL permissions 与 add-dir 章节 |

## 7. 测试与验证

- resolveSafe 边界矩阵：读全放 / fence 开关两态 / 写三档（manual ask、dontAsk 放行、plan 拒）/ add-dir / .git 拒写 / settings 硬保护回归 / 记忆窄口回归 / 会话放行集 'always' 语义与两面对齐。
- permissions：两级合并（含「项目不得解除全局 deny」锁定用例）、单级形状非法 warning 跳过、匹配单点（path glob 三规则、Bash 前缀、mcp 直名/尾通配）。
- landlock 接缝：fake 探测单测（不可用降级 + 包装参数契约）；真实内核探针手动口径（对标 ci.yml「探针不入库、开发机手动执行」先例）。
- selfcheck isolation 行三态；--add-dir 三面同源接线。
- 交付门：`pnpm build` 零报错 + 全量测试 + `pnpm selfcheck`；§14 平台差异登记后同步复核 README 平台支持矩阵。

## 8. 非目标（roadmap）

- macOS Seatbelt / Windows 受限令牌沙箱后端。
- 网络隔离（Landlock ABI4 TCP 过滤）与网络域审批。
- sandbox `require` 硬门（对标 CC failIfUnavailable，managed 部署安全门）。
- unsandboxed-retry 重试参数（对标 CC dangerouslyDisableSandbox）。
- acceptEdits 独立档位（allow 规则已覆盖其语义，YAGNI）。
