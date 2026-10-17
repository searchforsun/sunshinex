import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { t } from '../../i18n';
import { FileIcon } from '../../file-icon';

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
        const si = f.lastIndexOf('/');
        const base = si < 0 ? f : f.slice(si + 1);
        const dir = si < 0 ? '' : f.slice(0, si + 1);
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

/** G14.85 工具体用无链接版(输出面不需要文件交互) */
/** G14.95 token 提取:@路径=文件引用;/词(行首/空白后)=命令或技能引用。
 *  返回分段序列(plain 原样、file/cmd/skill 着色)——输入框高亮层与用户气泡共用一套口径 */
export interface MentionToken {
  text: string;
  kind: 'plain' | 'file' | 'cmd' | 'skill';
}

export function splitMentionTokens(text: string): MentionToken[] {
  // G14.121 @ 分支扩 `:\\`:绝对路径 token(D:/ws/a.ts、D:\ws\a.ts)整体着色
  const re = /@[\w./:\\-]+|(^|\s)(\/[a-z][\w-]*)/gi;
  const out: MentionToken[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    const matched = m[0];
    if (idx > last) out.push({ text: text.slice(last, idx), kind: 'plain' });
    if (matched.startsWith('@')) out.push({ text: matched, kind: 'file' });
    else {
      const lead = m[1] ?? '';
      if (lead !== '') out.push({ text: lead, kind: 'plain' });
      const word = m[2] ?? '';
      const atLineStart = idx === 0;
      out.push({ text: word, kind: atLineStart ? 'cmd' : 'skill' });
    }
    last = idx + matched.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: 'plain' });
  return out;
}

/** 用户气泡 markdown 的 token 视觉化:token 包行内 code(特殊样式),原文不变(复制走 entry.md);
 *  保留 \`> \` 引用前缀(气泡 blockquote 形态不变),仅对行内内容做 token 包装。
 *  G14.116 file token 显形去 @ 前缀(图标+名称由 buildUserMdComponents 接管) */
export function renderUserMd(md: string): string {
  const wrap = (line: string): string =>
    splitMentionTokens(line)
      .map((t) => {
        if (t.kind === 'plain') return t.text;
        if (t.kind === 'file') return '`' + (t.text.startsWith('@') ? t.text.slice(1) : t.text) + '`';
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
 *  光标恒贴芯片右沿;此前 basename/`(L..L)` 变换画宽>原文宽,光标后留缝 */
export const renderMentionSpans = (text: string): ReactNode =>
  splitMentionTokens(text).map((tk, i) => {
    if (tk.kind === 'plain') return <span key={i}>{tk.text}</span>;
    if (tk.kind === 'file') {
      const tokenBody = tk.text.slice(1);
      const anchor = /^(.*)(:L\d+(?:-L\d+)?)$/.exec(tokenBody);
      return (
        <span key={i} className="hn hn-file">
          <span className="hn-file-ico" aria-hidden="true">
            <FileIcon path={tokenBody.replace(/:L\d+(?:-L\d+)?$/, '')} />
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
    return <span key={i} className={`hn hn-${tk.kind}`}>{tk.text}</span>;
  });

/** G14.129/139 @ 引用发送期展开:输入框短写 `@文件名`(选中记账)或 `@相对路径` 或
 *  `@相对路径:L30-L35`(文件标签选区加引用) → md 原生超链接——行锚形态
 *  `[文件名 L30-L35](./相对路径#L30-L35)`,其余 `[文件名](./相对路径)`;标准 ./ 相对格式,
 *  daemon 相对会话根解析;纯文件名 token 经 resolve 解析(选中记账/最近索引兜底),解析不到原样保留 */
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
    const name = pathPart.split(/[\\/]/).pop() ?? pathPart;
    const rel = pathPart.includes('/') ? pathPart : resolve?.(name);
    if (rel === undefined || rel === '') return raw;
    const head = anchor !== null ? `${name} ${lines}` : name;
    return `[${head}](./${rel.replace(/^\.\//, '')}${lines !== '' ? `#${lines}` : ''})`;
  });
}
