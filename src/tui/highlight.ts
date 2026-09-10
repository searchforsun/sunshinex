/** 语法高亮 token 类别（渲染层映射为 ink 前景色） */
export type HiKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number';

export interface HiSpan {
  text: string;
  kind: HiKind;
}

/** 语言家族 → 关键字集合（轻量：仅覆盖高频关键字，非完整词法表） */
const KEYWORDS: Record<string, Set<string>> = {
  js: new Set(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new', 'import', 'export', 'from', 'await', 'async', 'try', 'catch', 'throw', 'typeof', 'instanceof', 'null', 'undefined', 'true', 'false', 'this', 'of', 'in', 'do', 'switch', 'case', 'break', 'continue', 'default', 'extends', 'super', 'static', 'get', 'set', 'yield', 'delete', 'void']),
  ts: new Set(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new', 'import', 'export', 'from', 'await', 'async', 'try', 'catch', 'throw', 'typeof', 'instanceof', 'null', 'undefined', 'true', 'false', 'this', 'of', 'in', 'do', 'switch', 'case', 'break', 'continue', 'default', 'extends', 'super', 'static', 'get', 'set', 'yield', 'delete', 'void', 'interface', 'type', 'enum', 'readonly', 'implements', 'declare', 'namespace', 'abstract', 'public', 'private', 'protected', 'as', 'satisfies', 'keyof']),
  python: new Set(['def', 'return', 'if', 'elif', 'else', 'for', 'while', 'class', 'import', 'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'pass', 'break', 'continue', 'yield', 'global', 'nonlocal', 'assert', 'del', 'in', 'is', 'not', 'and', 'or', 'True', 'False', 'None', 'async', 'await', 'print']),
  bash: new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'function', 'in', 'return', 'exit', 'echo', 'export', 'local', 'readonly', 'set', 'unset', 'source', 'shift', 'cd', 'ls', 'grep', 'cat', 'true', 'false']),
  sql: new Set(['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table', 'index', 'view', 'drop', 'alter', 'add', 'join', 'left', 'right', 'inner', 'outer', 'on', 'as', 'and', 'or', 'not', 'null', 'is', 'in', 'like', 'group', 'by', 'order', 'having', 'limit', 'offset', 'distinct', 'union', 'all', 'count', 'sum', 'avg', 'min', 'max', 'primary', 'key', 'foreign', 'references', 'default', 'unique', 'check']),
};

/** 语言归一化：ts/js 互认，别名（sh→bash、py→python）合并 */
function keywordSet(lang: string): Set<string> | undefined {
  const l = lang.trim().toLowerCase();
  if (l === 'js' || l === 'javascript' || l === 'mjs' || l === 'cjs') return KEYWORDS.js;
  if (l === 'ts' || l === 'typescript' || l === 'tsx' || l === 'jsx') return KEYWORDS.ts;
  if (l === 'py' || l === 'python' || l === 'python3') return KEYWORDS.python;
  if (l === 'sh' || l === 'bash' || l === 'zsh' || l === 'shell') return KEYWORDS.bash;
  if (l === 'sql') return KEYWORDS.sql;
  return undefined;
}

/** 单词边界判断（标识符续字符不算边界） */
const isWordChar = (c: string | undefined): boolean => (c !== undefined && /[A-Za-z0-9_]/.test(c));

/** 单行语法高亮：关键字/字符串/注释/数字四类着色，其余透传（纯函数，零 IO，不抛错） */
export function highlightLine(lang: string, line: string): HiSpan[] {
  const kws = keywordSet(lang);
  if (!kws) return [{ text: line, kind: 'plain' }];

  const spans: HiSpan[] = [];
  const push = (text: string, kind: HiKind): void => {
    if (text.length === 0) return;
    const last = spans[spans.length - 1];
    if (last && last.kind === kind) last.text += text;
    else spans.push({ text, kind });
  };
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const prev = line[i - 1];
    // 行注释：js/ts // ，python/bash # ，sql --
    if ((ch === '/' && line[i + 1] === '/') || (ch === '#') || (ch === '-' && line[i + 1] === '-')) {
      push(line.slice(i), 'comment');
      break;
    }
    // 字符串：单/双/反引号（sql 单引号同为字符串字面量）
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = line.indexOf(ch, i + 1);
      if (end > i) {
        push(line.slice(i, end + 1), 'string');
        i = end + 1;
        continue;
      }
      push(ch, 'plain');
      i++;
      continue;
    }
    // 数字：以数字开头且前一字符非标识符续字符
    if (/[0-9]/.test(ch) && !isWordChar(prev)) {
      const m = /^[0-9][0-9a-zA-Z_.]*/.exec(line.slice(i));
      if (m) {
        push(m[0], 'number');
        i += m[0].length;
        continue;
      }
    }
    // 标识符 / 关键字
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i));
      if (m) {
        push(m[0], kws.has(m[0]) ? 'keyword' : 'plain');
        i += m[0].length;
        continue;
      }
    }
    push(ch, 'plain');
    i++;
  }
  return spans;
}
