import { useState } from 'react';
import type { Connection } from './connection';

/**
 * images-cache 引用解析(2026-10-31 用户裁定「图片暂存项目数据目录 images-cache,上下文引用文件
 * 地址」GUI 显示面):daemon 档/上下文里的图片附件是文件地址(dataURL/http 之外的本地路径),
 * 气泡/工具行缩略图经既有 /app/file 端点取回 base64 转 dataURL 显示。三态:dataURL/http 原样
 * 直显;本地地址取回成功→dataURL;取回失败(原始图片已删等)→ null=渲染占位图标识(不显破图)。
 * 模块级 memo(键=root+\n+src,内容寻址文件名永不变更):同图跨重渲/跨重挂零重复拉取,
 * 失败结果同样缓存(文件已删不反复打端点)。
 */
const memo = new Map<string, string | null>();
const inflight = new Set<string>();

/** 取回失败哨兵(memo 值;hook 返回面以 null 表达) */
const FAILED = '\u0000failed';

/** 本地图片引用判定:dataURL/http(s) 之外的形态一律按本地文件地址走解析(含 images-cache
 * 绝对地址与任意工作区/数据目录路径) */
export function isLocalImageRef(src: string): boolean {
  return !src.startsWith('data:') && !/^https?:\/\//i.test(src);
}

/** 图片数组解析 hook:入参原序返回 (string|null)[]——string=可直接进 <img src>(dataURL 或
 * 原样透传形态);null=原始图片不可得(渲染占位);''=解析在途 */
export function useResolvedImages(conn: Connection | null, root: string | undefined, images: readonly string[] | undefined): Array<string | null> {
  const [, setTick] = useState(0);
  const out: Array<string | null> = [];
  for (const src of images ?? []) {
    if (!isLocalImageRef(src) || root === undefined || conn === null) {
      out.push(src);
      continue;
    }
    const key = `${root}\n${src}`;
    const hit = memo.get(key);
    if (hit !== undefined) {
      out.push(hit === FAILED ? null : hit);
      continue;
    }
    if (!inflight.has(key)) {
      inflight.add(key);
      void conn
        .appFile(root, src)
        .then((r) => {
          memo.set(key, r.type === 'image' && r.mime !== undefined && r.data !== undefined ? `data:${r.mime};base64,${r.data}` : FAILED);
          setTick((t) => t + 1);
        })
        .catch(() => {
          memo.set(key, FAILED); // 缺档/端点失败:占位面(原始图片已删也要有标识)
          setTick((t) => t + 1);
        });
    }
    out.push('');
  }
  return out;
}
