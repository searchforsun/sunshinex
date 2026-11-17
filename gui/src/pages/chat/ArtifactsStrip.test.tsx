import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ArtifactsStrip } from './ArtifactsStrip';
import { applyArtifactCards } from '../../artifact-cards';
import { setLanguage } from '../../i18n';
import type { Artifact } from '../../artifacts';

const conn = {} as never;

function arts(n: number): Artifact[] {
  return Array.from({ length: n }, (_, i) => ({ kind: 'file' as const, path: `f${i}.md`, source: 'write' as const }));
}

/** 折叠阈值 4 + 设置页开关(2026-11-16 用户裁定「产物默认显示 4 个,显示更多」「设置页可以控制
 *  产物显隐开关」) */

describe('ArtifactsStrip 折叠与显隐', () => {
  beforeEach(() => {
    localStorage.clear();
    setLanguage('en');
    applyArtifactCards(true);
  });

  it('默认首屏 4 张;6 张时出「Show more」,点开全显并转「Collapse」', () => {
    render(<ArtifactsStrip artifacts={arts(6)} conn={conn} />);
    expect(document.querySelectorAll('.sx-artifacts-card')).toHaveLength(4);
    const more = screen.getByText('Show more');
    fireEvent.click(more);
    expect(document.querySelectorAll('.sx-artifacts-card')).toHaveLength(6);
    expect(screen.getByText('Collapse')).toBeDefined();
  });

  it('不足 5 张不折叠(无 Show more)', () => {
    render(<ArtifactsStrip artifacts={arts(4)} conn={conn} />);
    expect(document.querySelectorAll('.sx-artifacts-card')).toHaveLength(4);
    expect(screen.queryByText('Show more')).toBeNull();
  });

  it('设置页关掉产物卡→卡区整块不渲染', () => {
    applyArtifactCards(false);
    const { container } = render(<ArtifactsStrip artifacts={arts(3)} conn={conn} />);
    expect(container.querySelector('.sx-artifacts')).toBeNull();
    applyArtifactCards(true);
  });
});
