import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';
import { t } from '../i18n';
import type { Connection } from '../connection';
import { ComposerCard } from '../composer/ComposerCard';
import { ComposerPillsLeft, ComposerPillsRight } from '../pages/chat/ComposerPills';
import { expandFileRefs, expandRefContents, fileHit, FilePalette, rankFileHits, RefPalette, refContentConsume, renderMentionSpans, slashTokenAt } from '../pages/chat/mention';
import { CommandPalette, type CmdItem } from '../CommandPalette';
import { slashItemsFor, useCommandPalette } from '../pages/chat/use-command-palette';
import { useComposerKeys } from '../pages/chat/use-composer-keys';
import { useChatComposerSide } from '../pages/chat/use-chat-composer-side';
import { flatRefItems, refTokenAt, type RefEntries, type RefPal } from '../pages/chat/ref-palette';
import { pathBasename } from '../ui-util';
import { useWorkspaceFiles } from '../pages/chat/use-workspace-files';
import { ComposerPlusPanel } from '../composer/ComposerPlusPanel';

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
  /** 草稿文本回档初值(gui/sessions 盘档 params.draftText,重启恢复输入框内容) */
  readonly initialText?: string;
  /** insert token 的选取全文(2026-11-07 串扰根修:与 insert 同路入私有账本,hover/展开不落全局兜底) */
  readonly insertContent?: string;
  /** 账本快照回档初值(JSON [token,content][];2026-11-07 落地即清配套——账本内存态重启即空,
   *  恢复的草稿芯片无内容=空壳紊乱;随页签档持久化,挂载回灌) */
  readonly draftRefContents?: string;
  /** 账本快照变更上报(与 onTextChange 同走 gui-state 落盘) */
  readonly onRefContentsChange?: (json: string) => void;
  /** 草稿文本变更上报(组件内 400ms 防抖→App patchTabMeta params.draftText→gui-state 写透) */
  readonly onTextChange?: (text: string) => void;
}): JSX.Element {
  const { conn, root, insert, insertContent, busy, onSend, initialText, draftRefContents, onTextChange, onRefContentsChange } = props;
  const [text, setText] = useState(initialText !== undefined && initialText !== '' ? initialText : (insert ?? ''));
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
  const { cmdData, setCmdData, cmdActive, setCmdActive, skills, reloadSkills } = useCommandPalette(conn, root);
  // 2026-11-07 用户实测「+ 能实时加出来,/ 不实时」:/ 面板在场即现拉技能清单(主对话同款)
  useEffect(() => {
    if (slashTokenAt(text, inputRef.current?.selectionStart ?? text.length) !== null) reloadSkills();
  }, [text, reloadSkills]);
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
  // pills=真组件复用(2026-11-06 用户裁定「和会话中的输入框一样,只去掉上下文圈;不要手搓」):
  // ComposerPillsLeft/Right 原件,本地态+空会话 ID(持久化调用静默失败=纯样式复用零逻辑改动);
  // ctxInfo 恒 null=无上下文圆环(未 fork 无共享 ctx);modelInfo 本地构造(conn.settings 缺省模型)
  const [pillOpen, setPillOpen] = useState<'mode' | 'model' | 'plus' | null>(null);
  const [sessMode, setSessMode] = useState<'read-only' | 'acceptEdits' | 'full-access' | 'plan'>('full-access');
  const [modelInfo, setModelInfo] = useState<{ current?: string; choices: Array<{ id: string; model: string; baseUrl: string; effort?: string; supportsImages?: boolean }> } | null>(null);
  const [sessEffort, setSelEffort] = useState<string | undefined>('medium');
  useEffect(() => {
    conn.settings().then(
      (view) => {
        // 2026-11-06 用户裁定「去掉默认模型,用第一个 provider 的第一个 model」
        const def = view.providers.choices[0]?.id;
        setModelInfo({
          current: def,
          choices: view.providers.choices.map((c) => ({ id: c.id, model: c.id, baseUrl: '' })),
        });
      },
      () => undefined,
    );
  }, [conn]);
  // pills/+ 面板外点收(Chat.tsx 495 同款:面板内点与 + 钮自持,弹层内点不收——模型连选+强度不闪收)
  useEffect(() => {
    if (pillOpen === null) return;
    const onDown = (e: MouseEvent): void => {
      if (e.target instanceof Element) {
        if (e.target.closest('.sx-plus-panel') !== null || e.target.closest('.composer-plus-btn') !== null) return;
        if (pillOpen !== 'plus' && e.target.closest('.composer-pills') !== null) return;
        setPillOpen(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pillOpen]);
  // 2026-11-07 用户裁定:辅助会话圈选=追加(此前整替是误改,第二个片段加不进去),改回追加:insert 变更回流=追加接续(去尾空白
  // +单空格);防重入保留——挂载首拍跳过(初值已含 insert,不防则 append 致双份)
  // insertContent 渲染期入账(2026-11-07 用户实测「草稿第 1 枚内容是主会话的」根修):子组件
  // ComposerCard 的规范化 effect 先于本组件 effect 执行——种子若在 effect 里写,改名已带空账本
  // 跑完,种子键对不上=hover/展开回落全局注册表取到别会话同键内容。渲染期直写幂等
  // 挂载回灌账本快照(一次性;2026-11-07 落地即清配套)
  const restoredRef = useRef(false);
  if (restoredRef.current === false) {
    restoredRef.current = true;
    if (draftRefContents !== undefined && draftRefContents !== '') {
      try {
        for (const [tk, c] of JSON.parse(draftRefContents) as Array<[string, string]>) refContentsRef.current.set(tk, c);
      } catch { /* 档损坏即弃 */ }
    }
  }
  if (insert !== undefined && insert !== '' && insertContent !== undefined && insertContent !== '') {
    refContentsRef.current.set(insert, insertContent);
    refContentConsume(insert); // 落地即清共享层
  }
  const lastInsertRef = useRef(insert);
  useEffect(() => {
    if (insert === undefined || insert === '') return;
    if (insert === lastInsertRef.current) return;
    lastInsertRef.current = insert;
    setText((prev) => (prev.trim() === '' ? `${insert} ` : `${prev.replace(/\s+$/, '')} ${insert} `));
  }, [insert]);
  // 草稿文本落盘上报(400ms 防抖→App 落 params.draftText→gui-state 500ms 写透;重启回档回填。
  // 窗口关闭前最后 <400ms 的击键不落盘,可接受——落盘语义为「输完即存」,非逐键同步)
  const textSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTextChangeRef = useRef(onTextChange);
  onTextChangeRef.current = onTextChange;
  const onRefContentsChangeRef = useRef(onRefContentsChange);
  onRefContentsChangeRef.current = onRefContentsChange;
  useEffect(() => {
    if (onTextChangeRef.current === undefined) return;
    if (textSaveRef.current !== null) clearTimeout(textSaveRef.current);
    textSaveRef.current = setTimeout(() => {
      onTextChangeRef.current?.(text);
      // 账本快照随文本落盘节奏同步上抛(芯片增删都伴随文本变更;JSON 序列化 Map 插入序)
      onRefContentsChangeRef.current?.(JSON.stringify([...refContentsRef.current]));
    }, 400);
    return () => {
      if (textSaveRef.current !== null) {
        clearTimeout(textSaveRef.current);
        textSaveRef.current = null;
      }
    };
  }, [text]);
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
      ) : pillOpen === 'plus' ? (
        /* + 附加面板(会话内同款:命令/技能插入;文件区需会话——草稿未 fork 不渲染) */
        <ComposerPlusPanel
          conn={conn}
          root={root}
          onInsert={(t2) => {
            setText((v) => (v.trim() === '' ? t2 : `${v.replace(/\s+$/, '')} ${t2}`));
            setPillOpen(null);
          }}
        />
      ) : null}
    </>
  );
  return (
    <ComposerCard
      label="side chat draft"
      inputRef={inputRef}
      refLedger={refContentsRef}
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
      highlight={
        /* refContents=会话私有账本优先(2026-11-07 串扰根修):全局注册表键跨会话共享,同键异内容
           时 hover 取到别的会话的片段——私有账本命中即不落全局 */
        renderMentionSpans(text, (n) => pickRelRef.current.get(n) ?? filePalFiles.find((f) => pathBasename(f) === n), refContentsRef.current, undefined, true)
      }
      footLeft={
        <ComposerPillsLeft
          pillOpen={pillOpen}
          setPillOpen={setPillOpen}
          sessMode={sessMode}
          setSessMode={setSessMode}
          conn={conn}
          sessionId=""
        />
      }
      footRight={
        <ComposerPillsRight
          pillOpen={pillOpen}
          setPillOpen={setPillOpen}
          conn={conn}
          sessionId=""
          ctxInfo={null}
          refreshCtx={() => undefined}
          runCount={0}
          steps={0}
          tokens={0}
          cacheTokens={0}
          modelInfo={modelInfo}
          setModelInfo={setModelInfo}
          sessEffort={sessEffort}
          setSessEffort={setSelEffort}
          running={busy}
          input={text}
          send={send}
          interrupt={() => undefined}
          connState="open"
          seeding={false}
        />
      }
      belowInput={undefined}
    />
  );
}
