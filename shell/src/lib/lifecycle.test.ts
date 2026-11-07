import { describe, expect, expectTypeOf, it } from 'vitest';
import { pickTrayRecents, QUIT_STEPS, resolveUiLang, resolveUiLangFromSetting, SHOW_ACCELERATOR, shouldHideOnClose, TRAY_RECENT_LIMIT, trayLabel, trayMenu } from './lifecycle';
import type { TrayRecent } from './lifecycle';

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

const recent = (journalId: string, updatedAt: number, label = journalId, root = '/w/a'): TrayRecent => ({ journalId, root, label, updatedAt });

describe('trayMenu(2026-11-07 三组+细线)', () => {
  it('zh 态无最近会话:会话组连同分隔线省略,余两组', () => {
    expect(trayMenu('zh')).toEqual([
      { type: 'action', label: '新对话', action: { kind: 'new-chat' } },
      { type: 'action', label: '设置', action: { kind: 'settings' } },
      { type: 'action', label: '快捷键', action: { kind: 'shortcuts' } },
      { type: 'separator' },
      { type: 'show', label: '打开 Sunshinex', accelerator: SHOW_ACCELERATOR },
      { type: 'quit', label: '退出' },
    ]);
  });

  it('有最近会话:首组为会话(开会话动作带 root/journalId),组间分隔', () => {
    const items = trayMenu('en', [recent('j1', 2, 'Fix login', '/w/p'), recent('j2', 1, 'Refactor')]);
    expect(items.map((i) => (i.type === 'separator' ? '—' : i.label))).toEqual([
      'Fix login', 'Refactor', '—', 'New chat', 'Settings', 'Keyboard shortcuts', '—', 'Open Sunshinex', 'Quit',
    ]);
    expect(items[0]).toEqual({ type: 'action', label: 'Fix login', action: { kind: 'open-session', root: '/w/p', journalId: 'j1' } });
  });
});

describe('pickTrayRecents', () => {
  it('跨工作区按活跃度降序取前 5,同 journal 去重,不足不补', () => {
    const rows = [recent('a', 1), recent('b', 7), recent('c', 3), recent('b', 7), recent('d', 9), recent('e', 5), recent('f', 2)];
    expect(pickTrayRecents(rows).map((r) => r.journalId)).toEqual(['d', 'b', 'e', 'c', 'f']);
    expect(pickTrayRecents([recent('x', 1)])).toHaveLength(1);
    expect(TRAY_RECENT_LIMIT).toBe(5);
  });
});

describe('trayLabel', () => {
  it('单行化+超长截断+& 转义(防 Windows 助记符)', () => {
    expect(trayLabel('  修复\n登录   bug ')).toBe('修复 登录 bug');
    expect(trayLabel('a'.repeat(40))).toBe(`${'a'.repeat(28)}…`);
    expect(trayLabel('A & B')).toBe('A && B');
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
