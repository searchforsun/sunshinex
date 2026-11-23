import { useCallback, useEffect, useState } from 'react';
import { Select } from './controls';
import { t } from '../i18n';
import { useRawEditor } from '../use-raw-editor';
import type { SettingsScope } from './components';

/**
 * G8c T9 高级面板——原文级编辑面:settings/mcp 双文件。**恒全局**(2026-10-31 用户裁定
 * 「高级页面要始终读取全局配置,也只能读取全局配置」):scope/root 壳注入不再消费——原文级
 * 项目编辑路径退役(项目侧配置走 GUI 表单面),本面读写恒省参(全局文件)。scope 缺省 'global'
 * 的旧语义并档存照。
 * 回显面:mount/切文件即自动「读取」(不再要求先点读取);content=null(缺文件)=空态判据照旧。
 * 「重新读取」钮保留(编辑中途弃改回磁盘现值)。textarea 受控;服务端验证拒存+原子写——GUI
 * 不本地预解析(parseSettingsFile 严格口径在服务端,原文保真是本面板价值)。
 * 空态示例占位(2026-10-31 用户裁定「里面给上示例占位,如果没有内容」):content 空时
 * textarea placeholder 显该文件的示例结构(键位形状=服务端解析口径),替代旧验证提示文案
 * (验证行为由「验证并保存」钮与服务端 400 行内错误自明)。
 * 切文件即回未读取态:content/错误/toast 清 + 保存禁用,自动读取随即装新原文——A 文件内容
 * 不跨文件写(部分方向能过服务端验证,守卫在 GUI 侧);在途读同款:切文件后迟到应答代不齐弃
 * (read 代守卫,G8e 终审 A)——清场语义经 use-raw-editor resetBeforeAutoRead 承载(D92)。
 * G8d T5 告警透出:面板顶部渲染 GET /settings warnings(全局 settings.json 的未知/退役键
 * flatten 告警;root 省参=仅全局面)——逐行 role=alert;拉取失败静默空(告警是增强面,不挡
 * 编辑主流程);mount 拉一次。
 */

/** 空文件示例占位(键位形状=服务端解析单点口径:settings=version+providers[{name,baseUrl,
 *  models[{model,tier}]}];mcp=mcpServers{name:{command,args}}——与主流 MCP 客户端键位兼容) */
const RAW_EXAMPLES: Record<'settings' | 'mcp', { en: string; zh: string }> = {
  settings: {
    en: `Example:\n{\n  "version": 1,\n  "tier": "medium",\n  "reasoningEffort": "medium",\n  "providers": [\n    {\n      "name": "bigmodel",\n      "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",\n      "models": [{ "model": "glm-5.3", "tier": "medium" }]\n    }\n  ]\n}`,
    zh: `示例:\n{\n  "version": 1,\n  "tier": "medium",\n  "reasoningEffort": "medium",\n  "providers": [\n    {\n      "name": "bigmodel",\n      "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",\n      "models": [{ "model": "glm-5.3", "tier": "medium" }]\n    }\n  ]\n}`,
  },
  mcp: {
    en: `Example:\n{\n  "mcpServers": {\n    "browser-use": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },\n    "remote": { "url": "http://127.0.0.1:8808/mcp", "transport": "http" }\n  }\n}`,
    zh: `示例:\n{\n  "mcpServers": {\n    "browser-use": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },\n    "remote": { "url": "http://127.0.0.1:8808/mcp", "transport": "http" }\n  }\n}`,
  },
};

/** raw 面连接面(结构满足即收,App 传整只 Connection) */
export interface RawPaneConn {
  settingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp'): Promise<{ content: string | null }>;
  putSettingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp', content: string): Promise<void>;
  /** G8d T5 告警数据源:root 缺省 = 仅全局文件面(与 settings() 同裁定) */
  settings(root?: string): Promise<{ warnings?: string[] }>;
}


interface RawPaneProps {
  readonly conn: RawPaneConn;
  /** 已退役注入面(2026-10-31 用户裁定恒全局):壳仍下发 scope/root 但本面不再消费——
   *  字段留置保壳层接线零变化;refreshTick 不由壳下发(raw 跨 settings+mcp 两资源——
   *  需要时本面自持 conn 调 useConfigChanged 自取) */
  readonly scope?: SettingsScope;
  readonly root?: string;
}

export function RawPane({ conn }: RawPaneProps): JSX.Element {
  /** 恒全局(2026-10-31 用户裁定):读写恒省参定位(全局文件)——scope/root 注入退役 */
  const effScope: SettingsScope = 'global';
  const effRoot = undefined;
  const [file, setFile] = useState<'settings' | 'mcp'>('settings');
  /** G8d T5 文件面告警(未知/退役键):拉取失败/无字段按空——增强面不挡编辑主流程 */
  const [warnings, setWarnings] = useState<string[]>([]);
  // 编辑器机制走 use-raw-editor 共享 hook（D92 收敛）:切文件清场语义=resetBeforeAutoRead
  const ed = useRawEditor({
    read: useCallback(() => conn.settingsRaw(effScope, effRoot, file), [conn, file]),
    write: useCallback((content: string) => conn.putSettingsRaw(effScope, effRoot, file, content), [conn, file]),
    readDeps: [conn, file],
    resetBeforeAutoRead: true,
  });

  useEffect(() => {
    let alive = true;
    conn.settings().then(
      (v) => {
        if (alive) setWarnings(v.warnings ?? []);
      },
      () => {
        if (alive) setWarnings([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [conn]);

  return (
    <section className="sx-settings-form sx-settings-body" aria-label="settings pane raw">
      <h2>{t('Advanced (raw editing)', '高级(原始编辑)')}</h2>
      {warnings.length > 0 && (
        <div className="sx-raw-warnings" role="alert">
          {warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}
      <div className="sx-card sx-raw-card">
        <div className="sx-raw-controls">
          <label>
            {t('File', '文件')}
            <Select
              ariaLabel="raw file"
              value={file}
              options={[
                { v: 'settings', l: 'settings.json' },
                { v: 'mcp', l: 'mcp.json' },
              ]}
              onChange={(v) => setFile(v as 'settings' | 'mcp')}
            />
          </label>
          <button type="button" onClick={ed.readNow}>
            {t('Reload', '重新读取')}
          </button>
        </div>
        {ed.loadError !== '' && <p className="home-error" role="alert">{ed.loadError}</p>}
        <textarea
          aria-label="raw editor"
          className="sx-raw-editor"
          ref={ed.editorRef}
          value={ed.content}
          onChange={(e) => ed.setContent(e.target.value)}
          rows={20}
          spellCheck={false}
          placeholder={t(RAW_EXAMPLES[file].en, RAW_EXAMPLES[file].zh)}
        />
        <div className="sx-save-bar">
          <button type="button" className="sx-settings-save" disabled={ed.saving || !ed.loaded} onClick={ed.save}>
            {t('Verify & save', '验证并保存')}
          </button>
        </div>
        {ed.saveError !== '' && <p className="home-error" role="alert">{ed.saveError}</p>}
      </div>
      {ed.toast !== null && (
        <div className="sx-toast" role="status">
          {ed.toast}
        </div>
      )}
    </section>
  );
}
