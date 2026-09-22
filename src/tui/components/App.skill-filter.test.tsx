import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { App, deriveFilterableView } from './App';
import { SessionController } from '../session';
import { ScriptedAdapter } from '../../model/adapter';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function flushKey(term: ReturnType<typeof render>): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

/* ---------- deriveFilterableView 纯函数 ---------- */

const full10 = Array.from({ length: 10 }, (_, i) => ({ label: `m-${i}`, description: `d ${i}` }));

test('deriveFilterableView：空词分页——8 实项 + More…，导航行无映射席位', () => {
  const r = deriveFilterableView(full10, '', 0);
  assert.equal(r.view.length, 9, '8 实项 + More…');
  assert.equal(r.view[8]?.label, 'More…');
  assert.deepEqual(r.map, [0, 1, 2, 3, 4, 5, 6, 7], '实项映射原下标');
  assert.equal(r.moreIdx, 8, 'More… 视图下标');
  assert.equal(r.backIdx, -1, '首页无 Back…');
});

test('deriveFilterableView：第 2 页带 Back…，More… 先于 Back…', () => {
  const r = deriveFilterableView(full10, '', 1);
  assert.equal(r.view.length, 3, '2 实项 + Back…');
  assert.deepEqual(r.map, [8, 9]);
  assert.equal(r.moreIdx, -1);
  assert.equal(r.backIdx, 2);
});

test('deriveFilterableView：有词全量过滤直出、无导航行', () => {
  const three = [{ label: 'alpha' }, { label: 'bolt' }, { label: 'gamma' }]; // bolt 不含 a：钉「未命中隐藏」（简报原标签 beta 含 a，任何子串语义必命中，勘误见报告）
  const r = deriveFilterableView(three, 'a', 0);
  assert.deepEqual(r.map, [0, 2], 'alpha/gamma 命中');
  assert.equal(r.moreIdx, -1);
  assert.equal(r.backIdx, -1, '有词无导航');
});

/* ---------- App 键盘分发（经 ctrl.askUser 直挂 filterable 卡） ---------- */

test('App filterable 卡：数字进筛选词（快选让位）、Enter 经 map 提交原 label', async () => {
  const tmp = tmpDir('sunshinex-appfilt1-');
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    const options = Array.from({ length: 10 }, (_, i) => ({ label: `skill-${i}`, description: `desc ${i}` }));
    const p = ctrl.askUser({ question: 'Load which skill?', options, filterable: true });
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    term = render(<App controller={ctrl} />);
    await waitFor(() => (term?.lastFrame() ?? '').includes('Load which skill?'), 3000);
    term.write('9');
    await flushKey(term);
    const f = term?.lastFrame() ?? '';
    assert.ok(f.includes('/ 9▊'), '筛选行显示数字词');
    assert.ok(!f.includes('skill-0'), '未命中项隐藏');
    assert.ok(f.includes('skill-9'), '命中项渲染');
    term.write('\r');
    assert.deepEqual(await p, { type: 'selected', labels: ['skill-9'] }, 'Enter 经 map 提交原 label');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App filterable 卡：Backspace 删字；Esc 两段式——先清词再退出 dismissed', async () => {
  const tmp = tmpDir('sunshinex-appfilt2-');
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    const options = [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }];
    const p = ctrl.askUser({ question: 'q?', options, filterable: true });
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    term = render(<App controller={ctrl} />);
    await waitFor(() => (term?.lastFrame() ?? '').includes('q?'), 3000);
    term.write('ab');
    await flushKey(term);
    term.write('\u007F'); // Backspace 删字
    await flushKey(term);
    assert.ok((term?.lastFrame() ?? '').includes('/ a▊'), '删字后剩 a');
    term.write('\u001B'); // Esc：词非空 → 清词
    await flushKey(term);
    assert.ok((term?.lastFrame() ?? '').includes('/ ▊'), 'Esc 先清词、卡仍在');
    assert.ok((term?.lastFrame() ?? '').includes('alpha'), '清词后全量列表回归');
    term.write('\u001B'); // Esc：词空 → 退出
    assert.deepEqual(await p, { type: 'dismissed' }, 'Esc 两段式退出');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App filterable 多选卡：Space 按原下标勾选、More… 翻页、Enter 提交勾选累积集', async () => {
  const tmp = tmpDir('sunshinex-appfilt3-');
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    const p = ctrl.askUser({ question: 'rm?', options: full10, multiple: true, filterable: true });
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    term = render(<App controller={ctrl} />);
    await waitFor(() => (term?.lastFrame() ?? '').includes('rm?'), 3000);
    term.write(' '); // cursor 0 → 勾 m-0
    await flushKey(term);
    assert.ok((term?.lastFrame() ?? '').includes('◉'), '勾选标记上屏');
    // ↓×8（D7：↑/↓ 逐行作用于视图，moveCursor 有回环钉）0→8 落 More…；简报「一次 ↓」系笔误，勘误见报告
    for (let i = 0; i < 8; i++) { term.write('\u001B[B'); await flushKey(term); }
    await flushKey(term);
    term.write('\r'); // 翻页
    await flushKey(term);
    const f1 = term?.lastFrame() ?? '';
    assert.ok(f1.includes('Back…') && f1.includes('m-8'), '翻到第 2 页');
    term.write('\u001B[B'); // 翻页后 cursor 归 0（m-8）→ ↓ 到 m-9
    await flushKey(term);
    term.write(' '); // 勾 m-9
    await flushKey(term);
    term.write('\r'); // 提交累积集
    assert.deepEqual(await p, { type: 'selected', labels: ['m-0', 'm-9'] }, '跨页勾选累积提交（升序）');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('App 非 filterable 卡：数字快选照旧（回归钉，规格 D6 零触碰承诺）', async () => {
  const tmp = tmpDir('sunshinex-appfilt4-');
  let term: ReturnType<typeof render> | undefined;
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    const options = [{ label: 'A' }, { label: 'B' }, { label: 'C' }];
    const p = ctrl.askUser({ question: 'plain?', options });
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    term = render(<App controller={ctrl} />);
    await waitFor(() => (term?.lastFrame() ?? '').includes('plain?'), 3000);
    term.write('2');
    assert.deepEqual(await p, { type: 'selected', labels: ['B'] }, '数字 2 快选第二项');
  } finally {
    term?.unmount();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
