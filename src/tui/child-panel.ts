import { t } from '../i18n';
import type { SessionEvent } from '../types';
import { toolCallLine } from './tool-verbs';
import { formatDuration, formatTokens } from './format';
import { serializeMultiline, pairChildResults } from './chat-model';
import type { ChildLiveState } from './chat-model';
import type { SessionController } from './session';

// D17 拆分件步4（docs/TECH-DEBT-SURVEY.md H1）：子代理面板态——onChildEvent/commitChild/archiveChild/
// archiveDeferred/archiveInto/markChildStopped/stopChild 迁出；pairChildResults 等纯件已随步1 在 chat-model。
// 面板态经 ctrl.state.children 与 childBufs/childPrompts/spawnCalls 单点读写，不为迁出复制状态。

/** 停单个子代理（UI 面，2026-10-02 用户裁决「子agent暂停不应连带中断主agent」）：按 label 定位在跑
 *  child 的账本任务 → task_stop 工具同款单点（stop 句柄中止其模型调用 + finish('stopped')）；主链
 *  零影响——TASK_WAIT 收到 stopped 终态行自判续跑。面板即时置终态并走延迟归档（abort 级联不保证
 *  还有 done/error 事件，UI 真相兜底）；返回是否实际停止了在跑任务 */
export function stopChild(ctrl: SessionController, label: string): boolean {
  const child = ctrl.state.children.find((c) => c.label === label && !c.done);
  const taskId = child?.taskId;
  if (child === undefined || taskId === undefined) return false;
  const tasks = ctrl.runtime.harness.tasks;
  const task = tasks.get(taskId);
  if (task === undefined || task.status !== 'running') {
    markChildStopped(ctrl, label);
    return false;
  }
  task.stop?.();
  if (tasks.get(taskId)?.status === 'running') tasks.finish(taskId, 'stopped', { marker: '[stopped: user]' });
  markChildStopped(ctrl, label);
  return true;
}

/** 停止后面板终态单点：done 置位 + 转录补停止标记行 + 延迟归档收口（与 done/error 事件路径同构） */
function markChildStopped(ctrl: SessionController, label: string): void {
  const list = ctrl.state.children;
  const idx = list.findIndex((c) => c.label === label && !c.done);
  if (idx < 0) return;
  const c = list[idx]!;
  commitChild(ctrl, list, idx, { ...c, done: true, doneAt: Date.now(), transcript: [...c.transcript, { kind: 'text', text: '[stopped: user]' }], bufText: undefined, bufThink: undefined, thinkStartedAt: undefined }, '');
  archiveDeferred(ctrl, label);
}

/** 子代理事件处理（规格 §4.3）：首事件创建面板态；增量行化、结构事件即时行化；不触达主链任何分支。
 *  流式双缓冲（2026-09-29 对标主 agent session 态）：reasoning 独立累积（bufThink，视图 6 行滚动窗实时预览）、
 *  非 reasoning 事件到达即收束为 ✻ 摘要行（对标 closeLive「Thought for Ns」+ detail 全文）；
 *  正文 token 半行遇结构边界冲刷保序（2026-09-30，见 flushBuf），空行保留（段落边界——视图增量入 Static 的稳态切割点）。 */
