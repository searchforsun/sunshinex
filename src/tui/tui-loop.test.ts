import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { runTuiLoop } from './tui-loop';
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

test('tui-loop：resize 卸载→清屏→重挂；首事件立即、连发防抖收敛；现场对象跨重挂复用', async () => {
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
  assert.equal(mounts.length, 2, '首个 resize 立即重挂');
  assert.equal(mounts[0].unmounts, 1, '旧实例应被卸载');
  assert.deepEqual(screens, ['clear']);

  ee.emit('resize');
  ee.emit('resize');
  await tick();
  assert.equal(mounts.length, 2, '防抖窗口内连发不重挂');
  await sleep(60);
  assert.equal(mounts.length, 3, '窗口安静后收敛重挂一次');
  assert.equal(mounts[1].unmounts, 1);
  assert.deepEqual(screens, ['clear', 'clear']);

  assert.ok(retains[0] === retains[1] && retains[1] === retains[2], '现场对象跨重挂复用');

  mounts[2].unmount();
  await loop;
  assert.equal(mounts.length, 3, '正常退出不再重挂');
});
