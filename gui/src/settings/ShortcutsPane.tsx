import { t } from '../i18n';

/**
 * 设置·快捷键说明页(静态文档面,无读写):全 GUI 键位按场景分组列示——全局/窗口、对话输入框、
 * 消息区、图片灯箱、设置与弹层。键位以 <kbd> 徽标渲染(样式 .sx-kbd),描述双语 t()。
 * 数据即本文档表(与实现一一对应:use-nav-history/TabStrip/use-composer-keys/WelcomeComposer/
 * EntryViews/PlanCard/AskDock/ImageLightbox/SettingsShell 等;新增快捷键须同步此表)。
 */

interface ShortcutRow {
  readonly keys: readonly string[];
  readonly desc: { readonly en: string; readonly zh: string };
}
interface ShortcutGroup {
  readonly title: { readonly en: string; readonly zh: string };
  readonly rows: readonly ShortcutRow[];
}

const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: { en: 'Global & window', zh: '全局与窗口' },
    rows: [
      { keys: ['Alt', '←'], desc: { en: 'Navigate back', zh: '会话导航历史·后退' } },
      { keys: ['Alt', '→'], desc: { en: 'Navigate forward', zh: '会话导航历史·前进' } },
      { keys: ['Alt', 'W'], desc: { en: 'Close active tab', zh: '关闭当前标签页' } },
      { keys: ['Ctrl', 'Alt', '→'], desc: { en: 'Next tab', zh: '切换到下一个标签页' } },
      { keys: ['Ctrl', 'Alt', '←'], desc: { en: 'Previous tab', zh: '切换到上一个标签页' } },
    ],
  },
  {
    title: { en: 'Message composer', zh: '对话输入框' },
    rows: [
      { keys: ['Enter'], desc: { en: 'Send message', zh: '发送消息' } },
      { keys: ['Shift', 'Enter'], desc: { en: 'New line', zh: '插入换行' } },
      { keys: ['/'], desc: { en: 'Open command & skill palette', zh: '打开命令/技能面板' } },
      { keys: ['@'], desc: { en: 'Reference a file (opens file panel)', zh: '引用文件(打开文件面板)' } },
      { keys: ['↑'], desc: { en: 'Move highlight up in panels', zh: '面板内高亮上移(命令/@ 文件面板)' } },
      { keys: ['↓'], desc: { en: 'Move highlight down in panels', zh: '面板内高亮下移' } },
      { keys: ['Tab'], desc: { en: 'Complete highlighted command', zh: '补全当前高亮命令' } },
      { keys: ['Esc'], desc: { en: 'Dismiss command / file panel', zh: '关闭命令/文件面板' } },
      { keys: ['Enter'], desc: { en: 'Pick highlighted @ file / run typed command', zh: '选中高亮 @ 文件 / 直跑已敲参数的命令' } },
      { keys: ['←'], desc: { en: 'Jump over an @ token (caret at boundary)', zh: '跨整个 @ 引用移动光标(位于边界时)' } },
      { keys: ['→'], desc: { en: 'Jump over an @ token (caret at boundary)', zh: '跨整个 @ 引用移动光标(位于边界时)' } },
      { keys: ['Backspace'], desc: { en: 'Delete whole @ token', zh: '整删光标所在 @ 引用' } },
    ],
  },
  {
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
    title: { en: 'Image lightbox', zh: '图片灯箱' },
    rows: [
      { keys: ['+'], desc: { en: 'Zoom in', zh: '放大' } },
      { keys: ['-'], desc: { en: 'Zoom out', zh: '缩小' } },
      { keys: ['0'], desc: { en: 'Reset zoom', zh: '复位缩放' } },
      { keys: ['Esc'], desc: { en: 'Close lightbox', zh: '关闭灯箱' } },
    ],
  },
  {
    title: { en: 'Settings & overlays', zh: '设置与弹层' },
    rows: [
      { keys: ['Esc'], desc: { en: 'Leave settings / close menus & popovers', zh: '设置页返回会话 / 关闭菜单与弹层' } },
      { keys: ['Enter'], desc: { en: 'Commit text input / activate item', zh: '提交文本输入 / 激活选中项' } },
      { keys: ['↑', '↓'], desc: { en: 'Move within dropdown options', zh: '下拉选项间移动' } },
    ],
  },
];

export function ShortcutsPane(): JSX.Element {
  return (
    <section className="sx-settings-form sx-settings-body" aria-label="settings pane shortcuts">
      {/* 与 SettingsForm 各面板同款 <h2> 标题(导航项文字一致),对齐设置页版式 */}
      <h2>{t('Shortcuts', '快捷键')}</h2>
      <div className="sx-shortcuts-page">
        {/* 2026-11-06 用户裁定:页首说明文字撤下(其他设置页无此形态);分组改深色背景块卡 */}
        {SHORTCUT_GROUPS.map((g) => (
          <div key={g.title.en} className="sx-shortcuts-group">
            <h3 className="sx-shortcuts-title">{t(g.title.en, g.title.zh)}</h3>
            <div className="sx-shortcuts-rows">
              {g.rows.map((r, i) => (
                <div key={i} className="sx-shortcut-row">
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
