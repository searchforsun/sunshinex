import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { AlertCircle, ArrowUp, Bot, Brain, Check, ChevronDown, ChevronRight, ChevronUp, Copy, Database, GitFork, Info, MessageSquare, PenLine, Sparkles, X, ImageOff } from 'lucide-react';
import { t } from '../../i18n';
import { localizeNotice } from '../../i18n-notice';
import { commandRunningLabel } from './ToolEntry';
import { pathBasename } from '../../ui-util';
import { useResolvedImages } from '../../images-cache';
import type { Connection } from '../../connection';
import { useCopyFeedback } from '../../use-copy-feedback';
import type { ChatEntry } from '../../chat-reducer';
import { buildMdComponents, keepUrl, RefTokenChip, rebuildPickTokens, renderMentionSpans, splitBrowserFences, useDirResolver, MD_REHYPE_PLUGINS, MD_REMARK_PLUGINS } from '../Chat';
import { RunChangesBar, RunFooter, TipButton } from './RunFooter';
import { ImageLightbox } from '../../ImageLightbox';
import { useDirOpener } from './md-render';
import { ComposerCard } from '../../composer/ComposerCard';
import { MAX_IMAGES, appendImages, loadImages } from '../../images';
import { EditComposer } from './edit-composer';
import { stripSideNote } from './side-note';
import type { ComposerEnv } from './edit-composer';
import { TurnConfirmDialog } from './rewind-confirm';
import type { RewindOps } from './chat-types';
import { hasUnclosedFence, streamMdCut } from './stream-md';

/** 会话条目渲染件群（D32 批C-4 拆分自 Chat.tsx）：run 状态行/思考折叠行/用户胶囊条(含编辑卡/
 *  回退菜单/折叠气泡)/系统行(含旁白着色)与单条渲染单元。memo 语义与 DOM 逐字节不变;md 渲染
 *  工厂(keepUrl/buildUserMdComponents/buildMdComponents/renderUserMd)与 token 工具留 Chat
 *  原路径消费。行为零变化(Chat.test 转录组为锚)。 */

/** 秒数格式(G14.118 中文单位,2026-10-25 扩时日档):<60s 「34秒」;≥60s 「5分 20秒」;≥1h 「6小时 1分」;
 *  ≥1d 「2天 3小时」(状态行/尾条共用;en 恒英文单位)——长任务(361分)不再挤在分钟档。
 *  2026-10-27 导出:等待模型待态行(MessageList pending)共用同一格式 */
export function runElapsed(seconds: number): string {
  if (seconds < 60) return t(`${seconds}s`, `${seconds}秒`);
  if (seconds < 3600) return t(`${Math.floor(seconds / 60)}m ${seconds % 60}s`, `${Math.floor(seconds / 60)}分 ${seconds % 60}秒`); // G14.185b 分秒之间加间隙
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return t(`${h}h ${m}m`, `${h}小时 ${m}分`);
  }
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  return t(`${d}d ${h}h`, `${d}天 ${h}小时`);
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
 *  推入旧文左流=「往前流动」,左缘 mask 渐隐);展开=全文内滚容器(streaming 时贴底闩吸底,
 *  直设 scrollTop 不平滑——逐 token 跟手;用户上翻即放手,同主对话非对称闩)。展开/折叠
 *  grid-rows 过渡(同工具行公式) */
