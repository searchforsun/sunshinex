import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, usageText } from './index';
import { resolveWorktreeLaunchRoot } from './worktree-launch';
import { resolveResumeFlag } from '../tui/entry';

test('--resume 与 --continue 同传：fail-fast', () => {
  const args = parseArgs(['--resume', '--continue']);
  assert.throws(
    () => resolveResumeFlag(args),
    (e: unknown) => e instanceof Error && /--continue/.test((e as Error).message) && /--resume/.test((e as Error).message),
  );
});

test('--resume 与 --worktree 同传：fail-fast（沿 --continue 先例同点位）', () => {
  const args = parseArgs(['--resume', '--worktree']);
  assert.throws(
    () => resolveWorktreeLaunchRoot(args, '/tmp/repo'),
    (e: unknown) => e instanceof Error && /--resume/.test((e as Error).message) && /--worktree/.test((e as Error).message),
  );
});

test('usageText 双语 flags 行含 --resume', () => {
  assert.match(usageText(), /--resume\s+TUI, open the session picker to resume/);
});
