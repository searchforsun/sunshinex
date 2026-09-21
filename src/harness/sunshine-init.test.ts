import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sunshineInitGoal } from './sunshine-init';
import { setLanguage } from '../i18n';

test('sunshineInitGoal：新建语义——内嵌落点路径与真实性底线，不预设具体技术栈与文档细节', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-goal-'));
  try {
    const g = sunshineInitGoal(dir, false);
    assert.ok(g.includes(path.join(dir, 'SUNSHINE.md')), '落点绝对路径必须内嵌，避免模型写错位置');
    assert.match(g, /from scratch/);
    assert.match(g, /never fabricate/, '真实性底线必须在场');
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
    assert.match(g, /refine/);
    assert.match(g, /as-is/, '用户已写内容不得被覆盖');
    assert.match(g, /wholesale/, '完善语义必须显式约束');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sunshineInitGoal：新建语义——覆盖大纲 A/B 档、覆盖率口径、篇幅目标齐备', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-goal-'));
  try {
    const g = sunshineInitGoal(dir, false);
    // L4a 口径声明：大纲是覆盖清单、不是格式
    assert.match(g, /coverage check, not a format/, '必须声明「覆盖清单、不是格式」，结构与命名交模型自定');
    // L3 证据要求
    assert.match(g, /dependency and script definitions/, '证据来源须为生态中性措辞');
    // L4b A 档 5 类
    assert.match(g, /what the project is/);
    assert.match(g, /how to run it/);
    assert.match(g, /how the code is laid out/);
    assert.match(g, /how it is structured/);
    assert.match(g, /how to write code here/);
    // L4c B 档 6 类触发条件
    assert.match(g, /commit-time gates/);
    assert.match(g, /packaging and release/);
    assert.match(g, /extension points/);
    assert.match(g, /version floors/);
    // L5 篇幅目标
    assert.match(g, /60-120 lines/, '篇幅目标必须在场');
    // 既有锚点
    assert.match(g, /from scratch/);
    assert.match(g, /never fabricate/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sunshineInitGoal：去标题锚定、提示词单语、不写产出语言条款（D2/D8/D9/D10）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-goal-'));
  try {
    const g = sunshineInitGoal(dir, false);
    assert.ok(!/^#{1,6}\s/m.test(g), '不出现标题字面锚点');
    assert.ok(!/Compact Instructions|压缩指令|MCP 服务器/.test(g), '不锚定机器消费区标题（D9）');
    assert.ok(!/[\u4e00-\u9fff]/.test(g), 'en 提示词不得混入中文（D10）');
    assert.ok(!/in Chinese|in English|用中文|写成中文|中文项目/.test(g), '不写产出语言条款（D8）');

    // 提示词恒英文单语：--language=zh 下 goal 逐字节不变（goal 不随外观语言分叉）
    setLanguage('zh');
    try {
      const gz = sunshineInitGoal(dir, false);
      assert.equal(gz, g, 'zh 下 goal 与 en 侧逐字节相同（提示词不随 --language 分叉）');
      assert.ok(!/[\u4e00-\u9fff]/.test(gz), 'zh 下同样零中文（提示词面）');
      assert.ok(!/^#{1,6}\s/m.test(gz), 'zh 侧同样无标题字面锚点');
      assert.ok(!/Compact Instructions|压缩指令|MCP 服务器/.test(gz), 'zh 侧不锚定机器消费区标题');
    } finally {
      setLanguage('en');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sunshineInitGoal：完善语义——读全文、既有行原样保留、只补缺失、整体写回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-goal-'));
  try {
    fs.writeFileSync(path.join(dir, 'SUNSHINE.md'), '# 项目名称\n既有项目\n');
    const g = sunshineInitGoal(dir, true);
    assert.match(g, /read it in full first/, '未读全文不得落笔');
    assert.match(g, /as-is/, '既有行原样保留');
    assert.match(g, /append only what is missing/, '只补缺失覆盖项');
    assert.match(g, /do not rewrite it wholesale/, '不得整体推翻');
    assert.match(g, /in one go/, '合并结果一次性写回，禁止分次写盘');
    assert.ok(!/^#{1,6}\s/m.test(g), '完善语义下同样不锚定标题');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
