import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** CLAUDE.md §13.1 规则 7 扫描面（2026-11-09 用户裁定）：可点元素内图标 ≥14px（只随界面 zoom，不随字号）；
 *  图标钮亮度 ≥ --fg-icon（=fg 85%,正文回复复制行同档），--fg-secondary/tertiary 不得直接作图标钮色。
 *  违反两例改回旧值即红：任何 `size={12}` 可点图标、`color: var(--fg-tertiary)` 图标钮。 */

const SRC = path.resolve(__dirname);


describe('CLAUDE.md §13.1 规则7:图标钮尺寸与亮度下限(源码扫描)', () => {
  const tsx: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(e.name) && !/\.test\./.test(e.name)) tsx.push(p);
    }
  };
  walk(SRC);

  it('可点元素内 lucide 图标 size ≥ 14(9px 豁免=状态点内装饰符号)', () => {
    const bad: string[] = [];
    for (const f of tsx.filter((f) => f.endsWith('.tsx'))) {
      const rel = path.relative(SRC, f).split(path.sep).join('/');
      const src = fs.readFileSync(f, 'utf8');
      const re = /<([A-Z][A-Za-z0-9]*)\s+size=\{(\d+(?:\.\d+)?)\}[^>]*>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const size = Number(m[2]);
        if (size >= 14) continue;
        const rel2 = `${rel}:${src.slice(0, m.index).split('\n').length}`;
        // 豁免:状态点内装饰性 ✓/→(非可点,9px 恰嵌 13px 圆)
        const before = src.slice(Math.max(0, m.index - 240), m.index);
        if (size === 9 && (before.includes('st === ') || before.includes('it.status'))) continue;
        bad.push(`${rel2} <${m[1]} size={${m[2]}}>`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('app.css 图标钮颜色不用 fg-secondary/tertiary(亮度 ≥ --fg-icon)', () => {
    const css = fs.readFileSync(path.join(SRC, 'app.css'), 'utf8');
    const mask = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    // 纯文字钮(「显示更多」/分段控件文字)不属图标钮,不入扫描面
    const ICONBTN = /iconbtn|sx-tip\b|winbtn|chev|-act\b|actions|-close\b|-remove\b|lightbox-act|tb-stop|chat-dyn-btn|tab-close|pin-btn|dev-x|dev-btn/;
    const bad: string[] = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(mask)) !== null) {
      const sel = m[1].split('\n').pop()!.trim();
      const ln = mask.slice(0, m.index).split('\n').length;
      if (!ICONBTN.test(sel) || sel.includes(':hover') || sel.includes('disabled') || sel.includes('knob')) continue;
      const c = m[2].match(/(?<![-\w])color:\s*var\(--fg-(secondary|tertiary)\)/);
      if (c) bad.push(`${ln} ${sel} → --fg-${c[1]}`);
    }
    expect(bad).toEqual([]);
  });
});
