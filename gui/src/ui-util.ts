/**
 * G8e-T2 共享 UI 小工具:relTime/errText 原三处本地复制(SettingsForm/SettingsShell/
 * ProjectMenu)抽一单源——行为逐字保持,既有测试面零破。
 */

import { t } from './i18n';
import type { Connection } from './connection';

/** 编辑器原生图标模块级缓存(2026-11-07 用户裁定「应用启动时就加载」避免会话展开抖动):
 *  此前缓存是 ChatTopbar 组件态——每会话重挂即清,首帧回落小字形、图标到达跳 18px。
 *  模块级单例跨会话/跨重挂存续,App 启动即 prefetch,会话首帧直读命中零跳变 */
const editorIconCache = new Map<string, string>();
export const editorIconCached = (id: string): string | undefined => editorIconCache.get(id);
export const editorIconPut = (id: string, url: string): void => {
  editorIconCache.set(id, url);
};
/** App 启动预取:编辑器清单+逐个原生图标(缺法/失败静默——回落集内字形兜底) */
export const prefetchEditorIcons = (conn: Connection): void => {
  if (typeof conn.editorsList !== 'function') return;
  void conn.editorsList().then(
    (r) => {
      for (const e of r.editors) {
        if (editorIconCache.has(e.id)) continue;
        if (typeof conn.editorIcon !== 'function') continue;
        void conn.editorIcon(e.id).then(
          (ic) => editorIconPut(e.id, `data:${ic.mime};base64,${ic.data}`),
          () => undefined,
        );
      }
    },
    () => undefined,
  );
};

/** 相对时间(简易,纯刻度不带后缀):<60s 刚刚;<60m N分钟;<24h N小时;否则 N天(G14.118 中文单位) */
export function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('now', '刚刚');
  if (diff < 3_600_000) { const m = Math.floor(diff / 60_000); return t(`${m}m`, `${m}分钟`); }
  if (diff < 86_400_000) { const h = Math.floor(diff / 3_600_000); return t(`${h}h`, `${h}小时`); }
  const d = Math.floor(diff / 86_400_000);
  return t(`${d}d`, `${d}天`);
}

/** 错误文案归一:Error.message 优先,否则 String(err)(Promise 拒因透出行内错误条) */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 系统默认浏览器外开单点(2026-10-25 用户裁定:正文 URL/WebTab 外开都走 OS 默认浏览器):
 *  桌面壳经 preload 桥 shell.openExternal(OS 按默认浏览器关联承接,用户配置的 Chrome);
 *  window.open 在 Electron 里只开自家子窗,不是系统浏览器。浏览器态(无桥)回落 window.open。
 *  消费面:md 链接组件(正文/气泡 a 点击)、WebTab ↗ 钮 */
export function openExternalUrl(url: string): void {
  const bridge = window.sunshinexWindow;
  if (bridge?.openExternal !== undefined) void bridge.openExternal(url).catch(() => {});
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/** tokens 格式(G14.17 自 Chat.tsx 导出共享):8400 → 8.4k tokens;840 → 840 tokens */
export function fmtTokens(n: number): string {
  // 2026-10-26 用户报障「64802.0k tokens」:加 m 档(≥1e6),k/m 一位小数
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m tokens`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`;
}

/** 字节量格式(存储页体积/toast,2026-11-21):B 直显,KB 起一位小数(≥100 取整) */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  return `${v >= 100 ? String(Math.round(v)) : v.toFixed(1)} ${units[i]!}`;
}

/** 路径段切分单点：双分隔符归一、空段滤除（disambiguateTabTitles 逐级上溯段构成消费；
 *  daemon 下发 POSIX 相对路径与 Windows 绝对路径两面同源）。 */
export function pathSegments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

/** 「打开」分体钮默认应用偏好键(2026-10-27 技术债轮 D57③:字面量三处散布——ChatTopbar×2/
 *  Files×1——默认应用口径靠字符串耦合,收单点) */
export const OPEN_DEFAULT_KEY = 'sunshinex.open-default';

