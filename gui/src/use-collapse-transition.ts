import { useEffect, useState } from 'react';

/**
 * 面板展开/收起过渡(2026-11-18 用户裁定「应用的侧栏、菜单栏、下栏,展开和关闭要平滑效果」):
 * 三块面板此前都是条件渲染(开=挂载/关=立即卸载),CSS 过渡无从跑起。本 hook 把「是否挂载」与
 * 「是否 open」拆开——关闭时先保留挂载 durationMs 让根节点的关闭类(宽度/高度收到 0)跑完过渡,
 * 再真卸载;打开立即挂载,组件根节点自带的展开 keyframe(sx-panel-in / sx-dock-in)负责入场。
 * 卸载后零成本,不改变任何面板内部行为(含 keep-alive 页签)。
 */
export function useCollapseTransition(open: boolean, durationMs = 200): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    setClosing((c) => (mounted ? true : c));
  }, [open, mounted]);
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => {
      setClosing(false);
      setMounted(false);
    }, durationMs);
    return () => window.clearTimeout(timer);
  }, [closing, durationMs]);
  return { mounted, closing };
}
