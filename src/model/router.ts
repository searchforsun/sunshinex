/** 三档算力路由（small/medium/large）：提示感知选档 + 档位→适配器绑定表——自 adapter.ts 纯搬移（H4 拆件）。
 *  ModelAdapter 契约为**纯 type 引用**（import type 编译期擦除，产物零 require './adapter'）：
 *  adapter.ts 对本件再导出不构成 CJS 运行时环；契约本体仍登记 adapter.ts（消费面不变） */
import type { ModelAdapter } from './adapter';
import type { ModelTier, RouteDecision } from '../types';

/** 路由提示：调用方对本次任务的算力信号（Graph 角色/复杂度） */
export interface RouteHint {
  complexity?: 'low' | 'mid' | 'high';
  role?: string;
}

/** 业务规则：评审/编码类角色需要更强模型，规划类居中 */
const ROLE_TIER: Record<string, ModelTier> = {
  critic: 'large',
  coder: 'large',
  planner: 'medium',
};

const COMPLEXITY_TIER: Record<NonNullable<RouteHint['complexity']>, ModelTier> = {
  low: 'small',
  mid: 'medium',
  high: 'large',
};

/** 三档算力路由：small/medium/large */

export class ModelRouter {
  private adapters = new Map<ModelTier, ModelAdapter>();
  private fallback: ModelAdapter | null = null;

  /** 默认档：所有未显式绑定的档位回退到此 adapter */
  bindDefault(adapter: ModelAdapter): this {
    this.fallback = adapter;
    return this;
  }

  bind(tier: ModelTier, adapter: ModelAdapter): void {
    this.adapters.set(tier, adapter);
  }

  /** 该档已绑定 → 直取；未绑定但有默认 → 回退默认；两者皆无 → 抛错（装配错误快速失败） */
  resolve(tier: ModelTier): ModelAdapter {
    const a = this.adapters.get(tier);
    if (a) return a;
    if (this.fallback) return this.fallback;
    throw new Error(`no adapter bound for tier ${tier}`);
  }

  /** 显式绑定档快照（不含默认回退） */
  boundTiers(): ModelTier[] {
    return [...this.adapters.keys()];
  }

  /** 提示感知路由：role 优先于 complexity，均缺省回退 medium；reason 留痕决策依据 */
  route(hint?: RouteHint): RouteDecision {
    let tier: ModelTier = 'medium';
    let source = 'default:medium';
    if (hint?.role && ROLE_TIER[hint.role]) {
      tier = ROLE_TIER[hint.role];
      source = `role:${hint.role}`;
    } else if (hint?.complexity) {
      tier = COMPLEXITY_TIER[hint.complexity];
      source = `complexity:${hint.complexity}`;
    }
    const bound = this.adapters.has(tier);
    const reason = bound ? source : `${source} fallback:default`;
    return { tier, reason, adapterProvider: this.resolve(tier).provider, bound };
  }
}
