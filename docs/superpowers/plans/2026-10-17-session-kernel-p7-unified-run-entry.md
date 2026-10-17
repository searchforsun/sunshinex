# Plan 7:双执行路径统一入口(spec §10-7a)

> 前置:P1-P6 已落地(`aa58bf8`…`fddf5b6`)。§10-7 两段:**a) Reactor 单发/Loop 模板双执行路径
> 统一入口**(本 plan);**b) run 执行器独立进程化**(大项——独立进程+重启续跑协议,另起 plan,
> 本 plan 落地后执行面词汇已收敛为其前置)。

## 0. 现状勘察(2026-10-18 代码实测)

**执行路径清单**:

| 路径 | 入口 | 生产消费 | 判定 |
|---|---|---|---|
| Loop 模板 | `KernelRuntime.runTask/runLoop` → longTaskTemplate/resolveTemplate → engine → nodes 内每 agent 节点构造 Reactor | TUI ctrl/daemon SessionRuntime/CLI run-loop/run-pipeline | **主路径(D5 主链唯一入口)** |
| 单发 Reactor | `harness.reactor.run(...)`(harness/index.ts:326 构造) | **零**——仅 e2e.test ×2、worktree-launch.test ×1 | 旁路死重量:生产装配即构造、从不 run |
| 域内自建 | nodes.ts:183(每 agent 节点)、teammate.ts:264(taskboard 执行体) | 生产 | 执行器内部构造细节,非第二入口 |
| 观测面 | `harness.reactor.stableSegment()`(reactor.ts:442 纯函数) | TUI /context、daemon /context、tui 测试 | 挂在 Reactor 上的 prompt 纯函数,借道执行器命名空间 |

**问题**:单发路径是双入口残留——Harness 装配一个从不运行的 Reactor(共享 refs 无状态,纯死
重量),测试经它直跑即绕过统一入口;stableSegment 借执行器命名空间暴露观测面,入口收编前必须
先出 Reactor。

## 1. 设计定版

### 1.1 stableSegment 出 Reactor(纯函数单点)

- reactor.ts 内 `stableSegment` 方法体提取为模块级导出纯函数
  `stableSegmentOf(opts: { outputStyle?; activeRoot?; root?; contextRoot })`(行常量/行拼装逻辑
  原地不动,仅提壳);`Reactor.stableSegment()` 薄委托;
- `Harness.stableSegment()` 公开薄委托(自带 deps 组装);三消费方
  `harness.reactor.stableSegment()` → `harness.stableSegment()`(tui/session.ts:1015、
  serve/session-commands.ts:72、tui/session.context.test.ts:122)。

### 1.2 执行面裁定(实测修正:统一已由 D5 达成,P7 补锁)

实施中实测:`session/runtime.ts:62` D5 裁定注释与代码证实——**生产主链唯一入口已是
KernelRuntime.runTask → Loop 长任务模板**,"双执行路径统一入口"的主体早已落地;`harness.reactor`
在生产源码零 `.reactor.run` 消费,现存 48 处引用全在测试面(~20 个 harness 级测试文件把
`h.reactor.run` 当驱动缝,直接跑 Reactor 验 spawn/worktree/前缀稳定/settle 等行为)。删字段需
移植全部测试且改变被测拓扑(Loop 包装层),收益仅"少一个从不运行的对象"——**裁定保留字段为
测试缝,文档钉死**;本 plan 补两件实事:

- 形态钉 `reactor.unified-entry.test.ts`(D27 先例):生产源码(非 *.test.ts)零 `.reactor.run(`
  直跑、零 `reactor.stableSegment` 借道——第二路径/借道观测复发即红;
- selfcheck 模块清单照旧(h.reactor 仍在场)。

### 1.3 后置项声明(§10-7b,另起 plan)

run 执行器独立进程化(重启不中止在途 run):需要独立设计档——执行器子进程宿主
(KernelRuntime 全量)、父子 IPC(事件流上行/submit·interrupt 下行)、脱离守护与重启重接
(journal 为交接介质+活控通道)、win32 进程语义。本 plan 收敛入口词汇后,执行器边界
(KernelRuntime.runTask 单点)即进程化的自然切割面。

## 2. 实施序(实测执行)

1. stableSegmentOf 提取(prompts/shared.ts 纯函数)+ Reactor.stableSegment 薄委托 +
   Harness.stableSegment()(构造期缓存 outputStyle 口径)+ 四消费方跟改(tui/session.ts、
   serve/session-commands.ts、serve/session-handlers.ts、tui/session.context.test.ts);
2. 形态钉 reactor.unified-entry.test.ts 两断言;
3. 全量回归+提交。

## 3. 验收(2026-10-18 实测回填)

- [x] 观测面出执行器命名空间:stableSegmentOf 单点(prompts/shared.ts),Reactor/Harness 双薄委托,
      四消费方零 `reactor.stableSegment` 借道(形态钉锁)
- [x] 统一入口锁死:生产源码零 `.reactor.run` 直跑(形态钉锁;主体统一由 D5 既有落地,P7 补防复发)
- [x] daemon 全量 0 fail;tsc 0 error(GUI 护栏)
