# 远程工作区(SSH)架构设计 —— 项目分组下的远程 SSH 项目

> 状态:设计稿(2026-11-24 调研后成文)。目标:**任意多台远程 SSH 主机上的项目目录,以一等工作区
> 身份进入侧栏项目分组与 Sunx 域**——GUI 单连接不动、daemon 回环绑定不动、远程零网络监听;
> v1 实施范围仅 ssh 后端,工厂按 local/ssh/wsl/docker 四 kind 定形。

## 0. 调研结论(设计依据)

### 0.1 本仓库现状(耦合点清单)

- 工作区注册:`handleWorkspaceCreate`(workspace-handlers.ts:84)把本地路径落 `~/.sunshinex/projects/<slug>/data/workspace.json`;`handleWorkspaces`(:171)扫描该目录出列。root 必须是 daemon 本机路径——建会话第一步 `fs.statSync` 即拒远程路径(session-lifecycle.ts:137)。
- 执行全在本机:`ProcessSandbox implements ToolBackend`(harness/security/sandbox.ts:8,注释明说"Docker/SSH 后端同接口预留,1D 不实现");git 全家桶 13 函数 `git -C root`(session-changes.ts:15);file/tree handler 直 fs(file-handlers.ts:202/503/85);PTY 本机 node-pty(pty.ts:154)。
- `ToolBackend`(types.ts:494)已收口 exec/execBackground/readFile/writeFile/listFiles 五件,工具链(builtin.ts)统一走 backend——**抽象缝现成,SSH 后端是补实现不是动结构**。
- harness 约 22 个文件绕过 backend 直 fs;其中落 dataDir 的持久化面与远程化正交(数据本来就在本地),root 面直读点:perception.ts(root 扫描)、context/loader.ts(SUNSHINE.md)、skills.ts(项目五根)、security/chain.ts(rootReal realpath)、worktree.ts(git spawn)、tools/builtin.ts(图片直读)。
- daemon 对 root 下 `.sunshinex` 挂 fs.watch(daemon.ts:351)。`projectSlug`(config/data-dir.ts:20)第一步 `path.resolve`——URI 形态 root 必须绕开本地 path 语义(slug 对 URI 串直接折叠),否则 slug 不稳定、数据档错位。
- daemon 恒绑回环(daemon-wire.ts:11,"远程暴露为 v1 非目标");GUI 单连接 HTTP/WS(use-connection-wiring.ts:120)。
- 会话数据与项目文件天然分离:journal/账本/记忆全落本地 `resolveDataDir(root)`(data-dir.ts:105)——远程项目不需要远程存储会话数据。
- 工作区选择面四处共用 DirPicker:侧栏「添加工作区」(project-menu-projects.tsx)、NewSunxDialog(新建 Sunx/项目会话)、欢迎页工作区切换、ScheduleConfig(调度任务 root)。

### 0.2 业界形态

