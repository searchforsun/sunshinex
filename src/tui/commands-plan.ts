import { t } from '../i18n';
import type { RunOutcome, StopReason } from '../types';
import { runPlanFlow, PLAN_MAX_ROUNDS } from '../harness/plan-flow';
import { PLAN_TASK_LABEL } from './chat-model';
import { describeIncomplete } from './stop-reason';
import { pushInterruptedNotice, suspendAskerFor } from './approval';
import type { SessionController } from './session';

// D52 拆分件（D17 commands-* 族先例）：/plan 计划域壳——confirmPlan 裁决回填、startPlanFlow 规划流程壳、
// landAcceptEdits 批准落档、runPlanItems 逐项执行。挂起/裁决态字段仍在控制器（pendingPlan/planDecide/
// planFlowRunning/planFeedbackMode/taskAbort/taskStatsSuppressed/turnMissHinted，本族函数经 ctrl 单点协调），
// SessionController 保留 confirmPlan 同名公开薄委托（组件与测试调用面零变化）。
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

/** 计划卡裁决回填：摘卡清反馈态 → decide 回填 → 壳续段。流程不在途的悬卡拒绝=旧式放弃（防御路径） */
export async function confirmPlanOn(ctrl: SessionController, yes: boolean, feedback?: string): Promise<void> {
  const pending = ctrl.pendingPlan;
  if (!pending) return;
  ctrl.pendingPlan = undefined;
  ctrl.planFeedbackMode = undefined;
  const decide = ctrl.planDecide;
  ctrl.planDecide = undefined;
  decide?.({ approved: yes, feedback });
  if (!yes && !ctrl.planFlowRunning) {
    ctrl.state = { ...ctrl.state, status: 'idle', pauseConfirm: undefined }; // 同 closeTask 状态出口清卡（规划轮挂的卡可走到这）
    ctrl.pushMsg('system', t('Plan discarded, back to input', '已放弃执行计划，回到输入态'));
    return;
  }
  // 批准与在途拒绝：planFlow 消费壳自行续段（批准=漂移探测+落 acceptEdits+逐项执行;拒绝=修订重入/超限收尾）,
  // 这里不清状态——状态出清归壳与 aborted 事件臂
}

/** /plan 规划流程壳（spec §4.2-4.4 重造）：runPlanFlow 纯流程编排的宿主消费,IO 全走接缝。
 *  submit 半径只到用户裁决点：首轮规划在本函数返回的「门」promise 内跑到 awaiting-approval（或中断/终态）
 *  放行 await submit;裁决后续段（批准=漂移探测+落 acceptEdits+逐项执行;拒绝=修订重入/超限收尾）脱离
 *  submit 半径,由 confirmPlan 的 decide 回填驱动后台续跑——「提交后停在确认卡」的既有公开语义不变。 */
