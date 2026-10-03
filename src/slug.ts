/**
 * tasks/worktree/learned 三处 slug 方言单点（R5 折叠）：正则链共口——toLowerCase → 非 [a-z0-9]
 * 连续段折叠 '-' → 去首尾 '-' → 截长 → 去尾 '-' → 全折叠空串回退 fallback。各调用方言只差
 * max/fallback 两参（任务 id 业务段 16/kind、worktree 树名 27/'wt'、learned 目录 id 40/'learned'），
 * 三份本地正则链此前逐字同构漂移风险高（汉字等非拉丁一律折叠，防中文 id 在跨平台路径面出隐患）。
 * trim 首步对链路是无操作（端部空白本就折叠成 '-' 后被去首尾 '-' 剥掉），保留以对齐最大共识形态。
 */
export function slugify(text: string, opts: { max: number; fallback: string }): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, opts.max)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : opts.fallback;
}
