// ask 挂起 dock 单卡分页（2026-11-28 十一轮「第二个或者多个的 ask_question 没有关掉」）：
// 逐题提交/跳过只作用于当前条,‹ 1/N › 可切换;多卡不再要求全部答完才能提交。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AskDock } from './AskDock';
import { setLanguage } from '../../i18n';

setLanguage('zh');

const card = (pid: string, question: string): { pid: string; req: { question: string; options: Array<{ label: string }> } } => ({
  pid,
  req: { question, options: [{ label: '是' }, { label: '否' }] },
});

describe('AskDock 单卡分页', () => {
  it('多卡:分页在问题行上侧独立一行(左来源/右 1/N),逐题提交只发当前 pid', () => {
    const sendAsk = vi.fn();
    const setAskPicks = vi.fn();
    const cards = [card('p1', '第一问?'), card('p2', '第二问?')];
    const { rerender } = render(<AskDock askCards={cards} askPicks={{ p1: { labels: ['是'], custom: '' } }} setAskPicks={setAskPicks} sendAsk={sendAsk} />);
    expect(screen.getByText('第一问?')).toBeDefined();
    expect(screen.getByLabelText('ask position').textContent).toBe('1/2');
    // 2026-11-28 十二轮：分页在问题行上侧独立一行（.ask-top-line 右端），不占问题行
    const top = document.querySelector('.ask-top-line')!;
    expect(top).not.toBeNull();
    expect(top.querySelector('.sx-group-ask-pager')?.textContent).toContain('1/2');
    expect(document.querySelector('.card-head .sx-group-ask-pager')).toBeNull();
    // 当前题已答 → 可直接提交,不被第二题未答卡住
    const submit = screen.getByRole('button', { name: '提交' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(sendAsk).toHaveBeenCalledWith('p1', { type: 'selected', labels: ['是'] });
    // 切到第二题
    fireEvent.click(screen.getByRole('button', { name: 'next ask' }));
    expect(screen.getByText('第二问?')).toBeDefined();
    expect(screen.getByLabelText('ask position').textContent).toBe('2/2');
    // 第二题未答 → 提交禁用;答后启用
    expect((screen.getByRole('button', { name: '提交' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<AskDock askCards={cards} askPicks={{ p2: { labels: ['否'], custom: '' } }} setAskPicks={setAskPicks} sendAsk={sendAsk} />);
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(sendAsk).toHaveBeenLastCalledWith('p2', { type: 'selected', labels: ['否'] });
  });

  it('跳过只 dismiss 当前题;单卡不渲染分页', () => {
    const sendAsk = vi.fn();
    const { container } = render(<AskDock askCards={[card('solo', '唯一问?')]} askPicks={{}} setAskPicks={vi.fn()} sendAsk={sendAsk} />);
    expect(container.querySelector('.sx-group-ask-pager')).toBeNull(); // 单卡无 1/N
    fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    expect(sendAsk).toHaveBeenCalledWith('solo', { type: 'dismissed' });
  });

  it('来源行上移：多题来自子智能体时顶带「来自 图标 名称」+右侧分页同集合（混合逐题各归其位）', () => {
    const asked = (pid: string, question: string, label: string): { pid: string; req: { question: string; options: Array<{ label: string }>; askedBy: { label: string } } } => ({
      pid,
      req: { question, options: [{ label: '是' }], askedBy: { label } },
    });
    const cards = [asked('a1', '子代理问?', 'planner'), card('a2', '本地问?')];
    const { container } = render(<AskDock askCards={cards} askPicks={{}} setAskPicks={vi.fn()} sendAsk={vi.fn()} onOpenAgent={vi.fn()} />);
    // 第一题有来源行：位于问题行之上,右侧分页;卡内旧来源行隐藏
    const src = container.querySelector('.ask-top-line')!;
    expect(src).not.toBeNull();
    expect(src.textContent).toContain('来自');
    expect(src.textContent).toContain('planner');
    expect(src.querySelector('svg')).not.toBeNull();
    expect(src.querySelector('.sx-group-ask-pager')?.textContent).toContain('1/2');
    expect(container.querySelector('.ask-card-source')).toBeNull();
    // 来源名称可点跳转录
    fireEvent.click(screen.getByRole('button', { name: 'planner' }));
    expect((screen.getByRole('button', { name: 'planner' }) as HTMLElement)).toBeDefined();
  });
});
