import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/** 编译产物位于 dist/harness/，回退两级到仓库根 */
const ROOT = path.resolve(__dirname, '..', '..');
const CJK = /[\u4e00-\u9fff]/;

/**
 * 按批次登记「提示词与链的产出面」文件。
 * 判据（CLAUDE.md §15）：非 `t()` 包裹的中文即泄漏——写链/进模型必须英文；
 * 写死的上屏回执须显式包 t()（包了即放行，这正是「死的用户显示」的标记）。
 */
const SCOPES: Record<string, string[]> = {
  B1: [
    'src/harness/tools.ts',
    'src/harness/tools/builtin.ts',
    'src/harness/tools/output-archive.ts',
    'src/harness/tools/websearch.ts',
    'src/harness/context/index.ts',
    'src/harness/context/window.ts',
    'src/harness/context/summarizer.ts',
    'src/harness/knowledge/embed.ts',
    'src/harness/knowledge/store.ts',
    'src/harness/knowledge/store.sqlite-vec.ts',
  ],
};

/**
 * 找出「非 t() 包裹」的中文字符串字面量。
 *
 * 取 TS 编译器 API 的真 AST，而非手写词法扫描：注释与正则字面量天然不误伤
 * （手写引号状态机在正则字面量内含引号时会失同步，把后续中文注释误判为字符串，
 * 见 `tools/websearch.ts` 的正则 `class="result__a"`），行号取自行列信息、逐字面量精确。
 * 包裹判定：沿 parent 链上溯到最近一层 CallExpression，其表达式为标识符 `t` 即放行。
 */
export function leaks(rel: string): { line: number; text: string }[] {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const kind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, raw, ts.ScriptTarget.Latest, true, kind);
  const lines = raw.split('\n');

  const posLine = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line;
  const exemptAt = (pos: number): boolean => (lines[posLine(pos)] ?? '').includes('i18n-exempt');
  /** 最近一层 CallExpression 是否 `t(...)`；越过语句边界即视为未包裹 */
  const wrappedByT = (node: ts.Node): boolean => {
    let p: ts.Node | undefined = node.parent;
    while (p !== undefined) {
      if (ts.isCallExpression(p)) return ts.isIdentifier(p.expression) && p.expression.text === 't';
      if (ts.isStatement(p) || ts.isSourceFile(p)) return false;
      p = p.parent;
    }
    return false;
  };

  const found: { line: number; text: string }[] = [];
  const record = (pos: number, text: string): void => {
    if (CJK.test(text) && !exemptAt(pos)) found.push({ line: posLine(pos) + 1, text: text.slice(0, 100) });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!wrappedByT(node)) record(node.getStart(sf), node.text);
    } else if (ts.isTemplateExpression(node)) {
      // 模板字面量按整节点计一条；插值表达式内部由子节点各自处理
      const text = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join('');
      if (!wrappedByT(node)) record(node.getStart(sf), text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

for (const [batch, files] of Object.entries(SCOPES)) {
  test(`prompt-language ${batch}：非 t() 包裹的中文零泄漏`, () => {
    const hits = files.flatMap((f) => leaks(f).map((h) => `${f}:${h.line}  ${h.text}`));
    assert.deepEqual(hits, [], `以下串进模型或进链却带中文，须按 R1/R3 改英文（用户回执改 t() 双语）：\n${hits.join('\n')}`);
  });
}
