import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { readSkillUsage } from '../catalog/skill-usage';
import { resolveDataDir } from '../config/data-dir';
import { listSessions, parseJournalFile, reduceJournal } from './session-journal';

// 关断 learned 沉淀（控制面键 SUNSHINEX_LEARNED_SKILLS，env > 缺省 on）：消费点
// （MemoryPipeline.runDeterministic / consumeLearned）对该键逐项实时判门，off 即零落盘；
// 且 learnedSkills 不受 /memory 会话覆盖影响，模块加载期设置一次即可全文件生效。
// 必须在任意 SessionController 构造前（即本行之后）执行——判门是运行时求值，装配期不冻结。
process.env.SUNSHINEX_LEARNED_SKILLS = 'off';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * HOME 隔离（2026-10-08 实机暴露）：loadSkills 除项目根外还并 userSkillsDir()（~/.sunshinex/skills）——
 * 本机真实装过 superpowers 技能集时，/skill 计数断言被真用户数据污染（24 vs 9）。
 * 夹具内重定向 HOME/USERPROFILE 至临时目录，与 daemon.test 的 withSettingsDaemon 同口径。
 */
async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = tmpdir('sunshinex-sess-skill-');
  const fakeHome = tmpdir('sunshinex-sess-skill-home-');
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    await fn(root);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
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
function writeSkill(root: string, id: string, name: string, description: string): void {
  const dir = path.join(root, '.sunshinex', 'skills', id);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `name: ${name}`, `description: ${description}`, 'version: 1.0.0', '---', '', `Body of ${name}.`];
  fs.writeFileSync(path.join(dir, 'SKILL.md'), lines.join('\n'));
}

/** 事件级 journal 读链（chain 事件逐条直写，链条目即观察面） */
function chainEntries(root: string): Array<{ action?: string; observation: string }> {
  const meta = listSessions(resolveDataDir(root))[0];
  if (!meta) return [];
  return reduceJournal(parseJournalFile(meta.file).events).chain;
}

// /skill 改插入引用（spec 2026-11-04 §4.2 硬载退役）：选定即把 `/id ` 回填输入框（用户补意图后提交——
// 模型经清单+skill 工具软加载）；链上零注入、无硬载回执；使用记录保留（选择卡排序源）

test('/skill：选择卡列技能、选定即回填 /id 引用（零链上注入、无硬载回执）', async () => {
  await withRoot(async (root) => {
    writeSkill(root, 'greet', 'Greet', 'Say hello to someone');
    writeSkill(root, 'retro', 'Retro', 'Conduct a retrospective');
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    const prefilled: string[] = [];
    ctrl.onPrefillInput((x) => prefilled.push(x)); // prefill spy（App 输入框回填接缝同款注册面）
    const p = ctrl.submit('/skill');
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    const q = ctrl.getState().question;
    assert.ok(q, '选择卡挂起');
    assert.equal(q!.filterable, undefined, '≤8 项不开筛选');
    assert.deepEqual(q!.options.map((o) => o.label), ['Greet', 'Retro'], '按名排序（formatSkillsIndex 同比较器）');
    ctrl.resolveAskAnswer({ type: 'selected', labels: ['Greet'] });
    await p;
    assert.deepEqual(prefilled, ['/greet '], '选定即回填 /id 引用（尾随空格留意图位）');
    assert.equal(chainEntries(root).filter((s) => s.action === 'skill').length, 0, '零链上注入（硬载退役）');
    assert.ok(!sysTexts(ctrl).some((x) => /Skill loaded|已加载/.test(x)), '无硬载回执');
    assert.ok(typeof readSkillUsage(root)['greet'] === 'number', '选定即记使用（选择卡排序源）');
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

test('/skill：空清单回执不弹卡；运行中拒绝；带参形态命令词命中卡照弹；dismissed 静默零回填', async () => {
  await withRoot(async (root) => {
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    await ctrl.submit('/skill');
    assert.ok(sysTexts(ctrl).some((x) => /No skills available|暂无可用技能/.test(x)), '空清单回执');
    assert.equal(ctrl.getState().question, undefined, '不弹卡');

    // 运行中拒绝（守卫沿 /resume 先例；manual 模式下 guard 层 ask 已收敛于非只读命令——
    // 行为变更①后 path 写直放安全链不再挂审批，故以非只读 Bash 命令制造「运行中」态）
    writeSkill(root, 'greet', 'Greet', 'Say hello');
    const guarded = new SessionController({
      root,
      mode: 'acceptEdits',
      model: new ScriptedAdapter(['{"tool":"exec","input":{"command":"mkdir run-guard"},"done":false}', '{"done":true,"reply":"ok"}']),
    });
    const task = guarded.submit('跑个命令');
    await waitFor(() => guarded.getState().status === 'awaiting-approval');
    await guarded.submit('/skill');
    assert.ok(sysTexts(guarded).some((x) => /A task is running|暂不能执行/.test(x)), '运行中拒绝回执');
    assert.equal(guarded.getState().status, 'awaiting-approval', '仍挂审批、未弹技能卡');
    guarded.resolveApproval('deny');
    await task;

    // 带参形态：命令词命中 /skill 分支（尾参忽略，卡照常弹出——裸形式守卫随硬载退役）
    const bare = new SessionController({ root, model: new ScriptedAdapter([]) });
    const barePrefilled: string[] = [];
    bare.onPrefillInput((x) => barePrefilled.push(x));
    const pBare = bare.submit('/skill greet');
    await waitFor(() => bare.getState().status === 'awaiting-question');
    assert.ok(bare.getState().question?.options.some((o) => o.label === 'Greet'), '带参形态仍走 /skill 卡');
    bare.resolveAskAnswer({ type: 'dismissed' });
    await pBare;
    assert.deepEqual(barePrefilled, [], '带参 dismissed 零回填');

    // dismissed 静默：无「Skill loaded」回执、零回填
    const quiet = new SessionController({ root, model: new ScriptedAdapter([]) });
    const quietPrefilled: string[] = [];
    quiet.onPrefillInput((x) => quietPrefilled.push(x));
    const p = quiet.submit('/skill');
    await waitFor(() => quiet.getState().status === 'awaiting-question');
    quiet.resolveAskAnswer({ type: 'dismissed' });
    await p;
    assert.ok(!sysTexts(quiet).some((x) => /Skill loaded/.test(x)), 'dismissed 零回执');
    assert.deepEqual(quietPrefilled, [], 'dismissed 零回填');
  });
});
