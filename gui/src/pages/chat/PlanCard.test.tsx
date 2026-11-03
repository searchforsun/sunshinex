import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PlanCard } from './PlanCard';
import type { PlanCardDecision } from './PlanCard';

/** PlanCard 组件直测(2026-11-03 修订重排锚):计划书 markdown 渲染;三按钮=实施·工作区编辑(缺省档)/
 *  实施·完全访问/驳回——前两者回执 {approved:true, mode}（full-access 必须显式选择）,驳回取常驻
 *  反馈框文本（带文本=修订环回执,空文本=放弃本轮不带 feedback）;Enter 快捷驳回（Shift+Enter 换行
 *  不提交,与 composer 键位同构）。判别力:决策体缺 mode 或反馈面语义漂移即红。 */

describe('PlanCard(计划确认卡 2026-11-03 重排:滚动文档+常驻反馈+三按钮)', () => {
  it('计划书 markdown 渲染;实施两按钮分别回执 approve+mode 两档;items 不再独立渲染 ol', () => {
    const decisions: PlanCardDecision[] = [];
    render(<PlanCard doc={'# 计划\n1. A\n2. B'} items={['A', 'B']} onDecide={(d) => decisions.push(d)} />);
    expect(screen.getByRole('heading', { level: 1, name: '计划' })).toBeTruthy();
    // Steps 随 doc 全文在滚动区（md 有序列表渲染 2 行）;旧独立只读 <ol> 已退役——总 listitem 数=md 渲染数,无重复
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['A', 'B']);
    fireEvent.click(screen.getByText(/Implement \(workspace edits\)|实施（工作区编辑）/));
    expect(decisions[0]).toEqual({ approved: true, mode: 'acceptEdits' });
    fireEvent.click(screen.getByText(/Implement \(full access\)|实施（完全访问）/));
    expect(decisions[1]).toEqual({ approved: true, mode: 'full-access' });
    expect(decisions).toHaveLength(2); // 驳回按钮未被误触(三按钮独立)
  });

  it('常驻反馈框:带文本驳回=修订环回执;空文本驳回=放弃本轮(不带 feedback);Enter 快捷驳回,Shift+Enter 换行', () => {
    const decisions: PlanCardDecision[] = [];
    render(<PlanCard doc="plan" items={['X']} onDecide={(d) => decisions.push(d)} />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '第二步拆细' } });
    fireEvent.click(screen.getByText(/Reject|驳回/));
    expect(decisions[0]).toEqual({ approved: false, feedback: '第二步拆细' });
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.click(screen.getByText(/Reject|驳回/));
    expect(decisions[1]).toEqual({ approved: false }); // 空文本驳回不带 feedback 字段(=放弃本轮,armed 保持)
    fireEvent.change(box, { target: { value: '再改' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(decisions[2]).toEqual({ approved: false, feedback: '再改' }); // Enter 快捷驳回
    expect(decisions).toHaveLength(3); // Enter 已提交,不再触发点击路径
    fireEvent.change(box, { target: { value: '换行不提交' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(decisions).toHaveLength(3); // Shift+Enter 换行不提交
  });

  it('计划名卡头链接（2026-11-03 交稿协议）:path+onOpenFile 在场=蓝色链接点击开侧栏原文;缺席降级纯文本', () => {
    const onOpenFile = vi.fn();
    const decisions: PlanCardDecision[] = [];
    const { unmount } = render(
      <PlanCard doc={'# 计划\n1. A'} items={['A']} name="重构认证模块" path="D:/data/sessions/j1.plan.md" onOpenFile={onOpenFile} onDecide={(d) => decisions.push(d)} />,
    );
    expect(screen.getByText('重构认证模块')).toBeTruthy(); // 卡头计划名
    fireEvent.click(screen.getByText('重构认证模块'));
    expect(onOpenFile).toHaveBeenCalledWith('D:/data/sessions/j1.plan.md');
    expect(decisions).toHaveLength(0); // 纯链接不触发裁决
    unmount();
    // 无 path:降级纯文本,无 onOpenFile 回调
    render(<PlanCard doc="plan" items={[]} name="旧会话计划" onDecide={() => undefined} />);
    expect(screen.getByText('旧会话计划').className).not.toContain('tool-file-link');
    fireEvent.click(screen.getByText('旧会话计划'));
    expect(onOpenFile).toHaveBeenCalledTimes(1); // 降级面零回调
  });
});
