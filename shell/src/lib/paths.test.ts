import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveDaemonPaths } from './paths';

describe('resolveDaemonPaths', () => {
  it('打包态：daemon/runtime 两件指 resourcesPath/app-dist CJS 束（H3-T2 build:app 产物），dist-gui 同根，win join 形态', () => {
    const resourcesPath = 'C:\\sunshinex\\resources';
    const devRepoRoot = 'D:\\repo\\sunshinex';
    const paths = resolveDaemonPaths(true, resourcesPath, devRepoRoot);

    expect(paths.daemonEntry).toBe(
      path.join(resourcesPath, 'app-dist', 'daemon.cjs'),
    );
    expect(paths.buildModelEntry).toBe(
      path.join(resourcesPath, 'app-dist', 'runtime.cjs'),
    );
    expect(paths.staticRoot).toBe(path.join(resourcesPath, 'dist-gui'));

    // win 路径 join 形态：反斜杠分隔，前缀 + 三件文件名逐字出现。
    expect(paths.daemonEntry.startsWith(resourcesPath + path.sep)).toBe(true);
    expect(paths.daemonEntry.endsWith('\\app-dist\\daemon.cjs')).toBe(true);
    expect(paths.buildModelEntry.endsWith('\\app-dist\\runtime.cjs')).toBe(true);
    expect(paths.staticRoot.endsWith('\\dist-gui')).toBe(true);

    // 打包态不受 devRepoRoot 影响，且不再指向 dev 臂的 dist/ 编译产物形。
    // 负断言须查原串：JSON.stringify 会把反斜杠转义加倍（文本形 dist\\serve），
    // 对单反斜杠子串 not.toContain 永真——T2 复审 Minor#1，改查 daemonEntry 原串。
    expect(JSON.stringify(paths)).not.toContain(devRepoRoot);
    expect(paths.daemonEntry).not.toContain('dist\\serve');
  });

  it('开发态：三件路径同构挂在 devRepoRoot 下（主仓 dist 编译产物形），与 resourcesPath 无关', () => {
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
