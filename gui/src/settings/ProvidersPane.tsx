import { useEffect, useState } from 'react';
import type { ProviderChoice } from '../connection';
import { SettingsForm } from './SettingsForm';
import type { SettingsFormConn, SettingsPaneDef } from './SettingsForm';

/**
 * G8c T9 模型与提供方面板:上=SettingsForm 表单引擎复用(pane 定义模型五键
 * model/modelSmall/modelMedium/modelLarge + tier/reasoningEffort/baseUrl——全 text 输入,
 * 键名与 daemon SEMANTIC_KEYS 逐字对齐;引擎自带来源徽标/env 禁编/保存 toast 面);
 * 下=providers 只读卡列表(conn.settings(root) 的 providers.choices 逐卡:名称/模型行/
 * apiKeyPresent 圆点——绿=env 槽在场/灰=缺,title=apiKeyEnv 槽名)+warnings 告警行。
 * providers 是只读呈现面(密钥只走 env 面,GUI 不编辑);本组件对 settings 发两笔请求
 * (表单引擎一笔 + providers 卡一笔——视图分面,各自独立加载态)。
 */

/** 模型与提供方面板定义(SettingsForm 消费;全 text——数字键集不含此七键) */
const PROVIDERS_PANE: SettingsPaneDef = {
  id: 'providers',
  title: '模型与提供方',
  fields: [
    { key: 'model', label: 'model', input: 'text' },
    { key: 'modelSmall', label: 'modelSmall', input: 'text' },
    { key: 'modelMedium', label: 'modelMedium', input: 'text' },
    { key: 'modelLarge', label: 'modelLarge', input: 'text' },
    { key: 'tier', label: 'tier', input: 'text' },
    { key: 'reasoningEffort', label: 'reasoningEffort', input: 'text' },
    { key: 'baseUrl', label: 'baseUrl', input: 'text' },
  ],
};

/** providers 只读面(conn.settings 的 providers 投影) */
export type ProvidersPaneConn = SettingsFormConn;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface ProvidersPaneProps {
  readonly conn: ProvidersPaneConn;
  /** 项目上下文('' = 仅全局;读面归一为省参) */
  readonly root: string;
}

export function ProvidersPane({ conn, root }: ProvidersPaneProps): JSX.Element {
  /** providers 只读面数据(null = 加载中;表单面数据由内嵌 SettingsForm 自管) */
  const [providers, setProviders] = useState<{ choices: ProviderChoice[]; apiKeyPresent: Record<string, boolean>; warnings: string[] } | null>(null);
  const [loadError, setLoadError] = useState('');
  const r = root === '' ? undefined : root; // 仅全局 = 省参(空串 root 服务端不可靠)

  useEffect(() => {
    conn.settings(r).then(
      (view) => {
        setProviders(view.providers);
        setLoadError('');
      },
      (err: unknown) => setLoadError(errText(err)),
    );
  }, [conn, r]);

  return (
    <div className="sx-settings-complex">
      <SettingsForm conn={conn} root={root} pane={PROVIDERS_PANE} />
      <section className="sx-providers" aria-label="providers">
        <h3>提供方(只读)</h3>
        {loadError !== '' && <p className="home-error" role="alert">{loadError}</p>}
        {providers === null && loadError === '' && <p className="home-loading">加载提供方…</p>}
        {providers !== null && providers.choices.length === 0 && loadError === '' && <p className="home-loading">无已配置的模型选择。</p>}
        {providers !== null && providers.choices.length > 0 && (
          <ul className="sx-provider-list">
            {providers.choices.map((c) => {
              /** apiKeyPresent 以 provider 名为键(daemon resolveProviderApiKey 判存);缺省 false=灰点 */
              const present = providers.apiKeyPresent[c.provider] === true;
              return (
                <li key={c.id} className="sx-provider-card">
                  <div className="sx-provider-head">
                    <span className="sx-provider-name">{c.id}</span>
                    <span className="sx-provider-vendor">{c.provider}</span>
                    <span className={`sx-api-dot${present ? ' present' : ' missing'}`} title={c.apiKeyEnv} aria-label={`api key ${c.id}`} />
                  </div>
                  <div className="sx-provider-model">{c.model}</div>
                </li>
              );
            })}
          </ul>
        )}
        {providers?.warnings.map((w) => (
          <p key={w} className="sx-provider-warn" role="alert">
            {w}
          </p>
        ))}
      </section>
    </div>
  );
}