export function onChildEvent(ctrl: SessionController, e: SessionEvent, label: string): void {
  let list = ctrl.state.children;
  let idx = list.findIndex((c) => c.label === label);
  if (idx < 0) {
    const taskId = typeof e.payload?.subagentTaskId === 'string' ? e.payload.subagentTaskId : undefined;
    list = [...list, { label, startedAt: Date.now(), steps: 0, tokens: 0, transcript: [], done: false, prompt: ctrl.childPrompts.get(label), ...(taskId !== undefined ? { taskId } : {}) }];
    idx = list.length - 1;
  }
  const child = list[idx]!;
  let buf = ctrl.childBufs.get(label) ?? '';
  let transcript = child.transcript;
  let steps = child.steps;
  let tokens = child.tokens;
  let bufThink = child.bufThink;
  let thinkStartedAt = child.thinkStartedAt;
  /** 结构边界冲刷（2026-09-30 时序保序，替代 2026-09-28「不冲刷防碎片」）：正文半行先行入档再落结构行——
   *  否则未换行正文滞留缓冲、跨过全部工具行后与后续步正文粘连沉底（真机「工具/阶段说明集中最后」病根）；
   *  冲出的孤立半行在视图 md 段合并下不再显碎片（相邻正文自动拼段，工具行隔断处即 CC 形态——
   *  正文片段先于其后的工具块，时间线与主 agent 同构） */
  const flushBuf = (): void => {
    if (buf.length === 0) return;
    transcript = [...transcript, { kind: 'text' as const, text: buf }];
    buf = '';
  };
  /** 思考段收束（对标主 agent closeLive）：折为 ✻ 摘要行 + detail 全文（视图 Tab 展开） */
  const closeThink = (): void => {
    if (bufThink === undefined || bufThink.length === 0) {
      bufThink = undefined;
      thinkStartedAt = undefined;
      return;
    }
    const secs = Math.max(1, Math.round((Date.now() - (thinkStartedAt ?? Date.now())) / 1000));
    transcript = [...transcript, { kind: 'thinking', text: `Thought for ${secs}s`, detail: bufThink }];
    bufThink = undefined;
    thinkStartedAt = undefined;
  };
  switch (e.type) {
    case 'reasoning': {
      // 思考开段前冲刷正文半行：思考摘要行必须落在其后正文之后（时序保序）
      flushBuf();
      const delta = e.text ?? '';
      if (delta.length > 0 && bufThink === undefined) thinkStartedAt = Date.now();
      bufThink = (bufThink ?? '') + delta;
      break;
    }
    case 'token': {
      closeThink();
      // CR 剥除（2026-09-30 真机幻影高度/错位碎片实锤）：Windows 子进程输出 CRLF，
      // split 后残留行尾 CR，渲染时光标回卷产生错位碎片与凭空高度
      buf += (e.text ?? '').replace(/\r/g, '');
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      // 空行保留（段落边界）：正文增量入 Static 按空行稳态切割（对标主 agent 行级喂入的段落边界语义），Markdown 段落语义不再丢失
      transcript = [...transcript, ...parts.map((l) => ({ kind: 'text' as const, text: l }))];
      break;
    }
    case 'tool-call': {
      flushBuf();
      closeThink();
      const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : '';
      transcript = [...transcript, { kind: 'call', text: toolCallLine(e.text ?? '', e.payload?.input), ...(callId ? { callId } : {}) }];
      const calls = callId
        ? [...(child.calls ?? []).filter((c) => c.callId !== callId), { callId, target: toolCallLine(e.text ?? '', e.payload?.input), startedAt: Date.now() }]
        : child.calls;
      commitChild(ctrl, list, idx, { ...child, transcript, steps, tokens, calls, bufText: buf || undefined, bufThink, thinkStartedAt }, buf);
      return;
    }
    case 'tool-result': {
      // 同 tool-call：半行冲刷保序，随后结果行入档；callId 随行（并行批视图按 callId 归位到对应调用行下）
      flushBuf();
      closeThink();
      const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : '';
      transcript = [...transcript, { kind: 'result', text: e.text ?? '', ok: e.payload?.ok === true, ...(callId ? { callId } : {}) }];
      const calls = callId ? (child.calls ?? []).filter((c) => c.callId !== callId) : child.calls;
      commitChild(ctrl, list, idx, { ...child, transcript, steps, tokens, calls, bufText: buf || undefined, bufThink, thinkStartedAt }, buf);
      return;
    }
    case 'step':
      flushBuf();
      closeThink();
      steps = child.steps + 1;
      // 任务带/消息行(2026-10-06 用户定版):tagged step 载荷落结构行——task=委派任务内容(灰底带),
      // message=agent 间交流(✉);两者与正文/工具行视觉区分,轮次边界即任务带边界
      {
        const taskBand = typeof e.payload?.taskBand === 'string' ? e.payload.taskBand : undefined;
        const messageLine = typeof e.payload?.messageLine === 'string' ? e.payload.messageLine : undefined;
        if (taskBand !== undefined) transcript = [...transcript, { kind: 'task' as const, text: taskBand }];
        else if (messageLine !== undefined) transcript = [...transcript, { kind: 'message' as const, text: messageLine }];
      }
      break;
    case 'usage':
      // per-run turnTotal 为该子代理 run 的累计值（单一 run），直接采信
      tokens = typeof e.payload?.turnTotal === 'number' ? e.payload.turnTotal : child.tokens;
      // 子代理 token 两级累计（规格 2026-09-26-stats-enhancement §3.3）：per-run 累计值取对子代理前值的增量并入，
      // 归档不清零、仅 /new 归零；状态栏 ↑tokens 合并项与任务收尾统计行差值基线的同一数据源
      {
        const cm = ctrl.state.metrics;
        const delta = Math.max(0, tokens - child.tokens);
        if (delta > 0) {
          ctrl.state = { ...ctrl.state, metrics: { ...cm, turnChildTokens: cm.turnChildTokens + delta, sessionChildTokens: cm.sessionChildTokens + delta, sessionTotalTokens: cm.sessionTotalTokens + delta } };
        }
      }
      break;
    case 'done':
    case 'error': {
      // 完成态即时落面板（并行批早完成者显终标、不再转圈）：归档锚点在主链 tool-result。
      // 终稿去重（2026-09-28 真机大段重复病根）：后台两段式/无流式场景终稿照常入档；与流式正文逐字重复则跳过
      const isError = e.type === 'error';
      const finalLine = e.text && e.text.length > 0 ? e.text : isError ? 'failed' : 'done';
      closeThink();
      // 尾部半行收口：done 即整段收束，未成行半行作为完整行入档（正文终稿不依赖 conclusion 兜底重复补齐）
      flushBuf();
      const streamText = transcript.filter((l) => l.kind === 'text').map((l) => l.text).join('\n');
      const isRealFinal = finalLine !== 'done' && finalLine !== 'failed';
      if (isRealFinal && !streamText.includes(finalLine)) {
        transcript = [...transcript, { kind: 'text', text: finalLine }];
      }
      commitChild(ctrl, list, idx, { ...child, transcript, steps, tokens, done: true, doneAt: Date.now(), conclusion: isRealFinal ? finalLine : undefined, bufText: undefined, bufThink: undefined, thinkStartedAt: undefined }, '');
      // 后台两段式延迟归档（结果先行语义）：done/error 即归档锚点，转录折回原 spawn 调用行
      archiveDeferred(ctrl, label);
      return;
    }
    default:
      return; // ctx/route/approval-* 不入面板态（done/error 已置终态；归档锚点在主链 tool-result）
  }
  commitChild(ctrl, list, idx, { ...child, transcript, steps, tokens, bufText: buf || undefined, bufThink, thinkStartedAt }, buf);
}

