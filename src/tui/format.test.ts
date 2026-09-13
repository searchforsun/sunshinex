import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTokens } from './format';

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
