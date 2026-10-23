import { describe, expect, expectTypeOf, it } from 'vitest';
import { QUIT_STEPS, resolveUiLang, resolveUiLangFromSetting, shouldHideOnClose, trayMenu } from './lifecycle';

describe('shouldHideOnClose', () => {
  it('非退出态关窗 → 驻留:隐藏而非真关闭', () => {
    expect(shouldHideOnClose(false)).toBe(true);
  });

  it('退出流程中 → 放行真关闭:不再隐藏', () => {
    expect(shouldHideOnClose(true)).toBe(false);
  });
});

describe('resolveUiLang', () => {
  it('locale 归一:zh 前缀系全归 zh,余者 en 兜底', () => {
    expect(resolveUiLang('zh-CN')).toBe('zh');
    expect(resolveUiLang('zh_TW')).toBe('zh');
    expect(resolveUiLang('zh')).toBe('zh');
    expect(resolveUiLang('en-US')).toBe('en');
    expect(resolveUiLang('de-DE')).toBe('en');
    expect(resolveUiLang('')).toBe('en');
  });
});

describe('resolveUiLangFromSetting(2026-10-23 托盘菜单跟应用语言设置)', () => {
  it('SUNSHINEX_LANGUAGE 槽值:zh/en 前缀归一,大小写与首尾空白容忍', () => {
    expect(resolveUiLangFromSetting('zh')).toBe('zh');
    expect(resolveUiLangFromSetting('en')).toBe('en');
    expect(resolveUiLangFromSetting('ZH')).toBe('zh');
    expect(resolveUiLangFromSetting(' en ')).toBe('en');
    expect(resolveUiLangFromSetting('zh-CN')).toBe('zh');
  });

  it('未设/空串/异形值 → undefined(调用方回落 OS locale),不误判 en', () => {
    expect(resolveUiLangFromSetting(undefined)).toBeUndefined();
    expect(resolveUiLangFromSetting('')).toBeUndefined();
    expect(resolveUiLangFromSetting('  ')).toBeUndefined();
    expect(resolveUiLangFromSetting('fr')).toBeUndefined();
    expect(resolveUiLangFromSetting('jp')).toBeUndefined();
  });
});

describe('trayMenu', () => {
  it('zh 态:显示/退出两项全 enabled,label 逐字', () => {
    expect(trayMenu(false, 'zh')).toEqual([
      { id: 'show', label: '显示 sunshinex', enabled: true },
      { id: 'quit', label: '退出', enabled: true },
    ]);
  });

  it('en 态:英文标签(纪律⑤ 外观双语)', () => {
    expect(trayMenu(false, 'en')).toEqual([
      { id: 'show', label: 'Show sunshinex', enabled: true },
      { id: 'quit', label: 'Quit', enabled: true },
    ]);
  });

  it('收口中:label 原样,enabled 全 false(防退出流程中重复触发)', () => {
    expect(trayMenu(true, 'zh')).toEqual([
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
