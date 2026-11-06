import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';
import { ArrowUp, ChevronDown, Eye, ListTodo, Loader2, ShieldCheck, Unlock } from 'lucide-react';
import { t } from '../i18n';
import type { Connection } from '../connection';
import { ComposerCard } from '../composer/ComposerCard';
import { expandFileRefs, expandRefContents, fileHit, FilePalette, rankFileHits, RefPalette, renderMentionSpans, slashTokenAt } from '../pages/chat/mention';
import { baseModelName, ModeIcon } from '../pages/Chat';
import { EffortSlider } from '../effort-slider';
import { CommandPalette, type CmdItem } from '../CommandPalette';
import { slashItemsFor, useCommandPalette } from '../pages/chat/use-command-palette';
import { useComposerKeys } from '../pages/chat/use-composer-keys';
import { useChatComposerSide } from '../pages/chat/use-chat-composer-side';
import { flatRefItems, refTokenAt, type RefEntries, type RefPal } from '../pages/chat/ref-palette';
import { pathBasename } from '../ui-util';
import { useWorkspaceFiles } from '../pages/chat/use-workspace-files';

/**
 * 辅助会话草稿 composer(2026-11-06 用户裁定「完全复制主对话输入框的能力」):fork 前的草稿态
 * 也要芯片高亮/五面守卫/@ / 命令、$# 三面板/insert-ref 片段通道——交互面与主对话同构,差异仅在
 * 提交(文本经 expandFileRefs/expandRefContents 展开后交 upgrade fork)与无 pills(权限/模型 pill
 * 需会话绑定,草稿未 fork 无会话;升级后真 Chat 自带全量 pills)。
 */
