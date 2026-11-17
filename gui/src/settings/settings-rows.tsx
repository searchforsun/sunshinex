import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Select } from './controls';
import { Switch } from './components';
import { t } from '../i18n';
import { applyTheme, currentTheme, readThemePref, watchSystemTheme, watchThemeChange } from '../theme';
import type { ThemePref } from '../theme';
import { applyZoom, readZoomPref } from '../ui-zoom';
import type { UiZoom } from '../ui-zoom';
import { applyFontPreset, FONT_PRESET_CHOICES, presetVars, readFontPreset } from '../font-preset';
import type { FontPreset } from '../font-preset';
import { palettesFor, readPalettePref, setPalettePref } from '../palette';
import { applyCodeFontSize, applyUiFontSize, CODE_FONT_CHOICES, readCodeFontSize, readUiFontSize, UI_FONT_CHOICES } from '../font-size';
import { applyUiMode, useUiMode } from '../ui-mode';
import type { UiMode } from '../ui-mode';
import { applyDarkBubbles, applyDarkCode, readDarkBubbles, readDarkCode } from '../dark-surfaces';
import { applyUsageStats, readUsageStats } from '../usage-stats';
import { applyArtifactCards, readArtifactCards } from '../artifact-cards';
import { applyConciseMode, readConciseMode } from '../concise-mode';
import { applyDeveloperMode, readDeveloperMode } from '../developer-mode';
import { applyChangeCards, readChangeCards } from '../change-cards';
import { applySessionInfoCards, readSessionInfoCards } from '../session-info-cards';
import type { Palette } from '../palette';

/** 外观特例行族(SettingsForm 外提,D62 批J):外观/配色/放缩/字体预设/字号/暗色面/用量统计/
 *  简洁模式/界面模式/开发者模式十二枚行组件+配色剪影+选中勾——GUI 本地偏好行,非 settings 键;
 *  各行读偏好+生效+持久化通路自包含,主表单(SettingsForm)按组开关旗标装配。 */

/** 卡片选中勾(配色/字体预设卡名行最右):与下拉选项勾同一符号与 accent 色(.sx-dd-opt-check),全项目选中态一致 */
const SELECTED_CHECK = <span className="sx-dd-opt-check sx-card-check" aria-hidden="true">✓</span>;

/** 字体预设行(2026-10-26 用户裁定):四预设卡片,每卡内嵌迷你实时预览(正文行/工具行/代码行
 *  按该预设的字号行高内联渲染),点击即全局生效并持久化(theme/ui-zoom 同通路)。GUI 本地偏好,
 *  非 settings 键。名单单源在 font-preset.ts FONT_PRESET_CHOICES(D55② 收敛,加预设只改彼处) */

