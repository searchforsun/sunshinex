/**
 * catalog io 读写纪律单点：后续 mcp/agents/plugins/providers/skills 各 catalog 模块一律经本模块
 * 读写配置文件，不得各自 fs 直写。两件纪律：
 * - 读 = JSONC 容错读（readJsoncDoc）：缺文件返回 exists:false 空 doc（没配就是没配，不算错）；
 *   注释与 BOM 容忍；畸形 JSON / 根非对象降级为空 doc 并产 warnings（列举面宁可少配不可错配）。
 * - 写 = 原子写（writeJsonAtomic）：同目录 tmp + rename（rename 同盘原子；tmp 落目标同目录防跨盘退化成拷贝），
 *   崩溃/并发读者至多见到旧文件或新文件，不见半截文件。
 * 注释识别/剥离复用 settings.ts 既有词法单点（hasJsonComments/stripJsonComments），本文件不再造解析器。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasJsonComments, stripJsonComments, loadGlobalSettings, loadProjectSettings } from '../config/settings';
import { t } from '../i18n';
import type { ResourceKind, Scope } from './types';

/** 项目作用域写面 root 必备守卫单点：root 缺失即 INVALID 拒写（resource 点名资源面进文案）——
 *  写面绝不借道 cwd 兜底，凭空落 cwd 是伪写（mcpWriteTarget 先例裁定上收）；返回验过的 root */
export function requireProjectRoot(scope: Scope, root: string | null, resource: string): string {
  if (scope === 'project' && root === null) {
    throw new CatalogWriteError(
      'INVALID',
      t(`project-scope ${resource} write requires a project root (--root)`, `project 作用域的 ${resource} 写需要项目根（--root）`),
    );
  }
  return root as string;
}

/** 写面读守卫单点（D60 五模块公共体上收）：COMMENTS 先于一切内容守卫（结构化写会毁注释，Task 15 映射
 *  409 引流 raw 编辑面）→ 畸形 JSON/根非对象 INVALID 拒写不覆盖（readJsoncDoc 降级为空 doc，照写等于毁掉
 *  用户既有内容）。返回守卫通过的读结果供调用方手术 */
export function readWritableDoc(file: string): ReturnType<typeof readJsoncDoc> {
  const read = readJsoncDoc(file);
  if (read.hasComments) {
    throw new CatalogWriteError(
      'COMMENTS',
      t(
        `${file} contains JSONC comments — a structured write would destroy them; remove the comments via the raw editor and retry`,
        `${file} 含 JSONC 注释，结构化写会毁注释；请经 raw 编辑面移除注释后重试`,
      ),
    );
  }
  if (read.exists && read.warnings.length > 0) {
    throw new CatalogWriteError('INVALID', read.warnings[0]!);
  }
  return read;
}

/** 落盘收口单点（D60 五模块公共体上收）：新档补 version:1（settings schema 口径；mcp.json 无 version
 *  语义走 bootstrapVersion:false 保持既有形态）→ 原子写 2-space + 尾随换行 → 写通知（resource/scope/root
 *  透传，与 watcher 映射同构；零变化路径由调用方先行短路，不经本函数） */
export function finishCatalogWrite(
  file: string,
  doc: Record<string, unknown>,
  existed: boolean,
  notify: { resource: ResourceKind; scope: Scope; root: string | null },
  opts?: { bootstrapVersion?: boolean },
): void {
  if (opts?.bootstrapVersion !== false && !existed && doc['version'] === undefined) doc['version'] = 1;
  writeJsonAtomic(file, JSON.stringify(doc, null, 2) + '\n');
  notifyCatalogWrite(notify.resource, notify.scope, notify.root);
}

/** 目标 scope 的 settings.json 落位单点：global=<userConfigDir>/settings.json、
 *  project=<root>/.sunshinex/settings.json（写落位=装载读位；root 缺省回退 cwd 仅服务无项目
 *  上下文的读面签名，写面经 requireProjectRoot 拒 null 后此分支不可达） */
export function settingsPathOf(scope: Scope, root: string | null): string {
  return scope === 'global' ? loadGlobalSettings() : loadProjectSettings(root ?? process.cwd());
}

/** 写入被拒：code=COMMENTS（目标文件含 JSONC 注释，结构化整写会毁注释）或 INVALID（内容不合法） */
export class CatalogWriteError extends Error {
  constructor(readonly code: 'COMMENTS' | 'INVALID', message: string) { super(message); }
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJsoncDoc(file: string): { exists: boolean; raw: string; doc: Record<string, unknown>; hasComments: boolean; warnings: string[] } {
  if (!fs.existsSync(file)) return { exists: false, raw: '', doc: {}, hasComments: false, warnings: [] };
  const raw = fs.readFileSync(file, 'utf8');
  const hasComments = hasJsonComments(raw);
  try {
    const parsed = JSON.parse(stripJsonComments(raw));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        exists: true,
        raw,
        doc: {},
        hasComments,
        warnings: [t(`${file} root must be a JSON object — treated as empty`, `${file} 根须为对象，已按空处理`)],
      };
    }
    return { exists: true, raw, doc: parsed as Record<string, unknown>, hasComments, warnings: [] };
  } catch (e) {
    return {
      exists: true,
      raw,
      doc: {},
      hasComments,
      warnings: [t(`${file} failed to parse: ${(e as Error).message}`, `${file} 解析失败：${(e as Error).message}`)],
    };
  }
}

export function writeJsonAtomic(file: string, text: string): void {
  ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/* ---------- 写通知钩子（任务14：双向实时同步的「内部写」半边） ----------
 * catalog 各写函数落盘成功后经 notifyCatalogWrite 统一通知；daemon（任务14）装配期注入
 * 「suppress watcher 回声 + 广播 config-changed 帧」。放 io.ts 单点是让全部 catalog 写共享一个
 * 回环抑制口，不逐模块穿参。缺省 null = no-op（Task 1-13 期间零行为）。
 * 口径约定：notify 的 (resource,scope,root) 与 watcher 对同一物理文件的映射同构（settings.json→
 * 'settings'、mcp.json→'mcp'、agents 目录→'agents'；scope='global' root 恒 null）——daemon 的
 * suppress 按 (resource,scope,root) 键丢 watcher 事件，键不同构则回声去重失效（自触双发）。 */

/** 写通知回调形态（catalog 写面落盘成功后携带的定位三元的消费签名） */
export type CatalogWriteNotify = (resource: ResourceKind, scope: Scope, root: string | null) => void;

/** 当前钩子（模块内可变量；经 setter 注入/摘除，catalog 模块一律走 notifyCatalogWrite 不直读） */
let onCatalogWrite: CatalogWriteNotify | null = null;

/** daemon 装配/摘除口：传 null 还原缺省 no-op（teardown 收口用） */
export function setOnCatalogWrite(fn: CatalogWriteNotify | null): void {
  onCatalogWrite = fn;
}

/** 落盘成功后的统一通知口：钩子未装配（null）时 no-op；钩子内抛错沿调用方收口
 *  （daemon 装配体自身不抛——broadcast/suppress 均为同步无异常面）。
 *  scope='global' 时 root 归一为 null：watcher 全局 DirSpec 恒 root:null，全局写携带非 null root
 *  的入参（调用方笔误）永远配不成 suppress 键——单点归一保证回声去重不因入参形态失效 */
export function notifyCatalogWrite(resource: ResourceKind, scope: Scope, root: string | null): void {
  if (onCatalogWrite === null) return;
  onCatalogWrite(resource, scope, scope === 'global' ? null : root);
}
