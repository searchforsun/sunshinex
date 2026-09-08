import { Harness } from './harness';
import { LoopDeps } from './loop/engine';
import { OpenAIAdapter, ScriptedAdapter, StubAdapter } from './model/adapter';

/** 统一装配根（composition root）：CLI/TUI/GUI 三面共用的唯一运行时装配点；root 为项目目录；--model 可选 openai|scripted|stub，缺省 openai（配置由进程入口 loadEnv 从 .env 装载，已导出环境变量优先） */
export function buildDeps(root: string, flags: Record<string, string | boolean>): LoopDeps {
  const h = new Harness({ root, mode: 'dontAsk' });
  const model =
    flags.model === 'scripted' ? new ScriptedAdapter([]) :
    flags.model === 'stub' ? new StubAdapter() :
    new OpenAIAdapter({ provider: 'openai' });
  return { safety: h.safety, registry: h.tools, context: h.context, model, skills: h.skills };
}