- **Codex 桌面**(官方文档 remote-connections):Settings → Connections → SSH,`~/.ssh/config` 自动发现主机;项目选择器选远程文件夹;新会话执行在远程机。SSH 拉起远程 codex app server("The app starts the remote Codex app server through SSH"),传输面不裸暴露公网。handoff:聊天+git 状态跨主机搬家(worktree)。
- **Claude Code 桌面**(code.claude.com/docs/en/desktop):环境选择器 **Local/SSH/Cloud 三页签**;SSH 页 = Host 下拉(已存连接 + "Add SSH connection…")→ 远程文件夹选择器;连接表单字段 = Name(可选)/SSH host(user@hostname 或 ~/.ssh/config 条目)/SSH port(可选)/SSH key(可选路径)/Worktree folder。"Desktop installs Claude Code on the remote machine automatically the first time you connect"——helper + Claude Code 装到远程 `~/.claude/remote/`,约 1 GB,要求非 noexec。
- **VS Code Remote-SSH / JetBrains Gateway / Zed remote**:IDE 类鼻祖形态——远程装 server 组件,本地薄 UI。
- **ZCode 桌面**(app.asar 反编译核证):ssh2 库 Client(认证四类:privateKeyPath/passphrase/password/SSH_AUTH_SOCK agent + keyboard-interactive;keepalive 15s×3,握手 60s);后端工厂 `createRemoteBackend` 按 kind 出 **ssh/wsl/docker**(各带可用性探测与列表:isDockerAvailable/isWSLAvailable/listDockerContainers/listWSLDistros);`SSHBackend` API = exec/execSimple/upload(SFTP 主 + exec 回退)/readFile/exists/resolveRemotePath;`deployServer` 上传便携运行时到远程 `~/.zcode/server/`(自含 node 二进制按 platformArch + zcode-server.cjs 单文件 + node-pty 原生模块),版本文件 + sha256 + `.new` 原子换装;`connectRemote` 流程 = detect → deploy → exec 拉起(buildRemoteServerCommand:env 前缀 + `~/.zcode/server/node ~/.zcode/server/zcode-server.cjs`)→ **exec 通道 stdio 握手** → 帧协议;server 生命周期挂连接;主机发现读 `~/.ssh/config`(`ssh -G` 输出解析)。会话注册表按来源分身份(local\0路径 vs remote\0sessionId\0路径)实现共存。

**对本项目最重要的一条**:ZCode/Claude Code/Codex 三家都是「daemon 网关 + 远程便携 runtime + stdio 协议」同构;远程机上零网络监听(唯一入口是用户自己的 SSH 会话),安全模型与 sunshinex 回环裁定完全兼容。

## 1. 总体形态裁定

| 维度 | 裁定 | 未采纳候选(留档) |
|---|---|---|
| 连接拓扑 | **daemon 网关共存**(2026-11-24 用户裁定,推翻先期「主机切换式」):GUI 永远只连本地 daemon,远程工作区混排侧栏,daemon 按工作区归属路由执行 | 主机切换式(整窗切换,对用户不友好);GUI 多连接聚合(数周级 GUI 改造);本地 daemon 网关+ssh -L 隧道(被厚形态 stdio 取代) |
| 数据面通道 | **ssh2 exec 通道 stdio**(帧协议跑在 exec 通道 stdio 上);文件 SFTP 直传;PTY 走 ssh2 pty channel | ssh -L 本地端口转发(隧道进程/本地口占用/防火墙面);`--host` 直连暴露(推翻回环裁定,token 强制+TLS 新工程) |
| 远程 runtime | **厚形态:部署自含 server bundle**(2026-11-24 用户裁定,否决薄形态零部署)——单文件纯 JS cjs,版本化原子部署;远程前提 = 登录 shell PATH 有 node ≥ 22 | 薄形态零部署(exec+SFTP+pty 三件套,无 server;PATH 继承短板);便携 node 上传(v1 不做,YAGNI,登记演进) |
| agent 循环归属 | **本地驱动**(2026-11-24 用户裁定):LLM 调用/harness/记忆/账本全在本地 daemon,密钥零同步 | 远程自治(远程跑完整 harness;密钥同步面大,登记 v2 演进) |
| v1 后端范围 | **仅 ssh**;工厂按 local/ssh/wsl/docker 四 kind 定形(2026-11-24 用户裁定「先完成 ssh」) | wsl/docker v1 实施(各带独立路由/测试/生命周期负担,登记演进) |

## 2. 架构总览

