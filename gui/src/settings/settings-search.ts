import { KEY_DESCRIPTIONS, SETTINGS_PANES } from './SettingsForm';
import { SETTINGS_GROUPS } from './settings-groups';
import { SHORTCUT_GROUPS } from './ShortcutsPane';

/**
 * 设置面搜索索引(2026-11-21 用户裁定「还有一些设置页的项等等……不用单独点击设置页」):
 * 管理面所有可定位项 = 设置页签条目 + 设置行(键/双语标签/双语说明) + 快捷键说明行。
 * 纯数据、双语对在渲染期 t() 求值;点击由宿主开设置并滚到对应行(data-setting-key 锚)。
 */

interface BiText {
  readonly en: string;
  readonly zh: string;
}

export interface SettingsSearchItem {
  readonly id: string;
  /** 目标设置面板 id(SettingsShell SETTINGS_GROUPS 同源) */
  readonly pane: string;
  readonly paneTitle: BiText;
  /** 目标行锚(设置行 data-setting-key;缺省=只开面板不滚行) */
  readonly row?: string;
  readonly label: BiText;
  readonly desc?: BiText;
  /** 快捷键行的键位(显示在行尾:Alt + ←) */
  readonly keys?: readonly string[];
}

/** 外观类特殊行(非 settings 键,标签/说明与 settings-rows.tsx 同文) */
const SPECIAL_ROWS: Record<string, { label: BiText; desc: BiText }> = {
  theme: {
    label: { en: 'Appearance', zh: '外观' },
    desc: { en: 'Color scheme of the app interface', zh: '应用界面的亮暗配色' },
  },
  zoom: {
    label: { en: 'UI zoom', zh: '界面放缩' },
    desc: { en: 'Global zoom for fonts / icons / layout', zh: '全局放缩字体/图标/布局' },
  },
  palette: {
    label: { en: 'Color theme', zh: '配色主题' },
    desc: { en: 'Colors of the interface — click a theme to apply', zh: '界面配色——点击主题即生效' },
  },
  font: {
    label: { en: 'Font preset', zh: '字体预设' },
    desc: { en: 'Body / thinking / tool / code typography', zh: '正文/思考/工具/代码的字体排版' },
  },
};

/** 面板标题 = 设置导航同源(SETTINGS_GROUPS 单点);缺失回落面板自身标题 */
const PANE_TITLES = new Map<string, BiText>(
  SETTINGS_GROUPS.flatMap((g) => g.items.map((it) => [it.id, it.title] as const)),
);

function buildIndex(): SettingsSearchItem[] {
  const out: SettingsSearchItem[] = [];
  // ① 面板级条目:搜「快捷键/权限/插件」直接开对应页
  for (const g of SETTINGS_GROUPS) {
    for (const it of g.items) {
      out.push({ id: `pane:${it.id}`, pane: it.id, paneTitle: it.title, label: it.title });
    }
  }
  // ② 设置行条目(SettingsForm 四页面板字段;键名/双语标签/双语说明可搜)
  for (const pane of SETTINGS_PANES) {
    const paneTitle = PANE_TITLES.get(pane.id) ?? pane.title;
    for (const group of pane.groups) {
      for (const fd of group.fields) {
        const d = KEY_DESCRIPTIONS[fd.key];
        out.push({
          id: `row:${pane.id}:${fd.key}`,
          pane: pane.id,
          paneTitle,
          row: fd.key,
          label: d !== undefined ? d.label : { en: fd.key, zh: fd.key },
          desc: d !== undefined ? { en: d.en, zh: d.zh } : undefined,
        });
      }
      // 外观特殊行(theme/zoom/palette/font;设置行锚同 data-setting-key)
      for (const [flag, key] of [
        [group.themeRow, 'theme'],
        [group.zoomRow, 'zoom'],
        [group.paletteRow, 'palette'],
        [group.fontRow, 'font'],
      ] as const) {
        if (flag !== true) continue;
        const s = SPECIAL_ROWS[key]!;
        out.push({ id: `row:${pane.id}:${key}`, pane: pane.id, paneTitle, row: key, label: s.label, desc: s.desc });
      }
    }
  }
  // ②b 存储页行(2026-11-21 StoragePane 自绘行,非 SETTINGS_PANES 字段;锚=data-setting-key)
  const storageTitle = PANE_TITLES.get('storage') ?? { en: 'Storage', zh: '存储' };
  const rd = KEY_DESCRIPTIONS.archiveRetentionDays;
  if (rd !== undefined) {
    out.push({ id: 'row:storage:archiveRetentionDays', pane: 'storage', paneTitle: storageTitle, row: 'archiveRetentionDays', label: rd.label, desc: { en: rd.en, zh: rd.zh } });
  }
  out.push({
    id: 'row:storage:cache',
    pane: 'storage',
    paneTitle: storageTitle,
    row: 'cache',
    label: { en: 'Clear cache', zh: '清理缓存' },
    desc: { en: 'Identified cache categories with sizes', zh: '已识别的缓存分类与占用' },
  });
  // ②c 通道页行(channels Task 12,spec §8):pane 条目已由 SETTINGS_GROUPS 自动收录;此处补两枚
  // 稳定行锚(pane 恒渲染:添加工具栏 data-setting-key="channels.add"、凭证说明行
  // data-setting-key="channels.secret")。逐通道字段锚 channels.<id>.<field> 的 id 运行期
  // 自动生成,索引期不可枚举——搜索直达落面板级,不在索引里放悬空锚。
  const channelsTitle = PANE_TITLES.get('channels') ?? { en: 'Channels', zh: '通道' };
  out.push({
    id: 'row:channels:add',
    pane: 'channels',
    paneTitle: channelsTitle,
    row: 'channels.add',
    label: { en: 'New channel', zh: '新增通道' },
    desc: {
      en: 'Telegram / Mock today; Feishu, DingTalk and WeCom coming soon',
      zh: '现支持 Telegram/Mock;飞书、钉钉、企业微信即将支持',
    },
  });
  out.push({
    id: 'row:channels:secret',
    pane: 'channels',
    paneTitle: channelsTitle,
    row: 'channels.secret',
    label: { en: 'Channel credentials', zh: '通道凭证' },
    desc: {
      en: 'Secrets live in env slots — set SUNSHINEX_CHANNEL_SECRET_<ID> in the settings.json env block (D6: never in channel config)',
      zh: '密钥按通道 id 走 env 槽——在 settings.json 的 env 块配置 SUNSHINEX_CHANNEL_SECRET_<ID>(D6:凭证不进通道配置)',
    },
  });
  // ③ 快捷键说明行(ShortcutsPane 文档表同源;点击开快捷键页并滚到该行)
  const shortcutsTitle = PANE_TITLES.get('shortcuts') ?? { en: 'Shortcuts', zh: '快捷键' };
  SHORTCUT_GROUPS.forEach((group, gi) => {
    group.rows.forEach((r, ri) => {
      out.push({
        id: `shortcut:${gi}:${ri}`,
        pane: 'shortcuts',
        paneTitle: shortcutsTitle,
        row: `shortcut:${gi}:${ri}`,
        label: r.desc,
        keys: r.keys,
      });
    });
  });
  return out;
}

/** 设置搜索索引(模块级只读构造一次:纯数据无 IO) */
export const SETTINGS_SEARCH_ITEMS: readonly SettingsSearchItem[] = buildIndex();
