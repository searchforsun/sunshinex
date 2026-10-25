import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { DiffLines } from '../diff-lines';

describe('DiffLines 语法高亮(2026-10-25 用户报障:编辑/写入 diff 无高亮)', () => {
  it('tsx 路径行级 hljs 令牌在场', () => {
    const { container } = render(
      <DiffLines newStr={'const origRaf = globalThis.requestAnimationFrame;\nlet scheduled = 0;\nreturn scheduled;'} path="gui/src/pages/Chat.test.tsx" />,
    );
    expect(container.querySelector('.hljs-keyword')).not.toBeNull();
  });
  it('未知扩展回落明文(不抛错)', () => {
    const { container } = render(<DiffLines newStr="plain content" path="x.unknownext" />);
    expect(container.textContent).toContain('plain content');
    expect(container.querySelector('.hljs-keyword')).toBeNull();
  });
});
