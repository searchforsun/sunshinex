/** plan 模式支撑模块（2026-11-03 无感化收敛,ask_question 同构）：计划模式=「read-only 覆盖+exit_plan
 *  挂起工具」,无宿主编排状态机——规划在会话作用域 run 内可见进行,exit_plan executor 弹卡阻塞等裁决,
 *  裁决作为工具结果回喂,模型同 run 无感继续（批准=宿主落档放权后原地实施;驳回带反馈=原地修订再出牌;
 *  空反馈驳回=宿主中断 run 放弃本轮）。本模块只留共用纯件:计划名派生/Steps 解析/提示 note;
 *  挂起协议（挂起表/帧/回执端点）与计划文件落盘归宿主（tui/serve）接缝。 */

/** 批准落档档位（2026-11-03 修订:批准卡三选,缺省 acceptEdits——full-access 必须显式选择） */
export type PlanLandMode = 'acceptEdits' | 'full-access';

export interface PlanDecision { approved: boolean; mode?: PlanLandMode; feedback?: string }

/** 计划模式提示 note（2026-11-03 无感化）：armed 会话提交时注入链（英文单语,§15 不进语言轴）——
 *  模型据此知悉只读约束与 exit_plan 交稿协议;批准后权限放开,todo_write 回归执行期自管 */
export const PLAN_MODE_NOTE =
  'Plan mode active: permissions are read-only until your plan is approved. Investigate the relevant code first, then submit the plan via the exit_plan tool (name = short title, doc = the full plan document in markdown with sections Background / Approach / Files / Steps (numbered "1. ...") / Risks / Verification). After approval you may implement; keep the todo list updated with todo_write as you work.';

/** 计划名兜底派生（模型 exit_plan 漏 name 时）：goal 压缩空白截 24 字符 */
export function derivePlanName(goal: string): string {
  const flat = goal.replace(/\s+/g, ' ').trim();
  return flat.length <= 24 ? (flat === '' ? 'Plan' : flat) : flat.slice(0, 24) + '…';
}

/** 计划书 Steps 解析（编号行 → 步骤清单）：只取编号行（全文含标题/散文,不应混入步骤清单）;
 *  批准播种 todos 与确认卡步骤清单共用 */
export function parseNumberedSteps(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+[.、]\s*/.test(l))
    .map((l) => l.replace(/^\d+[.、]\s*/, '').trim())
    .filter((l) => l.length > 0);
}