/** 文件系统绝对路径判定(浏览器无 node:path):Win 盘符/UNC;Posix 前导 /。
 *  开签/拖拽经 joinWsPath 的产物走此门;会话相对 md 图仍用 normRel(剥前导 /)。 */
export function isAbsPath(p: string): boolean {
  const t = p.trim();
  if (t === '') return false;
  if (/^[a-zA-Z]:[\\/]/.test(t)) return true;
  if (t.startsWith('\\\\') || t.startsWith('//')) return true;
  return t.startsWith('/');
}

/** 剥 md/拖放畸形前缀(./ 叠层、file://)后判绝对;相对保留。目录点击/开签入参归一。 */
/** 文件行段锚解析(#L123 / #L123-L235,2026-11-14 用户裁定「文件预览支持 #L40-L57 查询同款」):
 *  md 链接/引用里的行段锚拆出为 {path,line,lineEnd}——打开预览后定位到起始行(行段则高亮整段);
 *  无锚原样返回。大小写不敏感(#l40 同认),行号须为正整数 */
export function splitLineAnchor(p: string): { path: string; line?: number; lineEnd?: number } {
  const m = /#L(\d+)(?:-L?(\d+))?$/i.exec(p);
  if (m === null) return { path: p };
  const line = Number(m[1]);
  const end = m[2] !== undefined ? Number(m[2]) : undefined;
  if (!(line > 0)) return { path: p }; // 非法行号(#L0)不拆,整串按原路径(不当锚误吞)
  const path = p.slice(0, m.index);
  return {
    path,
    line,
    ...(end !== undefined && end > line ? { lineEnd: end } : {}),
  };
}

