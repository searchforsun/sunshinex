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
import { hasJsonComments, stripJsonComments } from '../config/settings';

/** 写入被拒：code=COMMENTS（目标文件含 JSONC 注释，结构化整写会毁注释）或 INVALID（内容不合法） */
export class CatalogWriteError extends Error {
  constructor(readonly code: 'COMMENTS' | 'INVALID', message: string) { super(message); }
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJsoncDoc(file: string): { exists: boolean; raw: string; doc: Record<string, unknown>; hasComments: boolean; warnings: string[] } {
  if (!fs.existsSync(file)) return { exists: false, raw: '', doc: {}, hasComments: false, warnings: [] };
  const raw = fs.readFileSync(file, 'utf8');
  const hasComments = hasJsonComments(raw);
  try {
    const parsed = JSON.parse(stripJsonComments(raw));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { exists: true, raw, doc: {}, hasComments, warnings: [`${file} 根须为对象，已按空处理`] };
    }
    return { exists: true, raw, doc: parsed as Record<string, unknown>, hasComments, warnings: [] };
  } catch (e) {
    return { exists: true, raw, doc: {}, hasComments, warnings: [`${file} 解析失败：${(e as Error).message}`] };
  }
}

export function writeJsonAtomic(file: string, text: string): void {
  ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
