import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PlanCard } from './PlanCard';

/** PlanCard 组件直测(task 10 brief Step 1 两路径锚):批准按钮即回执 {approved:true};
 *  拒绝展开反馈输入框,提交回执 {approved:false, feedback}。判别力:无卡片实现/回执通道
 *  形态不符(decision 体缺 approved 或 feedback)即红。 */

describe('PlanCard(计划确认卡:批准/反馈两路径,spec §5.2)', () => {
  it('批准按钮回执 approved;反馈输入+提交回执 approved=false+feedback', () => {
    const decisions: Array<{ approved: boolean; feedback?: string }> = [];
    render(<PlanCard doc="# 计划" items={['A', 'B']} onDecide={(d) => decisions.push(d)} />);
    // 计划书 markdown 渲染(沿 GUI 既有 markdown 通道)与步骤清单只读两行
    expect(screen.getByRole('heading', { level: 1, name: '计划' })).toBeTruthy();
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['A', 'B']);
    // —— 路径一:批准 ——
    fireEvent.click(screen.getByText(/Approve|批准/));
    expect(decisions).toEqual([{ approved: true }]);
    // —— 路径二:拒绝展开反馈输入,提交回执 approved=false+feedback ——
    fireEvent.click(screen.getByText(/Reject|拒绝/));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '第二步拆细' } });
    fireEvent.click(screen.getByText(/Send|提交/));
    expect(decisions[1]).toEqual({ approved: false, feedback: '第二步拆细' });
  });

  it('拒绝空反馈提交:回执 approved=false 且不带 feedback 字段(PlanDecision feedback 可选面)', () => {
    const decisions: Array<{ approved: boolean; feedback?: string }> = [];
    render(<PlanCard doc="plan" items={[]} onDecide={(d) => decisions.push(d)} />);
    fireEvent.click(screen.getByText(/Reject|拒绝/));
    fireEvent.click(screen.getByText(/Send|提交/));
    expect(decisions).toEqual([{ approved: false }]);
  });
});
