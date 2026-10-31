import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AskCard } from './PendingCards';
import type { AskPick } from './PendingCards';
import type { GuiAskReq } from '../../connection';

// 问询单题卡(2026-10-30 用户裁定「单选时点最下面手动输入:输入变蓝色选中框,去掉上面的选中」):
// 单选互斥双向——focus 输入框清 labels+输入卡 active 蓝框;点选项清 custom。多选不受影响(共存语义)
describe('AskCard 单选互斥', () => {
  const req: GuiAskReq = { question: '做什么?', options: [{ label: '看结构' }, { label: '写代码' }] };

  function mount(pick: AskPick, onPick: (patch: Partial<AskPick>) => void, multiple?: boolean): void {
    render(<AskCard req={{ ...req, multiple }} pick={pick} onPick={onPick} />);
  }

  it('单选:focus 输入框 → 清上方选中(onPick labels:[])+输入卡 active 选中蓝框', () => {
    const onPick = vi.fn();
    mount({ labels: ['写代码'], custom: '' }, onPick);
    const input = screen.getByLabelText('custom answer');
    fireEvent.focus(input);
    expect(onPick).toHaveBeenCalledWith({ labels: [] });
    expect(input.closest('.card-custom-card')!.className).toContain(' active');
    cleanup(); // 同用例二次挂载先卸载(getBy* 防多命中)
    // 多选:focus 只置焦点态,不清勾选(active 也不挂)
    const onPick2 = vi.fn();
    mount({ labels: ['看结构'], custom: '' }, onPick2, true);
    const input2 = screen.getByLabelText('custom answer');
    fireEvent.focus(input2);
    expect(onPick2).not.toHaveBeenCalled();
    expect(input2.closest('.card-custom-card')!.className).not.toContain(' active');
  });

  it('单选镜像:点选项 → 清自由输入(custom:""),防「已选+有字」并存而提交优先发 custom;多选保留 custom', () => {
    const onPick = vi.fn();
    mount({ labels: [], custom: '快速排序' }, onPick);
    fireEvent.click(screen.getByText('看结构'));
    expect(onPick).toHaveBeenCalledWith({ labels: ['看结构'], custom: '' });
    cleanup();
    const onPick2 = vi.fn();
    mount({ labels: [], custom: '快速排序' }, onPick2, true);
    fireEvent.click(screen.getByText('看结构'));
    expect(onPick2).toHaveBeenCalledWith({ labels: ['看结构'] });
  });
});
