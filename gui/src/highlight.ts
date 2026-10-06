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
