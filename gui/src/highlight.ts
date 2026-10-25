import hljs from 'highlight.js';

/**
 * G6 代码高亮渲染助手（Files 页消费）：文件名 → highlight.js 语言的映射单点 + HTML 产出。
 * 与主仓 TUI highlight.ts 同源库（highlight.js@^11 全量包——toml/tsx 等不在 common 子集内，
 * 全量导入换映射表完整性；GUI 打包面可后续按需收敛，语义优先）。
 *
 * 产出为 HTML 字符串（`hljs.highlight(code, {language}).value`）——消费面以
 * dangerouslySetInnerHTML 注入 <code>：内容经 hljs 转义（highlight.js 的 emit 流程对原文
 * HTML 转义后才包 span），非代码部分原样转义输出，无注入面。
 */

/** 扩展名 → highlight.js 语言名（小写扩展；缺省 plaintext） */
const EXT_LANG: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  json: 'json',
  md: 'markdown',
  css: 'css',
  html: 'xml',
  py: 'python',
  rs: 'rust',
  java: 'java',
  sh: 'bash',
  bash: 'bash',
  yaml: 'yaml',
  xml: 'xml',
  toml: 'toml',
};

/** 文件名 → 语言：取末段扩展名查表；无扩展名/未登记扩展名缺省 plaintext */
function languageOf(filename?: string): string {
  if (filename === undefined || filename === '') return 'plaintext';
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  const lang = EXT_LANG[ext];
  // 表外扩展名缺省 plaintext；表内语言未注册（理论不可达——全量包）同样回落，不抛错
  return lang !== undefined && hljs.getLanguage(lang) !== undefined ? lang : 'plaintext';
}

/** 五字符 HTML 转义(& < > " ')——hljs 异常回落面专用(T1 评审必落):产出经
 *  dangerouslySetInnerHTML 注入,裸返原文即注入面——回落路径必须自转义 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** 代码 → 高亮 HTML：异常防御性回落转义原文（高亮失败不挡预览,亦不开注入面） */
export function highlightCode(code: string, filename?: string): string {
  try {
    return hljs.highlight(code, { language: languageOf(filename) }).value;
  } catch {
    return escapeHtml(code);
  }
}

/** 代码 → 高亮 HTML：异常防御性回落转义原文——与 highlightCode 同注入面纪律 */
export function highlightByLang(code: string, lang?: string): string {
  try {
    const name = lang !== undefined && hljs.getLanguage(lang) !== undefined ? lang : 'plaintext';
    return hljs.highlight(code, { language: name }).value;
  } catch {
    return escapeHtml(code);
  }
}

/* ---------- shell 命令行专用着色(2026-10-25 用户裁定「命令行高亮优化」) ----------
 *  hljs bash 语法面向脚本,对单行命令几乎不产令牌(首词/字符串之外全裸文——git add -m 等
 *  全白)。本扫描器按命令行形态分词:命令词(行首/操作符后)/旗标/字符串/变量/操作符/数字/
 *  注释,令牌类 tok-* 在 app.css 取 syntax 表色。手写扫描零正则回溯,注入面=escapeHtml 单点 */

