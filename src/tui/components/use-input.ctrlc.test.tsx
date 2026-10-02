import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Text } from 'ink';
import { render } from '../test-ink';
import useInput, { RawKey } from './use-input';

// test-ink render 固定 exitOnCtrlC: false（与生产 entry 同口径）——Ctrl+C 必须达分发层。
// cb3ec70 重写丢失 !internal_exitOnCtrlC 守卫致 Ctrl+C 被无条件吞（真机「Ctrl+C 失效」）

function Probe(props: { onKey: (input: string, key: RawKey) => void }): JSX.Element {
  useInput((input, key) => props.onKey(input, key));
  return <Text>p</Text>;
}

test('use-input：Ctrl+C 在 exitOnCtrlC:false 下进分发层（key.ctrl + input c，真机「Ctrl+C 失效」回归）', async () => {
  const got: { input: string; key: RawKey }[] = [];
  const one = render(<Probe onKey={(input, key) => got.push({ input, key })} />);
  await new Promise((r) => setTimeout(r, 30));
  one.write('\x03');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(got.length, 1, `Ctrl+C 应派发一次（实际 ${got.length}）`);
  assert.equal(got[0]!.input, 'c');
  assert.ok(got[0]!.key.ctrl, 'key.ctrl 置位');
  one.unmount();
});

test('use-input：普通字符与组合键不受守卫影响', async () => {
  const got: { input: string; key: RawKey }[] = [];
  const one = render(<Probe onKey={(input, key) => got.push({ input, key })} />);
  await new Promise((r) => setTimeout(r, 30));
  one.write('x');
  one.write('\x18'); // Ctrl+X
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(got.map((g) => g.input), ['x', 'x'], '普通字符与 Ctrl+X 均派发');
  assert.ok(got[1]!.key.ctrl);
  one.unmount();
});
