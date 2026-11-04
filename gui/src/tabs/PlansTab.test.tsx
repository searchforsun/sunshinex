import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PlansTab } from './PlansTab';
import type { Connection } from '../connection';

/** 计划页签直测(2026-11-04 用户裁定「每个一行计划,有生成时间,点击打开指定文件」):
 *  行=计划名+生成时间;点击 onOpenFile(计划文件原文,与计划卡卡头链接同通路);
 *  空清单=空态文案;拉取失败=错误行内示出不静默。 */

describe('PlansTab(计划页签 2026-11-04)', () => {
  it('每行=计划名+生成时间,点击 → onOpenFile(计划文件绝对路径)', async () => {
    const conn = {
      sessionPlans: vi.fn(() =>
        Promise.resolve({
          plans: [
            { name: '重构认证模块', path: 'D:/d/sessions/j1.plan.md', mtime: Date.now() - 60_000 },
            { name: '', path: 'D:/d/sessions/j2.plan.md', mtime: 0 },
          ],
        }),
      ),
    } as unknown as Connection;
    const onOpenFile = vi.fn();
    render(<PlansTab conn={conn} sessionId="s1" onOpenFile={onOpenFile} />);
    await waitFor(() => expect(screen.getByText('重构认证模块')).toBeTruthy());
    // 空 name 行回落「未命名计划」文案(首行缺失=坏档兜底)
    expect(screen.getByText(/Untitled plan|未命名计划/)).toBeTruthy();
    fireEvent.click(screen.getByText('重构认证模块'));
    expect(onOpenFile).toHaveBeenCalledWith('D:/d/sessions/j1.plan.md');
    expect(conn.sessionPlans).toHaveBeenCalledWith('s1');
  });

  it('空清单=空态文案;拉取失败=错误行内示出不静默', async () => {
    const empty = { sessionPlans: vi.fn(() => Promise.resolve({ plans: [] })) } as unknown as Connection;
    render(<PlansTab conn={empty} sessionId="s1" onOpenFile={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/No plans yet|还没有计划/)).toBeTruthy());
    const boom = { sessionPlans: vi.fn(() => Promise.reject(new Error('plan list boom'))) } as unknown as Connection;
    render(<PlansTab conn={boom} sessionId="s1" onOpenFile={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('plan list boom')).toBeTruthy());
  });
});
