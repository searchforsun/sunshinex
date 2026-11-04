/**
 * catalog 基础类型：后续 mcp/agents/plugins/providers/skills 各 catalog 模块共用的形状契约单点。
 * 只放类型不放逻辑；改动须过全量测试（各 catalog 模块以此为公共词汇）。
 */

/** 作用域：global=用户级（跨项目共享），project=项目级（随工作区走） */
export type Scope = 'global' | 'project';

/** catalog 面覆盖的资源种类；'teams' = 预定义智能体团队（catalog/teams 写通知，Task 3）——watcher
 *  侧 teams 目录映射 P1 已接线（watch.ts mapFilename teams 段 + watchGlobal/watchProject teams
 *  子目录 spec），teams 写经 notifyCatalogWrite 直发帧 + watcher suppress 防回声，与 agents 同套 */
export type ResourceKind = 'mcp' | 'agents' | 'plugins' | 'skills' | 'providers' | 'permissions' | 'settings' | 'teams';

/**
 * 列举产物：entries + warnings（D7 容错口径的列举形态——缺文件/畸形条目不算错，
 * 降级为空条目并产告警，调用方决定输出通道）。
 */
export interface Listing<T> { entries: T[]; warnings: string[] }
