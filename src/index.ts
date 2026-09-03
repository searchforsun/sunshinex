import * as path from 'path';
import { loadSunshinex } from './config';
import { loadSkills } from './harness/skills';
import { loadPlugins } from './plugins/loader';
import { ToolRegistry } from './harness/tools';
import { Memory } from './harness/memory';
import { LoopEngine } from './loop/engine';
import { GraphEngine } from './graph/engine';
import { StubAdapter, ModelRouter } from './model/adapter';
import { LocalStore } from './storage/store';

const ROOT = process.cwd();

/** 自检：加载全部配置与清单，实例化三层引擎，打印骨架摘要 */
function selfcheck(): void {
  const ctx = loadSunshinex(ROOT);
  const skills = loadSkills(ROOT);
  const plugins = loadPlugins(ROOT);
  const tools = new ToolRegistry();
  const memory = new Memory();
  const loop = new LoopEngine();
  const graph = new GraphEngine();
  const router = new ModelRouter();
  router.bind('small', new StubAdapter());
  const store = new LocalStore(path.join(ROOT, '.data'));

  console.log('SunshineX skeleton selfcheck OK');
  console.log('project :', ctx?.name ?? '(no SUNSHINE.md)');
  console.log('rules   :', ctx?.rules.length ?? 0);
  console.log('skills  :', skills.map((s) => `${s.id}@${s.version}`).join(', ') || '(none)');
  console.log('plugins :', plugins.map((p) => `${p.id}@${p.version}`).join(', ') || '(none)');
  console.log('loop/graph/router/store :', [loop, graph, router, store, tools, memory].length, 'instances ready');
}

const args = process.argv.slice(2);
if (args.includes('--selfcheck')) {
  selfcheck();
} else {
  console.log('SunshineX skeleton loaded. Use --selfcheck to verify.');
}