```
GUI(浏览器 / Electron 壳)
  │ HTTP/WS 单连接(现行,回环,零改动)
  ▼
本地 daemon(sunshinex serve)
  ├─ harness 循环 + LLM 调用(密钥/设置/记忆/账本全本地)
  ├─ BackendFactory(root scheme → 执行后端;兑现 types.ts:494 预留位)
  │    ├─ local  → ProcessSandbox(现行,零改动)
  │    └─ ssh    → SshBackend(channel 连接池注入;v1)
  │    └─ wsl / docker → 注册形态位,v1 不实现(§13)
  ├─ RemoteHostManager(src/serve/remote/)
  │    ├─ host-store.ts   主机档案 remote-hosts.json(userConfigDir)
  │    ├─ connection-pool.ts  ssh2 Client 池:按 hostId 单连接/引用计数/keepalive/退避重连
  │    ├─ deployer.ts     server bundle 部署器(版本比对/SFTP 上传/.new 原子换装)
  │    ├─ protocol.ts     sunx-remote 帧协议编解码(§6)
  │    └─ handlers.ts     HTTP 运维面(/remote/hosts 族 + /remote/dirpicker)
  └─ serve 层按工作区形态路由(file/tree/git/changes/pty/dirpicker,§8)
       │ ssh2 常驻连接:exec channel(协议 stdio)+ SFTP 子系统 + pty channel
       ▼
远程机(~/.sunshinex/remote/,零网络监听,唯一入口 = 用户 sshd)
  ├─ server.cjs      执行服务 bundle(纯 JS 单文件)
  ├─ version         {version, sha256, protocol} 版本档
  └─ node ≥ 22(远程已有,v1 不上传)
```

## 3. 远程工作区形态

- **root scheme**:`ssh://<hostId>/<远程绝对路径>`(hostId = 主机档案稳定 id,别名仅档案显示字段——改别名不断链)。路径串由**远程侧语义解释**,daemon 侧禁止对 root 做 path.join/resolve 类本地 path API(Windows 远程 `C:\...` 同样成立)。
- **slug**:`projectSlug` 对 `ssh://` 形态绕开 `path.resolve`,直接对 URI 串折叠(非安全字符 → '-' + 12 位摘要,现行算法语义不变);同一远程项目 slug 稳定,数据档落本地 `resolveDataDir` 不变。
- **注册**:`POST /workspaces` 增加 `remote` 分支 `{hostId, path}`——不走 statSync,经通道 stat 探测(不存在/非目录 400),workspace.json 落 `{root: 'ssh://...'}`。幂等重添加语义与本地一致(隐藏档摘除,workspace-handlers.ts:107 先例)。
- **建会话/attach**:`createSessionIn` 的 statSync 门按形态分发(远程走通道 stat);attach 的 `rehomeRoot`/`fs.existsSync`(session-lifecycle.ts:283)同口径;SUNSHINE.md 缺档降级与本地同语义。
- **WorkspaceRow** 增 `kind: 'local'|'remote'` + `hostId`(+ 档案显示名 `hostName`,冗余透出省 GUI 二次拉);两形态组头/徽标消费(§9)。

## 4. 连接层

- **主机档案**:`{id(ulid), name, host(user@hostname 或 ~/.ssh/config 别名), port?, auth: 'agent'|'key'|'password', keyPath?, keyPassphrase?, password?, enabled}` 落 `userConfigDir/remote-hosts.json`(与 schedules/channels-bindings 同层,坏档 quarantine 同款)。凭据内联 + GET 回显开关(2026-11-22 channels secret 裁定同口径)。引用 `~/.ssh/config` 别名为推荐形态:凭据由用户 OpenSSH 自己管,daemon 零落盘。
- **认证四类**(ZCode 同款):key(path + 可选 passphrase)/password/agent(`SSH_AUTH_SOCK`;Windows OpenSSH agent 命名管道 ssh2 原生支持)/keyboard-interactive——档案 `auth` 字段存主凭据形态三种,keyboard-interactive 为 password 形态下的自动回退模式(ZCode tryKeyboard 同构),不单独建档。keepalive 15s×3,握手超时 60s,连接测试面给归一化中文错误(私钥需口令/口令错误/握手超时三分支,ZCode normalizeSSHConnectError 同构)。
- **host key 校验**:`~/.ssh/known_hosts`,首连 TOFU 记录(带指纹确认提示),指纹变化拒连(channels 供应链防线同品味;ZCode 未做此校验,本仓库从严)。
- **连接池**:每 hostId 至多 1 条 ssh2 Client;引用计数(活跃会话/终端/在途部署),归零闲置 60s 断开;断线指数退避重连(1s 起,30s 封顶);连接状态外窥(hosts 列表带 state: idle/connecting/ready/error + 最近错误)。
- **HTTP 面**:`GET /remote/hosts`(列表+状态)/`POST /remote/hosts`(添加)/`PATCH :id`(改)/`DELETE :id`(删,活跃工作区引用时 409)/`POST :id/test`(连接测试)/`GET /remote/dirpicker?host=&path=`(通道目录枚举,复用 dirpicker 响应形状)。