export const ThinkingEntryView = memo(function ThinkingEntryView({ entry }: { entry: ChatEntry }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 展开体内滚贴底闩:仅距底 <4 重贴;上翻/滚轮即放手——流式 md 增长不得抵消用户阅读位 */
  const bodyStickRef = useRef(true);
  const streaming = entry.streaming === true;
  useEffect(() => {
    if (!streaming) return;
    const h = setInterval(() => setTick((v) => v + 1), 1_000); // G14.37:流式秒针——头部持续计数
    return () => clearInterval(h);
  }, [streaming]);
  useEffect(() => {
    if (open && streaming && bodyStickRef.current && scrollRef.current !== null) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [open, streaming, entry.md]);
  // G14.37 流式两件套:头部秒数持续计数 / 内容右向流动窗(G14.52:速率显示去——思考行占满整行)
  const elapsed = streaming && entry.ts !== undefined ? Math.max(1, Math.round((Date.now() - entry.ts) / 1000)) : undefined;
  const flow = streaming ? entry.md.slice(-220) : ''; // G14.79:加宽尾窗,宽行下思考内容充满整行
  return (
    <div className={`entry entry-thinking${open ? ' open' : ''}${streaming ? ' streaming' : ''}`}>
      <button
        type="button"
        className="thinking-summary"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => {
            if (!v) bodyStickRef.current = true; // 展开即贴底跟流
            return !v;
          });
          window.dispatchEvent(new Event('sx-row-toggle')); // 贴地时展开/收起→滚动跟随(use-chat-scroll)
        }}
      >
        <Brain size={12} strokeWidth={1.75} aria-hidden="true" />
        <span className="thinking-label">
          {streaming ? (
            /* 流光文字(2026-10-22 用户裁定:思考行与执行行同语言);秒数向上取整最少 1s(2026-10-29
               用户裁定「思考最少 1s,向上取整」——亚秒/0 值不再显 0 秒) */
            <span className="exec-running-text">{t(`Thinking ${Math.max(1, Math.ceil(elapsed ?? 0))}s`, `思考中 ${Math.max(1, Math.ceil(elapsed ?? 0))}秒`)}</span>
          ) : entry.seconds !== undefined ? (
            t(`Thought for ${Math.max(1, Math.ceil(entry.seconds))}s`, `思考 ${Math.max(1, Math.ceil(entry.seconds))}秒`)
          ) : (
            t('Thought', '思考')
          )}
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
          <div
            className="thinking-scroll"
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              bodyStickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
            }}
            onWheel={(e) => {
              if (e.deltaY < 0) bodyStickRef.current = false;
            }}
          >
            <pre className="thinking-detail">{entry.md}</pre>
          </div>
        </div>
      </div>
    </div>
  );
});

/** 用户条目(Codex 形,G9 spec §3.1):右对齐胶囊(前景 5%/8% 底)+ 下方 hover 浮现复制钮;
 *  G11 §7 增编辑卡:hover 浮现 Edit 钮,点击气泡原位变 composer 同款浮卡(textarea 预填原文——user md 裸文,P11
 *  原文+取消/发送)。发送(2026-11-05):配了 rewindOps=二次确认弹窗后回退到此条并重发;未配(辅助对话/
 *  测试桩)经 onSend 追加发送。成功才关卡(失败保卡保草稿,spec §9),Esc 取消回气泡。md 的 `> ` 引用形态在胶囊内平铺(CSS 收平)。
 *  复制失败(权限等)钮 1.5s 示「未复制」tertiary 态,不弹错。memo 同 ChatEntryView——流式帧
 *  只重渲染流式条(未包 memo 时每帧带动 user 条 md 重渲染,计数回归被击穿);onSend 由调用面
 *  传 useCallback 稳定引用,memo 语义保持。 */
interface UserEntryOpts {
  /** G14.110 气泡内 @文件 token 点击 → 打开 file 标签(未配=无行为) */
  onOpenFile?: (p: string) => void;
  /** §7 编辑卡发送回调(=Chat.submitText,Promise:void:resolve 关卡,reject 保卡保草稿——
   *  spec §9 提交失败草稿不丢):未配不渲染 Edit 钮(测试桩免配);images=随行图片附件
   *  (2026-10-26 图片功能:编辑卡预填原条图片,重发随行) */
  onSend?: (text: string, images?: string[]) => Promise<void>;
  /** 回退操作面(主对话配;在场时编辑发送=二次确认弹窗后回退到此条并重发) */
  rewindOps?: RewindOps;
  /** 编辑卡输入环境(@短写记账表与 sessionId——EditComposer 与宿主发送链共享) */
  composerEnv?: ComposerEnv;
  /** 气泡缩略图点击开查看浮层(2026-10-26 图片功能;未配=缩略图不可点) */
  onOpenImage?: (src: string) => void;
}

