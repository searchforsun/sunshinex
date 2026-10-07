/**
 * G8a 标签条(spec §1 / task-3 简报):标签 pill(类型图标+标题+×)、尾部「+」类型菜单
 * (按 group 分节,选中直调 onOpenType)、右端折叠钮、快捷键(Alt+W 关活动 /
 * Ctrl+Alt+→/← 环回切换)——纯受控组件,状态全部上抛(T5 以 setTab 消费 tab-state)。
 * 样式全用 app.css 既有 sx- 类;唯一内联样式为 disabled 整条 opacity .5(简报明文允许)。
 */

import { useEffect, useRef, useState } from 'react';
import { X, Plus, PanelLeft, PanelRight, FileText, KanbanSquare } from 'lucide-react';
import { TAB_REGISTRY, tabEntry } from './registry';
import type { TabTypeId } from './tab-state';

export interface TabStripProps {
  readonly tabs: readonly import('./tab-state').TabInstance[];
  readonly activeUid: string | null;
  readonly collapsed: boolean;
  readonly disabled?: boolean; // 无会话:整条灰
  readonly onSelect: (uid: string) => void;
  readonly onClose: (uid: string) => void;
  readonly onNew: () => void; // + 菜单内选中类型由菜单直调 onOpenType
  readonly onOpenType: (type: import('./tab-state').TabTypeId) => void;
  readonly onToggleCollapse: () => void;
  readonly onCycle: (dir: 1 | -1) => void;
  readonly onCloseActive: () => void;
}

/** 类型图标(pill/菜单共用;G8b-d 增类在此补图标) */
const TAB_ICONS: Partial<Record<TabTypeId, typeof FileText>> = {
  file: FileText,
  tasks: KanbanSquare,
};

/** 「+」菜单分节序:content → session → tools */
const GROUP_ORDER: readonly ('content' | 'session' | 'tools')[] = ['content', 'session', 'tools'];

export function TabStrip(props: TabStripProps): JSX.Element {
  const {
    tabs,
    activeUid,
    collapsed,
    disabled = false,
    onSelect,
    onClose,
    onNew,
    onOpenType,
    onToggleCollapse,
    onCycle,
    onCloseActive,
  } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 菜单外点关闭:menuOpen 在席时挂 document mousedown,落点在本条外即收(点 + 自身走 click 切换)
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current !== null && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  // 快捷键(window keydown,卸载解绑):Alt+W 关活动;Ctrl+Alt+→/← 环回切换;disabled 不响应
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (disabled) return;
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'w' || e.key === 'W')) {
        onCloseActive();
        return;
      }
      if (e.ctrlKey && e.altKey && !e.metaKey) {
        if (e.key === 'ArrowRight') onCycle(1);
        else if (e.key === 'ArrowLeft') onCycle(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [disabled, onCloseActive, onCycle]);

  const collapseBtn = (
    <button
      type="button"
      aria-label="collapse sidebar"
      className="sx-iconbtn"
      disabled={disabled}
      onClick={onToggleCollapse}
    >
      {collapsed ? <PanelLeft size={16} strokeWidth={1.75} /> : <PanelRight size={16} strokeWidth={1.75} />}
    </button>
  );

  // disabled 整条降透明(本组件唯一内联样式,简报明文允许)
  const stripStyle = disabled ? { opacity: 0.5 } : undefined;

  // collapsed 态:只渲染折叠钮一行(无标签/无「+」)
  if (collapsed) {
    return (
      <div className="sx-tabstrip" ref={rootRef} style={stripStyle}>
        {collapseBtn}
      </div>
    );
  }

  return (
    <div className="sx-tabstrip" ref={rootRef} style={stripStyle}>
      {tabs.map((t) => {
        const entry = tabEntry(t.type);
        const title = entry.title(t.params);
        const Icon = TAB_ICONS[t.type] ?? FileText;
        return (
          <button
            key={t.uid}
            type="button"
            className={`sx-tab${t.uid === activeUid ? ' active' : ''}`}
            title={title}
            disabled={disabled}
            onClick={() => onSelect(t.uid)}
          >
            <Icon size={16} strokeWidth={1.75} />
            <span>{title}</span>
            <span
              role="button"
              aria-label={`close tab ${title}`}
              className="sx-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.uid);
              }}
            >
              <X size={12} strokeWidth={1.75} />
            </span>
          </button>
        );
      })}
      <button
        type="button"
        aria-label="new tab"
        className="sx-iconbtn"
        disabled={disabled}
        onClick={() => {
          onNew();
          setMenuOpen((o) => !o);
        }}
      >
        <Plus size={16} strokeWidth={1.75} />
      </button>
      {menuOpen && (
        <div className="sx-menu-pop" role="menu" aria-label="new tab types">
          {GROUP_ORDER.map((g) => {
            const entries = TAB_REGISTRY.filter((e) => e.group === g);
            if (entries.length === 0) return null;
            return (
              <div key={g} role="group" aria-label={g}>
                {entries.map((e) => {
                  const MenuIcon = TAB_ICONS[e.id] ?? FileText;
                  return (
                    <button
                      key={e.id}
                      type="button"
                      role="menuitem"
                      className="sx-menuitem"
                      disabled={disabled}
                      onClick={() => {
                        setMenuOpen(false);
                        onOpenType(e.id);
                      }}
                    >
                      <MenuIcon size={16} strokeWidth={1.75} />
                      {e.title({})}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      {collapseBtn}
    </div>
  );
}
