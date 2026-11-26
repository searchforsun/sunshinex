import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ToolSegBlock } from './ToolGroups';
import { ToolEntryView } from './ToolEntry';
import type { ChatEntry } from '../../chat-reducer';
import type { Connection } from '../../connection';
import { applyConciseMode } from '../../concise-mode';

/** 简洁模式折叠头恒在(2026-11-26 用户裁定「简洁模式下只显示最后一个(工具行),不显示
 *  『运行了命令,查看了文件』折叠行」):2026-11-19 的「运行末段钉末条原生工具行+头暂隐」退役——
 *  运行中末段也是折叠头一行(常驻不闪),点开看内层聚合;折叠轮末段(peekRunKey)在轮折叠态
 *  只露折叠头一行当本轮工作摘要,点击=展开整轮 */

beforeEach(() => applyConciseMode(true)); // 简洁模式偏好落根(测试无 main 引导)

const conn = {} as Connection;
const none = (): null => null;
const tool = (key: string, name: string, input: Record<string, unknown>, text = 'ok'): ChatEntry =>
  ({ key, kind: 'tool', name, input, text } as unknown as ChatEntry);

function mount(props: { seg: ChatEntry[]; closed: boolean; live?: boolean; liveRun?: boolean; peekRunKey?: string; onExpandRun?: (k: string) => void }): HTMLElement {
  const renderTool = (e: ChatEntry) => <ToolEntryView key={e.key} entry={e} conn={conn} sessionId="s" />;
  const r = render(
    <ToolSegBlock
      seg={props.seg}
      closed={props.closed}
      live={props.live}
      liveRun={props.liveRun}
      peekRunKey={props.peekRunKey}
      onExpandRun={props.onExpandRun}
      renderTool={renderTool}
      renderThinking={none}
      renderAssistant={none}
    />,
  );
  return r.container;
}

describe('简洁模式折叠头恒在', () => {
  it('运行中(在途轮)展开:折叠体默认打开=段内工具行全可见,点折叠头可逐段收起', () => {
    const seg = [tool('a', 'read', { path: 'a.ts' }), tool('b', 'grep', { pattern: 'x' }), tool('c', 'read', { path: 'c.ts' })];
    const c = mount({ seg, closed: false, liveRun: true });
    expect(c.querySelector('.concise-fold')).not.toBeNull();
    expect(c.querySelector('.concise-body')!.className).toContain('open'); // 运行中=全行可见
    expect(c.querySelectorAll('.entry-tool').length).toBe(3);
    fireEvent.click(c.querySelector('.concise-fold') as HTMLButtonElement);
    expect(c.querySelector('.concise-body')!.className).not.toContain('open'); // 用户手点=收起
  });
  it('运行末段(未折叠):折叠头在位且 body 收着,末条工具行仍钉在折叠体之外', () => {
    const seg = [tool('a', 'read', { path: 'a.ts' }), tool('b', 'grep', { pattern: 'x' }), tool('c', 'read', { path: 'c.ts' })];
    const c = mount({ seg, closed: false, live: true });
    const head = c.querySelector('.concise-fold');
    expect(head).not.toBeNull();
    expect(head!.textContent).toContain('Read files'); // 摘要折叠行常驻(不再因运行中消失)
    expect(c.querySelector('.concise-body')!.className).not.toContain('open');
    expect(c.querySelector('.concise-live')!.textContent).toContain('c.ts'); // 运行进度行仍钉在外面
  });

  it('点折叠头展开内层聚合行', () => {
    const seg = [tool('a', 'read', { path: 'a.ts' }), tool('b', 'read', { path: 'b.ts' })];
    const c = mount({ seg, closed: false });
    const head = c.querySelector('.concise-fold') as HTMLButtonElement;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(head);
    expect(c.querySelector('.concise-fold')!.getAttribute('aria-expanded')).toBe('true');
    expect(c.querySelector('.concise-body')!.className).toContain('open');
  });

  it('折叠轮末段(peekRunKey+closed):只露折叠头一行,点击=展开整轮', () => {
    let expanded: string | undefined;
    const seg = [tool('a', 'exec', { command: 'kubectl get pods' }), tool('b', 'read', { path: 'a.ts' })];
    const c = mount({ seg, closed: true, peekRunKey: 'r1', onExpandRun: (k) => { expanded = k; } });
    expect(c.querySelector('.concise-fold')).not.toBeNull();
    expect(c.querySelector('.entry-tool')).toBeNull(); // 段内行全隐(只渲头行,无折叠体)
    expect(c.querySelector('.concise-body')).toBeNull();
    fireEvent.click(c.querySelector('.concise-fold') as HTMLButtonElement);
    expect(expanded).toBe('r1');
  });

  it('peekRunKey 缺省(非折叠轮):折叠段整段仍随轮折叠不可见', () => {
    const seg = [tool('a', 'exec', { command: 'ls' })];
    const c = mount({ seg, closed: true });
    expect(c.querySelector('.seg-collapse')!.className).not.toContain('open');
    expect(c.querySelector('.concise-fold')).not.toBeNull(); // 头在折叠壳内(不可见),与既有语义一致
  });
});
