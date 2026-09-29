import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProcessSandbox } from './sandbox';

test('ExecOpts.wrap：wrap.file 接管进程位，grant 前缀 + `--` + shell + 命令依次入 argv', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sbx-wrap-'));
  const script = path.join(tmp, 'argv.js');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(1)));');
  const sandbox = new ProcessSandbox();
  const r = await sandbox.exec('echo hi', { wrap: { file: process.execPath, args: [script] } });
  assert.ok(r.ok, JSON.stringify(r));
  const argv = JSON.parse(r.value.stdout.trim()) as string[];
  assert.equal(argv[0], script);
  assert.ok(argv.includes('--'), 'grant 段与 shell 段以 -- 分隔');
  assert.ok(argv.includes('echo hi'), '原命令保持在 shell 位置执行');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('execBackground 同形态消费 wrap', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sbx-wrap-bg-'));
  const script = path.join(tmp, 'argv.js');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(1)));');
  const sandbox = new ProcessSandbox();
  // 形态偏差说明（简报括注授权）：现实现 execBackground 返回 Result<{ pid }>，输出经 opts.onData 增量回调
  // （返回句柄无 onData 注入口），按实际形态等价改写数据流：回调收集 + killBackground 收割，语义不变
  let acc = '';
  const bg = await sandbox.execBackground('echo hi-bg', {
    wrap: { file: process.execPath, args: [script] },
    onData: (chunk: string) => { acc += chunk; },
  });
  assert.ok(bg.ok, '后台任务应提交成功');
  const out = await new Promise<string>((resolve) => {
    // 等待窗口按平台差异化（2026-09-29 真机 win32 全量负载下 shell+wrap node 叠加冷启动超 1.5s 即 JSON.parse 空串红）：win32 4s / POSIX 1.5s，收到输出即提前收敛
    const deadline = process.platform === 'win32' ? 4000 : 1500;
    const start = Date.now();
    const timer = setInterval(() => { if (acc.includes('[') || Date.now() - start > deadline) { clearInterval(timer); resolve(acc); } }, 50);
  });
  const argv = JSON.parse(out.trim()) as string[];
  assert.equal(argv[0], script);
  assert.ok(argv.includes('echo hi-bg'));
  sandbox.killBackground(bg.value.pid);
  // Windows taskkill /F 同步退出后句柄释放有延迟（2026-09-29 真机 EPERM 实锤），短重试退避后删目录
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); break; }
    catch (err) { if ((err as { code?: string }).code !== 'EPERM' || i === 9) throw err; }
    const wait = setTimeout(() => { void wait; }, 200);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); void wait;
  }
});
