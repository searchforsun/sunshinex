import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { render } from '../test-ink';
import { MarkdownText, diffLineColor } from './MarkdownText';

test('diffLineColor：+/-/@@/上下文 四类行首着色', () => {
  assert.equal(diffLineColor('+ 新增行'), 'green');
  assert.equal(diffLineColor('- 删除行'), 'red');
  assert.equal(diffLineColor('@@ -1,3 +1,4 @@'), 'cyan');
  assert.equal(diffLineColor(' 上下文行'), 'gray');
  assert.equal(diffLineColor('普通行'), 'gray');
});

test('MarkdownText：diff 代码块行首 +/- 内容上屏', () => {
  const { lastFrame, unmount } = render(<MarkdownText text={'```diff\n+ 新增\n- 删除\n@@ -1 +1 @@\n```'} columns={100} />);
  const f = lastFrame() ?? '';
  assert.match(f, /新增/);
  assert.match(f, /删除/);
  assert.ok(!f.includes('```'), '围栏应被吞掉');
  unmount();
});
