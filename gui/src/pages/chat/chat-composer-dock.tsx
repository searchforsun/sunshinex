import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import { ComposerCard } from '../../composer/ComposerCard';
import { ComposerPlusPanel } from '../../composer/ComposerPlusPanel';
import { CommandPalette } from '../../CommandPalette';
import type { CmdItem } from '../../CommandPalette';
import { SteerQueue } from './SteerQueue';
import { AskDock } from './AskDock';
import { ApprovalCard } from './PendingCards';
import type { AskPick } from './PendingCards';
import { PlanCard } from './PlanCard';
import { fileHit, FilePalette, rankFileHits, RefPalette, slashTokenAt } from './mention';
import { refPickLabel, refTokenAt } from './ref-palette';
import type { RefEntries, RefPal } from './ref-palette';
import { ComposerPillsLeft, ComposerPillsRight } from './ComposerPills';
import { useComposerKeys } from './use-composer-keys';
import type { ChatProps } from './chat-types';
import { applyFilePick, chaseScrollBottom, dropRefsOf, insertRefBase, insertRefPick, insertRefToken } from '../../ui-util';
import { t } from '../../i18n';

type QueuedRow = { seq: number; text: string; images?: string[] };
type Mode = 'read-only' | 'acceptEdits' | 'full-access' | 'plan';

/**
 * 会话输入 dock(Chat 外提,D62 批I):统一输入卡区(2026-11-10 终端下栏改版同容器)——队列条/
 * 跳底钮/审批·计划·问答三态 dock/ComposerCard 装配(@文件面板·$/# 引用面板·/ 命令面板·+ 附加
 * 四链 overlays、权限/模型 pills 双 foot)。与欢迎页同一份 ComposerCard(唯一差异:无项目选择条,
 * .composer 只提供会话语境限宽贴底);输入面逻辑(键分发/守卫/展开)留宿主,本件纯装配渲染。
 */