## 5. 部署器与远程 runtime

- **产物**:`sunshinex-remote-server.cjs` 单文件 bundle(esbuild,`scripts/` 新增 bundle 脚本,gui:build 先例);纯 JS 零原生模块——PTY 走 ssh2 pty channel、文件走 SFTP 直传(均不经 server,§6),因此**不需要 node-pty 预编译矩阵与 ABI 配对**(对齐 ZCode 混合形态:文件即走 SFTP)。
- **远程布局**:`~/.sunshinex/remote/server.cjs` + `version`(`{version, sha256, protocol}`);更新 `server.cjs.new` 写入 → rename 原子换装(ZCode 同款);部署后 sha256 复核。
- **部署流程**:连接建立 → 远程探测(登录 shell `node --version`,< 22 报明确指引,便携 node 登记演进)→ 版本档比对 → 缺/不符才 SFTP 上传 → chmod +x → 拉起。同一 host 并发部署互斥(池内单飞)。
- **拉起与生命周期**:login shell 前台执行 `node ~/.sunshinex/remote/server.cjs`(继承完整用户环境,解决非交互 PATH 短板);协议跑在 exec 通道 stdio;**server 生命周期挂连接**——ssh 断/channel 关 → stdin EOF → server 自杀退出;重连 → 部署检查(秒级跳过)→ 重拉起。远程后台任务随连接存活,断线即死(如实限制,§13 detach+unix socket 重连登记演进)。
- **体积预期**:纯 JS 单文件(百 KB 级),对位 Claude Code 远程装机 ~1 GB / ZCode node+pty 多组件,部署秒级。

## 6. sunx-remote 协议 v1

- **传输**:exec 通道 stdio;stdout = JSON-lines 帧(UTF-8,\n 分界);stderr = server 日志(daemon 侧诊断透传,不入协议)。
- **帧**:hello `{kind:'hello', version, protocol:1, node}`(server 启动首行);请求 `{id, kind:'req', method, params}`;响应 `{id, kind:'res', ok, result|error}`;事件 `{kind:'evt', event, ...}`。
- **方法面 v1(仅 exec 家族——fs 走 SFTP、pty 走 ssh2 channel,均不经协议)**:
  - `exec.start {cmd, cwd, env?, timeoutMs}` → `{execId}`,事件 `exec.data {execId, stream:'stdout'|'stderr', chunk}` / `exec.exit {execId, exitCode, aborted?}`——**前台后台统一流模型**:前台 exec = daemon 侧 await exit,现行 120s 超时转后台语义保留(到点不杀,execId 转登记后台任务账本);`execBackground` = 同 `exec.start` 不等待。
  - `exec.kill {execId, signal}` → `{}`(远程进程树收割;task_stop 单点语义对齐 ProcessSandbox.abortKill)。
  - `ping` → `{pong}`(daemon 30s 心跳,僵死探测,叠加 ssh2 层 keepalive)。
- **中止单点**:run 中止信号(harness runSignal)→ 对应 execId 全量 `exec.kill`(EXEC_ABORTED 语义与本地一致)。

## 7. ToolBackend 接入(SshBackend 与 harness 治理)