/** 面板态收尾单点：半行留存 + 尾流派生 + 节流通知（常规事件与 done/error 终态共用） */
function commitChild(ctrl: SessionController, list: ChildLiveState[], idx: number, next: ChildLiveState, buf: string): void {
  const label = next.label;
  if (buf) ctrl.childBufs.set(label, buf);
  else ctrl.childBufs.delete(label);
  ctrl.state = { ...ctrl.state, children: list.map((c, i) => (i === idx ? next : c)) };
  ctrl.notifyThrottled();
}

/** spawn 结果归档（规格 §4.4）：每条 spawn 结果经 pending.input 拿到**自己的**基名（权威关联——结果序≠
 *  完成序的并行批下栈序≠基名序），child 已完成即归档，未完成/未创建一律转 wait 延迟归档（done 的
 *  archiveDeferred 按基名收口）。旧形态两处病根（真机「5 个只显示 1 个」）：① FIFO 兜底 idx=0 把
 *  面板里**别人的**子代理归进本行——链条一错全错，错配行永远等不到自己的 meta（Ctrl+B 只剩 1）；
 *  ② child 在跑即中途归档——面板条目被抽走、半份转录冻结进 detail，终态永不回填 */
export function archiveChild(ctrl: SessionController): void {
  const pending = ctrl.spawnCalls.shift();
  if (pending === undefined) return;
  const list = ctrl.state.children;
  let idx = list.findIndex((c) => c.label === pending.base);
  if (idx < 0) idx = list.findIndex((c) => c.label.startsWith(`${pending.base}#`));
  if (idx >= 0 && list[idx]!.done) {
    archiveInto(ctrl, pending, list[idx]!);
    return;
  }
  ctrl.spawnCalls.unshift({ ...pending, wait: true });
}

/** 延迟归档收口（后台两段式）：按基名在栈中找本基名条目（不看 wait 标记——并行批下栈中靠后条目
 *  未及经 archiveChild 转位即带不上标记，按标记过滤就是真机「5 个只显示 1 个」的第二病根），折回其调用行 */
