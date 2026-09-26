import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { Text } from 'ink';
import { render } from '../test-ink';
import useInput from './use-input';

// 键盘监听挂载时序回归（真机症状：运行中快捷键与输入全部失效）：
// 监听必须 layout 相位同步挂载且生命周期与处理器身份解耦——被动 effect（useEffect + inputHandler 依赖）
// 在高频重渲染（子面板 120ms 节流 + Spinner 240ms 帧）下反复摘挂，空窗内到达的按键直接丢失。

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function Probe(props: { onKey: (input: string) => void; tick: number }): JSX.Element {
  useInput((input) => props.onKey(input));
  return <Text>{props.tick}</Text>;
}

test('挂载后立即到达的按键不丢（监听 layout 相位即挂，不等被动冲刷）', async () => {
  const got: string[] = [];
  const one = render(<Probe onKey={(i) => got.push(i)} tick={0} />);
  await sleep(30); // 挂载完成（ink 异步提交）
  one.write('x');
  await sleep(20);
  assert.deepEqual(got, ['x'], `挂载后立即按键丢失，收到 ${JSON.stringify(got)}`);
  one.unmount();
});

test('高频重渲染窗口内到达的按键不丢（监听生命周期与处理器身份解耦）', async () => {
  const got: string[] = [];
  function Host(): JSX.Element {
    const [tick, setTick] = React.useState(0);
    React.useEffect(() => {
      const t = setInterval(() => setTick((v) => v + 1), 10);
      return () => clearInterval(t);
    }, []);
    useInput((input) => got.push(input));
    return <Text>{tick}</Text>;
  }
  const one = render(<Host />);
  await sleep(80); // 覆盖 ≥5 次重渲染周期（每 10ms 一次，旧实现每帧摘挂监听）
  one.write('k');
  await sleep(30);
  assert.deepEqual(got, ['k'], `高频重渲染下按键丢失，收到 ${JSON.stringify(got)}`);
  one.unmount();
});
