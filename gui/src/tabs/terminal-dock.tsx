import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Plus, X } from 'lucide-react';
import type { Connection } from '../connection';
import { t } from '../i18n';
import { pathBasename } from '../ui-util';
import { TerminalTab } from './TerminalTab';

/**
 * 2026-11-10 终端下栏(terminal dock,用户需求「主对话 composer 下方内嵌终端」):
 * 标签条 + 拖高把手 + 标签体三段;标签体复用右栏同款 TerminalTab(pty 记账/kill 链同一 App 单点——
 * uid 即寻址键,`dock-term-<n>` 与右栏页签 uid 空间不相交)。
 * 生命周期口径:面板关(×)只卸载不 kill(TerminalTab dispose 不 kill,重开经 ptyIdFor 重连 replay
 * 还原屏面);标签 × 走 App onCloseTab(既有 takePtyId→killPty 链)。标签清单/激活/高度/计数
 * 全落 localStorage 按会话键绑定(切会话/重启各回各档),面板重开原样恢复。
 * 2026-11-10 改版(用户实测六条):①面板=主对话对等区(.sx-main 直子,滚条 bottom 让位)非 chat-dock 内;
 * ②页签条形样式对齐侧栏页签(.sx-tab 同形),缺省名=项目名+序号;③面板 × 右缘常显;④页签点击切换;
 * ⑤档按会话绑定;⑥入口图标 16px 对齐窗控钮。
 */

const LS_SESSIONS = 'sunshinex.terminal-dock.sessions';
const LS_HEIGHT = 'sunshinex.terminal-dock-h';

/** 会话绑定档(2026-11-10 用户裁定「页签样式持久化和会话绑定,重启/切会话保持原状」):
 *  {sessionId: {open, tabs, active}} 一档映射;高度全局一档(窗口形状相关不分会话) */
export interface DockSessionState {
  open: boolean;
  tabs: DockTab[];
  active: string;
}
const loadSession = (sessionId: string): DockSessionState => {
  const all = lsRead<Record<string, DockSessionState>>(LS_SESSIONS, {});
  const hit = all[sessionId];
  if (hit !== undefined && Array.isArray(hit.tabs)) return hit;
  return { open: false, tabs: [], active: '' };
};
/** 会话档读取(Chat 挂载前取开态用) */
export function loadDockSession(sessionId: string): DockSessionState {
  return loadSession(sessionId);
}
const saveSession = (sessionId: string, state: DockSessionState): void => {
  const all = lsRead<Record<string, DockSessionState>>(LS_SESSIONS, {});
  all[sessionId] = state;
  lsWrite(LS_SESSIONS, all);
};

/** 单标签:uid=pty 记账/恢复寻址键(稳定不随改名变),name=用户可见名(可双击改名) */
export interface DockTab {
  readonly uid: string;
  name: string;
}

const HEIGHT_MIN = 120;
/** 主对话保底:dock 顶不得把 composer 区压到 <~320px(窗口 resize 时重钳) */
const CHAT_MIN = 320;
const HEIGHT_DEFAULT = 260;

const lsRead = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
};
const lsWrite = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 隐私模式等写失败静默:dock 档是尽力而为的便利,不入错误面
  }
};

/** 会话首开缺省:一签,名=项目名(无编号);二签起=项目名+序号(用户裁定「不是 终端123,是项目名123」) */
const defaultTab = (root: string, n: number): DockTab => {
  const base = pathBasename(root || '') || t('Terminal', '终端');
  return { uid: `dock-term-${n}`, name: n === 1 ? base : `${base}${n}` };
};

