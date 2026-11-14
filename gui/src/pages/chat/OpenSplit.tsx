import { useState } from 'react';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { SessionRowMenu, type SessionRowMenuItem } from '../../sidebar/session-row-menu';
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

function EditorGlyph({ id, icons, size = 14 }: { id: string; icons: Record<string, string>; size?: number }): JSX.Element {
  const url = icons[id] ?? editorIconCached(id);
  if (url !== undefined) return <img src={url} alt="" style={{ width: size, height: size, display: 'block', objectFit: 'contain' }} />;
  return <ExternalLink size={size - 2} strokeWidth={1.75} />;
}
void EditorGlyph;

/** 「打开 ▾」统一动作钮(2026-11-14 用户裁定「所有的都是同一 打开 ▾」):主钮=该类产物的主动作
 *  (file=侧栏预览/url=右栏 Web 页签/command=复制),caret=选项菜单;菜单项点击=立即执行。
 *  useEditors=true(file 类)=菜单由 /app/editors 实装清单+系统默认装配(原生图标+反误触缺省);
 *  否则用调用方 items(url=系统浏览器/command=复制命令)。主钮文案统一「打开」,command 类复制
 *  后短暂回显「已复制」 */
export function OpenSplit({ conn, onOpError, useEditors = false, label, onOpenDefault, onOpenWith, items = [], ariaLabel }: {
  conn?: Connection;
  onOpError?: (err: unknown) => void;
  /** useEditors=true(file 类)=菜单由 /app/editors 实装清单+系统默认装配,onOpenWith 承接选择 */
  useEditors?: boolean;
  label?: string;
  onOpenDefault: () => void;
  /** useEditors 菜单内选中已装应用/系统默认后的执行面 */
  onOpenWith?: (id: string) => void;
  items?: SessionRowMenuItem[];
  ariaLabel: string;
}): JSX.Element {
  const [editors, setEditors] = useState<Array<{ id: string; name: string }>>([]);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const ensureEditors = (): void => {
    if (!useEditors || conn === undefined) return;
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
    return <ExternalLink size={14} strokeWidth={1.75} />;
  };

  const resolvedItems: SessionRowMenuItem[] = useEditors
    ? [
        ...editors.map((e) => ({
          id: e.id,
          label: e.name,
          icon: glyph(e.id),
          onSelect: () => {
            setMenu(null);
            onOpenWith?.(e.id);
          },
        })),
        { id: 'sx-divider', label: '', divider: true, onSelect: () => {} },
        {
          id: 'default',
          label: t('System default', '系统默认'),
          icon: <ExternalLink size={14} strokeWidth={1.75} />,
          onSelect: () => {
            setMenu(null);
            onOpenWith?.('default');
          },
        },
      ]
    : items;

  return (
    <span className="sx-artifacts-open">
      <button type="button" className="sx-artifacts-openbtn" aria-label={ariaLabel} onClick={onOpenDefault}>
        {label ?? t('Open', '打开')}
      </button>
      <button
        type="button"
        className="sx-artifacts-caret"
        aria-label="options"
        data-tip={t('Options', '更多方式')}
        onClick={(e) => toggle(e.currentTarget)}
      >
        <ChevronDown size={14} strokeWidth={2} />
      </button>
      {menu !== null && <SessionRowMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={resolvedItems} />}
    </span>
  );
}
