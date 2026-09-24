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

/** 探测结果缓存复位（测试隔离用；运行期进程级缓存即可用性单调） */
export function resetLandlockProbe(): void {
  probeCache = null;
}

async function usable(): Promise<boolean> {
  if (probeCache === null) {
    probeCache = (async () => {
      if (process.platform !== 'linux') return false;
      const mod = await loader();
      if (mod === null) return false;
      try {
        return mod.probe(mod.launcherPath()) !== 'unusable';
      } catch {
        return false;
      }
    })();
  }
  return probeCache;
}

/** SUNSHINEX_SANDBOX（onOff，缺省 on） */
export function sandboxEnabled(): boolean {
  const v = process.env.SUNSHINEX_SANDBOX;
  if (v === 'off' || v === 'false') return false;
  return true;
}

/** 组装 launcher argv 前缀（launcher …grantArgs -- 后由调用方接 shell 与命令）；不可用/关闭/无有效可写根 → null */
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
