/**
 * 从 argv 判定是否走 shell 冒烟模式：精确匹配 '--shell-smoke'，
 * '--shell-smoke=x' 之类的带值形态不算命中。
 */
export function parseSmokeArgv(argv: readonly string[]): { smoke: boolean } {
  return { smoke: argv.includes('--shell-smoke') };
}
