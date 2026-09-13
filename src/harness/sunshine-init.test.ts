import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sunshineInitGoal } from './sunshine-init';

test('sunshineInitGoal：新建语义——内嵌落点路径与真实性底线，不预设具体技术栈与文档细节', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-goal-'));
  try {
    const g = sunshineInitGoal(dir, false);
    assert.ok(g.includes(path.join(dir, 'SUNSHINE.md')), '落点绝对路径必须内嵌，避免模型写错位置');
    assert.match(g, /从零生成/);
    assert.match(g, /禁止编造/, '真实性底线必须在场');
    assert.ok(!/package\.json/.test(g), '不预设具体清单文件，保持跨项目通用');
    assert.ok(!/以 - 开头/.test(g), '不规定行级格式细节，分区组织交模型按项目实际判断');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sunshineInitGoal：完善语义——先读原文、既有内容原样保留、不整体推翻', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-goal-'));
  try {
    fs.writeFileSync(path.join(dir, 'SUNSHINE.md'), '# 项目名称\n既有项目\n');
    const g = sunshineInitGoal(dir, true);
    assert.match(g, /完善/);
    assert.match(g, /原样保留/, '用户已写内容不得被覆盖');
    assert.match(g, /不整体推翻/, '完善语义必须显式约束');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
