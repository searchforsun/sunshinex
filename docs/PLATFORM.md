# 平台兼容性与部署条件

> 本文自 README.md 迁出：README 聚焦项目定位、架构与快速开始；平台兼容性与部署运维细节在此维护。

一份代码，三平台部署：安装、构建、自检与 CLI 基础命令在 Windows / macOS / Linux 全平台可用；工具 `exec` 的命令执行面以 POSIX sh 为基线，Windows 经 Git Bash 原生支持（`resolveShell()` 自动探测；无 Git Bash 时回落 PowerShell，末位 `ComSpec` 兜底。WSL 内按 Linux 口径）。

| 能力 | Linux | macOS | Windows |
|------|-------|-------|---------|
| 安装 / 构建 / 自检 | 支持 | 支持 | 支持 |
| CLI（selfcheck / run / pipeline） | 支持 | 支持 | 支持（单行命令） |
| 工具 exec 命令执行面 | 支持 | 支持 | 支持（Git Bash 自动探测；无 Git 时 PowerShell，末位 cmd 兜底） |

部署条件（三平台通用）：

1. Node.js ≥ 22.9（下限登记于 `package.json` `engines`），实测基线 22 LTS 与 24.x。
2. `dist/` 不入库：新检出须先 `pnpm install` + `pnpm build`（`pnpm cli` 已内置自动构建，可直接执行）。
3. 写入 `~/.sunshinex/settings.json`（语义键 + `env` 块填密钥，模板见 MANUAL.md 第三节）；未配置密钥时可用 `--model stub` 先验证链路。
4. 包管理器统一 pnpm（`packageManager` 钉版，corepack 启用后自动对齐版本）；`.npmrc` 已将 store 固定在仓内 `.pnpm-store`，依赖安装与缓存随仓库走。

平台契约的机器强制（声明即须可执行）：

- **CI 矩阵** `.github/workflows/ci.yml`：`ubuntu-latest + windows-latest` × Node `22`/`24`，步骤为 `pnpm install --frozen-lockfile` → `pnpm test` → `pnpm selfcheck`；`fail-fast: false`，避免一个组合失败掩盖其余组合（平台差异的价值恰在「哪个平台挂了」）。Windows runner 预装 Git for Windows，故 `selfcheck` 会真实走通 `resolveShell()` 的 Git Bash 命中路径；**PowerShell 一级与 ComSpec 末位在 CI 上不会被真实命中**（runner 恒有 Git Bash），其判别力全部由 `resolveShellFor` 注入式用例承载（POSIX 上亦断言 Windows 决议序）——两条分支的端到端行为如实登记为「无机器闸门，仅开发机手工验证」。
- **流水线未覆盖项（如实登记，勿误以为已覆盖）**：`scripts/*probe*.js` 为真实模型冒烟，依赖外部 API 且按 `.gitignore` 不入库，仅开发机手动执行；macOS 语义与 Linux 同源（POSIX），runner 成本约为 Linux 十倍，按性价比省略——其专属风险面「不区分大小写但保留大小写的文件系统」已由 `windows-latest` 的同名面覆盖。
- **文本契约**：`.gitattributes`（`* text=auto eol=lf`；二进制与 `*.snap` 显式排除转换）管入库/检出字节，`.editorconfig`（`end_of_line = lf`）管编辑器落盘字节。二者缺一不可——Git for Windows 缺省 `core.autocrlf=true`，只靠文档纪律时 Windows 侧一次提交即可引入整文件 CRLF 重写。
- **路径判界单点** `src/paths.ts` 的 `isWithin(root, target)`：安全链 root 判界、dataDir 判界、记忆路径分类三处共用，禁止再手写 `startsWith(root + path.sep)`。该原语**刻意不做大小写归一**——POSIX 区分大小写，不敏感比较会把越界目标判为根内（fail-open 真缺口）；Windows/macOS 虽不区分，但比较双方同由 `realpath` 产出（libuv 经 `GetFinalPathNameByHandleW` 返回磁盘规范大小写），天然一致故无需归一。契约：两侧须**口径同源**（都归一或都不归一）。
- **子进程启动形态**：`.cmd`/`.bat` 经 `spawn(ComSpec, ['/c', cmd, ...args])` 显式启动，不用 `shell: true` 与 `args` 并用（Node ≥ 22.15 弃用，DEP0190）。

