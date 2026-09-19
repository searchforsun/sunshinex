# 平台兼容性与部署条件

> 本文自 README.md 迁出：README 聚焦项目定位、架构与快速开始；平台兼容性与部署运维细节在此维护。

一份代码，三平台部署：安装、构建、自检与 CLI 基础命令在 Windows / macOS / Linux 全平台可用；工具 `exec` 的命令执行面以 POSIX sh 为基线，Windows 经 Git Bash 原生支持（`resolveShell()` 自动探测，无需 WSL）。

| 能力 | Linux | macOS | Windows |
|------|-------|-------|---------|
| 安装 / 构建 / 自检 | 支持 | 支持 | 支持 |
| CLI（selfcheck / run / pipeline） | 支持 | 支持 | 支持（单行命令） |
| 工具 exec 命令执行面 | 支持 | 支持 | 支持（Git Bash 自动探测） |

部署条件（三平台通用）：

1. Node.js ≥ 22.9（`pnpm cli` 依赖 `--env-file-if-exists`，下限登记于 `package.json` `engines`），实测基线 22 LTS 与 24.x。
2. `dist/` 不入库：新检出须先 `pnpm install` + `pnpm build`（`pnpm cli` 已内置自动构建，可直接执行）。
3. 写入 `~/.sunshinex/settings.json`（语义键 + `env` 块填密钥，模板见 TUI-MANUAL 第三节）；未配置密钥时可用 `--model stub` 先验证链路。
4. 包管理器统一 pnpm（`packageManager` 钉版，corepack 启用后自动对齐版本）；`.npmrc` 已将 store 固定在仓内 `.pnpm-store`，沙箱等 HOME 不可写环境开箱即用。

Windows 注意事项：

- README 中 CLI 示例均为单行，PowerShell/cmd 直接粘贴可用；bash 风格续行符 `\` 在 PowerShell 中无效。
- `exec` 命令执行面由 `resolveShell()` 按序解析：`SUNSHINEX_SHELL` 覆盖（契约：须 POSIX 兼容 shell，配 `-c` 调用；指向 cmd.exe 等非 POSIX shell 属未定义行为）→ 探测 Git Bash → 无 Git 时 `ComSpec` 兜底（`/c`，仅保证不崩，sh 语义命令不保证可用）。
- Git Bash 探测为多来源（`windowsBashCandidates`）：安装环境变量（`ProgramFiles` / `ProgramW6432` / `ProgramFiles(x86)` / `LOCALAPPDATA\Programs` 下的 `Git` 根）→ PATH 上 `git.exe` 所在目录及其祖先根反推 → PATH 上直接暴露的 `bash.exe`（msys2/cygwin 形态）；每个根取 `<root>\bin\bash.exe` 与 `<root>\usr\bin\bash.exe` 两种安装布局。仅探测到 bash.exe 才采用（不复用 sh 不可靠的其它壳）。
- 推荐安装 Git for Windows 后直接使用（自动探测生效）；WSL 内按 Linux 口径亦完整可用。便携版/自定义安装位置若未被自动发现（如未挂 PATH 且不在标准安装根下）：设置环境变量 `SUNSHINEX_SHELL` 指向 `bash.exe`/`sh.exe` 即可。
- **命令形态建议**：`exec` 在无 Git Bash 时回落 `cmd /c`，此时命令集与引号语义与 sh 不同（`ls`/`cat` 不可用、`node -e "…"` 的引号会被当字面量、退出码不反映实际）。要跨平台稳定，用脚本文件承载逻辑（`node script.js`）或安装 Git for Windows。
- **测试口径**：仓库测试不得依赖宿主 shell 方言（不以 `ls`/`cat`/内联 `node -e` 作断言前提），shell 语义用例集中在 `src/harness/security/sandbox.test.ts`。
