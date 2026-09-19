import { Harness } from './harness';
import { LoopDeps } from './loop/engine';
import { ModelAdapter, ModelRouter, OpenAIAdapter, ScriptedAdapter, StubAdapter } from './model/adapter';
import { ModelTier } from './types';

/** 模型装配唯一决策点（CLI run/pipeline 与 TUI 共用，避免各入口各写一套）：--model 可选 openai|scripted|stub，缺省 openai；配置由进程入口 loadEnv 从 .env 装载（已导出环境变量优先） */
export function buildModel(flags: Record<string, string | boolean>): ModelAdapter {
  if (flags.model === 'scripted') return new ScriptedAdapter([]);
  if (flags.model === 'stub') return new StubAdapter();
  return new OpenAIAdapter({ provider: 'openai' });
}

/** 校验档位值：--tier / /model 用户级参数只认 small|medium|large，其余一律 undefined（调用方按缺省处理） */
export function parseTier(value: unknown): ModelTier | undefined {
  return value === 'small' || value === 'medium' || value === 'large' ? value : undefined;
}

/**
 * 按档模型绑定（对标 Claude Code 多模型形态）：SUNSHINEX_MODEL_SMALL/MEDIUM/LARGE 显式配置的档位各绑一份
 * OpenAI 协议适配器（端点与密钥复用主配置），未配置档位回退主模型；全未配置返回 undefined（调用方退单模型装配）。
 * 档位是用户级会话参数：换档即换模型，属用户显式触发的跨模型重算事件（CLAUDE.md §11），系统侧不做任何自动换档。
 */
export function buildTierRouter(flags: Record<string, string | boolean>): ModelRouter | undefined {
  const tiers: Array<{ tier: ModelTier; env: string }> = [
    { tier: 'small', env: 'SUNSHINEX_MODEL_SMALL' },
    { tier: 'medium', env: 'SUNSHINEX_MODEL_MEDIUM' },
    { tier: 'large', env: 'SUNSHINEX_MODEL_LARGE' },
  ];
  let bound = 0;
  const router = new ModelRouter();
  for (const { tier, env } of tiers) {
    const model = process.env[env];
    if (model && model.length > 0) {
      router.bind(tier, new OpenAIAdapter({ provider: 'openai', model }));
      bound++;
    }
  }
  if (bound === 0) return undefined;
  return router.bindDefault(buildModel(flags));
}

/** 统一装配根（composition root）：CLI/TUI/GUI 三面共用的唯一运行时装配点；root 为项目目录 */
export function buildDeps(root: string, flags: Record<string, string | boolean>): LoopDeps {
  const h = new Harness({ root, mode: 'dontAsk' });
  const router = buildTierRouter(flags);
  const tier = parseTier(flags.tier) ?? parseTier(process.env.SUNSHINEX_TIER);
  return {
    safety: h.safety,
    registry: h.tools,
    context: h.context,
    model: buildModel(flags),
    skills: h.skills,
    root,
    runner: h.runner,
    // 后台沉淀管线透传（规格 §3.5）：CLI 命令收尾 await drain，退出前清空队列
    pipeline: h.pipeline,
    // 沉淀双钩子透传（规格 §3.1）：loop 内构造的 Reactor 收口同样零等待入队（此前 loop 路径未接＝真缺口）
    ...h.settleHooks,
    // 显式按档绑定才注入 router（reactor 按用户级档位取对应适配器）；--tier 注入 run 级档位常量
    ...(router ? { router } : {}),
    ...(tier ? { tier } : {}),
  };
}
