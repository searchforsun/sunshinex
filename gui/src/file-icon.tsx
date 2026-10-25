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

/** 集合 id 全集（键全量零下划线）：映射产出过存在性校验，失配自动回落 default-file——
 *  vscode-icons-js 返回名与集合键存在系统性失配（下划线形态 go_package→go-package、
 *  未识别文件的兜底返回是非空的 default_file.svg 而非 null），失配 id 渲染为空即丢图标 */
const COLLECTION_IDS = new Set([
  ...Object.keys(vscodeIcons.icons ?? {}),
  ...Object.keys(vscodeIcons.aliases ?? {}),
]);

/** vscode-icons-js 原始名 → 集合内 id（`file_type_light_js.svg` → `file-type-js`）；归一
 *  试探链：剥后缀/前缀、去 `light_` 亮色变体 → 下划线转横线 → 集合校验，失配回落 default-file */
function normalizedId(raw: string): string {
  const base = raw.replace(/\.svg$/, '').replace(/^file_type_/, '').replace(/^light_/, '');
  if (base === 'default_file') return 'default-file';
  const id = `file-type-${base.replace(/_/g, '-')}`;
  return COLLECTION_IDS.has(id) ? id : 'default-file';
}

/** vscode-icons-js 名 → iconify id（`file_type_light_js.svg` → `vscode-icons:file-type-js`）；
 *  未知/失配一律回落 default-file（导出供测试与消费面对齐校验） */
export function iconIdOf(fileName: string): string {
  const raw = getIconForFile(fileName);
  if (raw === null || raw === undefined || raw === '') return 'vscode-icons:default-file';
  return `vscode-icons:${normalizedId(String(raw))}`;
}

/** 文件名是否命中 vscode-icons 类型图标（G14.211 文件标签页消费:命中显类型图标,未命中由调用面回落通用图标）；
 *  与 iconIdOf 同口径——default_file 兜底与集合失配名均视为未命中 */
export function hasFileTypeIcon(path: string): boolean {
  return iconIdOf(path.split(/[\\/]+/).filter(Boolean).pop() ?? path) !== 'vscode-icons:default-file';
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
  // 目录判定:folder 显式传入,或路径带尾斜杠(@面板目录项/目录引用 token 统一尾斜杠标记)——
  // 一律经典黄目录(default-folder),不做按名映射(用户裁定)
  const icon =
    folder === true || /[\\/]$/.test(path)
      ? open === true
        ? 'vscode-icons:default-folder-opened'
        : 'vscode-icons:default-folder'
      : iconIdOf(path.split(/[\\/]+/).filter(Boolean).pop() ?? path);
  return <Icon icon={icon} width={size} height={size} aria-hidden="true" style={{ flex: 'none' }} />;
}
