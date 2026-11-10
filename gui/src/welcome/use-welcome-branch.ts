import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import type { WelcomeComposerConn } from './welcome-conn';

/** 欢迎页分支选择簇(2026-11-10 用户裁定改宗「选择不切换」):git 目录拉分支清单+占用清单;
 *  菜单点选/新建只改**选中态**(发送时统一落地——非隔离=确认后主工作区切换,隔离=worktree 签出),
 *  新建分支=仅 `git branch` 不切换;被其他 worktree 签出的分支禁用+「已签出」标记。
 *  实际切换/签出的冲突校验在发送时 daemon 实测兜底(菜单清单可能过期)。 */
export function useWelcomeBranch(conn: WelcomeComposerConn, picked: string, isDefaultPicked: boolean, setHint: (msg: string) => void) {
  const [gitBr, setGitBr] = useState<{ current: string; branches: string[]; occupied?: Record<string, string> } | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [creating, setCreating] = useState(false);
  const branchRef = useRef<HTMLDivElement | null>(null);
  const refresh = (root: string): void => {
    void conn.gitBranches(root).then((r) => setGitBr(r.branches.length > 0 ? r : null), () => setGitBr(null));
  };
  useEffect(() => {
    if (picked === '' || isDefaultPicked) {
      setGitBr(null);
      setSelectedBranch('');
      setBranchOpen(false);
      return;
    }
    refresh(picked);
    return () => undefined;
  }, [picked, conn, isDefaultPicked]);
  useEffect(() => {
    if (!branchOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (branchRef.current !== null && e.target instanceof Node && !branchRef.current.contains(e.target)) setBranchOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [branchOpen]);
  /** 菜单点选=只改选中态(占用项由菜单禁用,不会到达) */
  const pick = (b: string): void => {
    setSelectedBranch(b === gitBr?.current ? '' : b);
    setBranchOpen(false);
  };
  /** 新建分支(仅创建不切换):git branch + 回源清单 + 选中新建项;已存在/非法名 hint 可见化 */
  const createBranchOnly = (b: string): void => {
    if (picked === '' || creating) return;
    setCreating(true);
    conn
      .gitBranchCreate(picked, b)
      .then(() => {
        setSelectedBranch(b);
        refresh(picked);
        setBranchOpen(false);
      })
      .catch((err: unknown) => setHint(`${t('Create branch failed', '创建分支失败')}: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setCreating(false));
  };
  return { gitBr, branchOpen, setBranchOpen, branchRef, selectedBranch, setSelectedBranch, pick, createBranchOnly, refresh };
}
