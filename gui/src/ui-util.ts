/**
 * G8e-T2 共享 UI 小工具:relTime/errText 原三处本地复制(SettingsForm/SettingsShell/
 * ProjectMenu)抽一单源——行为逐字保持,既有测试面零破。
 */

import { t } from './i18n';

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
  const bridge = (window as unknown as { sunshinexWindow?: { openExternal?: (url: string) => Promise<{ ok: boolean }> } }).sunshinexWindow;
  if (bridge?.openExternal !== undefined) void bridge.openExternal(url).catch(() => {});
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/** tokens 格式(G14.17 自 Chat.tsx 导出共享):8400 → 8.4k tokens;840 → 840 tokens */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`;
}

/** 路径段切分单点：双分隔符归一、空段滤除（disambiguateTabTitles 逐级上溯段构成消费；
 *  daemon 下发 POSIX 相对路径与 Windows 绝对路径两面同源）。 */
export function pathSegments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

/** 路径 basename 单点（D34 口径收敛）：双分隔符归一（Windows 反斜杠/POSIX 斜杠）、
 *  空段滤除、无分隔符原样返回——daemon 下发 POSIX 相对路径与 Windows 绝对路径两面同源。 */
export function pathBasename(p: string): string {
  return pathSegments(p).pop() ?? p;
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

/** 毫秒时刻 → 本地短时刻(HH:mm;run 尾部完成时间):非法日期回退 '--:--' */
export function shortClockMs(ms: number): string {
  const d = new Date(ms);
  if (!(ms > 0) || Number.isNaN(d.getTime())) return '--:--';
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** G14.69 原生工作区选择结果:null=用户取消;字符串态=降级原因(GUI 回退自建目录浏览) */
export type WorkspacePickResult = { path: string } | 'unsupported' | 'denied' | 'timeout' | null;

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
