/**
 * catalog/providers 读面 + 写面：settings.json providers 键（多源多模型清单）的两级装载视图 + 结构化写单点。
 * §15 providers 归一化的数据基座：缺省模型 = 首源首模型（choices[0]，choices 序 = providers 序 ×
 * models 序即默认序）、tier 标注供档位路由消费。两视图一次装载：providers=源级分组（ProviderEntry，
 * 文件结构镜像 + 密钥在场标注）、choices=展平生效值（ModelChoice，条目级 > 源级缺省）。
 * 两级整键遮蔽与形状裁决一律复用 config/providers 装载单点（loadProvidersFull），本模块零解析逻辑——
 * 密钥永不回传值，只标 apiKeyEnv 槽名与 apiKeyPresent 在场布尔（GET /settings providers 面先例）。
 * 写面（Task 10）：upsert/remove/modelAdd/modelRemove/modelMove/setProviderApiKey 收口（REST/CLI/GUI
 * 后续一律经此），写纪律沿 catalog/plugins、catalog/approvals 同款——见写面节注释。
 */
import { loadProvidersFull, providerApiKeyEnv, resolveProviderApiKey } from '../config/providers';
import type { ModelChoice, ParsedProviderEntry } from '../config/providers';
import { loadGlobalSettings, loadProjectSettings } from '../config/settings';
import { parseEffort, EFFORT_ORDER } from '../model/effort';
import type { ReasoningEffort, ModelTier } from '../types';
import type { Scope } from './types';
import { CatalogWriteError, readJsoncDoc, writeJsonAtomic, notifyCatalogWrite } from './io';

/** 单个源条目：config 解析面的源级分组（name/baseUrl/源级显式字段/models 条目显式值）+ 密钥面 */
export interface ProviderEntry extends ParsedProviderEntry {
  /** 该源专用密钥槽名（SUNSHINEX_API_KEY_<大写源名>） */
  apiKeyEnv: string;
  /** 专用槽或主槽 SUNSHINEX_API_KEY 任一有值 = true（resolveProviderApiKey 判存，值不回传） */
  apiKeyPresent: boolean;
}

/** providers 读面：root:null 仅全局（loadProvidersFull 同语义）；providers 与 choices 同源同序，
 *  warnings 为装载告警单（形状裁决逐条跳过/忽略的告知面） */
export function listProviders(root: string | null): { providers: ProviderEntry[]; choices: ModelChoice[]; warnings: string[] } {
  const full = loadProvidersFull(root);
  return {
    providers: full.providers.map((g) => ({
      ...g,
      apiKeyEnv: providerApiKeyEnv(g.name),
      apiKeyPresent: resolveProviderApiKey(g.name) !== undefined,
    })),
    choices: full.choices,
    warnings: full.warnings,
  };
}

/* ---------- 写面（Task 10）：upsert/remove/modelAdd/modelRemove/modelMove/setProviderApiKey ----------
 *  写纪律沿 catalog/plugins（Task 4）/ catalog/approvals（Task 3）同款：
 *  - 读原文（readJsoncDoc）→ 改 doc → writeJsonAtomic 原子写回；盘上形态 2-space + 尾随换行，新档补 version:1；
 *  - 目标文件含 JSONC 注释 → CatalogWriteError('COMMENTS')（结构化整写会毁注释，Task 15 映射 409 引流
 *    raw 编辑面）；COMMENTS 先于一切内容守卫（守卫序与 plugins 同：先收口文件可写性，再谈内容对错）；
 *  - 畸形 JSON/根非对象 → CatalogWriteError('INVALID')（readJsoncDoc 降级为空 doc，照写等于毁掉用户
 *    既有内容——结构化写不越权覆盖）；
 *  - 零变化不落盘（同值重写零盘上副作用）；providers 键形状坏（非数组）→ 整键重置（plugins 键同款
 *    先例：装载面告警忽略坏形状，写面不保留垃圾）；
 *  - 定位语义：增删改/模型三操作在目标文件自身 providers 数组内按 name 定位——两级整键遮蔽下目标
 *    文件是该 scope 落盘的唯一权威，他级条目无从在本级文件手术（全局源在 project 写即 add 路径，
 *    baseUrl+非空 models 必备，杜绝造出解析面拒载的部分条目）；setProviderApiKey 的 provider 在场
 *    判定走该 scope 装载视图（listProviders：project=项目或全局、global=仅全局）——env 槽属装载语义
 *    而非文件结构，凡装载口径可见的源即可在本级 env 块落专用密钥；
 *  - project 作用域 root:null → CatalogWriteError('INVALID')（agentWriteTarget 先例：cwd 回退仅为
 *    读面签名兜底，写面绝不借道——凭空落 cwd 是伪写）；
 *  - 全部返回 void、零打印（密钥值无任何回显路径，echo 属调用面禁域）。 */

