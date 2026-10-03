/**
 * 文本匹配原语单点（普查 R4 收敛）：安全规则（security/rules）、权限（config/permissions）、
 * sandbox 三处共用的转义/glob 转换收敛于此，防三份拷贝漂移。零依赖叶子模块。
 *
 * 语义分立说明：permissions 的 pathGlobToRegex（`**` 跨段、`*`/`?` 不跨段）与 sandbox listFiles 的
 * 路径分段 glob 语义与此处简单 glob（`*` 跨任意字符）不同，刻意不分流到此——收敛以逐字节等价为前提。
 */

/** 正则元字符转义（与被收敛前三处实现逐字符等价） */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 简单 glob → 锚定正则（`*`→`.*`、`?`→`.`，语义以 security/rules 原实现为准；调用方加 ^$ 锚定） */
export function globToRegex(pattern: string): RegExp {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += escapeRegExp(ch);
  }
  return new RegExp('^' + out + '$');
}