const isWordChar = (c: string): boolean => /[^\s|;<>&()"']/.test(c);

function span(cls: string, text: string): string {
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

/** 命令词后的子词也保持可读:命令位=行首/&& || | ; & ( 之后。
 *  slashFlags(2026-10-25):cmd/powershell 变体——`/b` 形旗标同 `-b` 着色(DOS 路径用 \,无误伤面) */
export function highlightCommand(code: string, slashFlags = false): string {
  let out = '';
  let i = 0;
  let cmdPos = true; // 下一词是否处于命令位
  let lineStart = true;
  const n = code.length;
  while (i < n) {
    const c = code[i]!;
    // 换行:重置命令位
    if (c === '\n') {
      out += escapeHtml(c);
      i += 1;
      cmdPos = true;
      lineStart = true;
      continue;
    }
    // 空白:原样
    if (/\s/.test(c)) {
      out += escapeHtml(c);
      i += 1;
      continue;
    }
    // 注释:# 起词(行首或空白后)到行尾
    if (c === '#' && (lineStart || /\s/.test(code[i - 1] ?? ' '))) {
      const end = code.indexOf('\n', i);
      const seg = end < 0 ? code.slice(i) : code.slice(i, end);
      out += span('tok-cmt', seg);
      i += seg.length;
      continue;
    }
    // 字符串:引号起词;未闭合吃到行尾(流式半截命令不裸文)
    if (c === '"' || (c === "'" && (lineStart || /\s/.test(code[i - 1] ?? ' ')))) {
      let j = i + 1;
      while (j < n && code[j] !== c && code[j] !== '\n') {
        if (code[j] === '\\') j += 1;
        j += 1;
      }
      const seg = j < n && code[j] === c ? code.slice(i, j + 1) : code.slice(i, j);
      out += span('tok-str', seg);
      i += seg.length;
      cmdPos = false;
      continue;
    }
    // 操作符(长先匹配):&& || ;; >> 2>&1 由数字段配合作色,此处吃符号族
    const two = code.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === ';;' || two === '>>') {
      out += span('tok-op', two);
      i += 2;
      cmdPos = true;
      lineStart = false;
      continue;
    }
    if ('|;<>&()'.includes(c)) {
      out += span('tok-op', c);
      i += 1;
      // ( 后仍是命令位;其余符号后同样(管道右侧是新命令)
      cmdPos = c !== ')';
      lineStart = false;
      continue;
    }
    // 变量:${..} $(..) $VAR ~ 展开位
    if (c === '$') {
      let j = i + 1;
      if (code[j] === '{') {
        const end = code.indexOf('}', j);
        j = end < 0 ? n : end + 1;
      } else if (code[j] === '(') {
        let depth = 1;
        j += 1;
        while (j < n && depth > 0) {
          if (code[j] === '(') depth += 1;
          else if (code[j] === ')') depth -= 1;
          else if (code[j] === '\n') break;
          j += 1;
        }
      } else {
        while (j < n && /[A-Za-z0-9_@#?*$!-]/.test(code[j] ?? '')) j += 1;
      }
      out += span('tok-var', code.slice(i, Math.max(j, i + 1)));
      i = Math.max(j, i + 1);
      cmdPos = false;
      lineStart = false;
      continue;
    }
    if (c === '~' && (cmdPos || /\s/.test(code[i - 1] ?? ' '))) {
      let j = i + 1;
      while (j < n && /[\w./-]/.test(code[j] ?? '')) j += 1;
      out += span('tok-var', code.slice(i, j));
      i = j;
      cmdPos = false;
      lineStart = false;
      continue;
    }
    // 旗标:-x --xx(含 =值);数字起(如 -8)同样;cmd/powershell 变体另收 /x
    if ((c === '-' || (slashFlags && c === '/')) && /[A-Za-z0-9]/.test(code[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[\w.=-]/.test(code[j]!)) j += 1;
      out += span('tok-flag', code.slice(i, j));
      i = j;
      cmdPos = false;
      lineStart = false;
      continue;
    }
    // 词:ENV=赋值(前缀,命令位不消耗——真命令在后);命令位=命令词;纯数字=数字;其余参数原样
    if (isWordChar(c)) {
      let j = i;
      while (j < n && isWordChar(code[j]!)) j += 1;
      const word = code.slice(i, j);
      const env = /^([A-Za-z_][\w]*)=(.*)$/.exec(word);
      if (env !== null) {
        // ENV=赋值:名段着变量色;值段引号包=字符串,否则原样(值不是命令位,不再递归)
        const val = env[2] ?? '';
        out += span('tok-var', env[1]! + '=');
        out += val !== '' && (val.startsWith('"') || val.startsWith("'")) ? span('tok-str', val) : escapeHtml(val);
        i = j;
        lineStart = false;
        continue; // cmdPos 保持:FOO=bar echo 的 echo 仍是命令位
      }
      if (cmdPos) {
        out += span('tok-cmd', word);
        cmdPos = false;
      } else if (/^\d+$/.test(word)) {
        out += span('tok-num', word);
      } else {
        out += escapeHtml(word);
      }
      i = j;
      lineStart = false;
      continue;
    }
    // 其余(引号内起词/转义等)原样
    out += escapeHtml(c);
    i += 1;
    lineStart = false;
  }
  return out;
}

/** ANSI 转义序列剥离(显示面单点):终端产出(exec 日志等)带 SGR 颜色码,渲染进 <pre> 即
 *  「�[2m」乱码。CSI/OSC/裸 ESC 三形态全收;仅渲染面调用,数据面原文不动 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g, '');
}

/** 围栏脚本高亮分派(2026-10-25 用户裁定「代码块脚本命令复用命令行着色器」):shell 家族
 *  (hljs bash 对命令行几乎零令牌)走 highlightCommand;cmd/powershell 用斜杠旗标变体;
 *  其余(py/js/…)维持 hljs。语言名大小写不敏感,未登记语言回落 hljs/plaintext */
const CMD_FENCES: ReadonlySet<string> = new Set([
  'bash', 'sh', 'shell', 'zsh', 'shell-session', 'console', 'sh-session',
  'powershell', 'pwsh', 'ps1', 'cmd', 'batch', 'bat',
]);
const SLASH_FLAG_FENCES: ReadonlySet<string> = new Set(['powershell', 'pwsh', 'ps1', 'cmd', 'batch', 'bat']);

export function highlightFence(code: string, lang?: string): string {
  const l = (lang ?? '').toLowerCase();
  if (CMD_FENCES.has(l)) return highlightCommand(code, SLASH_FLAG_FENCES.has(l));
  return highlightByLang(code, lang);
}
