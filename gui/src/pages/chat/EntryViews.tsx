import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertCircle, ArrowUp, Bot, Brain, Check, ChevronDown, ChevronRight, ChevronUp, Copy, Database, History, Info, MessageSquare, PenLine, Sparkles, X } from 'lucide-react';
import { t } from '../../i18n';
import { pathBasename } from '../../ui-util';
import type { ChatEntry } from '../../chat-reducer';
import { buildMdComponents, buildUserMdComponents, keepUrl, renderUserMd } from '../Chat';
import { RunChangesBar, RunFooter, TipButton } from './RunFooter';

/** 会话条目渲染件群（D32 批C-4 拆分自 Chat.tsx）：run 状态行/思考折叠行/用户胶囊条(含编辑卡/
 *  回退菜单/折叠气泡)/系统行(含旁白着色)与单条渲染单元。memo 语义与 DOM 逐字节不变;md 渲染
 *  工厂(keepUrl/buildUserMdComponents/buildMdComponents/renderUserMd)与 token 工具留 Chat
 *  原路径消费。行为零变化(Chat.test 转录组为锚)。 */

/** 秒数格式(G14.118 中文单位):<60s 「34秒」;≥60s 「1分10秒」(状态行/尾条共用;en 恒英文单位) */
function runElapsed(seconds: number): string {
  if (seconds < 60) return t(`${seconds}s`, `${seconds}秒`);
  return t(`${Math.floor(seconds / 60)}m ${seconds % 60}s`, `${Math.floor(seconds / 60)}分 ${seconds % 60}秒`); // G14.185b 分秒之间加间隙
}

/** 模型显示名(G12 二轮):剥 provider 前缀——'openai/gpt-5.2' → 'gpt-5.2'(id 全文留 title);
 *  空值回落「默认模型」。欢迎页同口径消费(G13 反馈轮导出) */
export function baseModelName(id: string | undefined): string {
  if (id === undefined || id === '') return t('default model', '默认模型');
  return pathBasename(id);
}

/** run 状态行(G11 §1.2):streaming=Working(旋转环+1s tick+会话 tokens);封段=✓ Worked for Xs 淡灰
 *  保留。memo 包裹:sealed 行 entry/tokens 双稳定→不随 token 帧重渲;tick 是组件内部 state 自驱动,
 *  memo 不影响;tokens 变化(usage 帧)仍重渲(期望行为)。种子历史无 run 条,重连后自下一轮
 *  model-start 恢复(spec §0) */
export const RunEntryView = memo(function RunEntryView({ entry, collapsed, onToggle }: { entry: ChatEntry; collapsed?: boolean; onToggle?: (key: string) => void }): JSX.Element {
  const [, setTick] = useState(0);
  const streaming = entry.streaming === true;
  useEffect(() => {
    if (!streaming) return;
    const h = setInterval(() => setTick((v) => v + 1), 1_000);
    return () => clearInterval(h);
  }, [streaming]);
  if (!streaming) {
    // G14.31:sealed 行即轮折叠开关——点击折叠/展开其后工具与思考行;chevron 恒渲染、hover 显形
    return (
      <div
        className="entry entry-run sealed"
        aria-label="run summary"
        role={onToggle !== undefined ? 'button' : undefined}
        tabIndex={onToggle !== undefined ? 0 : undefined}
        aria-expanded={onToggle !== undefined ? !collapsed : undefined}
        onClick={onToggle !== undefined ? () => onToggle(entry.key) : undefined}
        onKeyDown={
          onToggle !== undefined
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onToggle(entry.key);
                }
              }
            : undefined
        }
      >
        <span>
          {entry.stopped === true
            ? t('Stopped', '已停止')
            : entry.seconds !== undefined
              ? t(`Worked for ${runElapsed(entry.seconds)}`, `已运行 ${runElapsed(entry.seconds)}`)
              : t('Worked', '已运行')}
        </span>
        {onToggle !== undefined && (
          <span className="run-chev" aria-hidden="true">
            {collapsed ? <ChevronRight size={12} strokeWidth={1.75} /> : <ChevronDown size={12} strokeWidth={1.75} />}
          </span>
        )}
      </div>
    );
  }
  const elapsed = entry.ts !== undefined ? Math.max(0, Math.round((Date.now() - entry.ts) / 1000)) : 0;
  // G14.11:状态行只示时长(圆圈/tokens 迁工具行尾)——tokens 参数保留由调用面透传(历史签名)
  return (
    <div className="entry entry-run live" role="status" aria-label="run status">
      <span>{t('Working', '运行中')}</span>
      <span className="run-meta" aria-hidden="true">{runElapsed(elapsed)}</span>
    </div>
  );
});


