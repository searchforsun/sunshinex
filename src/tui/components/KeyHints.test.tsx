import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { render } from '../test-ink';
import { KeyHints, keyHintsFor, fitHints } from './KeyHints';

test('keyHintsFor 矩阵：运行中=暂停/待办/详情，子代理在场追加 Ctrl+B', () => {
  const base = keyHintsFor({ status: 'running' })!;
  assert.deepEqual(base.items.map((i) => i.key), ['Ctrl+C', 'Tab', 'Ctrl+O']);
  const withChildren = keyHintsFor({ status: 'running', hasChildren: true })!;
  assert.deepEqual(withChildren.items.map((i) => i.key), ['Ctrl+C', 'Tab', 'Ctrl+O', 'Ctrl+B'], '子代理在场追加浏览键');
});

test('keyHintsFor 矩阵：空闲两态与 inspect/browse/pauseConfirm（/help 不进条——占位符已承载，冗余裁决）', () => {
  const idle = keyHintsFor({ status: 'idle' })!;
  assert.deepEqual(idle.items.map((i) => i.key), ['Tab', '↑', 'Ctrl+B'], '/help 撤出（与输入框占位符不双显）');
  const menu = keyHintsFor({ status: 'idle', menuVisible: true })!;
  assert.deepEqual(menu.items.map((i) => i.key), ['↑↓', 'Tab'], '斜杠菜单在场换面板键（Enter 由占位符承载）');
  const inspect = keyHintsFor({ status: 'running', inspect: true })!;
  assert.deepEqual(inspect.items.map((i) => i.key), ['Tab', 'Ctrl+C', 'Esc'], '全屏视图键（head 内嵌退役）');
  const browse = keyHintsFor({ status: 'idle', browse: true })!;
  assert.deepEqual(browse.items.map((i) => i.key), ['↑↓', 'Enter', 'Esc'], '浏览接管键');
  const pause = keyHintsFor({ status: 'running', pauseConfirm: true })!;
  assert.equal(pause.items[0]!.key.includes('Ctrl+C') || pause.items[0]!.key.includes('ctrl+c'), true, '首键=再按 Ctrl+C');
  assert.equal(pause.items[1]!.key, 'Esc');
});

test('keyHintsFor 矩阵：模态卡在场条退场（undefined）', () => {
  assert.equal(keyHintsFor({ status: 'awaiting-approval' }), undefined);
  assert.equal(keyHintsFor({ status: 'awaiting-plan' }), undefined);
  assert.equal(keyHintsFor({ status: 'awaiting-question' }), undefined);
  assert.equal(keyHintsFor({ status: 'running', approval: { id: 'x' } }), undefined);
  assert.equal(keyHintsFor({ status: 'running', question: { question: 'q' } }), undefined);
});

test('fitHints 截断：超宽按优先序裁尾、首位恒保留', () => {
  const items = [
    { key: 'Ctrl+C', action: '暂停' },
    { key: 'Tab', action: '待办' },
    { key: 'Ctrl+O', action: '详情' },
  ];
  assert.equal(fitHints(items, 200).length, 3, '宽屏全量');
  const two = fitHints(items, 30);
  assert.ok(two.length >= 1 && two.length < 3, '中屏裁尾');
  assert.equal(two[0]!.key, 'Ctrl+C', '首位（最关键键）恒保留');
  const one = fitHints(items, 12);
  assert.equal(one.length, 1, '极窄只保首位');
  assert.equal(one[0]!.key, 'Ctrl+C');
});

test('KeyHints 渲染：整行统一系统提示色——无 ⌨ 前缀、无粗体键名、无反色底（样式终版裁决）', () => {
  const one = render(<KeyHints items={keyHintsFor({ status: 'running' })!.items} columns={100} />);
  const f = one.lastFrame() ?? '';
  assert.ok(!f.includes('⌨'), '无 ⌨ 前缀 icon');
  assert.ok(f.includes('Ctrl+C'), '键名呈现');
  assert.ok(!f.includes('\u001b[1m') && !f.includes('\u001b[7m'), '无粗体/反色转义（纯 dimColor 单段）');
  one.unmount();
});