/** models 条目输入面（写面只收对象形态——字符串速记是文件装载的宽容形态，不入写面） */
export interface ProviderModelInput {
  model: string;
  tier?: ModelTier;
  contextWindow?: number;
  reasoningEffort?: ReasoningEffort;
  supportsImages?: boolean;
}

/** upsert 输入面：可选字段按需（未提字段不动）；models 仅对象形态条目，在场即整组替换 */
export interface ProviderUpsertPatch {
  name?: string;
  baseUrl?: string;
  contextWindow?: number;
  reasoningEffort?: ReasoningEffort;
  supportsImages?: boolean;
  models?: ProviderModelInput[];
}

/** 写面目标文件落位 + project root 必备守卫（agentWriteTarget 先例）：project=<root>/.sunshinex/settings.json、
 *  global=<userConfigDir>/settings.json（loadGlobalSettings/loadProjectSettings 单点，写落位 = 装载读位） */
function providerWriteFile(root: string | null, scope: Scope): string {
  if (scope === 'project' && root === null) {
    throw new CatalogWriteError('INVALID', 'project-scope provider write requires root');
  }
  return scope === 'global' ? loadGlobalSettings() : loadProjectSettings(root as string);
}

/** 写面文件守卫公共体（各写函数第一步）：COMMENTS 先于一切内容守卫 → 畸形 JSON/根非对象 INVALID 拒写不覆盖 */
function readWriteDoc(root: string | null, scope: Scope): { file: string; read: ReturnType<typeof readJsoncDoc> } {
  const file = providerWriteFile(root, scope);
  const read = readJsoncDoc(file);
  if (read.hasComments) {
    throw new CatalogWriteError('COMMENTS', `${file} 含 JSONC 注释，结构化写会毁注释；请经 raw 编辑面移除注释后重试`);
  }
  if (read.exists && read.warnings.length > 0) {
    // 畸形 JSON/根非对象：readJsoncDoc 降级为空 doc，照写等于毁掉用户既有内容——拒写引流修文件
    throw new CatalogWriteError('INVALID', read.warnings[0]!);
  }
  return { file, read };
}

/** 落盘收口：新档补 version:1（settings schema 口径，plugins/approvals 同款）→ 原子写 2-space + 尾随换行
 *  → 任务14 写通知（root/scope 透传自各写函数；写的是目标 scope 的 settings.json → ('settings', scope, root)，
 *  与 watcher settings.json 映射同构——六写经本单点统一回填） */
function finishWrite(root: string | null, scope: Scope, file: string, read: ReturnType<typeof readJsoncDoc>, doc: Record<string, unknown>): void {
  if (!read.exists && doc['version'] === undefined) doc['version'] = 1;
  writeJsonAtomic(file, JSON.stringify(doc, null, 2) + '\n');
  notifyCatalogWrite('settings', scope, root);
}

/** 对象形状裁决（条目/env 块通用）：非对象或数组 → undefined */
const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** doc 的 providers 数组取面：键形状坏（非数组）→ 整键重置（plugins 键同款先例）。仅改内存 doc，
 *  拒写路径不落盘零盘上副作用 */
