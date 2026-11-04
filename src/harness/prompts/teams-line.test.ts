import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { stableSegmentOf, TEAMS_INSTALL_LINE } from './shared';

test('稳定段含团队安装行（skills 行之后、工作目录行之前）', () => {
  const seg = stableSegmentOf({ contextRoot: '/x' });
  const at = (prefix: string) => seg.split('\n').findIndex((l) => l.startsWith(prefix));
  assert.ok(at(TEAMS_INSTALL_LINE) > at('To install skills') && at(TEAMS_INSTALL_LINE) < at(`Current working directory (project root): /x`));
});
