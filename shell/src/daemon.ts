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
export async function startDaemon(paths: DaemonPaths, preferredPort?: number): Promise<ShellDaemon> {
  const dm = await import(url.pathToFileURL(paths.daemonEntry).href);
  const GuiDaemon = dm.GuiDaemon ?? dm.default?.GuiDaemon;
  if (GuiDaemon === undefined) throw new Error('daemon entry missing GuiDaemon export');

  const rm = await import(url.pathToFileURL(paths.buildModelEntry).href);
  const buildModel = rm.buildModel ?? rm.default?.buildModel;
  if (buildModel === undefined) throw new Error('runtime entry missing buildModel export');

  // 2026-10-23 根因修复:CLI serve 同序(cli/index.ts:212)——settings 链先于模型装配装载。
  // 全局 settings.json 携带 env 块(API key)、projectsDir、language:缺此步适配器构造期读空 env
  // (「SUNSHINEX_API_KEY is not configured」)且 projectsRoot 落缺省目录(用户会话全不可见)、
  // GUI 语言回落 en。projectRoot=壳进程 cwd(安装目录,无项目级 settings 即纯全局链)。
  if (typeof dm.loadSettingsChain === 'function') {
    dm.loadSettingsChain(process.cwd());
  } else {
    console.error('[shell] daemon entry missing loadSettingsChain export — settings chain skipped');
  }

  // 多源多模型装配（2026-10-23 桌面「默认模型/无法选模型」根因修复）：壳侧 buildModel 是裸适配器
  // （runtime.cjs 面,不包切换器）,daemon.cjs 的 instanceof ModelSwitcher 注入闸对跨束实例恒 false
  // → modelSwitcher 恒 null,/model 恒 {choices:[]}。改用 daemon 束导出的同源工厂 assembleGuiModel
  // （loadProviders + ModelSwitcher,与 GuiDaemon 同类）——须在 settings 链装载后调用
  // （SUNSHINEX_MODEL/providers 均出自 settings）;warnings 与 CLI serve 同通道 stderr 透出。
  let model: unknown = buildModel({});
  if (typeof dm.assembleGuiModel === 'function') {
    const assembled = dm.assembleGuiModel(model, process.cwd());
    for (const w of assembled.warnings ?? []) console.error(`[shell] settings warning: ${w}`);
    model = assembled.model;
  } else {
    console.error('[shell] daemon entry missing assembleGuiModel — model switching unavailable (stale bundle)');
  }

  const daemon = new GuiDaemon({ model, staticRoot: paths.staticRoot });
  // 端口偏好(2026-10-23):上一 launch 实际端口优先(origin 稳定=GUI localStorage 跨 launch 存续),
  // 被占即回落临时端口;偏好落盘由 main 侧负责
  if (preferredPort !== undefined) {
    try {
      const s = await daemon.start({ port: preferredPort });
      return { port: s.port, token: s.token, close: () => daemon.close() };
    } catch (err) {
      // 失败原因不断言为端口占用(EACCES/装配错同落此路径),携原 err 如实记日志
      console.error(`[shell] preferred port ${preferredPort} unavailable — falling back to ephemeral port:`, err);
    }
  }
  const s = await daemon.start({ port: 0 });
  return { port: s.port, token: s.token, close: () => daemon.close() };
}
