import { StorageAdapter } from '../../storage/adapter';
import { KbHit } from '../../types';

/** 向量存储接缝：local-json / sqlite-vec 等后端实现同一契约，经注册表按 SUNSHINEX_KB_BACKEND 装配（可插拔原则，spec §3.4） */
export interface VectorStore {
  upsert(id: string, vec: number[], meta: Record<string, unknown>): void;
  search(vec: number[], topK: number): KbHit[];
  /** 按条目 id 读回全量 meta（与 upsert 第三参同形；条目不存在返回 undefined）。
   *  J8 契约观测通道：search 出参 KbHit 只承 text，meta 是否被后端完整持久化只能经此断言（conformance 同源锁两后端） */
  metaOf(id: string): Record<string, unknown> | undefined;
  size(): number;
  load(): void;
  flush(): void;
  /** 资源型后端释放底层连接（Windows 文件锁：连接未关即覆写/删目录会 EPERM）；纯内存实现可缺省 */
  close?(): void;
}

interface VecEntry {
  vec: number[];
  meta: Record<string, unknown>;
}

const STORE_KEY = 'kb.vectors';

/** 缺省后端：FileStore JSON 持久化 + 归一化暴力余弦（≤5 万块规模声明内），零依赖回归基线 */
export class LocalJsonVectorStore implements VectorStore {
  private entries = new Map<string, VecEntry>();

  constructor(private storage: StorageAdapter) {}

  upsert(id: string, vec: number[], meta: Record<string, unknown>): void {
    this.entries.set(id, { vec, meta });
  }

  search(vec: number[], topK: number): KbHit[] {
    if (topK <= 0) return [];
    const q = normalize(vec);
    const hits: KbHit[] = [];
    for (const [id, e] of this.entries) {
      hits.push({ id, text: String(e.meta.text ?? ''), score: dot(q, normalize(e.vec)) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }

  size(): number {
    return this.entries.size;
  }

  metaOf(id: string): Record<string, unknown> | undefined {
    return this.entries.get(id)?.meta;
  }

  load(): void {
    // 契约：损坏存储降级为空库不抛（索引可由 indexDir 全量重建）；解析容错归属后端边界，通用 FileStore 保持严格
    try {
      const data = this.storage.read<Record<string, VecEntry> | null>(STORE_KEY, null);
      this.entries = data ? new Map(Object.entries(data)) : new Map();
    } catch {
      this.entries = new Map();
    }
  }

  flush(): void {
    this.storage.write(STORE_KEY, Object.fromEntries(this.entries));
  }
}

/** 归一化：余弦相似度退化为点积；零向量原样返回（分数为 0，不产生 NaN） */
function normalize(v: number[]): number[] {
  const norm = Math.hypot(...v);
  return norm === 0 ? v : v.map((x) => x / norm);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * (b[i] ?? 0);
  return s;
}

const backends = new Map<string, (dataDir: string) => VectorStore>();

/** 后端注册（J3 修复后形态）：工厂只收 dataDir——落位由装配层显式决定，后端不再自行锚 process.cwd()/直读 env。
 *  在册注册调用收敛在装配模块（knowledge/index.ts），各后端文件零 import 副作用；新增后端 = 一个实现 + 装配模块注册一行 */
export function registerVectorBackend(name: string, factory: (dataDir: string) => VectorStore): void {
  backends.set(name, factory);
}

/** 装配入口：未注册名直接抛错（fail-fast，禁静默回退——错误配置必须在装配期暴露） */
export function createVectorBackend(name: string, dataDir: string): VectorStore {
  const factory = backends.get(name);
  if (!factory) throw new Error(`Unregistered vector backend: ${name}`);
  return factory(dataDir);
}
