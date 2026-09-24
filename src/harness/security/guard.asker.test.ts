import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityGuard } from './guard';
import { PolicyEngine } from './policy';
import { ApprovalDecision, ApprovalRequest } from '../../types';

function manualGuard(policy?: PolicyEngine): SecurityGuard {
  return new SecurityGuard(policy ?? new PolicyEngine(), 'manual');
}

test('asker：manual 非白名单操作走交互裁决（allow/deny/always 三态 + 会话级登记）', async () => {
  const script: ApprovalDecision[] = ['allow', 'deny', 'always'];
  const seen: ApprovalRequest[] = [];
  const g = manualGuard();
  g.setAsker(async (req) => {
    seen.push(req);
    return script[seen.length - 1];
  });
  const input = { command: 'touch tui-probe.txt' };

  const d1 = await g.preToolUseAsync('Bash', input);
  assert.equal(d1.allowed, true, 'allow 放行一次');
  const d2 = await g.preToolUseAsync('Bash', input);
  assert.equal(d2.allowed, false, 'deny 拒绝');
  if (!d2.allowed) assert.match(d2.reason, /rejected by user/);
  const d3 = await g.preToolUseAsync('Bash', input);
  assert.equal(d3.allowed, true, 'always 放行并登记');
  const d4 = await g.preToolUseAsync('Bash', input);
  assert.equal(d4.allowed, true, 'always 后同 subject 会话内直通');
  assert.equal(seen.length, 3, '第 4 次不应再询问');
  assert.equal(seen[0].kind, 'command');
  assert.equal(seen[0].subject, 'touch tui-probe.txt');

  g.clearSessionAllows();
  await g.preToolUseAsync('Bash', input);
  assert.equal(seen.length, 4, 'clear 后恢复询问');
});

test('asker：只读白名单不询问；无 asker 维持拒绝；asker 异常按拒绝收束', async () => {
  const g = manualGuard();
  const d0 = await g.preToolUseAsync('Bash', { command: 'ls -la' });
  assert.equal(d0.allowed, true, '只读白名单直通不询问');

  const g2 = manualGuard();
  const d1 = await g2.preToolUseAsync('Bash', { command: 'touch x.txt' });
  assert.equal(d1.allowed, false, '无 asker 维持阶段一拒绝');
  if (!d1.allowed) assert.match(d1.reason, /manual mode requires interactive confirmation/);

  const g3 = manualGuard();
  g3.setAsker(async () => {
    throw new Error('asker 炸了');
  });
  const d2 = await g3.preToolUseAsync('Bash', { command: 'touch y.txt' });
  assert.equal(d2.allowed, false, 'asker 异常按拒绝收束（宁停不误）');
  if (!d2.allowed) assert.match(d2.reason, /asker failed/);
});

test('asker：deny 规则与破坏性命令不因交互放行（硬底线先行）', async () => {
  const policy = new PolicyEngine();
  policy.add('deny', 'Bash(touch *)');
  const g = manualGuard(policy);
  g.setAsker(async () => 'allow');
  const d1 = await g.preToolUseAsync('Bash', { command: 'touch z.txt' });
  assert.equal(d1.allowed, false, 'deny 规则不被 asker 豁免');
  if (!d1.allowed) assert.match(d1.reason, /deny rule matched/);
  const d2 = await g.preToolUseAsync('Bash', { command: 'rm -rf stuff' });
  assert.equal(d2.allowed, false, '破坏性命令不被 asker 豁免');
  if (!d2.allowed) assert.match(d2.reason, /destructive command blocked by safety floor/);
});

test('asker：manual 档 path 写直放安全链，guard 不再逐次 ask（行为变更①：asker 零调用）', async () => {
  const g = manualGuard();
  const seen: ApprovalRequest[] = [];
  g.setAsker(async (req) => {
    seen.push(req);
    return 'deny';
  });
  const d = await g.preToolUseAsync('Write', { path: 'a.txt' });
  assert.equal(d.allowed, true, 'manual 档 Write 在 guard 层直接放行，审批下放安全链');
  assert.equal(seen.length, 0, 'asker 零调用');
});

