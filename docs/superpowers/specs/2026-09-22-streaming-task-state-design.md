# 流式会话三态状态机设计（Streaming Task State Machine）

- 日期：2026-09-22
- 状态：已批准（用户在问卷通道批准事件面落 reactor + 模型宣告 tool call 即 pending，随后批准设计五节全文）
- 对标：Claude Code 客户端工具调用状态机（pending → in_progress → completed/failed，事件驱动推进、渲染层只消费状态）与 Anthropic 流式协议「块宣告与块完成是两个独立时刻」的分界语义

## 1. 问题

当前 `step` 事件只在模型已产出动作时发射（reactor.ts L359），工具调用行上屏即为完成态。会话运行期间存在两个对用户不可见的关键窗口：

1. **思考窗口**：模型轮发起（prompt 已装配、请求已发出）到首个 token / 动作解析完成之间——用户只能看到 Spinner 兜底动画，不知道系统在做什么、处于哪个阶段。
2. **执行前窗口**：`tool-call` 事件虽在执行前发射，但事件本身不携带状态语义——manual 模式审批挂起期间，调用行已上屏却无「等待审批」的显式状态；执行瞬间与完成态在事件面上不可区分。

TUI 的 Spinner 是唯一的活动指示，且与具体动作无关联。该缺陷属事件面缺态而非展示层缺功能：TUI 无从展示它没收到过的状态，GUI 未来也会遇到同一问题。

## 2. 设计原则

1. **三态建在事件面（reactor 层）**：状态的产生与推进在 harness 底座完成，TUI/GUI 只消费同一状态面渲染——切换交互面零重推导。
2. **事件驱动状态机**：每个工具调用是一个状态对象，由事件流纯函数推导（对标 CC 客户端形态），渲染层不做业务推断。
3. **旁路遥测边界**：新事件全部不进提示词、不进会话链，前缀缓存零影响（沿 route/ctx 先例）。
4. **零破坏扩展**：既有事件发射时机与文本载荷一字不动，只增可选字段与新增事件类型。

## 3. 事件面（types.ts + reactor.ts）

### 3.1 新增事件类型

`SessionEventType` 联合扩展两个成员：

```typescript
| 'model-start'   // 模型轮发起：prompt 已装配、请求即将发出
| 'model-end'     // 模型轮结束（成功返回，含 done 轮）
```

### 3.2 事件载荷

```text
model-start   { step: number }            // 当前步号
model-end     { step: number, ms: number } // 当前步号 + 本轮耗时（旁路遥测，供状态栏/调试）
```

发射点（reactor.ts chat 主通道单点）：

- `model-start`：`chatRound` 进入即发射，先于流式首 token；
- `model-end`：模型轮成功返回处发射（含 `ms` 耗时）。错误路径不发射 `model-end`，由既有 `error` 事件承载终态。

### 3.3 既有事件语义细化（只增可选字段）

```text
tool-call    载荷增 { callId, status: 'pending' }
tool-result  载荷增 { callId, status: 'completed' | 'failed' }
```

- **callId**：`step:N-idx:M`（步号 + 批内序号），reactor 单点生成，确定性、无随机源（动态面审计合规），可从 journal 重放逻辑推导；
- **status: 'pending'** 固化 tool-call 的「已宣告未完成」语义——发射时机不变（执行前），manual 审批挂起窗口天然落在 pending 态内；
- **status: 'failed'** 对应 `ok:false` 的结果（含安全链拒绝），**completed** 对应 `ok:true`；
- 串行与并行批（`runParallelTools`）每项调用独立 callId，天然支持多工具并行三态。

### 3.4 前缀缓存与持久化边界

- 新事件与新增载荷字段全部为旁路遥测，不进提示词、不进会话链、零前缀击穿；
- journal 词汇表零扩展：状态对象为瞬态，不落盘（沿 children 瞬态先例）；/rewind /fork /resume 零波及——恢复后处于 idle，历史消息与三态无关；
- 无时间戳/随机值进提示词面，动态源仅存在于事件载荷（旁路遥测豁免区）。

