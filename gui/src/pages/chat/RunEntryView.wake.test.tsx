import { describe, expect, it, vi, beforeEach } from 'vitest';
// mermaid/monaco stub(images-flow.test 同款:jsdom 无渲染管线,EntryViews 经 ../Chat 拉重依赖)
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(() => Promise.resolve({ svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' })),
  },
}));
vi.mock('monaco-editor', () => ({
  editor: { defineTheme: vi.fn(), setTheme: vi.fn() },
}));
vi.mock('@monaco-editor/react', () => ({
  loader: { config: vi.fn() },
  Editor: () => <div className="mock-monaco-editor" />,
  DiffEditor: () => <div className="mock-monaco-diff" />,
}));
import { fireEvent, render } from '@testing-library/react';
import { RunEntryView } from './EntryViews';
import { setLanguage } from '../../i18n';

/** bg-wake 批F(spec §6):run 行唤醒前缀——只有任务名可点(bg:/板路由,stopPropagation 不触发折叠),
 *  「后台任务」「唤醒」恒静态,无名整行无点击元素;live/sealed 两态都拼前缀。
 *  语言约定:chat-reducer.test 同款 beforeEach 钉 en(防跨文件用例语言泄漏),断言走英文面。 */

beforeEach(() => setLanguage('en'));

const base = { seq: 3, ts: Date.now(), kind: 'run' as const, md: '', key: 'k3' };

describe('RunEntryView 唤醒前缀（bg-wake spec §6）', () => {
  it('有名：前缀「Woken by background task {构建前端} wake」+ 既有 sealed 文案；点任务名发 bg 路由且不触发折叠（鼠标+键盘）', () => {
    const onToggle = vi.fn();
    const onOpenTask = vi.fn();
    const { getByText } = render(
      <RunEntryView
        entry={{ ...base, seconds: 12 }}
        wake={[{ id: 'x1', name: '构建前端' }]}
        onToggle={onToggle}
        onOpenTask={onOpenTask}
      />,
    );
    expect(getByText(/Woken by background task/)).toBeTruthy(); // 「后台任务」段恒纯文本(正则匹配拼接行)
    const name = getByText('{构建前端}');
    fireEvent.click(name);
    expect(onOpenTask).toHaveBeenCalledWith('bg:x1'); // bg 路由
    expect(onToggle).not.toHaveBeenCalled(); // stopPropagation 不触发折叠
    fireEvent.keyDown(name, { key: 'Enter' }); // 键盘同道:不冒泡触发折叠
    expect(onOpenTask).toHaveBeenLastCalledWith('bg:x1');
    expect(onToggle).not.toHaveBeenCalled();
    expect(getByText(/Worked for/)).toBeTruthy(); // 既有 sealed 文案原样在场
  });

  it('板任务名点击走板路由', () => {
    const onOpenTask = vi.fn();
    const { getByText } = render(
      <RunEntryView entry={{ ...base, seconds: 3 }} wake={[{ id: 'l1', name: '修复登录', board: true, boardRef: 'task-t3' }]} onOpenTask={onOpenTask} />,
    );
    fireEvent.click(getByText('{修复登录}'));
    expect(onOpenTask).toHaveBeenCalledWith('task-t3');
  });

  it('无名：通用形态整行无点击元素；「后台任务」恒为纯文本', () => {
    const onOpenTask = vi.fn();
    const { getByText, queryByRole, container } = render(<RunEntryView entry={{ ...base, seconds: 5 }} wake={[{ id: 'x2' }]} onOpenTask={onOpenTask} />);
    expect(getByText(/Woken by background task/)).toBeTruthy();
    expect(queryByRole('button', { name: 'Woken by background task' })).toBeNull();
    expect(container.querySelector('.wake-name')).toBeNull(); // 无名=整行无点击元素
    fireEvent.click(getByText(/Woken by background task/));
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it('live 态：前缀 + 既有「运行中」拼接', () => {
    const { getByText } = render(<RunEntryView entry={{ ...base, streaming: true }} wake={[{ id: 'x1', name: '构建前端' }]} />);
    expect(getByText(/Woken by background task/)).toBeTruthy();
    expect(getByText('{构建前端}')).toBeTruthy();
    expect(getByText(/Working/)).toBeTruthy();
  });
});
