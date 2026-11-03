import { t } from '../i18n';
import type { RunOutcome, StopReason } from '../types';
import { runPlanFlow, PLAN_MAX_ROUNDS } from '../harness/plan-flow';
import type { PlanLandMode, PlanDecision } from '../harness/plan-flow';
import { formatToolCallLine } from '../harness/context/messages';
import { PLAN_TASK_LABEL } from './chat-model';
import { describeIncomplete } from './stop-reason';
import { writePlanDoc } from './session-journal';
import { resolveDataDir } from '../config/data-dir';
import { pushInterruptedNotice, suspendAskerFor, interrupt } from './approval';
import type { SessionController } from './session';

// D52 拆分件（D17 commands-* 族先例）：/plan 计划域壳——confirmPlan 裁决回填、startPlanFlow 规划流程壳、
// landModeOn 批准选档落档、runPlanItems 逐项执行、replanOn/settlePlanAbortOn 三态替换与收口（2026-11-03）。
// 挂起/裁决态字段仍在控制器（pendingPlan/planDecide/planFlowRunning/planArmed/planExecuting/
// planFlowSettled/planReplanQuiet/planFeedbackMode/taskAbort/taskStatsSuppressed/turnMissHinted,
// 本族函数经 ctrl 单点协调）,SessionController 保留 confirmPlan 同名公开薄委托（组件与测试调用面零变化）。
//
// ⚠ 验收红线（两注记为语义锚，改动前必读）：
// ①链序——计划书行必须严格先于执行指令行入链（planFlow 已先 chainAppendPlan 再返回，批准续段不得前置）；
// ②裁决回填竞序——confirmPlan 侧只回填不续段，批准后的续段由 startPlanFlow 壳单点续跑（confirmPlan 侧
// 续段会与 planFlow 的 chainAppendPlan 微任务竞序）。
// 锚点：plan-flow.e2e.test + session.board.test + App.input.test 零改动全绿。

/** 规划失败的如实措辞（终审修复：spec §7 规划失败不再谎报 interrupted——沿 describeIncomplete 文案形态；
 *  语义单点在 chat-model，本件只拼「规划失败：」前缀） */
function failedPlanningText(stopReason: string | undefined): string {
  const note = describeIncomplete(stopReason as StopReason | undefined);
  return note.length > 0
    ? t(`Planning failed: ${note}`, `规划失败：${note}`)
    : t(`Planning failed (${stopReason ?? 'unknown'})`, `规划失败（${stopReason ?? '未知'}）`);
}

/** 计划卡裁决回填：摘卡清反馈态 → decide 回填 → 壳续段。流程不在途的悬卡拒绝=旧式放弃（防御路径）。
 *  mode=批准落档档位（2026-11-03 批准卡三选;缺省不携字段=plan-flow acceptEdits 兜底,full-access 显式传） */
export async function confirmPlanOn(ctrl: SessionController, yes: boolean, feedback?: string, mode?: PlanLandMode): Promise<void> {
  const pending = ctrl.pendingPlan;
  if (!pending) return;
  ctrl.pendingPlan = undefined;
  ctrl.planFeedbackMode = undefined;
  const decide = ctrl.planDecide;
  ctrl.planDecide = undefined;
  decide?.({
    approved: yes,
    ...(mode !== undefined ? { mode } : {}),
    ...(feedback !== undefined ? { feedback } : {}),
  });
  if (!yes && !ctrl.planFlowRunning) {
    ctrl.state = { ...ctrl.state, status: 'idle', pauseConfirm: undefined }; // 同 closeTask 状态出口清卡（规划轮挂的卡可走到这）
    ctrl.pushMsg('system', t('Plan discarded, back to input', '已放弃执行计划，回到输入态'));
    return;
  }
  // 批准与在途拒绝：planFlow 消费壳自行续段（批准=漂移探测+落所选档+逐项执行;拒绝=修订重入/超限/放弃收尾）,
  // 这里不清状态——状态出清归壳与 aborted 事件臂
}