## 4. SessionController 状态层（src/tui/session.ts）

### 4.1 LiveTaskState

```typescript
interface ActiveCall {
  callId: string;
  verb: string;
  target?: string;
  startedAt: number;
}

interface LiveTaskState {
  phase: 'thinking' | 'tool-pending' | 'tool-awaiting' | 'responding' | 'idle';
  activeCalls: ActiveCall[];
}
```

### 4.2 状态机（applyTaskState 纯函数）

单点纯函数 `(state, event) => state`，由事件流驱动推进：

```text
idle        --task run start-->            thinking
非 idle     --model-start-->               thinking（循环轮从任意活动态回思考态）
thinking    --token 增量-->                 responding
任意活动态  --tool-call(status=pending)-->  tool-pending（activeCalls push；
                                           chat 原生 tool calling 下无正文 token、
                                           tool-call 可直接从 thinking 到达）
tool-pending --审批挂起（approval-request）--> tool-awaiting
tool-awaiting --审批通过-->                  tool-pending（回到执行）
tool-pending --工具执行完成-->                按 tool-result 移除该 callId；
                                            批内仍有未决调用 → 保持 tool-pending
activeCalls 清空 / --done / --error-->      idle（收口归位）
中断（interrupted）-->                       activeCalls 清空 → idle
```

要点：

- token 增量到达即 thinking→responding 切换（正文流式本身即状态呈现）；
- 审批挂起是 tool-pending 的显式子态 tool-awaiting，与审批卡并存；
- 纯函数单点、输入输出确定、可直接单测（不挂 useInput、不依赖渲染）；
- 状态对象挂 `RetainedUiState` 同级瞬态，journal 不落盘。

## 5. TUI 渲染层（只读消费）

- **Spinner 行升级**：从「唯一兜底动画」改为消费 `LiveTaskState.phase`——thinking 显示思考动词 + 已耗时；tool-pending/tool-awaiting 显示 `● [VERB] target` 活动态行（awaiting 标注等待审批）；responding 时静默（正文流式即状态）；idle 不显示；
- **调用行两态**：`tool-call` 到达即上屏 `● [VERB] …`（pending 形态），`tool-result` 到达原位转 `⎿ 结果行`——现有成对发射结构不变，pending 窗口期该行由状态态渲染；
- **审批卡协同**：tool-awaiting 与审批卡并存（审批卡本身是显式等待态）；中断/拒绝时该调用行直接转失败结果行；
- **帧高不变量**：状态行复用现有 Spinner 槽位、恒定行数，不构成动态区高度波动源。

## 6. GUI 前瞻

GUI 立项后直接消费 `LiveTaskState`（或未来抽取到交互面共用层的同一状态对象）：phase 驱动布局态（思考动画/工具列表/流式正文），activeCalls 驱动调用卡片状态徽标。交互面只读状态渲染，事件重推导逻辑零重复。

## 7. 测试与验收

1. `applyTaskState` 状态机全覆盖：thinking→responding→tool-pending→awaiting→completed 主链、并行多 callId、审批拒绝转 failed、中断清理、/new 归零；
2. reactor 新事件发射时序断言：model-start 先于首 token、tool-call 带 callId 与 status、tool-result 配对同 callId、model-end 带 ms；
3. TUI 渲染用例：pending 态行形态、审批挂起态、done/idle 归位、/new 清态；
4. 既有前缀稳定回归用例保持全绿（新事件零前缀影响为回归红线）；
5. 门禁：`pnpm build`（tsc strict 零报错）+ 全量测试 fail 0 + `pnpm selfcheck` OK。

## 8. 不做（YAGNI）

- 服务端工具进度流（progress 事件流）：当前工具执行为同步单次调用，无进度信号源，登记为未来工具面增强；
- model-start 覆盖文本回退通道：文本通道属 reactor 遗留退役面（TECH-DEBT-LOG D16），本设计只接 chat 主通道；
- GUI 渲染实现：本设计只保证状态面共用，GUI 消费形态待 GUI 立项时定；
- journal 状态持久化：瞬态不落盘，恢复后 idle。
