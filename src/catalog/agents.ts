/**
 * catalog/agents 读面 + 写面：子智能体定义（<agents 目录>/<id>/agent.md）三级位置合并列举 + 遮蔽/旧位置/
 * 启用标注；写面（Task 6）upsert/remove/setEnabled/migrate 收口（serve 面与 GUI 后续一律经此，Task 15 迁）。
 * 位置级序（高→低，与 harness.AgentRegistry.loadAgents 装载序 global→legacy→新家 last-wins 同构）：
 * 项目新家 <root>/.sunshinex/agents → 项目旧位置 <root>/agents（目录注册制历史装配口径，读面兼容
 * 列举、写面只迁不删）→ 全局 <userConfigDir>/agents。与装载面（harness.AgentRegistry）的分工：
 * 装载面 fail-fast 且每 id 运行期只装一份（Task 7 收口三级装载）；本面是「视图」——全量列出 + 来源
 * 标注（撞名者生效、被撞者标 shadowed 保留在列：新家撞全局/旧位置，旧位置撞全局——2026-10-28 终审
 * 修复波裁定视图对齐装载器语义，杜绝「显示全局、生效 legacy」的显示/运行分叉）。
 * 逐文件宽容：单文件畸形 → warnings 不抛死（沿 loadAgentsView 纪律）；enabled:false 照列（启停是
 * 写面/视图操作，运行时剔除属装载面职责）。解析词法复用 parseAgentFrontmatter 单点，不另造解析器。
 * 写面纪律（沿 serve handleAgentsPut 现纪律下沉）：先全量校验后落盘零部分写 + 将落盘字节过真解析器
 * round-trip 回环（验证口径=装载口径）；失败一律 CatalogWriteError('INVALID') 拒写、目标零触碰。
 */
import * as fs from 'fs';
import * as path from 'path';
import { userConfigDir } from '../config/env';
import { parseAgentFrontmatter } from '../harness/subagent';
import { CatalogWriteError, writeJsonAtomic, notifyCatalogWrite } from './io';
import type { Listing, Scope } from './types';

/** PUT /settings/agents 的 id 安全面（单点；Task 15 自 serve/config-helpers 上收——T6 评审移交：
 *  消除 catalog→serve 运行时依赖倒置，serve 面改从本模块 import）：id 直接拼进
 *  <agents 目录>/<id>/ 目录路径——路径分隔/穿越/点开头等形态一律拒（首字符限字母数字，
 *  余字符限 [A-Za-z0-9_-]） */
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** catalog agents 列表条目：id/scope 定位 + 遮蔽/旧位置标注 + 落盘目录 + frontmatter 元数据 + 正文预览 */
export interface AgentEntry {
  id: string;
  scope: Scope;
  /** true = 被更高优先同 id 遮蔽（被撞条目保留展示，沿 listMcpServers/loadAgentsView 视图口径——
   *  2026-10-28 终审裁定后撞名关系=装载序：新家撞全局/旧位置、旧位置撞全局均给全局/旧位置行标
   *  shadowed）；旧位置条目恒 false（撞名时旧位置是生效面——legacy 遮蔽全局；撞新家则不列） */
  shadowed: boolean;
  /** true = 来自旧位置 <root>/agents（撞新家同 id 不列；撞全局照列且生效——legacy 遮蔽全局） */
  oldLocation: boolean;
  /** 条目落盘目录（所在 agents 目录下本 id 子目录；agent.md 及同级私有文件均在此） */
  dir: string;
  meta: {
    name: string;
    description: string;
    version: string;
    memory: boolean;
    isolation?: 'worktree';
    executor?: 'internal-team' | 'external-cli';
    enabled: boolean;
  };
  /** frontmatter 之后正文前 200 字符（沿 loadAgentsView 口径，防长正文击穿设置面板） */
  bodyPreview: string;
}

/** agents 落位单点：global=<userConfigDir>/agents（globalDir 显式传参 = 测试/重定向口）；project=<root>/.sunshinex/agents（新家）。
 *  project 分支 root:null → cwd 回退仅为签名全整改（沿 mcpJsonPath 同形）；listAgents 对 root:null 刻意
 *  整体跳过项目两级（见该函数注释），不经此回退——写面调本函数前须自行保证 project 有 root。 */
