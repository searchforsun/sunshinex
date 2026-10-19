import { useCallback, useEffect, useRef, useState } from 'react';
import { pathBasename } from '../../ui-util';
import type { Connection } from '../../connection';

/** 工作区文件索引 hook（D32 批B 拆分自 Chat.tsx 数据部）：@ 补全与发送期解析的文件清单装载——
 *  root 在场走 /workspace/files 索引、缺省回落 tree BFS（跳噪声目录+600 上限），带会话/root 键缓存
 *  与挂载预热。UI 触发部（面板开合/选中记账 pickRelRef 写入）留在 Chat，记账表注入本 hook 供
 *  resolveFileRef 第一优先读取。行为零变化（Chat.test @ 展开组为锚）。 */
export function useWorkspaceFiles(
  conn: Connection,
  sessionId: string,
  root: string | undefined,
  pickRelRef: React.MutableRefObject<Map<string, string>>,
): {
  filesCacheRef: React.MutableRefObject<{ key: string; files: string[] } | null>;
  resolveFileRef: (name: string) => string | undefined;
  loadWorkspaceFiles: () => Promise<string[]>;
  /** 索引版本号:每次缓存落定 +1——目录判定(context 值)据此变化,驱动 memo 封存条目重渲
   *  (会话恢复时历史条目先于异步索引渲染,缓存装好后必须重渲一次才补上黄目录图标) */
  filesVer: number;
} {
  const filesCacheRef = useRef<{ key: string; files: string[] } | null>(null);
  const [filesVer, setFilesVer] = useState(0);
  /** 解析器:@文件名 → 相对路径(选中记账优先,工作区索引按 mtime 最近兜底) */
  const resolveFileRef = useCallback(
    (name: string): string | undefined => {
      const picked = pickRelRef.current.get(name);
      if (picked !== undefined) return picked;
      const files = filesCacheRef.current?.files;
      if (files !== undefined) {
        const hit = files.find((f) => pathBasename(f) === name);
        if (hit !== undefined) return hit;
      }
      return undefined;
    },
    [],
  );
  const loadWorkspaceFiles = useCallback(async (): Promise<string[]> => {
    // G14.121 root 在场走 /workspace/files 索引(mtime 倒序=最近改动优先);否则回落 tree BFS。
    // 目录引用面:索引 dirs(尾斜杠)排前——@面板可滤出文件夹,目录命中先于文件可见
    if (root !== undefined && root !== '' && root !== 'default') {
      const cached = filesCacheRef.current;
      if (cached !== null && cached.key === root) return cached.files;
      let files: string[] = [];
      try {
        const r = await conn.workspaceFiles(root);
        files = [...(r.dirs ?? []), ...r.files.map((f) => f.path)];
      } catch {
        files = [];
      }
      filesCacheRef.current = { key: root, files };
      setFilesVer((v) => v + 1);
      return files;
    }
    const cached = filesCacheRef.current;
    if (cached !== null && cached.key === sessionId) return cached.files;
    const skip = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.idea', '.vscode']);
    const cap = { n: 600 };
    const dcap = { n: 300 };
    const walk = async (p2: string, depth: number): Promise<string[]> => {
      if (depth > 4 || cap.n <= 0) return [];
      let entries: Array<{ name: string; kind: 'dir' | 'file' }> = [];
      try {
        const r = await conn.tree(sessionId, p2 === '' ? undefined : p2);
        entries = r.entries;
        if (r.truncated === true) cap.n -= 200;
      } catch {
        return [];
      }
      const out: string[] = [];
      for (const e of entries) {
        if (cap.n <= 0) break;
        const rel = p2 === '' ? e.name : `${p2}/${e.name}`;
        if (e.kind === 'file') {
          out.push(rel);
          cap.n -= 1;
        } else if (!skip.has(e.name)) {
          if (dcap.n > 0) {
            out.push(`${rel}/`);
            dcap.n -= 1;
          }
          out.push(...(await walk(rel, depth + 1)));
        }
      }
      return out;
    };
    const files = await walk('', 0);
    filesCacheRef.current = { key: sessionId, files };
    setFilesVer((v) => v + 1);
    return files;
  }, [conn, sessionId, root]);
  // G14.127 索引预热:会话打开即拉清单(手打 @根目录文件 无目录信息,发送期解析全靠它——
  // 不能等面板首次打开才拉);失败静默(面板降级可用)
  useEffect(() => {
    if (root !== undefined && root !== '' && root !== 'default') void loadWorkspaceFiles();
  }, [loadWorkspaceFiles, root]);
  return { filesCacheRef, resolveFileRef, loadWorkspaceFiles, filesVer };
}

