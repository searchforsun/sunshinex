/**
 * 库导出面（R1 入口收敛）：本件原为可执行占位入口——模块级装载 settings + 打印骨架占位语 +
 * 「selfcheck 已迁移」提示分支，三样副作用全部退役；可执行入口唯一落 src/cli/index.ts
 * （bin 与 npm start 均指 dist/cli/index.js）。本件保留为 package.json main 的库面（dist/index.js）：
 * 零副作用零打印，库消费方 require 即得公共 API；settings 两级装载原副作用收敛为显式导出
 * loadSettingsChain（config/settings.ts 单点，CLI 与库消费方共用），装载时机交消费方自决。
 */
export { loadSettingsChain } from './config/settings';
export { buildModel, buildHarness } from './runtime';