export function agentsDir(scope: Scope, root: string | null, globalDir?: string): string {
  if (scope === 'global') return path.join(globalDir ?? userConfigDir(), 'agents');
  return path.join(root ?? process.cwd(), '.sunshinex', 'agents');
}

/** 旧位置（legacy）：<root>/agents —— 目录注册制历史装配口径；读面兼容列举（遮蔽全局、低于新家——
 *  与装载序同构），写面只迁不删 */
export function legacyAgentsDir(root: string): string {
  return path.join(root, 'agents');
}

/**
 * 三级合并列举（层序=装载序：全局 → 项目旧位置 → 项目新家；各层内按 id 字典序沿 listMcpServers 口径）。
 * 容错口径沿 Listing（D7）：目录缺 = 空条目不算错；单文件畸形（frontmatter 缺块/缺 name、读失败）
 * 一律降级产 warnings 不抛——列举面宁可少列不可抛死。root:null 时项目两级整体跳过（只列全局）：
 * 与 mcp 模块 root:null→cwd 回退刻意不同——mcp 需要「无项目上下文时回落 cwd 惯例位」继续可操作，
 * agents 列表面无此需求：目录注册制定义本就依附具体工作区（新家 .sunshinex/agents 与旧位置 agents
 * 皆是项目概念），凭空落 cwd 只会伪造条目。
 * 遮蔽语义（2026-10-28 终审修复波裁定，与 harness.AgentRegistry.loadAgents 装载序逐层同构）：
 * 新家最高（同 id 撞旧位置/全局，被撞行 shadowed:true 保留在列）；旧位置中间层（同 id 撞全局——
 * 旧位置照列且生效、全局行降 shadowed:true；同 id 撞新家则旧位置不列）；全局垫底。此前「全局撞旧位置
 * 时旧位置整行隐藏」的旧口径与装载器 legacy 遮蔽全局（T7 钉测）三面分歧（CLI/TUI 列全局、运行装
 * legacy），本裁定后读面单点对齐，显示与运行恒同一副本。
 */
export function listAgents(root: string | null, globalDir?: string): Listing<AgentEntry> {
  const warnings: string[] = [];
  /** 单目录扫描：仅收 <id>/agent.md 常规目录（沿 loadAgentsView 几何，无 agent.md 的目录跳过） */
  const scan = (dir: string, scope: Scope, oldLocation: boolean): Map<string, AgentEntry> => {
    const out = new Map<string, AgentEntry>();
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, 'agent.md');
      if (!fs.existsSync(file)) continue;
      try {
        const meta = parseAgentFrontmatter(fs.readFileSync(file, 'utf8'));
        out.set(entry.name, {
          id: entry.name,
          scope,
          shadowed: false,
          oldLocation,
          dir: path.join(dir, entry.name),
          meta: {
            name: meta.name,
            description: meta.description,
            version: meta.version,
            memory: meta.memory,
            ...(meta.isolation !== undefined ? { isolation: meta.isolation } : {}),
            ...(meta.executor !== undefined ? { executor: meta.executor } : {}),
            enabled: meta.enabled,
          },
          bodyPreview: meta.body.slice(0, 200),
        });
      } catch (e) {
        warnings.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  };
  const globalEntries = scan(agentsDir('global', root, globalDir), 'global', false);
  const newHome = root !== null ? scan(agentsDir('project', root, globalDir), 'project', false) : new Map<string, AgentEntry>();
  // 新家最高：同 id 撞全局——全局条目保留在列、标 shadowed:true（视图口径，装载面才真正就近取一份）
  for (const id of newHome.keys()) {
    const g = globalEntries.get(id);
    if (g) globalEntries.set(id, { ...g, shadowed: true });
  }
  // 旧位置中间层（装载序 legacy 遮蔽全局，2026-10-28 终审裁定视图对齐）：撞新家 → 不列（新家生效）；
  // 撞全局 → 照列且为生效副本（shadowed 恒 false），同 id 全局行降 shadowed:true 保留在列
  const legacy = root !== null ? scan(legacyAgentsDir(root), 'project', true) : new Map<string, AgentEntry>();
  const legacyEntries = [...legacy.values()].filter((e) => !newHome.has(e.id));
  for (const e of legacyEntries) {
    const g = globalEntries.get(e.id);
    if (g) globalEntries.set(e.id, { ...g, shadowed: true });
  }
  const byId = (a: AgentEntry, b: AgentEntry): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { entries: [...[...globalEntries.values()].sort(byId), ...[...newHome.values()].sort(byId), ...legacyEntries.sort(byId)], warnings };
}

