import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { ToolSegBlock } from './ToolGroups';
import { ToolEntryView } from './ToolEntry';
import type { ChatEntry } from '../../chat-reducer';
import type { Connection } from '../../connection';
import { applyConciseMode } from '../../concise-mode';

/** 简洁模式运行中常显最后一条折叠工具行(2026-11-19 用户裁定「折叠运行中也要常驻显示最后一个
 *  折叠工具行,不要一会显示一会不显示」):live 段把末条并入面工具行钉在折叠体外,折叠头暂隐 */

beforeEach(() => applyConciseMode(true)); // 简洁模式偏好落根(测试无 main 引导)

const conn = {} as Connection;
const none = (): null => null;
const tool = (key: string, name: string, input: Record<string, unknown>, text = 'ok'): ChatEntry =>
  ({ key, kind: 'tool', name, input, text } as unknown as ChatEntry);

function mount(seg: ChatEntry[], live: boolean | undefined): HTMLElement {
  const renderTool = (e: ChatEntry) => <ToolEntryView key={e.key} entry={e} conn={conn} sessionId="s" />;
  const r = render(<ToolSegBlock seg={seg} closed={false} live={live} renderTool={renderTool} renderThinking={none} renderAssistant={none} />);
  return r.container;
}

describe('简洁模式 live 段常显最后一条工具行', () => {
  it('live=true:末条工具行常显,折叠头隐藏;非运行态的其余行仍收在折叠体内', () => {
    const seg = [tool('a', 'read', { path: 'a.ts' }), tool('b', 'grep', { pattern: 'x' }), tool('c', 'read', { path: 'c.ts' })];
    const c = mount(seg, true);
    // 钉住行(折叠体外):末条 read 的路径在位
    const pinned = c.querySelector('.concise-live');
    expect(pinned).not.toBeNull();
    expect(pinned!.textContent).toContain('c.ts');
    // 折叠头在 live 期间隐藏(避免运行中忽隐忽现)
    expect(c.querySelector('.concise-fold')).toBeNull();
  });

  it('live 未给(非运行末段):恢复折叠头,无钉住行', () => {
    const seg = [tool('a', 'read', { path: 'a.ts' })];
    const c = mount(seg, undefined);
    expect(c.querySelector('.concise-live')).toBeNull();
    expect(c.querySelector('.concise-fold')).not.toBeNull();
  });
});
