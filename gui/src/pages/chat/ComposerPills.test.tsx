import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Connection } from '../../connection';
import { ComposerPillsRight } from './ComposerPills';

/** ComposerPills 首个直测(L-1:db5bf3e②「模型 current 按 baseModelName 显示名比对」此前零测试
 *  锚——daemon /model 回模型名而 choices id 带 provider 前缀,旧严格相等比对恒 false,当前项
 *  ✓/强调色永不亮)。判别力:换回「c.id === current」旧实现,带前缀 id 用例即红。 */

const CONN = {
  setSessionModel: vi.fn().mockResolvedValue(undefined),
  setSessionEffort: vi.fn().mockResolvedValue(undefined),
} as unknown as Connection;

function mountModelPill(current: string | undefined): void {
  render(
    <ComposerPillsRight
      pillOpen="model"
      setPillOpen={() => {}}
      conn={CONN}
      sessionId="s1"
      ctxInfo={null}
      refreshCtx={() => {}}
      runCount={0}
      steps={0}
      tokens={0}
      cacheTokens={0}
      modelInfo={{
        current,
        explicitDefault: false,
        choices: [
          { id: 'provider-a/glm-5.3-flash', model: 'glm-5.3-flash', baseUrl: 'https://a/v1' },
          { id: 'provider-b/model-x', model: 'model-x', baseUrl: 'https://b/v1' },
        ],
      }}
      setModelInfo={() => {}}
      sessEffort="medium"
      setSessEffort={() => {}}
      running={false}
      input=""
      send={() => {}}
      interrupt={() => {}}
      connState="open"
      seeding={false}
    />,
  );
}

describe('ComposerPillsRight(模型 pill 菜单 current 判定,L-1 锚)', () => {
  it('current=裸模型名而 choice id 带 provider 前缀:仍按显示名命中 current 类(旧严格相等恒 false)', () => {
    mountModelPill('glm-5.3-flash');
    const hit = screen.getByRole('menuitem', { name: 'glm-5.3-flash' });
    const miss = screen.getByRole('menuitem', { name: 'model-x' });
    expect(hit.className).toContain('current');
    expect(miss.className).not.toContain('current');
  });

  it('current=完整带前缀 id(与 choice id 全等):同款命中,不禁用(2026-10-24 裁定:disabled 灰盖强调色,重选同模型无副作用)', () => {
    mountModelPill('provider-a/glm-5.3-flash');
    expect(screen.getByRole('menuitem', { name: 'glm-5.3-flash' }).className).toContain('current');
    expect(screen.getByRole('menuitem', { name: 'glm-5.3-flash' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('menuitem', { name: 'model-x' }).className).not.toContain('current');
  });
});
