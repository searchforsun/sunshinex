import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { Text } from 'ink';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from '../test-ink';
import { RenderBoundary } from './RenderBoundary';

const BadChild = (): JSX.Element => {
  // 渲染期抛错（模拟 ink Output 尺寸异常从 host commit 冒泡进 React 提交阶段）
  throw new RangeError('Invalid string length');
  return <Text>never</Text>;
};

test('RenderBoundary：渲染期异常降级为错误提示行不杀进程，崩溃诊断落 %TEMP%/sunshinex-render-crash.log', () => {
  const one = render(
    <RenderBoundary>
      <Text>ok-content</Text>
    </RenderBoundary>,
  );
  assert.match(one.lastFrame() ?? '', /ok-content/, '正常路径透传');
  one.unmount();

  const two = render(
    <RenderBoundary>
      <BadChild />
    </RenderBoundary>,
  );
  const f = two.lastFrame() ?? '';
  assert.match(f, /render error/, '异常降级为错误提示行（进程存活）');
  assert.match(f, /Invalid string length/, '错误消息可见');
  two.unmount();
  const log = path.join(os.tmpdir(), 'sunshinex-render-crash.log');
  assert.ok(fs.existsSync(log), '崩溃诊断已落盘');
});
