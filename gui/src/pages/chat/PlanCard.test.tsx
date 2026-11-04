import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PlanCard } from './PlanCard';
import type { PlanCardDecision } from './PlanCard';

/** PlanCard 组件直测(2026-11-03 修订重排锚;2026-11-04 泛化+按钮排布锚):计划书 markdown 渲染;
 *  按钮排布=取消|重新计划|实施,集随当前档——只读域(缺省)实施双键=工作区编辑(缺省档)+完全访问
 *  (warn),可写域实施单键=plain 实施(回执=当前档)。重新计划必须反馈框有内容(空=禁用),取消=放弃
 *  本轮(decision 不带 feedback,与框内文本无关);Enter 快捷重新计划(Shift+Enter 换行不提交)。
 *  判别力:决策体缺 mode 或反馈面/按钮域语义漂移即红。 */

describe('PlanCard(计划确认卡 2026-11-03 重排;2026-11-04 按钮排布 取消|重新计划|实施)', () => {
  it('计划书 markdown 渲染;只读域四钮=取消|重新计划|实施两档(2026-11-04 排布);items 不再独立渲染 ol', () => {
    const decisions: PlanCardDecision[] = [];
    render(<PlanCard doc={'# 计划\n1. A\n2. B'} items={['A', 'B']} onDecide={(d) => decisions.push(d)} />);
    expect(screen.getByRole('heading', { level: 1, name: '计划' })).toBeTruthy();
    // Steps 随 doc 全文在滚动区（md 有序列表渲染 2 行）;旧独立只读 <ol> 已退役——总 listitem 数=md 渲染数,无重复
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['A', 'B']);
    expect(screen.getByText(/Cancel|取消/)).toBeTruthy(); // 取消钮在场(放弃本轮单义承载)
    fireEvent.click(screen.getByText(/Implement \(workspace edits\)|实施（工作区编辑）/));
    expect(decisions[0]).toEqual({ approved: true, mode: 'acceptEdits' });
    fireEvent.click(screen.getByText(/Implement \(full access\)|实施（完全访问）/));
    expect(decisions[1]).toEqual({ approved: true, mode: 'full-access' });
    expect(decisions).toHaveLength(2); // 取消/重新计划未被误触(四钮独立)
  });

  it('重新计划必须带反馈(2026-11-04:空反馈禁用,放弃语义归取消钮);Enter 快捷重新计划,Shift+Enter 换行', () => {
    const decisions: PlanCardDecision[] = [];
    render(<PlanCard doc="plan" items={['X']} onDecide={(d) => decisions.push(d)} />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    const rePlanBtn = screen.getByText(/Re-plan|重新计划/).closest('button') as HTMLButtonElement;
    expect(rePlanBtn.disabled).toBe(true); // 空反馈=重新计划禁用(放弃走取消钮,不再兼义)
    fireEvent.click(rePlanBtn);
    expect(decisions).toHaveLength(0); // 禁用态点击零决策
    fireEvent.change(box, { target: { value: '第二步拆细' } });
    expect(rePlanBtn.disabled).toBe(false); // 有反馈即启用
    fireEvent.click(rePlanBtn);
    expect(decisions[0]).toEqual({ approved: false, feedback: '第二步拆细' });
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(decisions).toHaveLength(1); // 空白文本 Enter 无操作(2026-11-03:误按 Enter 不得立即放弃本轮)
    fireEvent.change(box, { target: { value: '再改' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(decisions[1]).toEqual({ approved: false, feedback: '再改' }); // Enter 快捷重新计划
    expect(decisions).toHaveLength(2); // Enter 已提交,不再触发点击路径
    fireEvent.change(box, { target: { value: '换行不提交' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(decisions).toHaveLength(2); // Shift+Enter 换行不提交
  });

  it('取消钮=放弃本轮(decision 不带 feedback,与反馈框内容无关;2026-11-04 用户裁定)', () => {
    const decisions: PlanCardDecision[] = [];
    render(<PlanCard doc="plan" items={['X']} onDecide={(d) => decisions.push(d)} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '写了些反馈' } });
    fireEvent.click(screen.getByText(/Cancel|取消/));
    expect(decisions[0]).toEqual({ approved: false }); // 取消恒不带 feedback(空放弃),不受框内文本影响
    expect(decisions).toHaveLength(1);
  });

  it('按钮集随当前档自适应(2026-11-04 泛化):可写域三钮=取消|重新计划|实施(plain,回执=当前档)', () => {
    const decisions: PlanCardDecision[] = [];
    const { unmount } = render(<PlanCard doc="plan" items={['A']} mode="full-access" onDecide={(d) => decisions.push(d)} />);
    expect(screen.getByText(/^Implement$|实施/)).toBeTruthy(); // plain 实施(不带档名后缀)
    expect(screen.queryByText(/Implement \(workspace edits\)|实施（工作区编辑）/)).toBeNull();
    expect(screen.queryByText(/Implement \(full access\)|实施（完全访问）/)).toBeNull();
    fireEvent.click(screen.getByText(/^Implement$|实施/));
    expect(decisions[0]).toEqual({ approved: true, mode: 'full-access' }); // 批准=维持当前档,无落档切换
    unmount();
    render(<PlanCard doc="plan" items={['A']} mode="acceptEdits" onDecide={(d) => decisions.push(d)} />);
    fireEvent.click(screen.getByText(/^Implement$|实施/));
    expect(decisions[1]).toEqual({ approved: true, mode: 'acceptEdits' });
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