function providersArrayOf(doc: Record<string, unknown>): unknown[] {
  const cur = doc['providers'];
  if (Array.isArray(cur)) return cur;
  const fresh: unknown[] = [];
  doc['providers'] = fresh;
  return fresh;
}

/** providers 条目按 name 定位（trim 对齐解析面口径：文件里手写的未 trim 名照样可定位）；不在 → -1 */
function entryIndexByName(arr: unknown[], name: string): number {
  return arr.findIndex((e) => {
    const rec = asRecord(e);
    return rec !== undefined && typeof rec['name'] === 'string' && rec['name'].trim() === name;
  });
}

/** models 条目的模型名取面（文件两形态：字符串速记 / 对象；坏形态或空名 → undefined） */
function modelNameOf(item: unknown): string | undefined {
  if (typeof item === 'string') {
    const s = item.trim();
    return s === '' ? undefined : s;
  }
  const rec = asRecord(item);
  if (rec === undefined || typeof rec['model'] !== 'string') return undefined;
  const s = rec['model'].trim();
  return s === '' ? undefined : s;
}

/** 校验辅助：contextWindow 须为正数（解析面同口径） */
function assertWindow(label: string, v: number): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new CatalogWriteError('INVALID', `providers.${label} contextWindow 须为正数，收到 ${JSON.stringify(v)}`);
  }
}

/** 校验辅助：reasoningEffort 须为合法档位（parseEffort 单点复用） */
function assertEffort(label: string, v: string): void {
  if (parseEffort(v) === undefined) {
    throw new CatalogWriteError('INVALID', `providers.${label} reasoningEffort 须为 ${EFFORT_ORDER.join('|')}，收到 ${JSON.stringify(v)}`);
  }
}

/** 校验辅助：tier 须为 small|medium|large（解析面同口径） */
function assertTier(label: string, v: ModelTier): void {
  if (v !== 'small' && v !== 'medium' && v !== 'large') {
    throw new CatalogWriteError('INVALID', `providers.${label} tier 须为 small|medium|large，收到 ${JSON.stringify(v)}`);
  }
}

/** models 条目校验 + 归一（trim 模型名；显式值逐位校验——坏值写面即拒，不做「告警忽略」半写）。
 *  产物形状与 ParsedProviderEntry.models 条目一致（文件结构镜像，键序 model→contextWindow→
 *  reasoningEffort→supportsImages→tier） */
function normalizeModelEntry(label: string, input: ProviderModelInput): ParsedProviderEntry['models'][number] {
  if (asRecord(input) === undefined) {
    throw new CatalogWriteError('INVALID', `providers.${label} models 条目须为 { model, ... } 对象（写面不收字符串速记）`);
  }
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (model === '') {
    throw new CatalogWriteError('INVALID', `providers.${label} models 条目 model 须为非空字符串`);
  }
  const sub = `${label} models.${model}`;
  if (input.contextWindow !== undefined) assertWindow(sub, input.contextWindow);
  if (input.reasoningEffort !== undefined) assertEffort(sub, input.reasoningEffort);
  if (input.supportsImages !== undefined && typeof input.supportsImages !== 'boolean') {
    throw new CatalogWriteError('INVALID', `providers.${sub} supportsImages 须为布尔，收到 ${JSON.stringify(input.supportsImages)}`);
  }
  if (input.tier !== undefined) assertTier(sub, input.tier);
  return {
    model,
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.supportsImages !== undefined ? { supportsImages: input.supportsImages } : {}),
    ...(input.tier !== undefined ? { tier: input.tier } : {}),
  };
}

/** models 数组整组构建：逐条归一 + 组内同名拒收（解析面对重复是装载去重，写面在源头即拒） */
function buildModelList(label: string, models: ProviderModelInput[]): ParsedProviderEntry['models'] {
  const built = models.map((m) => normalizeModelEntry(label, m));
  const seen = new Set<string>();
  for (const m of built) {
    if (seen.has(m.model)) {
      throw new CatalogWriteError('INVALID', `providers.${label} models 组内模型名重复: ${m.model}`);
    }
    seen.add(m.model);
  }
  return built;
}

