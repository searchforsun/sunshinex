import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolCallLine } from './tool-verbs';
import { t } from '../i18n';

test('toolCallLine：spawn 映射 SPAWN + label 摘要（规格 §6 调用行口径）', () => {
  assert.equal(toolCallLine('spawn', { prompt: 'x', label: 'w' }), 'SPAWN w');
  assert.equal(toolCallLine('spawn', { prompt: 'x' }), 'SPAWN subagent');
});

test('toolCallLine：已登记工具映射英文动词 + target 摘要', () => {
  assert.equal(toolCallLine('exec', { command: 'ls -la' }), 'EXEC ls -la');
  assert.equal(toolCallLine('read', { path: 'SUNSHINE.md' }), 'READ SUNSHINE.md');
  assert.equal(toolCallLine('write', { path: 'README.md', content: 'x' }), 'WRITE README.md');
  assert.equal(toolCallLine('grep', { pattern: 'TODO' }), 'GREP TODO');
  assert.equal(toolCallLine('glob', { pattern: 'src/**/*.ts' }), 'GLOB src/**/*.ts');
  assert.equal(toolCallLine('webfetch', { url: 'https://x.dev' }), 'FETCH https://x.dev');
  assert.equal(toolCallLine('websearch', { query: 'sunshine' }), 'WEBSEARCH sunshine');
  assert.equal(toolCallLine('kb_search', { query: '部署' }), 'SEARCH 部署');
});

test('toolCallLine：MCP 工具统一 MCP，未登记工具大写原名', () => {
  assert.equal(toolCallLine('mcp__fs__read', { path: 'a.txt' }), 'MCP a.txt');
  assert.equal(toolCallLine('custom_tool', { x: 1 }), 'CUSTOM_TOOL {"x":1}');
});

test('toolCallLine：无输入回退为空 target（仅动词）', () => {
  assert.equal(toolCallLine('read', {}), 'READ');
  assert.equal(toolCallLine('read', undefined), 'READ');
});

test('toolCallLine：超长 target 原样透传不截断（呈现层按列宽自然省略）', () => {
  const line = toolCallLine('read', { path: 'x'.repeat(120) });
  assert.equal(line, 'READ ' + 'x'.repeat(120), '源头零截断，target 语义完整交给呈现层');
});

test('toolCallLine：grep 带 path 仍取 pattern 代表字段', () => {
  assert.equal(toolCallLine('grep', { path: '.', pattern: 'needle' }), 'GREP needle');
});

test('toolCallLine：exec 取 command 全量（空白归一），与 path 共存时 command 优先', () => {
  assert.equal(toolCallLine('exec', { command: 'npm test', path: '/x' }), 'EXEC npm test');
  assert.equal(
    toolCallLine('exec', { command: 'grep  -n   "needle"  -r   src/' }),
    'EXEC grep -n "needle" -r src/',
    '多空白归一为单空格，命令详情完整保留（呈现层按列宽自然省略）',
  );
});

test('toolCallLine：读面行为不变——代表字段提取与空白归一零改动', () => {
  assert.equal(toolCallLine('read', { path: 'a/very/long/path/that/goes/on/and/on/forever/in/deep/dirs/file.ts' }),
    'READ a/very/long/path/that/goes/on/and/on/forever/in/deep/dirs/file.ts', '长路径完整保留');
});

test('toolCallLine：task_wait/task_stop 可读 target（2026-09-30 用户裁决：平台专属工具参数不再裸 JSON 兜底直出）', () => {
  assert.equal(
    toolCallLine('task_wait', { taskIds: ['b1', 'b2', 'b3', 'b4'], timeoutSeconds: 1500 }),
    'TASK_WAIT b1,b2,b3,b4 · 1500s',
    'taskIds 逗号连接 + timeout 尾追',
  );
  // i18n 双语面（测试进程语言随环境），t() 包裹的 null-taskIds 文案两面皆可
  assert.equal(toolCallLine('task_wait', { taskIds: null, timeoutSeconds: 60 }), `TASK_WAIT ${t('all running', '全部 running')} · 60s`, 'taskIds=null 等当前全部任务');
  assert.equal(toolCallLine('task_stop', { taskId: 'b7' }), 'TASK_STOP b7', 'task_stop 取 taskId');
});
