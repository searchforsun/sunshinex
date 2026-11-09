import { useEffect, useRef, useState } from 'react';
import type { WelcomeComposerConn } from './welcome-conn';

/** 欢迎页 @ 文件清单单点：清单恒属当前选中工作区——切换即清空并重拉（G14.127 索引预热：手打 @根目录文件 的
 *  发送期解析不依赖面板开过）；敲 @ 时 refresh 拉最新。应答按发起时的 root 落位，非当前工作区的迟到应答丢弃
 *  （慢工作区的旧应答不得覆盖新工作区清单）。目录（尾斜杠）排前——@面板可滤出文件夹 */
export function useWelcomeFiles(conn: WelcomeComposerConn, picked: string): { files: string[]; refresh: () => void } {
  const [files, setFiles] = useState<string[]>([]);
  const currentRef = useRef(picked);
  currentRef.current = picked;
  const load = (root: string): void => {
    if (root === '') return;
    void conn.workspaceFiles?.(root)?.then(
      (r) => {
        if (currentRef.current === root) setFiles([...(r.dirs ?? []), ...r.files.map((f) => f.path)]);
      },
      () => {
        if (currentRef.current === root) setFiles([]);
      },
    );
  };
  useEffect(() => {
    setFiles([]);
    load(picked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, conn]);
  return { files, refresh: () => load(currentRef.current) };
}