/** 用户气泡图片条(2026-10-26 图片功能):文本上方横排缩略图(截图口径——图上文下);
 *  点击开 lightbox(缩放/复制/下载)。空图不渲染 */
/** 图片占位标识(2026-10-31 用户裁定「无法渲染(原始图片删除了)也要渲染占位的图片标识」):
 *  引用解析失败面——图标+文件名,不显破图;布局随缩略图位(.user-img-strip/.tool-images 通用) */
export function ImageMissing({ name, size = 96 }: { name: string; size?: number }): JSX.Element {
  // 默认 96×96=用户气泡缩略图同尺寸(app.css .user-img-strip img 口径);工具行可传小档
  return (
    <span
      className="img-missing"
      role="img"
      aria-label={t('Image unavailable', '图片不可用')}
      data-tip={`${t('Image unavailable', '图片不可用')}
${name}`}
      style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, width: size, height: size, borderRadius: 'var(--radius-sm)', border: '1px dashed var(--border)', color: 'var(--fg-secondary)', background: 'color-mix(in srgb, var(--fg-secondary) 6%, transparent)', fontSize: 10, overflow: 'hidden', padding: 4, textAlign: 'center', wordBreak: 'break-all', lineHeight: 1.2 }}
    >
      <ImageOff size={Math.max(14, Math.round(size / 5))} strokeWidth={1.75} aria-hidden="true" />
      <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name.split(/[\/]/).pop() ?? name}</span>
    </span>
  );
}

function UserImageStrip({ conn, root, images, onOpen }: { conn?: Connection | null; root?: string; images: readonly string[]; onOpen?: (src: string) => void }): JSX.Element | null {
  const resolved = useResolvedImages(conn ?? null, root, images); // 本地地址 → dataURL;失败=null 占位(2026-10-31 裁定)
  if (images.length === 0) return null;
  return (
    <div className="user-img-strip">
      {images.map((src, i) => (
        resolved[i] === null ? (
          <ImageMissing key={`${i}:${src.slice(-24)}`} name={src} />
        ) : (
        <img
          key={`${i}:${src.slice(-24)}`}
          src={resolved[i] || src}
          alt={`${t('Attached image', '附件图片')} ${i + 1}`}
          /* 2026-10-26 懒加载+异步解码(大截图首滚入视口的主线程解码冻结)——边框/圆角统一在
             app.css .user-img-strip img(明暗主题自适应 color-mix,气泡/输入框/编辑卡同源) */
          loading="lazy"
          decoding="async"
          className={onOpen !== undefined ? 'clickable' : undefined}
          onClick={onOpen !== undefined && resolved[i] ? () => onOpen(resolved[i]!) : undefined}
        />
        )
      ))}
    </div>
  );
}
/** G14.181/G14.202 用户气泡限高折叠:默认 168px;折叠态最后一行渐变隐现(加强);
 *  展开钮在气泡下侧居中(独占一行不占内容);展开钮=气泡下侧居中独钮;复制归各页自有动作行。
 *  量测走 useLayoutEffect+ResizeObserver:队友消息/子智能体任务带首帧常在 flex 未定宽时
 *  scrollHeight 偏小(一次 useEffect 钉死不折),布局收敛后须再量 */
