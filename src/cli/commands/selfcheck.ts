import * as fs from 'fs';
import * as path from 'path';
import { Harness } from '../../harness';
import { softwarePipelineTemplate } from '../../graph/templates';
import { codeReviewTemplate } from '../../loop/templates';
import { StubAdapter } from '../../model/adapter';
import { resolveKbEnv } from '../../config/env';
import { parseMcpServers, parseSunshinex } from '../../config';
import type { CliArgs } from '../index';

/** 骨架自检：实例化 Harness 门面，聚合五大能力并打印骨架摘要 */
export function runSelfcheck(_args: CliArgs): void {
  const h = new Harness({ root: process.cwd() });
  const perceived = h.perception.scan();
  console.log('SunshineX skeleton selfcheck OK');
  console.log('project :', perceived.project?.name ?? '(no SUNSHINE.md)');
  console.log('rules   :', perceived.project?.rules.length ?? 0);
  console.log('files   :', perceived.files.length, 'deps:', perceived.dependencies.length);
  console.log('tools   :', h.tools.list().map((t) => t.name).join(', '));
  const sunshinePath = path.join(process.cwd(), 'SUNSHINE.md');
  const mcpServers = fs.existsSync(sunshinePath) ? parseMcpServers(parseSunshinex(fs.readFileSync(sunshinePath, 'utf8'))) : [];
  const mcpToolCount = h.tools.list().filter((t) => t.name.startsWith('mcp__')).length;
  console.log('mcp     :', `${mcpServers.length} servers configured, ${mcpToolCount} tools registered（登记制闸门，空 = 全禁）`);
  console.log('harness :', [h.perception, h.tools, h.security, h.sandbox, h.dryrun, h.context, h.reactor].length, 'modules ready');
  console.log('context :', `缓存命中率 ${h.context.session.hitRate().toFixed(1)}`);
  const kbEnv = resolveKbEnv(process.env as Record<string, string | undefined>);
  console.log('knowledge:', `kb_search ready (backend=${kbEnv.backend}, embedding=${kbEnv.embeddingBaseUrl && kbEnv.embeddingApiKey ? 'configured' : '未配置→调用时降级'})`);
  const skillHello = h.skills.resolve('hello-sunshine', { name: 'selfcheck' });
  console.log('skills  :', `${h.skills.list().length} loaded, resolve=${skillHello.ok ? 'ok' : 'fail'}`);
  const loopReady = codeReviewTemplate({ safety: h.safety, registry: h.tools, context: h.context, model: new StubAdapter() });
  console.log('loop    :', `${loopReady.name} template ready (${loopReady.nodes.length} nodes)`);
  const graphReady = softwarePipelineTemplate({ safety: h.safety, registry: h.tools, context: h.context, model: new StubAdapter() });
  console.log('graph   :', `${graphReady.name} template ready (${graphReady.nodes.length} nodes)`);
}
