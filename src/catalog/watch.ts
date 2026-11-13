/**
 * catalog/watch（任务13）：配置变更监听原语——目录级 fs.watch + 300ms 防抖 + 写回环抑制 + 失败降级。
 * 供任务14 daemon 接线，构成配置双向实时同步的「外部变更感知」半边；零新依赖，只用 node:fs.watch。
 * 设计口径（win32 实测口径）：
 * - fs.watch 按目录监听：globalDir 本层 + agents/plugins/teams 子目录；项目侧监听 <root>/.sunshinex 本层
 *   + skills/agents/teams 子目录，另挂 .agents/.claude/.codex/.cursor 兼容技能根的 skills/ 子目录
 *   （目录清单派生自 PROJECT_SKILL_ROOTS_ASC 单点；缺失目录逐个降级跳过）。
 * - Windows 上编辑器原子替换/重命名的事件常落在目录上、filename 可能只是子目录名——一律以
 *   「哪个被监听目录响了」定 scope/root 与固定 resource，本层文件再按 filename 前缀映射，不依赖单一 filename 的精确性。
 * - 同 (resource,scope,root) 300ms 防抖合并为一次回调；suppress() 在窗口期丢弃对应事件并撤销已挂起的防抖
 *   （daemon 写自身配置时抑制回声，防止自己写→自己收的回环）。
 * - 监听失败（目录不存在/权限不足/平台不支持递归）→ console.warn 降级：该目录不产事件、不 throw
 *   （功能回退 GET 即读，调用方无感）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECT_SKILL_ROOTS_ASC } from '../harness/skills';
import type { ResourceKind, Scope } from './types';

/** 一次配置变更（已归并到资源粒度）：订阅方据此刷新对应 catalog */
export interface ConfigChange { resource: ResourceKind; scope: Scope; root: string | null }

/** 防抖窗口：同 (resource,scope,root) 窗口内多次事件合并为一次回调（吸收编辑器/原子写的事件风暴） */
const DEBOUNCE_MS = 300;

/** 一条被监听物理目录的映射：resource=null 表示本层文件按 filename 前缀映射（settings.json/mcp.json），否则目录定 resource */
interface DirSpec { dir: string; resource: ResourceKind | null; scope: Scope; root: string | null }

/** 单条目录监听句柄 + 其映射 */
interface WatchEntry { watcher: fs.FSWatcher; spec: DirSpec }

/** 按「逻辑监听根」分组（global / project:<root>），unwatchProject 据此整组拆除 */
interface WatchGroup { key: string; entries: WatchEntry[] }

/** (resource,scope,root) 事件键：防抖与抑制共用 */
function changeKey(c: { resource: ResourceKind; scope: Scope; root: string | null }): string {
  return `${c.resource}\u0000${c.scope}\u0000${c.root ?? ''}`;
}

/**
 * filename（可能含子路径、win32 反斜杠）→ ResourceKind；映射不出返回 null（无关/临时文件，忽略）。
 * 路径段优先（skills/agents/plugins/teams 子目录事件，win32 目录级冒泡时 filename 常只是子目录名），
 * 本层文件按 basename 精确匹配（原子写 rename 事件落在最终文件名上）。
 */
export function mapFilename(filename: string): ResourceKind | null {
  const segments = filename.replace(/\\/g, '/').split('/');
  for (const s of segments) {
    if (s === 'skills') return 'skills';
    if (s === 'agents') return 'agents';
    if (s === 'plugins') return 'plugins';
    if (s === 'teams') return 'teams';
  }
  const base = segments[segments.length - 1];
  if (base === 'settings.json') return 'settings';
  if (base === 'mcp.json') return 'mcp';
  if (base === 'SUNSHINE.md') return 'sunshine'; // 全局规范(2026-11-05 设置页「全局规范」面板)——globalDir 本层
  return null;
}