/** /plan 规划流程壳（spec §4.2-4.4 重造;2026-11-03 三态扩员）：runPlanFlow 纯流程编排的宿主消费,IO 全走接缝。
 *  submit 半径只到用户裁决点：首轮规划在本函数返回的「门」promise 内跑到 awaiting-approval（或中断/终态）
 *  放行 await submit;裁决后续段（批准=漂移探测+落所选档+逐项执行;拒绝=修订重入/超限/放弃收尾）脱离
 *  submit 半径,由 confirmPlan 的 decide 回填驱动后台续跑——「提交后停在确认卡」的既有公开语义不变。
 *  planFlowSettled（2026-11-03）：整体收束 promise 挂 ctrl,replanOn/plan off 前置有界等待锚。
 *  images=随行图片仅首轮规划透传（修订轮提示词已含旧计划书全文,图片随首轮 seed 已在链;serve 同构） */
export function startPlanFlowOn(ctrl: SessionController, goal: string, images?: string[]): Promise<void> {
  ctrl.state = {
    ...ctrl.state,
    status: 'running',
  };
  ctrl.beginTaskStats();
  ctrl.turnMissHinted = false; // 新任务轮：轮首 miss 判定重置（观测小件）
  ctrl.taskAbort = new AbortController();
  ctrl.notify();
  ctrl.planFlowRunning = true;
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  let gated = false;
  const openGateOnce = (): void => { if (!gated) { gated = true; openGate(); } };
  let openFlow!: () => void;
  const flowSettled = new Promise<void>((resolve) => { openFlow = resolve; });
  ctrl.planFlowSettled = flowSettled; // replanOn/plan off 前置等待锚（防旧壳 finally 清新流程态）
  // 规划轮终稿不重复入档：计划正文仅以确认卡形态上屏一次（每轮规划同此）;批准执行段前复位,
  // 否则步骤正文会被归档抑制位吞掉
  ctrl.md.planReplyNoArchive = true;
  // 前轮计划书宿主侧留存（spec §4.3 rider：驳回环重入,revising 轮拼进规划提示词前部——plan-flow 模块不动,
  // 拼装在宿主接缝实现内）;revising 事件臂置位、awaiting-approval 臂复位。
  // 交稿面闭包（2026-11-03）：planName/planPath=awaiting-approval 臂更新（合成链行与卡/挂起行数据源）,
  // lastRound=revising/planning 臂更新（驳回行 round 文案）;flowSignal=入口捕获的中断信号（interrupt 会清
  // ctrl.taskAbort,合成行的 interrupted 判别靠这份引用）
  let lastPlanDoc: string | undefined;
  let revising = false;
  let planName: string | undefined;
  let planPath: string | undefined;
  let lastRound = 1;
  const flowSignal = ctrl.taskAbort?.signal;
  /** 合成 exit_plan 链行（回放权威;live 面 fork onEvent 事件帧已实时显示,合成行只补回放）：
   *  [tool-call('exit_plan',{name,path}) , tool-result('decision: …')]——不带 doc（回放轻,全文走 'plan' 行）。
   *  有交稿事实（awaiting-approval 到过）才合成;appendChain 主链尾追,fork 零回写红线不受影响 */
  const appendExitPlanRows = (decision: string): void => {
    if (planName === undefined) return;
    ctrl.runtime.harness.context.appendChain([
      { action: 'tool-call', observation: formatToolCallLine('exit_plan', JSON.stringify({ name: planName, ...(planPath !== undefined ? { path: planPath } : {}) })) },
      { action: 'tool-result', observation: decision },
    ]);
  };
  const decisionTextOf = (d: PlanDecision, interrupted: boolean): string => {
    if (interrupted) return 'decision: interrupted — no plan decision';
    if (d.approved) return `decision: implement via ${d.mode === 'full-access' ? 'full access' : 'workspace edits'}`;
    if (d.feedback !== undefined && d.feedback.trim() !== '') return `decision: rejected with feedback — revision round ${Math.min(lastRound + 1, PLAN_MAX_ROUNDS)}/${PLAN_MAX_ROUNDS}`;
    return 'decision: discarded by user (no feedback)';
  };
  void (async () => {
    try {
      const r = await runPlanFlow(goal, {
        // 中断信号沿 runInternalTask 既有的 taskAbort 透传,第三参对齐接缝签名（同源信号显式传递）。
        // 交稿转译（2026-11-03）：plan-presented → 读 harness 暂存槽,doc 进 reply 通道（plan-flow 既有
        // 「reply=计划书」判定即权威,状态机零改动）;name 一并带出（卡/落盘/合成行展示）
        runPlanningTask: async (prompt, signal) => {
          // 驳回环重入：前轮计划书拼进提示词前部（英文单语,§15 提示词面不进语言轴）+ 模块自带的反馈段
          const full = revising && lastPlanDoc
            ? `Previous plan document (rejected — revise it per the feedback below):\n${lastPlanDoc}\n\n${prompt}`
            : prompt;
          const out: RunOutcome = await ctrl.runInternalTask(full, PLAN_TASK_LABEL, signal, revising ? undefined : images);
          if (out.stopReason === 'plan-presented') {
            const presented = ctrl.runtime.harness.takePresentedPlan();
            return { done: true, reply: presented?.doc ?? '', ...(presented !== undefined ? { name: presented.name } : {}) };
          }
          return { done: out.done, ...(out.stopReason !== undefined ? { stopReason: out.stopReason } : {}), ...(out.reply !== undefined ? { reply: out.reply } : {}) };
        },
        enterReadOnly: () => {
          ctrl.runtime.harness.security.enterModeOverride('read-only');
          ctrl.runtime.harness.security.setExitPlanArmed(true); // 交稿协议：exit_plan 仅规划轮放行
        },
        exitReadOnly: () => {
          ctrl.runtime.harness.security.exitModeOverride();
          ctrl.runtime.harness.security.setExitPlanArmed(false);
        },
        // 计划书落盘（2026-11-03）：born-write 铸档后写 <dataDir>/sessions/<journalId>.plan.md（每轮覆盖写）
        persistPlan: (_name, doc) => {
          ctrl.ensureJournal();
          const jid = ctrl.journal?.currentId;
          if (jid === undefined) return {};
          return { path: writePlanDoc(resolveDataDir(ctrl.root), jid, _name, doc) };
        },
        todosSnapshot: () => ctrl.getState().todos.map((td) => ({ text: td.text, status: td.status })),
        chainAppendPlan: (doc) => {
          // 计划书入链（spec §4.4,ChainAction 'plan',批准后一次）。'plan' 行**不进** lastTaskIdx 推理轮半径
          // （messages.ts lastTaskIdx 只锚 'task'）——裁定：计划书入链后,执行段第一步的 runTask 经 seedHistory
          // 语义天然读到计划书（同链）,推理轮半径无需纳入 'plan' 行。
          ctrl.runtime.harness.context.appendChain([{ action: 'plan', observation: doc }]);
        },
        emit: (e) => {
          if (e.type === 'planning') {
            lastRound = e.round;
            return; // 状态置 running 已在入口沿现实现完成
          }
          if (e.type === 'awaiting-approval') {
            lastPlanDoc = e.doc; // 前轮计划书留存（revising 轮拼提示词用）
            planName = e.name; // 交稿面闭包更新（合成链行/挂起行数据源）
            planPath = e.path;
            revising = false;
            ctrl.pendingPlan = { name: e.name, path: e.path, doc: e.doc, items: e.items };
            const card = [
              t('Plan confirmation (/plan)', '计划确认卡（/plan）'),
              t(`Plan: ${e.name}`, `计划：${e.name}`),
              e.doc,
              '---',
              ...e.items.map((item, i) => `${i + 1}. ${item}`),
              t(`${e.items.length} items; y implement (workspace edits) / f implement (full access) / n re-plan with feedback / Esc discard`, `${e.items.length} 项；y 实施（工作区编辑）/ f 实施（完全访问）/ n 重新计划（附反馈）/ Esc 放弃`),
            ].join('\n');
            ctrl.pushMsg('system', card);
            ctrl.state = { ...ctrl.state, status: 'awaiting-plan' };
            ctrl.notify();
            openGateOnce(); // submit 半径到此为止：裁决后续段由 confirmPlan 驱动
            return;
          }
          if (e.type === 'revising') {
            revising = true;
            lastRound = e.round;
            ctrl.pushMsg('system', t(`Revising plan with your feedback (round ${e.round}/${PLAN_MAX_ROUNDS})`, `按反馈修订计划中（第 ${e.round}/${PLAN_MAX_ROUNDS} 轮）`));
            ctrl.state = { ...ctrl.state, status: 'running' }; // 状态卫生：修订轮规划在途,旧确认卡随裁决已出清
            ctrl.notify();
            return;
          }
          if (e.type === 'aborted') {
            // 合成链行补终态（2026-11-03）：有交稿事实才合成（empty/failed/首轮中断无 exit_plan 调用,零合成）;
            // exhausted 的末轮驳回行已由 awaitApproval 合成,此处零重复
            if (planName !== undefined) {
              appendExitPlanRows(
                e.reason === 'interrupted'
                  ? 'decision: interrupted — no plan decision'
                  : e.reason === 'exhausted'
                    ? `decision: rejected ${PLAN_MAX_ROUNDS} times (exhausted)`
                    : e.reason === 'discarded'
                      ? 'decision: discarded by user (no feedback)'
                      : `decision: planning failed (${e.stopReason ?? 'unknown'})`,
              );
            }
            // replan 静默位（2026-11-03）：替换路径的中断不落「规划已中断」——replanOn 自带回执文案
            const quiet = e.reason === 'interrupted' && ctrl.planReplanQuiet;
            // failed 臂如实措辞（终审修复:spec §7 规划失败不再谎报 interrupted）——沿 describeIncomplete
            // 文案形态拼「规划失败: <未完成原因>」;describeIncomplete 对 model-error 回空串,回落原始值;
            // discarded（2026-11-03）：空反馈驳回=放弃本轮,武装保持（下条提交重新规划）
            const why = e.reason === 'interrupted'
              ? t('Planning interrupted', '规划已中断')
              : e.reason === 'exhausted'
                ? t('Plan rejected 3 times — stopped, nothing executed', '计划已被拒 3 轮——已停止，未执行任何步骤')
                : e.reason === 'empty'
                  ? t('Planning produced no steps — cancelled', '规划未产出步骤——已取消')
                  : e.reason === 'discarded'
                    ? t('Plan discarded — still in plan mode; submit a new goal to re-plan', '已放弃本轮计划——仍处于计划模式，提交新目标将重新规划')
                    : failedPlanningText(e.stopReason);
            if (!quiet) ctrl.pushMsg('system', why, { level: 'warn' });
            // 失败路径不产出收尾统计行（规格 §3.2 边界,沿旧 empty/interrupted 路径语义）
            ctrl.taskStatsSuppressed = true;
            ctrl.closeTask();
            openGateOnce(); // 无裁决点路径（中断/超限/无产物）也放行 submit 半径
            return;
          }
          // approved：产物经返回值 r 承载,续段在下方 r 分支
        },
        // 裁决回填（合成链行时点）：决策先合成行（tool-call→tool-result 链序在 'plan' 行之前——红线①不破）,
        // 再把决策交还 plan-flow;interrupted 判别用入口捕获的 flowSignal（interrupt 会清 ctrl.taskAbort）
        awaitApproval: async () => {
          const d: PlanDecision = await new Promise((resolve) => { ctrl.planDecide = resolve; });
          appendExitPlanRows(decisionTextOf(d, flowSignal?.aborted === true));
          return d;
        },
        signal: ctrl.taskAbort?.signal,
      });
      ctrl.md.planReplyNoArchive = false; // 规划段出口即复位：执行段/后续任务正文不再被抑制
      if (r) {
        // 批准续段（单点,自旧 confirmPlan 前移）：确认项过期/冲突探测 → 落所选档回执 → 逐项执行。
        // 链序保证（红线①）：planFlow 已先 chainAppendPlan 再返回——计划书行严格先于本段的执行指令行入链
        const notices = ctrl.runtime.harness.context.checkConstantsDrift();
        for (const n of notices) ctrl.runtime.harness.context.appendChain([{ action: 'notice', observation: n }]);
        if (notices.length > 0) {
          ctrl.pushMsg('system', t(
            `Session constants changed since the plan was drafted; the latest version applies:\n${notices.join('\n')}`,
            `计划起草后会话常量已变化，执行以最新为准：\n${notices.join('\n')}`,
          ), { level: 'warn' });
        }
        landModeOn(ctrl, r.mode);
        await runPlanItemsOn(ctrl, r.items);
      }
      // aborted：三分支回执与 closeTask 已在 emit 臂如实落地,此处零事务（防双份文案）
    } catch (e) {
      ctrl.md.planReplyNoArchive = false;
      ctrl.pushMsg('system', t('Planning failed: ', '规划失败：') + (e instanceof Error ? e.message : String(e)), { level: 'error' });
      ctrl.closeTask();
    } finally {
      ctrl.planFlowRunning = false;
      ctrl.planDecide = undefined;
      ctrl.md.planReplyNoArchive = false;
      ctrl.planFeedbackMode = undefined;
      openGateOnce(); // 防御：任何出口都放行 submit 半径
      openFlow(); // 整体收束（planFlowSettled 锚落定）
    }
  })();
  return gate;
}

