import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { resolveDataDir } from '../config/data-dir';
import { parseJournalFile, sessionsDir } from './session-journal';

test('todo_write 端到端：模型调用 → 待办状态 → journal 落盘（规格 D1/D6/D8）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-todowrite-'));
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        '{"tool":"todo_write","input":{"todos":[{"text":"调研","status":"completed"},{"text":"实现","status":"in_progress"},{"text":"落库","status":"pending"}]}}',
        '{"done":true,"reply":"ok"}',
      ]),
    });
    await ctrl.submit('做一件事');
    await ctrl.waitIdle();
    assert.deepEqual(ctrl.getState().todos, [
      { text: '调研', status: 'completed' },
      { text: '实现', status: 'in_progress' },
      { text: '落库', status: 'pending' },
    ]);
    assert.ok(
      ctrl.getState().messages.some((m) => m.role === 'tool' && m.kind === 'call' && m.text.startsWith('TODO')),
      '调用行上屏（TODO 动词）',
    );
    const dir = sessionsDir(resolveDataDir(tmp));
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
    assert.ok(file, 'journal 已建档');
    const parsed = parseJournalFile(path.join(dir, file!));
    const todosEvents = parsed.events.filter((e) => e.t === 'todos');
    assert.equal(todosEvents.length, 1, '模型一次调用恰好一条 todos 事件');
    assert.deepEqual(
      (todosEvents[0] as { items: Array<{ text: string; status: string }> }).items[1],
      { text: '实现', status: 'in_progress' },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
