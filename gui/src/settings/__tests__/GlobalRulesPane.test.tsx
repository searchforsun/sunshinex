import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GlobalRulesPane } from '../GlobalRulesPane';
import type { GlobalRulesPaneConn } from '../GlobalRulesPane';

/**
 * 全局规范面板桩测(2026-11-05,编码分组「全局规范」):GET 装载原文+路径、编辑脏检查(未改禁存/
 * 有改可存)、保存调 PUT 并推进基线、refreshTick 变化重拉、读面失败错误条。en 语言钉(test-setup)。
 */

const connOf = (opts: { content?: string; path?: string; exists?: boolean; putReject?: Error } = {}): {
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
        return Promise.resolve({ content: opts.content ?? '', path: opts.path ?? '/home/.sunshinex/SUNSHINE.md', exists: opts.exists ?? false });
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
  it('装载原文+路径;缺失档显示建档提示', async () => {
    const h = connOf({ content: '', path: '/h/.sunshinex/SUNSHINE.md', exists: false });
    render(<GlobalRulesPane conn={h.conn} />);
    const ta = (await screen.findByLabelText('global rules editor')) as HTMLTextAreaElement;
    expect(ta.value).toBe('');
    expect(await screen.findByText(/not created yet/)).toBeTruthy();
    expect(screen.getByText('/h/.sunshinex/SUNSHINE.md')).toBeTruthy();
  });

  it('脏检查:未改动保存钮禁用;编辑后可存,PUT 收到编辑文本且基线推进(钮复禁)', async () => {
    const h = connOf({ content: 'rule one\n' });
    render(<GlobalRulesPane conn={h.conn} />);
    const ta = (await screen.findByLabelText('global rules editor')) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe('rule one\n')); // 装载落位(displayValue 匹配器对尾随换行不稳,用值断言)
    const save = screen.getByRole('button', { name: 'Save' });
    expect((save as HTMLButtonElement).disabled).toBe(true); // 未改动禁存
    fireEvent.change(ta, { target: { value: 'rule one\nrule two\n' } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(h.putCalls).toEqual(['rule one\nrule two\n']));
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true); // 基线推进
  });

  it('PUT 失败 → 错误条+编辑内容不丢;还原钮回磁盘原文', async () => {
    const h = connOf({ content: 'origin\n', putReject: new Error('409: bad state') });
    render(<GlobalRulesPane conn={h.conn} />);
    const ta = (await screen.findByLabelText('global rules editor')) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toBe('origin\n')); // 装载落位
    fireEvent.change(ta, { target: { value: 'dirty\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('409: bad state'); // 错误条
    expect((screen.getByLabelText('global rules editor') as HTMLTextAreaElement).value).toBe('dirty\n'); // 内容不丢
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect((screen.getByLabelText('global rules editor') as HTMLTextAreaElement).value).toBe('origin\n'));
  });

  it('refreshTick 变化重拉(config-changed sunshine 键:外部/他窗改动信号)', async () => {
    const h = connOf({ content: 'v1' });
    const { rerender } = render(<GlobalRulesPane conn={h.conn} refreshTick={0} />);
    await waitFor(() => expect(h.getCalls).toBe(1)); // 挂载首拉
    rerender(<GlobalRulesPane conn={h.conn} refreshTick={1} />);
    await waitFor(() => expect(h.getCalls).toBe(2)); // tick 变化即重拉
  });

  it('读面失败 → 错误条,编辑器空串可用', async () => {
    const conn: GlobalRulesPaneConn = {
      sunshineGet: vi.fn(() => Promise.reject(new Error('network down'))),
      sunshinePut: vi.fn(() => Promise.resolve()),
    };
    render(<GlobalRulesPane conn={conn} />);
    await screen.findByText('network down');
    expect((screen.getByLabelText('global rules editor') as HTMLTextAreaElement).value).toBe('');
  });
});
