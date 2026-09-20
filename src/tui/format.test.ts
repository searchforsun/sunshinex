import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatTokens } from './format';

test('formatTokens：千以下原样，千以上记 k', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1200), '1.2k');
  assert.equal(formatTokens(12345), '12k');
});

test('formatTokens：负值与非有限值按 0 收束', () => {
  assert.equal(formatTokens(-5), '0');
  assert.equal(formatTokens(Number.NaN), '0');
});

test('formatDuration：可读时长——秒 <1m 只显秒，跨分含分，跨时含时（1h 21m 30s 形态）', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(59), '59s');
  assert.equal(formatDuration(60), '1m 0s');
  assert.equal(formatDuration(602), '10m 2s');
  assert.equal(formatDuration(3661), '1h 1m 1s');
  assert.equal(formatDuration(4890), '1h 21m 30s');
  assert.equal(formatDuration(3600 * 25 + 61), '25h 1m 1s');
});