Windows 注意事项：

- README 中 CLI 示例均为单行，PowerShell/cmd 直接粘贴可用；bash 风格续行符 `\` 在 PowerShell 中无效。
- `exec` 命令执行面由 `resolveShell()` 按序解析：`SUNSHINEX_SHELL` 覆盖（契约：须 POSIX 兼容 shell，配 `-c` 调用；指向 cmd.exe 等非 POSIX shell 属未定义行为）→ 探测 Git Bash → 无 Git Bash 时探测 PowerShell（`-NoProfile -Command`；候选序 pwsh 各来源整体先于 powershell.exe——对齐 Claude Code native Windows 口径：无 Git for Windows 时以其作 shell 工具，而非退回 cmd.exe）→ 皆无则 `ComSpec` 末位兜底（`/c`，仅保证不崩，sh 语义命令不保证可用）。
- Git Bash 探测为多来源（`windowsBashCandidates`）：安装环境变量（`ProgramFiles` / `ProgramW6432` / `ProgramFiles(x86)` / `LOCALAPPDATA\Programs` 下的 `Git` 根）→ PATH 上 `git.exe` 所在目录及其祖先根反推 → PATH 上直接暴露的 `bash.exe`（msys2/cygwin 形态）；每个根取 `<root>\bin\bash.exe` 与 `<root>\usr\bin\bash.exe` 两种安装布局。仅探测到 bash.exe 才采用（不复用 sh 不可靠的其它壳）。**`bash.exe` 这个名字不是 MSYS 家族专有**：Windows 自带同名的 WSL 启动器（`%SystemRoot%\System32`、`SysWOW64`、`Sysnative`，以及 `%LOCALAPPDATA%\Microsoft\WindowsApps` 应用执行别名目录），而 System32 恒在 PATH 上、按文件名字符匹配恰是最靠前的候选，故由 `isWslBashLauncherDir()` 锚定 SystemRoot 显式排除（不靠目录名猜，避免误拒用户自建的同名路径）。误选一次错三处：PATH 不继承（宿主侧 node/npm 在发行版里一律 `command not found`）、路径变 `/mnt/<盘>/…`（与调用方的 Windows 路径口径不符）、首次调用要等发行版 VM 冷启动（实测 24–32 秒）且其持有 Windows 目录句柄致测试清理 EBUSY。**确要 WSL 当 shell 时**用 `SUNSHINEX_SHELL` 显式指向（`C:\Windows\System32\bash.exe`）：显式指定即跳过自动探测，上述 PATH 与路径口径差异由指定方自行承担。
- PowerShell 探测同为多来源（`windowsPowerShellCandidates`）：PATH 逐目录 → pwsh 固定安装位（`<ProgramFiles>\PowerShell\7`、`%LOCALAPPDATA%\Microsoft\WindowsApps`）→ Windows PowerShell 的 PATH 目录与 in-box 位置 `%SystemRoot%\System32\WindowsPowerShell\v1.0`。
- 决议产物带来源标签（`override` / `git-bash` / `powershell` / `comspec` / `posix`）：`sunshinex selfcheck` 输出 `shell : <file> <args> (<source>)` 一行——Git Bash 未命中曾属无任何报错可循的隐式差异（静默改变引号语义与命令集），观测面由此可循。
- 推荐安装 Git for Windows 后直接使用（自动探测生效）；WSL 内按 Linux 口径亦完整可用。便携版/自定义安装位置若未被自动发现（如未挂 PATH 且不在标准安装根下）：设置环境变量 `SUNSHINEX_SHELL` 指向 `bash.exe`/`sh.exe` 即可。
- **命令形态建议**：`exec` 在既无 Git Bash 又无 PowerShell 时才回落 `cmd /c`，此时命令集与引号语义与 sh 相差最远（`ls`/`cat` 不可用、`node -e "…"` 的引号会被当字面量、退出码不反映实际）；命中 PowerShell 时命令须按 PowerShell 语义书写（非 sh 语义）。要跨平台稳定，用脚本文件承载逻辑（`node script.js`）或安装 Git for Windows。
- **测试口径**：仓库测试不得依赖宿主 shell 方言（不以 `ls`/`cat`/内联 `node -e` 作断言前提），shell 语义用例集中在 `src/harness/security/sandbox.test.ts`。