export function ChatComposerDock(props: {
  dockRef: MutableRefObject<HTMLDivElement | null>;
  conn: ChatProps['conn'];
  sessionId: string;
  root: string | undefined;
  sideChat: boolean | undefined;
  /** Sunx 编排者会话显示名(2026-11-17 文案轮):占位据此换「给 {name} 一个目标」 */
  sunxName?: string;
  /** 会话尚无任何条目(空会话):占位区分「首次交代目标」与「接续对话」 */
  emptyChat: boolean;
  connState: ChatProps['connState'];
  queued: QueuedRow[];
  setQueued: Dispatch<SetStateAction<QueuedRow[]>>;
  queueFolded: boolean;
  /** 队列暂停态（2026-11-23 用户裁定「中断同时暂停队列」）：真=首条上侧横幅（暂停说明+继续钮） */
  queuePaused?: boolean;
  /** 横幅「继续」钮：解除暂停（daemon idle 即按序续发） */
  onResumeQueue?: () => void;
  setQueueFolded: Dispatch<SetStateAction<boolean>>;
  refreshQueued: () => void;
  pauseAndSend: (q: QueuedRow) => Promise<void>;
  entryTexts: ReadonlySet<string>;
  atBottom: boolean;
  chatScrollRef: RefObject<HTMLElement | null>;
  askCards: Array<Extract<import('./use-session-events').PendingCard, { kind: 'ask' }>>;
  approvalCards: Array<Extract<import('./use-session-events').PendingCard, { kind: 'approval' }>>;
  planCards: Array<Extract<import('./use-session-events').PendingCard, { kind: 'plan-approval' }>>;
  askPicks: Record<string, AskPick>;
  setAskPicks: Dispatch<SetStateAction<Record<string, AskPick>>>;
  sendAsk: (pid: string, answer: import('../../connection').GuiAskAnswer) => void;
  sendApproval: (pid: string, decision: string) => void;
  sendPlanApproval: (pid: string, decision: import('../../connection').GuiPlanDecision) => void;
  onOpenAgent: ChatProps['onOpenAgent'];
  onOpenFile: ChatProps['onOpenFile'];
  sessMode: Mode;
  setSessMode: Dispatch<SetStateAction<Mode>>;
  sessEffort: string | undefined;
  setSessEffort: Dispatch<SetStateAction<string | undefined>>;
  refContentsRef: { current: Map<string, string> };
  pendingImages: string[];
  setPendingImages: Dispatch<SetStateAction<string[]>>;
  setLightboxSrc: Dispatch<SetStateAction<string | undefined>>;
  addImageFiles: (files: File[]) => void;
  imgHint: string | undefined;
  modelSupportsImages: boolean;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  running: boolean;
  seeding: boolean;
  composerKeys: ReturnType<typeof useComposerKeys>;
  /** 组字段回抛 setter(2026-11-25 输入粘滞轮收窄为普通 setter:Chat 侧判等闸只收值对象,
   *  ComposerCard 三拍回抛也只传值对象,无需 updater 形态) */
  setCompRange: (range: { start: number; end: number } | null) => void;
  refPal: RefPal | null;
  setRefPal: Dispatch<SetStateAction<RefPal | null>>;
  refPanelItems: import('./ref-palette').RefItem[] | null;
  refEntries: RefEntries;
  refActive: number;
  setRefActive: Dispatch<SetStateAction<number>>;
  filePal: { query: string; from: number } | null;
  setFilePal: Dispatch<SetStateAction<{ query: string; from: number } | null>>;
  filePalFiles: string[];
  setFilePalFiles: Dispatch<SetStateAction<string[]>>;
  filePalActive: number;
  setFilePalActive: Dispatch<SetStateAction<number>>;
  loadWorkspaceFiles: () => Promise<string[]>;
  loadRefEntries: () => void;
  pillOpen: 'mode' | 'model' | 'plus' | null;
  setPillOpen: Dispatch<SetStateAction<'mode' | 'model' | 'plus' | null>>;
  pickRelRef: { current: Map<string, string> };
  slashPanelItems: CmdItem[] | null;
  cmdActive: number;
  setCmdActive: Dispatch<SetStateAction<number>>;
  renderHighlightSpans: (text: string) => ReactNode;
  onInputClick: () => void;
  terminalDockEnabled: boolean;
  dockOpen: boolean;
  setDockOpen: Dispatch<SetStateAction<boolean>>;
  /** 终端下栏高度(px;>0=下栏在座 → composer 整体抬到下栏上方,呼吸缝 10px 留在中间)。
   *  2026-11-18 座位壳回归:原由 CSS `.sx-main:has(> .terminal-dock)` 驱动,keep-alive 座位壳把
   *  下栏变成孙代后计数恒假,composer 压回下栏之上(用户实测「输入框跑下面」)——改显式上传,
   *  不再依赖 DOM 层级(dom 结构改写不再能静默弄丢抬升) */
  dockLift: number;
  ctxInfo: { total: number; window: number; parts: Array<{ id: string; tokens: number; count: number }> } | null;
  refreshCtx: () => void;
  runCount: number;
  steps: number;
  tokens: number;
  cacheTokens: number;
  modelInfo: Awaited<ReturnType<ChatProps['conn']['sessionModel']>> | null;
  setModelInfo: Dispatch<SetStateAction<Awaited<ReturnType<ChatProps['conn']['sessionModel']>> | null>>;
  send: () => void;
  interrupt: () => void;
  awaitModelSince: number | null;
}): JSX.Element {
  const {
    dockRef, conn, sessionId, root, sideChat, connState, queued, setQueued, queueFolded, setQueueFolded,
    queuePaused, onResumeQueue, refreshQueued, pauseAndSend, entryTexts, atBottom, chatScrollRef, askCards, approvalCards, planCards,
    askPicks, setAskPicks, sendAsk, sendApproval, sendPlanApproval, onOpenAgent, onOpenFile, sessMode, sunxName, emptyChat,
    setSessMode, sessEffort, setSessEffort, refContentsRef, pendingImages, setPendingImages, setLightboxSrc,
    addImageFiles, imgHint, modelSupportsImages, input, setInput, inputRef, running, seeding, composerKeys,
    setCompRange, refPal, setRefPal, refPanelItems, refEntries, refActive, setRefActive, filePal, setFilePal,
    filePalFiles, setFilePalFiles, filePalActive, setFilePalActive, loadWorkspaceFiles, loadRefEntries,
    pillOpen, setPillOpen, pickRelRef, slashPanelItems, cmdActive, setCmdActive, renderHighlightSpans,
    onInputClick, terminalDockEnabled, dockOpen, setDockOpen, ctxInfo, refreshCtx, runCount, steps, tokens,
    cacheTokens, modelInfo, setModelInfo, send, interrupt, awaitModelSince, dockLift,
  } = props;
  /** 输入卡占位(2026-11-17 文案轮单点):按「运行中/辅助对话/Sunx/计划模式/只读/空会话 vs 接续」
   *  分档——占位=动作邀请而非说明书:运行中讲清可插话,辅助对话讲清不打断主任务,计划模式讲清
   *  先计划后执行,只读讲清不改文件 */
  const composerPlaceholder = running
    ? t('Add more whenever you like', '有补充可直接说明')
    : sideChat === true
      ? t('Questions here do not affect the main task', '提问不影响主任务')
      : sunxName !== undefined
        ? t(`Assign ${sunxName} a task`, `给 ${sunxName} 指派任务`)
        : sessMode === 'plan'
          ? t('Describe the goal to plan first', '描述目标以规划执行方案')
          : sessMode === 'read-only'
            ? t('Describe what needs read-only analysis', '描述需只读分析的目标')
            : emptyChat
              ? t('Describe the goal to begin', '描述目标即可开始')
              : t('Continue or ask for details', '继续交代或追问细节');
  return (
    <div className="chat-dock" ref={dockRef} style={dockLift > 0 ? { bottom: dockLift + 10 } : undefined}>
      <div className="chat-dock-fade" aria-hidden="true" />
      {/* G14.88 审批挂起时队列条隐藏(dock 整体让位确认框),确认/拒绝后恢复 */}
      {queued.length > 0 && approvalCards.length === 0 && planCards.length === 0 && (
        <SteerQueue
          queued={queued}
          queueFolded={queueFolded}
          queuePaused={queuePaused}
          onResumeQueue={onResumeQueue}
          setQueueFolded={setQueueFolded}
          setQueued={setQueued}
          conn={conn}
          sessionId={sessionId}
          refreshQueued={refreshQueued}
          pauseAndSend={pauseAndSend}
          setInput={setInput}
          setImages={setPendingImages}
          entryTexts={entryTexts}
        />
      )}
      {!atBottom && (
        <button
          type="button"
          className="jump-down"
          aria-label="scroll to bottom"
          data-tip={t('Scroll to bottom', '回到底部')}
          onClick={() => {
            const el = chatScrollRef.current;
            // G14.74 跳底 + 迭代校正(2026-10-27):CV 估算高一次 scrollTo 落点偏短要连点多次,追平收口
            if (el !== null) chaseScrollBottom(el);
          }}
        >
          <ArrowDown size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
      {planCards.length > 0 ? (
        /* 阶段三 plan-arm(spec §5.2):计划确认卡 dock(与 approval/ask 同容器形态)——批准/
          反馈回执后移卡恢复输入框;裁决期间 composer 由 dock 顶替(同 G14.88 审批挂起口径) */
        <div className="ask-dock">
          {planCards.map((c) => (
            <PlanCard key={c.pid} doc={c.req.doc} items={c.req.items} name={c.req.name} path={c.req.path} mode={sessMode} onOpenFile={onOpenFile} onDecide={(d) => sendPlanApproval(c.pid, d)} />
          ))}
        </div>
      ) : approvalCards.length > 0 ? (
        /* G14.88:审批挂起时输入框变为确认框(与 ask 同形)——Allow/Deny/Always 回执后恢复输入框 */
        <div className="ask-dock">
          {approvalCards.map((c) => (
            <ApprovalCard key={c.pid} req={c.req} onDecision={(d) => sendApproval(c.pid, d)} />
          ))}
        </div>
      ) : askCards.length > 0 ? (
        <AskDock askCards={askCards} askPicks={askPicks} setAskPicks={setAskPicks} sendAsk={sendAsk} onOpenAgent={onOpenAgent} />
      ) : (
        <ComposerCard
          className="chat-composer"
          label="message input"
          refLedger={refContentsRef}
          images={pendingImages}
          onRemoveImage={(i) => setPendingImages((cur) => cur.filter((_, idx) => idx !== i))}
          onImageOpen={setLightboxSrc}
          onPasteFiles={addImageFiles}
          belowInput={
            imgHint !== undefined ? (
              <div className="sx-img-hint" role="status">{imgHint}</div>
            ) : pendingImages.length > 0 && !modelSupportsImages ? (
              <div className="sx-img-hint warn" role="status">{t('Current model does not support image input', '当前模型不支持图片输入')}</div>
            ) : undefined
          }
          value={input}
          rows={Math.min(6, Math.max(1, (input.match(/\n/g) ?? []).length + 1))}
          placeholder={composerPlaceholder}
          disabled={connState !== 'open' || seeding}
          onChange={(v) => {
            setInput(v);
            // G14.124 面板跟随输入(光标前 @token 即开,裸 @ 也开);无匹配=渲染面自然关闭
            const caret = inputRef.current?.selectionStart ?? v.length;
            const m = /@([\w./:\\-]*)$/.exec(v.slice(0, caret));
            // agents-teams P1 §3.2 $/# 引用面板同款跟随(与 @ 互斥:同一 caret 前缀不可能同时
            // 以 @词与 $/#词 收尾;@ 命中即收引用面板,反之亦然)
            const rt = refTokenAt(v, caret);
            if (m !== null) {
              setFilePal({ query: m[1] ?? '', from: caret - (m[1]?.length ?? 0) - 1 });
              // G14.2xx 查询变更即重置 active:残留箭头位在新命中集上会指向邻项(回车选中非目标)
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
          }}
          onKeyDown={composerKeys.onKeyDown}
          onBeforeInput={composerKeys.onBeforeInput}
          onPasteGuard={composerKeys.onPasteGuard}
          onCompositionGuard={composerKeys.onCompositionGuard}
          onCompositionRange={setCompRange}
          onCompositionEndGuard={composerKeys.onCompositionEndGuard}
          onSelectGuard={composerKeys.onSelectGuard}
          overlays={
            // agents-teams P1 §3.2 $/# 引用面板(链首=与 @/+/命令面板互斥;R4 插入 `$id `/`#id `
            // 尾随空格即终态,无记账;光标钉插入 token 后沿——G14.211 同款)
            refPal !== null && refPanelItems !== null ? (
              <RefPalette
                items={refPanelItems}
                emptyHint={
                  refEntries.agents.length === 0 && refEntries.teams.length === 0
                    ? t(
                        'No registered sub-agents or teams yet — create them in Settings → Agents / Agent Teams, then reference here with $ or #',
                        '尚无在册子智能体/团队 — 在 设置 → 智能体 / 智能体团队 创建后，即可在此 $ 引用 / # 拉队',
                      )
                    : t('No matching entry', '无匹配条目')
                }
                active={Math.max(0, Math.min(refActive, refPanelItems.length - 1))}
                onHover={setRefActive}
                onPick={(item) => {
                  // 插入名称而非标识(2026-11-20 用户裁定「# $ 后面只跟上名称,用户不感知 id」):
                  // 发送期 expandRefNames 按目录还原成 id;含空白名称回落 id(refPickLabel 单点)。
                  // 分隔符守卫/尾随空格/G14.211 光标钉全在 insertRefPick 单点(D85)
                  insertRefPick(setInput, {
                    sym: item.sym,
                    label: refPickLabel(item),
                    atFrom: refPal.from,
                    queryLen: refPal.query.length,
                    close: () => setRefPal(null),
                    pinTo: () => inputRef.current,
                  });
                }}
              />
            ) : // G14.121 @ 文件面板(此前数据链在而渲染面缺失——@ 弹窗从未出现的根因):命中才渲染;
              // G14.211 锚点校验:@ 已被整删/程序化改写后 filePal 残留,锚位不再是 '@' 即不渲染
              filePal !== null && input[filePal.from] === '@' && filePalFiles.some((f) => fileHit(f, filePal.query)) ? (
              <FilePalette
                items={rankFileHits(filePalFiles, filePal.query)}
                active={Math.min(filePalActive, 11)}
                onHover={setFilePalActive}
                onPick={(p) => {
                  // G14.126 短写显形+记账;G14.211 焦点回框+光标钉 token 右沿——applyFilePick 单点(D86)
                  applyFilePick(pickRelRef, setInput, { rel: p, atFrom: filePal.from, queryLen: filePal.query.length, close: () => setFilePal(null), pinTo: () => inputRef.current });
                }}
              />
            ) : pillOpen === 'plus' ? (
              <ComposerPlusPanel
                conn={conn}
                sessionId={sessionId}
                root={root}
                onAttachImages={addImageFiles}
                onInsert={(text) => {
                  // 2026-11-05 用户裁定:+面板智能体/团队区插整 token(`$id `/`#id `)——与命令/技能
                  // 行同款落文本即收,不再有裸符号触发行(引用面板交给输入触发)
                  setInput((v) => (v.trim() === '' ? text : `${v.replace(/\s+$/, '')} ${text}`));
                  setPillOpen(null);
                  inputRef.current?.focus();
                }}
              />
            ) : slashPanelItems !== null ? (
              (() => {
                const items = slashPanelItems;
                const active = Math.min(cmdActive, Math.max(0, items.length - 1));
                const pick = (item: CmdItem): void => {
                  if (!item.ok) return;
                  const tok = slashTokenAt(input, input.length);
                  const from = tok !== null ? tok.from : input.length;
                  const caret = inputRef.current?.selectionStart ?? input.length;
                  // 分隔符守卫(2026-11-05):落点前贴着 ⟧(芯片尾沿,透明不显)时补半角空格——
                  // 芯片后落选 /cmd 即粘成 ⟧/cmd,tokenizer (^|\s) 不识别=「文本后面的技能
                  // 无法识别成命令蓝色」根因之二
                  const head = input.slice(0, from);
                  const sep = head !== '' && /\S$/.test(head) ? ' ' : '';
                  setInput(head + sep + item.cmd + ' ' + input.slice(caret));
                };
                return <CommandPalette items={items} active={active} onHover={setCmdActive} onPick={pick} />;
              })()
            ) : null
          }
          inputRef={inputRef}
          highlight={renderHighlightSpans(input)}
          onInputClick={onInputClick}
          onDropFile={(rel) => {
            // G14.144 拖入文件 → caret 处插 @短写(insertRefToken 单点;G14.211 光标钉位随单点)
            insertRefToken(rel, { get: () => input, set: setInput, ta: () => inputRef.current, ledger: pickRelRef.current });
          }}
          onDropPaths={(paths) => {
            // 外部拖拽(2026-11-14 资源管理器拖文件/文件夹进输入框):绝对路径归一 @短写(根下相对化),
            // 与内部树拖入同语言(高亮可点,发送期 @ 展开解析)
            for (const { base, ledger } of dropRefsOf(paths, root)) {
              insertRefBase(base, ledger, { get: () => input, set: setInput, ta: () => inputRef.current, ledger: pickRelRef.current });
            }
          }}
          footLeft={
            <ComposerPillsLeft
              pillOpen={pillOpen}
              setPillOpen={setPillOpen}
              sessMode={sessMode}
              setSessMode={setSessMode}
              conn={conn}
              sessionId={sessionId}
              terminalDockEnabled={terminalDockEnabled}
              dockOpen={dockOpen}
              onToggleDock={() => setDockOpen((v) => !v)}
            />
          }
          footRight={
            <ComposerPillsRight
              pillOpen={pillOpen}
              setPillOpen={setPillOpen}
              conn={conn}
              sessionId={sessionId}
              ctxInfo={ctxInfo}
              refreshCtx={refreshCtx}
              runCount={runCount}
              steps={steps}
              tokens={tokens}
              cacheTokens={cacheTokens}
              modelInfo={modelInfo}
              setModelInfo={setModelInfo}
              sessEffort={sessEffort}
              setSessEffort={setSessEffort}
              running={running}
              input={input}
              hasImages={pendingImages.length > 0}
              send={send}
              interrupt={interrupt}
              connState={connState}
              seeding={seeding}
              sendLoading={awaitModelSince !== null}
              terminalDockEnabled={terminalDockEnabled}
            />
          }
        />
      )}
    </div>
  );
}