- **依赖**:ssh2 候选池转正(CLAUDE.md §5 评审:维护活跃/类型完善(@types/ssh2)/许可证 BSD——记录于台账)。
- **SshBackend**(`src/harness/security/ssh-sandbox.ts`)`implements ToolBackend`(name='ssh'):exec → 协议 exec.start;readFile/writeFile/listFiles → SFTP;execBackground → exec.start 不等待;killBackground → exec.kill。连接池由 serve 层注入(连接生命周期归 daemon,harness 只持接口)。中止收割/超时转后台/runSignal 语义与 ProcessSandbox 逐条对齐(daemon.test 锚)。
- **BackendFactory**:harness 装配点(harness/index.ts:267 `new ProcessSandbox()`)改为按 root scheme 分发;`name` 随后端,工具面零感知。
- **harness root 面治理清单**(远程形态下):
  - 通道化:context/loader.ts(SUNSHINE.md 经 backend.readFile)、tools/builtin.ts 图片直读。
  - 显式降级(明确报"远程项目不支持",不静默假成功):perception root 扫描降级(仅远程 root 直读探测改通道 stat 单点)、项目技能五根(skills.ts,只读 user 级)、worktree.ts(worktree 隔离入口隐藏)、chain.ts rootReal(realpath 跳过,信任远程侧)。
  - daemon 的 root `.sunshinex` fs.watch(daemon.ts:351):远程形态不挂(无热重载,登记演进)。
  - 落 dataDir 的持久化面 22 文件其余部分:零改动(数据在本地)。

## 8. serve 层路由

各 handler 按 WorkspaceRow 形态(kind/hostId)分发,**路由判定单点**(workspace 形态谓词,防散落):

- file-handlers:handleFile/handleAppFile/handleTree/walkTreeBounded → 远程走 SFTP/通道枚举;`git check-ignore`(gitIgnoredPaths:62)→ 远程走协议 exec。
- session-changes:git 全家桶 13 函数 → 远程形态 `exec.start`(git 在远程跑,`-C` 传远程路径);discardUnstaged 的 fs.rmSync(:268)→ 通道删改;workspaceFiles(:503)→ 通道枚举。
- pty-handlers:远程会话终端页签 → ssh2 pty channel(pty.spawn 换 channel open `{pty:true, term, cols, rows}`;resize/数据/退出事件对齐现行 PtyManager 面);App 级页签 v1 仅本地。
- dirpicker:远程模式走 `GET /remote/dirpicker`(通道 readdir),响应形状复用现有 DirPickerResp。
- workspace locate(标记文件全盘定位):仅本地语义,远程形态不适用(入口隐藏)。
- editors-handlers:远程工作区禁用(GUI 钮隐藏,直调 400 明确报错)。
- images/diff/cache/app-state:经 dataDir 或会话快照,零改动。

## 9. GUI 面(表现层)

- **工作区选择统一面:DirPicker 增「远程」页签**(四处共用一处改:侧栏「添加工作区」/NewSunxDialog/欢迎页工作区切换/ScheduleConfig)。远程页 = 主机下拉(已存连接 + 底部「添加 SSH 连接…」,Claude Code 环境选择器同款)+ 该主机远程目录逐级浏览(通道枚举,DirPicker 现行交互不变)+ 确认注册。
- **主机管理在设置页**(Codex Settings → Connections 同位):新「远程主机」pane——列表(name/host/state 徽标)/添加/编辑/删除/连接测试;添加表单字段对齐 Claude Code:Name(可选)/SSH host(user@hostname 或 ~/.ssh/config 别名)/SSH port(可选)/SSH key 路径(可选)/口令(密码框回显开关)。
- **项目分组混排**:远程工作区与本地同列(workspace-list 内),组头 🖥 徽标 + hostName(`WorkspaceRow.kind` 消费);排序/折叠/归档/移除/钉选全部现行语义复用。
- **Sunx 区**:平铺聚合天然纳入远程 Sunx 会话(跨工作区聚合按 root 归属,数据在本地);行信息卡增主机名;NewSunxDialog 工作区下拉含远程工作区。
- **降级项提示**:远程项目组内不出现 worktree 入口/编辑器打开钮;项目级技能来源提示只读 user 级;full-access 提示注明"将在远程机器执行"。
- 终端页签/文件页签/目录页签/diff 页签对远程会话行为无感知差异(路由在 daemon)。

