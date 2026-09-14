import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { ScriptedAdapter } from '../model/adapter';

/** 装配面契约（对标 ~/.claude/projects/<项目>）：缺省数据落全局按工作区隔离，工作区零残留 */
test('Harness：运行时数据落 ~/.sunshinex/projects/<工作区>/data，工作区零残留（HOME 重定向临时目录，用后复原）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-dd-harness-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-dd-harness-home-'));
  const prevHome = process.env.HOME;
  const prevOvr = process.env.SUNSHINEX_DATA_DIR;
  try {
    delete process.env.SUNSHINEX_DATA_DIR;
    process.env.HOME = fakeHome;
    const h = new Harness({ root, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const r = await h.reactor.run({ goal: '数据目录装配验收' }, { maxSteps: 2 });
    assert.equal(r.done, true);
    const projects = path.join(fakeHome, '.sunshinex', 'projects');
    const slugs = fs.readdirSync(projects);
    assert.equal(slugs.length, 1, '按工作区 slug 隔离：一个工作区一个数据目录');
    const dataDir = path.join(projects, slugs[0], 'data');
    assert.ok(fs.existsSync(path.join(dataDir, 'skills')), '学习技能沉淀至全局数据目录');
    assert.ok(!fs.existsSync(path.join(root, '.data')), '工作区零残留');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;else process.env.HOME = prevHome;
    if (prevOvr === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevOvr;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
