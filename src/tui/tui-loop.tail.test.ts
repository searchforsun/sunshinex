import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { runTuiLoop } from './tui-loop';
import { RetainedUiState } from './ui-state';
import { createTailLedger } from './tail-rewrite';

/** ink 实例替身（tui-loop.test 同款）：unmount 即退出 */
class FakeInstance {
  private resolveExit!: () => void;
  readonly exited = new Promise<void>((resolve) => (this.resolveExit = resolve));
  waitUntilExit(): Promise<void> {
    return this.exited;
  }
  unmount(): void {
    this.resolveExit();
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

interface Harness {
  writes: string[];
  clears(): number;
  mounts: { rewriteFrom?: number }[];
  request(mode?: 'full' | 'tail'): void;
  finish(): Promise<void>;
}

/** 装配循环替身：写流/清屏计数/挂载时 retain.rewriteFrom 快照全量观测 */
function harness(opts: { frameLines?: number; rows?: number; plan?: { from: number; suffixLines: number } | null }): Harness {
  const ee = new EventEmitter();
  const writes: string[] = [];
  const instances: FakeInstance[] = [];
  const mounts: { rewriteFrom?: number }[] = [];
  const retain: RetainedUiState = {
    buffer: '', cursor: 0, expandAll: false, latestFull: false, browseMode: false, browseCursor: 0,
    inspectExpanded: false, history: [], histIdx: -1,
    tailLedger: createTailLedger(),
  };
  if (opts.plan !== undefined) retain.tailLedger!.plan = opts.plan;
  let req: (mode?: 'full' | 'tail') => void = () => {};
  const loop = runTuiLoop({
    stdout: ee as never,
    initialRetain: retain,
    clearScreen: () => { writes.push('<clear>'); },
    writeRaw: (s: string): void => { writes.push(s); },
    frameLines: () => opts.frameLines,
    rows: () => opts.rows ?? 24,
    onRequestRepaint: (r) => { req = r; },
    renderOnce: (rt) => {
      mounts.push({ rewriteFrom: rt.rewriteFrom });
      const inst = new FakeInstance();
      instances.push(inst);
      return inst;
    },
  });
  return {
    writes,
    clears: () => writes.filter((w) => w === '<clear>').length,
    mounts,
    request: (mode) => req(mode),
    finish: async () => {
      instances[instances.length - 1]?.unmount();
      await loop;
    },
  };
}

test('tui-loop tail：光标上移 N+帧高就地擦写、预置 rewriteFrom、不清屏（2026 包裹原子换帧）', async () => {
  const h = harness({ frameLines: 4, rows: 30, plan: { from: 2, suffixLines: 6 } });
  await tick();
  assert.equal(h.mounts.length, 1, '启动挂载一次');
  h.request('tail');
  await tick();
  assert.equal(h.mounts.length, 2, 'tail 重挂一次');
  assert.equal(h.clears(), 0, '不清屏（滚动缓冲保留、零空白帧）');
  assert.ok(h.writes.some((w) => w.includes('\u001b[10A\x1b[J')), `应写入 CUU(6+4)+ED 字节序列，实际 ${JSON.stringify(h.writes)}`);
  assert.ok(h.writes.every((w) => !w.includes('2J')), '不得出现清屏字节');
  assert.equal(h.mounts[1]!.rewriteFrom, 2, '重挂时 retain.rewriteFrom=首失配位（MessageList 前缀抑制消费）');
  await h.finish();
});

test('tui-loop tail 回落：帧高无置信值 / 不可达 / plan 缺失 / 缺省模式 → 全量路径（清屏）', async () => {
  // ① 帧高嗅探无置信值
  const a = harness({ frameLines: undefined, rows: 30, plan: { from: 2, suffixLines: 6 } });
  await tick();
  a.request('tail');
  await tick();
  assert.equal(a.clears(), 1, '无帧高置信 → 清屏全量');
  assert.equal(a.mounts[1]!.rewriteFrom, undefined, '全量路径不预置前缀抑制');
  await a.finish();
  // ② 擦写起点超视口（6+25 > 24-1）
  const b = harness({ frameLines: 25, rows: 24, plan: { from: 2, suffixLines: 6 } });
  await tick();
  b.request('tail');
  await tick();
  assert.equal(b.clears(), 1, '不可达 → 清屏全量');
  await b.finish();
  // ③ plan 缺失（forceFull 闩在读侧同样归空）
  const d = harness({ frameLines: 4, rows: 30, plan: null });
  await tick();
  d.request('tail');
  await tick();
  assert.equal(d.clears(), 1, 'plan 缺失 → 清屏全量');
  await d.finish();
  // ④ 缺省模式=full（resize/Tab 既有语义）
  const e = harness({ frameLines: 4, rows: 30, plan: { from: 2, suffixLines: 6 } });
  await tick();
  e.request();
  await tick();
  assert.equal(e.clears(), 1, '缺省 full 清屏');
  await e.finish();
});

test('tui-loop 模式升级钉：tail 排队后被 full 覆盖 → 执行 full 不降级', async () => {
  const h = harness({ frameLines: 4, rows: 30, plan: { from: 2, suffixLines: 6 } });
  await tick();
  h.request('tail');
  h.request('full'); // 同帧内升级（如 tail 排队后用户按 Tab）
  await tick();
  assert.equal(h.mounts.length, 2);
  assert.equal(h.clears(), 1, '升级后走清屏全量');
  assert.equal(h.mounts[1]!.rewriteFrom, undefined);
  await h.finish();
});
