import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { icons as vscodeIcons } from '@iconify-json/vscode-icons';
import { FileIcon, hasFileTypeIcon, iconIdOf } from './file-icon';

/** G14.2xx 丢图标根治:vscode-icons-js 返回名与 @iconify-json/vscode-icons 集合键存在系统性
 *  失配(集合键全量零下划线;vscode-icons-js 对未识别文件返回非空的 default_file.svg 而非 null)
 *  ——iconIdOf 产出必须经集合存在性校验,失配回落 default-file;hasFileTypeIcon 同口径 */

/** 集合 id 全集(与实现同源口径,用于断言产出 id 必然可渲染) */
const COLLECTION_IDS = new Set([
  ...Object.keys(vscodeIcons.icons ?? {}),
  ...Object.keys(vscodeIcons.aliases ?? {}),
]);

describe('iconIdOf 集合感知归一', () => {
  it('未识别文件(default_file.svg 非 null 兜底)回落 default-file——README/Dockerfile 等无扩展名文件不再丢图标', () => {
    expect(iconIdOf('README')).toBe('vscode-icons:default-file');
    expect(iconIdOf('Dockerfile')).toBe('vscode-icons:default-file');
    expect(iconIdOf('LICENSE')).toBe('vscode-icons:default-file');
    expect(hasFileTypeIcon('README')).toBe(false);
  });

  it('下划线名转横线对位集合键(go_package → go-package)', () => {
    expect(iconIdOf('go.mod')).toBe('vscode-icons:file-type-go-package');
    expect(hasFileTypeIcon('go.mod')).toBe(true);
  });

  it('常规扩展名映射不变且产出 id 必在集合内(失配即丢图标)', () => {
    expect(iconIdOf('x.ts')).toBe('vscode-icons:file-type-typescript');
    expect(iconIdOf('package.json')).toBe('vscode-icons:file-type-npm'); // 原库精确映射(npm 专属图标,集合在场)
    expect(hasFileTypeIcon('x.ts')).toBe(true);
    for (const name of ['x.ts', 'x.tsx', 'x.py', 'x.rs', 'x.md', 'x.yml', 'package.json', 'go.mod']) {
      const id = iconIdOf(name);
      expect(COLLECTION_IDS.has(id.replace('vscode-icons:', '')), `${name} -> ${id}`).toBe(true);
    }
  });

  it('广样本抽检:任意文件名产出的 id 恒命中集合(丢图标零残留)', () => {
    const samples = [
      'x.cjs', 'x.proto', 'x.R', 'x.f90', 'x.asm', 'x.ahk', 'x.razor', 'x.pug',
      'x.cue', 'x.hcl', 'x.dhall', 'x.move', 'Makefile', 'Gemfile', 'Windowsfile',
      'Cargo.toml', 'pnpm-lock.yaml', 'x.sol', 'x.prisma', 'x.tf',
    ];
    for (const name of samples) {
      const id = iconIdOf(name);
      expect(COLLECTION_IDS.has(id.replace('vscode-icons:', '')), `${name} -> ${id}`).toBe(true);
    }
  });
});

describe('FileIcon 渲染', () => {
  it('失配回落面:README 渲染出非空 svg(图标可见,不再空渲染)', () => {
    const { container } = render(<FileIcon path="README.md" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.innerHTML.length ?? 0).toBeGreaterThan(0);
  });

  it('目录旗标:folder=true 显黄目录', () => {
    expect(iconIdOf('src/')).toBe('vscode-icons:default-file'); // 目录不经 iconIdOf,由 folder 旗标走
    const { container } = render(<FileIcon path="src/" folder={true} />);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