/** provider 身份参数归一：非字符串或空白 → INVALID */
function providerLabel(provider: string): string {
  const label = typeof provider === 'string' ? provider.trim() : '';
  if (label === '') throw new CatalogWriteError('INVALID', 'provider name 须为非空字符串');
  return label;
}

/**
 * 新增/增量更新一个源（provider 身份 = name 参数）：
 * - add（目标文件 providers 数组内无同名条目）：baseUrl 与非空 models 必备——两者缺任一都是解析面
 *   拒载的非法形态（providers 条目缺 baseUrl / models 空即跳过），写面同口径拒收；patch.name 在场须
 *   与 name 参数一致（add 的身份只来自 name 参数）；
 * - update（同名条目在场）：增量手术，未提字段不动（含条目内用户手写其余键原样透传）；patch.models
 *   在场整组替换（非增量合并，逐条校验 + 组内同名拒收）；patch.name 改名（撞他源名 → INVALID）；
 * - patch 字段先全量校验后落盘（零部分写）；零变化不落盘。
 */
export function upsertProvider(root: string | null, scope: Scope, name: string, patch: ProviderUpsertPatch): void {
  const { file, read } = readWriteDoc(root, scope); // 文件守卫在先：COMMENTS 先于一切内容守卫（含参数形状校验）
  const label = providerLabel(name);
  // patch 全量校验（先于任何 mutation）：baseUrl trim 后非空、显式值逐位合法
  const baseUrl = patch.baseUrl !== undefined ? (typeof patch.baseUrl === 'string' ? patch.baseUrl.trim() : '') : undefined;
  if (baseUrl === '') throw new CatalogWriteError('INVALID', `providers.${label} baseUrl 须为非空字符串`);
  if (patch.contextWindow !== undefined) assertWindow(label, patch.contextWindow);
  if (patch.reasoningEffort !== undefined) assertEffort(label, patch.reasoningEffort);
  if (patch.supportsImages !== undefined && typeof patch.supportsImages !== 'boolean') {
    throw new CatalogWriteError('INVALID', `providers.${label} supportsImages 须为布尔，收到 ${JSON.stringify(patch.supportsImages)}`);
  }
  const patchName = patch.name !== undefined ? (typeof patch.name === 'string' ? patch.name.trim() : '') : undefined;
  if (patchName === '') throw new CatalogWriteError('INVALID', 'patch.name 在场时须为非空字符串');
  const doc = read.doc;
  const arr = providersArrayOf(doc);
  const idx = entryIndexByName(arr, label);
  if (idx === -1) {
    // add 路径：baseUrl 与非空 models 必备（models 空的源是解析面拒载形态）
    if (baseUrl === undefined) throw new CatalogWriteError('INVALID', `providers.${label} 新建须携带 baseUrl`);
    if (!Array.isArray(patch.models) || patch.models.length === 0) {
      throw new CatalogWriteError('INVALID', `providers.${label} 新建须携带非空 models 数组（models 空的源是非法形态）`);
    }
    if (patchName !== undefined && patchName !== label) {
      throw new CatalogWriteError('INVALID', `providers 新建的 name 身份来自 name 参数，patch.name=${JSON.stringify(patchName)} 与之不符`);
    }
    arr.push({
      name: label,
      baseUrl,
      ...(patch.contextWindow !== undefined ? { contextWindow: patch.contextWindow } : {}),
      ...(patch.reasoningEffort !== undefined ? { reasoningEffort: patch.reasoningEffort } : {}),
      ...(patch.supportsImages !== undefined ? { supportsImages: patch.supportsImages } : {}),
      models: buildModelList(label, patch.models),
    });
    finishWrite(root, scope, file, read, doc);
    return;
  }
  // update 路径：增量手术（未提字段不动，其余键原样透传）
  const cur = arr[idx] as Record<string, unknown>;
  const next = { ...cur };
  if (patchName !== undefined && patchName !== label) {
    if (entryIndexByName(arr, patchName) !== -1) {
      throw new CatalogWriteError('INVALID', `providers.${patchName} 已存在，改名撞源`);
    }
    next['name'] = patchName;
  }
  if (baseUrl !== undefined) next['baseUrl'] = baseUrl;
  if (patch.contextWindow !== undefined) next['contextWindow'] = patch.contextWindow;
  if (patch.reasoningEffort !== undefined) next['reasoningEffort'] = patch.reasoningEffort;
  if (patch.supportsImages !== undefined) next['supportsImages'] = patch.supportsImages;
  if (patch.models !== undefined) {
    if (!Array.isArray(patch.models) || patch.models.length === 0) {
      throw new CatalogWriteError('INVALID', `providers.${label} models 替换须为非空数组（models 空的源是非法形态）`);
    }
    next['models'] = buildModelList(label, patch.models);
  }
  if (JSON.stringify(cur) !== JSON.stringify(next)) {
    arr[idx] = next;
    finishWrite(root, scope, file, read, doc);
  }
}

