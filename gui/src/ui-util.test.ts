import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chaseScrollBottom, rAFConverge } from './ui-util';

/** rAFConverge/chaseScrollBottom 特征化钉(2026-10-27 技术债轮 D54② 抽取前先锚):
 *  rAF 用手工队列桩驱动(帧推进显式可控,不依赖 jsdom 的 rAF 实现与机热时序——判据来自
 *  真实帧推进非时序祈祷);滚动面以 defineProperty 桩模拟 content-visibility 水合增长。
 *  换回「单次 scrollTo/一次校正」旧实现:水合增长用例即红(落点偏短)——判别力在案。 */

type Frame = (t: number) => void;

function installRafStub(): { frames: (n: number) => void; pending: () => number } {
  const queue: Frame[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: Frame): number => {
    queue.push(cb);
    return queue.length;
  });
  return {
    frames: (n: number): void => {
      for (let i = 0; i < n; i++) queue.shift()?.(0);
    },
    pending: () => queue.length,
  };
}

interface FakeScroller {
  el: HTMLElement;
  grow: (n: number) => void;
  top: () => number;
}

function fakeScroller(height: number, client: number): FakeScroller {
  const el = document.createElement('div');
  let h = height;
  let top = 0;
  Object.defineProperty(el, 'isConnected', { value: true, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { get: () => h, configurable: true });
  Object.defineProperty(el, 'clientHeight', { get: () => client, configurable: true });
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = v;
    },
    configurable: true,
  });
  return { el, grow: (n) => { h += n; }, top: () => top };
}

describe('rAFConverge(迭代收敛器单点)', () => {
  let raf: ReturnType<typeof installRafStub>;
  beforeEach(() => {
    raf = installRafStub();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('对称偏差逐帧追平,连续 2 帧入 eps 收口', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'isConnected', { value: true, configurable: true });
    let target = 300; // 目标位(模拟水合推偏)
    let top = 0;
    Object.defineProperty(el, 'scrollTop', {
      get: () => top,
      set: (v: number) => {
        top = v;
      },
      configurable: true,
    });
    rAFConverge(
      el,
      () => target - top,
      (d) => {
        top += d;
      },
      2,
    );
    raf.frames(1); // delta=300 → top=300
    expect(top).toBe(300);
    target = 260; // 水合推偏 40
    raf.frames(1); // delta=-40 → top=260
    expect(top).toBe(260);
    raf.frames(1); // delta=0 → 稳定 1
    // 稳定 1 帧尚未收口
    expect(raf.pending()).toBe(1);
    raf.frames(1); // 稳定 2 → 收口
    expect(raf.pending()).toBe(0);
    expect(top).toBe(260);
  });

  it('el 离开 DOM 提前终止(不挂帧队列)', () => {
    const el = document.createElement('div');
    let connected = true;
    Object.defineProperty(el, 'isConnected', { get: () => connected, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: 0, writable: true, configurable: true });
    rAFConverge(el, () => 999, () => undefined, 1);
    connected = false;
    raf.frames(1);
    // 离 DOM 后不再排帧
    expect(raf.pending()).toBe(0);
  });
});

describe('chaseScrollBottom(贴底追平·特征化)', () => {
  let raf: ReturnType<typeof installRafStub>;
  beforeEach(() => {
    raf = installRafStub();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('水合增长面:滚动中 scrollHeight 持续增长仍追到真底(单发 scrollTo 旧实现此例即偏短)', () => {
    const s = fakeScroller(800, 100);
    chaseScrollBottom(s.el);
    // 帧间水合:前 2 帧跑完各涨 500(cv:auto 离屏条目陆续水合),其后定态收敛
    for (let i = 0; i < 8; i++) {
      raf.frames(1);
      if (i === 0 || i === 1) s.grow(500);
    }
    // 终态=scrollHeight(1800)−client(100) 真贴底
    expect(s.top()).toBe(1700);
    expect(raf.pending()).toBe(0);
  });

  it('150 帧封顶:永不收敛的目标也终止(不无限挂帧)', () => {
    const el = document.createElement('div');
    let tick = 0;
    Object.defineProperty(el, 'isConnected', { value: true, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { get: () => 10000 + tick++ * 10, configurable: true });
    Object.defineProperty(el, 'clientHeight', { get: () => 100, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: 0, writable: true, configurable: true });
    chaseScrollBottom(el);
    raf.frames(1000);
    // 帧预算耗尽即停
    expect(raf.pending()).toBe(0);
  });
});
