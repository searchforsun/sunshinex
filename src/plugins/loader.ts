import * as fs from 'fs';
import * as path from 'path';

/** 插件描述 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  entry?: string;
}

/** 插件加载器：扫描 plugins/{id}/plugin.json */
export function loadPlugins(root: string): PluginManifest[] {
  const dir = path.join(root, 'plugins');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const f = path.join(dir, d.name, 'plugin.json');
      if (!fs.existsSync(f)) return null;
      try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as PluginManifest;
        return { ...raw, id: d.name };
      } catch {
        return null; // 单个清单损坏降级为跳过该插件，不阻断整体加载（与感知依赖解析降级同姿态）
      }
    })
    .filter((p): p is PluginManifest => p !== null);
}
