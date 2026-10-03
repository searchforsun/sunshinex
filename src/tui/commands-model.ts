import { EFFORT_ORDER, parseEffort } from '../model/adapter';
import { parseTier } from '../runtime';
import { formatTokens } from './format';
import { t } from '../i18n';
import type { SessionController } from './session';

// D17 拆分件步3（docs/TECH-DEBT-SURVEY.md H1）：模型选择命令族（/model /model-tier /model-effort）函数体
// 迁出，handleSlash 骨架留 session 只做分发；状态经 ctrl.state 单点读写，切换器经 ctrl.modelSwitcher。

/** /model：多源多模型切换（settings providers 键）：选择卡即选即切，对后续任务生效（整场恒定，CLAUDE.md §11 重算事件口径） */
export async function modelSwitch(ctrl: SessionController): Promise<void> {
  if (ctrl.state.status !== 'idle') {
    ctrl.pushMsg('system', t('A task is running; /model unavailable now', '当前有任务进行中，暂不能执行 /model'), { level: 'warn' });
    return;
  }
  const sw = ctrl.modelSwitcher;
  if (!sw || sw.choices().length === 0) {
    ctrl.pushMsg('system', t(
      'No switchable models: add a "providers" array to settings.json (each entry: name + baseUrl + models), then restart',
      '无可切换模型：在 settings.json 增加 "providers" 数组（每项 name + baseUrl + models）后重启',
    ), { level: 'warn' });
    return;
  }
  const current = sw.currentId();
  const options = [
    // default 仅在主模型显式配置（model 键 / SUNSHINEX_MODEL）时露出：未配置时缺省内芯本就是首个 provider 模型
    ...(sw.hasExplicitDefault() ? [{ label: 'default', description: current === undefined ? t('current (main model)', '当前（主模型）') : undefined }] : []),
    ...sw.choices().map((c) => ({
      label: c.id,
      description: c.id === current
        ? t('current', '当前')
        : [c.baseUrl, c.contextWindow !== undefined ? formatTokens(c.contextWindow) : undefined, c.reasoningEffort !== undefined ? `effort ${c.reasoningEffort}` : undefined].filter((x) => x !== undefined).join(' · '),
    })),
  ];
  const answer = await ctrl.askUser({
    question: t(current ? `Switch model (current: ${current})` : 'Switch model (current: main model)', current ? `切换模型（当前 ${current}）` : '切换模型（当前主模型）'),
    options,
  });
  if (answer.type !== 'selected') {
    ctrl.pushMsg('system', t('Model unchanged', '模型未变更'));
    return;
  }
  const picked = answer.labels[0] ?? '';
  if (picked === 'default') {
    sw.switchTo(undefined);
    ctrl.state = { ...ctrl.state, modelId: undefined, modelLabel: undefined, modelWindow: undefined };
    ctrl.notify();
    ctrl.logModel();
    ctrl.pushMsg('system', t('Model cleared; the main model applies to subsequent tasks', '模型已清除；后续任务用主模型'));
    return;
  }
  if (!sw.switchTo(picked)) return; // 选择卡来源即清单，正常不可达；防御配置漂移
  ctrl.state = { ...ctrl.state, modelId: picked, modelLabel: sw.label, ...(sw.contextWindow !== undefined ? { modelWindow: sw.contextWindow } : { modelWindow: undefined }) };
  ctrl.notify();
  ctrl.logModel();
  ctrl.pushMsg('system', t(`Model set to ${picked}; applies to subsequent tasks`, `模型已设为 ${picked}；对后续任务生效`));
}

/** /model-tier：用户级档位切换（small/medium/large 选择卡），对后续任务生效 */
export async function modelTierSwitch(ctrl: SessionController): Promise<void> {
  if (ctrl.state.status !== 'idle') {
    ctrl.pushMsg('system', t('A task is running; /model-tier unavailable now', '当前有任务进行中，暂不能执行 /model-tier'), { level: 'warn' });
    return;
  }
  const current = ctrl.state.tier;
  const answer = await ctrl.askUser({
    question: t(current ? `Switch model tier (current: ${current})` : 'Switch model tier (current: default)', current ? `切换模型档位（当前 ${current}）` : '切换模型档位（当前默认）'),
    options: (['small', 'medium', 'large'] as const).map((tier) => ({ label: tier, description: tier === current ? t('current', '当前档') : undefined })),
  });
  if (answer.type !== 'selected') {
    ctrl.pushMsg('system', t('Model tier unchanged', '模型档位未变更'));
    return;
  }
  const tier = parseTier(answer.labels[0] ?? '');
  if (!tier) return;
  ctrl.state = { ...ctrl.state, tier };
  ctrl.notify();
  ctrl.logModel();
  ctrl.pushMsg('system', t(`Model tier set to ${tier}; applies to subsequent tasks`, `模型档位已设为 ${tier}；对后续任务生效`));
}

/** /model-effort：思考强度切换（选择卡，default 清除回适配器缺省），对后续任务生效 */
export async function modelEffortSwitch(ctrl: SessionController): Promise<void> {
  if (ctrl.state.status !== 'idle') {
    ctrl.pushMsg('system', t('A task is running; /model-effort unavailable now', '当前有任务进行中，暂不能执行 /model-effort'), { level: 'warn' });
    return;
  }
  const current = ctrl.state.effort;
  const answer = await ctrl.askUser({
    question: t(current ? `Switch reasoning effort (current: ${current})` : 'Switch reasoning effort (current: adapter default)', current ? `切换思考强度（当前 ${current}）` : '切换思考强度（当前适配器缺省）'),
    options: [...EFFORT_ORDER, 'default' as const].map((v) => ({ label: v, description: v === current ? t('current override', '当前覆盖') : undefined })),
  });
  if (answer.type !== 'selected') {
    ctrl.pushMsg('system', t('Reasoning effort unchanged', '思考强度未变更'));
    return;
  }
  const value = answer.labels[0] ?? '';
  if (value === 'default') {
    ctrl.state = { ...ctrl.state, effort: undefined };
    ctrl.notify();
    ctrl.logModel();
    ctrl.pushMsg('system', t('Reasoning effort cleared; adapter default applies to subsequent tasks', '思考强度已清除；后续任务回适配器缺省'));
    return;
  }
  const effort = parseEffort(value);
  if (!effort) return;
  ctrl.state = { ...ctrl.state, effort };
  ctrl.notify();
  ctrl.logModel();
  // 回执回显实际生效档（规格 §5.2）：端点不支持时探测降级，取 adapter 探测缓存；接口未实现/未探测时与请求档一致
  const resolved = ctrl.runtime.harness.model.resolvedEffort?.(effort) ?? effort;
  ctrl.pushMsg('system', t(`Reasoning effort set to ${resolved}; applies to subsequent tasks`, `思考强度已设为 ${resolved}；对后续任务生效`));
}
