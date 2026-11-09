// src/catalog/watch.test.ts
// ConfigWatcher 行为测试：真实 tmp 目录 + 真实 fs.watch（不读任何配置文件，不需要 HOME 桩，绝不触真实 ~/.sunshinex）。
// 计时纪律（沿仓内「计时抖动」教训，见 scripts/run-tests.js 注释）：等待只设上界不设精确时序——
// 正向断言用 waitFor 轮询（事件一到即过），反向断言（无回调）给足 ≥1.5s 上界窗口。
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { ConfigWatcher, mapFilename, type ConfigChange } from './watch';

/** 固定等待（反向断言的观察窗口/写前就绪缓冲） */
const waitMs = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
/** 轮询等待条件成立，timeoutMs 只是兜底上界——满足即返回，不整段硬睡 */
async function waitFor(fn: () => boolean, timeoutMs = 2500): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时（${timeoutMs}ms 内条件未成立）`);
    await waitMs(25);
  }
}

test('写 globalDir/mcp.json → 收 mcp/global/null；300ms 防抖窗口内多次写合并为一次回调', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-global-'));
  const w = new ConfigWatcher();
  const got: ConfigChange[] = [];
  w.onChange(c => got.push(c));
  w.watchGlobal(dir); // agents/ plugins/ 子目录不存在 → 逐目录降级 warn，不影响本层监听
  try {
    await waitMs(250); // fs.watch 就绪缓冲
    writeFileSync(join(dir, 'mcp.json'), '{"a":1}');
    writeFileSync(join(dir, 'mcp.json'), '{"a":2}'); // 防抖窗口内第二次写 → 合并
    await waitFor(() => got.some(c => c.resource === 'mcp' && c.scope === 'global' && c.root === null));
    await waitMs(800); // 超过防抖窗口+余量：确认没有第二次回调
    assert.equal(got.length, 1);
  } finally { w.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('写 project/.sunshinex/skills/a/SKILL.md → 收 skills/project/root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cw-proj-'));
  const w = new ConfigWatcher();
  const got: ConfigChange[] = [];
  w.onChange(c => got.push(c));
  mkdirSync(join(root, '.sunshinex', 'skills'), { recursive: true }); // 结构先于监听存在（缺失目录会降级跳过）
  mkdirSync(join(root, '.sunshinex', 'agents'), { recursive: true });
  w.watchProject(root);
  try {
    await waitMs(250);
    const skillDir = join(root, '.sunshinex', 'skills', 'a');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# t');
    await waitFor(() => got.some(c => c.resource === 'skills' && c.scope === 'project' && c.root === root));
    await waitMs(800); // base 层与 skills/ 两路事件同键 → 防抖合并为一次
    assert.equal(got.filter(c => c.resource === 'skills').length, 1);
  } finally { w.close(); rmSync(root, { recursive: true, force: true }); }
});

test('写 project/.claude/skills/a/SKILL.md（兼容技能根）→ 收 skills/project/root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cw-compat-'));
  const w = new ConfigWatcher();
  const got: ConfigChange[] = [];
  w.onChange(c => got.push(c));
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true }); // 兼容根结构先于监听存在（缺失目录会降级跳过）
  w.watchProject(root);
  try {
    await waitMs(250);
    const skillDir = join(root, '.claude', 'skills', 'a');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# t');
    await waitFor(() => got.some(c => c.resource === 'skills' && c.scope === 'project' && c.root === root));
    await waitMs(800);
    assert.equal(got.filter(c => c.resource === 'skills').length, 1);
  } finally { w.close(); rmSync(root, { recursive: true, force: true }); }
});

test("suppress('mcp','global',null) 后写 mcp.json → 窗口期内不回调（写回环抑制）", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-suppress-'));
  const w = new ConfigWatcher();
  const got: ConfigChange[] = [];
  w.onChange(c => got.push(c));
  w.watchGlobal(dir);
  try {
    await waitMs(250);
    w.suppress('mcp', 'global', null); // 缺省 500ms 抑制窗口
    writeFileSync(join(dir, 'mcp.json'), '{"a":1}');
    await waitMs(1600); // 上界 ≥1.5s：窗口内确无任何回调
    assert.equal(got.length, 0);
  } finally { w.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('watch 不存在目录 → 不 throw、降级 warn（回退 GET 即读）', () => {
  const w = new ConfigWatcher();
  const got: ConfigChange[] = [];
  w.onChange(c => got.push(c));
  const missing = join(mkdtempSync(join(tmpdir(), 'cw-missing-')), 'nope');
  assert.doesNotThrow(() => { w.watchGlobal(missing); w.watchProject(missing); });
  assert.doesNotThrow(() => w.close()); // 拆除也不 throw
  rmSync(missing, { recursive: true, force: true });
});

test('watch 缺失目录降级后，补建目录并重新 watchGlobal → 事件可达（零条目组不占位，重试非空操作）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cw-retry-'));
  const missing = join(root, 'g'); // 故意先不创建：首次 watchGlobal 全目录缺失 → 逐个降级 warn 不 throw
  const w = new ConfigWatcher();
  const got: ConfigChange[] = [];
  w.onChange(c => got.push(c));
  w.watchGlobal(missing);
  try {
    await waitMs(250);
    mkdirSync(join(missing, 'agents'), { recursive: true }); // 事后补建目录
    w.watchGlobal(missing); // 重新监听：全局侧无 unwatch 可重置，重试必须真实生效
    await waitMs(250);
    writeFileSync(join(missing, 'mcp.json'), '{"a":1}');
    await waitFor(() => got.some(c => c.resource === 'mcp' && c.scope === 'global' && c.root === null));
  } finally { w.close(); rmSync(root, { recursive: true, force: true }); }
});

test('close() 后写文件不再回调', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-close-'));
  const w = new ConfigWatcher();
  const got: ConfigChange[] = [];
  w.onChange(c => got.push(c));
  w.watchGlobal(dir);
  try {
    await waitMs(250);
    writeFileSync(join(dir, 'settings.json'), '{}');
    await waitFor(() => got.length > 0); // 先证明监听确实活着
    w.close();
    await waitMs(100);
    const before = got.length;
    writeFileSync(join(dir, 'settings.json'), '{"x":1}');
    await waitMs(1600); // 上界 ≥1.5s：close 后确无迟到回调
    assert.equal(got.length, before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- agents-teams P1 Task 2：teams 目录接线（mapFilename teams 段 + watch 全局/项目 teams 子目录） ----------

test('mapFilename: teams 路径段映射 teams（win32 目录冒泡 filename 只剩子目录名同判）；无关文件仍 null', () => {
  assert.equal(mapFilename('teams/t1/team.md'), 'teams'); // 子路径含 teams 段
  assert.equal(mapFilename('teams\\t1\\team.md'), 'teams'); // win32 反斜杠归一
  assert.equal(mapFilename('teams'), 'teams'); // win32 目录级事件 filename 常只是子目录名
  assert.equal(mapFilename('t1/team.md'), null); // 无 teams/skills/agents/plugins 段仍不映射
});

test('写 globalDir/teams/g1/team.md → 收 teams/global/null（watchGlobal 挂 teams 子目录）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-gteams-'));
  const w = new ConfigWatcher();
  const got: ConfigChange[] = [];
  w.onChange(c => got.push(c));
  mkdirSync(join(dir, 'teams'), { recursive: true }); // 结构先于监听存在（缺失目录会降级跳过）
  mkdirSync(join(dir, 'agents'), { recursive: true });
  w.watchGlobal(dir);
  try {
    await waitMs(250);
    const teamDir = join(dir, 'teams', 'g1');
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, 'team.md'), '---\nname: G\nmembers: tester\n---\n');
    await waitFor(() => got.some(c => c.resource === 'teams' && c.scope === 'global' && c.root === null));
    await waitMs(800); // teams/ 子目录与 globalDir 本层两路事件同键 → 防抖合并为一次
    // 计时抖动上限 2：两条监听路由落窗即合并为 1；负载下 fs 事件抖动可跨窗（base 层/子目录两路事件
    // 分落两个防抖窗口），恰一断言会假阳 —— 只设上界，正向到辞性已由上方 waitFor 钉死
    assert.ok(got.filter(c => c.resource === 'teams').length <= 2);
  } finally { w.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('写 project/.sunshinex/teams/t1/team.md → 收 teams/project/root（watchProject 挂 teams 子目录）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cw-pteams-'));
  const w = new ConfigWatcher();
  const got: ConfigChange[] = [];
  w.onChange(c => got.push(c));
  mkdirSync(join(root, '.sunshinex', 'teams'), { recursive: true });
  mkdirSync(join(root, '.sunshinex', 'agents'), { recursive: true });
  w.watchProject(root);
  try {
    await waitMs(250);
    const teamDir = join(root, '.sunshinex', 'teams', 't1');
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, 'team.md'), '---\nname: T\nmembers: planner\n---\n');
    await waitFor(() => got.some(c => c.resource === 'teams' && c.scope === 'project' && c.root === root));
    await waitMs(800); // base 层与 teams/ 两路事件同键 → 防抖合并为一次
    // 计时抖动上限 2：两条监听路由落窗即合并为 1；负载下 fs 事件抖动可跨窗，恰一断言会假阳
    assert.ok(got.filter(c => c.resource === 'teams').length <= 2);
  } finally { w.close(); rmSync(root, { recursive: true, force: true }); }
});

// ---------- 全局规范(2026-11-05 设置页「全局规范」面板)：globalDir 本层 SUNSHINE.md 映射 ----------

test('mapFilename: SUNSHINE.md 本层文件映射 sunshine；子目录 SUNSHINE.md 不误判（段循环不含文件名）', () => {
  assert.equal(mapFilename('SUNSHINE.md'), 'sunshine'); // globalDir 本层原子写 rename 事件落最终名
  assert.equal(mapFilename('agents/x/SUNSHINE.md'), 'agents'); // 子目录 SUNSHINE.md 先按段循环归 agents(段优先)
});
