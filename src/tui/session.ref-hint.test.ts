import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { resolveDataDir } from '../config/data-dir';
import { listSessions, parseJournalFile, reduceJournal } from './session-journal';

// agents-teams P1（Task 5）未知 $/# 引用提示（spec §3.2 TUI 面；GUI ref-palette R5 同语义）：
// 普通文本派发前只读对照在册集合（listAgentDefs ids ∪ listTeams ids），未命中 token 聚合一条
// 普通 system 行（R6：无 warn 级），原文照发不拦截不改写。本套件沿 session.skill-command.test.ts
// 纯文本派发先例（submit → waitIdle → 链条目断言）。
process.env.SUNSHINEX_LEARNED_SKILLS = 'off';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 每用例自钉数据目录（test-env.cjs 按文件共享 + 跨运行残留：链计数断言需用例级隔离） */
async function withIsolatedData(fn: (root: string) => Promise<void>): Promise<void> {
  const prev = process.env.SUNSHINEX_DATA_DIR;
  await tmpdirCase(async (root) => {
    process.env.SUNSHINEX_DATA_DIR = path.join(root, 'data');
    try {
      await fn(root);
    } finally {
      if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
      else process.env.SUNSHINEX_DATA_DIR = prev;
    }
  });
}

async function tmpdirCase(fn: (root: string) => Promise<void>): Promise<void> {
  const root = tmpdir('sunshinex-sess-refhint-');
  try {
    await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 项目团队夹具（.sunshinex/teams/<id>/team.md；members 引内建四角色即在册不算 missing） */
function writeTeam(root: string, id: string, members: string[]): void {
  const dir = path.join(root, '.sunshinex', 'teams', id);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `name: ${id}`, `description: team ${id}`, 'version: 1.0.0', `members: ${members.join(' ')}`, '---', '', `Body of ${id}.`];
  fs.writeFileSync(path.join(dir, 'team.md'), lines.join('\n'));
}

/** 事件级 journal 读链（chain 事件逐条直写，链条目即观察面） */
function chainEntries(root: string): Array<{ action?: string; observation: string }> {
  const meta = listSessions(resolveDataDir(root))[0];
  if (!meta) return [];
  return reduceJournal(parseJournalFile(meta.file).events).chain;
}

const HINT_RE = /No registered match|未匹配到在册/;
const hintLines = (ctrl: SessionController): string[] =>
  ctrl.state.messages.filter((m) => m.role === 'system' && HINT_RE.test(m.text)).map((m) => m.text);

// ① 未知 token 进提示、在册 token 不进；聚合恰一条；原文照发不拦截
test('未知 $/# 引用：未知 token 进提示行、在册 token 不进，原文照常派发', async () => {
  await withIsolatedData(async (root) => {
    writeTeam(root, 'fix-crew', ['planner']); // 在册团队（#fix-crew 命中）
    const ctrl = new SessionController({ root, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const text = '#nope 请连同 #fix-crew 与 $planner 一起处理 $ghost';
    await ctrl.submit(text);
    await ctrl.waitIdle();
    const hints = hintLines(ctrl);
    assert.equal(hints.length, 1, `恰一条聚合提示行：${JSON.stringify(ctrl.state.messages.map((m) => m.text))}`);
    assert.ok(hints[0]!.includes('#nope') && hints[0]!.includes('$ghost'), `未知 token 应进提示：${hints[0]}`);
    assert.ok(!hints[0]!.includes('#fix-crew') && !hints[0]!.includes('$planner'), '在册 token 不得进提示');
    assert.ok(hints[0]!.includes('/agents') && hints[0]!.includes('/teams'), '提示应附在册查看入口');
    assert.ok(chainEntries(root).some((s) => s.action === 'task' && s.observation.includes(text)), '任务按原文派发（不拦截不改写）');
    assert.equal(ctrl.getState().status, 'idle');
  });
});

// ② 提示行是普通 system 行（R6：无 warn 级）
test('未知引用提示为普通 system 行（无 warn 级，R6）', async () => {
  await withIsolatedData(async (root) => {
    const ctrl = new SessionController({ root, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl.submit('$ghost do it');
    await ctrl.waitIdle();
    const hint = ctrl.state.messages.find((m) => m.role === 'system' && HINT_RE.test(m.text));
    assert.ok(hint, '未知 token 应有提示行');
    assert.equal(hint!.level, undefined, `提示应为普通 system 行：${JSON.stringify(hint)}`);
  });
});

// ③ 无 $/# token 文本零提示，派发照常
test('无 $/# token 纯文本零提示、派发不受影响', async () => {
  await withIsolatedData(async (root) => {
    const ctrl = new SessionController({ root, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl.submit('just do the thing');
    await ctrl.waitIdle();
    assert.equal(hintLines(ctrl).length, 0, '纯文本零提示');
    assert.ok(chainEntries(root).some((s) => s.action === 'task' && s.observation.includes('just do the thing')), '派发照常');
  });
});

// ④ 词法面（与 GUI 一词法）：词中 $/PATH 前缀形态不触发提示
test('词中 $ 与大写前缀形态不触发（一词法：(^|\\s) 起手 + 小写首字符）', async () => {
  await withIsolatedData(async (root) => {
    const ctrl = new SessionController({ root, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl.submit('set PATH=$PATH and see #L30 line and cost a$b');
    await ctrl.waitIdle();
    assert.equal(hintLines(ctrl).length, 0, `词中/大写形态不是引用 token：${JSON.stringify(hintLines(ctrl))}`);
  });
});

// ⑤ 读面失败 fail-soft：teams 目录损坏 → 零提示，派发不受影响
test('读面失败 fail-soft：teams 目录损坏 → 零提示，原文派发不受影响', async () => {
  await withIsolatedData(async (root) => {
    fs.mkdirSync(path.join(root, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sunshinex', 'teams'), 'not a dir'); // listTeams readdirSync 抛
    const ctrl = new SessionController({ root, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const text = '$nope hello';
    await ctrl.submit(text);
    await ctrl.waitIdle();
    assert.equal(hintLines(ctrl).length, 0, '读面失败零提示（fail-soft，不为提示误报）');
    assert.ok(chainEntries(root).some((s) => s.action === 'task' && s.observation.includes(text)), '派发不受影响');
    assert.equal(ctrl.getState().status, 'idle');
  });
});

// ⑥ G14.95 未知斜杠词落点同检：未命中命令词当普通文本派发时同样提示
test('G14.95 未知斜杠词落点同检：/nope $ghost 文本派发附提示且原文照发', async () => {
  await withIsolatedData(async (root) => {
    const ctrl = new SessionController({ root, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const text = '/nope 请让 $ghost 干活';
    await ctrl.submit(text);
    await ctrl.waitIdle();
    const hints = hintLines(ctrl);
    assert.equal(hints.length, 1, `落点同检恰一条提示：${JSON.stringify(ctrl.state.messages.map((m) => m.text))}`);
    assert.ok(hints[0]!.includes('$ghost'), '未知 token 应进提示');
    assert.ok(chainEntries(root).some((s) => s.action === 'task' && s.observation.includes(text)), '按普通文本派发（原文照发）');
  });
});