test('asker：无 path/url/query 的结构化写工具 subject 取 type:摘要（卡片可读且恒非空）', async () => {
  const g = manualGuard();
  const seen: ApprovalRequest[] = [];
  g.setAsker(async (req) => {
    seen.push(req);
    return 'deny';
  });
  // memory_write 形态（canonical 同族 Write、入参无 path）：审批卡只有 `Approval ap-1 (write)` 与一行空白即看不出在写什么
  const fact = { type: 'project', content: 'Repo uses pnpm with a repo-local store', description: 'pnpm store is repo-local' };
  await g.preToolUseAsync('Write', fact);
  assert.equal(seen[0].kind, 'write');
  assert.equal(seen[0].subject, 'project: pnpm store is repo-local');
  assert.notEqual(seen[0].subject, '', 'subject 恒非空（空 subject 会让卡片空白且会话放行键跨内容命中）');

  // description 缺省 → 取正文首行（单行口径，与 writeMemoryFact 的 description 缺省同源）
  await g.preToolUseAsync('Write', { type: 'user', content: 'Prefers concise answers\nsecond line' });
  assert.equal(seen[1].subject, 'user: Prefers concise answers');

  // path 形态的 Write 直放安全链（行为变更①）：不产生审批请求——结构化摘要只覆盖无 path 形态
  await g.preToolUseAsync('Write', { path: 'a.txt', type: 'project', content: 'x', description: 'y' });
  assert.equal(seen.length, 2, 'path 写直放安全链，零审批请求');

  // path 优先于结构化字段的旧口径保留在 webfetch 上（url 字段语义零变化）
  await g.preToolUseAsync('WebFetch', { url: 'https://example.com', content: 'x' });
  assert.equal(seen[2].subject, 'https://example.com');

  // 结构化字段全缺仍为空（不臆造摘要），该形态的跨族风险由 allowKey 的 `<tool>:` 兜住（见下一条用例）
  await g.preToolUseAsync('Write', {});
  assert.equal(seen[3].subject, '');
});

test('asker：allowKey 对空 subject 并入工具规范名（键空间至少含工具身份）', () => {
  const g = manualGuard();
  const key = (tool: string, subject: string): string =>
    (g as unknown as { allowKey(t: string, s: string): string }).allowKey(tool, subject);
  assert.equal(key('Write', ''), 'Write:');
  assert.equal(key('mcp__github__create_issue', ''), 'mcp__github__create_issue:');
  assert.equal(key('Bash', ''), 'Bash:', '空命令行同样并入工具名（不得落空键）');
  assert.equal(key('Write', 'a.txt'), 'a.txt', '非空 subject 语义零变化');
  assert.equal(key('Bash', 'npm run build'), 'npm', 'Bash 仍归一命令族');
});

test('asker：空 subject 不跨族放行（一次 always 只登记该工具的键）', async () => {
  const seen: ApprovalRequest[] = [];
  const g = new SecurityGuard(new PolicyEngine(), 'manual', ['github']);
  g.setAsker(async (req) => {
    seen.push(req);
    return 'always';
  });
  // MCP 工具无 path/url/query/type/description/content → subject 为空；旧语义下该键为 ''，与任意空键工具共享
  const mcp = await g.preToolUseAsync('mcp__github__create_issue', { title: 'x' });
  assert.equal(mcp.allowed, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].subject, '');
  const mcpAgain = await g.preToolUseAsync('mcp__github__create_issue', { title: 'y' });
  assert.equal(mcpAgain.allowed, true);
  assert.equal(seen.length, 1, 'always 后同工具空键直通');

  // 换工具（subject 同样为空）必须重新询问：空键不得成为跨工具族公共键
  const write = await g.preToolUseAsync('Write', {});
  assert.equal(write.allowed, true);
  assert.equal(seen.length, 2, '不同工具的空 subject 不得命中同一登记键');
  assert.equal(seen[1].subject, '');
});
