import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { resolveDataDir } from '../config/data-dir';
import { getLanguage, setLanguage } from '../i18n';
import { ScriptedAdapter } from '../model/adapter';

/** 计划模式无感化测试（2026-11-03,ask_question 同构）：armed 提交=会话作用域 run（read-only 覆盖在座）
 *  ——模型调研后 exit_plan 弹卡阻塞等裁决（run 不收口,status 保持 running/awaiting-plan 视角）,
 *  裁决回填 → executor 恢复同 run 无感继续（批准=落档放权原地实施;重新计划带反馈=原地修订再出牌;
 *  空反馈放弃=中断 run 放弃本轮,arm 保持）。裁决回执链路:confirmPlan → planDecide → seam 恢复。 */

async function waitFor(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout: ' + what);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function chainOf(ctrl: SessionController): { action?: string; observation: string }[] {
  return ctrl.context.chainView() as unknown as { action?: string; observation: string }[];
}

function messageTexts(ctrl: SessionController): string {
  return ctrl.getState().messages.map((m) => m.text).join('\n');
}

test('/plan：armed 提交→exit_plan 挂起(status running→awaiting-plan)→批准→同 run 无感实施→待办播种', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan1-'));
  const prevLang = getLanguage();
  try {
    setLanguage('en');
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        { toolCalls: [{ name: 'exit_plan', args: { name: '重构认证模块', doc: '# 重构认证模块\n1. 步骤A\n2. 步骤B' } }] },
        '{"tool":"write","input":{"path":"plan-impl-a.txt","content":"A"},"done":false}',
        '{"done":true,"reply":"步骤A 完成"}',
        '{"tool":"write","input":{"path":"plan-impl-b.txt","content":"B"},"done":false}',
        '{"done":true,"reply":"步骤B 完成"}',
      ]),
    });
    await ctrl.submit('/plan 做一件事');
    assert.equal(ctrl.planArmed, true, '裸提交前武装由 /plan 分支置位');
    await ctrl.submit('做一件事');
    await waitFor(() => ctrl.getState().status === 'awaiting-plan', '交稿挂卡(status awaiting-plan)');
    assert.match(ctrl.getState().messages.at(-1)?.text ?? '', /步骤A/, '计划书随卡上屏');
    assert.ok(
      ctrl.getState().messages.some((m) => m.role === 'user' && m.text === '做一件事'),
      '用户输入应回显上屏',
    );
    // 计划文件落盘:born-write 铸档 → sessions/<jid>.plan.md(首行=计划名)
    const jid = ctrl.journal?.currentId;
    assert.ok(jid !== undefined, '挂起接缝 born-write 铸档');
    const planFile = path.join(resolveDataDir(tmp), 'sessions', `${jid}.plan.md`);
    assert.ok(fs.existsSync(planFile), '计划书已落盘');
    assert.match(fs.readFileSync(planFile, 'utf8'), /^# 重构认证模块/, '文件首行=计划名(无 H1 前置)');
    // 批准(工作区编辑):落档放权 → 同 run 无感继续实施
    await ctrl.confirmPlan(true, undefined, 'acceptEdits');
    await ctrl.waitIdle();
    assert.ok(ctrl.getState().todos.length >= 2, '批准时 todos 按计划书 Steps 播种');
    const chain = chainOf(ctrl);
    assert.ok(chain.some((s) => s.action === 'tool-call' && s.observation.includes('exit_plan')), '交稿工具调用行在主链(会话作用域 run)');
    assert.ok(chain.some((s) => s.action === 'tool-result' && s.observation.includes('plan approved')), '裁决结果回喂行在场');
    assert.ok(chain.some((s) => s.action === 'task'), '实施轨迹同链(会话作用域)');
    assert.equal(ctrl.planArmed, false, '批准落档 arm 解除');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  void prevLang;
});

