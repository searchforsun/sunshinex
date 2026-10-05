import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('spawn 归档写入 subagentMeta（steps + durationMs）', () => {
  const tmp = tmpdir('sunshinex-sess-spawnmeta-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: '审查', label: 'rv' } } } as never);
    ctrl.onEventForTest({ type: 'token', text: '审查中\n', payload: { subagent: 'rv' } } as never);
    ctrl.onEventForTest({ type: 'step', text: '', payload: { subagent: 'rv' } } as never);
    ctrl.onEventForTest({ type: 'usage', text: '', payload: { subagent: 'rv', turnTotal: 4200 } } as never);
    ctrl.onEventForTest({ type: 'done', text: '审查结论', payload: { subagent: 'rv' } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'rv 完成', payload: { tool: 'spawn', ok: true } } as never);
    const call = ctrl.getState().messages.find((m) => m.kind === 'call' && m.text.startsWith('SPAWN'));
    assert.ok(call, 'spawn 调用行在链');
    assert.ok(call!.detail?.includes('审查结论'), '转录已折入 detail');
    assert.ok(call!.subagentMeta, '归档应写入 subagentMeta');
    assert.ok(call!.subagentMeta!.steps >= 1, 'steps 取自 ChildLiveState.steps');
    assert.ok(call!.subagentMeta!.durationMs >= 0, 'durationMs = 归档时刻 - startedAt');
    assert.equal(call!.subagentMeta!.prompt, '审查', '委派词入 meta（全屏回看头部数据源，不再参与正文取尾）');
    assert.equal(ctrl.getState().children.length, 0, '归档后面板移除');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('INVALID_ARG 即败零子事件：spawn 调用行无 subagentMeta（折叠态省尾注）', () => {
  const tmp = tmpdir('sunshinex-sess-spawnmeta2-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: {} } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'INVALID_ARG', payload: { tool: 'spawn', ok: false } } as never);
    const call = ctrl.getState().messages.find((m) => m.kind === 'call' && m.text.startsWith('SPAWN'));
    assert.ok(call);
    assert.equal(call!.subagentMeta, undefined, '零子事件无归档命中，meta 保持缺省');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('归档富化回写日志：resume 回放 SPAWN 行带 detail/subagentMeta（2026-09-30 真机「历史归档只显示 1 个」病根）', async () => {
  const tmp = tmpdir('sunshinex-sess-spawnjournal-');
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = path.join(tmp, '.data-pin');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.SUNSHINEX_DATA_DIR = dataDir;
  try {
    // 会话一：两个子代理归档（各自 SPAWN 行经 'msg' 入档 + 'msg-update' 富化回写）
    const ctrl1 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl1.submit('跑两个');
    await ctrl1.waitIdle();
    for (const label of ['a', 'b']) {
      ctrl1.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: `p-${label}`, label } } } as never);
      ctrl1.onEventForTest({ type: 'token', text: `${label} 线\n`, payload: { subagent: label } } as never);
      ctrl1.onEventForTest({ type: 'done', text: `${label} 结论`, payload: { subagent: label } } as never);
      ctrl1.onEventForTest({ type: 'tool-result', text: `${label} 完成`, payload: { tool: 'spawn', ok: true } } as never);
    }
    assert.equal(ctrl1.getState().messages.filter((m) => m.kind === 'call' && m.text.startsWith('SPAWN ') && m.subagentMeta).length, 2, '前置：两行归档带 meta');

    // 会话二（重启语义）：resumePicker 选中该档 → 回放后归档行须带 detail/subagentMeta（Ctrl+B 历史归档数据源）
    const ctrl2 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"忽略"}']), resumePicker: true });
    const deadline = Date.now() + 5000;
    while (ctrl2.getState().status !== 'awaiting-question' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    ctrl2.resolveAskAnswer({ type: 'selected', labels: [ctrl2.getState().question!.options[0]!.label] });
    // 选中后二级动作卡（rewind/fork 规格 §7.2 入口 B）：restore 默认首项走现行恢复
    const modeDeadline = Date.now() + 5000;
    while (!(ctrl2.getState().question?.question.includes('fork from it?') ?? false) && Date.now() < modeDeadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    ctrl2.resolveAskAnswer({ type: 'selected', labels: ['restore'] });
    // 等恢复回执（不等 status：resolve 后状态先回 idle、restoreFromSession 仍在异步链上，等 idle 会抢跑断言）
    const deadline2 = Date.now() + 5000;
    while (!ctrl2.getState().messages.some((m) => m.text.includes('Session restored') || m.text.includes('已恢复会话')) && Date.now() < deadline2) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const archived = ctrl2.getState().messages.filter((m) => m.kind === 'call' && m.text.startsWith('SPAWN ') && m.subagentMeta);
    assert.equal(archived.length, 2, 'resume 回放后两行归档带 meta（历史归档不再消失）');
    assert.ok(archived.every((m) => m.detail !== undefined), 'detail 同步回放（Ctrl+O/全屏回看数据源）');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR; else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('并行批 5 spawn 乱序完成：每行归自己的 meta/detail，不再 FIFO 错配丢行（真机「5 个只显示 1 个」病根）', () => {
  const tmp = tmpdir('sunshinex-sess-par5-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const labels = ['b1', 'b2', 'b3', 'b4', 'b5'];
    const prompts: Record<string, string> = { b1: '单体AI链路', b2: '工作流编排', b3: '微服务架构', b4: '前端', b5: '数据与运维' };
    // 全部 spawn：tool-call（延迟入档挂起）→ tool-result（结果先行，child 未创建 → wait）
    for (const l of labels) {
      ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: prompts[l]!, label: l } } } as never);
      ctrl.onEventForTest({ type: 'tool-result', text: `task ${l} started`, payload: { tool: 'spawn', ok: true } } as never);
    }
    // 全部 child 启动（结果已在栈里 wait）
    for (const l of labels) ctrl.onEventForTest({ type: 'token', text: `${l} 工作中\n`, payload: { subagent: l } } as never);
    assert.equal(ctrl.getState().children.length, 5, '前置：5 个 child 都在面板');
    // 完成序全乱：b3, b1, b5, b2, b4
    for (const l of ['b3', 'b1', 'b5', 'b2', 'b4']) {
      ctrl.onEventForTest({ type: 'done', text: `${prompts[l]}结论`, payload: { subagent: l } } as never);
      ctrl.onEventForTest({ type: 'tool-result', text: `${l} 完成`, payload: { tool: 'spawn', ok: true } } as never);
    }
    const st = ctrl.getState();
    const spawns = st.messages.filter((m) => m.kind === 'call' && m.text.startsWith('SPAWN '));
    assert.equal(spawns.length, 5, '5 条 SPAWN 行都在');
    assert.equal(spawns.filter((m) => m.subagentMeta).length, 5, '5 行全部带 meta（不再 4 行裸奔消失）');
    // 每行归自己的委派词：b1 行含「单体AI链路」而非别人的
    for (const l of labels) {
      const row = spawns.find((m) => m.subagentMeta?.prompt === prompts[l]);
      assert.ok(row, `${l} 行归自己的委派词（${prompts[l]}）`);
      assert.ok(row!.detail?.includes(`${prompts[l]}结论`), `${l} 行 detail 含自己的结论`);
    }
    assert.equal(st.children.length, 0, '全部完成后面板清空（而非 4 个蒸发）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('child 在跑时 spawn result 到达：不中途归档（半份转录不冻结），done 后整段归档（后台两段式语义）', () => {
  const tmp = tmpdir('sunshinex-sess-midrun-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    ctrl.onEventForTest({ type: 'tool-call', text: 'spawn', payload: { input: { prompt: '调研', label: 'w' } } } as never);
    ctrl.onEventForTest({ type: 'tool-result', text: 'task w started', payload: { tool: 'spawn', ok: true } } as never);
    ctrl.onEventForTest({ type: 'token', text: '调研进行中\n', payload: { subagent: 'w' } } as never);
    // child 在跑、result 已到：不归档（面板保留、SPAWN 行无 meta）
    assert.equal(ctrl.getState().children.length, 1, 'child 在跑时留在面板');
    assert.equal(ctrl.getState().messages.filter((m) => m.kind === 'call' && m.subagentMeta).length, 0, '未完成不中途归档');
    // 后续事件继续累积、done 后整段归档
    ctrl.onEventForTest({ type: 'token', text: '更多调研内容\n', payload: { subagent: 'w' } } as never);
    ctrl.onEventForTest({ type: 'done', text: '调研结论', payload: { subagent: 'w' } } as never);
    const row = ctrl.getState().messages.find((m) => m.kind === 'call' && m.text.startsWith('SPAWN '));
    assert.ok(row!.subagentMeta, 'done 后归档带 meta');
    assert.ok(row!.detail?.includes('更多调研内容'), '终态完整转录入 detail（非半份冻结）');
    assert.equal(ctrl.getState().children.length, 0, '面板离场');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