/** 批准后落所选档（2026-11-03 批准卡三选,原 landAcceptEditsOn 泛化;spec §4.4 绑定性权威:真切换）：
 *  guard 基档经 setBaseMode 通道实切;armed 随批准解除（档位切离 plan,armed 语义即不成立）;
 *  会话档本就所选档时无操作。asker 接线仅 acceptEdits 需要（full-access 档 ask 分支宁停硬拒,
 *  与 CLI --mode=full-access 构造缺省一致）。
 *  asker 接线补位（终审修复沿旧）：非 acceptEdits 启动的会话构造器不挂 asker——实切后 ask 分支
 *  宁停硬拒（resolveAsk null）,批准续段的写步骤必停。setAsker(suspendAskerFor(ctrl)) 幂等无害 */
function landModeOn(ctrl: SessionController, mode: PlanLandMode): void {
  ctrl.planArmed = false; // 批准=arm 解除（档位落所选,armed 语义随之不成立）
  if (ctrl.runtime.harness.security.mode === mode) return;
  ctrl.runtime.harness.security.setBaseMode(mode);
  if (mode === 'acceptEdits') ctrl.runtime.harness.security.setAsker(suspendAskerFor(ctrl));
  ctrl.pushMsg('system', mode === 'full-access' ? t('Switched to full access mode', '已切换到完全访问档') : t('Switched to workspace edit mode', '已切换到工作区编辑档'));
}

