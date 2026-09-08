import * as path from 'path';
import { LoopDeps } from '../../loop/engine';
import { LoopContext } from '../../types';
import { LoopTemplate, codeRefactorTemplate, codeReviewTemplate, testLoopTemplate } from '../../loop/templates';
import { buildDeps } from '../../runtime';
import type { CliArgs } from '../index';

/** 规则校验器 opts：与 loop 模板 TemplateOpts.ruleCheckers 同构 */
export interface TemplateRuleOpts {
  ruleCheckers?: Record<string, (io: { ctx: LoopContext; goal: string }) => Promise<boolean> | boolean>;
}

const FACTORIES: Record<string, (deps: LoopDeps, opts?: TemplateRuleOpts) => ReturnType<typeof codeRefactorTemplate>> = {
  'code-refactor': (d, o) => codeRefactorTemplate(d, o),
  'test-loop': (d, o) => testLoopTemplate(d, o),
  'code-review': (d, o) => codeReviewTemplate(d, o),
};

export function resolveTemplate(deps: LoopDeps, name: string, opts?: TemplateRuleOpts): LoopTemplate {
  const f = FACTORIES[name];
  if (!f) throw new Error(`未知模板：${name}（可选 ${Object.keys(FACTORIES).join('/')}）`);
  return f(deps, opts);
}

export async function runLoop(args: CliArgs): Promise<void> {
  const dir = args.positional[0];
  if (!dir) throw new Error('用法：sunshinex run <dir> --template=test-loop --goal="目标（验收标准：id=描述）"');
  const root = path.resolve(dir);
  const goal = String(args.flags.goal ?? '');
  if (!goal) throw new Error('缺少 --goal="目标（验收标准：id=描述）"');
  const template = String(args.flags.template ?? 'test-loop');
  const deps = buildDeps(root, args.flags);
  const tpl = resolveTemplate(deps, template);
  console.log(`[run] root=${root} template=${template}`);
  const r = await tpl.engine.run(goal);
  console.log(JSON.stringify({ status: r.status, iterations: r.iterations, tokensUsed: r.tokensUsed, criteria: r.criteria, reply: r.reply, error: r.error }, null, 2));
  if (r.status !== 'done') process.exitCode = 1;
}
