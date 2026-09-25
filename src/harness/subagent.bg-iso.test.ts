import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { ScriptedAdapter } from '../model/adapter';
import { AgentRegistry, SubagentRunner } from './subagent';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { SafetyChain } from './security/chain';
import { ProcessSandbox } from './security/sandbox';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { DryRun } from './security/dryrun';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { TaskRegistry } from './tasks';

/**
 * 回归（2026-09-25 用户后台子代理会话日志）：
 * ① 后台结论落盘只写 firstLine(reply)，多行报告丢弃 → 模型读日志只见结论首行，被迫全部前台重跑；
 * ② spawn 入参 isolation 传字符串 "null"（模型照 schema ['string','null'] 字面形态）时，
 *    工具 executor 入口的 validateSpawnInput 先于 runSubagent 内部的 normalizeSpawnInput 执行，
 *    直接 INVALID_ARG "Unknown isolation: null" → 模型反复改参同错空转（与 agent_id "null" 同病）。
 */

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-bg-iso-'));
  const git = (args: string[]) => execSync(`git ${args.join(' ')}`, { cwd: root, stdio: 'pipe' });
  git(['init', '-q']);
  git(['-c', 'user.email=t@local', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return root;
}

function withIso(fn: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-bg-t-'));
  const prev = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = dataDir;
  return fn(dataDir).finally(() => {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
}

test('后台 spawn 入参 isolation="null" 字面量归一（不再 Unknown isolation 空转）', async () =>
  withIso(async () => {
    const root = makeRepo();
    try {
      const model = new ScriptedAdapter([
        JSON.stringify({ tool: 'spawn', input: { prompt: '只读调研：列出目录结构', label: 'probe', background: true, isolation: 'null' } }),
        JSON.stringify({ done: true, reply: '主链完成' }),
      ]);
      const h = new Harness({ root, mode: 'dontAsk', model, learnSkills: false });
      const r = await h.reactor.run({ goal: 'g' }, { maxSteps: 5 });
      assert.ok(
        !r.steps.some((s) => s.observation.includes('Unknown isolation')),
        `isolation:"null" 应回落无隔离形态，实际链：${JSON.stringify(r.steps.map((s) => s.observation))}`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }));

test('后台子代理结论全文落任务日志（多行报告不再只留首行）', async () =>
  withIso(async (dataDir) => {
    const root = makeRepo();
    try {
      const report = ['## 结论一', '细节 A', '细节 B'].join('\n');
      const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
      const registry = new ToolRegistry();
      for (const t of builtinTools(safety, root)) registry.register(t);
      registry.unregister('spawn');
      registry.unregister('todo_write');
      registry.unregister('ask_question');
      registry.unregister('worktree');
      const store = new FileStore(path.join(dataDir, '.data'));
      const context = new ContextManager(root, store);
      const agents = new AgentRegistry();
      agents.registerBuiltins();
      const tasks = new TaskRegistry(path.join(dataDir, 'tasks'));
      const parentModel = new ScriptedAdapter(['{"done":true,"reply":"unused"}']);
      const childModel = new ScriptedAdapter([JSON.stringify({ done: true, reply: report })]);
      const runner = new SubagentRunner({ registry, safety, context, model: childModel, tasks }, agents);
      runner.attachParent(() => ({ maxSteps: 10, tokenCap: 50_000 }));
      const bg = runner.spawnBackground({ prompt: '后台调研任务', label: 'bg' });
      const log = bg.outputFilePath;
      for (let i = 0; i < 100; i++) {
        if (fs.readFileSync(log, 'utf8').includes('[done]')) break;
        await new Promise((res) => setTimeout(res, 50));
      }
      const content = fs.readFileSync(log, 'utf8');
      assert.match(content, /\[conclusion\]/, '结论行应落任务日志');
      for (const line of ['## 结论一', '细节 A', '细节 B']) {
        assert.ok(content.includes(line), `结论全文应落日志，缺行：${line}\n--- 日志 ---\n${content}`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }));
