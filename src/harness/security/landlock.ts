/**
 * Landlock 接缝（spec 5.4）：Linux 内核级 exec 写围栏，self-restrict-then-exec launcher 形态（Codex 同款）。
 * 收敛边界：本文件单点。包缺失/非 Linux/内核不支持 → 一律返回 null，调用方原样 spawn
 * （对标 MCP 装配失败警告降级语义：不阻断）；SUNSHINEX_SANDBOX=off 一键关（'require' 硬门保留 roadmap）。
 * 模块系统缝：包为 ESM-only 且 tsconfig module=CommonJS 会把 import() 下溯为 require()，
 * 故经 new Function 构造不经转译的真动态 import；本地结构类型避免编译期静态依赖（optionalDependencies 缺失可编译）。
 */
import * as fs from 'fs';

interface LandlockModule {
  launcherPath(): string;
  probe(launcher: string): string;
  grantArgs(grants: { readOnly: string[]; readWrite: string[] }): string[];
}

export interface LandlockWrap {
  file: string;
  args: string[];
}

const dynamicImport = new Function('specifier', 'return import(specifier);') as (s: string) => Promise<unknown>;

const realLoader = async (): Promise<LandlockModule | null> => {
  try {
    return (await dynamicImport('@deepseek-ai/node-addon-landlock-run')) as LandlockModule;
  } catch {
    return null;
  }
};

let loader: Loader = realLoader;
type Loader = () => Promise<LandlockModule | null>;

/** 测试注入口；传 null 恢复真实装载器 */
export function configureLandlockLoader(custom: Loader | null): void {
  loader = custom ?? realLoader;
}

let probeCache: Promise<boolean> | null = null;

/**
 * 探测结果缓存复位（测试隔离用）。缓存契约：usable 成功结果进程级固化（探测成本一次付清）；
 * 失败结果不缓存——探测瞬断（如首轮 exec 早于目录登记完成时的偶发异常）后，下一次 exec 重新探测可恢复包装。
 */
export function resetLandlockProbe(): void {
  probeCache = null;
}

/** 成功探测进程级固化（Promise 常驻短路）；失败只返回不落缓存，下次调用重探（见 resetLandlockProbe 契约注释） */
async function usable(): Promise<boolean> {
  if (probeCache !== null) return probeCache;
  const verdict = await (async () => {
    if (process.platform !== 'linux') return false;
    const mod = await loader();
    if (mod === null) return false;
    try {
      return mod.probe(mod.launcherPath()) !== 'unusable';
    } catch {
      return false;
    }
  })();
  if (verdict) probeCache = Promise.resolve(true);
  return verdict;
}

/** SUNSHINEX_SANDBOX（onOff，缺省 on） */
export function sandboxEnabled(): boolean {
  const v = process.env.SUNSHINEX_SANDBOX;
  if (v === 'off' || v === 'false') return false;
  return true;
}

/**
 * 组装 launcher argv 前缀（launcher …grantArgs -- 后由调用方接 shell 与命令）；不可用/关闭/无有效可写根 → null。
 * 契约：探测为进程级，成功即固化；失败可重探（见 usable）。运行期扩目录（/add-dir、'always' 登记）经
 * landlockWritableRoots 现场求值，每次 exec 包装都取当前根集快照——「探测先于首登」并非扩目录生效前提。
 * grant 形态（launcher 语义核实结论，@deepseek-ai/node-addon-landlock-run lib/index.d.ts「Everything
 * not granted is denied — Landlock rulesets are allow-lists」+ src/main.c + 本机真实 addon 实测）：
 * `--ro` 段仅授读+执行，是被包装命令的运行面（bash 及其动态库在可写根之外，无只读段时连 exec 都失败，
 * 实测 exit 125 fail-closed）；写边界始终由 readWrite 白名单内核级保证——实测白名单外写被拒、/dev/null
 * 反被拦。终审 I-1「grant 段不阻写、readOnly:['/'] 使写边界名存实亡」的前提不成立，故只读段保留：
 * 全盘只读段 '/' 是必要运行面而非写通道，可写集由 roots 精确圈定，与 spec 5.4 一致。
 */
export async function landlockWrap(writableRoots: string[]): Promise<LandlockWrap | null> {
  if (!sandboxEnabled()) return null;
  if (!(await usable())) return null;
  const mod = await loader();
  if (mod === null) return null;
  const roots = [...new Set(writableRoots.map((r) => r.trim()).filter((r) => r.length > 1 && fs.existsSync(r)))];
  if (roots.length === 0) return null;
  return { file: mod.launcherPath(), args: mod.grantArgs({ readOnly: ['/'], readWrite: roots }) };
}

/** 隔离口径解析（spec 5.5）：SUNSHINEX_ISOLATION 显式声明优先，auto = landlock 探测 → 容器标记 → host */
export async function resolveIsolation(): Promise<'landlock' | 'container' | 'host'> {
  const override = process.env.SUNSHINEX_ISOLATION;
  if (override === 'landlock' || override === 'container' || override === 'host') return override;
  if (await usable()) return 'landlock';
  try {
    if (fs.existsSync('/.dockerenv')) return 'container';
  } catch {
    /* 探测失败按 host 口径 */
  }
  return 'host';
}
