import { Fragment, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { zoomScale } from '../../ui-zoom';
import { t } from '../../i18n';
import { FileIcon } from '../../file-icon';
import { FileText, Globe, SquareTerminal } from 'lucide-react';
import { isAbsPath } from '../../ui-util';
import type { RefItem } from './ref-palette';

/** @ 引用域（D32 批C-5 拆分自 Chat.tsx）：@ 文件模糊匹配与面板渲染件、mention token 解析/
 *  原子编辑判定（整删/原子区间/beforeinput 判定/caret 定位）/输入框高亮/发送期展开/用户气泡
 *  token 视觉化。纯函数域为主（FilePalette/renderMentionSpans 两渲染面随域）；composer 键
 *  处理管线消费侧留 Chat。行为零变化（Chat.test 与欢迎页复用为锚）。 */

/** G14.85 @ 文件模糊匹配:子序列命中(G14.121 导出共享——欢迎页 composer 同一面板) */
export function fileHit(file: string, query: string): boolean {
  if (query === '') return true;
  let i = 0;
  const fl = file.toLowerCase();
  for (const ch of query.toLowerCase()) {
    i = fl.indexOf(ch, i);
    if (i < 0) return false;
    i += 1;
  }
  return true;
}

/** G14.2xx 命中排序:精确 basename > 前缀 > 包含 > 路径包含 > 子序列,同级保原序(目录清单在前)。
 *  子序列命中无定位语义——@query 精中某文件/目录时它必须置顶(回车即中),否则目标可能沉底,
 *  残留 active 位上 Enter 选中邻项(用户实测:输 @harness 回车选中 src/harness/tools/)。
 *  cap=面板可视上限,排序后再截——避免子序列远缘命中挤掉精确项 */
export function rankFileHits(files: string[], query: string, cap = 12): string[] {
  const hits = files.filter((f) => fileHit(f, query));
  const q = query.trim().toLowerCase();
  if (q === '') return hits.slice(0, cap);
  const baseOf = (f: string): string => {
    const b = f.replace(/[\\/]+$/, '');
    const i = b.lastIndexOf('/');
    return (i < 0 ? b : b.slice(i + 1)).toLowerCase();
  };
  const rank = (f: string): number => {
    const b = baseOf(f);
    if (b === q) return 0;
    if (b.startsWith(q)) return 1;
    if (b.includes(q)) return 2;
    if (f.toLowerCase().includes(q)) return 3;
    return 4;
  };
  return hits
    .map((f, i) => ({ f, i, r: rank(f) }))
    .sort((x, y) => (x.r !== y.r ? x.r - y.r : x.i - y.i))
    .slice(0, cap)
    .map((x) => x.f);
}

/** G14.85 @ 文件面板:工作区文件清单(G14.134 行=文件名+紧跟的相对目录后缀;
 *  G14.121 导出共享——欢迎页复用;G14.135 通栏定位不随 @ 移动) */
export function FilePalette({
  items,
  active,
  onPick,
  onHover,
}: {
  items: string[];
  active: number;
  onPick: (p: string) => void;
  onHover: (i: number) => void;
}): JSX.Element {
  // G14.163 ↑↓ 移动时选中项滚入可视区(block:nearest 最小滚动;过滤后 items 变也跟随)
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active, items]);
  return (
    <div className="file-palette" role="listbox" aria-label={t('Workspace files', '工作区文件')}>
      <div className="sx-plus-sec">{t('Files', '文件')}</div>
      {items.length === 0 && <div className="file-palette-empty">{t('No matching files', '无匹配文件')}</div>}
      {items.map((f, i) => {
        // 目录项(工作区索引 dirs,尾斜杠内部标记):黄目录图标(FileIcon 尾斜杠判)即区分,
        // 名/父目录后缀按剥斜杠取,显示不再追加斜杠
        const bare = f.replace(/[\\/]+$/, '');
        const si = bare.lastIndexOf('/');
        const base = si < 0 ? bare : bare.slice(si + 1);
        const dir = si < 0 ? '' : bare.slice(0, si + 1);
        return (
          <button
            key={f}
            ref={i === active ? activeRef : undefined}
            type="button"
            role="option"
            aria-selected={i === active}
            className={`file-palette-row${i === active ? ' active' : ''}`}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(f)}
          >
            <FileIcon path={f} />
            <span className="file-palette-name">{base}</span>
            {dir !== '' && <span className="file-palette-dir">{dir}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** agents-teams P1 Task 4（spec §3.2）：$/# 引用面板（2026-11-05 用户裁定：$ 与 # 拆开，各自
 *  单域单游标，行=符号着色 + id + 展示名后缀，无组头文字）；全池空/过滤无命中=渲染 emptyHint
 *  引导行（静默隐藏=弹了等于没弹）。键盘（↑↓ 循环/Enter 插入/Esc）在 use-composer-keys 与
 *  @ 面板同链；插入文本由调用面拼装（R4：`$id `/`#id ` 尾随空格，插入即终态无记账）。 */
export function RefPalette({
  items,
  active,
  onPick,
  onHover,
  emptyHint,
}: {
  items: RefItem[];
  active: number;
  onPick: (item: RefItem) => void;
  onHover: (i: number) => void;
  /** 空态引导(2026-11-05 用户实测:零目录时面板静默隐藏=弹了等于没弹)——items 空时渲染
   *  非交互提示行(池空=指路设置面;有池无匹配=无匹配),面板不再以空渲染关自己的门 */
  emptyHint?: string;
}): JSX.Element {
  // G14.163 同款：↑↓ 移动时选中项滚入可视区(block:nearest 最小滚动)
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active, items]);
  return (
    <div className="ref-palette" role="listbox" aria-label={t('Sub-agents and agent teams', '子智能体与智能体团队')}>
      {items.length > 0 && <div className="sx-plus-sec">{items[0].sym === '#' ? t('Agent teams', '智能体团队') : t('Sub-agents', '子智能体')}</div>}
      {items.length === 0 && emptyHint !== undefined && <div className="ref-palette-empty">{emptyHint}</div>}
      {items.map((item, i) => {
        // 组头文字退役(2026-11-05 用户裁定:#$ 面板不显示「智能体」等文字头——行首符号着色已
        // 自明,$/# 又拆开各自单域,头部再标域属冗余)
        return (
          <Fragment key={`${item.sym}${item.id}`}>
            <button
              ref={i === active ? activeRef : undefined}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`ref-palette-row${i === active ? ' active' : ''}`}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(item)}
            >
              <span className={`ref-palette-sym ref-palette-sym-${item.sym === '$' ? 'agent' : 'team'}`} aria-hidden="true">
                {item.sym}
              </span>
              <span className="ref-palette-id">{item.id}</span>
              <span className="ref-palette-name">{item.name}</span>
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

/** G14.85 工具体用无链接版(输出面不需要文件交互) */
/** G14.95 token 提取:@路径=文件引用;/词(行首/空白后)=命令或技能引用;2026-11-04 §3.1 扩
 *  $智能体/#团队 软引用(词边界起手+小写首字符:#L30/#Title/词中 $var 天然不命中)。
 *  返回分段序列(plain 原样、其余着色)——输入框高亮层与用户气泡共用一套口径 */
export interface MentionToken {
  text: string;
  kind: 'plain' | 'file' | 'cmd' | 'skill' | 'ref' | 'agent' | 'team' | 'mdlink';
}

export function splitMentionTokens(text: string): MentionToken[] {
  // G14.121 @ 分支扩 `:\\`:绝对路径 token(D:/ws/a.ts、D:\ws\a.ts)整体着色
  // 2026-11-04 ref 分支:⟦…⟧ 元素/终端片段引用(选取面插入,发送期 expandRefContents 展开全量)
  // 2026-11-04 §3.1 加 $/# 软引用支:词边界组+小写首字符(小写限定即测试语义——
  // #L30 行锚/#Title/词中 $var 均不误伤)。原 /gi 的 i 对 @、/ 两支只有 [a-z] 一处生效,
  // 改显式 [a-zA-Z] 后两支逐字节不变;保 i 则 #Title 反而命中,故全局旗降为 /g
  // 2026-11-04 md 链接支(首支,无捕获组不位移):发送期展开落档的文件引用形态
  // `[名 L19-L22](路径#L19-L22)` 整体成原子 token——编辑回填/气泡/队列按文件芯片渲染
  const re = /\[[^\]\n]+\]\([^()\s]+\)|@[\w./:\\-]+|⟦[^⟧]{1,120}⟧|(^|\s)(\/[a-zA-Z][\w-]*)|(^|\s)([$#][a-z][a-z0-9-]*)/g;
  const out: MentionToken[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    const matched = m[0];
    if (idx > last) out.push({ text: text.slice(last, idx), kind: 'plain' });
    if (matched.startsWith('[')) out.push({ text: matched, kind: 'mdlink' });
    else if (matched.startsWith('@')) out.push({ text: matched, kind: 'file' });
    else if (matched.startsWith('⟦')) out.push({ text: matched, kind: 'ref' });
    else if (matched.startsWith('/') || m[2] !== undefined) {
      const lead = m[1] ?? '';
      if (lead !== '') out.push({ text: lead, kind: 'plain' });
      const word = m[2] ?? '';
      const atLineStart = idx === 0;
      // 2026-11-05 用户二次裁定:行中 /word 保 skill 芯片照亮(视觉),「普通文本」仅指派发语义
      //(整条照发、模型软加载,无徽标不碍加载的反面——无芯片才碍用户识别);行首 /词 = cmd
      out.push({ text: word, kind: atLineStart ? 'cmd' : 'skill' });
    } else {
      // $/# 软引用:lead(行首为空串/空白)记 plain,token 按 $→agent、#→team
      const lead = m[3] ?? '';
      if (lead !== '') out.push({ text: lead, kind: 'plain' });
      const word = m[4] ?? '';
      out.push({ text: word, kind: word.startsWith('$') ? 'agent' : 'team' });
    }
    last = idx + matched.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: 'plain' });
  return out;
}

/** 用户气泡 markdown 的 token 视觉化:token 包行内 code(特殊样式),原文不变(复制走 entry.md);
 *  P10:内核 `> ` 前缀已在投影层剥除(chat-reducer mapEntries)——此处收裸文本,仅对行内内容做 token 包装。
 *  G14.116 file token 显形去 @ 前缀(图标+名称由 buildUserMdComponents 接管)。
 *  2026-11-04 §3.1:$/# 软引用(agent/team)与 cmd/skill 同款行内 code 包装(尾分支自然覆盖,
 *  色别不在气泡处硬编码——composer 高亮层以 hn-agent/hn-team 类区分,CSS 侧取 --accent/--warn 变量) */
export function renderUserMd(md: string): string {
  const wrap = (line: string): string =>
    splitMentionTokens(line)
      .map((t) => {
        if (t.kind === 'plain') return t.text;
        if (t.kind === 'file') return '`' + (t.text.startsWith('@') ? t.text.slice(1) : t.text) + '`';
        if (t.kind === 'ref') return '`' + t.text.slice(1, -1) + '`';
        return '`' + t.text + '`';
      })
      .join('');
  return md
    .split('\n')
    .map((line) => {
      const m = /^(> ?)(.*)$/.exec(line);
      return m === null ? wrap(line) : m[1] + wrap(m[2] ?? '');
    })
    .join('\n');
}

/** G14.156 token 整删判定:Backspace/Delete 与 caret → 应整删的 token 区间(无则 null)。
 *  非明文 token(文件/命令/技能)作为整体:Backspace 在 token 内(含末位)、Delete 在 token 内(含首位)即整删 */
export function tokenDeleteRange(text: string, caret: number, key: 'Backspace' | 'Delete'): [number, number] | null {
  let pos = 0;
  for (const tk of splitMentionTokens(text)) {
    if (tk.kind === 'plain') { pos += tk.text.length; continue; }
    const s = pos;
    const e2 = pos + tk.text.length;
    pos = e2;
    if (key === 'Backspace' && caret > s && caret <= e2) return [s, e2];
    if (key === 'Delete' && caret >= s && caret < e2) return [s, e2];
  }
  return null;
}

/** G14.212 token 原子区间:编辑区间与非明文 token 部分相交(未整段覆盖)→ 扩为完整 token;
 *  返回与入参相同=无部分相交,编辑放行。整段覆盖(token 全落在区间内)=有意整替,放行 */
export function atomicRange(text: string, start: number, end: number): [number, number] {
  let pos = 0;
  let s = start;
  let e = end;
  for (const tk of splitMentionTokens(text)) {
    if (tk.kind === 'plain') { pos += tk.text.length; continue; }
    const ts = pos;
    const te = pos + tk.text.length;
    pos = te;
    const covers = start <= ts && end >= te;
    if (start < te && end > ts && !covers) { s = Math.min(s, ts); e = Math.max(e, te); }
  }
  return [s, e];
}

export type TokenGuardVerdict =
  | { action: 'allow' }
  | { action: 'redirectEnd'; to: number }
  | { action: 'splice'; s: number; e: number };

const INSERT_INPUT_TYPES = new Set(['insertText', 'insertReplacementText', 'insertCompositionText', 'insertParagraph', 'insertLineBreak', 'insertFromPaste', 'insertFromDrop']);
const DELETE_INPUT_TYPES = new Set(['deleteContentBackward', 'deleteContentForward', 'deleteByCut', 'deleteByDrag', 'deleteCompositionText', 'deleteWordBackward', 'deleteWordForward', 'deleteSoftLineBackward', 'deleteSoftLineForward', 'deleteHardLineBackward', 'deleteHardLineForward']);

/** G14.212 beforeinput 判定(token 原子性):插入面部分命中 token → 阻止+光标钉 token 尾(再击
 *  落边界);删除面部分命中 → 扩为整 token 删。整段覆盖/边界编辑放行(:L 行锚续写、有意整替) */
export function tokenGuardVerdict(text: string, start: number, end: number, inputType: string): TokenGuardVerdict {
  if (INSERT_INPUT_TYPES.has(inputType)) {
    const [s, e] = atomicRange(text, start, end);
    if (s !== start || e !== end) return { action: 'redirectEnd', to: e };
    return { action: 'allow' };
  }
  if (DELETE_INPUT_TYPES.has(inputType)) {
    const [s, e] = atomicRange(text, start, end);
    if (s !== start || e !== end) return { action: 'splice', s, e };
    return { action: 'allow' };
  }
  return { action: 'allow' };
}

/** G14.213 严格包含 caret 的 token 区间(s < caret < e;首尾边界不算内);无则 null。
 *  「光标不落 token 中间」的归位判据——点击/方向键/原生移动统一钉到边界 */
export function tokenSpanAt(text: string, caret: number): [number, number] | null {
  let pos = 0;
  for (const tk of splitMentionTokens(text)) {
    if (tk.kind === 'plain') { pos += tk.text.length; continue; }
    const s = pos;
    const e2 = pos + tk.text.length;
    pos = e2;
    if (caret > s && caret < e2) return [s, e2];
  }
  return null;
}
/** G14.132 输入框高亮层(导出共享——欢迎页 composer 同款):file token 渲染文件图标+显形文本。
 *  G14.211 显形=原始字形(tokenBody 原样,行锚 :L 段弱色)——显示宽度逐字形等于原文,
 *  光标恒贴芯片右沿;此前 basename/`(L..L)` 变换画宽>原文宽,光标后留缝。
 *  lookup=目录解析(Chat/欢迎页注入记账+索引):命中值带尾斜杠=目录引用 → 黄目录图标
 *  (内部标记,插入/显示文本无斜杠;token 自带尾斜杠的直写形态同样识别)。
 *  2026-11-04 §3.1:agent/team 走尾分支同款 `hn-${kind}` 类(hn-agent/hn-team,CSS 侧取
 *  --accent/--warn 区分,不新增硬编码色) */
export const renderMentionSpans = (text: string, lookup?: (name: string) => string | undefined, refContents?: ReadonlyMap<string, string>, onOpenFile?: (p: string) => void, composer?: boolean, compRange?: { start: number; end: number } | null): ReactNode => {
  // IME 组字段压平(2026-11-05 用户实测「组字期芯片消失」根修):与组字范围交叠的 token 渲染为
  // 普通段——叠层恒可见(既有芯片保留),组字串以普通前景色由叠层绘制(textarea 恒透明,单绘制)
  let pos = 0;
  return splitMentionTokens(text).map((tk, i) => {
    const ts = pos;
    const te = pos + tk.text.length;
    pos = te;
    const composingOverlap = compRange !== undefined && compRange !== null && ts < compRange.end && te > compRange.start;
    if (tk.kind === 'plain' || composingOverlap) return <span key={i}>{tk.text}</span>;
    if (tk.kind === 'mdlink') {
      // 发送期展开落档的文件引用链接形态(2026-11-04 用户裁定「当作特殊 chip,不露 md 原文;
      // 2026-11-04 续:与输入框完全一致」)=composer 文件芯片同构:FileIcon+全名(accent)+
      // 弱色 :行段(冒号在内,与 @token 形态逐字同构);有跳转通道即点击开文件(剥 #行锚)
      const m2 = /^\[([^\]\n]+)\]\(([^()\s]+)\)$/.exec(tk.text);
      const full = m2?.[1] ?? tk.text;
      const href = m2?.[2] ?? '';
      const anchorM = / (L\d+(?:-L\d+)?)$/.exec(full);
      const range = anchorM?.[1] ?? '';
      const name = range !== '' ? full.slice(0, full.length - range.length - 1) : full;
      const open = href !== '' && onOpenFile !== undefined ? () => onOpenFile(href.replace(/#[^#]*$/, '')) : undefined;
      return (
        <span
          key={i}
          className="hn hn-file hn-mdlink"
          onClick={open}
          onMouseDown={(e) => e.preventDefault()}
          title={full}
          style={open !== undefined ? { cursor: 'pointer' } : undefined}
        >
          <span className="hn-file-ico" aria-hidden="true">
            <FileIcon path={name} />
          </span>
          {name}
          {range !== '' && <span className="hn-file-lines">:{range}</span>}
        </span>
      );
    }
    if (tk.kind === 'file') {
      const tokenBody = tk.text.slice(1);
      const anchor = /^(.*)(:L\d+(?:-L\d+)?)$/.exec(tokenBody);
      const pathNoAnchor = tokenBody.replace(/:L\d+(?:-L\d+)?$/, '');
      const bare = pathNoAnchor.replace(/[\\/]+$/, '');
      const isDir = /[\\/]$/.test(pathNoAnchor) || /[\\/]$/.test(lookup?.(bare) ?? '');
      return (
        <span key={i} className="hn hn-file">
          <span className="hn-file-ico" aria-hidden="true">
            <FileIcon path={pathNoAnchor} folder={isDir || undefined} />
          </span>
          <span className="hn-file-at" aria-hidden="true">@</span>
          {anchor === null ? (
            tokenBody
          ) : (
            <>
              {anchor[1]}
              <span className="hn-file-lines">{anchor[2]}</span>
            </>
          )}
        </span>
      );
    }
    if (tk.kind === 'ref') {
      const inner = tk.text.slice(1, -1);
      const isTerm = inner.startsWith('终端');
      const content = refContents?.get(tk.text) ?? refContentRegistry.get(tk.text) ?? '';
      return <RefTokenChip key={i} inner={inner} isTerm={isTerm} content={content} composer={composer === true} />;
    }
    return <span key={i} className={`hn hn-${tk.kind}`}>{tk.text}</span>;
  });
};

/** 2026-11-04 ref 芯片 hover 预览(用户裁定「输入框/用户气泡/队列/编辑都保持 chip 状态,hover
 *  时显示具体内容」):固定定位面板随 chip 悬停显隐,内容=账本/注册表全文;指针穿透不抢悬停。
 *  2026-11-04 裁定续:恒上侧(面板底缘贴 chip 顶缘),水平钳回主对话区(.sx-main,缺席回退视口),
 *  可用高度钳 max-height 超出纵向滚动。
 *  2026-11-05 实测根修两件:①面板 Portal 到 body——.chat-dock 携侧栏开合滑动 transform,
 *  position:fixed 后代的包含块被它劫持,视口坐标被相对 dock 解释=面板落到视口外(hover「无弹窗」
 *  真因,数据与 handlers 一直在);②气泡/队列分支补 hover handlers(此前仅 composer 分支有,
 *  「任意选取有 hover」缺半边)。
 *  composer=true(输入框高亮层):显形宽度=原文宽度硬约束——⟦⟧ 定界符保留占位(透明,同 file
 *  芯片 @ 保字宽手法),图标绝对定位挂芯片尾缘(2026-11-05 实测 ⟦ 字形advance仅 5.4px,13px
 *  图标压进「正」字 7.6px=「图标挤在一起」根因;尾部是插入即带的尾随空格,无常驻墨迹可栖);
 *  气泡/队列无约束,图标内联+定界符不渲染 */
/** 预览面板几何(2026-11-05 用户裁定「宽度降到 300px」):视觉宽度恒 300,满高 300;水平钳回
 *  主对话区以此宽推算右界。样式写入一律经 zoomScale 归一——ui-zoom 契约:html zoom 子树内
 *  gBCR=视觉 px、样式 px=本地值(视觉/zoom),面板 Portal 落 body 同处 zoom 子树,漏归一即
 *  位移下坠右移(zoom≠1 时 hover「跑远了」的根因) */
const PANEL_W = 300;
const PANEL_H = 300;

export function RefTokenChip({ inner, isTerm, content, composer }: { inner: string; isTerm: boolean; content: string; composer?: boolean }): JSX.Element {
  const [tip, setTip] = useState<{ x: number; y: number; h: number; w: number; below: boolean } | null>(null);
  // 2026-11-05 用户裁定「hover 提示可悬停」:指针从 chip 移入面板不关(面板 pointer-events:auto
  // 可滚动查看),移出面板/chip 才关——chip mouseleave 延迟 160ms 关,面板 mouseenter 取消
  const hideTimer = useRef<number | undefined>(undefined);
  const closeLater = (): void => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setTip(null), 160);
  };
  const keepOpen = (): void => window.clearTimeout(hideTimer.current);
  // 图标按 token 语义分型:终端片段=终端、正文片段(2026-11-05 圈选芯片化)=文本、其余(网页元素)=地球
  const ico = isTerm ? (
    <SquareTerminal size={11} strokeWidth={1.75} />
  ) : inner.startsWith('正文') ? (
    <FileText size={11} strokeWidth={1.75} />
  ) : (
    <Globe size={11} strokeWidth={1.75} />
  );
  const onEnter = (e: ReactMouseEvent<HTMLSpanElement>): void => {
    keepOpen();
    const r = e.currentTarget.getBoundingClientRect();
    const main = e.currentTarget.closest('.sx-main')?.getBoundingClientRect();
    const z = zoomScale();
    const wLocal = PANEL_W / z;
    const mL = (main?.left ?? 0) + 8;
    const mR = (main?.right ?? window.innerWidth) - 8;
    // 坐标整数化(2026-11-05):除 zoom 后落分数 px,1px 边框跨设备像素=边缘毛刺
    const x = Math.round(Math.min(Math.max(r.left, mL), Math.max(mR - PANEL_W, mL)) / z);
    // 2026-11-05 用户裁定:面板恒在芯片上方;上方放不下(满高露不全)且下方空间更大才翻下方,
    // 高度=所在侧可用空间与满高取小,超出纵向滚动(CSS overflow:auto)
    const spaceAbove = r.top - 8;
    const spaceBelow = window.innerHeight - r.bottom - 12;
    const below = spaceAbove < PANEL_H && spaceBelow > spaceAbove;
    const h = Math.round((below ? Math.min(PANEL_H, spaceBelow) : Math.min(PANEL_H, Math.max(spaceAbove, 140))) / z);
    // 贴边(2026-11-05 用户裁定「贴着 chip 的上下边缘」):间隙 2px
    setTip({ x, y: Math.round((below ? r.bottom + 2 : r.top - 2) / z), h, w: wLocal, below });
  };
  // 面板挂 body 层:避开 .chat-dock 等 transform 祖先的包含块劫持(fixed 才是真视口定位)
  const panel =
    tip !== null &&
    content !== '' &&
    createPortal(
      <span
        className="ref-chip-preview"
        onMouseEnter={keepOpen}
        onMouseLeave={() => setTip(null)}
        style={tip.below ? { left: tip.x, top: tip.y, maxHeight: tip.h, width: tip.w } : { left: tip.x, top: tip.y, transform: 'translateY(-100%)', maxHeight: tip.h, width: tip.w }}
      >
        <pre>{content}</pre>
      </span>,
      document.body,
    );
  if (composer === true) {
    return (
      <>
        <span
          className="hn hn-ref ref-chip"
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={onEnter}
          onMouseLeave={closeLater}
        >
          <span className="hn-ref-at" aria-hidden="true">⟦</span>
          {inner}
          <span className="hn-ref-at" aria-hidden="true">⟧</span>
          <span className="hn-ref-ico" aria-hidden="true">{ico}</span>
        </span>
        {panel}
      </>
    );
  }
  return (
    <>
      <span className="hn hn-ref ref-chip" onMouseEnter={onEnter} onMouseLeave={closeLater}>
        <span className="hn-ref-ico" aria-hidden="true">{ico}</span>
        {inner}
      </span>
      {panel}
    </>
  );
}

/** ref 全文注册表(会话级,insert-ref 落账同步写):气泡/队列等无账本 prop 的渲染面 hover 取数源 */
export const refContentRegistry = new Map<string, string>();
const REG_STORE_KEY = 'sunshinex:ref-registry';
// 重载自愈(2026-11-05 用户实测「字面量 token 发出」根因):Chromium reload 以表单恢复把
// composer 里的 ⟦token⟧ 文本带回来,而注册表是模块内存——JS 上下文重建即空,发送期
// expandRefContents 查不到内容=字面 token 直达 agent。持久层 localStorage(2026-11-05 二改:
// sessionStorage 不活进程,重启即空=「重启后无法显示 hover 弹窗」根因;daemon 端口偏好已
// 落盘复用、GUI origin 稳定,localStorage 跨 launch 存续——与语言/主题/zoom 同通路),装载时回灌。
try {
  const saved = localStorage.getItem(REG_STORE_KEY);
  if (saved !== null) {
    for (const [k, v] of JSON.parse(saved) as Array<[string, string]>) refContentRegistry.set(k, v);
  }
} catch {
  // 档损坏即弃:只丢 hover/展开兜底,主链路不受影响
}
let regPersistQueued = false;
function persistRegistry(): void {
  if (regPersistQueued) return;
  regPersistQueued = true;
  setTimeout(() => {
    regPersistQueued = false;
    try {
      // 上限 40 条(选取全文 ≤2000 字/条,防 5MB 配额击穿);Map 插入序=铸造序,弃最老
      const entries = [...refContentRegistry].slice(-40);
      localStorage.setItem(REG_STORE_KEY, JSON.stringify(entries));
    } catch {
      // 配额/隐私模式写失败即弃:内存注册表仍支撑本会话全链
    }
  }, 0);
}
/** 注册表落账单点(set+写穿):insert-ref 面与编辑回填面共用 */
export function refContentRegister(token: string, content: string): void {
  refContentRegistry.set(token, content);
  persistRegistry();
}

/** 正文/终端片段 token 铸造(2026-11-05 用户裁定「正文圈选也要 chip」):按类会话级计数,
 *  同类二铸即 ·N——账本/注册表以 token 全文为键,固定 token 二次圈选会把先选内容互覆。
 */
const snippetSeq: { body: number; term: number } = { body: 0, term: 0 };
export function mintSnippetToken(kind: 'body' | 'term'): string {
  const base = kind === 'body' ? '正文片段' : '终端片段';
  snippetSeq[kind] += 1;
  return snippetSeq[kind] === 1 ? `⟦${base}⟧` : `⟦${base}·${snippetSeq[kind]}⟧`;
}

/** browser-element 围栏拆分(2026-11-04 用户裁定「用户气泡保持 chip 状态」):发送期展开落档的
 *  全文围栏在显示侧折叠回芯片——段序列=原文段 | 围栏段(fence=围栏体,token=回填重 token 化的
 *  token 全文,label 从页签/定位行提取)。2026-11-04 续:扩 text-selection(终端片段围栏化落档);
 *  2026-11-05 续:扩 body-snippet(正文圈选围栏化落档,与终端同构、标签/图标分型) */
export function splitBrowserFences(md: string): Array<{ text: string } | { fence: string; kind: 'browser-element' | 'text-selection' | 'body-snippet'; label: string; token: string }> {
  const out: Array<{ text: string } | { fence: string; kind: 'browser-element' | 'text-selection' | 'body-snippet'; label: string; token: string }> = [];
  const re = /```(browser-element|text-selection|body-snippet)\n([\s\S]*?)```/g;
  let last = 0;
  let termSeq = 0;
  let bodySeq = 0;
  for (const m of md.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: md.slice(last, idx) });
    const kind = (m[1] ?? 'browser-element') as 'browser-element' | 'text-selection' | 'body-snippet';
    const body = m[2] ?? '';
    if (kind === 'text-selection') {
      termSeq += 1;
      out.push({ fence: body, kind, label: '终端片段', token: termSeq === 1 ? '⟦终端片段⟧' : `⟦终端片段·${termSeq}⟧` });
    } else if (kind === 'body-snippet') {
      bodySeq += 1;
      out.push({ fence: body, kind, label: '正文片段', token: bodySeq === 1 ? '⟦正文片段⟧' : `⟦正文片段·${bodySeq}⟧` });
    } else {
      const pid = /页签 #(t-[0-9a-z]+)/.exec(body)?.[1] ?? /页签 #(\S+)/.exec(body)?.[1] ?? '';
      const loc = /定位: (\S+)/.exec(body)?.[1] ?? '';
      const label = pid !== '' ? `网页#${pid}${loc !== '' ? ` · ${loc}` : ''}` : '网页元素';
      out.push({ fence: body, kind, label, token: `⟦${label}⟧` });
    }
    last = idx + m[0].length;
  }
  if (last < md.length) out.push({ text: md.slice(last) });
  return out;
}

/** 编辑回填重 token 化(2026-11-04 用户裁定「编辑页也保持 chip」):载入的展开档文按围栏折回
 *  token 并记账(写传入账本+会话注册表),composer 恢复芯片态;重发经 expandRefContents 展开
 *  回原形态(browser 围栏体原样含标记,终端/正文片段重围栏化)。账本缺省=会话注册表(展开面有兜底) */
export function rebuildPickTokens(md: string, ledger: Map<string, string> = refContentRegistry): string {
  const out: string[] = [];
  for (const seg of splitBrowserFences(md)) {
    if ('text' in seg) {
      out.push(seg.text);
      continue;
    }
    const content = seg.kind === 'browser-element' ? `\`\`\`browser-element\n${seg.fence}\`\`\`` : seg.fence;
    ledger.set(seg.token, content);
    refContentRegister(seg.token, content);
    out.push(seg.token);
  }
  return out.join('');
}

/** G14.129/139 @ 引用发送期展开:输入框短写 `@文件名`(选中记账)或 `@相对路径` 或
 *  `@相对路径:L30-L35`(文件标签选区加引用) → md 原生超链接——行锚形态
 *  `[文件名 L30-L35](./相对路径#L30-L35)`,其余 `[文件名](./相对路径)`;标准 ./ 相对格式,
 *  daemon 相对会话根解析;纯文件名 token 经 resolve 解析(选中记账/最近索引兜底),解析不到原样保留。
 *  目录引用(token 尾斜杠 `@src/`,或 resolve 命中带尾斜杠的索引目录项):href 保尾斜杠——
 *  气泡链接面(FileIcon 尾斜杠判目录)显黄目录,点击交 Files 目录移交;头名剥尾斜杠 */
/** / 令牌解析:caret 前 /词。atStart=开头(内置命令面板)/中间(不弹面板;/skill-id 软引用=纯文本)。原 Chat.tsx 模块层导出
 *  (App 欢迎页 /命令 目标分流复用)下沉本件——与 atomicRange/tokenSpanAt 同族原语单点 */
export const slashTokenAt = (text: string, caret: number): { query: string; from: number; atStart: boolean } | null => {
  const m = /\/([\w-]*)$/.exec(text.slice(0, caret));
  if (m === null) return null;
  return { query: m[1] ?? '', from: m.index, atStart: m.index === 0 };
};

export function expandFileRefs(
  text: string,
  root: string | undefined,
  resolve?: (name: string) => string | undefined,
): string {
  if (root === undefined || root === '' || root === 'default') return text;
  return text.replace(/@([\w./:\\-]+)/g, (raw, p: string) => {
    const anchor = /^(.*):(L\d+(?:-L\d+)?)$/.exec(p);
    const pathPart = anchor !== null ? anchor[1] : p;
    const lines = anchor !== null ? anchor[2] : '';
    const bare = pathPart.replace(/[\\/]+$/, '');
    const isDirRef = /[\\/]$/.test(pathPart);
    const name = bare.split(/[\\/]/).pop() ?? bare;
    // 含路径分隔(含 Win \)即整段路径;否则短写走 resolve
    const rel = /[\\/]/.test(bare) ? bare : resolve?.(name);
    if (rel === undefined || rel === '') return raw;
    const dirHref = isDirRef || /[\\/]$/.test(rel);
    const relBody = rel.replace(/^\.\//, '').replace(/[\\/]+$/, '');
    const head = anchor !== null ? `${name} ${lines}` : name;
    // 绝对路径原样作 href(勿加 ./ —— 否则 ./D:\proj\src/ 畸形,Files/目录开签全挂)
    const hrefCore = isAbsPath(relBody) ? relBody : `./${relBody}`;
    return `[${head}](${hrefCore}${dirHref ? '/' : ''}${lines !== '' ? `#${lines}` : ''})`;
  });
}

/** 2026-11-04 元素/终端片段引用发送期展开(用户裁定「实际内容 agent 知道即可,composer 只显简标识」):
 *  ⟦…⟧ token → 账本(refContents)中的全量内容(围栏包裹);无账本命中原样保留 */
export function expandRefContents(text: string, contents: ReadonlyMap<string, string>): string {
  return text.replace(/⟦([^⟧]{1,120})⟧/g, (raw, _inner: string) => {
    // 注册表兜底(2026-11-04):编辑回填重 token 化只写注册表即可全链生效(气泡 hover/重发展开)
    const c = contents.get(raw) ?? refContentRegistry.get(raw);
    if (c === undefined) return raw;
    // 落档围栏化:raw 选区→围栏——气泡/编辑回填可折叠回芯片;browser-element 内容自带围栏不套。
    // 尾随换行归一(重展开逐字节回原)。围栏 kind 即显示侧标签判据:终端→text-selection、
    // 正文(2026-11-05 用户裁定「正文也要 chip」)→body-snippet
    if (raw.startsWith('⟦正文') && !c.startsWith('```')) {
      const body = c.endsWith('\n') ? c.slice(0, -1) : c;
      return `\`\`\`body-snippet\n${body}\n\`\`\``;
    }
    if (raw.startsWith('⟦终端') && !c.startsWith('```')) {
      const body = c.endsWith('\n') ? c.slice(0, -1) : c;
      return `\`\`\`text-selection\n${body}\n\`\`\``;
    }
    return c;
  });
}