/** 下一编号=既有 uid 序号最大值 +1(删中段不重号;持久化计数器省一条档,口径等价) */
const nextUidOf = (tabs: DockTab[]): { uid: string; n: number } => {
  let max = 0;
  for (const x of tabs) {
    const m = /^dock-term-(\d+)$/.exec(x.uid);
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  return { uid: `dock-term-${max + 1}`, n: max + 1 };
};

const clampHeight = (h: number): number => {
  const ceiling = Math.max(HEIGHT_MIN, (typeof window === 'undefined' ? 720 : window.innerHeight) - CHAT_MIN);
  return Math.min(ceiling, Math.max(HEIGHT_MIN, h));
};

export interface TerminalDockProps {
  readonly conn: Connection;
  readonly sessionId: string;
  /** pty 记账读写(App usePtyRegistry 同一单点;dock uid 与右栏页签 uid 不相交) */
  readonly ptyIdFor: (uid: string) => string | undefined;
  readonly onPtyAllocated: (uid: string, ptyId: string) => void;
  /** 标签 ×:App 侧既有 kill 链(takePtyId→killPty)——面板 × 不走此(保 pty 活) */
  readonly onCloseTab: (uid: string) => void;
  /** 项目根(缺省页签名=项目名,2026-11-10 用户裁定「不是 终端123,是项目名123」) */
  readonly root?: string;
  /** 高度上报(Chat 滚动条让位 bottomOffset 用) */
  readonly onHeightChange: (h: number) => void;
  /** 面板 ×:宿主(Chat)收面板态——只卸载不 kill,标签档/pty 全保 */
  readonly onHide: () => void;
}

export function TerminalDock({ conn, sessionId, root, ptyIdFor, onPtyAllocated, onCloseTab, onHide, onHeightChange }: TerminalDockProps): JSX.Element {
  /** 会话绑定档:挂载/切会话即从会话键恢复(重启=localStorage 持久,切会话=各回各档);空档给缺省签 */
  const [tabs, setTabs] = useState<DockTab[]>(() => {
    const saved = loadSession(sessionId).tabs.filter((x) => typeof x.uid === 'string' && typeof x.name === 'string');
    return saved.length > 0 ? saved : [defaultTab(root ?? '', 1)];
  });
  const [active, setActive] = useState<string>(() => {
    const saved = loadSession(sessionId);
    return saved.active !== '' && saved.tabs.some((x) => x.uid === saved.active) ? saved.active : (saved.tabs[0]?.uid ?? '');
  });
  const [height, setHeight] = useState<number>(() => clampHeight(lsRead<number>(LS_HEIGHT, HEIGHT_DEFAULT)));
  /** 双击改名进行中:renaming=编辑目标 uid,renameDraft=输入框值(Esc 回退) */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => saveSession(sessionId, { open: true, tabs, active }), [sessionId, tabs, active]);
  useEffect(() => lsWrite(LS_HEIGHT, height), [height]);
  useEffect(() => onHeightChange(height), [height, onHeightChange]);
  /** 窗口 resize 重钳:上限随窗口收,主对话 ≥~320px 保底不破 */
  useEffect(() => {
    const reclamp = (): void => setHeight((h) => clampHeight(h));
    window.addEventListener('resize', reclamp);
    return () => window.removeEventListener('resize', reclamp);
  }, []);

  const activeTab = tabs.find((x) => x.uid === active) ?? tabs[0];

  /** + 追加新签并激活(uid 序号续号,名字 t() 随语言) */
  const addTab = useCallback((): void => {
    const { uid, n } = nextUidOf(tabs);
    setTabs((cur) => [...cur, defaultTab(root ?? '', n)]);
    setActive(uid);
  }, [tabs, root]);

  /** 标签 ×:App kill 链保 pty 不泄漏;最后一条删掉即补新签(终端 dock 恒 ≥1) */
  const removeTab = useCallback((uid: string): void => {
    onCloseTab(uid);
    const rest = tabs.filter((x) => x.uid !== uid);
    if (rest.length === 0) {
      const { uid: uid2, n } = nextUidOf(tabs);
      setTabs([defaultTab(root ?? '', n)]);
      setActive(uid2);
      return;
    }
    setTabs(rest);
    if (uid === active) setActive(rest[0]!.uid);
  }, [tabs, active, onCloseTab, root]);

  const commitRename = useCallback((): void => {
    if (renaming === null) return;
    const uid = renaming;
    const name = renameDraft.trim().slice(0, 40) || t('Terminal', '终端');
    setRenaming(null);
    setTabs((cur) => cur.map((x) => (x.uid === uid ? { ...x, name } : x)));
  }, [renaming, renameDraft]);

  /** 拖高把手:pointer capture 跟手;起点锚定(startY/startH)免累积漂移;向上拖=增高 */
  const onHandlePointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startH: height };
  };
  const onHandlePointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    setHeight(clampHeight(drag.startH + (drag.startY - e.clientY)));
  };
  const onHandlePointerUp = (): void => {
    dragRef.current = null;
  };

  return (
    <div className="terminal-dock" style={{ height, boxSizing: 'border-box' }}>
      {/* 拖高把手:6px 带,row-resize;主对话最小高度钳在 clampHeight(含 resize 重钳) */}
      <div
        className="terminal-dock-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('Resize terminal dock', '拖动调整终端下栏高度')}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerUp}
      />
      <div className="terminal-dock-strip">
        {tabs.map((x) => (
          <div
            key={x.uid}
            className={'terminal-dock-tab' + (x.uid === activeTab?.uid ? ' active' : '')}
            role="tab"
            aria-selected={x.uid === activeTab?.uid}
            onClick={() => setActive(x.uid)}
          >
            {renaming === x.uid ? (
              <input
                className="terminal-dock-rename"
                autoFocus
                value={renameDraft}
                maxLength={40}
                aria-label={t('Rename terminal tab', '重命名终端标签')}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  else if (e.key === 'Escape') setRenaming(null);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className="terminal-dock-tab-name"
                onDoubleClick={() => {
                  setRenaming(x.uid);
                  setRenameDraft(x.name);
                }}
              >
                {x.name}
              </span>
            )}
            <button
              type="button"
              className="sx-iconbtn terminal-dock-tab-close"
              aria-label={`close terminal ${x.name}`}
              data-tip={t('Close tab', '关闭标签')}
              onClick={() => removeTab(x.uid)}
            >
              <X size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        ))}
        <button type="button" className="sx-iconbtn terminal-dock-add" aria-label="add terminal" data-tip={t('New terminal', '新建终端')} onClick={addTab}>
          <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        {/* 面板 ×:只收面板不 kill pty/不清标签档——再点入口原样恢复(同 uid 重连 replay) */}
        <button
          type="button"
          className="sx-iconbtn terminal-dock-close"
          aria-label="close terminal dock"
          data-tip={t('Hide terminal dock', '收起终端下栏')}
          onClick={() => {
            setRenaming(null);
            onHide();
          }}
        />
      </div>
      <div className="terminal-dock-body">
        {activeTab !== undefined && (
          <TerminalTab
            key={activeTab.uid}
            conn={conn}
            sessionId={sessionId}
            uid={activeTab.uid}
            params={{}}
            ptyIdFor={ptyIdFor}
            onPtyAllocated={onPtyAllocated}
          />
        )}
      </div>
    </div>
  );
}
