import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCommand } from './session-commands';
import { MemoryStore } from '../harness/memory/store';
import type { SessionRuntime } from './session';

/** /memory 命令族测试（2026-11-25 用户裁定「/memory-gc /memory 等命令 gui 也要加上」）:
 *  rt 最小桩(root=临时目录+pump 静默)/MemoryStore 真档(tmp 隔离)——清单/删除/整理早退三面。 */

function makeRt(root: string): SessionRuntime {
  return {
    root,
    status: () => 'idle',
    pump: () => undefined,
    commandAbort: undefined,
    runtime: { harness: { model: null } },
  } as unknown as SessionRuntime;
}

async function capture(rt: SessionRuntime, line: string): Promise<{ result: string; text: string }> {
  let text = '';
  const result = await runCommand(rt, line, (t) => {
    text = t;
  });
  return { result, text };
}

test('/memory 命令族:空清单/清单/按序号删除/整理早退（2026-11-25 用户裁定）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cmds-'));
  try {
    const rt = makeRt(root);
    // 空清单
    const empty = await capture(rt, '/memory');
    assert.equal(empty.result, 'ok');
    assert.ok(empty.text.includes('No memories yet'), '空清单如实提示(t() 随测试语言 en)');
    // 整理:空清单早退(零模型调用)
    const gc = await capture(rt, '/memory-gc');
    assert.equal(gc.result, 'ok');
    assert.ok(gc.text.includes('nothing to consolidate'), '空清单整理早退');
    // 播两条真记忆
    const store = new MemoryStore(root);
    const a = store.add({ type: 'user', description: '用户偏好结论先行', body: '回答先给结论', created: '2026-01-01' });
    const b = store.add({ type: 'project', description: '项目使用 pnpm', body: '包管理器 pnpm', created: '2026-01-02' });
    assert.ok(a.ok && b.ok, '种子记忆写入');
    // 清单:序号+slug+描述行
    const list = await capture(rt, '/memory');
    assert.ok(list.text.includes('Persistent memories (2)'), '清单计数');
    assert.ok(list.text.includes('用户偏好结论先行'), '描述随行');
    // 裸 /memory-rm=清单+用法(有记录期断言——清空后走空库早退分支)
    const bare = await capture(rt, '/memory-rm');
    assert.ok(bare.text.includes('Usage:'), '裸命令回清单+用法');
    // 未知条目(有记录期断言——清空后走空库早退分支)
    const unknown = await capture(rt, '/memory-rm nope');
    assert.ok(unknown.text.includes('Unknown memory'), '未知条目如实提示');
    // 按序号删除
    const rm = await capture(rt, '/memory-rm 1');
    assert.ok(rm.text.includes('Memory removed'), '序号删除回执');
    assert.equal(new MemoryStore(root).list().length, 1, '盘面减一');
    // 按名称删除
    const rm2 = await capture(rt, `/memory-rm ${b.value.slug}`);
    assert.ok(rm2.text.includes('Memory removed'), '名称删除回执');
    assert.equal(new MemoryStore(root).list().length, 0, '盘面清空');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
