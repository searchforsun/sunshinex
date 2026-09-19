/**
 * 跨平台路径判定原语（叶子模块：不依赖 security / memory / config，避免模块环）。
 *
 * 存在理由：路径子树包含判定曾在三处各自实现——安全链 root 判界（chain.resolveSafe）、
 * 安全链 dataDir 判界（chain.underDataDir）、记忆路径分类（memory.isMemoryPath）。
 * 三份拷贝的历史代价已发生过一次：只归一 absPath 而不归一 dataDir 时「前缀比对恒失配、静默全拒」
 * （见 memory/paths.ts 头部裁决记录）。语义单点是唯一解，故收敛到此。
 *
 * 与 data-dir.ts 的分工：那里管「数据目录怎么定位」，这里管「两个路径是否构成子树关系」——
 * 定位随策略变（覆盖 > 全局 > 回退），包含关系是恒定的数学判定，两者不该混在一处。
 */
import * as path from 'path';

/**
 * target 是否落在 root 子树内（含 root 自身）。纯字符串判定，零 IO。
 *
 * 契约：**两侧须口径同源**——要么都 realpath 归一，要么都未归一。混用即产生
 * memory/paths.ts 记录过的失配全拒。调用方负责归一（realpath 属 IO，不混进纯函数）。
 *
 * 大小写：**刻意不做大小写归一化**，两侧语义相反——
 *   · POSIX：文件系统区分大小写，`/data/Root` 与 `/data/root` 是两个不同目录；
 *     不敏感比较会把越界目标判为「在根内」，属 fail-open（真漏洞）。
 *   · Windows/macOS：文件系统不区分大小写，但比较双方同由 realpath 产出
 *     （libuv 在 Windows 经 GetFinalPathNameByHandleW 返回磁盘上的规范大小写），
 *     故天然一致，无需归一；真正的不一致只发生在 root 不存在而字面回退时，
 *     其后果是「合法路径被误拒」（fail-closed），可接受。
 * 结论：归一化换不来安全增益，却会在 POSIX 上制造缺口——不作为。
 *
 * 尾分隔符：先去尾再拼。否则 root='/' 时拼出 '//'，任何目标都判「子树外」，
 * 整个文件系统被误判越界（fail-closed 到不可用）。
 */
export function isWithin(root: string, target: string): boolean {
  const sep = path.sep;
  const base = root.length > 1 && root.endsWith(sep) ? root.slice(0, -1) : root;
  // 文件系统根（POSIX '/'）：其下一切绝对路径皆在内，单字符基准不可再拼分隔符
  if (base === sep) return target.startsWith(sep);
  return target === base || target.startsWith(base + sep);
}
