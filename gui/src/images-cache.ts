import { useState } from 'react';
import type { Connection } from './connection';

/**
 * images-cache 引用解析(2026-10-31 用户裁定「底层存储不要 base64——图片暂存项目 images-cache,
 * 上下文引用文件地址」GUI 显示面):daemon 档/上下文里的用户图片附件是相对路径引用
 * (`images-cache/<时间戳>-<hash>.<ext>`),气泡缩略图经既有 /app/file 端点(path 相对 root)取回
 * base64 转 dataURL 显示。模块级 memo(键=root+\n+rel):同图跨重渲/跨重挂零重复拉取——
 * 落盘即内容寻址(hash 文件名),缓存永不失效。拉取失败缓存原引用串(显示破图不炸渲染)。
 */
const memo = new Map<string, string>();
const inflight = new Set<string>();

export function isImageCacheRef(src: string): boolean {
  return src.startsWith('images-cache/');
}

/** 图片数组解析 hook:dataURL/其它形态原样;images-cache 引用未就绪时返回 ''(懒加载 img 空占位),
 *  取回后整体重渲 */
export function useResolvedImages(conn: Connection | null, root: string | undefined, images: readonly string[] | undefined): string[] {
  const [, setTick] = useState(0);
  const out: string[] = [];
  for (const src of images ?? []) {
    if (!isImageCacheRef(src) || root === undefined || conn === null) {
      out.push(src);
      continue;
    }
    const key = `${root}\n${src}`;
    const hit = memo.get(key);
    if (hit !== undefined) {
      out.push(hit);
      continue;
    }
    if (!inflight.has(key)) {
      inflight.add(key);
      void conn
        .appFile(root, src)
        .then((r) => {
          memo.set(key, r.type === 'image' && r.mime !== undefined && r.data !== undefined ? `data:${r.mime};base64,${r.data}` : src);
          setTick((t) => t + 1);
        })
        .catch(() => {
          memo.set(key, src);
          setTick((t) => t + 1);
        });
    }
    out.push('');
  }
  return out;
}
