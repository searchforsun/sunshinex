/**
 * G8a 标签条(spec §1 / task-3 简报):标签 pill(类型图标+标题+×)、尾部「+」类型菜单
 * (按 group 分节,选中直调 onOpenType)、右端折叠钮、快捷键(Alt+W 关活动 /
 * Ctrl+Alt+→/← 环回切换)——纯受控组件,状态全部上抛(T5 以 setTab 消费 tab-state)。
 * 样式全用 app.css 既有 sx- 类;唯一内联样式为 disabled 整条 opacity .5(简报明文允许)。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { X, Plus, PanelLeft, PanelRight, FileText, ChevronsDown } from 'lucide-react';
import { t } from '../i18n';
import { FileIcon, hasFileTypeIcon } from '../file-icon';
import { TAB_REGISTRY, TAB_ICONS, tabEntry } from './registry';
import { disambiguateTabTitles, type ClosedTab } from './tab-state';
import { TabSearchPop } from './TabSearchPop';

export interface TabStripProps {
  readonly tabs: readonly import('./tab-state').TabInstance[];
  readonly activeUid: string | null;
  readonly collapsed: boolean;
  readonly disabled?: boolean; // 无会话:整条灰
  readonly onSelect: (uid: string) => void;
  readonly onClose: (uid: string) => void;
  /** G14.111 拖拽重排回调(App 落 tabStates 数组重排) */
  readonly onReorder?: (fromUid: string, toUid: string) => void;
  readonly onOpenType: (type: import('./tab-state').TabTypeId) => void;
  readonly onToggleCollapse: () => void;
  readonly onCycle: (dir: 1 | -1) => void;
  readonly onCloseActive: () => void;
  /** G14.2xx 标签搜索弹窗:最近关闭历史(App 持有)+按索引重开;缺场=弹窗无「最近关闭」节 */
  readonly recentClosed?: readonly ClosedTab[];
  readonly onReopenClosed?: (index: number) => void;
}

/** 「+」菜单分节序:content → session → tools */
const GROUP_ORDER: readonly ('content' | 'session' | 'tools')[] = ['content', 'session', 'tools'];
/** G14.159 不入「+」菜单的标签类型(类型仍注册:目录树/工具行照常开 file 标签,既有标签照常渲染) */
const MENU_HIDDEN = new Set(['file', 'context', 'agent']);

