/** 产物共享面（2026-11-12 spec §3.2；内核登记点 src/types.ts ArtifactFile——惯例同 ChangeFile
 *  「gui 侧另有同形局部声明不引」）：扩展名→类目词标签 + 白名单同形判定 */

export interface ArtifactFile {
  path: string;
  source: 'write' | 'edit' | 'bash';
  callId?: string;
}

/** 产物库聚合行（GET /session/:id/artifacts items 直映） */
export interface ArtifactRow {
  path: string;
  source: 'write' | 'edit' | 'bash';
  callId?: string;
  runSeq: number;
  endedTs?: number;
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  md: '文档', txt: '文档', pdf: '文档', rst: '文档', docx: '文档', doc: '文档',
  png: '图片', jpg: '图片', jpeg: '图片', webp: '图片', gif: '图片', svg: '图片',
  xlsx: '表格', xls: '表格', csv: '表格', tsv: '表格',
  pptx: '演示', ppt: '演示',
  json: '数据', yaml: '数据', yml: '数据', toml: '数据', xml: '数据',
};

export function extOf(relPath: string): string | undefined {
  const base = relPath.replaceAll('\\', '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : undefined;
}

export function isDeliverablePath(relPath: string): boolean {
  const ext = extOf(relPath);
  return ext !== undefined && ext in KIND_LABELS;
}

/** 「类目 · 大写扩展名」标签；非产物 undefined */
export function artifactKindLabel(relPath: string): string | undefined {
  const ext = extOf(relPath);
  if (ext === undefined) return undefined;
  const kind = KIND_LABELS[ext];
  return kind === undefined ? undefined : `${kind} · ${ext.toUpperCase()}`;
}
