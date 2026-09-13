import hljs from 'highlight.js';

/** 语法高亮 token 类别（渲染层映射为 ink 前景色） */
export type HiKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number';

export interface HiSpan {
  text: string;
  kind: HiKind;
}

/** highlight.js 内部 token 树节点（rootNode 类型未导出，自声明） */
interface HiNode {
  scope?: string;
  sublanguage?: string;
  children?: (HiNode | string)[];
}

/** scope → HiKind：仅保留渲染层有前景色映射的核心类别，其余归 plain */
function scopeToKind(scope: string | undefined): HiKind | undefined {
  if (scope === 'keyword') return 'keyword';
  if (scope === 'string') return 'string';
  if (scope === 'comment') return 'comment';
  if (scope === 'number') return 'number';
  return undefined;
}

/** 深度优先遍历 token 树，展平为 HiSpan[] */
function flatten(node: HiNode | string, inherited: HiKind, out: HiSpan[]): void {
  if (typeof node === 'string') {
    out.push({ text: node, kind: inherited });
    return;
  }
  const kind = scopeToKind(node.scope) ?? inherited;
  if (node.children) {
    for (const child of node.children) flatten(child, kind, out);
  }
}

/** 合并相邻同 kind 的 span（贴近渲染层「连续同色为一段」的预期） */
function mergeSpans(spans: HiSpan[]): HiSpan[] {
  const out: HiSpan[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && last.kind === s.kind) last.text += s.text;
    else out.push({ text: s.text, kind: s.kind });
  }
  return out;
}

/** 单行语法高亮：委托 highlight.js，映射核心 scope；未知语言/异常整行 plain（纯函数，不抛错） */
export function highlightLine(lang: string, line: string): HiSpan[] {
  const l = lang.trim().toLowerCase();
  if (!l || !hljs.getLanguage(l)) return [{ text: line, kind: 'plain' }];
  try {
    const result = hljs.highlight(line, { language: l, ignoreIllegals: true });
    const emitter = result._emitter as unknown as { root: HiNode };
    const spans: HiSpan[] = [];
    flatten(emitter.root, 'plain', spans);
    // 输出不变量：非空且完整覆盖原文；空行等场景 hljs token 树为空，回退整行 plain
    return spans.length > 0 ? mergeSpans(spans) : [{ text: line, kind: 'plain' }];
  } catch {
    return [{ text: line, kind: 'plain' }];
  }
}