/* ---------- 写面（Task 6）：upsert / remove / setEnabled / migrate ----------
 *  serve handleAgentsPut 的写纪律（先全量校验后落盘零部分写 + 将落盘字节过真解析器 round-trip）下沉
 *  至 catalog 单点：GUI/serve（Task 15 迁）后续一律经本面写，serve 层不再各自 fs 直写。 */

/** upsert 输入面（校验后形态）：name 必填，可选键按需；isolation/executor 枚举在类型面收窄（serve 面
 *  AgentFrontmatterInput 为 string 归一前形态，本面直校枚举——library 面自防 JS 侧越型入参） */
export interface AgentUpsertSpec {
  name: string;
  description?: string;
  memory?: boolean;
  isolation?: 'worktree';
  executor?: 'internal-team' | 'external-cli';
  body?: string;
  enabled?: boolean;
}

/** PUT /settings/agents upsert 输入的 frontmatter 面（校验后形态；Task 6 自 serve/config-helpers 迁入，
 *  serve 层改 import）：name 必填，可选键按需；调用方已保证字符串值单行（含换行的值在 400 面拒收——
 *  frontmatter 是单行 KV 词法，换行注入伪键） */
export interface AgentFrontmatterInput {
  name: string;
  description?: string;
  memory?: boolean;
  isolation?: string;
  executor?: string;
  /** Task 6 写面新增：仅 false 落行（缺省/true 由解析面「缺省 true」承载）。serve 输入面
   *  parseAgentFrontmatterInput 不产该键 → 既有调用（G8c T5 serve upsert）输出字节级零变 */
  enabled?: boolean;
}

/** agent.md 生成（G8c T5 upsert；Task 6 迁入 catalog，逐字迁移 + 末尾 enabled:false 条件行）：frontmatter
 *  键序固定 name 首位、可选键按需追加（description→memory→isolation→executor→enabled），body 缺省空串。
 *  生成物经写前 round-trip（parseAgentFrontmatter）验证后才落盘目标——装配链 loadAgents 对畸形文件
 *  fail-fast，坏文件会死锁整个会话装配，本生成器 + 回读验证是写盘前的防线 */
