// 崩溃注入 fixture(测试子进程拉起):构造真实 TaskBoard(假 runner 首任务永不返回),
// 创建依赖链任务 t1→t2,drain 派发 t1 至 claimed(事件已落盘)后向 stdout 打印 READY 并挂住,
// 等待父进程强杀。env SUNSHINEX_DATA_DIR 由父进程定向临时目录。
import * as path from 'path';
import { TaskBoard } from './board';
import { TeamStore } from './store';
import { resolveDataDir } from '../config/data-dir';
import type { SubagentRunner } from '../harness/subagent';
import type { TaskRegistry } from '../harness/tasks';

function main(): void {
  const root = process.cwd();
  const runner = {
    runSubagent: () => new Promise<{ ok: boolean; value: { reply: string; tokens: number } }>(() => {}),
  } as unknown as SubagentRunner;
  const registry = {
    submit: () => ({ id: 'fixture', stop: () => {} }),
    append: () => {},
    finish: () => {},
  } as unknown as TaskRegistry;
  const board = new TaskBoard({
    store: new TeamStore(path.join(resolveDataDir(root), 'teams', 'main')),
    runner,
    registry,
  });
  board.init();
  const a = board.create({ title: 'A', spec: 'hang forever', dependsOn: [] });
  board.create({ title: 'B', spec: 'b', dependsOn: ['t1'] });
  if (!a.ok) {
    process.stderr.write(`fixture create failed: ${a.error.message}\n`);
    process.exit(1);
  }
  // drain 是异步的:等微任务两拍保证 claimed 落盘后再报 READY
  setImmediate(() => {
    setImmediate(() => {
      process.stdout.write('READY\n');
      setInterval(() => {}, 1 << 30); // 挂住等杀
    });
  });
}
main();