test('/plan：重新计划带反馈→executor 恢复原地修订→再次出牌→批准实施(修订环自然迭代,无轮次上限)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan2-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        { toolCalls: [{ name: 'exit_plan', args: { name: '计划一', doc: '# 计划一\n1. 步骤A' } }] },
        { toolCalls: [{ name: 'exit_plan', args: { name: '计划二', doc: '# 计划二\n1. 步骤B' } }] },
        '{"done":true,"reply":"步骤B 完成"}',
      ]),
    });
    await ctrl.submit('/plan 做一件事');
    await waitFor(() => ctrl.getState().status === 'awaiting-plan', '首卡');
    assert.match(ctrl.getState().messages.at(-1)?.text ?? '', /步骤A/, '首卡计划一');
    await ctrl.confirmPlan(false, '改成步骤B');
    await waitFor(() => ctrl.getState().status === 'awaiting-plan', '修订后新卡');
    assert.match(ctrl.getState().messages.at(-1)?.text ?? '', /步骤B/, '修订卡携带新计划');
    await ctrl.confirmPlan(true, undefined, 'acceptEdits');
    await ctrl.waitIdle();
    const chain = chainOf(ctrl);
    const exitCalls = chain.filter((st) => st.action === 'tool-call' && st.observation.includes('exit_plan')).length;
    assert.ok(exitCalls >= 2, '两次交稿调用(修订环自然迭代)');
    assert.ok(chain.some((st) => st.observation.includes('计划二')), '修订后计划书在链');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/plan：空反馈放弃=放弃本轮——run 中断回输入态,arm 保持(2026-11-03 用户裁定)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan3-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        { toolCalls: [{ name: 'exit_plan', args: { name: '计划X', doc: '# 计划X\n1. 步骤X' } }] },
      ]),
    });
    await ctrl.submit('/plan 做一件事');
    await waitFor(() => ctrl.getState().status === 'awaiting-plan', '确认卡');
    await ctrl.confirmPlan(false); // 空反馈=放弃
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().status, 'idle', '放弃本轮收尾回输入态');
    assert.match(messageTexts(ctrl), /Plan discarded|已放弃执行计划/, '放弃回执');
    assert.equal(ctrl.planArmed, true, '放弃仍保持 armed(下条提交重新规划)');
    assert.equal(ctrl.getState().todos.length, 0, '放弃不产生待办');
    assert.ok(!chainOf(ctrl).some((s) => s.observation.includes('只有一项') && s.action === 'task'), '放弃不执行步骤');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/plan：裸 /plan=幂等武装/off 解除;运行中 <目标> 入队收口转规划(2026-11-03 三态)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan4-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      mode: 'acceptEdits',
      model: new ScriptedAdapter([
        '{"tool":"exec","input":{"command":"echo hi"},"done":false}',
        '{"done":true,"reply":"ok"}',
        { toolCalls: [{ name: 'exit_plan', args: { name: 'Q计划', doc: '# Q计划\n1. 步骤Q' } }] },
        '{"done":true,"reply":"步骤Q 完成"}',
      ]),
    });
    await ctrl.submit('/plan');
    assert.equal(ctrl.planArmed, true, '裸 /plan 武装');
    await ctrl.submit('/plan');
    assert.ok(messageTexts(ctrl).includes('Already in plan mode'), '重复发送幂等');
    await ctrl.submit('/plan off');
    assert.equal(ctrl.planArmed, false, '/plan off 解除');
    // 普通任务运行中带目标:入 steer 队列,收口后 armed 拦截转规划
    const p = ctrl.submit('跑个命令');
    await waitFor(() => ctrl.getState().status === 'running' || ctrl.getState().status === 'awaiting-approval', '任务起跑');
    await ctrl.submit('/plan 规划这件事');
    assert.equal(ctrl.planArmed, true, '运行中武装生效');
    await ctrl.resolveApproval('allow');
    // p 不先 await:drainQueue 对 armed 队列行内联起规划 run,交稿挂卡阻塞在 run 内——先等卡,裁决后 p 才收口
    await waitFor(() => ctrl.getState().status === 'awaiting-plan', '队列目标转规划');
    assert.equal(ctrl.planArmed, true, '规划在途 armed 保持');
    await ctrl.confirmPlan(true, undefined, 'acceptEdits');
    await p;
    await ctrl.waitIdle();
    assert.equal(ctrl.planArmed, false, '批准落档 arm 解除');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/plan：批准落 acceptEdits——基档真切换(无感化:同 run 恢复,无换铸)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-plan-mode-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        { toolCalls: [{ name: 'exit_plan', args: { name: '步骤A计划', doc: '# 步骤A计划\n1. 步骤A' } }] },
        '{"done":true,"reply":"步骤A 完成"}',
      ]),
    });
    type GuardFace = { mode: string };
    const guard = (ctrl as unknown as { runtime: { harness: { security: GuardFace } } }).runtime.harness.security;
    assert.equal(guard.mode, 'full-access', '批准前基档=缺省 full-access');
    await ctrl.submit('/plan 做一件事');
    await waitFor(() => ctrl.getState().status === 'awaiting-plan', '确认卡');
    await ctrl.confirmPlan(true, undefined, 'acceptEdits');
    await ctrl.waitIdle();
    assert.match(messageTexts(ctrl), /Switched to workspace edit mode|已切换到工作区编辑档/, '批准落 acceptEdits 回执');
    assert.equal(guard.mode, 'acceptEdits', '批准后基档真切换');
    assert.equal(ctrl.planArmed, false, '批准 arm 解除');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
