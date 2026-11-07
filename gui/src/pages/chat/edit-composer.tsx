import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, MutableRefObject, SetStateAction } from 'react';
import { ArrowUp, X } from 'lucide-react';
import { ComposerCard } from '../../composer/ComposerCard';
import { ComposerPlusPanel } from '../../composer/ComposerPlusPanel';
import { CommandPalette } from '../../CommandPalette';
import type { CmdItem } from '../../CommandPalette';
import { pathBasename } from '../../ui-util';
import { zoomScale } from '../../ui-zoom';
import { t } from '../../i18n';
import { PlusAddIcon } from '../../sidebar/project-menu-util';
import { FilePalette, RefPalette, fileHit, rankFileHits, refContentRegistry, renderMentionSpans, slashTokenAt, splitMentionTokens } from './mention';
import { flatRefItems, refTokenAt } from './ref-palette';
import type { RefEntries, RefItem, RefPal } from './ref-palette';
import { slashItemsFor, useCommandPalette } from './use-command-palette';
import { useComposerKeys } from './use-composer-keys';
import { useWorkspaceFiles } from './use-workspace-files';
import type { Connection } from '../../connection';

/**
 * 编辑卡输入面(2026-11-06 用户裁定「编辑页直接替换成底部输入框的样式大小」):ComposerCard 同款壳
 * + 同款触发面——/ 命令面板、@ 文件面板、$/# 引用面板、+ 附加面板、token 原子性守卫全量
 * (useComposerKeys 参数化注入,面板态归本组件私有);差异只有三件:无权限档/上下文圆环/模型
 * pills,footer 左侧只留「+」,右侧=取消 X(32px 与发送钮同规格)+发送。@短写记账(pickRelRef)
 * 由 Chat 共享注入——编辑卡选中的文件在发送期(宿主 resendFrom)照样展开。
 * 弹出层视口适配:面板锚卡根向上开(bottom:100%),编辑卡贴转录顶部时上溢——每次渲染量测可见
 * 面板矩形,上方不够即整卡临时下移(关面板回原位),下方越界滚最近的滚动祖先带回。
 */
