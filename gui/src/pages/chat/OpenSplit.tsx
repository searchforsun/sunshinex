import { useState } from 'react';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { SessionRowMenu } from '../../sidebar/session-row-menu';
import { editorIconCached, editorIconPut } from '../../ui-util';
import { t } from '../../i18n';
import type { Connection } from '../../connection';

/** 编辑器清单模块级缓存:产物卡×N 只发一次 /app/editors(与 ChatTopbar 抖动根修同口径) */
let editorsCache: Array<{ id: string; name: string }> | null = null;
let editorsPromise: Promise<Array<{ id: string; name: string }>> | null = null;

async function loadEditors(conn: Connection): Promise<Array<{ id: string; name: string }>> {
  if (editorsCache !== null) return editorsCache;
  editorsPromise ??= conn
    .editorsList()
    .then((r) => {
      editorsCache = r.editors;
      return r.editors;
    })
    .catch((err: unknown) => {
      editorsPromise = null; // 失败不毒化:下次 caret 打开重试(SDD T10 审查裁定)
      throw err;
    });
  return editorsPromise;
}

const NATIVE_FALLBACK: Readonly<Record<string, string>> = { explorer: 'default-folder', vscode: 'file-type-vscode', cursor: 'folder-type-cursor' };

/** 「打开 ▾」分体钮共用件(2026-11-12 spec §5.4):主钮=调用方默认动作(产物卡/产物库=侧栏预览),
 *  ∨=已装应用+「系统默认」菜单;菜单项点击=立即以该目标打开(与顶栏「选中仅设默认」的反误触
 *  语义刻意区分——卡片菜单是单文件动作,spec §5.2) */
export function OpenSplit({ conn, onOpError, onOpenDefault, onOpenWith, ariaLabel }: {
  conn: Connection;
  onOpError?: (err: unknown) => void;
  onOpenDefault: () => void;
  onOpenWith: (id: string) => void;
  ariaLabel: string;
}): JSX.Element {
  const [editors, setEditors] = useState<Array<{ id: string; name: string }>>([]);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const ensureEditors = (): void => {
    loadEditors(conn)
      .then((list) => {
        setEditors(list);
        for (const e of list) {
          if (icons[e.id] !== undefined) continue;
          conn
            .editorIcon(e.id)
            .then((r) => {
              const url = `data:${r.mime};base64,${r.data}`;
              editorIconPut(e.id, url);
              setIcons((prev) => ({ ...prev, [e.id]: url }));
            }, () => {})
            .catch(() => {});
        }
      })
      .catch((err: unknown) => onOpError?.(err));
  };

  const toggle = (anchor: HTMLElement): void => {
    if (menu !== null) {
      setMenu(null);
      return;
    }
    ensureEditors();
    const b = anchor.getBoundingClientRect();
    setMenu({ x: b.right, y: b.bottom + 2 });
  };

  const glyph = (id: string): JSX.Element => {
    const url = icons[id] ?? editorIconCached(id);
    if (url !== undefined) return <img src={url} alt="" style={{ width: 14, height: 14, display: 'block', objectFit: 'contain' }} />;
    const key = NATIVE_FALLBACK[id];
    if (key === undefined) return <ExternalLink size={14} strokeWidth={1.75} />;
    return <ExternalLink size={14} strokeWidth={1.75} />;
  };

  return (
    <span className="sx-artifacts-open">
      <button type="button" className="sx-artifacts-openbtn" aria-label={ariaLabel} onClick={onOpenDefault}>
        {t('Open', '打开')}
      </button>
      <button
        type="button"
        className="sx-artifacts-caret"
        aria-label="open with"
        data-tip={t('Open with', '打开方式')}
        onClick={(e) => toggle(e.currentTarget)}
      >
        <ChevronDown size={14} strokeWidth={2} />
      </button>
      {menu !== null && (
        <SessionRowMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...editors.map((e) => ({
              id: e.id,
              label: e.name,
              icon: glyph(e.id),
              onSelect: () => {
                setMenu(null);
                onOpenWith(e.id);
              },
            })),
            { id: 'sx-divider', label: '', divider: true, onSelect: () => {} },
            {
              id: 'default',
              label: t('System default', '系统默认'),
              icon: <ExternalLink size={14} strokeWidth={1.75} />,
              onSelect: () => {
                setMenu(null);
                onOpenWith('default');
              },
            },
          ]}
        />
      )}
    </span>
  );
}
