import * as fs from 'fs';
import * as path from 'path';
import { EmbeddingProvider, KbHit } from '../../types';
import { chunkMarkdown } from './chunk';
import { VectorStore } from './store';
import { createVectorBackend, LocalJsonVectorStore, registerVectorBackend } from './store';
import { OpenAICompatEmbeddings } from './embed';
import { resolveDataDir } from '../../config/data-dir';
import type { KbEnv } from '../../config/env';
import { FileStore } from '../../storage/adapter';

const SUNSHINEX_KB_EXTENSIONS = new Set(['.md', '.txt']);

// 在册后端在装配模块显式注册（D18/J3）：后端文件零 import 副作用、工厂只收显式 dataDir；
// 新增后端 = 实现一个 VectorStore + 此处注册一行，主链（assembleKnowledgeBase）零改动
registerVectorBackend('local-json', (dataDir) => new LocalJsonVectorStore(new FileStore(dataDir)));
// sqlite-vec 惰性 require（H1-T4）：node:sqlite 是 Node 22.5+ 内建，静态 import 会把 runtime.js
// 整链钉死在宿主 Node 版本上（Electron 33 内嵌 Node 20 即模块初始化崩）；注册面恒在，实例化面只在
// SUNSHINEX_KB_BACKEND=sqlite-vec 显式声明时才触碰 node:sqlite——缺省 local-json 零依赖语义不变
registerVectorBackend('sqlite-vec', (dataDir) => {
  const { SqliteVecStore } = require('./store.sqlite-vec') as typeof import('./store.sqlite-vec');
  return new SqliteVecStore(dataDir);
});

/** 知识库编排：目录 → 分块 → 向量化 → 存储；检索 = 查询向量化 + 库内余弦 TopK（embedding 桩注入，零真实网络） */
export class KnowledgeBase {
  private files = 0;

  constructor(private store: VectorStore, private embedder: EmbeddingProvider) {}

  /** 递归索引目录下 md/txt 文件，返回本次索引块数；块 id = 相对路径#序号，重索引幂等覆盖 */
  async indexDir(dir: string): Promise<number> {
    let chunks = 0;
    for (const rel of this.walkFiles(dir)) {
      const text = fs.readFileSync(path.join(dir, rel), 'utf-8');
      const parts = chunkMarkdown(text);
      if (parts.length === 0) continue;
      this.files += 1;
      const vectors = await this.embedder.embed(parts);
      parts.forEach((p, i) => this.store.upsert(`${rel}#${i}`, vectors[i], { text: p, file: rel }));
      chunks += parts.length;
    }
    this.store.flush();
    return chunks;
  }

  async search(query: string, topK: number): Promise<KbHit[]> {
    const [queryVec] = await this.embedder.embed([query]);
    // file 下泄（D28）：store.search 出参只承 id/text/score，来源文件在 meta（indexDir 落库）——
    // 检索期经 metaOf 回填供模型引用命中出处；旧索引/无 meta 命中不带该键（可选字段，零破坏）
    return this.store.search(queryVec, topK).map((h) => {
      const file = this.store.metaOf(h.id)?.file;
      return typeof file === 'string' && file.length > 0 ? { ...h, file } : h;
    });
  }

  stats(): { files: number; chunks: number } {
    return { files: this.files, chunks: this.store.size() };
  }

  /** 目录递归收集 md/txt 相对路径：跳过隐藏目录与 node_modules；不可读目录整体跳过不中断 */
  private walkFiles(dir: string, relDir = ''): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(relDir ? path.join(dir, relDir) : dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      // 成本护栏（D28 索引入口上线）：缺省目录=项目根时 node_modules 动辄数万 md/txt，
      // 真实计费 embedding 成本会失控——依赖目录恒非知识库内容，与隐藏目录同判跳过
      if (e.isDirectory() && e.name === 'node_modules') continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...this.walkFiles(dir, rel));
      else if (e.isFile() && SUNSHINEX_KB_EXTENSIONS.has(path.extname(e.name))) out.push(rel);
    }
    return out;
  }
}

/** 同进程活性 KB 登记（key = backend + 数据目录，D28）：装配即登记——索引入口经「已装配的同一实例」写入，
 *  会话内 kb_search 对新索引即时可见（local-json 的命中数据在实例内存里，绕开实例写入=当轮不可见的静默过期）；
 *  进程外写入（另一 CLI 进程）只能落盘，待下次装配 load 挂接 */
const liveKnowledgeBases = new Map<string, KnowledgeBase>();

function liveKey(backend: string, dataDir: string): string {
  return `${backend}\u0000${dataDir}`;
}

/** KB 数据目录单点：kbDataDir 显式覆盖 > resolveDataDir(root)/kb（装配与索引入口共用同源口径，防两处漂移） */
function kbDataDirOf(cfg: KbEnv, root: string): string {
  return cfg.kbDataDir ?? path.join(resolveDataDir(root), 'kb');
}

