import { createRoot } from 'react-dom/client';
import './app.css';
import { applyTheme } from './theme';
import { parseLanguage, setLanguage } from './i18n';
import { SettingsForm, SETTINGS_PANES } from './settings/SettingsForm';
import type { SettingsView } from './connection';

setLanguage(parseLanguage('zh-CN'));
applyTheme('dark');
const view: SettingsView = {
  keys: [{ key: 'language', value: null, source: 'global', envOverride: false }],
  permissions: { merged: { deny: [], allow: [], additionalDirs: [] }, project: { deny: [], allow: [], additionalDirs: [] }, global: { deny: [], allow: [], additionalDirs: [] } },
  providers: { choices: [], apiKeyPresent: {}, warnings: [] },
};
const conn = { settings: () => Promise.resolve(view), putSettings: () => Promise.resolve(), memoryStats: () => Promise.resolve({ entries: 0, lastWriteAt: null }) };
createRoot(document.getElementById('root')!).render(
  <div style={{ background: 'var(--surface-under)', minHeight: '100vh', padding: 16 }}>
    {[600, 510, 470, 460, 400].map((w) => (
      <div key={w} style={{ width: w, background: 'var(--surface)', borderRadius: 8, padding: 8, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, padding: 4 }}>panel {w}</div>
        <SettingsForm conn={conn} root="" pane={SETTINGS_PANES[0]!} />
      </div>
    ))}
  </div>,
);