export function TabStrip(props: TabStripProps): JSX.Element {
  const {
    tabs,
    activeUid,
    collapsed,
    disabled = false,
    onSelect,
    onClose,
    onReorder,
    onOpenType,
    onToggleCollapse,
    onCycle,
    onCloseActive,
    recentClosed,
    onReopenClosed,
  } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  // G14.2xx 标签搜索弹窗(最左触发,纵向列打开的/最近关闭的标签页)
  const [searchOpen, setSearchOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  /** G14.2xx 弹层锚容器(外点关闭的判定边界=各自触发钮容器,非整条——点条内标签/另一钮同样收) */
  const searchAnchorRef = useRef<HTMLDivElement>(null);
  const menuAnchorRef = useRef<HTMLDivElement>(null);
  // G14.111 拖拽重排:draggable 标签 dragstart 记 uid,dragover 命中目标即回调重排(App 落数组)
  const dragUidRef = useRef<string | null>(null);
  // G14.2xx 同名消歧:file 标签撞名时显示最小区分相对路径(chrome 同位);引用随 tabs 变
  const titles = useMemo(() => disambiguateTabTitles(tabs), [tabs]);
  /** G14.2xx 标题截断隐现(chrome 同形:无省略号,溢出即右缘渐隐)——逐标题量溢出打 data-cut */
  const scrollRef = useRef<HTMLDivElement>(null);
  const titleRefs = useRef(new Map<string, HTMLSpanElement>());
  useLayoutEffect(() => {
    const mark = (): void => {
      for (const [, el] of titleRefs.current) {
        if (el.scrollWidth > el.clientWidth + 1) el.setAttribute('data-cut', '');
        else el.removeAttribute('data-cut');
      }
    };
    mark();
    const el = scrollRef.current;
    if (el === null) return;
    const ro = new ResizeObserver(mark); // 拖栏/标签增删改变 pill 宽 → 重量截断
    ro.observe(el);
    return () => ro.disconnect();
  }, [titles, tabs]);

  // 弹窗外点关闭:判定边界=各自锚容器(V 触发钮容器/「+」触发钮容器)——点条内其他元素(标签/
  // 折叠钮等)同属「其他地方」一律收;点弹层自身/触发钮不收(触发钮走 click 切换)
  useEffect(() => {
    if (!menuOpen && !searchOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (!(e.target instanceof Node)) return;
      if (searchOpen && searchAnchorRef.current !== null && !searchAnchorRef.current.contains(e.target)) {
        setSearchOpen(false);
      }
      if (menuOpen && menuAnchorRef.current !== null && !menuAnchorRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    // 外点收语义(各弹层各表其面,见 D49):本件=容器外 mousedown 即收(标签条无 Esc 面且不随滚动收——fixed 侧栏贴边)
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen, searchOpen]);

  // 快捷键(window keydown,卸载解绑):Alt+W 关活动;Ctrl+Alt+→/← 环回切换;disabled 不响应
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat) return; // 长按连发守卫:按住 Alt+W 只关一次(连发即连关全部标签)
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

  // G14.28:展开态钉最右侧(mlAuto);折叠态细条已由 App 整体不渲染(保留本钮兜底)
  // disabled 整条降透明(本组件唯一内联样式,简报明文允许);G8e 三面:title 提示不可用因由
  const stripStyle = disabled ? { opacity: 0.5 } : undefined;
  const stripTitle = disabled ? '先从左侧选择会话' : undefined;
  const collapseBtn = (mlAuto: boolean) => (
    <button
      type="button"
      aria-label="collapse sidebar"
      className="sx-iconbtn"
      style={mlAuto ? { marginLeft: 'auto' } : undefined}
      disabled={disabled}
      onClick={onToggleCollapse}
    >
      {collapsed ? <PanelLeft size={16} strokeWidth={1.75} /> : <PanelRight size={16} strokeWidth={1.75} />}
    </button>
  );

  // collapsed 态:只渲染折叠钮一行(无标签/无「+」)
  if (collapsed) {
    return (
      <div className="sx-tabstrip" ref={rootRef} style={stripStyle} data-tip={stripTitle}>
        {collapseBtn(false)}
      </div>
    );
  }

  return (
    <div className="sx-tabstrip" ref={rootRef} style={stripStyle} data-tip={stripTitle}>
      {/* G14.2xx 标签搜索弹窗触发钮(最左;纵向列打开的/最近关闭的标签页) */}
      <div style={{ position: 'relative', display: 'inline-flex', flex: 'none' }} ref={searchAnchorRef}>
        <button
          type="button"
          aria-label={t('Search tabs', '搜索标签页')}
          className="sx-iconbtn"
          disabled={disabled}
          onClick={() => setSearchOpen((o) => !o)}
        >
          <ChevronsDown size={15} strokeWidth={1.75} />
        </button>
        {searchOpen && (
          <TabSearchPop
            tabs={tabs}
            activeUid={activeUid}
            recentClosed={recentClosed ?? []}
            onSelect={onSelect}
            onCloseTab={onClose}
            onReopen={(i) => onReopenClosed?.(i)}
            onDone={() => setSearchOpen(false)}
          />
        )}
      </div>
      {/* G14.39:标签滚动区独立(overflow-x auto 只裁标签);+/弹窗在滚动区外,弹窗不被条裁切 */}
      <div className="sx-tabstrip-scroll" ref={scrollRef}>
      {tabs.map((t) => {
        const entry = tabEntry(t.type);
        // G14.2xx file 标签撞名 → 最小区分相对路径;其余回落 registry 原题
        const title = titles.get(t.uid) ?? entry.title(t.params);
        const Icon = TAB_ICONS[t.type] ?? FileText;
        // G14.211 文件标签显对应文件类型图标(vscode-icons 集内);未命中回落通用文档图标
        const filePath = t.type === 'file' ? t.params.path : undefined;
        const useFileIcon = filePath !== undefined && hasFileTypeIcon(filePath);
        return (
          <button
            key={t.uid}
            type="button"
            className={`sx-tab${t.uid === activeUid ? ' active' : ''}`}
            data-title={title}
            data-tip={title}
            disabled={disabled}
            draggable={!disabled}
            onDragStart={(e) => {
              dragUidRef.current = t.uid;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/tab-uid', t.uid);
            }}
            onDragOver={(e) => {
              if (dragUidRef.current !== null && dragUidRef.current !== t.uid) e.preventDefault(); // 允许落点
            }}
            onDrop={(e) => {
              e.preventDefault();
              const from = dragUidRef.current;
              dragUidRef.current = null;
              if (from !== null && from !== t.uid) onReorder?.(from, t.uid);
            }}
            onClick={() => onSelect(t.uid)}
          >
            {useFileIcon && filePath !== undefined ? (
              <FileIcon path={filePath} size={16} />
            ) : (
              <Icon size={16} strokeWidth={1.75} />
            )}
            <span
              className="sx-tab-title"
              ref={(el) => {
                if (el === null) titleRefs.current.delete(t.uid);
                else titleRefs.current.set(t.uid, el);
              }}
            >
              {title}
            </span>
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
      </div>
      {/* G14.39:「+」弹窗跟随按钮、开在其下(相对锚容器;原 absolute right:8px 钉右缘) */}
      <div className="sx-strip-newtab" style={{ position: 'relative', display: 'inline-flex', flex: 'none' }} ref={menuAnchorRef}>
      <button
        type="button"
        aria-label="new tab"
        className="sx-iconbtn"
        disabled={disabled}
        onClick={() => {
          setMenuOpen((o) => !o);
        }}
      >
        <Plus size={16} strokeWidth={1.75} />
      </button>
      {menuOpen && (
        <div className="sx-menu-pop" role="menu" aria-label="new tab types">
          {GROUP_ORDER.map((g) => {
            // G14.159 文件/上下文不走「+」菜单:文件由目录树/工具行开档,上下文面板按需经命令;已有标签不受影响
            const entries = TAB_REGISTRY.filter((e) => e.group === g && !MENU_HIDDEN.has(e.id));
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
      </div>
      {collapseBtn(true)}
    </div>
  );
}
