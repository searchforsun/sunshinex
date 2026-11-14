import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultOpenCommand } from './editors-handlers';

/** 系统默认关联打开(2026-11-12 spec §5.3):explorer 对文件只定位不关联,须独立一档 */

test('defaultOpenCommand:三平台命令面(win32 start 空标题位/mac open/linux xdg-open)', () => {
  assert.deepEqual(defaultOpenCommand('win32', 'C:\\r\\a.md'), { cmd: 'cmd', args: ['/c', 'start', '', 'C:\\r\\a.md'] });
  assert.deepEqual(defaultOpenCommand('darwin', '/r/a.md'), { cmd: 'open', args: ['/r/a.md'] });
  assert.deepEqual(defaultOpenCommand('linux', '/r/a.md'), { cmd: 'xdg-open', args: ['/r/a.md'] });
});
