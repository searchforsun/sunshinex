import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { BoardList, BOARD_PAGE_ROWS } from './BoardList';
import { boardRows } from './use-board-keys';
import type { TuiState } from '../session';
import { emptyBoard, applyBoardEvent } from '../../taskboard/model';

test('boardRows：TuiState.board 派生单点——id 数值序（t2 < t10）、label 组装箭头/assignee、gated 透传', () => {
  let board = emptyBoard();
  board = applyBoardEvent(board, { t: 'task-created', taskId: 't10', title: 'T10', spec: 'x', dependsOn: [], ts: 1 });
  board = applyBoardEvent(board, { t: 'task-created', taskId: 't2', title: 'B', spec: 'x', dependsOn: ['t10'], ts: 2 });
  board = applyBoardEvent(board, { t: 'assigned', taskId: 't2', assignee: 'w1', ts: 3 });
  board = applyBoardEvent(board, { t: 'gate-set', taskId: 't2', ts: 4 });
  const rows = boardRows({ board } as unknown as TuiState);
  assert.deepEqual(rows.map((r) => r.id), ['t2', 't10'], 'id 数值序（字典序会把 t10 排在 t2 前）');
  assert.equal(rows[0]!.label, 'B ← t10 @w1', 'label = title + 依赖箭头 + assignee 后缀');
  assert.equal(rows[0]!.status, '○');
  assert.equal(rows[0]!.gated, true, 'gated 透传（Enter 行内审批锚点）');
  assert.equal(rows[1]!.gated, undefined, '非 gated 行不携带标记');
});


test('BoardList：行形态 `${id} <符号> ⚠ label`——gated ⚠ 高亮、非 gated 行无 ⚠、箭头/后缀由 label 承载(符号由 boardRows 单点映射,组件直显)', () => {
  const one = render(
    <BoardList
      rows={[
        { id: 't1', label: 'A', status: '○' },
        { id: 't2', label: 'B ← t1 @w1', status: '◆', gated: true },
      ]}
      cursor={0}
    />,
  );
  const f = one.lastFrame() ?? '';
  assert.match(f, /t1 ○ A/, '普通行 `${id} <符号> ${label}`');
  assert.match(f, /t2 ◆ ⚠ B ← t1 @w1/, 'gated 行 ⚠ 高亮 + 依赖箭头/assignee 后缀随 label');
  assert.doesNotMatch(f, /t1 ○ ⚠/, '非 gated 行无 ⚠');
  one.unmount();
});

test('BoardList：光标行反色标记 ❯、非光标行无前缀', () => {
  const one = render(
    <BoardList
      rows={[
        { id: 't1', label: 'A', status: '○' },
        { id: 't2', label: 'B', status: '○' },
      ]}
      cursor={1}
    />,
  );
  const f = one.lastFrame() ?? '';
  assert.match(f, /❯ t2/, '光标行 ❯ 前缀');
  assert.doesNotMatch(f, /❯ t1/, '非光标行无 ❯ 前缀');
  one.unmount();
});

test(`BoardList：每页 ${BOARD_PAGE_ROWS} 行滑窗、页脚页码，翻页窗口平移`, () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `t${i + 1}`, label: `T${i + 1}`, status: '○' }));
  const page1 = render(<BoardList rows={rows} cursor={0} />);
  const p1 = page1.lastFrame() ?? '';
  assert.doesNotMatch(p1, /t9 ○/, '第 1 页不含第 9 行（每页 8 行窗口）');
  assert.doesNotMatch(p1, /t10 ○/, '第 1 页不含第 10 行');
  assert.match(p1, /page 1\/2/, '超出单页显示页脚页码');
  page1.unmount();
  const page2 = render(<BoardList rows={rows} cursor={8} />);
  const p2 = page2.lastFrame() ?? '';
  assert.match(p2, /t9 ○/, '第 2 页窗口平移后含第 9 行');
  assert.match(p2, /t10 ○/, '第 2 页含第 10 行');
  assert.doesNotMatch(p2, /\bT1\b/, '第 2 页不含第 1 行（label 锚定，不与 T10 前缀互扰）');
  page2.unmount();
});

test('BoardList：空板渲染提示行（board 模态空板自退，此为组件层契约）', () => {
  const one = render(<BoardList rows={[]} cursor={0} />);
  assert.match(one.lastFrame() ?? '', /task board empty — Ctrl\+T to toggle/, '空板提示行在位');
  one.unmount();
});
