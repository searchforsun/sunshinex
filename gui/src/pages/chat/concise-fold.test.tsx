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

function mount(props: { seg: ChatEntry[]; closed: boolean; live?: boolean; runFolded?: boolean }): HTMLElement {
  const renderTool = (e: ChatEntry) => <ToolEntryView key={e.key} entry={e} conn={conn} sessionId="s" />;
  const r = render(
    <ToolSegBlock
      seg={props.seg}
      closed={props.closed}
      live={props.live}
      runFolded={props.runFolded}
      renderTool={renderTool}
      renderThinking={none}
      renderAssistant={none}
    />,
  );
  return r.container;
}

describe('简洁模式折叠头恒在', () => {
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

  it('运行中折叠(runFolded):不加折叠层,末条工具行按本来样子显示(不套汇总头)', () => {
    const seg = [tool('a', 'exec', { command: 'kubectl get pods' })];
    const c = mount({ seg, closed: false, live: true, runFolded: true });
    expect(c.querySelector('.concise-fold')).toBeNull(); // 不强行变折叠行
    expect(c.querySelector('.concise-body')).toBeNull();
    expect(c.querySelector('.entry-tool')).not.toBeNull(); // 直接是工具行本行
  });

  it('封口轮折叠(closed,非在途):整段随轮折叠不可见,不露折叠行/工具行', () => {
    const seg = [tool('a', 'exec', { command: 'ls' })];
    const c = mount({ seg, closed: true });
    expect(c.querySelector('.seg-collapse')!.className).not.toContain('open');
    expect(c.querySelector('.seg-collapse.open')).toBeNull();
  });
});