export function renderAgentMd(fm: AgentFrontmatterInput, body: string): string {
  const lines = [`name: ${fm.name}`];
  if (fm.description !== undefined) lines.push(`description: ${fm.description}`);
  if (fm.memory === true) lines.push('memory: true');
  if (fm.isolation !== undefined) lines.push(`isolation: ${fm.isolation}`);
  if (fm.executor !== undefined) lines.push(`executor: ${fm.executor}`);
  if (fm.enabled === false) lines.push('enabled: false');
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

/** 写面目标定位 + 双守卫（写面四函数共用）：id 安全校验（AGENT_ID_RE 本模块单点——id 直接拼
 *  目录路径，路径分隔/穿越/点开头一律拒）+ project 作用域 root 必备（agentsDir 的 root:null→cwd 回退仅为
 *  读面签名全整改兜底，写面绝不借道——凭空落 cwd 是伪写）。返回条目目录 <agents 目录>/<id> */
function agentWriteTarget(root: string | null, scope: Scope, id: string): string {
  if (!AGENT_ID_RE.test(id)) {
    throw new CatalogWriteError('INVALID', `invalid agent id: ${JSON.stringify(id)} (must match ${AGENT_ID_RE.source})`);
  }
  if (scope === 'project' && root === null) {
    throw new CatalogWriteError('INVALID', 'project-scope agent write requires root');
  }
  return path.join(agentsDir(scope, root), id);
}

/** 新增/整写一个 agent 定义（Task 6 写面收口）：renderAgentMd 生成 → 写前 round-trip（真解析器
 *  parseAgentFrontmatter + 字段回环）→ writeJsonAtomic 原子落盘（同目录 tmp+rename）。校验先于任何
 *  落盘动作——较 serve 面 tmp+回读+rename 更进一步：坏内容根本不进 tmp，目标与目录零触碰 */
export function upsertAgent(root: string | null, scope: Scope, id: string, spec: AgentUpsertSpec): void {
  const dir = agentWriteTarget(root, scope, id);
  // 全量校验后落盘零部分写（沿 handleAgentsPut 现纪律）：name 必填非空白单行；单行 KV 字段拒换行；
  // isolation/executor 枚举守卫（越型值会被解析面静默丢弃，产出「写了不生效」的死行不如写面即拒）
  if (typeof spec.name !== 'string' || spec.name.trim().length === 0 || /\r|\n/.test(spec.name)) {
    throw new CatalogWriteError('INVALID', 'agent name required (non-empty single-line string)');
  }
  const name = spec.name.trim();
  for (const [label, v] of [['description', spec.description], ['isolation', spec.isolation], ['executor', spec.executor]] as const) {
    if (v !== undefined && /\r|\n/.test(v)) {
      throw new CatalogWriteError('INVALID', `agent ${label} must be single-line (multi-line content belongs in body)`);
    }
  }
  if (spec.isolation !== undefined && spec.isolation !== 'worktree') {
    throw new CatalogWriteError('INVALID', `agent isolation must be "worktree", got ${JSON.stringify(spec.isolation)}`);
  }
  if (spec.executor !== undefined && spec.executor !== 'internal-team' && spec.executor !== 'external-cli') {
    throw new CatalogWriteError('INVALID', `agent executor must be "internal-team" | "external-cli", got ${JSON.stringify(spec.executor)}`);
  }
  const md = renderAgentMd(
    {
      name,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      ...(spec.memory === true ? { memory: true } : {}),
      ...(spec.isolation !== undefined ? { isolation: spec.isolation } : {}),
      ...(spec.executor !== undefined ? { executor: spec.executor } : {}),
      ...(spec.enabled === false ? { enabled: false } : {}),
    },
    spec.body ?? '',
  );
  // round-trip（验证口径=装载口径）：将落盘字节过真解析器 + 逐字段回环，任一不符 → INVALID 拒写
  let meta: ReturnType<typeof parseAgentFrontmatter>;
  try {
    meta = parseAgentFrontmatter(md);
  } catch (e) {
    throw new CatalogWriteError('INVALID', `generated agent.md failed validation (<agents>/${id}/agent.md): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (meta.name !== name) throw new CatalogWriteError('INVALID', `round-trip name mismatch: ${JSON.stringify(meta.name)}`);
  if (meta.memory !== (spec.memory === true)) throw new CatalogWriteError('INVALID', `round-trip memory mismatch (<agents>/${id}/agent.md)`);
  if (meta.isolation !== spec.isolation) throw new CatalogWriteError('INVALID', `round-trip isolation mismatch (<agents>/${id}/agent.md)`);
  if (meta.executor !== spec.executor) throw new CatalogWriteError('INVALID', `round-trip executor mismatch (<agents>/${id}/agent.md)`);
  if (meta.enabled !== (spec.enabled !== false)) throw new CatalogWriteError('INVALID', `round-trip enabled mismatch (<agents>/${id}/agent.md)`);
  writeJsonAtomic(path.join(dir, 'agent.md'), md);
  // 任务14 写通知：agent.md 落盘 → ('agents', scope, root)（与 watcher agents 目录映射同构）
  notifyCatalogWrite('agents', scope, root);
}

/** 移除一个 agent 定义：rm -rf 条目整目录（agent.md 及同级私有文件一并清）；不存在 → INVALID
 *  （catalog 写面严格语义；幂等收口属 serve 面——Task 15 迁时由 handler 裁量） */
export function removeAgent(root: string | null, scope: Scope, id: string): void {
  const dir = agentWriteTarget(root, scope, id);
  if (!fs.existsSync(dir)) throw new CatalogWriteError('INVALID', `agent not found: ${scope}/agents/${id}`);
  fs.rmSync(dir, { recursive: true });
  // 任务14 写通知：条目整目录移除同样是配置变更（rm 非原子写路径，成功后同样补一行）
  notifyCatalogWrite('agents', scope, root);
}

/** frontmatter enabled 行保序手术（setEnabled 单点）：块内既有 enabled 行原位替换（位置不动）；缺行则
 *  保序插入（description 后 → name 后 → 块尾兜底）；其余键行序逐字不动（非整块重写——用户手排键序与
 *  行尾注释风格均保真）。frontmatter 块缺失/未闭合 → INVALID。逐行 trim 判定容忍 CRLF（仅被替换/
 *  插入的行归一 \n，其余行原样）。词法说明：行级手术需行位信息，parseFrontmatterKV 只出 KV 不出行位，
 *  故本面自扫 `---` 块界（块界判定与 harness FRONTMATTER 词法同形） */
function patchEnabledLine(md: string, id: string, enabled: boolean): string {
  const lines = md.split('\n');
  if ((lines[0] ?? '').trim() !== '---') {
    throw new CatalogWriteError('INVALID', `agent.md missing frontmatter: <agents>/${id}/agent.md`);
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '---') { close = i; break; }
  }
  if (close === -1) {
    throw new CatalogWriteError('INVALID', `agent.md frontmatter unterminated: <agents>/${id}/agent.md`);
  }
  const findLine = (re: RegExp): number => {
    for (let i = 1; i < close; i++) if (re.test((lines[i] ?? '').trim())) return i;
    return -1;
  };
  const line = `enabled: ${enabled}`;
  const at = findLine(/^enabled\s*:/);
  if (at !== -1) lines[at] = line; // 原位替换：不新增行、不挪位
  else {
    let insertAfter = findLine(/^description\s*:/);
    if (insertAfter === -1) insertAfter = findLine(/^name\s*:/);
    if (insertAfter === -1) insertAfter = close - 1; // 块尾兜底（无 name 行的畸形块由写后回环拒收）
    lines.splice(insertAfter + 1, 0, line);
  }
  return lines.join('\n');
}

/** 启停一个 agent（Task 6 写面）：读 agent.md → frontmatter 增/改 enabled 行（patchEnabledLine 保序
 *  手术，非整块重写）→ 原子写回（writeJsonAtomic 对任意文本文件同款 tmp+rename）→ 将落盘字节过真
 *  解析器回环（enabled 不符/畸形 → INVALID 拒写，目标零触碰）。id 不在该作用域（agent.md 缺）→ INVALID */
export function setAgentEnabled(root: string | null, scope: Scope, id: string, enabled: boolean): void {
  const dir = agentWriteTarget(root, scope, id);
  const file = path.join(dir, 'agent.md');
  if (!fs.existsSync(file)) throw new CatalogWriteError('INVALID', `agent not found: ${scope}/agents/${id}`);
  const md = fs.readFileSync(file, 'utf8'); // 存在性竞态移除 → 读抛错沿调用方收口（serve 面 500 同惯例）
  const patched = patchEnabledLine(md, id, enabled);
  let meta: ReturnType<typeof parseAgentFrontmatter>;
  try {
    meta = parseAgentFrontmatter(patched);
  } catch (e) {
    throw new CatalogWriteError('INVALID', `patched agent.md failed validation (<agents>/${id}/agent.md): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (meta.enabled !== enabled) throw new CatalogWriteError('INVALID', `round-trip enabled mismatch (<agents>/${id}/agent.md)`);
  writeJsonAtomic(file, patched);
  // 任务14 写通知：enabled 手术落盘 → ('agents', scope, root)
  notifyCatalogWrite('agents', scope, root);
}

/** 旧位置 → 新家迁移（Task 6 写面，写面「只迁不删」的一半）：<root>/agents/<id>/ 整目录递归拷入
 *  <root>/.sunshinex/agents/<id>/（fs.cpSync 内建递归拷贝，零新依赖；agent.md 及同级私有文件随迁）。
 *  旧目录保留不删（旧位置读面兼容列举靠同 id 碰撞自然让位，见 listAgents；删除属用户显式操作）。
 *  缺源 / 撞目标（新家已存在）/ 非法 id → INVALID——迁移是一次性动作，幂等重放由调用方显式裁定 */
export function migrateAgent(root: string, id: string): void {
  if (!AGENT_ID_RE.test(id)) {
    throw new CatalogWriteError('INVALID', `invalid agent id: ${JSON.stringify(id)} (must match ${AGENT_ID_RE.source})`);
  }
  const src = path.join(legacyAgentsDir(root), id);
  const dest = path.join(agentsDir('project', root), id);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    throw new CatalogWriteError('INVALID', `legacy agent not found: agents/${id}`);
  }
  if (fs.existsSync(dest)) {
    throw new CatalogWriteError('INVALID', `destination already exists: .sunshinex/agents/${id}`);
  }
  fs.cpSync(src, dest, { recursive: true });
  // 任务14 写通知：迁入新家 = 项目 agents 目录新增条目（cp 非原子写路径，成功后同样补一行；恒 project）
  notifyCatalogWrite('agents', 'project', root);
}
