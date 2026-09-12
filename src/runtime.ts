import { Harness } from './harness';
import { LoopDeps } from './loop/engine';
import { ModelAdapter, OpenAIAdapter, ScriptedAdapter, StubAdapter } from './model/adapter';

/** 模型装配唯一决策点（CLI run/pipeline 与 TUI 共用，避免各入口各写一套）：--model 可选 openai|scripted|stub，缺省 openai；配置由进程入口 loadEnv 从 .env 装载（已导出环境变量优先） */
export function buildModel(flags: Record<string, string | boolean>): ModelAdapter {
  if (flags.model === 'scripted') return new ScriptedAdapter([]);
  if (flags.model === 'stub') return new StubAdapter();
  return new OpenAIAdapter({ provider: 'openai' });
}

/** 统一装配根（composition root）：CLI/TUI/GUI 三面共用的唯一运行时装配点；root 为项目目录 */
export function buildDeps(root: string, flags: Record<string, string | boolean>): LoopDeps {
  const h = new Harness({ root, mode: 'dontAsk' });
  return { safety: h.safety, registry: h.tools, context: h.context, model: buildModel(flags), skills: h.skills, root };
}
