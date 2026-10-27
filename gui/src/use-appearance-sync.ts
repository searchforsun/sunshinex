import { useEffect, useState } from 'react';
import type { Connection } from './connection';
import { parseLanguage, setLanguage } from './i18n';
import { applyFontPreset, type FontPreset } from './font-preset';
import { applyTheme, type ThemePref } from './theme';
import { applyZoom, type UiZoom } from './ui-zoom';
import { initUiPrefSync } from './ui-pref-sync';

/**
 * 外观偏好同步 hook(2026-10-27 技术债轮 D53 批E 自 App.tsx 外提,行为零变化):
 * 连接装配后两件一次性同步——①GUI chrome 双语语言源(daemon settings language 键,t 为
 * 模块级非响应式,tick 驱动宿主重渲染使静止页面即时翻语言);②公共持久化偏好上收(2026-10-24
 * 用户裁定「能放到公共持久化的务必放」:连接就绪即拉 /app/gui-state 公共档覆盖本地
 * ui-zoom/theme/font-preset,此后变更经 notifyUiPref 去抖双写)。
 */
export function useAppearanceSync(connInstance: Connection | null): void {
  /** G14.104 语言切换重渲染触发(t 为模块级非响应式) */
  const [, setLangTick] = useState(0);
  /** GUI chrome 双语(G10-C3c):语言源 = daemon settings language 键,连接装配即同步 */
  useEffect(() => {
    if (connInstance === null) return;
    connInstance.settings().then(
      (view) => {
        const raw = view.keys.find((k) => k.key === 'language')?.value ?? undefined;
        if (raw !== undefined) setLanguage(parseLanguage(raw)); // 未设置不覆盖(缺省 zh 由 i18n 模块承载;测试钉 en 由 setup 承载)
        setLangTick((v) => v + 1); // G14.104 语言是模块级非响应式——补一次重渲染,静止页面即时翻语言
      },
      () => {},
    );
  }, [connInstance]);

  /** 公共持久化偏好上收(2026-10-24 用户裁定「能放到公共持久化的务必放」):连接就绪即拉
   *  /app/gui-state 公共档覆盖本地(ui-zoom/theme),此后变更经 notifyUiPref 去抖双写 */
  useEffect(() => {
    if (connInstance === null) return;
    initUiPrefSync(connInstance, {
      zoom: (v) => applyZoom(v as UiZoom),
      theme: (v) => applyTheme(v as ThemePref),
      fontPreset: (v) => applyFontPreset(v as FontPreset),
    });
  }, [connInstance]);
}
