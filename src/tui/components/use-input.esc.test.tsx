import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { Text } from 'ink';
import { render } from '../test-ink';
import useInput, { RawKey } from './use-input';

// 拆包重组回归（2026-09-30 幽灵中断修复）：conpty/高负载下一次按键的转义序列可拆成多个 data 事件，
// 首字节 \u001B 单独到达时旧解析当真 Esc 键——运行中即「无缘无故中断」（TASK_WAIT 收割瞬间真机形态）。
// 窗口钉 25ms：拼接断言窗口内到达、过期断言超窗后派发，均确定性
process.env.SUNSHINEX_ESC_JOIN_MS = '25';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function Probe(props: { onKey: (input: string, key: RawKey) => void; label: string }): JSX.Element {
  useInput((input, key) => props.onKey(input, key));
  return <Text>{props.label}</Text>;
}

test('拆包重组：裸 ESC + 窗口内后续字节拼成完整序列再解析（旧实现把首字节当真 Esc 即幽灵中断）', async () => {
  const got: RawKey[] = [];
  const one = render(<Probe label="p1" onKey={(_i, key) => got.push(key)} />);
  await sleep(30);
  one.write('\u001B');
  await sleep(5); // 窗口内到达的序列后半段
  one.write('[A');
  await sleep(60); // 超窗确认无二次派发
  assert.equal(got.length, 1, `应恰好派发一次（实际 ${got.length}）`);
  assert.equal(got[0]!.raw, '\u001B[A', '拼接后按完整序列派发');
  assert.ok(got[0]!.upArrow, '解析为 ↑');
  assert.ok(!got[0]!.escape, '不得误判为 Esc 键');
  one.unmount();
});

test('拆包重组：残缺 CSI 中段拼接——\\u001B[ + 3~ 拼成 ⌦ 序列，raw 保全', async () => {
  const got: RawKey[] = [];
  const one = render(<Probe label="p2" onKey={(_i, key) => got.push(key)} />);
  await sleep(30);
  one.write('\u001B[');
  await sleep(5);
  one.write('3~');
  await sleep(60);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.raw, '\u001B[3~');
  assert.ok(got[0]!.delete, '解析为 ⌦');
  one.unmount();
});

test('窗口过期：孤零裸 ESC = 真 Esc 键派发；普通键完整即零延迟直发', async () => {
  const got: RawKey[] = [];
  const one = render(<Probe label="p3" onKey={(_i, key) => got.push(key)} />);
  await sleep(30);
  // 普通键：完整序列同步直发，write 返回即已派发（不进拼接窗口）
  one.write('x');
  assert.equal(got.length, 1, '普通键零延迟直发');
  assert.equal(got[0]!.raw, 'x');
  // 裸 ESC：窗口内无后续 → 过期后按真 Esc 键派发
  one.write('\u001B');
  assert.equal(got.length, 1, '窗口内未派发');
  await sleep(80);
  assert.equal(got.length, 2, '过期后派发一次');
  assert.ok(got[1]!.escape, '孤零 ESC 解析为 Esc 键');
  assert.equal(got[1]!.raw, '\u001B');
  one.unmount();
});

test('连续两笔完整序列互不粘连（各自独立直发，拼接缓冲不残留）', async () => {
  const got: RawKey[] = [];
  const one = render(<Probe label="p4" onKey={(_i, key) => got.push(key)} />);
  await sleep(30);
  one.write('\u001B[B');
  one.write('\u001B[A');
  await sleep(60);
  assert.deepEqual(got.map((k) => k.raw), ['\u001B[B', '\u001B[A'], '两笔各派发一次、内容不粘连');
  assert.ok(got[0]!.downArrow && got[1]!.upArrow);
  one.unmount();
});

test('裸 ESC 扣住期间到达非序列字节：先派发 Esc 再派发后续键（2026-09-30 真机「全屏 Esc 需先按 Enter」病根）', async () => {
  const got: RawKey[] = [];
  const one = render(<Probe label="p5" onKey={(_i, key) => got.push(key)} />);
  await sleep(30);
  one.write('\u001B'); // Esc 扣进拼接窗口
  await sleep(5);
  one.write('\r'); // 窗口内 Enter 到达：旧实现拼成 '\u001B\r' 整体直发、escape=false 即 Esc 被吞
  await sleep(60);
  assert.equal(got.length, 2, `拆发两键（实际 ${got.length}）`);
  assert.ok(got[0]!.escape, '先派发真 Esc 键');
  assert.equal(got[0]!.raw, '\u001B');
  assert.ok(got[1]!.return, 'Enter 照常派发');
  assert.equal(got[1]!.raw, '\r');
  one.unmount();
});

test('裸 ESC 扣住期间到达 [ 开头字节仍拼合（拆包序列语义不让位于拆发）', async () => {
  const got: RawKey[] = [];
  const one = render(<Probe label="p6" onKey={(_i, key) => got.push(key)} />);
  await sleep(30);
  one.write('\u001B');
  await sleep(5);
  one.write('[B'); // ↓ 序列剩余：必须拼合而非拆发 Esc
  await sleep(60);
  assert.equal(got.length, 1, '拼合单发');
  assert.ok(got[0]!.downArrow, '解析为 ↓');
  assert.ok(!got[0]!.escape, '不误判 Esc');
  one.unmount();
});
