/**
 * 快捷键集中注册表(2026-11-25 调研轮:对标 Codex / Claude Code keybindings / ChatGPT 桌面版):
 * 单一数据源——动作 id → 默认键位 + 双语标签 + 分组。消费端三处同源,不再各写各的:
 * ① 集中分发器(dispatch.ts,window keydown 捕获态按注册表匹配 → 动作 bus);
 * ② 设置·快捷键页(ShortcutsPane 可编辑行,行内录制改键);
 * ③ 侧栏菜单 kbd 角标(ProjectMenu,「新对话」等入口右侧恒显键位)。
 * 键串规范化形如 'Ctrl+Shift+O' / 'Alt+ArrowLeft':修饰序固定 Ctrl,Alt,Shift,Meta;
 * 主键取 e.key(单字符统一大写)。展示经 comboParts 切片(箭头/Esc 渲染惯用字形,
 * 与旧 ShortcutsPane 文档表同形 ['Ctrl','Alt','→'])。
 */

export type ShortcutId =
  | 'app.newChat'
  | 'app.newSunx'
  | 'app.schedules'
  | 'app.search'
  | 'app.settings'
  | 'app.shortcuts'
  | 'nav.back'
  | 'nav.forward'
  | 'tabs.close'
  | 'tabs.next'
  | 'tabs.prev';

export interface BiText {
  readonly en: string;
  readonly zh: string;
}

export interface ShortcutDef {
  readonly id: ShortcutId;
  /** 默认键位(规范化键串) */
  readonly keys: string;
  /** 帮助面板分组:'app'=应用动作(侧栏/设置入口,可录制改键) | 'window'=全局与窗口 */
  readonly group: 'app' | 'window';
  readonly label: BiText;
}

/** 默认键位表。默认值避开:OS 级唤起 Alt+Shift+S(shell/lifecycle)、Electron 桌面惯例
 *  Ctrl+W(壳 Menu.setApplicationMenu(null) 后虽不吞键,但与用户肌肉记忆冲突仍避开);
 *  新增对齐业界:Ctrl+Shift+O/Ctrl+Alt+N=ChatGPT 新对话/quick chat,Ctrl+K=搜索
 *  (ChatGPT/Linear 事实标准),Ctrl+,=设置(VS Code 惯例),Ctrl+/=快捷键帮助(ChatGPT 惯例) */
export const SHORTCUT_DEFS: readonly ShortcutDef[] = [
  { id: 'app.newChat', keys: 'Ctrl+Shift+O', group: 'app', label: { en: 'New chat', zh: '新对话' } },
  { id: 'app.newSunx', keys: 'Ctrl+Alt+N', group: 'app', label: { en: 'New Sunx', zh: '新建 Sunx' } },
  { id: 'app.schedules', keys: 'Alt+T', group: 'app', label: { en: 'Scheduled tasks', zh: '定时任务' } },
  { id: 'app.search', keys: 'Ctrl+K', group: 'app', label: { en: 'Search', zh: '搜索' } },
  { id: 'app.settings', keys: 'Ctrl+,', group: 'app', label: { en: 'Settings', zh: '设置' } },
  { id: 'app.shortcuts', keys: 'Ctrl+/', group: 'app', label: { en: 'Shortcut help', zh: '快捷键帮助' } },
  { id: 'nav.back', keys: 'Alt+ArrowLeft', group: 'window', label: { en: 'Navigate back', zh: '会话导航历史·后退' } },
  { id: 'nav.forward', keys: 'Alt+ArrowRight', group: 'window', label: { en: 'Navigate forward', zh: '会话导航历史·前进' } },
  { id: 'tabs.close', keys: 'Alt+W', group: 'window', label: { en: 'Close active tab', zh: '关闭当前标签页' } },
  { id: 'tabs.next', keys: 'Ctrl+Alt+ArrowRight', group: 'window', label: { en: 'Next tab', zh: '切换到下一个标签页' } },
  { id: 'tabs.prev', keys: 'Ctrl+Alt+ArrowLeft', group: 'window', label: { en: 'Previous tab', zh: '切换到上一个标签页' } },
];

/** 可编辑分组(帮助面板前两组,行内可录制改键;组序即面板序) */
export const EDITABLE_GROUPS: ReadonlyArray<{ readonly id: 'app' | 'window'; readonly title: BiText }> = [
  { id: 'app', title: { en: 'App actions', zh: '应用动作' } },
  { id: 'window', title: { en: 'Global & window', zh: '全局与窗口' } },
];

export interface StaticShortcutRow {
  readonly keys: readonly string[];
  readonly desc: BiText;
}
export interface StaticShortcutGroup {
  readonly id: string;
  readonly title: BiText;
  readonly rows: readonly StaticShortcutRow[];
}

/** 静态说明组(组件局部键面,不可改键;2026-11-25 调研裁定精简——↑↓/Tab/←→ 跨 token/
 *  Backspace 整删等输入框微导航不上帮助面板,业界同口径(Codex/ChatGPT 帮助面只列动作级);
 *  Enter 发送/Shift+Enter 换行属聊天通用惯例,收「通用输入」组收尾;桌面端补 OS 级唤起键) */
