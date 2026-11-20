/**
 * slug 正则链单点（R5 折叠）。主链 slugify：tasks/worktree/learned 三处方言共口——toLowerCase →
 * 非 [a-z0-9] 连续段折叠 '-' → 去首尾 '-' → 截长 → 去尾 '-' → 全折叠空串回退 fallback。各调用方言
 * 只差 max/fallback 两参（任务 id 业务段 16/kind、worktree 树名 27/'wt'、learned 目录 id 40/'learned'），
 * 多份本地正则链此前逐字同构漂移风险高（汉字等非拉丁一律折叠，防中文 id 在跨平台路径面出隐患）。
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

/**
 * memory 记录 slug 方言（自 memory/store.ts 本地正则链收编，防第 4 份漂移）：**不降大小写 +
 * Unicode 字母数字保留**。记忆标题多为中文，按主链折叠会全部塌缩 fallback 撞车；slug 同时是
 * 记录文件名与 links/supersededBy 的引用键，落机器本地数据域（~/.sunshinex/projects/…）不跨机
 * 运输，中文档名无跨平台传输面。合法 slug 判定=本函数幂等（memory isSafeSlug）——方言换形即
 * 全量存量记录失联，不得并回主链。
 */
export function slugifyMemory(title: string): string {
  const slug = title
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'memo';
}
