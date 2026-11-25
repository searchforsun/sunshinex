import { beforeEach, describe, expect, it } from 'vitest';
import { SHORTCUT_DEFS, comboAllowed, comboParts, eventToCombo } from './registry';
import { installShortcutDispatcher, onShortcut, setShortcutsSuspended } from './dispatch';
import {
  applyShortcutOverridesRemote,
  resetAllShortcuts,
  resetShortcut,
  resolveShortcutKeys,
  setShortcutCapturing,
  setShortcutOverride,
  shortcutConflict,
} from './store';

/**
 * 快捷键注册表轮单测(2026-11-25 调研轮):键串规范化/展示切片/录制准入、覆盖档
 * (默认→覆盖→清除→重置 + 冲突检测 + 远端回灌)、集中分发器(匹配拦截/未消费放行/
 * 挂起白名单/录制让位/改键即时生效)。
 */

/** jsdom KeyboardEvent 助手(cancelable 必显式:缺省 false 时 preventDefault 不落 defaultPrevented) */
const kd = (key: string, init: KeyboardEventInit = {}): KeyboardEvent =>
  new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });

describe('registry 键串', () => {
  it('eventToCombo 规范化(修饰序固定;单字符大写;纯修饰回 null)', () => {
    expect(eventToCombo(kd('O', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+O');
    expect(eventToCombo(kd('ArrowLeft', { altKey: true }))).toBe('Alt+ArrowLeft');
    expect(eventToCombo(kd(',', { ctrlKey: true }))).toBe('Ctrl+,');
    expect(eventToCombo(kd('/', { ctrlKey: true }))).toBe('Ctrl+/');
    expect(eventToCombo(kd('j', { ctrlKey: true }))).toBe('Ctrl+J');
    expect(eventToCombo(kd('Control', { ctrlKey: true }))).toBeNull();
    expect(eventToCombo(kd('Shift'))).toBeNull();
  });

  it('comboParts 展示切片(箭头/Esc 字形;主键恰为 + 时空尾解析)', () => {
    expect(comboParts('Ctrl+Alt+ArrowRight')).toEqual(['Ctrl', 'Alt', '→']);
    expect(comboParts('Ctrl+ArrowLeft')).toEqual(['Ctrl', '←']);
    expect(comboParts('Alt+Escape')).toEqual(['Alt', 'Esc']);
    expect(comboParts('Ctrl+,')).toEqual(['Ctrl', ',']);
    expect(comboParts('Ctrl++')).toEqual(['Ctrl', '+']);
    expect(comboParts('F4')).toEqual(['F4']);
  });

  it('comboAllowed 录制准入(拒裸键;收修饰组合与 F1-F12)', () => {
    expect(comboAllowed('A')).toBe(false);
    expect(comboAllowed('ArrowLeft')).toBe(false);
    expect(comboAllowed('Shift+A')).toBe(false);
    expect(comboAllowed('Ctrl+K')).toBe(true);
    expect(comboAllowed('Alt+T')).toBe(true);
    expect(comboAllowed('F4')).toBe(true);
  });

  it('默认键位两两不冲突(注册表静态自洽)', () => {
    const seen = new Set<string>();
    for (const d of SHORTCUT_DEFS) {
      expect(seen.has(d.keys)).toBe(false);
      seen.add(d.keys);
    }
  });
});

describe('store 覆盖档', () => {
  beforeEach(() => {
    resetAllShortcuts();
  });

  it('resolve:默认 → 覆盖 → 清除(无)→ 重置回默认', () => {
    expect(resolveShortcutKeys('app.search')).toBe('Ctrl+K');
    setShortcutOverride('app.search', 'Ctrl+J');
    expect(resolveShortcutKeys('app.search')).toBe('Ctrl+J');
    setShortcutOverride('app.search', '');
    expect(resolveShortcutKeys('app.search')).toBeNull();
    resetShortcut('app.search');
    expect(resolveShortcutKeys('app.search')).toBe('Ctrl+K');
  });

  it('同值覆盖不落档(=默认即删项回落)', () => {
    setShortcutOverride('app.search', 'Ctrl+K');
    expect(localStorage.getItem('sunshinex.shortcuts')).toBe('{}');
  });

  it('冲突检测(自身豁免)', () => {
    setShortcutOverride('app.search', 'Ctrl+J');
    expect(shortcutConflict('Ctrl+J')).toBe('app.search');
    expect(shortcutConflict('Ctrl+J', 'app.search')).toBeNull();
    expect(shortcutConflict('Ctrl+不存在的键')).toBeNull();
  });

  it('远端回灌整表替换;坏档忽略(内存态原样)', () => {
    applyShortcutOverridesRemote('{"tabs.close":"Ctrl+Q"}');
    expect(resolveShortcutKeys('tabs.close')).toBe('Ctrl+Q');
    applyShortcutOverridesRemote('not-json');
    expect(resolveShortcutKeys('tabs.close')).toBe('Ctrl+Q');
    applyShortcutOverridesRemote('{"not-an-action":"Ctrl+Q"}');
    expect(resolveShortcutKeys('tabs.close')).toBe('Alt+W');
  });
});

describe('dispatch 集中分发器', () => {
  it('匹配→动作→消费才拦截;无订阅不拦', () => {
    const uninstall = installShortcutDispatcher();
    let fired = 0;
    const off = onShortcut('tabs.close', () => {
      fired += 1;
      return true;
    });
    const e = kd('W', { altKey: true });
    window.dispatchEvent(e);
    expect(fired).toBe(1);
    expect(e.defaultPrevented).toBe(true);
    off();
    const e2 = kd('W', { altKey: true });
    window.dispatchEvent(e2);
    expect(e2.defaultPrevented).toBe(false);
    uninstall();
  });

  it('处理器回 false 放行(消费否决面)', () => {
    const uninstall = installShortcutDispatcher();
    const off = onShortcut('tabs.close', () => false);
    const e = kd('W', { altKey: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    off();
    uninstall();
  });

  it('覆盖档改键即时生效(新键命中,旧键失配放行)', () => {
    const uninstall = installShortcutDispatcher();
    setShortcutOverride('app.search', 'Ctrl+J');
    let fired = 0;
    const off = onShortcut('app.search', () => {
      fired += 1;
      return true;
    });
    window.dispatchEvent(kd('j', { ctrlKey: true }));
    expect(fired).toBe(1);
    window.dispatchEvent(kd('k', { ctrlKey: true }));
    expect(fired).toBe(1);
    off();
    setShortcutOverride('app.search', 'Ctrl+K');
    uninstall();
  });

  it('挂起面:覆盖层全屏期间暂停,白名单(app.shortcuts)豁免', () => {
    const uninstall = installShortcutDispatcher();
    setShortcutsSuspended(true);
    let n = 0;
    const offS = onShortcut('app.settings', () => {
      n += 1;
      return true;
    });
    const offH = onShortcut('app.shortcuts', () => {
      n += 10;
      return true;
    });
    window.dispatchEvent(kd(',', { ctrlKey: true }));
    window.dispatchEvent(kd('/', { ctrlKey: true }));
    expect(n).toBe(10);
    setShortcutsSuspended(false);
    window.dispatchEvent(kd(',', { ctrlKey: true }));
    expect(n).toBe(11);
    offS();
    offH();
    uninstall();
  });

  it('录制态让位(分发器见旗不匹配)', () => {
    const uninstall = installShortcutDispatcher();
    setShortcutCapturing(true);
    let n = 0;
    const off = onShortcut('app.search', () => {
      n += 1;
      return true;
    });
    window.dispatchEvent(kd('k', { ctrlKey: true }));
    expect(n).toBe(0);
    setShortcutCapturing(false);
    window.dispatchEvent(kd('k', { ctrlKey: true }));
    expect(n).toBe(1);
    off();
    uninstall();
  });
});
