import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { resolveDataDir } from '../config/data-dir';
import { listSessions, parseJournalFile, reduceJournal } from './session-journal';

// 关断 learned 沉淀（控制面键 SUNSHINEX_LEARNED_SKILLS，env > 缺省 on）：本套件第 5 例的
// 成功任务会经 settle 管线把 goal 沉淀为 learned 技能、写进本文件私有数据目录
// （SUNSHINEX_DATA_DIR 钉定的 .data-test/tui-session.skill/skills），目录跨运行残留会污染
// 技能清单断言（deepEqual 全量序 / 9 项计数），单文件第二次运行必红。消费点
// （MemoryPipeline.runDeterministic / consumeLearned）对该键逐项实时判门，off 即零落盘；
// 且 learnedSkills 不受 /memory 会话覆盖影响，模块加载期设置一次即可全文件生效。
// 必须在任意 SessionController 构造前（即本行之后）执行——判门是运行时求值，装配期不冻结。
process.env.SUNSHINEX_LEARNED_SKILLS = 'off';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = tmpdir('sunshinex-sess-skill-');
  try {
    await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function sysTexts(ctrl: SessionController): string[] {
  return ctrl.getState().messages.filter((m) => m.role === 'system').map((m) => m.text);
}

/** 项目级技能夹具（.sunshinex/skills/<id>/SKILL.md，优先级链最高根） */
function writeSkill(root: string, id: string, name: string, description: string, extraFm = ''): void {
  const dir = path.join(root, '.sunshinex', 'skills', id);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `name: ${name}`, `description: ${description}`, 'version: 1.0.0'];
  if (extraFm) lines.push(extraFm);
  lines.push('---', '', `Body of ${name}.`);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), lines.join('\n'));
}

/** 事件级 journal 读链（chain 事件逐条直写，链条目即观察面） */
function chainEntries(root: string): Array<{ action?: string; observation: string }> {
  const meta = listSessions(resolveDataDir(root))[0];
  if (!meta) return [];
  return reduceJournal(parseJournalFile(meta.file).events).chain;
}

test('/skill：选择卡列技能、选定即链尾追注入 + 回执', async () => {
  await withRoot(async (root) => {
    writeSkill(root, 'greet', 'Greet', 'Say hello to someone');
    writeSkill(root, 'retro', 'Retro', 'Conduct a retrospective');
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    const p = ctrl.submit('/skill');
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    const q = ctrl.getState().question;
    assert.ok(q, '选择卡挂起');
    assert.equal(q!.filterable, undefined, '≤8 项不开筛选');
    assert.deepEqual(q!.options.map((o) => o.label), ['Greet', 'Retro'], '按名排序（formatSkillsIndex 同比较器）');
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['Greet'] });
    await p;
    const entry = chainEntries(root).find((s) => s.action === 'skill');
    assert.ok(entry, '链上出现 action=skill 条目');
    assert.match(entry!.observation, /^\[Skill\] Greet \(id=greet v=1\.0\.0\)\n\nBody of Greet\./, '头行对齐 loop skillRef 格式 + 正文随后');
    assert.ok(sysTexts(ctrl).some((x) => /Skill loaded: Greet/.test(x)), '加载回执上屏');
    assert.equal(ctrl.getState().status, 'idle');
  });
});

test('/skill：>8 技能全量选项 + filterable 标记（筛选在渲染层，会话层不分页）', async () => {
  await withRoot(async (root) => {
    for (let i = 1; i <= 9; i++) writeSkill(root, `s${i}`, `Skill ${i}`, `desc ${i}`);
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    const p = ctrl.submit('/skill');
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    const q = ctrl.getState().question;
    assert.equal(q!.filterable, true, '>8 启用筛选');
    assert.equal(q!.options.length, 9, '全量直出、无 More… 导航行');
    assert.ok(!q!.options.some((o) => o.label === 'More…'), '会话层不注入导航行');
    ctrl.resolveAskAnswer({ type: 'dismissed' });
    await p;
  });
});

test('/skill：重复加载去重——回执已加载、链上仅一条', async () => {
  await withRoot(async (root) => {
    writeSkill(root, 'greet', 'Greet', 'Say hello');
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    const p1 = ctrl.submit('/skill');
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['Greet'] });
    await p1;
    const p2 = ctrl.submit('/skill');
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['Greet'] });
    await p2;
    assert.ok(sysTexts(ctrl).some((x) => /already loaded|已加载/.test(x)), '去重回执');
    assert.equal(chainEntries(root).filter((s) => s.action === 'skill' && s.observation.includes('(id=greet v=')).length, 1, '链上恰好一条');
  });
});

test('/skill：含必填模板参数的技能——resolve 失败 warn 回执零注入', async () => {
  await withRoot(async (root) => {
    writeSkill(root, 'paramed', 'Paramed', 'Needs a param', 'params: target');
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    const p = ctrl.submit('/skill');
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['Paramed'] });
    await p;
    assert.ok(sysTexts(ctrl).some((x) => x.includes('SKILL_PARAM_MISSING')), 'resolve 失败回执带错误码');
    assert.equal(chainEntries(root).filter((s) => s.action === 'skill').length, 0, '零注入');
  });
});

test('/skill：空清单回执不弹卡；运行中拒绝；带参形态无法识别；dismissed 静默', async () => {
  await withRoot(async (root) => {
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    await ctrl.submit('/skill');
    assert.ok(sysTexts(ctrl).some((x) => /No skills available|暂无可用技能/.test(x)), '空清单回执');
    assert.equal(ctrl.getState().question, undefined, '不弹卡');

    // 运行中拒绝（守卫沿 /resume 先例；manual 模式写审批挂起即非 idle）
    writeSkill(root, 'greet', 'Greet', 'Say hello');
    const guarded = new SessionController({
      root,
      mode: 'manual',
      model: new ScriptedAdapter(['{"tool":"write","input":{"path":"a.txt","content":"1"},"done":false}', '{"done":true,"reply":"ok"}']),
    });
    const task = guarded.submit('写任务');
    await waitFor(() => guarded.getState().status === 'awaiting-approval');
    await guarded.submit('/skill');
    assert.ok(sysTexts(guarded).some((x) => /A task is running|暂不能执行/.test(x)), '运行中拒绝回执');
    assert.equal(guarded.getState().status, 'awaiting-approval', '仍挂审批、未弹技能卡');
    guarded.resolveApproval('deny');
    await task;

    // 带参形态走裸形式守卫（D1，不在 FREE_TEXT_ARGS 集）
    const bare = new SessionController({ root, model: new ScriptedAdapter([]) });
    await bare.submit('/skill greet');
    assert.ok(sysTexts(bare).some((x) => x.includes('Unrecognized command')), '带参形态统一无法识别');

    // dismissed 静默：无「Skill loaded」回执
    const quiet = new SessionController({ root, model: new ScriptedAdapter([]) });
    const p = quiet.submit('/skill');
    await waitFor(() => quiet.getState().status === 'awaiting-question');
    quiet.resolveAskAnswer({ type: 'dismissed' });
    await p;
    assert.ok(!sysTexts(quiet).some((x) => /Skill loaded/.test(x)), 'dismissed 零回执');
  });
});
