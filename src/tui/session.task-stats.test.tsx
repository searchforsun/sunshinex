import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setLanguage } from '../i18n';
import { SessionController, formatTaskStatsLine } from './session';
import { ScriptedAdapter } from '../model/adapter';

setLanguage('en');

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('formatTaskStatsLine：无子代理消耗省略子代理段', () => {
  assert.equal(formatTaskStatsLine(192, 25, 3_100_000, 0), '3m 12s · 25 steps · ↑3100k tokens');
});

test('formatTaskStatsLine：含子代理段（合并总数 + 子代理分量）', () => {
  assert.equal(formatTaskStatsLine(192, 25, 3_100_000, 2_600_000), '3m 12s · 25 steps · ↑3100k tokens (subagents 2600k)');
});

test('任务收尾统计行：done 后 messages 尾部产出统计行（基线差值口径）', async () => {
  const tmp = tmpdir('sunshinex-sess-stats2-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"好的"}']) });
    await ctrl.submit('写个总结');
    const msgs = ctrl.getState().messages;
    const last = msgs[msgs.length - 1]!;
    assert.equal(last.role, 'system', '统计行为 system 行（入档、/resume 可回放）');
    assert.match(last.text, /\S+ · \d+ steps · ↑\d+(\.\d+)?k? tokens/, '形态 = 时长 · steps · tokens');
    assert.ok(!last.text.includes('subagents'), '无子代理消耗省略子代理段');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
