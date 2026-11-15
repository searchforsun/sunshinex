import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TimerController } from './timer';
import type { WakeScheduleRecord } from './timer';

/** 定时调度原语单测（2026-11-15 sunx P2 Task 3）：假钟注入三缝（setTimeout/clearTimeout/now）——
 *  零真实时间依赖；arm/fire/cancel/替换/busy 排队/受理失败留位/R7 错过补发/收口逐项钉。 */

/** 假钟：句柄登记制——advance 推进钟面并按登记序触发到点句柄（同刻多柄=替换语义下至多一枚在册） */
class FakeClock {
  now = 1_000_000;
  private seq = 0;
  private handles = new Map<number, { at: number; fn: () => void }>();
  readonly setTimeoutImpl = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.handles.set(id, { at: this.now + Math.max(0, ms), fn });
    return id;
  };
  readonly clearTimeoutImpl = (handle: unknown): void => {
    this.handles.delete(handle as number);
  };
  /** 在册句柄数（替换语义断言：旧句柄确已撤销） */
  get pendingCount(): number {
    return this.handles.size;
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, h] of [...this.handles]) {
      if (h.at <= this.now) {
        this.handles.delete(id);
        h.fn();
      }
    }
  }
}

const rec = (over: Partial<WakeScheduleRecord> = {}): WakeScheduleRecord => ({
  id: 'sched-1',
  fireAt: 1_000_000 + 5_000,
  note: 'check the deploy',
  ...over,
});

describe('TimerController', () => {
  const mk = (over: { busy?: () => boolean; fireResult?: boolean | (() => boolean) } = {}) => {
    const clock = new FakeClock();
    const fired: Array<{ rec: WakeScheduleRecord; lateMs: number }> = [];
    const fireResult = over.fireResult ?? true;
    const c = new TimerController({
      busy: over.busy ?? (() => false),
      fire: (r, lateMs) => {
        fired.push({ rec: r, lateMs });
        return typeof fireResult === 'function' ? fireResult() : fireResult;
      },
      setTimeoutImpl: clock.setTimeoutImpl,
      clearTimeoutImpl: clock.clearTimeoutImpl,
      now: () => clock.now,
    });
    return { clock, fired, c };
  };

  test('arm → 到点 fire：载荷逐字段原样 + lateMs≈0（准点不迟到）', () => {
    const { clock, fired, c } = mk();
    const r = rec({ taskSpec: 'TASK-SPEC' });
    c.arm(r);
    assert.equal(c.scheduled?.id, 'sched-1');
    clock.advance(4_999);
    assert.equal(fired.length, 0, '未到点不 fire');
    clock.advance(1);
    assert.equal(fired.length, 1);
    assert.deepEqual(fired[0]!.rec, r);
    assert.equal(fired[0]!.lateMs, 0, '准点 lateMs=0');
    assert.equal(c.scheduled, undefined, '受理后调度位清空');
  });

  test('cancel：到点不 fire、调度位清空、句柄撤销', () => {
    const { clock, fired, c } = mk();
    c.arm(rec());
    assert.equal(clock.pendingCount, 1);
    c.cancel();
    assert.equal(clock.pendingCount, 0, '句柄已撤销');
    assert.equal(c.scheduled, undefined);
    clock.advance(10_000);
    assert.equal(fired.length, 0);
  });

  test('单活跃位替换：新 arm 撤旧句柄——旧 record 永不到点，新 record 准点 fire', () => {
    const { clock, fired, c } = mk();
    c.arm(rec({ id: 'sched-1', fireAt: 1_000_000 + 5_000, note: 'first' }));
    c.arm(rec({ id: 'sched-2', fireAt: 1_000_000 + 8_000, note: 'second' }));
    assert.equal(clock.pendingCount, 1, '旧句柄已撤销（替换语义）');
    clock.advance(5_000);
    assert.equal(fired.length, 0, '旧调度位已随替换作废');
    clock.advance(3_000);
    assert.equal(fired.length, 1);
    assert.equal(fired[0]!.rec.id, 'sched-2');
    assert.equal(fired[0]!.rec.note, 'second');
  });

  test('busy 到点排队：轮收束 onTurnEnded 补跑；busy 期 onTurnEnded 不派发', () => {
    let busy = true;
    const { clock, fired, c } = mk({ busy: () => busy });
    c.arm(rec());
    clock.advance(5_000);
    assert.equal(fired.length, 0, 'busy 即排队（due 留位）');
    assert.equal(c.scheduled?.id, 'sched-1', '调度位保留');
    assert.equal(c.onTurnEnded(), false, '仍 busy 不派发');
    busy = false;
    assert.equal(c.onTurnEnded(), true, '空闲轮收束补跑');
    assert.equal(fired.length, 1);
    assert.ok(fired[0]!.lateMs >= 0);
    assert.equal(c.onTurnEnded(), false, '消费后再问=无补跑');
  });

  test('fire 未受理（false）留位：下次轮收束重试，受理后清位', () => {
    let accept = false;
    const { clock, fired, c } = mk({ fireResult: () => accept });
    c.arm(rec({ id: 'a' }));
    clock.advance(5_000);
    assert.equal(fired.length, 1, 'fire 已被调用（受理面决定去留）');
    assert.equal(c.scheduled?.id, 'a', '未受理留位');
    accept = true;
    assert.equal(c.onTurnEnded(), true, '轮收束重试受理');
    assert.equal(fired.length, 2);
    assert.equal(c.scheduled, undefined);
  });

  test('R7 错过重布防：arm 时 fireAt 已过 → 异步即发 + lateMs=停机跨度', () => {
    const { clock, fired, c } = mk();
    c.arm(rec({ fireAt: 1_000_000 - 5_000 })); // 停机跨越：fireAt 早于 now 5s
    assert.equal(fired.length, 0, 'arm 本身零同步副作用（回放路径安全）');
    clock.advance(0);
    assert.equal(fired.length, 1, '补发一次');
    assert.equal(fired[0]!.lateMs, 5_000, '迟到时长=fireAt 跨度（通知文注明延迟的数据源）');
  });

  test('reset：句柄清空不再到点（宿主 teardown 收口面）', () => {
    const { clock, fired, c } = mk();
    c.arm(rec());
    c.reset();
    clock.advance(10_000);
    assert.equal(fired.length, 0);
    assert.equal(c.scheduled, undefined);
  });
});
