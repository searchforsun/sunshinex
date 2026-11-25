import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { EDITABLE_GROUPS, SHORTCUT_DEFS, STATIC_SHORTCUT_GROUPS, comboAllowed, comboParts, eventToCombo } from '../shortcuts/registry';
import { resetAllShortcuts, resetShortcut, resolveShortcutKeys, setShortcutCapturing, setShortcutOverride, shortcutConflict, useShortcutOverrides } from '../shortcuts/store';
import type { ShortcutId } from '../shortcuts/registry';

/**
 * 设置·快捷键页(2026-11-25 注册表轮,原「静态文档面,无读写」退役):前两组=可编辑动作
 * (数据源 shortcuts 注册表 SHORTCUT_DEFS,与集中分发器/侧栏角标同源零漂移)——点键位格
 * 进入录制态,按新组合即改(与默认同值=回落档删除;Backspace 清除=显示「无」;Esc 取消;
 * 冲突行内红字提示且不落档),行尾 ↺ 单条重置、有改键时页头「全部恢复默认」。
 * 其余组=静态说明(STATIC_SHORTCUT_GROUPS:组件局部键面不可改键;输入框微导航已按调研裁定
 * 精简不上面板)。键位以 <kbd> 徽标渲染(样式 .sx-kbd),描述双语 t()。
 */

function shortcutLabel(id: ShortcutId): string {
  const def = SHORTCUT_DEFS.find((d) => d.id === id);
  return def !== undefined ? t(def.label.en, def.label.zh) : id;
}