function archiveDeferred(ctrl: SessionController, label: string): void {
  const idx = ctrl.spawnCalls.findIndex((p) => p.base === label || label.startsWith(`${p.base}#`));
  if (idx < 0) return;
  const [pending] = ctrl.spawnCalls.splice(idx, 1);
  const child = ctrl.state.children.find((c) => c.label === label);
  if (pending !== undefined && child !== undefined) archiveInto(ctrl, pending, child);
}

/** 归档落点单点：结论精简 detail（委派提示词 + 结论 + 统计行，2026-09-28 用户裁决：已完成 spawn 只展输入/输出/统计）
 *  + subagentMeta；归档即从面板离场（历史区 SPAWN 行 detail 为唯一回看面，Ctrl+B 直接浏览全部已完成） */
function archiveInto(ctrl: SessionController, pending: { seq: number; base: string; delegatedAt: number }, child: ChildLiveState): void {
  ctrl.childBufs.delete(child.label);
  // 委派词按「消歧 label → 基名」取（同名并发 #N 前缀匹配归档时登记键为基名）；取后一并清登记
  const prompt = ctrl.childPrompts.get(child.label) ?? ctrl.childPrompts.get(pending.base);
  ctrl.childPrompts.delete(child.label);
  ctrl.childPrompts.delete(pending.base);
  const durS = Math.max(0, Math.round((Date.now() - child.startedAt) / 1000));
  // 结论不双份：done 时终稿未与流式正文重复会追加进 transcript 末尾，conclusion 段仅在转录未含时补
  //（与 done 事件去重同口径——流式正文 includes 终稿即跳过）
  const transcriptText = child.transcript.filter((l) => l.kind === 'text').map((l) => l.text).join('\n');
  const detail = [
    ...(prompt ? [`⏺ ${t('delegated prompt', '委派提示词')}：${serializeMultiline(prompt)}`] : []),
    // 完整时间线随 detail 折入（2026-09-28 用户裁决：归档子代理与运行中/主 agent 同构，Tab 展开时间线）——
    // 结构行序列化与 ChildInspector archived 分流互为镜像：result 行 ⎿ ✓/✗（多行输出续行缩进折入）、
    // call 行原样（首词动词分流还原）、text 行原样、thinking 行 ✻ 摘要 + 4 空格缩进 detail 续行
    // （与 MessageList ThinkingRow 呈现缩进同口径）；序列化前并行结果归位（pairChildResults 单点）：
    // 结果行落对应调用行下，归档回看不再结果堆叠
    ...pairChildResults(child.transcript).map((l) =>
      l.kind === 'result'
        ? `⎿ ${l.ok === false ? '✗' : '✓'} ${serializeMultiline(l.text)}`
        : l.kind === 'thinking'
          ? `✻ ${l.text}${l.detail !== undefined && l.detail.length > 0 ? '\n' + l.detail.split('\n').map((x) => `    ${x}`).join('\n') : ''}`
          : l.kind === 'task'
            ? `▶ ${serializeMultiline(l.text)}`
            : l.kind === 'message'
              ? `✉ ${l.text}`
              : l.text,
    ),
    ...(child.conclusion && !transcriptText.includes(child.conclusion) ? [child.conclusion] : []),
    `${formatDuration(durS)} · ${Math.max(1, child.steps)} steps · ↑${formatTokens(child.tokens)} tokens`,
  ].join('\n');
  const subagentMeta = { steps: Math.max(1, child.steps), durationMs: Math.max(0, Date.now() - child.startedAt), tokens: child.tokens, delegatedAt: pending.delegatedAt, prompt };
  // 富化回写（2026-09-30）：调用行已在档（'msg' 事件先行），归档富化以 'msg-update' 终态覆盖回写——
  // 不回写则 resume/rewind 回放退回裸调用行（无 detail/subagentMeta），Ctrl+B 历史归档全消失（真机「6 个只显示 1 个」病根）；
  // 覆盖写经 updateMessage 单点（journal 回写 + 通知与追加写点同一纪律）
  ctrl.state = { ...ctrl.state, children: ctrl.state.children.filter((c) => c.label !== child.label) };
  const target = ctrl.state.messages.find((m) => m.seq === pending.seq);
  if (target !== undefined) ctrl.updateMessage({ ...target, detail, subagentMeta });
  else ctrl.notify();
}