export const STATIC_SHORTCUT_GROUPS: readonly StaticShortcutGroup[] = [
  {
    id: 'desktop',
    title: { en: 'Desktop (system-wide)', zh: '桌面端(系统级)' },
    rows: [
      { keys: ['Alt', 'Shift', 'S'], desc: { en: 'Summon the main window (works over any app; not remappable)', zh: '唤起主窗口(任何应用前台均生效;不可自定义)' } },
    ],
  },
  {
    id: 'common-input',
    title: { en: 'Text input (universal)', zh: '通用输入' },
    rows: [
      { keys: ['Enter'], desc: { en: 'Send message', zh: '发送消息' } },
      { keys: ['Shift', 'Enter'], desc: { en: 'New line', zh: '插入换行' } },
    ],
  },
  {
    id: 'composer',
    title: { en: 'Composer panels', zh: '对话输入框·面板' },
    rows: [
      { keys: ['/'], desc: { en: 'Open command & skill palette', zh: '打开命令/技能面板' } },
      { keys: ['@'], desc: { en: 'Reference a file (opens file panel)', zh: '引用文件(打开文件面板)' } },
      { keys: ['Esc'], desc: { en: 'Dismiss command / file panel', zh: '关闭命令/文件面板' } },
      { keys: ['Enter'], desc: { en: 'Pick highlighted @ file / run typed command', zh: '选中高亮 @ 文件 / 直跑已敲参数的命令' } },
    ],
  },
  {
    id: 'message',
    title: { en: 'Conversation area', zh: '消息区' },
    rows: [
      { keys: ['Enter'], desc: { en: 'Toggle finished-turn summary (focused)', zh: '折叠/展开已结束轮次摘要(聚焦时)' } },
      { keys: ['Esc'], desc: { en: 'Cancel message edit (without saving)', zh: '退出消息编辑(不保存)' } },
      { keys: ['Enter'], desc: { en: 'Submit message edit', zh: '提交消息编辑' } },
      { keys: ['Enter'], desc: { en: 'Re-plan with feedback (plan card, non-empty)', zh: '带反馈重新计划(计划卡反馈框非空时)' } },
      { keys: ['Enter'], desc: { en: 'Submit question card answers', zh: '提交选择题挂起卡' } },
    ],
  },
  {
    id: 'lightbox',
    title: { en: 'Image lightbox', zh: '图片灯箱' },
    rows: [
      { keys: ['+'], desc: { en: 'Zoom in', zh: '放大' } },
      { keys: ['-'], desc: { en: 'Zoom out', zh: '缩小' } },
      { keys: ['0'], desc: { en: 'Reset zoom', zh: '复位缩放' } },
      { keys: ['Esc'], desc: { en: 'Close lightbox', zh: '关闭灯箱' } },
    ],
  },
  {
    id: 'overlay',
    title: { en: 'Settings & overlays', zh: '设置与弹层' },
    rows: [
      { keys: ['Esc'], desc: { en: 'Leave settings / close menus & popovers', zh: '设置页返回会话 / 关闭菜单与弹层' } },
      { keys: ['Enter'], desc: { en: 'Commit text input / activate item', zh: '提交文本输入 / 激活选中项' } },
      { keys: ['↑', '↓'], desc: { en: 'Move within dropdown options', zh: '下拉选项间移动' } },
    ],
  },
];

/** 键盘事件 → 规范化键串;纯修饰键(等待主键中)回 null。单字符统一大写,
 *  故 Shift+字母 与其大写形规范化同串(录制/匹配两侧一致) */
export function eventToCombo(e: KeyboardEvent): string | null {
  const k = e.key;
  if (
    k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta' ||
    k === 'AltGraph' || k === 'CapsLock' || k === 'ContextMenu' || k === 'Process'
  ) {
    return null;
  }
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  parts.push(k.length === 1 ? k.toUpperCase() : k);
  return parts.join('+');
}

const KEY_DISPLAY: Readonly<Record<string, string>> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
  ' ': 'Space',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
};

/** 规范化键串 → 展示切片(['Ctrl','Alt','→'];主键恰为 '+' 时规范串以前缀空尾解析) */
export function comboParts(combo: string): readonly string[] {
  let s = combo;
  const parts: string[] = [];
  for (const m of ['Ctrl', 'Alt', 'Shift', 'Meta'] as const) {
    if (s.startsWith(`${m}+`)) {
      parts.push(m);
      s = s.slice(m.length + 1);
    }
  }
  parts.push(s === '' ? '+' : (KEY_DISPLAY[s] ?? s));
  return parts;
}

/** 录制准入:全局键面必须有修饰(Ctrl/Alt/Meta)或属功能键 F1-F12——裸字母/数字/方向键/
 *  翻页键一旦全局绑定,输入框打字与光标移动即被吞键,一律不收 */
export function comboAllowed(combo: string): boolean {
  if (combo.startsWith('Ctrl+') || combo.startsWith('Alt+') || combo.startsWith('Meta+')) return true;
  const parts = comboParts(combo);
  const main = parts[parts.length - 1] ?? '';
  return /^F([1-9]|1[0-2])$/.test(main);
}
