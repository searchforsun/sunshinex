import path from 'node:path';

export interface DaemonPaths {
  daemonEntry: string;
  buildModelEntry: string;
  staticRoot: string;
}

/**
 * 解析 daemon 三件路径：入口 / 构建模型 / 静态资源根。
 * 开发态以 devRepoRoot 为根，直指主仓 dist 编译产物（tsc 形：dist/serve/daemon.js、dist/runtime.js）。
 * 打包态以 resourcesPath 为根，指 H3-T2 esbuild CJS 束（build:app 产物经 electron-builder 落
 * resourcesPath/app-dist）：daemon.cjs / runtime.cjs；静态资源根两态同形（dist-gui）。
 * 两态入口形不同（ESM 路径下的 tsc CJS vs 束化 CJS），daemon.ts interop 容错双形。
 */
export function resolveDaemonPaths(
  isPackaged: boolean,
  resourcesPath: string,
  devRepoRoot: string,
): DaemonPaths {
  if (isPackaged) {
    return {
      daemonEntry: path.join(resourcesPath, 'app-dist', 'daemon.cjs'),
      buildModelEntry: path.join(resourcesPath, 'app-dist', 'runtime.cjs'),
      staticRoot: path.join(resourcesPath, 'dist-gui'),
    };
  }
  return {
    daemonEntry: path.join(devRepoRoot, 'dist', 'serve', 'daemon.js'),
    buildModelEntry: path.join(devRepoRoot, 'dist', 'runtime.js'),
    staticRoot: path.join(devRepoRoot, 'dist-gui'),
  };
}
