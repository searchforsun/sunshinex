import * as fs from 'fs';
import * as path from 'path';
import { EmbeddingProvider, KbHit } from '../../types';
import { chunkMarkdown } from './chunk';
import { VectorStore } from './store';

const KB_EXTENSIONS = new Set(['.md', '.txt']);

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
    return this.store.search(queryVec, topK);
  }

  stats(): { files: number; chunks: number } {
    return { files: this.files, chunks: this.store.size() };
  }

  /** 目录递归收集 md/txt 相对路径：跳过隐藏目录；不可读目录整体跳过不中断 */
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
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...this.walkFiles(dir, rel));
      else if (e.isFile() && KB_EXTENSIONS.has(path.extname(e.name))) out.push(rel);
    }
    return out;
  }
}
