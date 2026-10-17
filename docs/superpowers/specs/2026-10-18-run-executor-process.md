# 设计档:run 执行器独立进程化(2026-10-18,session-kernel spec §10-7b)

> 目标:GUI daemon 重启不中止在途 run。前置:P7 已把执行面收敛到 `KernelRuntime.runTask` 单点
> (`5691f3b`)——进程化的自然切割面已就位。状态:**设计定版,实施未开始**(P8a/P8b 两片,见 §7)。

## 0. 目标与非目标

- **目标**:daemon 进程重启/崩溃时,在途 run 在独立进程中继续执行;新 daemon 上线后重接,事件流
  无损续传(转录/统计/待办/队列与未重启形态一致);审批/问询挂起跨重启存活。
- **非目标**:TUI 进程化(TUI 即用户进程,Ctrl+C 本就是用户意图);CLI 面化;§10-8 GUI 单进程
  (二期,另一形态);多机/远程执行(恒 127.0.0.1)。

## 1. 进程模型裁定:每 run 链执行器子进程(选型 b)

| 选项 | 形态 | 判定 |
|---|---|---|
| a) 工作区会话宿主常驻进程 | SessionRuntime 整体迁入宿主,web daemon 退化纯代理 | 否——serve/ 全部 handler io 面改 RPC(~24 文件),journal 单写者反而要重立(P2 语义推翻);重启安全收益相同,churn 大一个量级 |
| **b) 每 run 链执行器子进程** | `SessionRuntime` 留守 daemon;submit 时 fork 执行器子进程承载 `KernelRuntime` 全量(runTask 入口+续跑链),daemon 重启子进程自活 | **取**——字面合 spec;churn 收敛在 submit/run 通路;子进程寿命有限(链终即退)自清理 |
| c) run 线程池 | 无进程隔离 | 否——不达目标 |

**子进程承载粒度=「run 链」而非单 run**:G14.89 轮收束自动续跑(队列非空取队首续发)是 run 链
语义,随执行器进子进程——链尽(队列空)子进程交还写者权并退出。steer 入队发生在链内( reactor
drain/轮收束),子进程在链存活期**独占**队列态(P5 内核 ops 全套随之在子进程)。

## 2. 职责划分(交接面)

| 状态/职责 | 子进程(链存活期) | daemon(始终) |
|---|---|---|
| KernelRuntime(harness/loop/reactor) | **持** | — |
| 转录内核 KernelState + steer 队列 | **持**(投影+ops 执行) | 镜像投影(事件喂入不落档) |
| journal 写者(v2 行:seg/chain/runmeta/steer/user) | **独占** | 抑制(persistKernelEvent 旁路) |
| 链续跑(G14.89 takePending→submit) | **持** | — |
| 审批/问询挂起 Promise | 持(P6 suspend* 在执行器内被 guard 调) | 广播帧+回执路由(P6 语义不变,resolve 经控制通道回子进程) |
| seq 分配/环形缓冲/WS 广播/snapshot | — | **持**(帧无 seq 上行,daemon 转发时分配) |
| HTTP/WS/静态/pid 铸造 | — | **持** |

单写者不变式(P2)保持:**同一时刻 journal 恰一写者**——链存活期=子进程,链外=daemon。交接是
时间盒:子进程 start 前写 `writer: child` 行(新 v2 元行 `{"t":"writer","who":"child","runId"}`),
end 写 `writer: daemon`;daemon 装载时按末条 writer 行判读档尾归属,防双写窗口。

## 3. 子进程形态与启动

- 入口:`dist/serve/executor/child.js`(新 CLI 隐藏命令 `__executor` 同源装配,`process.execPath`
  直spawn,不经 CLI 参数解析面);
- 生命周期:`submit` 受理且装配完成 → `child_process.spawn(process.execPath, [child.js, specFile],
  { detached: true, stdio: ['pipe','pipe','pipe'], windowsHide: true })`;`detached` 使子进程脱离
  daemon 进程组(POSIX 换组/win32 CREATE_NEW_PROCESS_GROUP+不挂 job)——**daemon 死子进程不死**;
- specFile(临时 JSON,`<dataDir>/executor/<runId>.spec.json`):root/journalId/goal/tier/effort/
  mode/model 装配面(见 §4)/steer 队列快照(P5 items)/上下文种子引用(journalId——子进程自行
  `restoreSession` 装载链,与 attach 同序);启动即读、读完可删;
- 模型装配序列化:daemon 把**生效装配面**写入 spec(provider 清单=loadProviders(root) 结果+
  buildModel 同款 flags 集+effort 缺省+ModelSwitcher 当前 id)——子进程同源工厂重建(buildModel/
  loadProviders 均为 root+flags 纯函数,环境变量 env 同机继承);不传适配器实例。
- 退出语义:链尽(run 收束且队列空)→ 写 writer 行 → stdout 发 `done` → flush → exit 0;
  interrupt 后链尽同径;异常 → error 事件 + exit 1;daemon 主动 kill(specFile 删除+SIGTERM,
  3s 后 SIGKILL)仅 reset/delete 场。

## 4. IPC 协议(JSONL;P8a=stdio 管道,P8b 增 TCP 活控通道)

