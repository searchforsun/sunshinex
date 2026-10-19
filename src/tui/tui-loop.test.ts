import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { runTuiLoop, installSyncUpdateWrap } from './tui-loop';
import { RetainedUiState } from './ui-state';

/** ink 实例替身：unmount 即视为退出（waitUntilExit 解析），与 ink 语义一致 */
class FakeInstance {
  unmounts = 0;
  private resolveExit!: () => void;
  readonly exited = new Promise<void>((resolve) => (this.resolveExit = resolve));
  waitUntilExit(): Promise<void> {
    return this.exited;
  }
  unmount(): void {
    this.unmounts += 1;
    this.resolveExit();
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('tui-loop：resize 冻结-重放——首事件冻结定格零重挂，settle 一次性清屏重挂；现场对象跨重挂复用', async () => {
  const ee = new EventEmitter();
  const screens: string[] = [];
  const mounts: FakeInstance[] = [];
  const retains: RetainedUiState[] = [];
  const loop = runTuiLoop({
    stdout: ee as never,
    clearScreen: () => screens.push('clear'),
    renderOnce: (retain) => {
      retains.push(retain);
      const inst = new FakeInstance();
      mounts.push(inst);
      return inst;
    },
    debounceMs: 20,
  });

  assert.equal(mounts.length, 1, '启动即挂载一次');
  assert.equal(screens.length, 0, '首挂载不清屏（入口已清屏）');

  ee.emit('resize');
  await tick();
  assert.equal(mounts.length, 1, '首事件冻结：不重挂（拖拽期零重渲染）');
  assert.equal(mounts[0].unmounts, 1, '旧实例已卸载定格');
  assert.deepEqual(screens, [], '冻结期不清屏');

  ee.emit('resize');
  ee.emit('resize');
  await tick();
  assert.equal(mounts.length, 1, '拖拽连发保持冻结、零重挂');
  await sleep(60);
  assert.equal(mounts.length, 2, 'settle 后一次性清屏重挂');
  assert.deepEqual(screens, ['clear']);
  assert.equal(mounts[0].unmounts, 1);

  assert.ok(retains[0] === retains[1], '现场对象跨重挂复用');

  mounts[1].unmount();
  await loop;
  assert.equal(mounts.length, 2, '正常退出不再重挂');
});

test('tui-loop：冻结落在 waitUntilExit 期间不退出循环——settle 后 full 重放（resize 即杀 TUI 回归）', async () => {
  const ee = new EventEmitter();
  const screens: string[] = [];
  const mounts: FakeInstance[] = [];
  const loop = runTuiLoop({
    stdout: ee as never,
    clearScreen: () => screens.push('clear'),
    renderOnce: () => {
      const inst = new FakeInstance();
      mounts.push(inst);
      return inst;
    },
    debounceMs: 20,
  });
  assert.equal(mounts.length, 1);

  // 冻结落在 waitUntilExit 悬挂期:卸载唤醒循环,但 repaintQueued 为空——退出条件若不含 frozen 即杀 TUI
  ee.emit('resize');
  await tick();
  assert.equal(mounts.length, 1, '冻结期零重挂');
  await sleep(60);
  assert.equal(mounts.length, 2, 'settle 后 full 重放(循环未退出)');
  assert.deepEqual(screens, ['clear']);

  mounts[1].unmount();
  await loop;
});

test('tui-loop：重绘路径以同步更新（DEC 2026）包裹清屏与重挂，终端原子换帧不闪中间空屏', async () => {
  const ee = new EventEmitter();
  const writes: string[] = [];
  const mounts: FakeInstance[] = [];
  const loop = runTuiLoop({
    stdout: ee as never,
    writeRaw: (s) => writes.push(s),
    clearScreen: () => writes.push('<clear>'),
    renderOnce: () => {
      writes.push('<render>');
      const inst = new FakeInstance();
      mounts.push(inst);
      return inst;
    },
    debounceMs: 20,
  });

  assert.equal(mounts.length, 1, '启动即挂载一次');
  assert.deepEqual(writes, ['<render>'], '首挂载有渲染但无同步更新包裹（入口清屏不是模式切换）');

  writes.length = 0;
  ee.emit('resize'); // 首事件冻结(零写),settle 后才清屏重放
  await sleep(60);

  assert.deepEqual(
    writes,
    ['\x1b[?2026h', '<clear>', '<render>', '\x1b[?2026l'],
    '清屏前开同步更新、重挂帧落定后收——终端持旧帧到重放完成原子切换',
  );

  mounts[mounts.length - 1].unmount();
  await loop;
});

test('tui-loop：installSyncUpdateWrap 全帧逐写原子化（2026-10-02 起缺省关闭，SUNSHINEX_SYNC_WRAP=1 显式开启）', () => {
  const writes: string[] = [];
  const stream = {
    write: (...args: unknown[]): unknown => {
      writes.push(args[0] as string);
      return args[0] !== 'fail' ;
    },
  };
  // 缺省直通：WT 不识别 DEC 2026、包裹是空操作且高频成对开合是渲染冻结头号嫌疑——直通零回归
  installSyncUpdateWrap(stream);
  stream.write('frame-content');
  assert.deepEqual(writes, ['frame-content'], '缺省直通不包裹');
  // 显式开启：逐写包裹为原子块（支持 2026 的终端换回原子换帧）
  process.env.SUNSHINEX_SYNC_WRAP = '1';
  try {
    installSyncUpdateWrap(stream);
    const r = stream.write('frame-content');
    assert.equal(r, true, '写返回值透传');
    assert.deepEqual(writes.slice(1), ['\x1b[?2026hframe-content\x1b[?2026l'], '逐写包裹为原子块');
    stream.write('\x1b[?2026halready\x1b[?2026l');
    assert.equal(writes.length, 3, '已含 2026h 的写（repaint 路径自包）不重复包裹');
  } finally {
    delete process.env.SUNSHINEX_SYNC_WRAP;
  }
});
