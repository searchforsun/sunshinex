import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskBoard } from './board';
import { TeamStore } from './store';
import type { SubagentRunner } from '../harness/subagent';
import type { TaskRegistry } from '../harness/tasks';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('kill -9 于 claimed 时刻:重启恢复,任务回池、事件完整、可继续追加(spec §7.6)', async () => {
  const tmp = tmpdir('sunshinex-tbcrash-');
  const child = spawn(process.execPath, [path.resolve(__dirname, 'crash-fixture.js')], {
    env: { ...process.env, SUNSHINEX_DATA_DIR: path.join(tmp, 'data') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (c: string) => { out += c; });
  try {
    // 等 fixture 打印 READY(claimed 已落盘)后强杀;10s 兜底定时器在 READY 命中时即清(不留悬挂句柄)
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (out.includes('READY')) { clearInterval(t); clearTimeout(fallback); resolve(); }
      }, 50);
      const fallback = setTimeout(() => { clearInterval(t); resolve(); }, 10_000);
    });
    assert.ok(out.includes('READY'), 'fixture 达到 claimed 挂起点');
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    // 存活性证明(4c 取最简稳健项):杀时进程仍活着——exitCode 非零或信号终局(fixture 两笔 create 均已成功才挂到此处)
    assert.ok(child.exitCode !== 0 || child.signalCode !== null, `强杀后应非零退出/信号终局,实际 exitCode=${child.exitCode} signal=${child.signalCode}`);
    // 重启恢复:同目录新协调器
    const runner = { runSubagent: async () => ({ ok: true as const, value: { reply: 'r', tokens: 1 } }) } as unknown as SubagentRunner;
    const registry = { submit: () => ({ id: 'b9', stop: () => {} }), append: () => {}, finish: () => {} } as unknown as TaskRegistry;
    const board = new TaskBoard({ store: new TeamStore(path.join(tmp, 'data', 'teams', 'main')), runner, registry });
    board.init();
    const s = board.snapshot();
    assert.equal(s.tasks['t1']!.status, 'pending', 'claimed 回池(§7.4)');
    assert.ok(s.tasks['t1']!.artifact?.conclusion === undefined, '无半成品 artifact');
    assert.equal(s.tasks['t2']!.status, 'pending', '依赖任务原样');
    // 恢复后可继续:create 成功且事件流追加畅通
    const r = board.create({ title: 'C', spec: 'c', dependsOn: ['t1'] });
    assert.ok(r.ok);
    await new Promise((r2) => setImmediate(r2));
    // events.jsonl 无撕裂行:全部可解析
    const lines = fs.readFileSync(path.join(tmp, 'data', 'teams', 'main', 'events.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0);
    for (const line of lines) JSON.parse(line);
    assert.ok(lines.some((l) => l.includes('recovered after restart')), '自愈事件在流中');
  } finally {
    // 收尸守卫:READY 断言失败等早退路径也保证 kill(已退出则守卫跳过,双杀无害);等退出后再清场防文件占用
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(resolve, 5_000).unref?.();
      });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('进程内变体:events.jsonl 尾行截断,重放跳过不炸(Task 2 语义的崩溃面复验)', () => {
  const tmp = tmpdir('sunshinex-tbcrash2-');
  try {
    const dir = path.join(tmp, 'teams', 'main');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'events.jsonl'), [
      JSON.stringify({ t: 'task-created', taskId: 't1', title: 'A', spec: 'a', dependsOn: [], ts: 1 }),
      '{"t":"task-cr',
    ].join('\n'), 'utf8');
    const store = new TeamStore(dir);
    const s = store.load();
    assert.equal(s.tasks['t1'] !== undefined, true, '完好行生效');
    assert.equal(s.seq, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
