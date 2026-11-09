import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import type { WelcomeComposerConn } from './welcome-conn';

/** 欢迎页分支选择簇（D62 批C，2026-11-07 自 WelcomeComposer 外提——行为零变化）：picked 为 git 目录时拉
 *  分支清单、弹层外点收、切换分支回源；失败经宿主 hint 面可见化。 */
export function useWelcomeBranch(conn: WelcomeComposerConn, picked: string, isDefaultPicked: boolean, setHint: (msg: string) => void) {
  /** G14.113 欢迎页分支选择(picked 为 git 目录时显):分支清单/当前分支/切换 */
  const [gitBr, setGitBr] = useState<{ current: string; branches: string[] } | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const branchRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (picked === '' || isDefaultPicked) { setGitBr(null); setBranchOpen(false); return; }
    let alive = true;
    conn.gitBranches(picked).then(
      (r) => { if (alive) setGitBr(r.branches.length > 0 ? r : null); },
      () => { if (alive) setGitBr(null); },
    );
    return () => { alive = false; };
  }, [picked, conn, isDefaultPicked]);
  useEffect(() => {
    if (!branchOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (branchRef.current !== null && e.target instanceof Node && !branchRef.current.contains(e.target)) setBranchOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [branchOpen]);
  const checkoutBranch = (branch: string, create = false): void => {
    void conn
      .gitCheckout(picked, branch, create)
      .then(() => conn.gitBranches(picked))
      .then((r) => setGitBr(r.branches.length > 0 ? r : null))
      .catch((err: unknown) => setHint(`${t('Branch switch failed', '切换分支失败')}: ${err instanceof Error ? err.message : String(err)}`));
  };
  return { gitBr, branchOpen, setBranchOpen, branchRef, checkoutBranch };
}