/** 中止在途 plan 流程并等收束（2026-11-03 三态共用核）：中断（信号+挂卡拒绝回填,approval.ts 语义）
 *  + 有界等 planFlowSettled（≤2s,serve abortPlanFlowAndSettle 同构——防旧壳 finally 清新流程态:
 *  planFlowRunning/taskAbort/planDecide 竞写）。流程不在途零事务幂等 */
export async function settlePlanAbortOn(ctrl: SessionController): Promise<void> {
  interrupt(ctrl);
  const settled = ctrl.planFlowSettled;
  if (settled === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bail = new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000); });
  await Promise.race([settled.catch(() => undefined), bail]);
  if (timer !== undefined) clearTimeout(timer);
}

/** 重新规划（2026-11-03 /plan 三态,serve replan 同构）：规划在途/挂卡期以新目标替换——中止旧流程
 *  （planReplanQuiet 抑制「规划已中断」双文案）+ 起新流程。回执文案在此单点（调用方不再重复） */
export async function replanOn(ctrl: SessionController, goal: string): Promise<void> {
  ctrl.planReplanQuiet = true;
  try {
    await settlePlanAbortOn(ctrl);
  } finally {
    ctrl.planReplanQuiet = false;
  }
  ctrl.pushMsg('system', t('Re-planning with the new goal', '已按新目标重新规划'));
  await startPlanFlowOn(ctrl, goal);
}