/** 移除一个源整条目：目标文件 providers 数组内无同名条目 → INVALID（catalog 写面严格语义，
 *  幂等收口属调用面裁量） */
export function removeProvider(root: string | null, scope: Scope, name: string): void {
  const { file, read } = readWriteDoc(root, scope);
  const label = providerLabel(name);
  const doc = read.doc;
  const arr = providersArrayOf(doc);
  const idx = entryIndexByName(arr, label);
  if (idx === -1) throw new CatalogWriteError('INVALID', `provider not found: ${scope}/providers/${label}`);
  arr.splice(idx, 1);
  finishWrite(root, scope, file, read, doc);
}

/** 追加一个模型到指定源：同源同模型名已存在（字符串速记/对象两形态都算同名）→ INVALID（幂等拒绝）；
 *  既有 models 槽形状坏 → 该槽重置后重建（plugins 记录形状坏写面重建同款先例） */
export function modelAdd(root: string | null, scope: Scope, provider: string, entry: ProviderModelInput): void {
  const { file, read } = readWriteDoc(root, scope);
  const label = providerLabel(provider);
  const built = normalizeModelEntry(label, entry); // 先全量校验后落盘（零部分写）
  const doc = read.doc;
  const arr = providersArrayOf(doc);
  const idx = entryIndexByName(arr, label);
  if (idx === -1) throw new CatalogWriteError('INVALID', `provider not found: ${scope}/providers/${label}`);
  const cur = arr[idx] as Record<string, unknown>;
  const rawModels = cur['models'];
  if (Array.isArray(rawModels) && rawModels.some((m) => modelNameOf(m) === built.model)) {
    throw new CatalogWriteError('INVALID', `providers.${label} 模型已存在: ${built.model}（同名重复拒绝）`);
  }
  cur['models'] = [...(Array.isArray(rawModels) ? rawModels : []), built];
  finishWrite(root, scope, file, read, doc);
}

/** 摘除一个模型：源不在/模型不在 → INVALID；最后一条模型摘除后源整条删除（providers 条目 models
 *  空即非法形态，留空等于造出装载面拒载的源） */
export function modelRemove(root: string | null, scope: Scope, provider: string, model: string): void {
  const { file, read } = readWriteDoc(root, scope);
  const label = providerLabel(provider);
  const target = typeof model === 'string' ? model.trim() : '';
  if (target === '') throw new CatalogWriteError('INVALID', 'model 名须为非空字符串');
  const doc = read.doc;
  const arr = providersArrayOf(doc);
  const idx = entryIndexByName(arr, label);
  if (idx === -1) throw new CatalogWriteError('INVALID', `provider not found: ${scope}/providers/${label}`);
  const cur = arr[idx] as Record<string, unknown>;
  if (!Array.isArray(cur['models'])) throw new CatalogWriteError('INVALID', `providers.${label} models 形状坏，无从摘除`);
  const models = cur['models'] as unknown[];
  const at = models.findIndex((m) => modelNameOf(m) === target);
  if (at === -1) throw new CatalogWriteError('INVALID', `providers.${label} 模型不存在: ${target}`);
  models.splice(at, 1);
  if (models.length === 0) arr.splice(idx, 1); // 空自动删源：models 空的源是非法形态
  finishWrite(root, scope, file, read, doc);
}

