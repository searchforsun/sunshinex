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

/** 文件名是否命中 vscode-icons 类型图标（G14.211 文件标签页消费:命中显类型图标,未命中由调用面回落通用图标） */
export function hasFileTypeIcon(path: string): boolean {
  const raw = getIconForFile(path.split(/[\\/]+/).pop() ?? path);
  return raw !== null && raw !== undefined && raw !== '';
}

export function FileIcon({
  path,
  folder,
  open,
  size = 14,
}: {
  path: string;
  folder?: boolean;
  open?: boolean;
  /** G14.211 可选尺寸（文件标签页 16 与 lucide 同框;缺省 14 恒稳） */
  size?: number;
}): JSX.Element {
  const icon =
    folder === true
      ? open === true
        ? 'vscode-icons:default-folder-opened'
        : 'vscode-icons:default-folder'
      : iconIdOf(path.split(/[\\/]+/).pop() ?? path);
  return <Icon icon={icon} width={size} height={size} aria-hidden="true" style={{ flex: 'none' }} />;
}