/** 逐项执行计划：每项一个 run，完成即勾选待办（宁停不误：单项失败即暂停，剩余保持未完成）。
 *  planExecuting 标记（2026-11-03 三态）：执行段在途——submit 三态分流据此把 armed+执行段视为普通
 *  运行态（steer 排队,不 replan 中断在途执行） */
async function runPlanItemsOn(ctrl: SessionController, items: string[]): Promise<void> {
  ctrl.taskAbort = new AbortController(); // plan 执行段整段一个中断源（Esc/Ctrl+C 中止当前步及后续步）
  ctrl.state = { ...ctrl.state, status: 'running' };
  ctrl.planExecuting = true;
  ctrl.setTodos(items.map((t) => ({ text: t, status: 'pending' as const })));
  ctrl.notify();
  const ctx = ctrl.runtime.harness.context;
  // 计划纪律走链（只增不改）：每轮只完成最后一条当前指令，不执行/预判/重排后续任务
  ctx.appendChain([{ action: 'note', observation: 'Plan discipline: each round completes only the last "Current instruction"; do not execute, anticipate, or reorder other tasks.' }]);
  try {
    for (let i = 0; i < items.length; i++) {
      // 中断检查在循环体首行（终审修复）：「上一步完成后信号才落地」的竞窗下,被跳过步骤的指令行
      // 不再入链、待办不再误标 in_progress（旧形态先 append/标 in_progress 再查,留孤儿链行）
      if (ctrl.taskAbort?.signal.aborted) break; // 上一步被中断：不进下一 plan 步
      ctrl.pushMsg('step', `Step ${i + 1}/${items.length} — ${items[i]}`);
      ctrl.notify(); // 轮窗起点/计数由内核 model-start 统计面承载(P9),此处只剩步骤行通知
      ctrl.setTodos(ctrl.state.todos.map((td) => (td.text === items[i] && td.status === 'pending' ? { ...td, status: 'in_progress' } : td)));
      ctx.appendInstructionLine(`Current instruction: ${items[i]}`);
      try {
        const r: RunOutcome = await ctrl.runtime.runTask(items[i], {
          ...(ctrl.state.tier ? { tier: ctrl.state.tier } : {}),
          ...(ctrl.state.effort ? { effort: ctrl.state.effort } : {}),
          ...(ctrl.taskAbort ? { signal: ctrl.taskAbort.signal } : {}),
        });
        if (r.stopReason === 'interrupted') { pushInterruptedNotice(ctrl); break; }
        if (!r.done) {
          ctrl.reportIncomplete(r, 'warn');
          ctrl.pushMsg('system', t(`Step incomplete: ${items[i]}; remaining steps paused`, `步骤未完成：${items[i]}；剩余步骤暂停`), { level: 'warn' });
          break;
        }
        ctrl.setTodos(ctrl.state.todos.map((td) => (td.text === items[i] ? { ...td, status: 'completed' } : td)));
        // 步骤全量轨迹与结论行已由 reactor 会话作用域自动入链（fork 模型：不再只留结论行）
        // 步骤正文已随流式管线入档（markdansi 行级 ansi 条目 + finish 收口），此处不再重复上屏（Step 切换时上一阶段正文重复的根因）
      } catch (e) {
        ctrl.pushMsg('system', t('Step failed: ' + items[i] + ' (' + (e instanceof Error ? e.message : String(e)) + '); remaining steps paused', '步骤失败：' + items[i] + '（' + (e instanceof Error ? e.message : String(e)) + '）；剩余步骤暂停'), { level: 'error' });
        break;
      }
    }
  } finally {
    ctrl.planExecuting = false; // 执行段收口（三态分流标记复位;finally 防异常路径泄漏 armed 分流误判）
  }
  ctrl.closeTask();
}
