import { describe, expect, expectTypeOf, it } from 'vitest';
import { QUIT_STEPS, shouldHideOnClose, trayMenu } from './lifecycle';

describe('shouldHideOnClose', () => {
  it('非退出态关窗 → 驻留:隐藏而非真关闭', () => {
    expect(shouldHideOnClose(false)).toBe(true);
  });

  it('退出流程中 → 放行真关闭:不再隐藏', () => {
    expect(shouldHideOnClose(true)).toBe(false);
  });
});

describe('trayMenu', () => {
  it('常驻态:显示/退出两项全 enabled,label 逐字', () => {
    expect(trayMenu(false)).toEqual([
      { id: 'show', label: '显示 sunshinex', enabled: true },
      { id: 'quit', label: '退出', enabled: true },
    ]);
  });

  it('收口中:label 原样,enabled 全 false(防退出流程中重复触发)', () => {
    expect(trayMenu(true)).toEqual([
      { id: 'show', label: '显示 sunshinex', enabled: false },
      { id: 'quit', label: '退出', enabled: false },
    ]);
  });
});

describe('QUIT_STEPS', () => {
  it('内容与顺序:先关 daemon,后 app 退出', () => {
    expect([...QUIT_STEPS]).toEqual(['daemon-close', 'app-quit']);
    expect(QUIT_STEPS[0]).toBe('daemon-close');
    expect(QUIT_STEPS[1]).toBe('app-quit');
  });

  it('readonly 面:as const 元组类型不可变', () => {
    expectTypeOf(QUIT_STEPS).toEqualTypeOf<
      readonly ['daemon-close', 'app-quit']
    >();
  });
});
