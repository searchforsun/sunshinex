import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import { listSessions } from './session-journal';

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-journal-reply-'));
}

function pinDataDir(root: string): string {
  const dataDir = path.join(root, '.data-pin');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.SUNSHINEX_DATA_DIR = dataDir;
  return dataDir;
}

function messageTexts(ctrl: SessionController): string {
  return ctrl.getState().messages.map((m) => m.text).join('\n');
}

test('resume：流式切块段落全部入档，恢复后正文完整', async () => {
  const tmp = tmpRoot();
  const prev = process.env.SUNSHINEX_DATA_DIR;
  pinDataDir(tmp);
  try {
    // 多段正文：段落边界触发 flushReply 切块，前段经切块路径入档、尾段经 done 路径入档
    const reply = [
      '第一段结论行',
      '',
      '第二段展开说明，内容较长用于形成独立的流式切块。',
      '',
      '第三段补充背景与细节，同样跨越多个流式增量到达。',
      '',
      '第四段收尾。',
    ].join('\n');
    const ctrl1 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"' + reply + '"}']) });
    await ctrl1.submit('造档任务');
    await ctrl1.waitIdle();
    assert.ok(messageTexts(ctrl1).includes('第一段结论行'), '前置：当前会话消息面含首段');

    const ctrl2 = new SessionController({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"忽略"}']), resumePicker: true });
    await waitFor(() => ctrl2.getState().status === 'awaiting-question');
    const sessions = listSessions(pinDataDir(tmp));
    ctrl2.resolveAskAnswer({ type: 'selected', labels: [sessions[0].id] });
    await waitFor(() => ctrl2.getState().status === 'idle');
    const restored = messageTexts(ctrl2);
    assert.ok(restored.includes('第一段结论行'), '恢复后含首段（切块段须入档）');
    assert.ok(restored.includes('第四段收尾。'), '恢复后含尾段');
  } finally {
    process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
