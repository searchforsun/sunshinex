import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolCallLine, setToolDisplayMeta, TOOL_VERBS } from './tool-verbs';
import { t } from '../i18n';
import { ToolRegistry } from '../harness/tools';
import { builtinTools } from '../harness/tools/builtin';
import { makeSpawnTool } from '../harness/subagent';
import { makeTaskStopTool } from '../harness/tools/task-stop';
import { makeTaskWaitTool } from '../harness/tools/task-wait';
import { SafetyChain } from '../harness/security/chain';
import { SecurityGuard } from '../harness/security/guard';
import { PolicyEngine } from '../harness/security/policy';
import { ProcessSandbox } from '../harness/security/sandbox';
import type { SubagentRunner } from '../harness/subagent';
import type { TaskRegistry } from '../harness/tasks';

// J1 装配期接线（同产线 createRuntime 形态）：真实注册表 displayMeta → TUI 呈现表。既有断言值即
// 迁移前旧 VERBS/TARGET_FIELD 表值——本接线即「值随注册下泄、呈现零跟表」的特征化对照
function wireProductionMeta(): void {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), process.cwd());
  const registry = new ToolRegistry();
  const stubMemoryWrite = () => ({ ok: true as const, value: { slug: 'stub-slug', existed: false, notice: null } });
  const stubAsk = async () => ({ type: 'dismissed' as const });
  for (const tool of builtinTools(safety, process.cwd(), { memoryWrite: stubMemoryWrite, ask: stubAsk })) registry.register(tool);
  // 平台三工具产线同形注册点附加（harness/index.ts）
  registry.register({ ...makeSpawnTool({} as unknown as SubagentRunner), display: { verb: 'SPAWN' } });
  registry.register({ ...makeTaskStopTool({} as unknown as TaskRegistry), display: { verb: 'TASK_STOP' } });
  registry.register({ ...makeTaskWaitTool({} as unknown as TaskRegistry), display: { verb: 'TASK_WAIT' } });
  setToolDisplayMeta(registry.displayMeta());
}
wireProductionMeta();

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

test('J1：注入含自定义 display 的表后呈现层用其 verb/targetFields（新工具零跟表即正确呈现）', () => {
  setToolDisplayMeta({ deploy_service: { verb: 'DEPLOY', targetFields: ['service'] } });
  assert.equal(toolCallLine('deploy_service', { service: 'api', path: '/x' }), 'DEPLOY api', 'target 按声明字段取，不受候选顺序（path 优先）干扰');
  assert.equal(toolCallLine('deploy_service', { path: '/x' }), 'DEPLOY {"path":"/x"}', '声明字段缺席回 JSON 摘要（既有兜底语义）');
  assert.equal(toolCallLine('read', { path: 'a.ts' }), 'READ a.ts', '表外工具走大写原名 fallback（读面动词恰为名大写）');
  wireProductionMeta(); // 复位产线表：后续用例与同进程后续文件不受本用例注入影响
});

test('J1：空表 = 纯 fallback（未装配态降级对齐现状未登记工具语义）', () => {
  setToolDisplayMeta({});
  assert.equal(toolCallLine('webfetch', { url: 'https://x.dev' }), 'WEBFETCH https://x.dev', '缺注入回大写原名');
  assert.equal(toolCallLine('grep', { path: '.', pattern: 'needle' }), 'GREP .', '缺注入回候选字段序（path 先于 pattern）');
  assert.equal(toolCallLine('mcp__fs__read', { path: 'a.txt' }), 'MCP a.txt', 'MCP 统一呈现不随表');
  assert.equal(TOOL_VERBS.size, 0, '动词集合随空表清空');
  wireProductionMeta();
});

test('J1：TOOL_VERBS 随注入表重建——旧 VERBS 全集动词无一丢失（ChildTranscript 分流判据）', () => {
  for (const verb of ['ASK', 'EXEC', 'READ', 'WRITE', 'GREP', 'GLOB', 'FETCH', 'WEBSEARCH', 'SEARCH', 'SPAWN', 'WORKTREE', 'TODO', 'TASK_WAIT', 'TASK_STOP']) {
    assert.ok(TOOL_VERBS.has(verb), `动词 ${verb} 应随注入表在集合中`);
  }
});
