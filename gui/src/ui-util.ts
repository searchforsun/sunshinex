/**
 * G8e-T2 共享 UI 小工具:relTime/errText 原三处本地复制(SettingsForm/SettingsShell/
 * ProjectMenu)抽一单源——行为逐字保持,既有测试面零破。
 */

/** 相对时间(简易,纯刻度不带后缀):<60s 刚刚;<60m Nm;<24h Nh;否则 Nd */
export function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
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
