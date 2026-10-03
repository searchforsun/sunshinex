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

// 真空宽限（2026-10-03 真机「归档视图进入/live→archived 换挡后须先按 Enter」终修钉）：
// 重挂路径（browse→归档进入、换挡）卸载与重挂同一宏任务，中间隔归档大转录首帧同步渲染（真机秒级）——
// 若卸载即关 raw mode，窗口内终端落 cooked 线路规程、物理按键行缓冲直到按 Enter 整行递交=病根签名。
// 夹具：同一假 stdin 两轮挂载（test-ink 每 render 新建 stdin，宽限语义需同一物理流），setRawMode 记调用。
import { render as inkRender } from 'ink';
import { EventEmitter, Writable } from 'stream';

interface SharedStdin {
  stdin: EventEmitter & { isTTY: boolean; setEncoding(): void; setRawMode(on?: boolean): void; resume(): void; pause(): void; ref(): void; unref(): void };
  rawCalls: boolean[];
  mount(sink: string[]): { unmount(): void };
}

function sharedStdinHarness(): SharedStdin {
  const rawCalls: boolean[] = [];
  const stdin = new EventEmitter() as SharedStdin['stdin'];
  stdin.isTTY = true;
  stdin.setEncoding = () => {};
  stdin.setRawMode = (on?: boolean) => { rawCalls.push(!!on); };
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const stdout = new Writable({ write(_chunk, _enc, cb) { cb(); } }) as Writable & { columns: number };
  stdout.columns = 100;
  const mount = (sink: string[]): { unmount(): void } => {
    const inst = inkRender(<Probe onKey={(i) => sink.push(i)} tick={0} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      debug: false,
      exitOnCtrlC: false,
    });
    return { unmount: () => inst.unmount() };
  };
  return { stdin, rawCalls, mount };
}

test('真空宽限：卸载→重挂窗口不关 raw mode（监听常驻，按键直达新处理器）', async () => {
  const h = sharedStdinHarness();
  const got1: string[] = [];
  const one = h.mount(got1);
  await sleep(30);
  h.stdin.emit('data', 'a');
  await sleep(20);
  assert.deepEqual(got1, ['a'], '首轮按键派发');
  const rawAfterMount = [...h.rawCalls];
  one.unmount();
  assert.deepEqual([...h.rawCalls], rawAfterMount, '卸载即刻不关 raw mode（宽限保留——渲染窗口终端不落 cooked 行缓冲）');
  const got2: string[] = [];
  const two = h.mount(got2);
  await sleep(30);
  h.stdin.emit('data', 'b');
  await sleep(20);
  assert.deepEqual(got2, ['b'], '同 stdin 重挂后按键派发新处理器（监听从未摘）');
  assert.deepEqual(got1, ['a'], '旧处理器不复活');
  assert.ok(h.rawCalls.length > 0 && h.rawCalls.every((on) => on), '全程未出现 setRawMode(false)');
  two.unmount();
  await sleep(30);
  assert.ok(h.rawCalls.every((on) => on), '宽限内仍未拆链（默认 1s 窗口未到）');
});

test('真空宽限到期：真无重挂才拆链（raw off + 监听摘除，SUNSHINEX_VACUUM_GRACE_MS 压短）', async () => {
  process.env.SUNSHINEX_VACUUM_GRACE_MS = '20';
  try {
    const h = sharedStdinHarness();
    const got: string[] = [];
    const one = h.mount(got);
    await sleep(30);
    h.stdin.emit('data', 'a');
    await sleep(20);
    assert.deepEqual(got, ['a']);
    one.unmount();
    assert.ok(!h.rawCalls.includes(false), '卸载即刻不关 raw mode');
    await sleep(80); // 越过宽限（20ms）
    assert.ok(h.rawCalls.includes(false), '宽限到期拆链退 raw mode（真无重挂路径）');
    h.stdin.emit('data', 'z');
    await sleep(20);
    assert.deepEqual(got, ['a'], '拆链后监听不在（按键零派发）');
  } finally {
    delete process.env.SUNSHINEX_VACUUM_GRACE_MS;
  }
});
