import path from 'node:path';

export interface DaemonPaths {
  daemonEntry: string;
  buildModelEntry: string;
  staticRoot: string;
}

/**
 * 解析 daemon 三件路径：入口 / 构建模型 / 静态资源根。
 * 打包态以 resourcesPath 为根，开发态以 devRepoRoot 为根，两态目录结构同构：
 * dist/serve/daemon.js、dist/runtime.js、dist-gui。
 */
export function resolveDaemonPaths(
  isPackaged: boolean,
  resourcesPath: string,
  devRepoRoot: string,
): DaemonPaths {
  const root = isPackaged ? resourcesPath : devRepoRoot;
  return {
    daemonEntry: path.join(root, 'dist', 'serve', 'daemon.js'),
    buildModelEntry: path.join(root, 'dist', 'runtime.js'),
    staticRoot: path.join(root, 'dist-gui'),
  };
}
