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

/** tokens 格式(G14.17 自 Chat.tsx 导出共享):8400 → 8.4k tokens;840 → 840 tokens */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`;
}

/** ISO 时刻 → 本地短时刻(创建时间回溯面):'2026-10-11T05:24:29.123Z' → '10-11 13:24' */
export function shortLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 原生文件夹选择(G10-C11,统一交互单点):桌面壳走 IPC 系统对话框(回全路径);浏览器走
 *  showDirectoryPicker(Win 原生对话框——安全模型只回名字,建项目交 daemon /workspace/create)。
 *  返回 {name[,path]} | 'unsupported'(环境无原生选择器) | null(用户取消) */
export async function pickFolderNative(): Promise<{ name: string; path?: string } | 'unsupported' | null> {
  const w = window as unknown as { sunshinex?: { pickFolder?: () => Promise<string | null> } };
  if (typeof w.sunshinex?.pickFolder === 'function') {
    const p = await w.sunshinex.pickFolder();
    if (p === null) return null;
    return { name: p.split(/[\\/]/).filter(Boolean).pop() ?? p, path: p };
  }
  const picker = (window as unknown as {
    showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<{ name: string }>;
  }).showDirectoryPicker;
  if (typeof picker !== 'function') return 'unsupported';
  try {
    const handle = await picker({ mode: 'readwrite' });
    return { name: handle.name };
  } catch {
    return null; // 用户取消(原生对话框 AbortError)
  }
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
