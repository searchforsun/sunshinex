import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_PRESETS } from './agents';

test('ROLE_PRESETS：与 AgentRole 全集一致且框定非空', () => {
  const roles = ['planner', 'developer', 'tester', 'reviewer'];
  assert.deepEqual(Object.keys(ROLE_PRESETS).sort(), [...roles].sort());
  for (const r of roles) {
    const preset = ROLE_PRESETS[r as keyof typeof ROLE_PRESETS];
    assert.ok(preset.label.length > 0, `${r} label 非空`);
    assert.ok(preset.framing.length > 0, `${r} framing 非空`);
  }
});
