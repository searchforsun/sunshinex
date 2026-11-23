/** TUI catalog 命令族共享件（D87 收敛，2026-11-23 续轮四）：原 agents/teams/plugins/mcp 四份
 *  readListing 逐字四胞胎（仅错误文案名词漂移，teams 版注释自称「镜像 commands-agents」）、
 *  agents runAgentWrite 与 plugins 内联写面 try/catch 同构、五文件八处 idle 前置守卫同构——
 *  文案名词/命令名经参数注入，装配串逐字保真（commands-mcp/teams.test 正则钉零漂移）。
 *  「不抛死会话」契约：submit 是 fire-and-forget，handleSlash 拒绝即未处理拒绝杀进程——
 *  读面与写面同履（T20 评审修补语义，随本单点全族统一承载）。 */
import { CatalogWriteError } from '../catalog/io';
import { t } from '../i18n';
import type { SessionController } from './session';

/** 错误文案名词（en 进英文句模板、zh 进中文句前段，见各装配处） */
export interface CatalogNoun {
  readonly en: string;
  readonly zh: string;
}

/** 读面遏制：catalog 读面失败（目录竞态不可读/畸形 settings fail-fast）统一 try/catch → warn
 *  错误行（与写面错误行同形状），undefined = 已出错误行，调用方短路后续定位/写路径 */
export function readListing<T>(ctrl: SessionController, noun: CatalogNoun, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    ctrl.pushMsg('system', t(
      `${noun.en} listing failed: ${e instanceof Error ? e.message : String(e)}`,
      `${noun.zh}清单读取失败：${e instanceof Error ? e.message : String(e)}`,
    ), { level: 'warn' });
    return undefined;
  }
}

/** catalog 写面收口：CatalogWriteError → `code: message` 错误行，其余 → `<名词> write failed`
 *  错误行（消息面不抛死会话），成功 true */
export function runCatalogWriteTui(ctrl: SessionController, noun: CatalogNoun, fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (e) {
    ctrl.pushMsg('system', e instanceof CatalogWriteError ? t(`${e.code}: ${e.message}`, `${e.code}：${e.message}`) : t(
      `${noun.en} write failed: ${e instanceof Error ? e.message : String(e)}`,
      `${noun.zh}写入失败：${e instanceof Error ? e.message : String(e)}`,
    ), { level: 'error' });
    return false;
  }
}

/** 面板前置守卫：任务进行中即 warn 拒行（/<cmd> unavailable now）并返回 false，idle 放行 true */
export function idleGuard(ctrl: SessionController, cmd: string): boolean {
  if (ctrl.state.status === 'idle') return true;
  ctrl.pushMsg('system', t(`A task is running; /${cmd} unavailable now`, `当前有任务进行中，暂不能执行 /${cmd}`), { level: 'warn' });
  return false;
}
