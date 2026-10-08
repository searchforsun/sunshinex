import * as url from 'node:url';
import type { DaemonPaths } from './lib/paths';

/** 壳持有的 daemon 视图：port/token 供窗口 URL 拼装，close 供退出收口（GuiDaemon 自身幂等——首调落链复用） */
export interface ShellDaemon {
  port: number;
  token: string;
  close(): Promise<void>;
}

/**
 * daemon 进程内装配（spec H §3 裁定：不 spawn 子进程，壳主进程即 daemon 宿主）。
 * 动态 import daemon 入口：编译期不引主仓源（shell tsconfig 无路径映射、esbuild 不解析），
 * 运行时按 resolveDaemonPaths 两态路径加载——变量化 import 表达式天然保外置，daemon 体不进 bundle。
 * interop 容错（H3-T2）：两态入口形不同——dev 臂主仓 dist（tsc CJS，具名导出在 dm.GuiDaemon）
 * 与打包臂 esbuild CJS 束（Node CJS-ESM interop 下具名可能只挂 dm.default），双形取一、
 * 两处皆无即抛（束装配错或入口选错，宁可启动期红也不静默 undefined 调用炸晚）。
 * 模型装配同 CLI serve 源头（buildModel 空旗标 = 缺省旋钮）；port 0 = 临时端口，回执取实际监听值。
 */
export async function startDaemon(paths: DaemonPaths): Promise<ShellDaemon> {
  const dm = await import(url.pathToFileURL(paths.daemonEntry).href);
  const GuiDaemon = dm.GuiDaemon ?? dm.default?.GuiDaemon;
  if (GuiDaemon === undefined) throw new Error('daemon entry missing GuiDaemon export');

  const rm = await import(url.pathToFileURL(paths.buildModelEntry).href);
  const buildModel = rm.buildModel ?? rm.default?.buildModel;
  if (buildModel === undefined) throw new Error('runtime entry missing buildModel export');

  const daemon = new GuiDaemon({ model: buildModel({}), staticRoot: paths.staticRoot });
  const s = await daemon.start({ port: 0 });
  return { port: s.port, token: s.token, close: () => daemon.close() };
}