export function EditComposer({ conn, sessionId, root, pickRelRef, value, onChange, images, onRemoveImage, onImageOpen, onAddImageFiles, onSend, onCancel, onOpenFile }: {
  conn: Connection;
  sessionId: string;
  root?: string;
  /** @短写 → 相对路径记账表(Chat 注入共享——发送期宿主据此展开) */
  pickRelRef: MutableRefObject<Map<string, string>>;
  value: string;
  onChange: Dispatch<SetStateAction<string>>;
  images: string[];
  onRemoveImage: (index: number) => void;
  onImageOpen: (src: string) => void;
  onAddImageFiles: (files: File[]) => void;
  onSend: () => void;
  onCancel: () => void;
  onOpenFile?: (p: string) => void;
}): JSX.Element {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const zoneRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const { resolveFileRef, loadWorkspaceFiles } = useWorkspaceFiles(conn, sessionId, root, pickRelRef);
  const { cmdData, setCmdData, cmdActive, setCmdActive, skills } = useCommandPalette(conn, root);
  const [filePal, setFilePal] = useState<{ query: string; from: number } | null>(null);
  const [filePalFiles, setFilePalFiles] = useState<string[]>([]);
  const [filePalActive, setFilePalActive] = useState(0);
  const [refPal, setRefPal] = useState<RefPal | null>(null);
  const [refActive, setRefActive] = useState(0);
  const refEntriesLoadedRef = useRef(false);
  const [refEntries, setRefEntries] = useState<RefEntries>({ agents: [], teams: [] });
  const [pillOpen, setPillOpen] = useState<'plus' | null>(null);
  const [compRange, setCompRange] = useState<{ start: number; end: number } | null>(null);
  /** 两目录缓存(agents+teams id/name 投影;首触懒拉,失败静默空列——Chat 同款守卫) */
  const loadRefEntries = useCallback((): void => {
    if (refEntriesLoadedRef.current) return;
    refEntriesLoadedRef.current = true;
    const refRoot = root !== undefined && root !== '' && root !== 'default' ? root : undefined;
    void Promise.all([conn.agentsView(refRoot), conn.teamsView(refRoot)]).then(
      ([a, tv]) => {
        setRefEntries({
          agents: [
            ...a.builtins.map((b) => ({ id: b.role, name: b.name })),
            ...a.view.entries.filter((e) => !e.shadowed).map((e) => ({ id: e.id, name: e.name })),
          ].filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i),
          teams: tv.view.entries.filter((e) => !e.shadowed).map((e) => ({ id: e.id, name: e.name })),
        });
      },
      () => {}, // 失败静默:entries 保持空列(面板无项不开;不重试——零网络纪律)
    );
  }, [conn, root]);

  const composerKeys = useComposerKeys({
    input: value,
    setInput: onChange,
    inputRef: taRef,
    composingRef,
    filePal,
    setFilePal,
    filePalFiles,
    setFilePalFiles,
    filePalActive,
    setFilePalActive,
    loadWorkspaceFiles,
    pickRelRef,
    refPal,
    setRefPal,
    refEntries,
    refActive,
    setRefActive,
    loadRefEntries,
    cmdData,
    setCmdData,
    cmdActive,
    setCmdActive,
    skills,
    conn,
    sessionId,
    send: onSend,
  });

  /** 面板跟随输入(光标前 @token/$#token 即开)——Chat onChange 同款 */
  const handleChange = (v: string): void => {
    onChange(v);
    const caret = taRef.current?.selectionStart ?? v.length;
    const m = /@([\w./:\\-]*)$/.exec(v.slice(0, caret));
    const rt = refTokenAt(v, caret);
    if (m !== null) {
      setFilePal({ query: m[1] ?? '', from: caret - (m[1]?.length ?? 0) - 1 });
      setFilePalActive(0);
      void loadWorkspaceFiles().then((files) => setFilePalFiles(files));
      setRefPal(null);
    } else if (rt !== null) {
      setRefPal(rt);
      setRefActive(0);
      loadRefEntries();
    } else {
      if (filePal !== null) setFilePal(null);
      if (refPal !== null) setRefPal(null);
    }
  };

  /** Esc 双义:有面板在开=关面板(useComposerKeys 分支);无面板=关编辑卡(宿主 onCancel) */
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
      const caret = taRef.current?.selectionStart ?? value.length;
      const tok = slashTokenAt(value, caret);
      const paletteOpen =
        (filePal !== null && value[filePal.from] === '@')
        || (refPal !== null && (value[refPal.from] === '$' || value[refPal.from] === '#'))
        || (tok !== null && slashItemsFor(cmdData, tok, skills).length > 0)
        || pillOpen !== null;
      if (!paletteOpen) {
        e.preventDefault();
        onCancel();
        return;
      }
    }
    composerKeys.onKeyDown(e);
  };

  /** 渲染期面板项(/ 命令+技能;$#/引用)——与键控面同源防漂移(Chat 同款) */
  const slashPanelItems: CmdItem[] | null = (() => {
    const caret = taRef.current?.selectionStart ?? value.length;
    const items = slashItemsFor(cmdData, slashTokenAt(value, caret), skills ?? []);
    return items.length > 0 ? items : null;
  })();
  const refPanelItems: RefItem[] | null = (() => {
    if (refPal === null) return null;
    if (value[refPal.from] !== '$' && value[refPal.from] !== '#') return null;
    return flatRefItems(refEntries, refPal.query, refPal.sym);
  })();

  const overlay = useMemo(
    () => (
      <>
        {refPal !== null && refPanelItems !== null ? (
          <RefPalette
            items={refPanelItems}
            emptyHint={t('No matching entry', '无匹配条目')}
            active={Math.max(0, Math.min(refActive, refPanelItems.length - 1))}
            onHover={setRefActive}
            onPick={(item) => {
              const from = refPal.from;
              const end = from + 1 + refPal.query.length;
              onChange((prev: string) => {
                const head = prev.slice(0, from);
                const sep = head !== '' && /\S$/.test(head) ? ' ' : '';
                return head + sep + `${item.sym}${item.id} ` + prev.slice(Math.max(end, from));
              });
              setRefPal(null);
              taRef.current?.focus();
            }}
          />
        ) : filePal !== null && value[filePal.from] === '@' && filePalFiles.some((f) => fileHit(f, filePal.query)) ? (
          <FilePalette
            items={rankFileHits(filePalFiles, filePal.query)}
            active={Math.min(filePalActive, 11)}
            onHover={setFilePalActive}
            onPick={(p) => {
              const base = pathBasename(p);
              pickRelRef.current.set(base, p);
              const atFrom = filePal.from;
              const atEnd = atFrom + 1 + filePal.query.length;
              onChange((prev: string) => prev.slice(0, atFrom) + `@${base} ` + prev.slice(Math.max(atEnd, atFrom)));
              setFilePal(null);
              taRef.current?.focus();
            }}
          />
        ) : pillOpen === 'plus' ? (
          <ComposerPlusPanel
            conn={conn}
            sessionId={sessionId}
            root={root}
            onAttachImages={onAddImageFiles}
            onInsert={(text) => {
              onChange((v: string) => (v.trim() === '' ? text : `${v.replace(/\s+$/, '')} ${text}`));
              setPillOpen(null);
              taRef.current?.focus();
            }}
          />
        ) : slashPanelItems !== null ? (
          (() => {
            const items = slashPanelItems;
            const active = Math.min(cmdActive, Math.max(0, items.length - 1));
            const pick = (item: CmdItem): void => {
              if (!item.ok) return;
              const tok = slashTokenAt(value, value.length);
              const from = tok !== null ? tok.from : value.length;
              const caret = taRef.current?.selectionStart ?? value.length;
              const head = value.slice(0, from);
              const sep = head !== '' && /\S$/.test(head) ? ' ' : '';
              onChange(head + sep + item.cmd + ' ' + value.slice(caret));
            };
            return <CommandPalette items={items} active={active} onHover={setCmdActive} onPick={pick} />;
          })()
        ) : null}
      </>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 面板链整体随输入态换身份(Chat 同口径)
    [refPal, refPanelItems, refActive, filePal, filePalFiles, filePalActive, pillOpen, slashPanelItems, cmdActive, value],
  );

  /** 弹出层视口适配。上方空间不足(2026-11-07 用户裁定「上面不够时整体向下移动一下,弹窗关掉后
   *  再回到原来位置」):面板向上开,编辑卡贴转录顶部时被滚动容器上沿(会话顶栏下缘)裁掉,且滚动位
   *  已到顶、滚无可滚——整张卡(连面板)translateY 下移到面板完整可见,面板关闭即清位移回原位
   *  (transform 不占布局,滚动位零副作用)。下方越界照旧滚最近滚动祖先带回 */
  const shiftRef = useRef(0);
  useLayoutEffect(() => {
    const zone = zoneRef.current;
    const wrap = cardRef.current;
    if (zone === null || wrap === null) return;
    // 位移按视觉 px 记账(与 gBCR 量测同空间),落样式归一本地 px(界面放缩下 /zoom,ui-zoom.ts 契约)
    const setShift = (px: number): void => {
      shiftRef.current = px;
      wrap.style.transform = px > 0 ? `translateY(${px / zoomScale()}px)` : '';
      // 下移后的卡压在后续条目上:抬层防被定位条目盖住(低于 dock 的 5)
      wrap.style.zIndex = px > 0 ? '4' : '';
    };
    const pal = zone.querySelector<HTMLElement>('.file-palette,.ref-palette,.cmd-palette,.sx-plus-panel');
    if (pal === null) {
      if (shiftRef.current !== 0) setShift(0);
      return;
    }
    let scroller: HTMLElement | null = null;
    for (let el: HTMLElement | null = wrap.parentElement; el !== null; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') {
        scroller = el;
        break;
      }
    }
    const PAD = 12;
    const fit = (): void => {
      // 自然位量测:先撤位移再量——带位移量测会把「已下移」误判为够了而回弹
      wrap.style.transform = '';
      const rect = pal.getBoundingClientRect();
      const topBound = Math.max(0, scroller?.getBoundingClientRect().top ?? 0) + PAD;
      const dockTop = wrap.closest('.sx-main')?.querySelector('.chat-dock')?.getBoundingClientRect().top;
      const room = Math.min(window.innerHeight, dockTop ?? window.innerHeight) - PAD - wrap.getBoundingClientRect().bottom;
      const need = Math.round(Math.min(topBound - rect.top, Math.max(0, room)));
      // 面板开着期间位移只增不减(候选项随输入增减,卡位不跟着上下跳);关面板归零回原位
      const shift = Math.max(shiftRef.current, need, 0);
      setShift(shift);
      if (shift > 0) return;
      if (rect.bottom > window.innerHeight - PAD && scroller !== null) scroller.scrollTop += (rect.bottom - (window.innerHeight - PAD)) / zoomScale();
    };
    fit();
    // 面板自身异步长高(+ 面板的命令/技能清单后到)不经本组件重渲染——盯面板尺寸重算
    const ro = new ResizeObserver(fit);
    ro.observe(pal);
    return () => ro.disconnect();
  });

  /** 宽度对齐底部输入框(2026-11-06 用户实测「宽度没有对齐,太窄」):编辑卡在转录内容盒内,
   *  盒宽与盒位都和 .chat-dock(composer 容器)不同源,纯公式/margin-auto 算不齐(实测同宽仍右偏
   *  11px)——直接量测同主区 composer 实宽钉宽 + composer 左缘相对条目盒的偏移钉 margin-left,
   *  ResizeObserver 跟随窗宽/右栏宽变化;找不到 composer(旁路面)回落 CSS 缺省宽 */
  useLayoutEffect(() => {
    const wrap = cardRef.current;
    if (wrap === null) return;
    const main = wrap.closest('.sx-main');
    const composer = (main ?? document).querySelector('.chat-dock .chat-composer');
    if (composer === null) return;
    // 量测为视觉 px、样式为本地 px:界面放缩(根 zoom≠1)下须 /zoom 归一——不除则卡宽×zoom
    // 越出视口压到右栏下(2026-11-07 用户实测 110% 编辑卡超出视口),左缘补偿同理
    const apply = (): void => {
      const z = zoomScale();
      const cr = composer.getBoundingClientRect();
      wrap.style.width = `${cr.width / z}px`;
      // 左缘自校正(2026-11-06):父盒(.entry-user,flex 尾对齐+内边距)的合位规则绕不准——
      // 置零 margin 量出自然左缘相对 composer 左缘的偏差,再反向补偿,对任意父盒规则成立
      wrap.style.marginLeft = '0px';
      const wr = wrap.getBoundingClientRect();
      wrap.style.marginLeft = `${(cr.left - wr.left) / z}px`;
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(composer);
    // 放缩切换时 composer 本地尺寸可不变(RO 不触发),applyZoom 派发的 resize 兜底重算
    window.addEventListener('resize', apply);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', apply);
    };
  }, []);

  useLayoutEffect(() => {
    taRef.current?.focus();
  }, []);

  /** 面板点外自动收(2026-11-06 用户实测「+ 显示后,点击其他地方要自动关闭」):pointerdown 落
   *  编辑卡外即收全部浮层(+面板/@文件/$#/引用);面板行锚卡内,选中点击不受影响(Chat 点外即收同款) */
  // 2026-11-06 用户裁定续「点击编辑框内部也要关掉 + 弹出层」:卡内点击(面板本体与 + 钮自持除外)
  // 亦收 + 面板;@/$# 面板随光标前 token 自开合,卡内点击不动
  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Element)) return;
      if (!e.target.closest('.user-edit-composer')) {
        setPillOpen(null);
        setFilePal(null);
        setRefPal(null);
      } else if (!e.target.closest('.user-edit-overlay-zone') && !e.target.closest('.composer-plus-btn')) {
        setPillOpen(null);
      }
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, []);

  // 编辑卡私有账本(2026-11-07):规范化改名须迁账本才有内容可搬——渲染期从全局注册表补种
  // 当前值内全部 ref token(幂等;子 ComposerCard effect 先于本组件 effect,种子必须在渲染期)
  const editLedger = useRef(new Map<string, string>());
  for (const tk of splitMentionTokens(value)) {
    if (tk.kind === 'ref' && !editLedger.current.has(tk.text)) {
      const c = refContentRegistry.get(tk.text);
      if (c !== undefined) editLedger.current.set(tk.text, c);
    }
  }
  return (
    <div className="user-edit-composer" ref={cardRef}>
      <ComposerCard
        label="edit message"
        refLedger={editLedger}
        value={value}
        placeholder={t('Edit message', '编辑消息')}
        rows={Math.min(6, Math.max(1, (value.match(/\n/g) ?? []).length + 1))}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBeforeInput={composerKeys.onBeforeInput}
        onPasteGuard={composerKeys.onPasteGuard}
        onCompositionGuard={composerKeys.onCompositionGuard}
        onCompositionRange={setCompRange}
        onCompositionEndGuard={composerKeys.onCompositionEndGuard}
        onSelectGuard={composerKeys.onSelectGuard}
        overlays={<div className="user-edit-overlay-zone" ref={zoneRef}>{overlay}</div>}
        inputRef={taRef}
        highlight={renderMentionSpans(value, resolveFileRef, undefined, onOpenFile, true, compRange)}
        onDropFile={(rel) => {
          const bare = rel.replace(/[\\/]+$/, '');
          const isDir = bare !== rel;
          const ta = taRef.current;
          const pos = ta?.selectionStart ?? value.length;
          const base = bare.split(/[\\/]/).filter(Boolean).pop() ?? bare;
          pickRelRef.current.set(base, isDir ? `${bare}/` : bare);
          onChange((prev: string) => prev.slice(0, pos) + `@${base} ` + prev.slice(pos));
          taRef.current?.focus();
        }}
        images={images}
        onRemoveImage={onRemoveImage}
        onImageOpen={onImageOpen}
        onPasteFiles={onAddImageFiles}
        footLeft={
          <div className="composer-pills">
            <button
              type="button"
              className="composer-pill composer-plus-btn"
              aria-label="add"
              aria-expanded={pillOpen === 'plus'}
              data-tip={t('Add context', '添加上下文')}
              onClick={() => setPillOpen((v) => (v === 'plus' ? null : 'plus'))}
            >
              <PlusAddIcon size={16} />
            </button>
          </div>
        }
        footRight={
          <div className="composer-pills">
            <button
              type="button"
              className="user-edit-cancel"
              aria-label="cancel edit"
              data-tip={t('Cancel', '取消')}
              onClick={onCancel}
            >
              <X size={16} strokeWidth={2} aria-hidden="true" />
            </button>
            <button type="button" className="send tip-right" aria-label="send edit" data-tip={`${t('Send', '发送')} · Enter`} onClick={onSend}>
              <ArrowUp size={16} strokeWidth={2.25} aria-hidden="true" />
            </button>
          </div>
        }
      />
    </div>
  );
}

export interface ComposerEnv {
  sessionId: string;
  pickRelRef: MutableRefObject<Map<string, string>>;
}

