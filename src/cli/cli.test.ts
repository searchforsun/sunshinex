import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './index';

test('parseArgs：无参数回退 help', () => {
  assert.equal(parseArgs([]).command, 'help');
});

test('parseArgs：positional 与布尔 flag', () => {
  const a = parseArgs(['selfcheck', '--json']);
  assert.equal(a.command, 'selfcheck');
  assert.equal(a.flags.json, true);
});

test('parseArgs：--flag=value 与裸 positional 混排', () => {
  const a = parseArgs(['run', 'tests/fixtures/demo', '--template', 'test-loop', '--mode', 'dontAsk']);
  assert.equal(a.command, 'run');
  assert.deepEqual(a.positional, ['tests/fixtures/demo']);
  assert.equal(a.flags.template, 'test-loop');
  assert.equal(a.flags.mode, 'dontAsk');
});