export function startPlanFlowOn(ctrl: SessionController, goal: string): Promise<void> {
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
  // 规划轮终稿不重复入档：计划正文仅以确认卡形态上屏一次（每轮规划同此）;批准执行段前复位,
  // 否则步骤正文会被归档抑制位吞掉
  ctrl.md.planReplyNoArchive = true;
  // 前轮计划书宿主侧留存（spec §4.3 rider：驳回环重入,revising 轮拼进规划提示词前部——plan-flow 模块不动,
  // 拼装在宿主接缝实现内）;revising 事件臂置位、awaiting-approval 臂复位
  let lastPlanDoc: string | undefined;
  let revising = false;
  void (async () => {
    try {
      const r = await runPlanFlow(goal, {
        // 中断信号沿 runInternalTask 既有的 taskAbort 透传,第三参对齐接缝签名（同源信号显式传递）
        runPlanningTask: (prompt, signal) => {
          // 驳回环重入：前轮计划书拼进提示词前部（英文单语,§15 提示词面不进语言轴）+ 模块自带的反馈段
          const full = revising && lastPlanDoc
            ? `Previous plan document (rejected — revise it per the feedback below):\n${lastPlanDoc}\n\n${prompt}`
            : prompt;
          return ctrl.runInternalTask(full, PLAN_TASK_LABEL, signal);
        },
        enterReadOnly: () => ctrl.runtime.harness.security.enterModeOverride('read-only'),
        exitReadOnly: () => ctrl.runtime.harness.security.exitModeOverride(),
        todosSnapshot: () => ctrl.getState().todos.map((td) => ({ text: td.text, status: td.status })),
        chainAppendPlan: (doc) => {
          // 计划书入链（spec §4.4,ChainAction 'plan',批准后一次）。'plan' 行**不进** lastTaskIdx 推理轮半径
          // （messages.ts lastTaskIdx 只锚 'task'）——裁定：计划书入链后,执行段第一步的 runTask 经 seedHistory
          // 语义天然读到计划书（同链）,推理轮半径无需纳入 'plan' 行。
          ctrl.runtime.harness.context.appendChain([{ action: 'plan', observation: doc }]);
        },
        emit: (e) => {
          if (e.type === 'planning') return; // 状态置 running 已在入口沿现实现完成
          if (e.type === 'awaiting-approval') {
            lastPlanDoc = e.doc; // 前轮计划书留存（revising 轮拼提示词用）
            revising = false;
            ctrl.pendingPlan = { doc: e.doc, items: e.items };
            const card = [
              t('Plan confirmation (/plan)', '计划确认卡（/plan）'),
              e.doc,
              '---',
              ...e.items.map((item, i) => `${i + 1}. ${item}`),
              t(`${e.items.length} items; y approve / n reject with feedback / Esc discard`, `${e.items.length} 项；y 批准 / n 拒绝（附反馈）/ Esc 放弃`),
            ].join('\n');
            ctrl.pushMsg('system', card);
            ctrl.state = { ...ctrl.state, status: 'awaiting-plan' };
            ctrl.notify();
            openGateOnce(); // submit 半径到此为止：裁决后续段由 confirmPlan 驱动
            return;
          }
          if (e.type === 'revising') {
            revising = true;
            ctrl.pushMsg('system', t(`Revising plan with your feedback (round ${e.round}/${PLAN_MAX_ROUNDS})`, `按反馈修订计划中（第 ${e.round}/${PLAN_MAX_ROUNDS} 轮）`));
            ctrl.state = { ...ctrl.state, status: 'running' }; // 状态卫生：修订轮规划在途,旧确认卡随裁决已出清
            ctrl.notify();
            return;
          }
          if (e.type === 'aborted') {
            // failed 臂如实措辞（终审修复:spec §7 规划失败不再谎报 interrupted）——沿 describeIncomplete
            // 文案形态拼「规划失败: <未完成原因>」;describeIncomplete 对 model-error 回空串,回落原始值
            const why = e.reason === 'interrupted'
              ? t('Planning interrupted', '规划已中断')
              : e.reason === 'exhausted'
                ? t('Plan rejected 3 times — stopped, nothing executed', '计划已被拒 3 轮——已停止，未执行任何步骤')
                : e.reason === 'empty'
                  ? t('Planning produced no steps — cancelled', '规划未产出步骤——已取消')
                  : failedPlanningText(e.stopReason);
            ctrl.pushMsg('system', why, { level: 'warn' });
            // 失败路径不产出收尾统计行（规格 §3.2 边界,沿旧 empty/interrupted 路径语义）
            ctrl.taskStatsSuppressed = true;
            ctrl.closeTask();
            openGateOnce(); // 无裁决点路径（中断/超限/无产物）也放行 submit 半径
            return;
          }
          // approved：产物经返回值 r 承载,续段在下方 r 分支
        },
        awaitApproval: () => new Promise((resolve) => { ctrl.planDecide = resolve; }),
        signal: ctrl.taskAbort?.signal,
      });
      ctrl.md.planReplyNoArchive = false; // 规划段出口即复位：执行段/后续任务正文不再被抑制
      if (r) {
        // 批准续段（单点,自旧 confirmPlan 前移）：确认项过期/冲突探测 → 落 acceptEdits 回执 → 逐项执行。
        // 链序保证（红线①）：planFlow 已先 chainAppendPlan 再返回——计划书行严格先于本段的执行指令行入链
        const notices = ctrl.runtime.harness.context.checkConstantsDrift();
        for (const n of notices) ctrl.runtime.harness.context.appendChain([{ action: 'notice', observation: n }]);
        if (notices.length > 0) {
          ctrl.pushMsg('system', t(
            `Session constants changed since the plan was drafted; the latest version applies:\n${notices.join('\n')}`,
            `计划起草后会话常量已变化，执行以最新为准：\n${notices.join('\n')}`,
          ), { level: 'warn' });
        }
        landAcceptEditsOn(ctrl);
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
    }
  })();
  return gate;
}

/** 批准后落 acceptEdits（spec §4.4 绑定性权威:真切换,Task8 审查推翻「只回执不实切」旧裁定）：
 *  guard 基档经 setBaseMode 通道实切（运行中模式切换 409 纪律由宿主保证——批准点在任务轮收口前,无并发源）;
 *  会话档本就 acceptEdits 时无操作,否则切换+如实回执。
 *  asker 接线随实切补位（终审修复）：非 acceptEdits 启动的会话构造器不挂 asker——实切后 ask 分支
 *  宁停硬拒（resolveAsk null）,批准续段的写步骤必停。setAsker(suspendAskerFor(ctrl)) 幂等无害
 *  （acceptEdits 会话构造器已挂同款闭包,本路径不重入;挂起裁决面沿既有 approval.ts 管线） */
function landAcceptEditsOn(ctrl: SessionController): void {
  if (ctrl.runtime.harness.security.mode === 'acceptEdits') return;
  ctrl.runtime.harness.security.setBaseMode('acceptEdits');
  ctrl.runtime.harness.security.setAsker(suspendAskerFor(ctrl));
  ctrl.pushMsg('system', t('Switched to workspace edit mode', '已切换到工作区编辑档'));
}

/** 逐项执行计划：每项一个 run，完成即勾选待办（宁停不误：单项失败即暂停，剩余保持未完成） */
async function runPlanItemsOn(ctrl: SessionController, items: string[]): Promise<void> {
  ctrl.taskAbort = new AbortController(); // plan 执行段整段一个中断源（Esc/Ctrl+C 中止当前步及后续步）
  ctrl.state = { ...ctrl.state, status: 'running' };
  ctrl.setTodos(items.map((t) => ({ text: t, status: 'pending' as const })));
  ctrl.notify();
  const ctx = ctrl.runtime.harness.context;
  // 计划纪律走链（只增不改）：每轮只完成最后一条当前指令，不执行/预判/重排后续任务
  ctx.appendChain([{ action: 'note', observation: 'Plan discipline: each round completes only the last "Current instruction"; do not execute, anticipate, or reorder other tasks.' }]);
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
  ctrl.closeTask();
}
