import { Harness } from './harness';
import { codeReviewTemplate } from './loop/templates';
import { StubAdapter } from './model/adapter';

const ROOT = process.cwd();

/** 自检：实例化 Harness 门面，聚合五大能力并打印骨架摘要 */
function selfcheck(): void {
  const h = new Harness({ root: ROOT });
  const perceived = h.perception.scan();
  console.log('SunshineX skeleton selfcheck OK');
  console.log('project :', perceived.project?.name ?? '(no SUNSHINE.md)');
  console.log('rules   :', perceived.project?.rules.length ?? 0);
  console.log('files   :', perceived.files.length, 'deps:', perceived.dependencies.length);
  console.log('tools   :', h.tools.list().map((t) => t.name).join(', '));
  console.log('harness :', [h.perception, h.tools, h.security, h.sandbox, h.dryrun, h.context, h.reactor].length, 'modules ready');
  const loopReady = codeReviewTemplate({ safety: h.safety, registry: h.tools, context: h.context, model: new StubAdapter() });
  console.log('loop    :', `${loopReady.name} template ready (${loopReady.nodes.length} nodes)`);
}

const args = process.argv.slice(2);
if (args.includes('--selfcheck')) {
  selfcheck();
} else {
  console.log('SunshineX skeleton loaded. Use --selfcheck to verify.');
}
