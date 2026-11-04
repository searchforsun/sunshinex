import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { slashHelp } from './chat-model';
import { resolveDataDir } from '../config/data-dir';
import { listSessions, parseJournalFile, reduceJournal } from './session-journal';

// 关断 learned 沉淀（控制面键 SUNSHINEX_LEARNED_SKILLS，env > 缺省 on）：本套件的成功任务
// 会经 settle 管线把 goal 沉淀为 learned 技能、写进数据目录，目录跨运行残留会污染
// 技能夹具断言；必须在任意 SessionController 构造前执行（判门是运行时求值）。
process.env.SUNSHINEX_LEARNED_SKILLS = 'off';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 每用例自钉数据目录（test-env.cjs 按文件共享 + 跨运行残留：链计数断言需用例级隔离；
 *  node:test 同文件顺序执行，进出恢复 env 不串扰邻用例） */
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
  const root = tmpdir('sunshinex-sess-skillcmd-');
  try {
    await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

// skills 硬载退役（spec 2026-11-04 §4.1）：/<skill-id> 退出命令面，skills 清单 lead 行承载软引用
// （模型经清单+skill 工具自加载）——TUI submit 未命中命令词一律当普通文本派发（GUI 同语义）

// ① `/skill-id 意图` 不再走命令分发：作为普通文本派发（GUI 同语义，skills 清单 lead 行承载软引用）
test('/skill-id 带意图当普通文本派发', async () => {
  await withIsolatedData(async (root) => {
    writeSkill(root, 'hello-sunshine', 'Hello Sunshine', 'Say hello'); // hello-sunshine 是盘上真实技能 id（夹具预置）
    const ctrl = new SessionController({ root, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl.submit('/hello-sunshine 请打招呼');
    await ctrl.waitIdle();
    // 断言：无「Skill loaded」系统行、无链上 action='skill' 行，任务按原文派发
    assert.ok(!ctrl.state.messages.some((m) => m.text.includes('Skill loaded')), '硬载退役：无 Skill loaded 回执');
    assert.ok(chainEntries(root).every((s) => s.action !== 'skill'), '无链上 action=skill 行');
    assert.ok(chainEntries(root).some((s) => s.action === 'task' && s.observation.includes('/hello-sunshine 请打招呼')), '任务按原文派发');
    assert.equal(ctrl.getState().status, 'idle');
  });
});

// ② `/未知词 参数` 不再报「无法识别命令」，当普通文本派发
test('/未知词 带参数当普通文本派发', async () => {
  await withIsolatedData(async (root) => {
    const ctrl = new SessionController({ root, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl.submit('/nope x');
    await ctrl.waitIdle();
    assert.ok(
      !ctrl.state.messages.some((m) => m.text.includes('无法识别命令') || m.text.includes('Unrecognized command')),
      'warn 分支退役：未命中命令词不再报无法识别',
    );
    assert.ok(chainEntries(root).some((s) => s.action === 'task' && s.observation.includes('/nope x')), '按普通文本派发');
  });
});

// ③ `/help` 无技能段（命令面仅剩纯内置命令；/skill 卡保留为插入辅助）
test('/help 不含技能段', () => {
  const help = slashHelp().join('\n');
  assert.ok(!help.includes('Skills:'), 'Skills 引导行整行退役');
  assert.ok(help.includes('/skill'), '/skill 插入卡仍在内置清单');
});
