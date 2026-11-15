import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import type { ChatRequest } from '../types';
import { TOOL_OUTPUT_CHAR_LIMIT } from './tools/output-archive';
import { resolveDataDir } from '../config/data-dir';

/** 装配面契约（对标 ~/.claude/projects/<项目>）：缺省数据落全局按工作区隔离，工作区零残留 */
test('Harness：运行时数据落 ~/.sunshinex/projects/<工作区>/data，工作区零残留（HOME 重定向临时目录，用后复原）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-dd-harness-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-dd-harness-home-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevOvr = process.env.SUNSHINEX_DATA_DIR;
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  try {
    delete process.env.SUNSHINEX_DATA_DIR;
    delete process.env.SUNSHINEX_PROJECTS_DIR; // 机器级 projects 根覆盖优先——钉槽去机器相关(同 config/data-dir.test 首测)
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    const h = new Harness({ root, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const r = await h.reactor.run({ goal: 'data-dir 装配验收' }, { maxSteps: 2 }); // goal 含 ASCII——G14.81 门控:纯中文 goal slug 塌缩 learned-N 噪声不落盘
    assert.equal(r.done, true);
    const projects = path.join(fakeHome, '.sunshinex', 'projects');
    const slugs = fs.readdirSync(projects);
    assert.equal(slugs.length, 1, '按工作区 slug 隔离：一个工作区一个数据目录');
    const dataDir = path.join(projects, slugs[0], 'data');
    assert.ok(fs.existsSync(path.join(dataDir, 'skills')), '学习技能沉淀至全局数据目录');
    assert.ok(!fs.existsSync(path.join(root, '.data')), '工作区零残留');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;else process.env.USERPROFILE = prevUserProfile;
    if (prevOvr === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevOvr;
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

/** 记忆提取夹具（pipeline-wiring.test 同款）：主链 chat 即时收束（done），提取轮 submit_memory_items 出牌——
 *  用以驱动 settleMemory 后台消费，钉记忆目录归位 */
function memoryFixture(): ModelAdapter {
  return {
    provider: 'openai',
    capabilities: { chat: true }, // J2 能力位：isModelSummarizer 门禁判据
    complete: async () => {
      throw new Error('complete must not be called on the chat path');
    },
    chat: async (req: ChatRequest) => {
      const prompt = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      if (prompt.includes('memory-extraction')) {
        return {
          finish: 'tool_calls',
          content: '',
          toolCalls: [{ id: 'call_0', name: 'submit_memory_items', argsJson: JSON.stringify({ items: [{ type: 'project', description: 'deploys via pnpm', content: 'deploys run through pnpm scripts' }] }) }],
        };
      }
      return { finish: 'stop', content: 'ok', toolCalls: [] };
    },
  } as unknown as ModelAdapter;
}

/** 环境钉位（注入缝专用）：HOME/USERPROFILE 重定向 fakeHome + 摘数据目录/记忆/学习四覆盖——注入走 opts
 *  不经 env，缺席推导面全落 fakeHome，任何缺省区落盘都会被「零落盘」断言捕获。返回恢复函数 */
function pinHome(fakeHome: string): () => void {
  const keys = ['HOME', 'USERPROFILE', 'SUNSHINEX_DATA_DIR', 'SUNSHINEX_PROJECTS_DIR', 'SUNSHINEX_AUTO_MEMORY', 'SUNSHINEX_LEARNED_SKILLS'] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  for (const k of ['SUNSHINEX_DATA_DIR', 'SUNSHINEX_PROJECTS_DIR', 'SUNSHINEX_AUTO_MEMORY', 'SUNSHINEX_LEARNED_SKILLS'] as const) delete process.env[k];
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** dataDir 注入缝（2026-11-15 sunx P3 Task 1）：注入持久化域目录 → 全部持久化数据面落域，
 *  工作树共享面不动——sandbox safePath/写落盘仍锚工作 root（最高约束：base 语义不可漂移） */
test('Harness：dataDir 注入——tasks 日志/tool-outputs 归档/write 快照 blob/memory 全落注入域，safePath 仍锚工作 root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-dd-inj-root-'));
  const domain = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-dd-inj-domain-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-dd-inj-home-'));
  const restore = pinHome(fakeHome);
  let h: Harness | undefined;
  try {
    h = new Harness({ root, dataDir: domain, model: memoryFixture(), mode: 'full-access', learnSkills: false });
    // ① TaskRegistry 任务日志：submit 即在 <domain>/tasks 建档
    const t = h.tasks.submit({ kind: 'exec', label: 'probe' });
    assert.equal(path.dirname(t.outputFilePath), path.join(domain, 'tasks'), '任务日志应落注入域');
    assert.ok(fs.existsSync(t.outputFilePath), '任务日志建档即存在');
    // ② 工具输出归档：read 超限全文落 <domain>/tool-outputs（恢复指针同源）
    fs.writeFileSync(path.join(root, 'huge.txt'), 'h'.repeat(TOOL_OUTPUT_CHAR_LIMIT + 5_000));
    const r = await h.tools.execute('read', { path: 'huge.txt' }, h.safety);
    assert.ok(r.ok, `read 应成功：${r.ok ? '' : r.error.message}`);
    if (r.ok) {
      const m = r.value.stdout.match(/\[truncated · full output: (.+)\]/);
      assert.ok(m, '超限输出应带落盘恢复指针');
      assert.equal(path.dirname(m![1]!), path.join(domain, 'tool-outputs'), '输出归档应落注入域');
      assert.ok(fs.existsSync(m![1]!), '归档全文已落盘');
    }
    // ③ write 影子快照 blob：pre-image 内容寻址落 <domain>/sessions/_blobs；文件本体仍锚 root（safePath 不漂移）
    fs.writeFileSync(path.join(root, 'probe.txt'), 'old');
    const w = await h.tools.execute('write', { path: 'probe.txt', content: 'anchor' }, h.safety);
    assert.ok(w.ok, `write 应成功：${w.ok ? '' : w.error.message}`);
    assert.equal(fs.readFileSync(path.join(root, 'probe.txt'), 'utf8'), 'anchor', 'safePath 仍锚工作 root——写落盘在工作区');
    const blobs = path.join(domain, 'sessions', '_blobs');
    assert.ok(fs.existsSync(blobs) && fs.readdirSync(blobs).length >= 1, 'write 影子快照 blob 应落注入域');
    // ④ memory：收口提取 → 后台 drain → <domain>/memory
    const run = await h.reactor.run({ goal: 'deploy the app' }, { maxSteps: 2 });
    assert.ok(run.done);
    await h.pipeline.drain();
    assert.ok(fs.existsSync(path.join(domain, 'memory', 'MEMORY.md')), '记忆索引应落注入域');
    assert.ok(
      fs.readdirSync(path.join(domain, 'memory')).some((f) => f.endsWith('.md') && f !== 'MEMORY.md'),
      '记忆记录应落注入域',
    );
    // ⑤ 缺省数据面零落盘（注入即整域接管——缺省区零 slug 数据域创建。技能门面 learned 根按本任务裁定
    // 仍锚 root（learnSkills 处置归 Task 2），其构造期 eager 推导只留空壳 projects 基座，无任何数据目录）
    const projectsBase = path.join(fakeHome, '.sunshinex', 'projects');
    const emptyBase = !fs.existsSync(projectsBase) || fs.readdirSync(projectsBase).length === 0;
    assert.ok(emptyBase, '注入后缺省全局数据区零 slug 数据域落盘');
    assert.ok(!fs.existsSync(path.join(root, '.data')), '工作区零残留');
  } finally {
    h?.tasks.stopAll();
    restore();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(domain, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

/** 基线锚（最高约束）：dataDir 缺席 → 全部持久化面落既有推导（resolveDataDir(root)），与今日逐字节相同 */
test('Harness：dataDir 缺席——tasks 日志/tool-outputs 归档/memory 全落既有缺省推导（基线锚）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-dd-base-root-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-dd-base-home-'));
  const restore = pinHome(fakeHome);
  let h: Harness | undefined;
  try {
    const def = resolveDataDir(root); // 缺省推导：HOME 重定向后 = <fakeHome>/.sunshinex/projects/<slug>/data
    h = new Harness({ root, model: memoryFixture(), mode: 'full-access', learnSkills: false });
    const t = h.tasks.submit({ kind: 'exec', label: 'probe' });
    assert.equal(path.dirname(t.outputFilePath), path.join(def, 'tasks'), '任务日志落既有缺省推导');
    assert.ok(fs.existsSync(t.outputFilePath), '任务日志建档即存在');
    fs.writeFileSync(path.join(root, 'huge.txt'), 'h'.repeat(TOOL_OUTPUT_CHAR_LIMIT + 5_000));
    const r = await h.tools.execute('read', { path: 'huge.txt' }, h.safety);
    assert.ok(r.ok, `read 应成功：${r.ok ? '' : r.error.message}`);
    if (r.ok) {
      const m = r.value.stdout.match(/\[truncated · full output: (.+)\]/);
      assert.ok(m !== null && path.dirname(m[1]!) === path.join(def, 'tool-outputs'), '输出归档落既有缺省推导');
    }
    const run = await h.reactor.run({ goal: 'deploy the app' }, { maxSteps: 2 });
    assert.ok(run.done);
    await h.pipeline.drain();
    assert.ok(fs.existsSync(path.join(def, 'memory', 'MEMORY.md')), '记忆索引落既有缺省推导');
    assert.ok(!fs.existsSync(path.join(root, '.data')), '工作区零残留');
  } finally {
    h?.tasks.stopAll();
    restore();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

/** 混合装配（注入缝的实例隔离判据）：同一进程两次装配（一次注入一次缺席）互不影响——
 *  路径面各自归位，互不串写（全靠构造期单点，无 env/模块级状态） */
test('Harness：混合装配——同一进程注入与缺席两次装配互不影响', async () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-dd-mix-root-a-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-dd-mix-root-b-'));
  const domainA = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-dd-mix-domain-a-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-dd-mix-home-'));
  const restore = pinHome(fakeHome);
  let hA: Harness | undefined;
  let hB: Harness | undefined;
  try {
    hA = new Harness({ root: rootA, dataDir: domainA, model: memoryFixture(), mode: 'full-access', learnSkills: false });
    const defB = resolveDataDir(rootB);
    hB = new Harness({ root: rootB, model: memoryFixture(), mode: 'full-access', learnSkills: false });
    const tA = hA.tasks.submit({ kind: 'exec', label: 'probe-a' });
    const tB = hB.tasks.submit({ kind: 'exec', label: 'probe-b' });
    assert.equal(path.dirname(tA.outputFilePath), path.join(domainA, 'tasks'), '注入装配任务日志落注入域');
    assert.equal(path.dirname(tB.outputFilePath), path.join(defB, 'tasks'), '缺席装配任务日志落缺省推导');
    assert.equal(fs.readdirSync(path.join(domainA, 'tasks')).length, 1, '注入域只收自己的任务日志');
    assert.equal(fs.readdirSync(path.join(defB, 'tasks')).length, 1, '缺省域只收自己的任务日志');
    const rA = await hA.reactor.run({ goal: 'deploy the app' }, { maxSteps: 2 });
    const rB = await hB.reactor.run({ goal: 'deploy the app' }, { maxSteps: 2 });
    assert.ok(rA.done && rB.done);
    await hA.pipeline.drain();
    await hB.pipeline.drain();
    assert.ok(fs.existsSync(path.join(domainA, 'memory', 'MEMORY.md')), '注入装配记忆落注入域');
    assert.ok(fs.existsSync(path.join(defB, 'memory', 'MEMORY.md')), '缺席装配记忆落缺省推导');
    assert.ok(!fs.existsSync(path.join(domainA, 'skills')), 'learnSkills=false：注入域零 learned 沉淀');
  } finally {
    hA?.tasks.stopAll();
    hB?.tasks.stopAll();
    restore();
    for (const d of [rootA, rootB, domainA, fakeHome]) fs.rmSync(d, { recursive: true, force: true });
  }
});
