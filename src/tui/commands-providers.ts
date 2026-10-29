import { listProviders } from '../catalog/providers';
import { t } from '../i18n';
import type { SessionController } from './session';

// Task 20（Phase E）拆分件：/providers 只读清单卡（commands-model/commands-mcp 先例——handleSlash 骨架
// 只留分发）。读全走 catalog 单点（listProviders：密钥永不回传值，只标槽名与在场布尔）；TUI 不做表单
// （缺省裁定，与 brief 一致）：写面（upsert/model/密钥）引导 CLI sunshinex providers ... 或 $EDITOR
// settings.json——TUI 面板零写盘。

/** /providers：模型提供方清单卡——源名/模型数/密钥槽在场状态/默认标记（默认恒 choices[0] 所属源，
 *  §15 缺省模型 = 首源首模型）+ 编辑引导行。未配置 providers 时给配置指引（/model 无卡同款引导面）。 */
export function providersPanel(ctrl: SessionController): void {
  if (ctrl.state.status !== 'idle') {
    ctrl.pushMsg('system', t('A task is running; /providers unavailable now', '当前有任务进行中，暂不能执行 /providers'), { level: 'warn' });
    return;
  }
  const { providers, choices, warnings } = listProviders(ctrl.root);
  if (providers.length === 0) {
    ctrl.pushMsg('system', t(
      'No providers configured: add a "providers" array to settings.json (each entry: name + baseUrl + models), or run: sunshinex providers add',
      '未配置提供方：在 settings.json 增加 "providers" 数组（每项 name + baseUrl + models），或运行：sunshinex providers add',
    ), { level: 'warn' });
    return;
  }
  // 默认源 = choices[0]（首源首模型）所属 provider；choices 空（源存在但全部畸形被装载面跳过）→ 无默认标注
  const defaultProvider = choices[0]?.provider;
  const lines = [t(`Model providers (${providers.length}):`, `模型提供方（${providers.length} 个）：`)];
  for (const p of providers) {
    const isDefault = p.name === defaultProvider;
    const key = p.apiKeyPresent
      ? t(`key ${p.apiKeyEnv}: present`, `密钥 ${p.apiKeyEnv}：已配置`)
      : t(`key ${p.apiKeyEnv}: missing`, `密钥 ${p.apiKeyEnv}：未配置`);
    lines.push(`- ${p.name}${isDefault ? ` · ${t('default', '默认')}` : ''} — ${p.models.length} ${t('models', '个模型')} · ${key}`);
  }
  for (const w of warnings) lines.push(t(`warning: ${w}`, `警告：${w}`));
  lines.push(t(
    'Edit: sunshinex providers ... or $EDITOR settings.json (panel is read-only)',
    '编辑：sunshinex providers 子命令或 $EDITOR settings.json（面板只读）',
  ));
  ctrl.pushMsg('system', lines.join('\n'));
}