export function SideChatComposer(props: {
  readonly conn: Connection;
  readonly root?: string;
  readonly insert?: string;
  readonly busy: boolean;
  readonly onSend: (text: string) => void;
}): JSX.Element {
  const { conn, root, insert, busy, onSend } = props;
  const [text, setText] = useState(insert ?? '');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const pickRelRef = useRef(new Map<string, string>());
  const refContentsRef = useRef(new Map<string, string>());
  const [filePal, setFilePal] = useState<{ query: string; from: number } | null>(null);
  const [filePalFiles, setFilePalFiles] = useState<string[]>([]);
  const [filePalActive, setFilePalActive] = useState(0);
  const [refPal, setRefPal] = useState<RefPal | null>(null);
  const [refEntries, setRefEntries] = useState<RefEntries>({ agents: [], teams: [] });
  const [refActive, setRefActive] = useState(0);
  const refEntriesLoadedRef = useRef(false);
  const { cmdData, setCmdData, cmdActive, setCmdActive, skills } = useCommandPalette(conn, root);
  /** 工作区文件索引(@ 面板数据部;草稿无会话,缓存键传空串=独立缓存,装载口径同主对话) */
  const { resolveFileRef, loadWorkspaceFiles } = useWorkspaceFiles(conn, '', root, pickRelRef);
  /** agents/teams 引用目录懒加载(Chat.tsx 同款投影:内置并入+shadowed 剔除+去重,失败静默空列) */
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
      () => setRefEntries({ agents: [], teams: [] }),
    );
  }, [conn, root]);
  /** insert-ref 片段通道(主对话圈选「添加到辅助会话」):token 落框+账本,芯片态恢复 */
  const { onInputClick } = useChatComposerSide({
    pickRelRef,
    refContents: refContentsRef,
    inputRef,
    setInput: setText as Dispatch<SetStateAction<string>>,
    input: text,
    resolveFileRef,
    target: 'side',
  });
  // pills 本地态(2026-11-06 P1 用户裁定「欢迎页也有+完全访问等,和主对话一样」):结构/交互
  // 镜像欢迎页 pills(mode/model/强度本地可选);fork 继承主会话配置;无上下文圆圈(未 fork 无 ctx)
  const [mode, setMode] = useState<'read-only' | 'acceptEdits' | 'full-access' | 'plan'>('full-access');
  const [modeOpen, setModeOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelChoices, setModelChoices] = useState<Array<{ id: string; effort?: string }>>([]);
  const [defaultModel, setDefaultModel] = useState<string | undefined>(undefined);
  const [selModel, setSelModel] = useState<string | undefined>(undefined);
  const [selEffort, setSelEffort] = useState<string | undefined>(undefined);
  useEffect(() => {
    conn.settings().then(
      (view) => {
        setDefaultModel(view.keys.find((k) => k.key === 'model')?.value ?? undefined);
        setModelChoices(view.providers.choices);
      },
      () => undefined,
    );
  }, [conn]);
  useEffect(() => {
    if (!modelOpen && !modeOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (e.target instanceof Element && e.target.closest('.sx-menu-pop') === null && e.target.closest('[aria-label="model"]') === null && e.target.closest('[aria-label="approval mode"]') === null) {
        setModelOpen(false);
        setModeOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [modelOpen, modeOpen]);
  const modeLabel = mode === 'plan' ? t('Plan mode', '计划模式') : mode === 'read-only' ? t('Read-only', '只读模式') : mode === 'acceptEdits' ? t('Workspace edits', '工作区编辑') : t('Full access', '完全访问');
  const modeRows: Array<{ separator: true } | { m: 'plan' | 'read-only' | 'acceptEdits' | 'full-access'; label: string; desc: string; icon: JSX.Element; disabled?: boolean }> = [
    { m: 'plan' as const, label: t('Plan mode', '计划模式'), desc: t('Plan first, execute on approval', '先规划，批准后执行'), icon: <ListTodo size={15} strokeWidth={1.75} aria-hidden="true" /> },
    { separator: true },
    { m: 'read-only' as const, label: t('Read-only', '只读模式'), desc: t('Read-only analysis, no changes', '只读分析，不改文件'), icon: <Eye size={15} strokeWidth={1.75} aria-hidden="true" /> },
    { m: 'acceptEdits' as const, label: t('Workspace edits', '工作区编辑'), desc: t('Direct edits in-workspace, asks outside', '工作区内直接改，域外需确认'), icon: <ShieldCheck size={15} strokeWidth={1.75} aria-hidden="true" /> },
    { m: 'full-access' as const, label: t('Full access', '完全访问'), desc: t('Fully automatic, blocks destructive commands', '全自动执行，仅拦破坏性命令'), icon: <Unlock size={15} strokeWidth={1.75} aria-hidden="true" /> },
  ];
  // 2026-11-06 P4:insert 变更回流——草稿已挂载时再次收到「添加到辅助会话」不再失效
  useEffect(() => {
    if (insert === undefined || insert === '') return;
    setText((prev) => (prev.trim() === '' ? insert : `${prev}
${insert}`));
  }, [insert]);
  const send = (): void => {
    if (busy) return;
    const trimmed = expandRefContents(expandFileRefs(text, root, resolveFileRef), refContentsRef.current).trim();
    if (trimmed === '') return;
    onSend(trimmed);
  };
  const composerKeys = useComposerKeys({
    input: text,
    setInput: setText,
    inputRef,
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
    sessionId: '',
    send,
  });
  // 面板跟随输入(WelcomeComposer 同款轻量版:@ 命中开文件面板,$/# 命中开引用面板,互斥)
  const onChange = (v: string): void => {
    setText(v);
    const caret = inputRef.current?.selectionStart ?? v.length;
    const m = /@([\w./:\\-]*)$/.exec(v.slice(0, caret));
    const rt = refTokenAt(v, caret);
    if (m !== null) {
      setFilePal({ query: m[1] ?? '', from: caret - (m[1]?.length ?? 0) - 1 });
      setFilePalActive(0);
      setRefPal(null);
      void loadWorkspaceFiles().then(
        (files) => setFilePalFiles(files),
        () => setFilePalFiles([]),
      );
    } else if (rt !== null) {
      setRefPal(rt);
      setRefActive(0);
      loadRefEntries();
    } else {
      if (filePal !== null) setFilePal(null);
      if (refPal !== null) setRefPal(null);
    }
  };
  // 面板点外即收(Chat.tsx G14.211 同款)
  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Element && !e.target.closest('.sx-composer')) {
        setFilePal(null);
        setRefPal(null);
      }
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape') e.currentTarget.blur();
    composerKeys.onKeyDown(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  // 面板渲染面数据(Chat.tsx 同款:filePal 锚校验/命令清单=supported 过滤+技能行)
  const caret = inputRef.current?.selectionStart ?? text.length;
  const slashToken = slashTokenAt(text, caret);
  const slashPanelItems: CmdItem[] | null = slashToken !== null ? slashItemsFor(cmdData, slashToken, skills) : null;
  const refItems = refPal !== null ? flatRefItems(refEntries, refPal.query, refPal.sym) : null;
  const overlays = (
    <>
      {refPal !== null && refItems !== null ? (
        <RefPalette
          items={refItems}
          emptyHint={t('No matching entry', '无匹配条目')}
          active={Math.max(0, Math.min(refActive, refItems.length - 1))}
          onHover={setRefActive}
          onPick={(item) => {
            const from = refPal.from;
            const end = from + 1 + refPal.query.length;
            setText((prev) => {
              const head = prev.slice(0, from);
              const sep = head !== '' && /\S$/.test(head) ? ' ' : '';
              return head + sep + `${item.sym}${item.id} ` + prev.slice(Math.max(end, from));
            });
            setRefPal(null);
            inputRef.current?.focus();
            requestAnimationFrame(() => {
              const ta = inputRef.current;
              if (ta !== null) {
                const to = Math.min(from + item.id.length + 2, ta.value.length);
                ta.setSelectionRange(to, to);
              }
            });
          }}
        />
      ) : filePal !== null && text[filePal.from] === '@' && filePalFiles.some((f) => fileHit(f, filePal.query)) ? (
        <FilePalette
          items={rankFileHits(filePalFiles, filePal.query)}
          active={Math.min(filePalActive, 11)}
          onHover={setFilePalActive}
          onPick={(p) => {
            const base = pathBasename(p);
            pickRelRef.current.set(base, p);
            const atFrom = filePal.from;
            const atEnd = atFrom + 1 + filePal.query.length;
            setText((prev) => prev.slice(0, atFrom) + `@${base} ` + prev.slice(Math.max(atEnd, atFrom)));
            setFilePal(null);
            inputRef.current?.focus();
            requestAnimationFrame(() => {
              const ta = inputRef.current;
              if (ta !== null) {
                const to = Math.min(atFrom + base.length + 2, ta.value.length);
                ta.setSelectionRange(to, to);
              }
            });
          }}
        />
      ) : slashPanelItems !== null ? (
        (() => {
          const items = slashPanelItems;
          const active = Math.min(cmdActive, Math.max(0, items.length - 1));
          const pick = (item: CmdItem): void => {
            if (!item.ok) return;
            const tok = slashTokenAt(text, text.length);
            const from = tok !== null ? tok.from : text.length;
            const cur = inputRef.current?.selectionStart ?? text.length;
            const head = text.slice(0, from);
            const sep = head !== '' && /\S$/.test(head) ? ' ' : '';
            setText(head + sep + item.cmd + ' ' + text.slice(cur));
            inputRef.current?.focus();
          };
          return <CommandPalette items={items} active={active} onHover={setCmdActive} onPick={pick} />;
        })()
      ) : null}
    </>
  );
  return (
    <ComposerCard
      label="side chat draft"
      inputRef={inputRef}
      value={text}
      rows={Math.min(6, Math.max(1, (text.match(/\n/g) ?? []).length + 1))}
      placeholder={t('Ask something…', '问点什么…')}
      disabled={busy}
      onChange={onChange}
      onKeyDown={onKeyDown}
      onBeforeInput={composerKeys.onBeforeInput}
      onPasteGuard={composerKeys.onPasteGuard}
      onCompositionGuard={composerKeys.onCompositionGuard}
      onCompositionEndGuard={composerKeys.onCompositionEndGuard}
      onSelectGuard={composerKeys.onSelectGuard}
      onInputClick={onInputClick}
      overlays={overlays}
      highlight={renderMentionSpans(text, (n) => pickRelRef.current.get(n) ?? filePalFiles.find((f) => pathBasename(f) === n), undefined, undefined, true)}
      footLeft={
        <div className="pill-anchor">
          <button
            type="button"
            className="composer-pill"
            aria-label="approval mode"
            aria-expanded={modeOpen}
            data-tip={modeLabel}
            onClick={() => setModeOpen((v) => !v)}
          >
            <ModeIcon mode={mode} />
            <span className="pill-label">{modeLabel}</span>
            <ChevronDown className="pill-chevron" size={12} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {modeOpen && (
            <div className="sx-menu-pop pill-pop mode-pop" role="menu" aria-label="approval mode menu">
              {modeRows.map((row, idx) => (
                <div key={'separator' in row ? `sep-${idx}` : row.m} className="mode-pop-group">
                  {'separator' in row ? (
                    <div className="mode-pop-sep" aria-hidden="true" />
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      className={`mode-item${!row.disabled && mode === row.m ? ' active' : ''}`}
                      aria-disabled={row.disabled === true ? true : undefined}
                      onClick={() => {
                        if (row.disabled === true) return;
                        setMode(row.m);
                        setModeOpen(false);
                      }}
                    >
                      <span className="mode-item-icon">{row.icon}</span>
                      <span className="mode-item-body">
                        <span className="mode-item-name">{row.label}</span>
                        <span className="mode-item-desc">{row.desc}</span>
                      </span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      }
      footRight={
        <>
          <div className="pill-anchor">
            <button
              type="button"
              className="composer-pill model-pill"
              aria-label="model"
              aria-expanded={modelOpen}
              data-tip={selModel ?? defaultModel ?? modelChoices[0]?.id ?? undefined}
              onClick={() => setModelOpen((v) => !v)}
            >
              {baseModelName(selModel ?? defaultModel ?? modelChoices[0]?.id ?? '')}
              <ChevronDown className="pill-chevron" size={12} strokeWidth={1.75} aria-hidden="true" />
            </button>
            {modelOpen && (
              <div className="sx-menu-pop pill-pop model-pop" role="menu" aria-label="model menu">
                {modelChoices.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="menuitem"
                    className={`sx-menuitem${(selModel ?? defaultModel) !== undefined && baseModelName(c.id) === baseModelName(selModel ?? defaultModel) ? ' current' : ''}`}
                    data-tip={c.id}
                    onClick={() => {
                      setSelModel(c.id);
                      if (c.effort !== undefined) setSelEffort(c.effort);
                    }}
                  >
                    {baseModelName(c.id)}
                  </button>
                ))}
                <div className="pill-group-head">{t('Reasoning effort', '思考强度')}</div>
                <EffortSlider value={selEffort ?? 'medium'} onChange={setSelEffort} />
              </div>
            )}
          </div>
          <button
            type="button"
            className="send"
            aria-label="send"
            data-tip={`${t('Send', '发送')} · Enter`}
            disabled={busy || text.trim() === ''}
            onClick={send}
          >
            {busy ? <Loader2 size={16} strokeWidth={2} style={{ animation: 'sx-spin 1s linear infinite' }} aria-hidden="true" /> : <ArrowUp size={16} strokeWidth={2.25} aria-hidden="true" />}
          </button>
        </>
      }
      belowInput={undefined}
    />
  );
}