## 10. 安全面

- 回环绑定/token 体系零变化;远程零网络监听(唯一入口 = 用户 sshd);SSH 认证即通道认证,无传输面 token。
- host key:known_hosts TOFU + 指纹变化拒连(§4)。
- 凭据:引用 ~/.ssh/config 零落盘为默认;档案直存密钥走 channels secret 口径(内联 settings 形态、GET 回显开关、密码框显隐)。
- 供应链:远程项目的 SUNSHINE.md 通道读取但项目技能五根降级只读 user 级(收窄注入面,channels 供应链裁定同品味);full-access 提示注明远程执行;server bundle sha256 部署复核。
- 执行边界如实告知:远程会话的命令执行发生在远程机,审批/权限档语义不变(档在本地 harness,执行点在远程)。

## 11. 测试计划

- 协议:编解码/握手/hello 超时/帧界单测;**ssh2 库 server 模式起内存 SSH server**做 SshBackend/连接池集成测试(免真实 sshd,覆盖认证失败/host key 拒连/断线退避)。
- 部署器:版本比对/原子换装/sha256 复核单测(本地 fs 模拟远程侧);并发单飞。
- BackendFactory:root scheme 分发、slug 绕 path.resolve、远程注册幂等/隐藏档、createSessionIn 通道 stat 门、attach rehome——daemon.test 锚风格。
- serve 路由:file/tree/git/changes/pty 按 kind 分发 handler 单测(mock 通道;现行 handler 测试补 remote 分支锚)。
- GUI:DirPicker 远程页/设置 pane/徽标/NewSunxDialog 远程下拉组件测试(现行测试口径);i18n 双语键。
- e2e(可选 slow 标记):Windows OpenSSH 本机回环 ssh 真连接冒烟。

## 12. 分期与验收

1. **阶段一(骨架)**:ssh2 转正 → 协议/连接池/部署器 → SshBackend + BackendFactory → 远程工作区注册/建会话/attach 工具链全通(命令执行/文件读写)。验收:CLI 侧可对 `ssh://` root 建会话跑通一轮 exec/read/write。
2. **阶段二(serve 全量)**:file/tree/git/changes/pty/dirpicker 路由 + harness 降级面(SUNSHINE.md 通道化,perception/skills/worktree/watch 显式降级)。验收:远程会话文件页签/目录页签/diff/变更/终端全可用。
3. **阶段三(GUI 完形)**:DirPicker 远程页/设置 pane/徽标/Sunx 区主机名/降级提示。验收:全程 GUI 完成添加主机→添加远程工作区→新建会话(项目+Sunx 两口)→对话操作→终端。
4. 验收总口径:本地项目行为零变化(现行测试全绿);远程项目在项目分组与 Sunx 域为一等工作区;远程机除 node≥22 与 sshd 外零前提、零网络监听。

## 13. 后续演进(不在本 spec 实施范围)

- 便携 node 上传(远程无 node ≥ 22 时自部署,ZCode node/<arch> 先例)。
- 断线续跑:server detach + unix socket 重连(ssh2 direct-streamlocal)。
- **wsl 后端**(Windows + 项目在 WSL2 ext4:Linux 工具链/NTFS 性能与权限位回避;传输 = wsl.exe -d <发行版>,文件走 \\wsl$\<发行版>\ UNC;root scheme `wsl://<发行版>/路径`)。
- **docker 后端**(devcontainer 对齐/工具链钉版/full-access 硬隔离边界;传输 = docker exec / dockerode(候选池已登记),root scheme `docker://<容器>/路径`)。
- handoff 式会话搬家(Codex 先例:聊天+git 状态跨主机 worktree 迁移;本仓库 worktree 基建在座)。
- 远程 `.sunshinex` watch 与项目技能五根通道化(收窄现降级面)。