const USER_BUBBLE_CLAMP = 168;
export function CollapsibleBubble({ text, render }: { text: string; render: (md: string) => ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const innerRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (el === null) return;
    // scrollHeight=内容全高(与 max-height/overflow 无关)——超过阈值才出浮钮
    const measure = (): void => {
      setClamped(el.scrollHeight > USER_BUBBLE_CLAMP + 8);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
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

export const UserEntryView = memo(function UserEntryView({ entry, insert, onSend, rewindOps, composerEnv, onOpenImage, onOpenFile, conn, root, sideChat }: { entry: ChatEntry; insert?: boolean; conn?: Connection | null; root?: string; sideChat?: boolean } & UserEntryOpts): JSX.Element {
  const { status: copied, copy: copyText } = useCopyFeedback();
  /** 2026-11-06 用户裁定「fork 说明只进上下文不进气泡」:首条播种的注入前缀显示侧剥离
   *  (模型上下文原样,辅助会话转录只呈现用户真实请求;重启重放同径) */
  const displayMd = sideChat === true ? stripSideNote(entry.md) : entry.md;
  const [confirm, setConfirm] = useState<{ text: string; images?: string[] } | null>(null);
  const [editHint, setEditHint] = useState('');
  const confirmDialog = confirm !== null && rewindOps !== undefined && (
    <TurnConfirmDialog
      resend
      loadPlan={() => rewindOps.planForEntry(entry)}
      onCancel={() => setConfirm(null)}
      onConfirm={(restoreFiles) => {
        const run = rewindOps.resendFrom(entry, confirm.text, confirm.images, restoreFiles);
        return run.then(
          () => {
            setConfirm(null);
            setEditing(false);
          },
          () => setConfirm(null), // 错误提示归宿主;编辑卡与草稿保留
        );
      }}
    />
  );
  const copy = (): void => {
    copyText(displayMd); // P11:user md 裸文(内核渲染中立)——正文合法以 > 开头者不再误剥
  };
  const [editing, setEditing] = useState(false);
  const [editLightbox, setEditLightbox] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [draftImages, setDraftImages] = useState<string[]>([]);
  /** 附件图片入列(+面板/粘贴;上限守卫随 Chat 同款,溢出提示落编辑卡提示行) */
  const appendDraftImages = useCallback((files: File[]): void => {
    void loadImages(files).then((imgs) => {
      setDraftImages((cur) => {
        const { images: next, overflow } = appendImages(cur, imgs);
        if (overflow > 0) setEditHint(t(`Up to ${MAX_IMAGES} images per message`, `每条消息最多 ${MAX_IMAGES} 张图片`));
        return next;
      });
    });
  }, []);
  const openEdit = (): void => {
    // 编辑回填重 token 化(2026-11-04 用户裁定「编辑页也保持 chip」):载入的展开档文按围栏折回
    // token+注册表记账——composer 恢复芯片态,重发经 expandRefContents(注册表兜底)展开回原形态
    setDraft(rebuildPickTokens(entry.md));
    setDraftImages(entry.images ?? []); // 编辑卡预填原条图片（随行重发/可移除）
    setEditing(true);
  };
  const sendEdit = (): void => {
    const text = draft.trim();
    if (text === '' && draftImages.length === 0) {
      setEditing(false); // 空文本且无图:关卡不发(现状保持;纯图允许——图片即消息)
      return;
    }
    if (rewindOps !== undefined) {
      if (rewindOps.busy()) {
        setEditHint(t('The session is running. Stop it before editing and resending.', '会话运行中,请先停止再编辑重发'));
        return;
      }
      setEditHint('');
      setConfirm({ text, ...(draftImages.length > 0 ? { images: draftImages } : {}) });
      return;
    }
    const result = onSend?.(text, draftImages.length > 0 ? draftImages : undefined);
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
    /* 2026-11-06 用户裁定「编辑页直接替换成底部输入框的样式大小」:整卡换 ComposerCard 同款壳
       (同宽同高同 max-height),/ @ $ # 触发面板与 + 附加面板全量(EditComposer);
       conn/composerEnv 缺席(测试桩/旁路面)退纯壳兜底——无面板,Esc 关卡 Enter 发送 */
    return (
      <div className="entry entry-user" data-entry-key={entry.key}>
        {editLightbox !== undefined && <ImageLightbox src={editLightbox} onClose={() => setEditLightbox(undefined)} />}
        {editHint !== '' && <div className="user-edit-hint" role="alert">{editHint}</div>}
        {conn !== undefined && conn !== null && composerEnv !== undefined ? (
          <EditComposer
            conn={conn}
            sessionId={composerEnv.sessionId}
            root={root}
            pickRelRef={composerEnv.pickRelRef}
            value={draft}
            onChange={setDraft}
            images={draftImages}
            onRemoveImage={(i) => setDraftImages((cur) => cur.filter((_, idx) => idx !== i))}
            onImageOpen={setEditLightbox}
            onAddImageFiles={appendDraftImages}
            onSend={sendEdit}
            onCancel={() => setEditing(false)}
            onOpenFile={onOpenFile}
          />
        ) : (
          <ComposerCard
            label="edit message"
            value={draft}
            placeholder={t('Edit message', '编辑消息')}
            onChange={setDraft}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                setEditing(false);
              } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                sendEdit();
              }
            }}
            images={draftImages}
            onRemoveImage={(i) => setDraftImages((cur) => cur.filter((_, idx) => idx !== i))}
            onImageOpen={setEditLightbox}
            footRight={
              <div className="composer-pills">
                <button type="button" className="user-edit-cancel" aria-label="cancel edit" data-tip={t('Cancel', '取消')} onClick={() => setEditing(false)}>
                  <X size={16} strokeWidth={2} aria-hidden="true" />
                </button>
                <button type="button" className="send tip-right" aria-label="send edit" data-tip={`${t('Send', '发送')} · Enter`} onClick={sendEdit}>
                  <ArrowUp size={16} strokeWidth={2.25} aria-hidden="true" />
                </button>
              </div>
            }
          />
        )}
        {confirmDialog}
      </div>
    );
  }
  return (
    <div className={`entry entry-user${insert === true ? ' entry-user-insert' : ''}`} data-entry-key={entry.key}>
      {/* 2026-10-26 用户裁定:图片与气泡分离——图片条独立在气泡外(上方右对齐),纯图消息不渲染空气泡 */}
      {entry.images !== undefined && entry.images.length > 0 && (
        <UserImageStrip conn={conn} root={root} images={entry.images} onOpen={onOpenImage} />
      )}
      {displayMd.trim() !== '' && (
        <CollapsibleBubble
          text={displayMd}
          render={(md) => (
            /* 2026-11-04 用户裁定:用户气泡不做任何 md 格式化渲染(标题/加粗/代码块/表格/链接
               一律原文)——仅 @文件 /命令 ⟦引用⟧ 特殊 token 走 chip 高亮(renderMentionSpans,
               与输入框高亮同口径);换行经 pre-wrap 保真。2026-11-04 裁定续:发送期展开落档的
               browser-element 全文围栏在显示侧折叠回芯片(hover 展开全文,splitBrowserFences) */
            md.trim() !== '' ? (
              <div className="user-md-plain">
                {splitBrowserFences(md).map((seg, i) =>
                  'fence' in seg ? <RefTokenChip key={i} inner={seg.label} isTerm={seg.kind === 'text-selection'} content={seg.fence} /> : <Fragment key={i}>{renderMentionSpans(seg.text, undefined, undefined, onOpenFile)}</Fragment>,
                )}
              </div>
            ) : null
          )}
        />
      )}
      <div className="user-actions">
        <TipButton
          className="user-action"
          tip={copied === 'ok' ? t('Copied', '已复制') : copied === 'fail' ? t('Not copied', '未复制') : t('Copy', '复制')}
          label="Copy"
          icon={copied === 'ok' ? <Check size={12} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={12} strokeWidth={1.75} aria-hidden="true" />}
          onClick={copy}
        />
        {/* 2026-11-06 用户裁定 P2:辅助会话正文不再支持编辑用户气泡——入口裁剪 */}
        {onSend !== undefined && sideChat !== true && (
          <TipButton className="user-action" tip={t('Edit', '编辑')} label="Edit" icon={<PenLine size={12} strokeWidth={1.75} aria-hidden="true" />} onClick={openEdit} />
        )}
      </div>
      {confirmDialog}
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

/** agent-message / inbox drain 通知：`[from → to] text`。气泡只展示来源名与正文。 */
function agentMessageOf(entry: ChatEntry): { from: string; text: string } | null {
  if (entry.kind !== 'notice') return null;
  const m = /^\[([^\]]+) → ([^\]]+)\] ([\s\S]*)$/.exec(entry.md);
  if (m === null || m[1] === undefined) return null;
  return { from: m[1], text: m[3] ?? '' };
}

