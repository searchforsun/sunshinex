import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { ModelSwitcher } from '../model/catalog';
import { SessionJournal, listSessions, newSessionId, parseJournalFile, reduceJournal, sessionsDir } from './session-journal';

const tmpRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-persist-'));

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 持久化测试钉数据目录：控制器构造期即经 resolveDataDir 解析写点，必须在构造前设置；finally 恢复防互染 */
function pinDataDir(root: string): string {
  const dataDir = path.join(root, '.data-pin');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.SUNSHINEX_DATA_DIR = dataDir;
  return dataDir;
}

test('重放一致性：live 会话（任务×2 + /model-tier）重放到新控制器——对话面=seg 重建，命令卡即 ephemeral，seq 续排不回绕', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  pinDataDir(tmp);
  try {
    const ctrl1 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"任务一完成"}', '{"done":true,"reply":"任务二完成"}']) });
    await ctrl1.submit('第一个任务');
    await ctrl1.waitIdle();
    const pm = ctrl1.submit('/model-tier');
    await waitFor(() => ctrl1.getState().status === 'awaiting-question');
    ctrl1.resolveAskAnswer({ type: 'selected', labels: ['large'] });
    await pm;
    await ctrl1.submit('第二个任务');
    await ctrl1.waitIdle();

    const ctrl2 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"恢复后完成"}']) });
    const pr = ctrl2.submit('/resume');
    await waitFor(() => ctrl2.getState().status === 'awaiting-question');
    const cands = ctrl2.getState().question?.options.map((o) => o.label) ?? [];
    ctrl2.resolveAskAnswer({ type: 'selected', labels: [cands[0]!] });
    // 选中后二级动作卡（rewind/fork 规格 §7.2 入口 B）：restore 默认首项走现行恢复
    await waitFor(() => ctrl2.getState().question?.question.includes('fork from it?') ?? false);
    ctrl2.resolveAskAnswer({ type: 'selected', labels: ['restore'] });
    await pr;
    await ctrl2.waitIdle();
    const after = ctrl2.getState().messages;
    // 对话面重建(P3 seg 面):user 原文 ×2 + assistant ANSI ×2 + 恢复横幅;/model-tier 卡与命令回显即 ephemeral 不还原
    const plain = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');
    assert.equal(after.length, 5, '恢复流 = user/assistant×2 轮 + 恢复提示行(命令卡不还原)');
    assert.equal(after[0].role, 'user');
    assert.equal(after[0].text, '第一个任务', 'user 条剥引用块原文还原');
    assert.equal(after[1].role, 'assistant');
    assert.ok(plain(after[1].text).includes('任务一完成'), 'assistant 条终稿在档(ANSI 现渲)');
    assert.equal(after[2].text, '第二个任务', '第二轮 user 条在档');
    assert.ok(plain(after[3].text).includes('任务二完成'), '第二轮 assistant 条在档');
    assert.equal(after[4].role, 'system', '恢复横幅殿后');
    const beforeChain = ctrl2.context.chainView();
    assert.ok(beforeChain.some((s) => s.observation.includes('第一个任务')), '链视图还原(restoreSession)');
    assert.equal(ctrl2.getState().tier, 'large', '档位还原');
    assert.equal(ctrl2.getState().status, 'idle', '恢复后安全缺省 idle');
    const maxSeq = after[after.length - 1].seq;

    // seq 续排：恢复后新任务的消息 seq 严格大于存档重建序
    await ctrl2.submit('恢复后新输入');
    await ctrl2.waitIdle();
    const msgs = ctrl2.getState().messages;
    assert.ok(msgs.slice(after.length).every((m) => m.seq > maxSeq), 'seq 续排不回绕');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/new 轮转：旧档留存可找回、列表倒序、序号恢复旧会话', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    const ctrl1 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"任务甲完成"}', '{"done":true,"reply":"任务乙完成"}']) });
    await ctrl1.submit('任务甲');
    await ctrl1.waitIdle();
    await ctrl1.submit('/new');
    await ctrl1.submit('任务乙');
    await ctrl1.waitIdle();
    // ScriptedAdapter 全程亚毫秒完成：两档 mtime 同毫秒并列会让「最新在前」排序不确定，显式钉 mtime（与 session-journal.test.ts 先例一致）
    const newer = listSessions(dataDir).find((m) => m.firstUser === '任务乙')!;
    for (const m of listSessions(dataDir)) {
      fs.utimesSync(m.file, new Date(), new Date(m.id === newer.id ? 2_000_000_000 : 1_000_000_000));
    }
    const metas = listSessions(dataDir);
    assert.equal(metas.length, 2, '/new 轮转后两个会话档并存');
    assert.equal(metas[0].firstUser, '任务乙', '列表最新在前');

    const ctrl2 = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    const pr = ctrl2.submit('/resume');
    await waitFor(() => ctrl2.getState().status === 'awaiting-question');
    const cands = ctrl2.getState().question?.options.map((o) => o.label) ?? [];
    ctrl2.resolveAskAnswer({ type: 'selected', labels: [cands[1]!] });
    // 选中后二级动作卡（rewind/fork 规格 §7.2 入口 B）：restore 默认首项走现行恢复
    await waitFor(() => ctrl2.getState().question?.question.includes('fork from it?') ?? false);
    ctrl2.resolveAskAnswer({ type: 'selected', labels: ['restore'] });
    await pr;
    const texts = ctrl2.getState().messages.map((m) => m.text);
    assert.ok(texts.some((t) => t.includes('任务甲')), '恢复的是旧会话（任务甲）');
    assert.ok(!ctrl2.getState().messages.some((m) => m.text === '任务乙'), '新会话内容不混入');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('斜杠会话即时建档（事件级）：/help 落 header+user，恢复面 firstUser 回显', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    await ctrl.submit('/help');
    const metas = listSessions(dataDir);
    assert.equal(metas.length, 1, '指令先行落盘：斜杠输入也即时建档');
    assert.equal(metas[0].firstUser, '/help');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('continueLast：手工 v3 档全词汇还原（seg 转录/链/待办/档位/模型选择/视图/输入历史），横幅上屏，UI 现场一次性取用', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    const j = new SessionJournal(dataDir);
    j.start(3);
    j.log({ t: 'user', text: '历史输入一' });
    j.log({ t: 'seg', kind: 'user', md: '历史输入一', ts: 1, seq: 1 });
    j.log({ t: 'seg', kind: 'assistant', md: '历史答复', ts: 2, seq: 2 });
    j.log({ t: 'chain', steps: [{ step: 1, action: 'task', observation: '指令行' }] });
    j.log({ t: 'todos', items: [{ text: '待办甲', status: 'pending' }] });
    j.log({ t: 'model', tier: 'small', modelId: 'deepseek/deepseek-chat' });
    j.log({ t: 'view', expandAll: true, latestFull: false });
    const id = j.currentId!;

    const sw = new ModelSwitcher({
      choices: [{ id: 'deepseek/deepseek-chat', provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_DEEPSEEK', contextWindow: 128000 }],
      default: new ScriptedAdapter([]),
    });
    const ctrl = new SessionController({ root: tmp, models: sw, continueLast: true });
    assert.equal(ctrl.getState().status, 'idle');
    assert.deepEqual(ctrl.getState().todos, [{ text: '待办甲', status: 'pending' }]);
    assert.equal(ctrl.getState().tier, 'small');
    assert.equal(sw.currentId(), 'deepseek/deepseek-chat', '模型选择还原：切换器换回档内内芯');
    assert.equal(ctrl.getState().modelId, 'deepseek/deepseek-chat', 'modelId 还原');
    assert.equal(ctrl.getState().modelLabel, 'deepseek/deepseek-chat', '状态栏段还原');
    assert.equal(ctrl.getState().modelWindow, 128000, '每模型窗口随选择还原（状态栏分母）');
    const texts = ctrl.getState().messages.map((m) => m.text);
    assert.ok(texts.includes('历史输入一') && texts.includes('历史答复'), '消息直注入');
    assert.ok(texts.some((t) => t.includes(String(id))), '续接横幅含会话 id');
    const ui = ctrl.takeRestoredUi();
    assert.deepEqual(ui, { history: ['历史输入一'], expandAll: true, latestFull: false }, 'UI 现场一次性取用');
    assert.equal(ctrl.takeRestoredUi(), undefined, '二次取用为 undefined');
    assert.deepEqual(ctrl.context.chainView(), [{ step: 1, action: 'task', observation: '指令行' }]);

    // 配置漂移：档内 modelId 已不在 providers 清单 → 告警上屏、保持当前（缺省内芯）不硬切
    const j2 = new SessionJournal(dataDir);
    j2.start(3);
    j2.log({ t: 'user', text: '漂移档输入' });
    j2.log({ t: 'model', modelId: 'gone/model' });
    const sw2 = new ModelSwitcher({
      choices: [{ id: 'deepseek/deepseek-chat', provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'SUNSHINEX_API_KEY_DEEPSEEK' }],
      default: new ScriptedAdapter([]),
    });
    const ctrl2 = new SessionController({ root: tmp, models: sw2, continueLast: true });
    assert.equal(sw2.currentId(), undefined, '漂移 id 不硬切，保持缺省内芯');
    assert.equal(ctrl2.getState().modelId, undefined);
    assert.ok(
      ctrl2.getState().messages.some((m) => m.role === 'system' && m.text.includes('gone/model') && m.text.includes('providers')),
      '漂移告警行上屏（含 id 与配置面指引）',
    );
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('日志尾行撕裂：恢复到最后一条完整事件并上屏提示', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  const dataDir = pinDataDir(tmp);
  try {
    fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
    const id = newSessionId();
    const file = path.join(sessionsDir(dataDir), id + '.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ t: 'header', v: 3, id, createdAt: 'x' }),
      JSON.stringify({ t: 'user', text: '完整输入' }),
      JSON.stringify({ t: 'seg', kind: 'user', md: '完整输入', ts: 1, seq: 1 }),
      '{"t":"seg","kin',
    ].join('\n'), 'utf8');
    const events = parseJournalFile(file).events;
    const r = reduceJournal(events);
    void r;
    SessionJournal; // 类型面引用

    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]), continueLast: true });
    const texts = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.ok(texts.includes('完整输入'), '完整事件已恢复');
    assert.ok(texts.includes('truncated') || texts.includes('截断'), '撕裂提示上屏');
    assert.equal(ctrl.getState().messages.length, 2, '消息 + 提示行，撕裂事件不复活');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/resume 候选排除当前在飞会话（事件级建档后命令输入不再污染候选）', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  pinDataDir(tmp);
  try {
    const ctrl1 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"r1"}']) });
    await ctrl1.submit('任务一');
    await ctrl1.waitIdle();
    // 同根新控制器：其当前会话（含任务二 + 命令回显）为在飞自建档，/resume 候选应排除它、只列真实会话
    const ctrl2 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"r2"}']) });
    await ctrl2.submit('任务二');
    await ctrl2.waitIdle();
    const pr = ctrl2.submit('/resume');
    await waitFor(() => ctrl2.getState().status === 'awaiting-question');
    const cands = ctrl2.getState().question?.options.map((o) => o.label) ?? [];
    assert.equal(cands.length, 1, '候选排除当前在飞自建档后仅剩真实会话');
    ctrl2.resolveAskAnswer({ type: 'selected', labels: [cands[0]!] });
    // 选中后二级动作卡（rewind/fork 规格 §7.2 入口 B）：restore 默认首项走现行恢复
    await waitFor(() => ctrl2.getState().question?.question.includes('fork from it?') ?? false);
    ctrl2.resolveAskAnswer({ type: 'selected', labels: ['restore'] });
    await pr;
    await ctrl2.waitIdle();
    const texts = ctrl2.getState().messages.map((m) => m.text).join('\n');
    assert.ok(texts.includes('任务一'), '排除自建档后应恢复到真实会话（消息流保留）');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
