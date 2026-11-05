import { Fragment, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { t } from '../../i18n';
import { FileIcon } from '../../file-icon';
import { Globe, SquareTerminal } from 'lucide-react';
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

/** agents-teams P1 Task 4（spec §3.2）：$/# 引用面板（智能体/团队双组单游标）——行=符号着色 +
 *  id + 展示名后缀，组头分节（Agents/Teams），空组由调用面过滤（flatRefItems 只含非空组），
 *  全空=调用面不开面板（与 @ 面板同门）。键盘（↑↓ 循环/Enter 插入/Esc）在 use-composer-keys
 *  与 @ 面板同链；插入文本由调用面拼装（R4：`$id `/`#id ` 尾随空格，插入即终态无记账）。 */
export function RefPalette({
  items,
  active,
  onPick,
  onHover,
}: {
  items: RefItem[];
  active: number;
  onPick: (item: RefItem) => void;
  onHover: (i: number) => void;
}): JSX.Element {
  // G14.163 同款：↑↓ 移动时选中项滚入可视区(block:nearest 最小滚动)
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active, items]);
  return (
    <div className="ref-palette" role="listbox" aria-label={t('Agents and teams', '智能体与团队')}>
      {items.map((item, i) => {
        // 组头:首行恒带头($ 行=Agents、# 行=Teams——空组已被 flatRefItems 滤除,过滤后只剩
        // 团队行时首行直接落 Teams 头);此后首个 # 行前插 Teams 头
        const head =
          item.sym === '#' && (i === 0 || items[i - 1]?.sym === '$')
            ? t('Teams', '团队')
            : i === 0
              ? t('Agents', '智能体')
              : null;
        return (
          <Fragment key={`${item.sym}${item.id}`}>
            {head !== null && <div className="ref-palette-head">{head}</div>}
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
export const renderMentionSpans = (text: string, lookup?: (name: string) => string | undefined, refContents?: ReadonlyMap<string, string>, onOpenFile?: (p: string) => void, compact?: boolean): ReactNode =>
  splitMentionTokens(text).map((tk, i) => {
    if (tk.kind === 'plain') return <span key={i}>{tk.text}</span>;
    if (tk.kind === 'mdlink') {
      // 发送期展开落档的文件引用链接形态(2026-11-04 用户裁定「当作特殊 chip,不露 md 原文」):
      // 文件芯片渲染,compact=紧凑短标签(气泡/队列——长文件名中段省略,全名进 title;composer
      // 高亮层显形宽度须与 textarea 逐字对齐,保持全字长),有跳转通道即点击开文件(剥 #行锚)
      const m2 = /^\[([^\]\n]+)\]\(([^()\s]+)\)$/.exec(tk.text);
      const full = m2?.[1] ?? tk.text;
      const href = m2?.[2] ?? '';
      const anchorM = / (L\d+(?:-L\d+)?)$/.exec(full);
      const range = anchorM?.[1] ?? '';
      const name = range !== '' ? full.slice(0, full.length - range.length - 1) : full;
      const shortName = name.length > 20 ? `${name.slice(0, 9)}…${name.slice(-7)}` : name;
      const label = compact === true ? `${shortName}${range !== '' ? ` ${range}` : ''}` : full;
      const open = href !== '' && onOpenFile !== undefined ? () => onOpenFile(href.replace(/#[^#]*$/, '')) : undefined;
      return (
        <span
          key={i}
          className="hn hn-file hn-mdlink"
          onClick={open}
          title={full}
          style={open !== undefined ? { cursor: 'pointer' } : undefined}
        >
          <span className="hn-file-ico" aria-hidden="true">
            <FileIcon path={name} />
          </span>
          {label}
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
      return <RefTokenChip key={i} text={tk.text} inner={inner} isTerm={isTerm} content={content} />;
    }
    return <span key={i} className={`hn hn-${tk.kind}`}>{tk.text}</span>;
  });

/** 2026-11-04 ref 芯片 hover 预览(用户裁定「输入框/用户气泡/队列/编辑都保持 chip 状态,hover
 *  时显示具体内容」):固定定位面板随 chip 悬停显隐,内容=账本/注册表全文;指针穿透不抢悬停。
 *  2026-11-04 裁定续:恒上侧(面板底缘贴 chip 顶缘),水平钳回主对话区(.sx-main,缺席回退视口),
 *  可用高度钳 max-height 超出纵向滚动 */
export function RefTokenChip({ inner, isTerm, content }: { text?: string; inner: string; isTerm: boolean; content: string }): JSX.Element {
  const [tip, setTip] = useState<{ x: number; y: number; h: number } | null>(null);
  return (
    <span
      className="hn hn-ref ref-chip"
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const main = e.currentTarget.closest('.sx-main')?.getBoundingClientRect();
        const mL = (main?.left ?? 0) + 8;
        const mR = (main?.right ?? window.innerWidth) - 8;
        const x = Math.min(Math.max(r.left, mL), Math.max(mR - 520, mL));
        setTip({ x, y: r.top - 6, h: Math.min(300, Math.max(r.top - 16, 140)) });
      }}
      onMouseLeave={() => setTip(null)}
    >
      <span className="hn-ref-ico" aria-hidden="true">
        {isTerm ? <SquareTerminal size={11} strokeWidth={1.75} /> : <Globe size={11} strokeWidth={1.75} />}
      </span>
      {inner}
      {tip !== null && content !== '' && (
        <span className="ref-chip-preview" style={{ left: tip.x, top: tip.y, transform: 'translateY(-100%)', maxHeight: tip.h }}>
          <pre>{content}</pre>
        </span>
      )}
    </span>
  );
}

/** ref 全文注册表(会话级,insert-ref 落账同步写):气泡/队列等无账本 prop 的渲染面 hover 取数源 */
export const refContentRegistry = new Map<string, string>();

/** browser-element 围栏拆分(2026-11-04 用户裁定「用户气泡保持 chip 状态」):发送期展开落档的
 *  全文围栏在显示侧折叠回芯片——段序列=原文段 | 围栏段(content=围栏体,chip 标签从页签/定位行提取) */
export function splitBrowserFences(md: string): Array<{ text: string } | { fence: string; label: string }> {
  const out: Array<{ text: string } | { fence: string; label: string }> = [];
  const re = /```browser-element\n([\s\S]*?)```/g;
  let last = 0;
  for (const m of md.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: md.slice(last, idx) });
    const body = m[1] ?? '';
    const pid = /页签 #(t-[0-9a-z]+)/.exec(body)?.[1] ?? /页签 #(\S+)/.exec(body)?.[1] ?? '';
    const loc = /定位: (\S+)/.exec(body)?.[1] ?? '';
    out.push({ fence: body, label: pid !== '' ? `网页#${pid}${loc !== '' ? ` · ${loc}` : ''}` : '网页元素' });
    last = idx + m[0].length;
  }
  if (last < md.length) out.push({ text: md.slice(last) });
  return out;
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
  return text.replace(/⟦([^⟧]{1,120})⟧/g, (raw, inner: string) => contents.get(`⟦${inner}⟧`) ?? raw);
}
