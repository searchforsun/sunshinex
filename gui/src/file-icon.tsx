import { Icon, addCollection } from '@iconify/react';
import { getIconForFile } from 'vscode-icons-js';
import { icons as vscodeIcons } from '@iconify-json/vscode-icons';

/**
 * vscode 式文件图标（G14 工具行/侧栏文件树改版）：@iconify-json/vscode-icons 离线 SVG 集
 * （打包内联，零运行时外联）+ vscode-icons-js 的 文件名→图标 映射。id 规则：vscode-icons-js
 * 返回 `file_type_light_js.svg` 形，剥前缀/后缀、去 `light_` 即 iconify id（`file-type-js`）。
 */

// 全量集合一次注册（~1681 图标;SVG data 内联,无网络请求;prefix 取集合自带 vscode-icons）
addCollection(vscodeIcons);

/** vscode-icons-js 名 → iconify id（`file_type_light_js.svg` → `file-type-js`）；未知回落 default-file */
function iconIdOf(fileName: string): string {
  const raw = getIconForFile(fileName);
  if (raw === null || raw === undefined || raw === '') return 'vscode-icons:default-file';
  const base = (raw as string).replace(/\.svg$/, '').replace(/^file_type_/, '');
  return `vscode-icons:file-type-${base.replace(/^light_/, '')}`;
}

export function FileIcon({ path, folder, open }: { path: string; folder?: boolean; open?: boolean }): JSX.Element {
  const icon =
    folder === true
      ? open === true
        ? 'vscode-icons:default-folder-opened'
        : 'vscode-icons:default-folder'
      : iconIdOf(path.split(/[\\/]+/).pop() ?? path);
  return <Icon icon={icon} width={14} height={14} aria-hidden="true" style={{ flex: 'none' }} />;
}
