import * as fs from 'fs';
import * as path from 'path';
import { Harness } from '../../harness';
import { softwarePipelineTemplate } from '../../graph/templates';
import { codeReviewTemplate } from '../../loop/templates';
import { ModelAdapter, StubAdapter, UsageHooks } from '../../model/adapter';
import { resolveKbEnv } from '../../config/env';
import { parseMcpServers, parseSunshinex } from '../../config';
import { SessionController } from '../../tui/session';
import { ReplyStreamExtractor } from '../../tui/stream-extractor';
import type { CliArgs } from '../index';

/** 自检用流式适配器：合成 reasoning → token 逐字流 → usage 上报（离线、零网络，驱动流式管线冒烟） */
class SelfcheckStreamAdapter implements ModelAdapter {
  readonly provider = 'selfcheck-stream';
  async complete(): Promise<string> {
    return '{"done":true,"reply":"流式自检 OK"}';
  }
  async completeStream(_prompt: string, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<string> {
    hooks?.onReasoning?.('自检思考');
    const text = '{"done":true,"reply":"流式自检 OK"}';
    for (const ch of text) onDelta(ch);
    hooks?.onUsage?.(3);
    return text;
  }
}

/** 骨架自检：实例化 Harness 门面，聚合五大能力并打印骨架摘要 */
export async function runSelfcheck(_args: CliArgs): Promise<void> {
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
  console.log('learned :', h.skills.learnedCount());
  const usage = h.ledger.summary();
  console.log('usage  :', `${usage.runs} runs / ${usage.tokens} tokens`);
  // TUI 流式管线冒烟：合成流式适配器驱动 SessionController（reasoning→thinking 折叠、token→reply 流式、usage→本轮 tokens）
  const tuiCtrl = new SessionController({ root: process.cwd(), model: new SelfcheckStreamAdapter() });
  await tuiCtrl.submit('selfcheck tui 流式冒烟');
  await tuiCtrl.waitIdle();
  const tuiState = tuiCtrl.getState();
  const tuiReply = tuiState.messages.filter((m) => m.role === 'assistant').map((m) => m.text).join('');
  const tuiThink = tuiState.messages.filter((m) => m.role === 'thinking').length;
  if (tuiReply !== '流式自检 OK') throw new Error(`tui 流式答复异常：${tuiReply}`);
  if (tuiThink < 1) throw new Error('tui 思考折叠未生效');
  if (tuiState.metrics.turnTokens !== 3) throw new Error(`tui 本轮 tokens 异常：${tuiState.metrics.turnTokens}`);
  // 增量提取器：跨 chunk 的协议 JSON 应只透出 reply 文本
  let extracted = '';
  const ex = new ReplyStreamExtractor((t) => { extracted += t; });
  for (const chunk of ['{"done":true,"re', 'ply":"流式提取 OK"}']) ex.feed(chunk);
  if (extracted !== '流式提取 OK') throw new Error(`流式提取异常：${extracted}`);
  console.log('tui     :', `流式管线 OK（${tuiState.messages.length} 条消息；答复「${tuiReply}」；思考折叠 ${tuiThink} 段；提取「${extracted}」）`);
  const loopReady = codeReviewTemplate({ safety: h.safety, registry: h.tools, context: h.context, model: new StubAdapter() });
  console.log('loop    :', `${loopReady.name} template ready (${loopReady.nodes.length} nodes)`);
  const graphReady = softwarePipelineTemplate({ safety: h.safety, registry: h.tools, context: h.context, model: new StubAdapter() });
  console.log('graph   :', `${graphReady.name} template ready (${graphReady.nodes.length} nodes)`);
}