/** 相邻调序：up=与前一位互换、down=与后一位互换（choices 序 = providers 序 × models 序，调序即调
 *  默认序）；模型不在/已在边界/direction 非法 → INVALID */
export function modelMove(root: string | null, scope: Scope, provider: string, model: string, direction: 'up' | 'down'): void {
  const { file, read } = readWriteDoc(root, scope);
  const label = providerLabel(provider);
  const target = typeof model === 'string' ? model.trim() : '';
  if (target === '') throw new CatalogWriteError('INVALID', 'model 名须为非空字符串');
  if (direction !== 'up' && direction !== 'down') {
    throw new CatalogWriteError('INVALID', `direction 须为 up|down，收到 ${JSON.stringify(direction)}`);
  }
  const doc = read.doc;
  const arr = providersArrayOf(doc);
  const idx = entryIndexByName(arr, label);
  if (idx === -1) throw new CatalogWriteError('INVALID', `provider not found: ${scope}/providers/${label}`);
  const cur = arr[idx] as Record<string, unknown>;
  if (!Array.isArray(cur['models'])) throw new CatalogWriteError('INVALID', `providers.${label} models 形状坏，无从调序`);
  const models = cur['models'] as unknown[];
  const at = models.findIndex((m) => modelNameOf(m) === target);
  if (at === -1) throw new CatalogWriteError('INVALID', `providers.${label} 模型不存在: ${target}`);
  const swapWith = direction === 'up' ? at - 1 : at + 1;
  if (swapWith < 0 || swapWith >= models.length) {
    throw new CatalogWriteError('INVALID', `providers.${label} 模型 ${target} 已在${direction === 'up' ? '顶' : '底'}部，无从再${direction === 'up' ? '上' : '下'}移`);
  }
  [models[at], models[swapWith]] = [models[swapWith]!, models[at]!];
  finishWrite(root, scope, file, read, doc);
}

/**
 * 置源专用密钥：写目标 scope settings env[providerApiKeyEnv(provider)] = apiKey（槽名经单点生成，
 * 绝不手工拼接）；空串 = 删除该 env 行（清空语义）。provider 必须在该 scope 装载视图可见
 * （listProviders：project=项目或全局、global=仅全局），否则 INVALID——env 槽属装载语义，凡不可
 * 装载的源无从落密钥；定位在文件守卫之后（plugins 定位同序）。返回 void 且全程零打印零日志：
 * 密钥值在本面无任何回显路径。
 */
export function setProviderApiKey(root: string | null, scope: Scope, provider: string, apiKey: string): void {
  const { file, read } = readWriteDoc(root, scope);
  const label = providerLabel(provider);
  if (typeof apiKey !== 'string') throw new CatalogWriteError('INVALID', 'apiKey 须为字符串（空串 = 删除该 env 行）');
  // provider 在场判定（文件守卫后）：走该 scope 装载视图（loadProvidersFull 对他级畸形按缺级处理，不抛）
  const viewRoot = scope === 'project' ? root : null;
  if (!listProviders(viewRoot).providers.some((p) => p.name === label)) {
    throw new CatalogWriteError('INVALID', `provider not found: ${scope}/providers/${label}`);
  }
  const doc = read.doc;
  const env = asRecord(doc['env']);
  const slot = providerApiKeyEnv(label);
  if (env === undefined) {
    // env 块缺失（或形状坏）：删不存在的行 = 零变化不落盘；落值则整键重建（形状坏不保留垃圾）
    if (apiKey === '') return;
    doc['env'] = { [slot]: apiKey };
    finishWrite(root, scope, file, read, doc);
    return;
  }
  if (apiKey === '') {
    if (env[slot] === undefined) return; // 零变化不落盘
    delete env[slot];
  } else {
    if (env[slot] === apiKey) return; // 零变化不落盘
    env[slot] = apiKey;
  }
  finishWrite(root, scope, file, read, doc);
}