**下行(daemon→child,stdin)**:`{t:'steer', op:'enqueue'|'edit'|'move'|'front'|'remove'|'takePending', ...}`
(P5 ops 直通)/`{t:'interrupt'}`/`{t:'reply', kind:'approval'|'ask', pid, decision|answer}`/
`{t:'ping'}`。

**上行(child→daemon,stdout)**:`{t:'ready', runId}`/`{t:'event', e:SessionEvent}`(全事件流,
与 pump 同源同序)/`{t:'pending', kind, req}`(挂起登记请求)/`{t:'queue', items}`(P5 队列变更
快照,daemon 转 queue 帧)/`{t:'done', runId, stopReason}`/`{t:'log', line}`(stderr 旁路)。

- 纪律:stdout 只走协议 JSONL(框架/依赖的 console 输出重定向 stderr——执行器入口首行即劫持
  console.log);消息不加 seq(事件序=行序,管道有序;P8b TCP 同 Socket 有序语义);
- 尾随语义:daemon 死→stdin EOF→子进程**继续跑**(唯一使命),事件照写 journal、内存环形缓冲
  (容量 4096,复用 EVENT_BUFFER_CAP 语义)备重接补发;子进程死→daemon 读到 stdout close 且无
  done→run 以 `stopReason:'executor-lost'` 收束(error 帧+悬空 run 标 stopped,重载语义复用 §3.2
  reduceV2Rows 悬空 run 路径);
- 心跳:daemon 1s ping/5s 未回判僵尸(P8a 阶段仅记日志不 kill——kill 语义与重启安全矛盾,
  P8b 由活控通道接管 kill)。

## 5. 重启重接(P8b 核心)

- **会合点**:`<dataDir>/executor/<runId>.run.json` = `{pid, port, token, startedAt, root,
  journalId, specDigest}`(mode 0600,serve-token 同纪律);子进程 P8b 起加听 `127.0.0.1:0`,端口
  进 run.json;链尽删除该文件;
- **adopt 序**(daemon 启动/工作区发现时):扫各 dataDir executor/*.run.json → pid 存活探
  (`process.kill(pid,0)`)+ token 握手(`{t:'hello', token}`)→ 活执行器表挂管:该会话标记
  running(状态自执行器 `status` 查询,不自持)→ 转录重建(journal 重放=既有 attach 序,末条
  writer=child 则 tail 段留给补发)→ 补发:向执行器要环形缓冲回放(seq 重排自新 daemon 计数器,
  客户端经 reseed 快照对齐,无跨重启 seq 承诺——与 G4 客户端语义一致);
- **孤儿清扫**:run.json 在而 pid 死→删除文件+转录按悬空 run 标 stopped(重载面既有);
  startedAt 超 24h 的残留 spec 文件清扫;
- **审批跨重启**:挂起 Promise 在子进程,daemon 重启丢路由表——重接后执行器经 `{t:'pending'}`
  重发未决清单(环形缓冲同源),新 daemon 重铸 pid(旧 pid 不保——客户端 reseed 重建卡,与
  G7 快照重建同径)。

## 6. Windows 语义与测试策略

- win32:`detached:true` 即 CREATE_NEW_GROUP,不进 daemon job 对象(spawn 默认不挂 job,显式
  不用 `windowsHide` 之外的 job 绑定);杀链用 taskkill /T 兜底;TCP 活控恒 127.0.0.1;
- 测试:P8a——执行器往返(daemon fork 子进程跑 ScriptedAdapter 链,事件/转录/队列与 in-process
  形态逐字段等)+ 写者交接(链中 daemon 落档暂停、子进程行在档、链尽写者行翻回)+ 中断/审批/
  队列 ops 控制通道往返;P8b——kill daemon(子进程 detached 存活)→ 新 daemon adopt → 事件续传
  断言;孤儿清扫;win32 CI 双跑。

## 7. 实施切片

| 片 | 内容 | 达成 |
|---|---|---|
| **P8a** | 执行器子进程+stdio 协议+写者交接+控制通道(steer/interrupt/reply)+链续跑随迁;daemon 仍 fork 即管(不 detach) | 进程边界与全部协议落地,行为零可见变化(重启仍杀 run——子进程随父死,P8b 解) |
| **P8b** | detached+run.json 会合点+TCP 活控通道+adopt 序+孤儿清扫 | 目标达成:daemon 重启在途 run 无损续传 |
| P8c(可选) | 执行器日志面(`<dataDir>/executor/<runId>.log`)与 `sunshinex ps` 活执行器清单 | 可观测性 |

## 8. 已识别风险

1. **queue/pending 双侧语义**:链存活期态在子进程,daemon HTTP 面全部变代理——P5/P6 的 ops 契约
   必须在 IPC 面逐字保留(回执/越界 400 语义由 daemon 面继续承担);
2. **写者交接竞态**:submit fork 前后、链尽交还窗口的双写——writer 行+顺序纪律(§2)钉死,
   测试压竞态窗口;
3. **模型装配漂移**:spec 序列化的 provider 面与 daemon 内存实例若不同源,同一会话前后两轮模型
   不一致——同源工厂+specDigest 锚定;
4. **僵尸执行器**:daemon 反复重启残留 detached 子进程——run.json 会合点+孤儿清扫+链尽自退
   三层兜底;执行器自身崩溃=run 失败(比 daemon 崩溃面小一个量级)。