export class ConfigWatcher {
  private callbacks: Array<(c: ConfigChange) => void> = [];
  private groups = new Map<string, WatchGroup>();
  /** 防抖挂起：key → 定时器 + 待发变更（抑制/拆除时撤销） */
  private pending = new Map<string, { timer: ReturnType<typeof setTimeout>; change: ConfigChange }>();
  /** 写回环抑制：key → 截止时刻（epoch ms） */
  private suppressedUntil = new Map<string, number>();
  private closed = false;

  /** 监听全局目录：globalDir 本层文件（settings.json/mcp.json）+ agents/ plugins/ teams/ 子目录
   *  （缺失的子目录逐个降级，不影响其余）；另挂 HOME 下 .cursor/.codex/.claude/.agents 兼容技能根
   *  的 skills/ 子目录（2026-11-13 用户裁定「skills 加载兼容全局四根」,清单派生自
   *  PROJECT_SKILL_ROOTS_ASC 单点,.sunshinex 即 globalDir 本体不重复挂） */
  watchGlobal(globalDir: string): void {
    const home = path.dirname(path.resolve(globalDir));
    const compatGlobalSkillSpecs = PROJECT_SKILL_ROOTS_ASC
      .filter((dot) => dot !== '.sunshinex')
      .map((dot) => ({ dir: path.join(home, dot, 'skills'), resource: 'skills' as const, scope: 'global' as const, root: null }));
    this.watchGroup('global', [
      { dir: globalDir, resource: null, scope: 'global', root: null },
      { dir: path.join(globalDir, 'agents'), resource: 'agents', scope: 'global', root: null },
      { dir: path.join(globalDir, 'plugins'), resource: 'plugins', scope: 'global', root: null },
      { dir: path.join(globalDir, 'teams'), resource: 'teams', scope: 'global', root: null },
      ...compatGlobalSkillSpecs,
    ]);
  }

  /** 监听项目根：<root>/.sunshinex 整目录（本层文件 + skills/ agents/ teams/ 子目录），另挂
   *  .agents/.claude/.codex/.cursor 兼容技能根的 skills/ 子目录（清单派生自 PROJECT_SKILL_ROOTS_ASC 单点，
   *  .sunshinex 已含其中，不重复挂）；重复监听同一 root 幂等跳过 */
  watchProject(root: string): void {
    const base = path.join(root, '.sunshinex');
    const compatSkillSpecs = PROJECT_SKILL_ROOTS_ASC
      .filter((dot) => dot !== '.sunshinex')
      .map((dot) => ({ dir: path.join(root, dot, 'skills'), resource: 'skills' as const, scope: 'project' as const, root }));
    this.watchGroup(`project:${path.resolve(root)}`, [
      { dir: base, resource: null, scope: 'project', root },
      { dir: path.join(base, 'skills'), resource: 'skills', scope: 'project', root },
      { dir: path.join(base, 'agents'), resource: 'agents', scope: 'project', root },
      { dir: path.join(base, 'teams'), resource: 'teams', scope: 'project', root },
      ...compatSkillSpecs,
    ]);
  }

  /** 停止某项目的监听（整组拆句柄、撤销其挂起防抖）；未监听过则空操作 */
  unwatchProject(root: string): void {
    const key = `project:${path.resolve(root)}`;
    const group = this.groups.get(key);
    if (!group) return;
    for (const entry of group.entries) this.closeEntry(entry);
    this.groups.delete(key);
    for (const [k, p] of this.pending) {
      if (p.change.scope === 'project' && p.change.root === root) { clearTimeout(p.timer); this.pending.delete(k); }
    }
  }

  /** 项目 root 是否已在监听（daemon onCatalogWrite 补监听判定用，终审修复波 2026-10-28）：
   *  path.resolve 归一后查组键——与 watchProject/unwatchProject 同键法，与「零条目组不注册」的
   *  重试语义对齐（目录缺失未挂上 = false，后续写事件可再触发重试） */
  isProjectWatched(root: string): boolean {
    return this.groups.has(`project:${path.resolve(root)}`);
  }

  /** 注册变更回调（可多次注册，事件到达时依次调用） */
  onChange(cb: (c: ConfigChange) => void): void {
    this.callbacks.push(cb);
  }

