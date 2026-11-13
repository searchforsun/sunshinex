import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** D62 批F 自 WelcomeComposer 平移的欢迎页持久化/隐现副作用簇（2026-11-12/13 特性线回弹增量）：
 *  三态选择写档+分支恢复单次闸+模型/强度持久+选项条窄宽隐现；闭包语义与宿主原段逐字等价。 */

/** 挂载即恢复上次项目（键随 sx-welcome:model/effort 同族；失效根由 useWelcomeWorkspaces 回源校验回落默认） */
export function readPersistedProject(): string {
  try {
    return localStorage.getItem('sx-welcome:project') ?? '';
  } catch {
    return '';
  }
}

/** 挂载即恢复隔离武装态（同项目/分支一族） */
export function readPersistedIsolate(): boolean {
  try {
    return localStorage.getItem('sx-welcome:isolate') === '1';
  } catch {
    return false;
  }
}

/** 模型/思考强度持久（2026-11-09 用户裁定）：localStorage 即时层挂载读回；记忆的模型已不在
 *  清单（providers 变更删除）→ 回落缺省，不把失效 id 带进新会话 */
export function useWelcomePersistedModel(modelChoices: Array<{ id: string; effort?: string }>): {
  selModel: string | undefined;
  setSelModel: (v: string | undefined) => void;
  selEffort: string;
  setSelEffort: (v: string) => void;
} {
  const [selModel, setSelModel] = useState<string | undefined>(() => localStorage.getItem('sx-welcome:model') ?? undefined);
  const [selEffort, setSelEffort] = useState<string>(() => localStorage.getItem('sx-welcome:effort') ?? 'medium');
  useEffect(() => {
    if (selModel !== undefined) localStorage.setItem('sx-welcome:model', selModel);
    else localStorage.removeItem('sx-welcome:model');
  }, [selModel]);
  useEffect(() => {
    localStorage.setItem('sx-welcome:effort', selEffort);
  }, [selEffort]);
  useEffect(() => {
    if (selModel !== undefined && modelChoices.length > 0 && !modelChoices.some((c) => c.id === selModel)) setSelModel(undefined);
  }, [modelChoices, selModel]);
  return { selModel, setSelModel, selEffort, setSelEffort };
}

/** 项目/分支/隔离三态选择持久（2026-11-12 用户裁定「切会话不回默认」）：三态变更即写
 *  localStorage（sx-welcome:* 键族）；隐私模式写失败静默。分支恢复单次闸：gitBr 首次到位
 *  （picked 恢复的项目）且存档分支仍在清单且≠当前 → 恢复预选；此后用户改选不再回写 */
export function useWelcomePersistedPicks({
  picked,
  selectedBranch,
  isolate,
  gitBr,
  setSelBranch,
}: {
  picked: string;
  selectedBranch: string;
  isolate: boolean;
  gitBr: { current: string; branches: string[] } | null;
  setSelBranch: (v: string) => void;
}): void {
  useEffect(() => {
    try {
      localStorage.setItem('sx-welcome:project', picked);
    } catch { /* 隐私模式写失败静默 */ }
  }, [picked]);
  useEffect(() => {
    try {
      localStorage.setItem('sx-welcome:branch', selectedBranch);
    } catch { /* 隐私模式写失败静默 */ }
  }, [selectedBranch]);
  useEffect(() => {
    try {
      localStorage.setItem('sx-welcome:isolate', isolate ? '1' : '0');
    } catch { /* 隐私模式写失败静默 */ }
  }, [isolate]);
  const branchRestoreRef = useRef(true);
  useEffect(() => {
    if (!branchRestoreRef.current || gitBr === null) return;
    branchRestoreRef.current = false;
    let saved = '';
    try {
      saved = localStorage.getItem('sx-welcome:branch') ?? '';
    } catch { /* 读档失败=无预选 */ }
    if (saved !== '' && saved !== gitBr.current && gitBr.branches.includes(saved)) setSelBranch(saved);
  }, [gitBr, setSelBranch]);
}

/** 选项条窄宽隐现（2026-11-12 用户裁定「过窄自动隐现工作区/分支名,不换行不超视口」）：
 *  名字 span 溢出打 data-cut=右缘 14px 渐隐（同页签隐现口径）；条级不打点不裁剪——分支弹层
 *  向上伸出条外，条级 overflow 会连弹层一起截。ResizeObserver 盯条随宽重算，选中/项目名
 *  变更随内容重算 */
export function useOptsBarCut(deps: [string, unknown, string, string]): React.Ref<HTMLDivElement> {
  const optsBarRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const bar = optsBarRef.current;
    if (bar === null) return;
    const mark = (): void => {
      for (const el of bar.querySelectorAll<HTMLElement>('.wc-pill-label')) {
        if (el.scrollWidth > el.clientWidth + 1) el.setAttribute('data-cut', '');
        else el.removeAttribute('data-cut');
      }
    };
    mark();
    const ro = new ResizeObserver(mark);
    ro.observe(bar);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return optsBarRef;
}
