import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLASH_COMMANDS } from '../tui/slash-commands';
import { listCommands } from './commands';

/** G10-C1a GET /commands 数据面:清单与描述唯一出口。
 *  防漂移钉子:与 tui/slash-commands.ts 单源逐字同源——该断言失守即 gui/tui 双清单病发。 */
test('listCommands 与 TUI SLASH_COMMANDS 逐字同源(防漂移钉子)', () => {
  const { commands, descriptions } = listCommands();
  assert.deepEqual(commands, SLASH_COMMANDS);
  for (const c of commands) {
    const key = c.startsWith('/') ? c.slice(1) : c;
    assert.ok(descriptions[key], `description missing for ${c}`);
    assert.equal(typeof descriptions[key], 'string');
  }
});

test('清单完整下发(25 条;置灰判定归 gui,不在此裁剪)', () => {
  const { commands } = listCommands();
  assert.equal(commands.length, SLASH_COMMANDS.length);
  assert.ok(commands.includes('/terminal-setup'));
});