  /** 写回环抑制：windowMs（缺省 500）内丢弃对应 (resource,scope,root) 事件，并撤销该键已挂起的防抖 */
  suppress(resource: ResourceKind, scope: Scope, root: string | null, windowMs = 500): void {
    const key = changeKey({ resource, scope, root });
    this.suppressedUntil.set(key, Date.now() + windowMs);
    const p = this.pending.get(key);
    if (p) { clearTimeout(p.timer); this.pending.delete(key); }
  }

  /** 关闭全部监听并清空状态；close 后任何残留事件不再产生回调 */
  close(): void {
    this.closed = true;
    for (const group of this.groups.values()) for (const entry of group.entries) this.closeEntry(entry);
    this.groups.clear();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.suppressedUntil.clear();
    this.callbacks = [];
  }

  // ---- 内部 ----

  /** 建立一组目录监听；同 key 已在监听则跳过（避免重复事件源），失败目录逐个降级不 throw。
   *  零条目组（全部目录缺失等）不注册：后续再次 watchXxx 自然重试——否则组键占位会把重试变成静默空操作。 */
  private watchGroup(key: string, specs: DirSpec[]): void {
    if (this.closed || this.groups.has(key)) return;
    const group: WatchGroup = { key, entries: [] };
    for (const spec of specs) {
      const entry = this.tryWatch(spec);
      if (entry) group.entries.push(entry);
    }
    if (group.entries.length > 0) this.groups.set(key, group);
  }

  /** 单目录尝试监听：目录缺失/权限不足 → warn 降级返回 null；平台不支持递归时回退非递归（至少本层生效） */
  private tryWatch(spec: DirSpec): WatchEntry | null {
    if (!fs.existsSync(spec.dir)) {
      console.warn(`[catalog/watch] 目录不存在，跳过监听（降级 GET 即读）: ${spec.dir}`);
      return null;
    }
    try {
      return this.startEntry(spec, true);
    } catch (recursiveErr) {
      try {
        return this.startEntry(spec, false);
      } catch (e) {
        console.warn(`[catalog/watch] 监听失败（降级 GET 即读）: ${spec.dir}: ${(e as Error).message}` +
          `（recursive 失败: ${(recursiveErr as Error).message}）`);
        return null;
      }
    }
  }

  private startEntry(spec: DirSpec, recursive: boolean): WatchEntry {
    const watcher = fs.watch(spec.dir, { recursive }, (_event, filename) => this.onFsEvent(spec, filename));
    // 监听期 error（如 win32 原子替换瞬间 EPERM）只 warn 降级，不让进程因未处理 error 事件崩溃
    watcher.on('error', (err) => console.warn(`[catalog/watch] 监听异常（降级忽略）: ${spec.dir}: ${(err as Error).message}`));
    return { watcher, spec };
  }

  /** 原始 fs 事件入口：目录+filename 双重映射 → 抑制检查 → 防抖合并 → 回调 */
  private onFsEvent(spec: DirSpec, filename: string | null): void {
    if (this.closed) return;
    const resource = spec.resource ?? (filename !== null ? mapFilename(filename) : null);
    if (resource === null) return; // 无关/临时文件
    const change: ConfigChange = { resource, scope: spec.scope, root: spec.root };
    const key = changeKey(change);
    const until = this.suppressedUntil.get(key);
    if (until !== undefined) {
      if (Date.now() < until) return; // 写回环抑制窗口内：丢弃
      this.suppressedUntil.delete(key);
    }
    const prev = this.pending.get(key);
    if (prev) clearTimeout(prev.timer); // 窗口内后续事件只续期，不叠加回调
    const timer = setTimeout(() => {
      this.pending.delete(key);
      for (const cb of this.callbacks) cb(change);
    }, DEBOUNCE_MS);
    this.pending.set(key, { timer, change });
  }

  private closeEntry(entry: WatchEntry): void {
    try { entry.watcher.close(); } catch { /* 句柄已失效则忽略 */ }
  }
}
