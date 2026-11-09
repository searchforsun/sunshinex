import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { t } from '../i18n';
import { pathBasename, pickWorkspaceFolder } from '../ui-util';
import type { WelcomeComposerConn } from './welcome-conn';

/** 欢迎页工作区清单簇（D62 批C，2026-11-07 自 WelcomeComposer 外提——行为零变化）：rows 回源三通道
 *  （挂载/preset/config-changed 300ms 合帧）+ default 锚定去重投影 + 三入口登记收口（桌面壳对话框/
 *  浏览器态对话框/DirPicker 确认）。picked/projOpen/dirOpen/hint 态留宿主，setter 直传零语义变化。 */
export function useWelcomeWorkspaces(
  conn: WelcomeComposerConn,
  presetRoot: string | undefined,
  presetSeq: number | undefined,
  io: {
    setPicked: Dispatch<SetStateAction<string>>;
    setProjOpen: (v: boolean) => void;
    setHint: (msg: string) => void;
    setDirOpen: (v: boolean) => void;
  },
) {
  const { setPicked, setProjOpen, setHint, setDirOpen } = io;
  const [rows, setRows] = useState<Array<{ slug: string; root?: string; sessionCount: number }>>([]);
  /** 项目列表回源（挂载 + 创建/登记成功后静默重拉——本地 append 只保即时可见,mtime 排序/会话计数/
   *  侧栏对齐都要以 /workspaces 为准;2026-10-30 创建提速后加载缺口收口） */
  const refreshRows = (): void => {
    conn.workspaces().then(
      (list) => {
        const usable = list.filter((r) => r.root !== undefined && r.root !== '');
        // default 工作区(用户裁定):置顶缺省——非文件类任务与对话的落点
        // G14.10 B 方案:default 锚定专用临时目录(daemon 侧 <tmp>/sunshinex-default),按 basename
        // 识别('sunshinex-default' 为新锚,'default' 兼容旧仓库内工作区);无注册行时回落字面
        // 'default'(daemon createSession 同规则解析)。default 行置顶。basename 取 pathBasename 单点。
        // G14.34 去重:default 与 sunshinex-default*(含旧临时锚点的带尾哈希变体)同义——
        // 全部坍缩为唯一「默认工作区」项(root 取现存锚点行;全无则回落字面 'default')
        const isDefaultNm = (nm: string): boolean => nm === 'default' || nm.startsWith('sunshinex-default');
        const anchorRow =
          usable.find((r) => r.root !== undefined && pathBasename(r.root) === 'sunshinex-default') ??
          usable.find((r) => isDefaultNm(pathBasename(r.root ?? r.slug)));
        const deduped = usable.filter((r) => !isDefaultNm(pathBasename(r.root ?? r.slug)));
        const withDefault = anchorRow !== undefined
          ? [anchorRow, ...deduped]
          : [{ slug: 'default', root: 'default', sessionCount: 0 }, ...deduped];
        setRows(withDefault);
        setPicked((p) => (p === '' ? (anchorRow?.root ?? 'default') : p));
      },
      () => setRows([]),
    );
  };
  useEffect(() => {
    refreshRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn]);
  /** 预选工作区(G10-C16):项目行「+」带来的 preset——每次入口(seq 递增)即选中(用户仍可在条上切换);
   *  新对话入口(无 preset)回默认工作区——清空选择,回源时按 default 锚点补选(2026-11-09 用户实测
   *  「最近会话旁新对话,欢迎页停在上一个项目」)。同拍回源项目列表:侧栏「添加工作区」只经本 preset
   *  通知欢迎页(组件已挂载不重拉,下拉还是挂载时快照——新建项目不入列,切页才显) */
  useEffect(() => {
    if (presetRoot !== undefined && presetRoot !== '') {
      setPicked(presetRoot);
      refreshRows();
    } else if (presetSeq !== undefined && presetSeq > 0) {
      setPicked('');
      refreshRows();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetRoot, presetSeq]);
  /** 他面创建回源(2026-10-30 用户实测「侧栏建项目后欢迎页下拉不显,切页才出」的跨面收口):
   *  config-changed 任一帧即静默重拉 /workspaces(daemon afterCreate 建项目必广播;skills
   *  等高频帧顺带重拉只是幂等 GET)。300ms 合帧防抖;conn 缺 onConfigChanged(旧桩)不订阅 */
  useEffect(() => {
    if (typeof conn.onConfigChanged !== 'function') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = conn.onConfigChanged(() => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        refreshRows();
      }, 300);
    });
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn]);
  /** 浏览新文件夹(G10 用户裁定 + G14.51 收口):桌面壳走 IPC 系统对话框(回全路径);浏览器态
   *  开服务端 DirPicker 逐级浏览——两路都回「既有目录」绝对路径,daemon {path} 分支只登记不建
   *  目录(旧 showDirectoryPicker 拿不到路径按 name 建目录的行为废除)。已登记幂等(daemon
   *  workspace.json 同 root 直返 ok)。 */
  /** 登记成功收口单点(三入口共用:桌面壳对话框/浏览器态对话框/DirPicker 确认):
   *  幂等追加(slug 判重)+选中+收项目菜单+静默回源(skills 闸随 picked 重置+列表与侧栏/mtime 对齐) */
  const adoptWorkspace = (res: { slug: string; root: string }): void => {
    setRows((prev) => {
      const list = prev ?? [];
      return list.some((r) => r.slug === res.slug) ? list : [...list, { slug: res.slug, root: res.root, sessionCount: 0 }];
    });
    setPicked(res.root);
    setProjOpen(false);
    void refreshRows();
  };
  const browseFolder = async (): Promise<void> => {
    setHint('');
    const shell = window.sunshinex;
    if (typeof shell?.pickFolder === 'function') {
      const p = await shell.pickFolder();
      if (p === null) return;
      try {
        adoptWorkspace(await conn.createWorkspace({ path: p }));
      } catch (err) {
        setHint(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    // G14.194 浏览器态也走 Win 原生对话框(showDirectoryPicker+标记定位,同侧栏添加工作区);
    // 取消静默;不支持/权限被拒/定位超时 → 回退自建 DirPicker
    const picked = await pickWorkspaceFolder((q) => conn.locateWorkspace(q));
    if (picked === null) return;
    if (picked !== 'unsupported' && picked !== 'denied' && picked !== 'timeout') {
      try {
        adoptWorkspace(await conn.createWorkspace({ path: picked.path }));
      } catch (err) {
        setHint(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (picked === 'denied') setHint(t('Folder permission denied', '文件夹写权限被拒'));
    if (picked === 'timeout') setHint(t('Could not locate the picked folder', '未能定位所选文件夹'));
    setDirOpen(true);
  };
  /** DirPicker 确认:登记所选既有目录为工作区并选中(同桌面壳后段) */
  const registerFolder = (p: string): void => {
    setDirOpen(false);
    conn
      .createWorkspace({ path: p })
      .then(adoptWorkspace)
      .catch((err: unknown) => setHint(err instanceof Error ? err.message : String(err)));
  };
  return { rows, refreshRows, adoptWorkspace, browseFolder, registerFolder };
}