export function ShortcutsPane(): JSX.Element {
  /** 覆盖档快照(重置钮显隐;subscribeShortcuts 驱动重渲) */
  const overrides = useShortcutOverrides();
  /** 录制态:recId=正在改键的动作;recConflict=该键已被谁占用(行内红字,不落档) */
  const [recId, setRecId] = useState<ShortcutId | null>(null);
  const [recConflict, setRecConflict] = useState<ShortcutId | null>(null);

  /** 录制器(window keydown 捕获态;capture 旗令集中分发器让位):Esc 取消、Backspace 清除、
   *  纯修饰键等待主键、裸键不收(准入面 registry.comboAllowed)、冲突停留提示、合法即落档 */
  useEffect(() => {
    if (recId === null) return;
    setShortcutCapturing(true);
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        setRecId(null);
        setRecConflict(null);
        return;
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.metaKey) {
        setShortcutOverride(recId, ''); // 清除绑定(显示「无」)
        setRecId(null);
        setRecConflict(null);
        return;
      }
      const combo = eventToCombo(e);
      if (combo === null) return; // 纯修饰键:等待主键
      if (!comboAllowed(combo)) {
        setRecConflict(null); // 裸键不收:留在录制态,提示文案已注明需含 Ctrl/Alt
        return;
      }
      const other = shortcutConflict(combo, recId);
      if (other !== null) {
        setRecConflict(other);
        return;
      }
      setShortcutOverride(recId, combo);
      setRecId(null);
      setRecConflict(null);
    };
    window.addEventListener('keydown', onKey, true);
    // 行外任意 mousedown 即退出录制(2026-11-25 用户裁定「点其他地方直接退出,符合直觉」);
    // 本行编辑钮内的 mousedown 放行——再点同行=取消,交由 click 链自理(外点关闭同 D49 各弹层惯例)
    const onDown = (e: MouseEvent): void => {
      const inEditor = e.target instanceof Element ? e.target.closest('.sx-shortcut-edit.recording') : null;
      if (inEditor !== null) return;
      setRecId(null);
      setRecConflict(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
      setShortcutCapturing(false);
    };
  }, [recId]);

  const anyOverride = Object.keys(overrides).length > 0;

  return (
    <section className="sx-settings-form sx-settings-body" aria-label="settings pane shortcuts">
      {/* 与 SettingsForm 各面板同款 <h2> 标题(导航项文字一致),对齐设置页版式 */}
      <h2>{t('Shortcuts', '快捷键')}</h2>
      <div className="sx-shortcuts-page">
        {/* 2026-11-06 用户裁定:页首说明文字撤下(其他设置页无此形态);分组改深色背景块卡。
            2026-11-25 注册表轮:有改键时页头出「全部恢复默认」 */}
        {anyOverride && (
          <div className="sx-shortcuts-toolbar">
            <button
              type="button"
              className="sx-shortcut-resetall"
              onClick={() => {
                setRecId(null);
                setRecConflict(null);
                resetAllShortcuts();
              }}
            >
              {t('Reset all to defaults', '全部恢复默认')}
            </button>
          </div>
        )}
        {/* 可编辑动作组(注册表驱动):键位格=录制触发钮;行尾 ↺ 仅改过键的行渲染 */}
        {EDITABLE_GROUPS.map((g) => (
          <div key={g.id} className="sx-shortcuts-group">
            <h3 className="sx-shortcuts-title">{t(g.title.en, g.title.zh)}</h3>
            <div className="sx-shortcuts-rows">
              {SHORTCUT_DEFS.filter((d) => d.group === g.id).map((def) => {
                const recording = recId === def.id;
                const overridden = overrides[def.id] !== undefined;
                const cur = resolveShortcutKeys(def.id);
                return (
                  <div key={def.id} className="sx-shortcut-row" data-setting-key={`shortcut:${def.id}`}>
                    <button
                      type="button"
                      className={`sx-shortcut-edit${recording ? (recConflict !== null ? ' recording conflict' : ' recording') : ''}`}
                      data-tip={recording ? undefined : t('Click to rebind', '点击修改')}
                      aria-label={`${def.id} keybinding`}
                      onClick={() => {
                        if (recording) {
                          // 再点同行=取消录制(提示文案已极简,不写 Esc/Backspace,故给个显式退出)
                          setRecId(null);
                          setRecConflict(null);
                          return;
                        }
                        setRecConflict(null);
                        setRecId(def.id);
                      }}
                    >
                      {recording ? (
                        <span className={`sx-shortcut-rec-hint${recConflict !== null ? ' conflict' : ''}`}>
                          {recConflict !== null
                            ? `${t('Already used by ', '与「')}${shortcutLabel(recConflict)}${t('', '」冲突')}`
                            : t('Press new keys', '按下新组合键')}
                        </span>
                      ) : cur === null ? (
                        <kbd className="sx-kbd sx-kbd-none">{t('None', '无')}</kbd>
                      ) : (
                        comboParts(cur).map((chip, i) => (
                          <kbd key={i} className="sx-kbd">
                            {chip}
                          </kbd>
                        ))
                      )}
                    </button>
                    <span className="sx-shortcut-desc">{t(def.label.en, def.label.zh)}</span>
                    {overridden && !recording ? (
                      <button
                        type="button"
                        className="sx-shortcut-reset"
                        data-tip={t('Reset to default', '恢复默认')}
                        aria-label={t('Reset to default', '恢复默认')}
                        onClick={() => resetShortcut(def.id)}
                      >
                        ↺
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {/* 静态说明组(组件局部键面,不可改键;行锚 shortcut:static:<组>:<行> 与设置搜索同源) */}
        {STATIC_SHORTCUT_GROUPS.map((g, gi) => (
          <div key={g.id} className="sx-shortcuts-group">
            <h3 className="sx-shortcuts-title">{t(g.title.en, g.title.zh)}</h3>
            <div className="sx-shortcuts-rows">
              {g.rows.map((r, ri) => (
                <div key={ri} className="sx-shortcut-row" data-setting-key={`shortcut:static:${gi}:${ri}`}>
                  <span className="sx-shortcut-keys">
                    {r.keys.map((k) => (
                      <kbd key={k} className="sx-kbd">
                        {k}
                      </kbd>
                    ))}
                  </span>
                  <span className="sx-shortcut-desc">{t(r.desc.en, r.desc.zh)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
