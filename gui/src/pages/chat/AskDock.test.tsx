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
  it('多卡:显示 1/2,逐题提交只发当前 pid;切到第二题再答只发第二 pid', () => {
    const sendAsk = vi.fn();
    const setAskPicks = vi.fn();
    const cards = [card('p1', '第一问?'), card('p2', '第二问?')];
    const { rerender } = render(<AskDock askCards={cards} askPicks={{ p1: { labels: ['是'], custom: '' } }} setAskPicks={setAskPicks} sendAsk={sendAsk} />);
    expect(screen.getByText('第一问?')).toBeDefined();
    expect(screen.getByLabelText('ask position').textContent).toBe('1/2');
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

  it('跳过只 dismiss 当前题;单卡时不渲染分页头', () => {
    const sendAsk = vi.fn();
    const { container } = render(<AskDock askCards={[card('solo', '唯一问?')]} askPicks={{}} setAskPicks={vi.fn()} sendAsk={sendAsk} />);
    expect(container.querySelector('.sx-group-ask-head')).toBeNull(); // 单卡无 1/N 头
    fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    expect(sendAsk).toHaveBeenCalledWith('solo', { type: 'dismissed' });
  });
});