export function cleanPathInput(p: string): string {
  let t = p.trim().replace(/^file:\/\//i, '');
  while (t.startsWith('./')) t = t.slice(2);
  return t;
}

/** 绝对路径落在哪个注册工作区(最长前缀命中);返回 root + 相对路径(posix /)。未命中 null。
 *  比较走大小写/分隔符无关;rel 从归一后前缀切,避免 root 与 abs 斜杠形态不一致时 slice 错位。 */
export function workspaceOfAbs(absPath: string, roots: readonly string[]): { root: string; rel: string } | null {
  const target = cleanPathInput(absPath).replace(/[\\/]+$/, '');
  if (target === '' || roots.length === 0) return null;
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const t = norm(target);
  const targetPosix = target.replace(/\\/g, '/').replace(/\/+$/, '');
  let best: { root: string; rel: string; len: number } | null = null;
  for (const root of roots) {
    const bare = root.replace(/[\\/]+$/, '');
    if (bare === '') continue;
    const r = norm(bare);
    if (t === r || t.startsWith(r + '/')) {
      const rel = t === r ? '' : targetPosix.slice(r.length).replace(/^\/+/, '');
      if (best === null || r.length > best.len) best = { root: bare, rel, len: r.length };
    }
  }
  return best === null ? null : { root: best.root, rel: best.rel };
}

/** 工作区根 + 相对 → 绝对;入参已绝对则原样(尾目录斜杠保留)。分隔随 root 形态。 */
export function joinWsPath(root: string, relOrAbs: string): string {
  const raw = relOrAbs.trim();
  if (raw === '' || root === '') return raw;
  if (isAbsPath(raw)) return raw;
  const sep = root.includes('\\') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  const rel = raw.replace(/^[\\/]+/, '');
  const dirMark = /[\\/]$/.test(raw);
  const joined = `${base}${sep}${rel.replace(/\\/g, sep)}`;
  return dirMark && !/[\\/]$/.test(joined) ? `${joined}${sep}` : joined;
}

/** 相对路径归一单点(2026-10-27 技术债轮 G10 自 Files.tsx 上收——md 正文图片此前仅剥 file:// 头,
 *  `/docs/a.png`·`./docs/a.png` 形态在 Files 面可解析、MdImage 面 404 落 chip 的口径分叉根除):
 *  ./a/b 与 /a/b 都按会话根相对(前导斜杠剥掉)。Win 盘符/UNC 原样。
 *  跨项目绝对路径开签请先 isAbsPath 分流,勿经本函数(posix /… 会被当相对剥头)。
 *  消费面:md 图片 MdImage;Files 仅对非 abs 入参调用 */
export function normRel(p: string): string {
  const trimmed = p.trim();
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\') || trimmed.startsWith('//')) return trimmed;
  let t = trimmed.replace(/\\/g, '/');
  while (t.startsWith('./')) t = t.slice(2);
  if (t.startsWith('/')) t = t.replace(/^\/+/, '');
  return t;
}


/** 路径 basename 单点（D34 口径收敛）：双分隔符归一（Windows 反斜杠/POSIX 斜杠）、
 *  空段滤除、无分隔符原样返回——daemon 下发 POSIX 相对路径与 Windows 绝对路径两面同源。 */
export function pathBasename(p: string): string {
  return pathSegments(p).pop() ?? p;
}

/** 外部拖拽落盘路径归一(2026-11-14 用户裁定「资源管理器拖文件/文件夹到输入框,自动解析成超链接」):
 *  绝对路径→@短写账本三元组;根在场且路径在根下→相对化(发送期 @ 展开口径),根外保绝对(展开成
 *  绝对路径 md 链接仍可打开);目录判定=末段无扩展名的启发(Explorer 拖拽不带类型标记,带扩展名
 *  的无尾斜杠目录罕见,误判仅影响芯片斜杠标记不影响链接)。win 反斜杠统一正斜杠,尾斜杠剥除 */
export function dropRefsOf(paths: string[], root?: string): Array<{ base: string; ledger: string }> {
  const r = root !== undefined && root !== '' ? root.replaceAll('\\', '/').replace(/\/+$/, '') : undefined;
  return paths.map((p) => {
    const norm = p.replaceAll('\\', '/').replace(/([^/])\/+$/, '$1');
    let ledger = norm;
    if (r !== undefined && norm.toLowerCase().startsWith(r.toLowerCase() + '/')) ledger = norm.slice(r.length + 1);
    const base = norm.split('/').filter(Boolean).pop() ?? norm;
    const isDir = !/\.[^./]+$/.test(base);
    return { base, ledger: isDir ? `${ledger}/` : ledger };
  });
}

/** 封顶 JSON map localStorage 持久化单点（D46 收敛：Chat scrollMem/侧栏 seenMap 同构两份）：
 *  读=缺档/坏档/隐私模式回空对象；写=按 recencyOf 降序截 cap 条落盘，存储满/禁用静默 */
export function loadStoredMap<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    const obj = raw === null ? null : (JSON.parse(raw) as Record<string, T>);
    return obj !== null && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

export function persistCappedMap<T>(key: string, map: Record<string, T>, cap: number, recencyOf: (v: T) => number): void {
  try {
    const entries = Object.entries(map)
      .sort((a, b) => recencyOf(b[1]) - recencyOf(a[1]))
      .slice(0, cap);
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* 存储满/禁用:静默 */
  }
}

/** ISO 时刻 → 本地短时刻(创建时间回溯面):'2026-10-11T05:24:29.123Z' → '10-11 13:24' */
export function shortLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

const p2 = (n: number): string => String(n).padStart(2, '0');

/** 毫秒时刻 → 本地短时戳(MM-DD HH:mm;待办/任务板卡头创建时间、Insight 行同源):
 *  旧档无时刻(≤0)或非法日期回退 '--:--' */
export function shortStampMs(ms: number): string {
  if (!(ms > 0)) return '--:--';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 日期戳(2026-11-11 用户裁定:团队页时间与记忆行同格式同字体):`2026-11-09` */
export function dateStampMs(ms: number): string {
  if (!(ms > 0)) return '----';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '----';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 时长(m→m:ss,h 进位 h:mm:ss;秒位定宽——tabular-nums 在 CSS 面)。Insight/智能体团队共用。 */
export function fmtDurMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 毫秒时刻 → 消息时间(用户气泡/正文尾部,2026-11-07 用户裁定):当天「HH:mm」、昨天「昨天 HH:mm」、
 *  更早「M月D日 HH:mm」(en: Yesterday HH:mm / M/D HH:mm)。now 注入供测试钉日界;非法日期回退 '--:--' */
export function messageTimeMs(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  if (!(ms > 0) || Number.isNaN(d.getTime())) return '--:--';
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const dayStart = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(new Date(now)) - dayStart(d)) / 86_400_000);
  if (days <= 0) return hm;
  if (days === 1) return t(`Yesterday ${hm}`, `昨天 ${hm}`);
  return t(`${d.getMonth() + 1}/${d.getDate()} ${hm}`, `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`);
}

/** G14.69 原生工作区选择结果:null=用户取消;字符串态=降级原因(GUI 回退自建目录浏览) */
type WorkspacePickResult = { path: string } | 'unsupported' | 'denied' | 'timeout' | null;

interface PickDirHandle {
  requestPermission(opts: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<{
    createWritable(): Promise<{ close(): Promise<void> }>;
  }>;
  removeEntry(name: string): Promise<void>;
}

/** 原生系统文件夹选择(showDirectoryPicker=Windows 原生对话框)+ 绝对路径定位:
 *  浏览器安全模型只回目录名——在所选目录落一枚随机标记文件,回调交 daemon 全盘找标记
 *  即得绝对路径(找完即删标记)。'unsupported'=环境无原生选择器;'denied'=写权限被拒;
 *  'timeout'=daemon 未能在时限内定位;null=用户取消。调用方按态回退自建目录浏览。 */
export async function pickWorkspaceFolder(
  locate: (q: { token: string }) => Promise<{ path: string | null }>,
): Promise<WorkspacePickResult> {
  // File System Access API 尚未入 TS lib.dom——特性探测形(调用点 typeof 收窄)
  const w = window as unknown as {
    showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<PickDirHandle>;
  };
  const picker = w.showDirectoryPicker;
  if (typeof picker !== 'function') return 'unsupported';
  let handle: PickDirHandle;
  try {
    handle = await picker.call(w, { mode: 'read' }); // 原生 Windows 文件夹对话框
  } catch {
    return null; // AbortError=用户取消
  }
  try {
    if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') return 'denied';
    const token = `sunshinex-pick-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const marker = await handle.getFileHandle(token, { create: true });
    const writable = await marker.createWritable();
    await writable.close();
    try {
      const { path } = await locate({ token });
      return path !== null ? { path } : 'timeout';
    } finally {
      await handle.removeEntry(token).catch(() => undefined); // 标记即清,成败皆试
    }
  } catch {
    return 'denied'; // 权限/落文件被拒(含用户拒绝授权)
  }
}

/** rAF 迭代收敛器单点(2026-10-27 技术债轮 D54②:贴底追平×刻度跳转校正两份手写同口径循环收敛):
 *  每帧 measure() 取偏差——|delta|≤eps 记一帧稳定(连续 2 帧即收口),否则 apply(delta) 并清稳定计数;
 *  150 帧封顶(content-visibility 水合级联 24 帧封顶实测残差 87px 的口径,两处原值同源);el 离开
 *  DOM 提前终止。消费面:chaseScrollBottom(贴底,eps=1)/ChatRail jump(跳转,eps=2) */
/** 刷新转圈最短窗口(2026-11-03 用户裁定「全局刷新按钮都要转圈」):localhost 快照毫秒级即回,
 *  refreshing true→false 同帧翻转 React 不重绘转圈帧=「刷新不转圈」体感;统一 ≥500ms 展示窗 */
export function withMinSpin<T>(p: Promise<T>, ms = 500): Promise<T> {
  return Promise.all([p, new Promise<void>((resolve) => setTimeout(resolve, ms))]).then(([v]) => v);
}

export function rAFConverge(el: HTMLElement, measure: () => number, apply: (delta: number) => void, eps: number): void {
  let tries = 0;
  let stable = 0;
  const step = (): void => {
    if (!el.isConnected || tries > 150) return;
    tries += 1;
    const delta = measure();
    if (Math.abs(delta) <= eps) {
      stable += 1;
      if (stable >= 2) return;
    } else {
      stable = 0;
      apply(delta);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** 跳底迭代校正(2026-10-27):正文条目挂 content-visibility:auto,离屏只有估算高——一次
 *  scrollTo(scrollHeight) 落点偏短,且滚动中条目陆续水合、高度继续增长,要连点多次才真贴底
 *  (用户实测「回到底部要点几次」)。按贴底差逐帧追平(迭代骨架=rAFConverge 单点);主对话与
 *  子智能体转录页两处回到底部钮共用 */
export function chaseScrollBottom(el: HTMLElement): void {
  rAFConverge(
    el,
    () => el.scrollHeight - el.clientHeight - el.scrollTop,
    (delta) => {
      el.scrollTop += delta;
    },
    1,
  );
}

/** @短写插入核心（D72-③ 收敛,2026-11-15）：composer caret 处插 `@base `+账本记账,内部拖入
 *  （onDropFile）与外部拖拽（onDropPaths）共用。base=短写文件名,value=账本值（绝对/相对路径,
 *  目录带尾斜杠内部标记）。pinCaret=rAF 钉光标到 token 后（内部拖入单插用,外部多路径不钉） */
export function insertRefBase(
  base: string,
  value: string,
  io: { get: () => string; set: (u: (prev: string) => string) => void; ta: () => HTMLTextAreaElement | null; ledger: Map<string, string>; pinCaret?: boolean },
): void {
  const ta = io.ta();
  const pos = ta?.selectionStart ?? io.get().length;
  io.ledger.set(base, value);
  io.set((prev) => prev.slice(0, pos) + `@${base} ` + prev.slice(pos));
  ta?.focus();
  if (io.pinCaret !== true) return;
  requestAnimationFrame(() => {
    const g = io.ta();
    if (g === null) return;
    const to = Math.min(pos + base.length + 2, g.value.length);
    g.setSelectionRange(to, to);
  });
}

/** 内部拖入载荷解析+插入单点：rel 尾斜杠=目录内部标记（插入文本不带斜杠——用户裁定,记账保
 *  标记值供芯片/展开判目录）,基名取最后一段 */
export function insertRefToken(
  rel: string,
  io: { get: () => string; set: (u: (prev: string) => string) => void; ta: () => HTMLTextAreaElement | null; ledger: Map<string, string> },
): void {
  const bare = rel.replace(/[\/]+$/, '');
  const isDir = bare !== rel;
  const base = bare.split(/[\/]/).filter(Boolean).pop() ?? bare;
  insertRefBase(base, isDir ? `${bare}/` : bare, { ...io, pinCaret: true });
}

/** $/# 引用面板 pick 插入共用件（D85 收敛：键面 Enter/五处点击「sym+名 token 区间 splice+收
 *  面板」六份逐字核——insertRefPick 单点后六面同式：分隔符守卫（2026-11-05:锚位前贴芯片尾沿
 *  无空白时补半角空格,否则 tokenizer (^|\s) 不识别=引用渲染成白文）、尾随空格即终态、名称
 *  显形（2026-11-20 用户裁定,发送期 expandRefNames 还原 id）。pinTo 缺席=键盘路（textarea 已
 *  焦点,不钉不focus）;在座=点击路 G14.211 光标钉插入 token 右沿） */
export function insertRefPick(
  setText: (updater: (prev: string) => string) => void,
  opts: { sym: '$' | '#'; label: string; atFrom: number; queryLen: number; close: () => void; pinTo?: () => HTMLTextAreaElement | null },
): void {
  const atEnd = opts.atFrom + 1 + opts.queryLen;
  setText((prev) => {
    const head = prev.slice(0, opts.atFrom);
    const sep = head !== '' && /\S$/.test(head) ? ' ' : '';
    return head + sep + `${opts.sym}${opts.label} ` + prev.slice(Math.max(atEnd, opts.atFrom));
  });
  opts.close();
  const pin = opts.pinTo;
  if (pin === undefined) return;
  pin()?.focus();
  requestAnimationFrame(() => {
    const ta = pin();
    if (ta === null) return;
    const to = Math.min(opts.atFrom + opts.label.length + 2, ta.value.length);
    ta.setSelectionRange(to, to);
  });
}

/** @文件面板 pick 插入共用件（D86 收敛：键盘/点击两路六份「pathBasename+pickRelRef 记账+@token
 *  区间 splice+收面板」逐字核；G14.211 光标钉 ×4 同式随 pinTo 收编——钉在插入 token 右沿
 *  @+名+空格,旧光标位恢复=token 中间）。返回短写 base（入账键=显形名）。 */
export function applyFilePick(
  pickRelRef: { current: Map<string, string> },
  setText: (updater: (prev: string) => string) => void,
  opts: { rel: string; atFrom: number; queryLen: number; close: () => void; pinTo?: () => HTMLTextAreaElement | null },
): string {
  const base = pathBasename(opts.rel);
  pickRelRef.current.set(base, opts.rel);
  const atEnd = opts.atFrom + 1 + opts.queryLen;
  setText((prev) => prev.slice(0, opts.atFrom) + `@${base} ` + prev.slice(Math.max(atEnd, opts.atFrom)));
  opts.close();
  const pin = opts.pinTo;
  if (pin !== undefined) {
    pin()?.focus();
    requestAnimationFrame(() => {
      const ta = pin();
      if (ta === null) return;
      const to = Math.min(opts.atFrom + base.length + 2, ta.value.length);
      ta.setSelectionRange(to, to);
    });
  }
  return base;
}

/** 跳转定位行级蓝亮(2026-11-24 用户裁定推翻 11-08「跳转定位不加闪光」,同日二修口径):
 *  跨页签跳转落点打 `.jump-hl` **整体蓝底**(非描边)3 秒——确认点击已生效+对应关系;
 *  ①点击被亮的行立即熄灭 ②重复点击触发点重新计时 ③**同一面板内同时只亮一行**
 *  (scope=落点最近的 .insight-tab 面板根;跨面板互不影响)。纯 DOM 类+登记表,不经 React
 *  状态(与既有 imperative scrollIntoView 定位同型);重渲染换节点=自然消失 */
const jumpLit = new WeakMap<Element | Document, { el: Element; timer: number }>();
/** 面板首行点亮(2026-11-24 用户裁定「点击顶部的后台任务/待办/计划书/团队任务等触发点也要高亮」):
 *  顶栏计数钮开的是「无特定落点」的页签——点亮面板**第一行**作落点确认。页签体懒加载+数据
 *  异步到位,轮询可见 .sx-tabbody 至 2.5s 上限;无行面页签(diff/文件)轮询自然过期零副作用 */
const PANEL_ROW_SELECTORS = '.tb-card, .tb-task-main, .todo-card, .mem-row, li[data-skill-id]';
export function lightFirstPanelRow(deadline: number = performance.now() + 2500): void {
  const body = document.querySelector<HTMLElement>('.sx-tabbody:not([style*="none"])');
  const el = body?.querySelector(PANEL_ROW_SELECTORS) ?? null;
  if (el !== null) {
    markJumpHighlight(el);
    return;
  }
  if (performance.now() > deadline) return;
  requestAnimationFrame(() => lightFirstPanelRow(deadline));
}

export function markJumpHighlight(el: Element, ms = 3000): void {
  const scope = el.closest('.insight-tab') ?? el.ownerDocument;
  const prev = jumpLit.get(scope);
  if (prev !== undefined) {
    window.clearTimeout(prev.timer);
    prev.el.classList.remove('jump-hl');
    jumpLit.delete(scope);
  }
  el.classList.add('jump-hl');
  const clear = (): void => {
    window.clearTimeout(timer);
    el.classList.remove('jump-hl');
    el.removeEventListener('click', clear, true);
    if (jumpLit.get(scope)?.el === el) jumpLit.delete(scope);
  };
  const timer = window.setTimeout(clear, ms);
  el.addEventListener('click', clear, true); // 点被亮的行立即熄灭(捕获=先于行内 toggle)
  jumpLit.set(scope, { el, timer });
}