/**
 * KB 装配函数（D18 接线裁决落点）：入参为 resolveKbEnv 产物 + root（数据目录解析锚）。
 * - embedding base/key/model 任一缺失 → undefined：kb_search 维持 kb_not_configured 确定降级（「未配置」是合法确定态）
 * - 后端按 env 名装配：缺省 local-json（零依赖），SUNSHINEX_KB_BACKEND=sqlite-vec 显式声明才用 sqlite-vec（禁静默切换）；未注册名装配期抛错（fail-fast）
 * - 数据目录：kbDataDir 显式覆盖 > resolveDataDir(root)/kb（对齐 memory 的 memoryDir 先例同源口径）
 * - 构造即 load() 挂接既有索引（损坏存储降级空库不抛，契约由 conformance 锁）；不做自动重索引——
 *   indexDir 对目录内全部 md/txt 走真实计费 embedding，成本不可控，索引入口留用户显式触发（D28 已补 indexKnowledgeDir）
 * 本层不读 process.env（embed.ts 头注纪律：配置由装配层注入）：resolveKbEnv(process.env) 由调用方（runtime.ts / selfcheck.ts）执行
 */
export function assembleKnowledgeBase(cfg: KbEnv, root: string): KnowledgeBase | undefined {
  const { embeddingBaseUrl: baseURL, embeddingApiKey: apiKey, embeddingModel: model } = cfg;
  if (baseURL === undefined || apiKey === undefined || model === undefined) return undefined;
  const dataDir = kbDataDirOf(cfg, root);
  const store = createVectorBackend(cfg.backend, dataDir);
  store.load();
  const kb = new KnowledgeBase(store, new OpenAICompatEmbeddings({ baseURL, apiKey, model }));
  liveKnowledgeBases.set(liveKey(cfg.backend, dataDir), kb);
  return kb;
}

/** indexKnowledgeDir 失败产物：missing 为缺失配置的 env 键（含回退源名，文案口径与 resolveKbEnv 回退链同源） */
type KbIndexFailure =
  | { ok: false; reason: 'not-configured'; missing: string[] }
  | { ok: false; reason: 'bad-dir'; dir: string };

/** indexKnowledgeDir 产物：成功携带 backend/数据目录/本次索引块数（CLI/TUI 上屏统计的唯一来源） */
type KbIndexResult = { ok: true; backend: string; dataDir: string; chunks: number } | KbIndexFailure;

/** embedding 配置缺失清单（单点供 CLI/TUI 引导文案，防两处各写一份 env 名漂移） */
function missingEmbeddingEnv(cfg: KbEnv): string[] {
  const missing: string[] = [];
  if (cfg.embeddingBaseUrl === undefined) missing.push('SUNSHINEX_EMBEDDING_BASE_URL (or SUNSHINEX_BASE_URL)');
  if (cfg.embeddingApiKey === undefined) missing.push('SUNSHINEX_EMBEDDING_API_KEY (or SUNSHINEX_API_KEY)');
  if (cfg.embeddingModel === undefined) missing.push('SUNSHINEX_EMBEDDING_MODEL (or SUNSHINEX_MODEL)');
  return missing;
}

/**
 * 索引构建生产入口单点（D28 裁决落点）：CLI kb-index 子命令与 TUI /kb-index 共用，绝不两处复制索引逻辑。
 * - 未配置 → { reason: 'not-configured', missing }（调用方给引导文案，判配逻辑不外泄）
 * - 目录不存在/非目录 → { reason: 'bad-dir' }；装配期显式误配（未注册后端名）沿用 fail-fast 抛错由调用方收口
 * - 成本语义：索引对目录内全部 md/txt 走真实计费 embedding——命令由用户显式触发，成本可控性由文件数决定
 *   （node_modules 与隐藏目录不索引）；重索引幂等覆盖（块 id = 相对路径#序号）
 */
export async function indexKnowledgeDir(cfg: KbEnv, root: string, dir: string): Promise<KbIndexResult> {
  const missing = missingEmbeddingEnv(cfg);
  if (missing.length > 0) return { ok: false, reason: 'not-configured', missing };
  const abs = path.resolve(dir);
  try {
    if (!fs.statSync(abs).isDirectory()) return { ok: false, reason: 'bad-dir', dir: abs };
  } catch {
    return { ok: false, reason: 'bad-dir', dir: abs };
  }
  const dataDir = kbDataDirOf(cfg, root);
  // 活性实例优先（同进程会话装配的那只）：经它写入使会话内 kb_search 即时可见；无活实例才自装配（CLI 单发进程形态）
  const kb = liveKnowledgeBases.get(liveKey(cfg.backend, dataDir)) ?? assembleKnowledgeBase(cfg, root);
  if (kb === undefined) return { ok: false, reason: 'not-configured', missing };
  const chunks = await kb.indexDir(abs);
  return { ok: true, backend: cfg.backend, dataDir, chunks };
}