function FontRow(): JSX.Element {
  const [pref, setPref] = useState<FontPreset>(readFontPreset);
  return (
    <div className="sx-setting-row sx-font-row">
      <div className="sx-setting-main">
        <div className="sx-setting-title">
          <span className="sx-setting-label">{t('Font preset', '字体预设')}</span>
        </div>
        <p className="sx-setting-desc">{t('Body / thinking / tool / code typography — click a preset to apply', '正文/思考/工具/代码的字体排版——点击卡片即生效')}</p>
      </div>
      <div className="sx-setting-ctl sx-font-ctl">
        {FONT_PRESET_CHOICES.map((p) => {
          const v = presetVars(p.v);
          return (
            <button
              key={p.v}
              type="button"
              className={`sx-font-preset-card${pref === p.v ? ' active' : ''}`}
              aria-pressed={pref === p.v}
              aria-label={t(p.l.en, p.l.zh)}
              onClick={() => {
                setPref(p.v);
                applyFontPreset(p.v);
              }}
            >
              <span className="sx-font-preset-name">
                {t(p.l.en, p.l.zh)}
                {pref === p.v && SELECTED_CHECK}
              </span>
              <span
                className="sx-font-pv"
                style={{ lineHeight: v['--f-body-lh'] ?? '1.6', fontSize: v['--f-base-size'], fontFamily: v['--font-ui'] }}
              >
                {t('Body text reads here. 正文预览。', 'Body text reads here. 正文预览。')}
              </span>
              <span className="sx-font-pv-tool" style={{ fontSize: v['--f-tool'] ?? '14px', lineHeight: v['--f-tool-lh'] ?? 'normal' }}>
                <span style={v['--font-mono'] !== undefined ? { fontFamily: v['--font-mono'] } : undefined}>run pnpm test --filter gui</span>
              </span>
              <span
                className="sx-font-pv-code"
                style={{
                  fontSize: 'var(--f-code)',
                  // 预览=md 代码块真实口径(2026-11-08 对齐:行距 1.5/内距 0.6em 1em 为用户裁定钉值,
                  // 不随预设 --f-code-lh/pad 变——那两键现只服务 diff 面与 raw 编辑器)
                  lineHeight: 1.5,
                  padding: '0.6em 1em',
                  fontFamily: v['--font-mono'],
                }}
              >
                {'const x = 1;'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 配色剪影:迷你应用界面(侧栏/对话主面/用户气泡/正文与链接/代码井/输入框+强调色按钮),
 *  色值直取配色表令牌——与生效界面同源,剪影即所见 */
function PaletteSilhouette({ p }: { p: Palette }): JSX.Element {
  const c = p.tokens;
  const vars = {
    '--pv-under': c.surfaceUnder,
    '--pv-surface': c.surface,
    '--pv-elev': c.surfaceElevated,
    '--pv-code': c.surfaceCode,
    '--pv-fg': c.fg,
    '--pv-accent': c.accent,
  } as CSSProperties;
  return (
    <span className="sx-pal-sil" style={vars} aria-hidden="true">
      <span className="sx-pal-side">
        <i className="on" />
        <i />
        <i />
        <i />
      </span>
      <span className="sx-pal-main">
        <span className="sx-pal-bubble" />
        <span className="sx-pal-line" />
        <span className="sx-pal-line sx-pal-line-link">
          <i />
          <b />
        </span>
        <span className="sx-pal-code">
          <i />
          <i />
        </span>
        <span className="sx-pal-composer">
          <b />
        </span>
      </span>
    </span>
  );
}

/** 配色主题行(2026-11-07 用户裁定):亮/暗各四套,只列当前生效模式那一组(外观切换即换组,
 *  system 跟随系统同经 data-theme 观察);点击即生效,亮暗偏好分记。GUI 本地偏好,非 settings 键 */
function PaletteRow(): JSX.Element {
  const [, setTick] = useState(0);
  useEffect(() => watchThemeChange(() => setTick((n) => n + 1)), []);
  const mode = currentTheme();
  const active = readPalettePref(mode);
  return (
    <div className="sx-setting-row sx-palette-row">
      <div className="sx-setting-main">
        <div className="sx-setting-title">
          <span className="sx-setting-label">{t('Color theme', '配色主题')}</span>
        </div>
        <p className="sx-setting-desc">
          {mode === 'light'
            ? t('Colors for light mode — click a theme to apply', '亮色模式下的界面配色——点击即生效')
            : t('Colors for dark mode — click a theme to apply', '暗色模式下的界面配色——点击即生效')}
        </p>
      </div>
      <div className="sx-setting-ctl sx-palette-ctl" role="radiogroup" aria-label={t('Color theme', '配色主题')}>
        {palettesFor(mode).map((p) => {
          const on = p.id === active;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`sx-palette-card${on ? ' active' : ''}`}
              onClick={() => {
                setPalettePref(mode, p.id);
                setTick((n) => n + 1);
              }}
            >
              <PaletteSilhouette p={p} />
              <span className="sx-palette-name">
                {t(p.name.en, p.name.zh)}
                {on && SELECTED_CHECK}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 外观主题行(GUI 本地偏好,非 settings 键;G9 三态持久,system 跟随系统) */
function ThemeRow(): JSX.Element {
  const [pref, setPref] = useState<ThemePref>(readThemePref);
  useEffect(() => watchSystemTheme(pref), [pref]);
  return (
    <div className="sx-setting-row">
      <div className="sx-setting-main">
        <div className="sx-setting-title">
          <span className="sx-setting-label">{t('Appearance', '外观')}</span>
        </div>
        <p className="sx-setting-desc">{t('Color scheme of the app interface', '应用界面的亮暗配色')}</p>
      </div>
      <div className="sx-setting-ctl">
      <Select
        ariaLabel="theme"
        value={pref}
        options={[
          { v: 'system', l: t('System', '跟随系统') },
          { v: 'light', l: t('Light', '亮色') },
          { v: 'dark', l: t('Dark', '暗色') },
        ]}
        onChange={(v) => {
          setPref(v as ThemePref);
          applyTheme(v as ThemePref);
        }}
      />
      </div>
    </div>
  );
}

/** 界面放缩行(GUI 本地偏好;根 zoom 全域等比——字体/图标/布局一体,见 ui-zoom.ts) */
function ZoomRow(): JSX.Element {
  const [pref, setPref] = useState<UiZoom>(readZoomPref);
  return (
    <div className="sx-setting-row">
      <div className="sx-setting-main">
        <div className="sx-setting-title">
          <span className="sx-setting-label">{t('UI zoom', '界面放缩')}</span>
        </div>
        <p className="sx-setting-desc">{t('Global zoom for fonts / icons / layout', '全局放缩字体/图标/布局')}</p>
      </div>
      <div className="sx-setting-ctl">
        <Select
          ariaLabel="ui zoom"
          value={pref}
          options={[
            { v: '0.9', l: '90%' },
            { v: '1', l: '100%' },
            { v: '1.1', l: '110%' },
            { v: '1.25', l: '125%' },
            { v: '1.5', l: '150%' },
          ]}
          onChange={(v) => {
            setPref(v as UiZoom);
            applyZoom(v as UiZoom);
          }}
        />
      </div>
    </div>
  );
}

/** 字号行(2026-11-07 用户裁定外观两项,对标 Codex):界面字号只缩文字(图标/布局不动)、代码字号管
 *  代码块/文件预览/差异视图;GUI 本地偏好,非 settings 键(font-size.ts 落根) */
function FontSizeRow({ label, desc, aria, choices, read, apply }: {
  label: string;
  desc: string;
  aria: string;
  choices: readonly number[];
  read: () => number;
  apply: (n: number) => void;
}): JSX.Element {
  const [v, setV] = useState<number>(read);
  return (
    <div className="sx-setting-row">
      <div className="sx-setting-main">
        <div className="sx-setting-title">
          <span className="sx-setting-label">{label}</span>
        </div>
        <p className="sx-setting-desc">{desc}</p>
      </div>
      <div className="sx-setting-ctl">
        <Select
          ariaLabel={aria}
          value={String(v)}
          options={choices.map((n) => ({ v: String(n), l: `${n}px` }))}
          onChange={(s) => {
            const n = Number(s);
            setV(n);
            apply(n);
          }}
        />
      </div>
    </div>
  );
}

/** 暗色面开关行(2026-11-12 用户裁定「暗色气泡/暗色代码」;2026-11-17 用户裁定「布尔行换胶囊
 *  开关,与下拉框左对齐」):开/关 select 退役→Switch 统一开关(sx-switch 令牌);控件列左对齐
 *  (sx-setting-ctl 左缘=下拉框同位);dark-surfaces.ts 落根 data 属性,UI 偏好双写通路 */
function DarkSurfaceRow({ label, desc, aria, read, apply }: {
  label: string;
  desc: string;
  aria: string;
  read: () => boolean;
  apply: (on: boolean) => void;
}): JSX.Element {
  const [on, setOn] = useState<boolean>(read);
  return (
    <div className="sx-setting-row">
      <div className="sx-setting-main">
        <div className="sx-setting-title">
          <span className="sx-setting-label">{label}</span>
        </div>
        <p className="sx-setting-desc">{desc}</p>
      </div>
      <div className="sx-setting-ctl">
        <Switch
          on={on}
          onToggle={() => {
            setOn(!on);
            apply(!on);
          }}
          ariaLabel={aria}
        />
      </div>
    </div>
  );
}

const DarkBubblesRow = (): JSX.Element => (
  <DarkSurfaceRow
    label={t('Dark bubbles', '暗色气泡')}
    desc={t('In light theme, user bubbles use dark-theme colors.', '亮色模式下，用户气泡使用暗色主题的颜色。')}
    aria="dark bubbles"
    read={readDarkBubbles}
    apply={applyDarkBubbles}
  />
);

const DarkCodeRow = (): JSX.Element => (
  <DarkSurfaceRow
    label={t('Dark code', '暗色代码')}
    desc={t('In light theme, code blocks, file previews, and tool-row diff previews use dark-theme colors.', '亮色模式下，代码块、文件预览和工具行 diff 预览使用暗色主题的颜色。')}
    aria="dark code"
    read={readDarkCode}
    apply={applyDarkCode}
  />
);

/** 用量统计行(2026-11-14 用户裁定「设置页加开关,gui 控制显示步数轮次和 tokens」):
 *  关=上下文弹层只留百分比(首行总量恒显,轮次/步数行隐)、轮尾与运行状态行隐步数+tokens
 *  (时刻保留)、会话悬停卡/tooltip 隐轮次步数;主对话与子智能体面同口径 */
const UsageStatsRow = (): JSX.Element => (
  <DarkSurfaceRow
    label={t('Usage stats', '用量统计')}
    desc={t('Show steps, turns, and token counts in the context popover, run footers, and session cards.', '显示上下文弹层、轮尾与会话卡中的步数、轮次和 tokens 数量。')}
    aria="usage stats"
    read={readUsageStats}
    apply={applyUsageStats}
  />
);

/** 产物卡显隐行(2026-11-16 用户裁定「设置页可以控制产物显隐开关」):关=正文轮末产物卡区整块
 *  不渲染;产物仍登记在 runmeta(产物库页签/回放不受影响,只收渲染层)。持久经 artifact-cards.ts */
const ArtifactCardsRow = (): JSX.Element => (
  <DarkSurfaceRow
    label={t('Artifact cards', '产物卡')}
    desc={t('Show the artifact cards at the end of each turn in the chat. Artifacts stay registered and visible in the Artifacts tab.', '在对话每轮末尾展示产物卡片。产物仍会登记，可在产物页签查看。')}
    aria="artifact cards"
    read={readArtifactCards}
    apply={applyArtifactCards}
  />
);


/** 改动卡显隐行(2026-11-17 用户裁定「产物卡下面显示一个改动卡,普通模式下不显示,开发者模式默认是打开的,
 *  显示 diff 卡条」):关=正文轮末改动卡条整块不渲染;改动仍登记在 runmeta(审查页不受影响) */
const ChangeCardsRow = (): JSX.Element => (
  <DarkSurfaceRow
    label={t('Change cards', '改动卡')}
    desc={t('Show the change cards at the end of each turn in the chat. Changes stay registered and visible in review.', '在对话每轮末尾展示改动卡条。改动仍会登记，可在审查页查看。')}
    aria="change cards"
    read={readChangeCards}
    apply={applyChangeCards}
  />
);

/** 会话信息卡显隐行(2026-11-17 用户裁定「会话信息卡,也在普通模式下不显示,开发者默认开,同样放到 diff 下」):
 *  关=侧栏会话行悬浮信息卡不渲染 */
const SessionInfoCardsRow = (): JSX.Element => (
  <DarkSurfaceRow
    label={t('Session info card', '会话信息卡')}
    desc={t('Show the hover card with the session path, branch, turns, and creation time in the sidebar.', '在侧栏会话行悬停时展示路径、分支、轮次与建档时刻卡片。')}
    aria="session info card"
    read={readSessionInfoCards}
    apply={applySessionInfoCards}
  />
);
/** 开发者模式行(2026-11-17 用户裁定「一个开关控制」):关=C 端简洁界面
 *  (隐藏终端/高级设置/工程详情类入口);开=完整工程能力。持久经 developer-mode.ts */
const DeveloperModeRow = (): JSX.Element => (
  <DarkSurfaceRow
    label={t('Developer mode', '开发者模式')}
    desc={t('Show terminal, advanced settings, and other tools for developers.', '显示终端、高级设置等面向开发者的能力。')}
    aria="developer mode"
    read={readDeveloperMode}
    apply={applyDeveloperMode}
  />
);

/** 简洁模式行(2026-11-14 用户裁定「设置页提供简洁模式」):两阶段正文之间的工具/思考段外面
 *  再加一层段级折叠——折叠头=交织双方形图标+类别动词总结(查阅了文件 · 运行了命令…,不带数量);
 *  运行中只显既有聚合行+当前运行行,跑完平滑并入;逃逸面=spawn/团队全家/ask/exit_plan/task_stop */
const ConciseModeRow = (): JSX.Element => (
  <DarkSurfaceRow
    label={t('Concise mode', '简洁模式')}
    desc={t('Fold tool and thinking rows into one summary line.', '工具与思考行折叠为一条总结，跑完即并入。')}
    aria="concise mode"
    read={readConciseMode}
    apply={applyConciseMode}
  />
);

/** 界面模式行(2026-11-07 用户裁定;ui-mode.ts):编程(缺省)/办公 */
function UiModeRow(): JSX.Element {  const mode = useUiMode();
  return (
    <div className="sx-setting-row">
      <div className="sx-setting-main">
        <div className="sx-setting-title">
          <span className="sx-setting-label">{t('Interface mode', '界面模式')}</span>
        </div>
        <p className="sx-setting-desc">
          {t('Office mode focuses on action summaries and results; coding mode shows commands, output, and code change details.', '办公模式侧重操作摘要与结果；编程模式显示命令、输出和代码变更详情。')}
        </p>
      </div>
      <div className="sx-setting-ctl">
        <Select
          ariaLabel="interface mode"
          value={mode}
          options={[
            { v: 'code', l: t('Coding', '编程模式') },
            { v: 'office', l: t('Office', '办公模式') },
          ]}
          onChange={(v) => applyUiMode(v as UiMode)}
        />
      </div>
    </div>
  );
}

const UiFontRow = (): JSX.Element => (
  <FontSizeRow
    label={t('UI font size', '界面字号')}
    desc={t('Adjust the text size of the app interface; icons and layout are not affected.', '调整应用界面的文字大小，图标和布局尺寸不受影响。')}
    aria="ui font size"
    choices={UI_FONT_CHOICES}
    read={readUiFontSize}
    apply={applyUiFontSize}
  />
);

const CodeFontRow = (): JSX.Element => (
  <FontSizeRow
    label={t('Code font size', '代码字号')}
    desc={t('Adjust the default size of code blocks, file previews, and diff views.', '调整代码块、文件预览和差异视图的默认字号。')}
    aria="code font size"
    choices={CODE_FONT_CHOICES}
    read={readCodeFontSize}
    apply={applyCodeFontSize}
  />
);

export {
  ArtifactCardsRow,
  ChangeCardsRow,
  SessionInfoCardsRow,
  CodeFontRow,
  ConciseModeRow,
  DarkBubblesRow,
  DarkCodeRow,
  DeveloperModeRow,
  FontRow,
  FontSizeRow,
  PaletteRow,
  PaletteSilhouette,
  ThemeRow,
  UiFontRow,
  UiModeRow,
  UsageStatsRow,
  ZoomRow,
};