/** 思考链折叠行(G11 §3):折叠=Brain 图标+「思考中…/思考 Ns」+末行内联预览(尾锚定,新内容自右
 *  推入旧文左流=「往前流动」,左缘 mask 渐隐);展开=全文内滚容器(streaming 时 effect 逐帧吸底,
 *  直设 scrollTop 不平滑——逐 token 跟手)。展开/折叠 grid-rows 过渡(同工具行公式) */
export const ThinkingEntryView = memo(function ThinkingEntryView({ entry }: { entry: ChatEntry }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const streaming = entry.streaming === true;
  useEffect(() => {
    if (!streaming) return;
    const h = setInterval(() => setTick((v) => v + 1), 1_000); // G14.37:流式秒针——头部持续计数
    return () => clearInterval(h);
  }, [streaming]);
  useEffect(() => {
    if (open && streaming && scrollRef.current !== null) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [open, streaming, entry.md]);
  // G14.37 流式两件套:头部秒数持续计数 / 内容右向流动窗(G14.52:速率显示去——思考行占满整行)
  const elapsed = streaming && entry.ts !== undefined ? Math.max(1, Math.round((Date.now() - entry.ts) / 1000)) : undefined;
  const flow = streaming ? entry.md.slice(-220) : ''; // G14.79:加宽尾窗,宽行下思考内容充满整行
  return (
    <div className={`entry entry-thinking${open ? ' open' : ''}`}>
      <button type="button" className="thinking-summary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Brain size={12} strokeWidth={1.75} aria-hidden="true" />
        <span className="thinking-label">
          {streaming
            ? t(`Thinking ${elapsed ?? 0}s`, `思考中 ${elapsed ?? 0}秒`)
            : entry.seconds !== undefined
              ? t(`Thought for ${entry.seconds}s`, `思考 ${entry.seconds}秒`)
              : t('Thought', '思考')}
        </span>
        {streaming && !open && flow !== '' && (
          <span className="thinking-flow" aria-hidden="true">
            {flow}
          </span>
        )}
        <ChevronRight className="think-chev" size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <div className="think-body">
        <div className="think-body-inner">
          <div className="thinking-scroll" ref={scrollRef}>
            <pre className="thinking-detail">{entry.md}</pre>
          </div>
        </div>
      </div>
    </div>
  );
});

/** 回到此轮菜单(G10-C4;/rewind 底层):bubble 钮点击即拉 anchors 列出任务轮,选中回退 */
function RewindMenu({ onAnchors, onPick }: { onAnchors: () => Promise<Array<{ turn: number; text: string }>>; onPick: (turn: number) => void }): JSX.Element {
  const [anchors, setAnchors] = useState<Array<{ turn: number; text: string }> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    onAnchors().then(setAnchors, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [onAnchors]);
  if (error !== '') return <div className="rewind-menu">{error}</div>;
  if (anchors === null) return <div className="rewind-menu">{t('Loading…', '加载中…')}</div>;
  return (
    <div className="rewind-menu" role="menu" aria-label={t('rewind turns', '回退任务轮')}>
      {anchors.length === 0 && <div className="rewind-empty">{t('No turns to rewind yet', '暂无可回退的任务轮')}</div>}
      {anchors.map((a) => (
        <button
          key={a.turn}
          type="button"
          role="menuitem"
          className="sx-menuitem rewind-item"
          data-tip={a.text}
          onClick={() => onPick(a.turn)}
        >
          <span className="rewind-turn">{a.turn}</span>
          <span className="rewind-text">{a.text}</span>
        </button>
      ))}
    </div>
  );
}

/** 用户条目(Codex 形,G9 spec §3.1):右对齐胶囊(前景 5%/8% 底)+ 下方 hover 浮现复制钮;
 *  G11 §7 增编辑卡:hover 浮现 Edit 钮,点击气泡原位变 composer 同款浮卡(textarea 预填原文——user md 裸文,P11
 *  原文+取消/发送),发送经 onSend(=Chat 的 submitText,与 composer 同一提交路径)发新消息,
 *  成功才关卡(失败保卡保草稿,spec §9),Esc 取消回气泡。md 的 `> ` 引用形态在胶囊内平铺(CSS 收平)。
 *  复制失败(权限等)钮 1.5s 示「未复制」tertiary 态,不弹错。memo 同 ChatEntryView——流式帧
 *  只重渲染流式条(未包 memo 时每帧带动 user 条 md 重渲染,计数回归被击穿);onSend 由调用面
 *  传 useCallback 稳定引用,memo 语义保持。 */
interface UserEntryOpts {
  /** 回到此轮(G10-C4 /rewind 底层):拉锚点+确认回退;未配不渲染钮(测试桩免配) */
  fetchAnchors?: () => Promise<Array<{ turn: number; text: string }>>;
  onRewind?: (turn: number) => void;
  /** G14.110 气泡内 @文件 token 点击 → 打开 file 标签(未配=无行为) */
  onOpenFile?: (p: string) => void;
  /** §7 编辑卡发送回调(=Chat.submitText,Promise:void:resolve 关卡,reject 保卡保草稿——
   *  spec §9 提交失败草稿不丢):未配不渲染 Edit 钮(测试桩免配) */
  onSend?: (text: string) => Promise<void>;
}
/** G14.181/G14.202 用户气泡限高折叠:默认 168px;折叠态最后一行渐变隐现(加强);
 *  展开钮在气泡下侧居中(独占一行不占内容);展开钮=气泡下侧居中独钮;复制归各页自有动作行 */
const USER_BUBBLE_CLAMP = 168;
export function CollapsibleBubble({ text, render }: { text: string; render: (md: string) => ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const innerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = innerRef.current;
    if (el === null) return;
    // scrollHeight=内容全高(与 max-height/overflow 无关)——超过阈值才出浮钮
    setClamped(el.scrollHeight > USER_BUBBLE_CLAMP + 8);
  }, [text]);
  const shown = open || !clamped;
  return (
    <div className="user-bubble-wrap">
      <div ref={innerRef} className={`user-bubble${shown ? '' : ' user-bubble-clamped'}${open ? ' user-bubble-open' : ''}`}>
        {render(text)}
        {/* G14.208 展开态:钮行在气泡内部独占一行(不遮正文不跑外面) */}
        {open && (
          <div className="user-bubble-toggle-row">
            <button
              type="button"
              className="user-bubble-toggle"
              aria-expanded={open}
              aria-label={t('Collapse', '收起')}
              onClick={() => setOpen(false)}
            >
              <ChevronUp size={12} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      {/* 折叠态:钮悬浮在气泡内底部渐隐区(不遮可见内容) */}
      {clamped && !open && (
        <div className="user-bubble-toggle-row floating">
          <button
            type="button"
            className="user-bubble-toggle"
            aria-expanded={open}
            aria-label={t('Expand', '展开')}
            onClick={() => setOpen(true)}
          >
            <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

export const UserEntryView = memo(function UserEntryView({ entry, fetchAnchors, onRewind, onSend, onOpenFile }: { entry: ChatEntry } & UserEntryOpts): JSX.Element {  /** G14.116 文件 token 组件面(去 @ 显形+图标+点击开侧栏);onOpenFile 缺场=纯 chip 不可点 */
  const mdComponents = useMemo(() => buildUserMdComponents(onOpenFile), [onOpenFile]);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [rewindOpen, setRewindOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const copy = (): void => {
    const text = entry.md; // P11:user md 裸文(内核渲染中立)——正文合法以 > 开头者不再误剥
    navigator.clipboard?.writeText(text).then(
      () => setCopied('ok'),
      () => setCopied('fail'),
    );
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied('idle'), 1500);
  };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const openEdit = (): void => {
    setDraft(entry.md);
    setEditing(true);
  };
  const sendEdit = (): void => {
    const text = draft.trim();
    if (text === '') {
      setEditing(false); // 空文本:关卡不发(现状保持)
      return;
    }
    const result = onSend?.(text);
    if (result === undefined) {
      setEditing(false); // 未配 onSend 的测试桩:直接关卡
      return;
    }
    // 成功才关卡;失败保卡保草稿(spec §9:提交失败草稿不丢,错误条已由 submitText 落)
    void result.then(
      () => setEditing(false),
      () => undefined,
    );
  };
  if (editing) {
    return (
      <div className="entry entry-user">
        <div className="user-edit-card">
          <textarea
            aria-label="edit message"
            className="user-edit-input"
            autoFocus
            value={draft}
            rows={Math.min(6, Math.max(1, (draft.match(/\n/g) ?? []).length + 1))}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(false);
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                sendEdit();
              }
            }}
          />
          <div className="user-edit-foot">
            <TipButton tip={t('Cancel', '取消')} label="cancel edit" icon={<X size={12} strokeWidth={1.75} aria-hidden="true" />} onClick={() => setEditing(false)} />
            <button type="button" className="user-edit-send" aria-label="send edit" data-tip={t('Send', '发送')} onClick={sendEdit}>
              <ArrowUp size={14} strokeWidth={2.25} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="entry entry-user">
      <CollapsibleBubble
        text={entry.md}
        render={(md) => (
          <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={keepUrl} components={mdComponents}>{renderUserMd(md)}</ReactMarkdown>
        )}
      />
      <div className="user-actions">
        <TipButton
          className="user-action"
          tip={copied === 'ok' ? t('Copied', '已复制') : copied === 'fail' ? t('Not copied', '未复制') : t('Copy', '复制')}
          label="Copy"
          icon={copied === 'ok' ? <Check size={12} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={12} strokeWidth={1.75} aria-hidden="true" />}
          onClick={copy}
        />
        {onSend !== undefined && (
          <TipButton className="user-action" tip={t('Edit', '编辑')} label="Edit" icon={<PenLine size={12} strokeWidth={1.75} aria-hidden="true" />} onClick={openEdit} />
        )}
        {fetchAnchors !== undefined && onRewind !== undefined && (
          <TipButton
            className="user-action"
            tip={t('Rewind to this turn', '回到此轮')}
            label="Rewind"
            icon={<History size={12} strokeWidth={1.75} aria-hidden="true" />}
            onClick={() => setRewindOpen((v) => !v)}
          />
        )}
      </div>
      {rewindOpen && fetchAnchors !== undefined && onRewind !== undefined && (
        <RewindMenu
          onAnchors={fetchAnchors}
          onPick={(turn) => {
            setRewindOpen(false);
            onRewind(turn);
          }}
        />
      )}
    </div>
  );
});

/** 系统行图标(G11 §4):error=AlertCircle;notice 按 md 形态分流(委派 ✻=Bot/agent 消息 [a → b]
 *  =MessageSquare/通用=Info)。md 原文不动,纯前置装饰 */
function systemIconOf(entry: ChatEntry): ReactNode {
  if (entry.kind === 'error') return <AlertCircle size={12} strokeWidth={1.75} aria-hidden="true" />;
  if (entry.kind !== 'notice') return null;
  if (entry.md.startsWith('✻')) return <Bot size={12} strokeWidth={1.75} aria-hidden="true" />;
  if (/^\[[^\]]+ → [^\]]+\]/.test(entry.md)) return <MessageSquare size={12} strokeWidth={1.75} aria-hidden="true" />;
  return <Info size={12} strokeWidth={1.75} aria-hidden="true" />;
}

/** G14.19 旁白分类(G14 批):[skills]/[memory] 打头的学习/记忆系统信息用专用图标(Sparkles/
 *  Database 微着色)+剥标签前缀——与一般系统提示(Info 灰)一眼区分;非此类回 null 走 systemIconOf */
function noticeAccentOf(entry: ChatEntry): { icon: ReactNode; md: string } | null {
  if (entry.kind !== 'notice') return null;
  if (entry.md.startsWith('[skills]')) {
    return { icon: <Sparkles size={12} strokeWidth={1.75} aria-hidden="true" />, md: entry.md.slice('[skills]'.length).trimStart() };
  }
  if (entry.md.startsWith('[memory]')) {
    return { icon: <Database size={12} strokeWidth={1.75} aria-hidden="true" />, md: entry.md.slice('[memory]'.length).trimStart() };
  }
  return null;
}

/** 单条渲染单元(React.memo):reducer 保未动条目引用——流式 token 帧只有流式条重渲染(md 解析 O(1) 摊销)。
 *  G8d T5:streaming 条末挂流式光标 span.sx-stream-cursor(闪灭动画定义在 app.css 特批小段;done 收段
 *  条 streaming=false → 光标随 memo 重渲染退场)。G11 §4 结构化:.entry-md 包装(含 icon 时 has-icon
 *  类)+.entry-md-body 内 md 与光标(后代查询兼容)。G11 §6 终审:footer 收敛为 footerRun(条目引用
 *  而非元素)——调用面传 `runFooterByEntry.get(entry.key)`(undefined 恒稳定,reducer 保条目引用,浅
 *  比较恢复命中),组件内在场时自渲染 RunFooter;终审前传 ReactNode 每帧新建元素击穿 memo,长会话
 *  每 token 触发历史末条全文重解析 */
export const ChatEntryView = memo(function ChatEntryView({ entry, footerRun, onFork, onOpenFile, onOpenDiff, onRestore }: { entry: ChatEntry; footerRun?: ChatEntry; onFork?: () => void; onOpenFile?: (p: string) => void; onOpenDiff?: (path: string) => void; onRestore?: (path: string) => void }): JSX.Element {
  const accent = noticeAccentOf(entry);
  const icon = accent !== null ? accent.icon : systemIconOf(entry);
  // G14.85:正文工作区文件链接化(工厂按 onOpenFile 装配;引用稳定仅 onOpenFile 变化时重建)
  const mdc = useMemo(() => buildMdComponents(onOpenFile ?? (() => undefined)), [onOpenFile]);
  return (
    <div className={`entry entry-${entry.kind}${entry.streaming === true ? ' streaming' : ''}`}>
      <div className={`entry-md${icon !== null ? ' has-icon' : ''}`}>
        {icon !== null && <span className={`entry-icon${accent !== null ? ' accent' : ''}`}>{icon}</span>}
        <div className="entry-md-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={keepUrl} components={mdc}>{accent !== null ? accent.md : entry.md}</ReactMarkdown>
        </div>
      </div>
      {footerRun !== undefined && <RunFooter text={entry.md} run={footerRun} onFork={onFork} />}
      {footerRun !== undefined && footerRun.changes !== undefined && footerRun.changes.length > 0 && (
        <RunChangesBar
          changes={footerRun.changes}
          onOpenDiff={onOpenDiff}
          onRestore={onRestore}
        />
      )}
    </div>
  );
});
