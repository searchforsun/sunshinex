import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render, type TestRenderResult } from '../test-ink';
import { App } from './App';
import { SessionController } from '../session';
import { ScriptedAdapter } from '../../model/adapter';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** App 集成：Ctrl+Q 等待队列管理面板（P5 spec §12.3）——查看（序号+插入发送标记）、↑↓ 选条、
 *  E 内联编辑（Enter 提交）、D 删除、I 插入、Ctrl+↑↓ 重排、Esc 关闭；面板在场吞键。 */
test('App：Ctrl+Q 队列面板——查看/E 编辑/D 删除/I 插入/Ctrl+↑ 重排/front 标记/Esc 关闭', async () => {
  const tmp = tmpdir('sunshinex-app-queue-');
  let term: TestRenderResult | undefined;
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
    });
    // 队列播种（生产同构=内核 ops；steer 行落档随 persistKernelEvent 自动）
    ctrl.queueEnqueue('任务甲');
    ctrl.queueEnqueue('任务乙');

    term = render(<App controller={ctrl} banner={{ version: '1.0.0', model: 'm', root: tmp }} />);
    const { write, lastFrame } = term;
    await wait(200);
    assert.doesNotMatch(lastFrame() ?? '', /等待队列|Queued messages/, '缺省非面板态');

    write('\u0011'); // Ctrl+Q 开面板
    await wait(200);
    let frame = lastFrame() ?? '';
    assert.match(frame, /1\. 任务甲/, '条目行=序号+文本');
    assert.match(frame, /2\. 任务乙/, '第二条在场');
    assert.match(frame, /edit/, '键提示条切队列组');

    write('\u001b[B'); // ↓ 选中任务乙
    await wait(150);
    assert.match(lastFrame() ?? '', /❯ 2\. 任务乙/, '↓ 光标到第二条');

    write('\u001b[1;5A'); // Ctrl+↑ 重排：乙 → 队首
    await wait(150);
    frame = lastFrame() ?? '';
    assert.match(frame, /❯ 1\. 任务乙/, 'Ctrl+↑ 重排生效(乙至首,光标随行)');
    assert.match(frame, /2\. 任务甲/, '甲退居次位');

    write('f'); // F 置首插入(乙已在首——front 标记出现)
    await wait(150);
    assert.match(lastFrame() ?? '', /\[inject\] |\[插入发送\] /, 'F 置首后 front 标记行');

    write('\u001b[B'); // ↓ 回到甲
    await wait(120);
    write('e'); // E 编辑
    await wait(150);
    write('改'); // draft 输入
    await wait(120);
    frame = lastFrame() ?? '';
    assert.match(frame, /任务甲改/, '编辑 draft 行显示原文+输入增量');
    write('\r'); // Enter 提交
    await wait(150);
    assert.match(lastFrame() ?? '', /任务甲改/, 'Enter 后条目更新');
    assert.deepEqual(
      ctrl.queueItems().map((x) => x.text),
      ['任务乙', '任务甲改'],
      '内核队列态同步(ctrl API 同源)',
    );

    write('d'); // D 删除选中(甲改)
    await wait(150);
    assert.deepEqual(
      ctrl.queueItems().map((x) => x.text),
      ['任务乙'],
      'D 删除生效',
    );

    write('i'); // I 插入新条
    await wait(150);
    write('新插入');
    await wait(120);
    write('\r');
    await wait(150);
    assert.deepEqual(
      ctrl.queueItems().map((x) => x.text),
      ['任务乙', '新插入'],
      'I 插入入队',
    );

    write('\u001b'); // Esc 关面板
    await wait(150);
    assert.doesNotMatch(lastFrame() ?? '', /1\. 任务乙/, 'Esc 关闭(清单退场)');
    // 关闭后 Ctrl+Q 可再开
    write('\u0011');
    await wait(150);
    assert.match(lastFrame() ?? '', /新插入/, '再开可见');
  } finally {
    term?.unmount?.();
  }
});
