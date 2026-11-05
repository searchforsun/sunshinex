import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GlobalRulesPane } from '../GlobalRulesPane';
import type { GlobalRulesPaneConn } from '../GlobalRulesPane';

/**
 * 全局规范面板桩测(2026-11-05,编码分组「全局规范」——形态对标 raw 面):mount/tick 自动回显、
 * 保存 PUT+toast、读/存失败 home-error 行、Reload 重读。en 语言钉(test-setup)。
 */

const connOf = (opts: { content?: string; getReject?: Error; putReject?: Error } = {}): {
  conn: GlobalRulesPaneConn;
  getCalls: number;
  putCalls: string[];
} => {
  const getCalls = { n: 0 };
  const putCalls: string[] = [];
  return {
    conn: {
      sunshineGet() {
        getCalls.n += 1;
        if (opts.getReject !== undefined) return Promise.reject(opts.getReject);
        return Promise.resolve({ content: opts.content ?? '', path: '/h/.sunshinex/SUNSHINE.md', exists: opts.content !== undefined });
      },
      sunshinePut(content: string) {
        putCalls.push(content);
        if (opts.putReject !== undefined) return Promise.reject(opts.putReject);
        return Promise.resolve();
      },
    },
    get getCalls(): number {
      return getCalls.n;
    },
    putCalls,
  };
};

describe('GlobalRulesPane(全局规范,编码分组)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('mount 自动回显原文;Reload 重读(计数+1)', async () => {
    const h = connOf({ content: 'rule one\n' });
    render(<GlobalRulesPane conn={h.conn} />);
    const ta = (await screen.findByLabelText('global rules editor')) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe('rule one\n'));
    expect(h.getCalls).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(h.getCalls).toBe(2));
  });

  it('保存:PUT 收到编辑文本 + toast「新建会话起」;保存中禁用', async () => {
    const h = connOf({ content: 'rule one\n' });
    render(<GlobalRulesPane conn={h.conn} />);
    const ta = (await screen.findByLabelText('global rules editor')) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe('rule one\n'));
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    fireEvent.change(ta, { target: { value: 'rule one\nrule two\n' } });
    fireEvent.click(save);
    expect(save.disabled).toBe(true); // 保存中禁用
    await waitFor(() => expect(h.putCalls).toEqual(['rule one\nrule two\n']));
    expect(screen.getByRole('status').textContent).toContain('applies to new sessions'); // toast 3s 自隐(定时器面,此处只钉出现)
  });

  it('读面失败 → home-error 行;写面失败 → 同面示错,编辑内容不丢', async () => {
    const h = connOf({ content: 'origin\n', putReject: new Error('409: bad state') });
    render(<GlobalRulesPane conn={h.conn} />);
    const ta = (await screen.findByLabelText('global rules editor')) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe('origin\n'));
    fireEvent.change(ta, { target: { value: 'dirty\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('409: bad state');
    expect(ta.value).toBe('dirty\n'); // 内容不丢
    fireEvent.click(screen.getByRole('button', { name: 'Reload' })); // 重新读取回磁盘原文
    await waitFor(() => expect(ta.value).toBe('origin\n'));
  });

  it('读面挂 → 错误行,保存禁用(loaded 门)', async () => {
    const h = connOf({ getReject: new Error('network down') });
    render(<GlobalRulesPane conn={h.conn} />);
    await screen.findByText('network down');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refreshTick 变化重读(config-changed sunshine 键:外部/他窗改动信号)', async () => {
    const h = connOf({ content: 'v1' });
    const { rerender } = render(<GlobalRulesPane conn={h.conn} refreshTick={0} />);
    await waitFor(() => expect(h.getCalls).toBe(1)); // 挂载首读
    rerender(<GlobalRulesPane conn={h.conn} refreshTick={1} />);
    await waitFor(() => expect(h.getCalls).toBe(2)); // tick 变化即重读
  });
});
