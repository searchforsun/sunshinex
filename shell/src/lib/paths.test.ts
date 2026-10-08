import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveDaemonPaths } from './paths';

describe('resolveDaemonPaths', () => {
  it('打包态：三件路径均以 resourcesPath 为根，win join 形态（dist/serve/daemon.js、dist/runtime.js、dist-gui）', () => {
    const resourcesPath = 'C:\\sunshinex\\resources';
    const devRepoRoot = 'D:\\repo\\sunshinex';
    const paths = resolveDaemonPaths(true, resourcesPath, devRepoRoot);

    expect(paths.daemonEntry).toBe(
      path.join(resourcesPath, 'dist', 'serve', 'daemon.js'),
    );
    expect(paths.buildModelEntry).toBe(
      path.join(resourcesPath, 'dist', 'runtime.js'),
    );
    expect(paths.staticRoot).toBe(path.join(resourcesPath, 'dist-gui'));

    // win 路径 join 形态：反斜杠分隔，前缀 + 三件文件名逐字出现。
    expect(paths.daemonEntry.startsWith(resourcesPath + path.sep)).toBe(true);
    expect(paths.daemonEntry.endsWith('\\dist\\serve\\daemon.js')).toBe(true);
    expect(paths.buildModelEntry.endsWith('\\dist\\runtime.js')).toBe(true);
    expect(paths.staticRoot.endsWith('\\dist-gui')).toBe(true);

    // 打包态不受 devRepoRoot 影响。
    expect(JSON.stringify(paths)).not.toContain(devRepoRoot);
  });

  it('开发态：三件路径同构挂在 devRepoRoot 下，与 resourcesPath 无关', () => {
    const resourcesPath = 'C:\\sunshinex\\resources';
    const devRepoRoot = 'D:\\repo\\sunshinex';
    const paths = resolveDaemonPaths(false, resourcesPath, devRepoRoot);

    expect(paths.daemonEntry).toBe(
      path.join(devRepoRoot, 'dist', 'serve', 'daemon.js'),
    );
    expect(paths.buildModelEntry).toBe(
      path.join(devRepoRoot, 'dist', 'runtime.js'),
    );
    expect(paths.staticRoot).toBe(path.join(devRepoRoot, 'dist-gui'));

    expect(paths.daemonEntry.startsWith(devRepoRoot + path.sep)).toBe(true);
    expect(paths.daemonEntry.endsWith('\\dist\\serve\\daemon.js')).toBe(true);
    expect(paths.buildModelEntry.endsWith('\\dist\\runtime.js')).toBe(true);
    expect(paths.staticRoot.endsWith('\\dist-gui')).toBe(true);

    expect(JSON.stringify(paths)).not.toContain(resourcesPath);
  });
});