/** G14.19 旁白分类(G14 批):[skills]/[memory] 打头的学习/记忆系统信息用专用图标(Sparkles/
 *  Database 微着色)+剥标签前缀——与一般系统提示(Info 灰)一眼区分;非此类回 null 走 systemIconOf。
 *  2026-10-31 用户裁定 i18n+可点:saved/updated/learned 动词本地化(添加记忆/更新记忆/添加技能/
 *  更新技能),tag/ref 随返(渲染面 data-* 落 DOM,Chat 容器点击委托开对应侧栏页签定位) */
function noticeAccentOf(entry: ChatEntry): { icon: ReactNode; md: string; tag?: 'memory' | 'skills'; ref?: string } | null {
  if (entry.kind !== 'notice') return null;
  if (entry.md.startsWith('[skills]')) {
    const rest = entry.md.slice('[skills]'.length).trimStart();
    const m = /^(learned|updated):\s*(\S+)/.exec(rest);
    if (m !== null) {
      const zh = m[1] === 'learned' ? t('Skill added', '添加技能') : t('Skill updated', '更新技能');
      return { icon: <Sparkles size={12} strokeWidth={1.75} aria-hidden="true" />, md: `${zh}: ${m[2]}`, tag: 'skills', ref: m[2] };
    }
    return { icon: <Sparkles size={12} strokeWidth={1.75} aria-hidden="true" />, md: rest };
  }
  if (entry.md.startsWith('[memory]')) {
    const rest = entry.md.slice('[memory]'.length).trimStart();
    const m = /^(saved|updated):\s*(.+)$/.exec(rest);
    if (m !== null) {
      const zh = m[1] === 'saved' ? t('Memory saved', '添加记忆') : t('Memory updated', '更新记忆');
      const first = m[2].split(',')[0]?.trim() ?? '';
      return { icon: <Database size={12} strokeWidth={1.75} aria-hidden="true" />, md: `${zh}: ${m[2]}`, tag: 'memory', ref: first };
    }
    return { icon: <Database size={12} strokeWidth={1.75} aria-hidden="true" />, md: rest };
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
/** 流式分域渲染(对齐 TUI 块缓冲口径,2026-10-22 用户报障「正文流式期间状态行向下抖动」):
 *  已完成块=整块 markdown(memo——头串稳定即跳过重解析),在途尾块=markdown 实时渲染。
 *  2026-10-25 用户裁定「实时渲染从上层统一定,穷尽不完」:结构前缀枚举(tailIsStructured)
 *  退役——代码块/引用行等随 token 成形;切分见 streamMdCut(围栏内空行不切断)。mermaid 未闭合=
 *  live 试渲流式(节流成图随流生长,半截语法保留上一帧;2026-10-30 用户报障「无法实时流式渲染」
 *  推翻此前零 render 等闭合策略);闭合后正式成图入缓存。尾块=在途块,晋升并入 memo 头 */
const MarkdownHead = memo(function MarkdownHead({ md, components }: { md: string; components: Components }): JSX.Element {
  if (md === '') return <></>;
  return (
    <ReactMarkdown remarkPlugins={MD_REMARK_PLUGINS} rehypePlugins={MD_REHYPE_PLUGINS} urlTransform={keepUrl} components={components}>
      {md}
    </ReactMarkdown>
  );
});

/** 斜杠命令三态系统提示行(2026-10-31 用户裁定「显示成系统提示行,不是普通工具行;系统提示也要
 *  三态;不受工具折叠影响」):daemon runCommand 落的 tool-call/tool-result 行(name=/cmd)在此以
 *  notice 形态直渲——运行中 spinner+「上下文压缩中」/完成 ✓+回执/失败 ✗+错误;不进 ToolSegBlock
 *  聚合,不入轮次折叠区(use-chat-fold 同步豁免) */
export function isCommandEntry(e: ChatEntry): boolean {
  return e.kind === 'tool' && typeof e.name === 'string' && e.name.startsWith('/');
}
export const CommandEntryView = memo(function CommandEntryView({ entry }: { entry: ChatEntry }): JSX.Element {
  const name = entry.name ?? '';
  const done = entry.result !== undefined;
  const failed = done && entry.result?.ok === false;
  const text = done ? localizeNotice(entry.result?.text ?? '') : commandRunningLabel(name); // 运行态由波纹承载,不加 …(2026-10-31 裁定)
  // 统一样式语言(2026-10-31 用户裁定「不要 ✓;成功=灰色叹号系统提示,失败=红色叹号+背景框」):
  // 成功/运行中=entry-notice(Info 灰);失败=entry-error(AlertCircle err 色+err 底框,与 error 条同款)
  return (
    <div className={`entry ${failed ? 'entry-error' : 'entry-notice'} cmd-entry`} role="status" data-cmd={name} data-state={!done ? 'running' : failed ? 'failed' : 'done'}>
      <div className="entry-md has-icon">
        <span className="entry-icon">
          {failed ? <AlertCircle size={12} strokeWidth={1.75} aria-hidden="true" /> : <Info size={12} strokeWidth={1.75} aria-hidden="true" />}
        </span>
        <div className={`entry-md-body${!done ? ' exec-running-text' : ''}`}>{text !== '' ? text : name}</div>
      </div>
    </div>
  );
});

export const ChatEntryView = memo(function ChatEntryView({ entry, footerRun, onFork, onOpenFile, onOpenDiff, onRestore, onOpenAgent, onOpenSession, sideChat }: { entry: ChatEntry; footerRun?: ChatEntry; onFork?: (runKey: string) => void; onOpenFile?: (p: string) => void; onOpenDiff?: (path: string) => void; onRestore?: (path: string) => void; onOpenAgent?: (label: string, agentTitle: string, task?: string) => void; onOpenSession?: (sessionId: string) => void; sideChat?: boolean }): JSX.Element {
  const msg = agentMessageOf(entry);
  const accent = noticeAccentOf(entry);
  const icon = accent !== null ? accent.icon : systemIconOf(entry);
  const { status: copied, copy: copyText } = useCopyFeedback();
  // G14.85:正文工作区文件链接化(工厂按 onOpenFile 装配;引用稳定仅 onOpenFile 变化时重建);
  // isDir=目录解析(目录链接显黄目录;context 缺省恒 false——代理转录等无会话索引面按文件)
  const isDir = useDirResolver();
  const openDir = useDirOpener();
  const mdc = useMemo(() => buildMdComponents(onOpenFile ?? (() => undefined), isDir, { onOpenDirectory: openDir ?? undefined }), [onOpenFile, isDir, openDir]);
  const streaming = entry.streaming === true;
  // 块缓冲切分:安全空行为界(未闭合围栏不切断)——前段=已完成块,尾段=在途块
  let headMd = '';
  let tailMd = '';
  if (streaming && accent === null) {
    const cut = streamMdCut(entry.md);
    headMd = cut.head;
    tailMd = cut.tail;
  }
  const mermaidDraft = streaming && hasUnclosedFence(tailMd);
  const mdcTail = useMemo(
    () => buildMdComponents(onOpenFile ?? (() => undefined), isDir, { mermaidDraft, onOpenDirectory: openDir ?? undefined }),
    [onOpenFile, isDir, mermaidDraft, openDir],
  );
  if (msg !== null) {
    // 与插入档用户胶囊同形(+发送人名可点;无编辑):限高折叠 + 下沿复制
    return (
      <div className="entry entry-user entry-user-insert agent-msg" data-from={msg.from}>
        <div className="agent-msg-head">
          <MessageSquare size={12} strokeWidth={1.75} aria-hidden="true" />
          {onOpenAgent !== undefined ? (
            <button
              type="button"
              className="agent-msg-from"
              data-tip={t('View member', '查看成员')}
              onClick={() => onOpenAgent(msg.from, msg.from)}
            >
              {msg.from}
            </button>
          ) : (
            <span className="agent-msg-from">{msg.from}</span>
          )}
        </div>
        {msg.text !== '' && (
          <CollapsibleBubble text={msg.text} render={(md) => <div className="agent-msg-text">{md}</div>} />
        )}
        <div className="user-actions">
          <TipButton
            className="user-action"
            tip={copied === 'ok' ? t('Copied', '已复制') : copied === 'fail' ? t('Not copied', '未复制') : t('Copy', '复制')}
            label="Copy"
            icon={copied === 'ok' ? <Check size={12} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={12} strokeWidth={1.75} aria-hidden="true" />}
            onClick={() => copyText(msg.text)}
          />
        </div>
      </div>
    );
  }
  // 2026-11-06 用户裁定 P3:辅助会话与主会话绑定,不渲染「以上内容分叉自会话」fork 注记
  if (sideChat === true && entry.kind === 'notice' && entry.md.startsWith('[fork-origin]')) return <></>;
  if (entry.kind === 'notice' && entry.md.startsWith('[fork-origin]')) {
    // fork 分割点(合成 notice 段行,daemon attach 按 upToLine 边界装载):文案即分割语义——
    // 本行**以上**=fork 前来自父会话的内容,**以下**=子会话新内容;父会话名可点回源。
    // 坏编码退普通 notice 渲染不丢行
    let info: { sessionId: string; title: string } | null = null;
    try {
      const parsed = JSON.parse(entry.md.slice('[fork-origin]'.length)) as { sessionId?: unknown; title?: unknown };
      if (typeof parsed.sessionId === 'string' && typeof parsed.title === 'string') info = { sessionId: parsed.sessionId, title: parsed.title };
    } catch {
      /* 退普通 notice */
    }
    if (info !== null) {
      return (
        <div className="entry entry-notice fork-origin" role="status">
          <span className="entry-icon">
            <GitFork size={12} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <div className="entry-md">
            {t('Content above forked from session', '以上内容分叉自会话')}：
            <button type="button" className="fork-origin-link" onClick={() => onOpenSession?.(info!.sessionId)}>
              {info!.title}
            </button>
          </div>
        </div>
      );
    }
  }
  return (
    <div
      className={`entry entry-${entry.kind}${streaming ? ' streaming' : ''}`}
      {...(accent?.tag !== undefined
        ? { 'data-notice-tag': accent.tag, 'data-notice-ref': accent.ref ?? '', 'data-notice-clickable': '1' }
        : {})}
    >
      <div className={`entry-md${icon !== null ? ' has-icon' : ''}`}>
        {icon !== null && <span className={`entry-icon${accent !== null ? ' accent' : ''}`}>{icon}</span>}
        <div className="entry-md-body">
          {streaming ? (
            <>
              <MarkdownHead md={headMd} components={mdc} />
              {/* 尾块:未闭合 mermaid=live 试渲随流成图;闭合后正式成图(迁头块,缓存命中零闪) */}
              {tailMd !== '' && (
                <div className="entry-stream-tail-md">
                  <ReactMarkdown remarkPlugins={MD_REMARK_PLUGINS} rehypePlugins={MD_REHYPE_PLUGINS} urlTransform={keepUrl} components={mdcTail}>
                    {tailMd}
                  </ReactMarkdown>
                </div>
              )}
            </>
          ) : (
            <ReactMarkdown remarkPlugins={MD_REMARK_PLUGINS} rehypePlugins={MD_REHYPE_PLUGINS} urlTransform={keepUrl} components={mdc}>{accent !== null ? accent.md : entry.md}</ReactMarkdown>
          )}
        </div>
      </div>
      {/* 2026-11-06 用户裁定 P2:辅助会话正文不渲染 fork/回退行 */}
      {/* 辅助会话仅裁 fork 入口(2026-11-06 用户裁定「只让去掉 fork 入口」):复制/步数/tokens/时间照常 */}
      {footerRun !== undefined && <RunFooter text={entry.md} run={footerRun} onFork={sideChat === true ? undefined : onFork} />}
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
