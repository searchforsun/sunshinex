import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { ArrowUp, ChevronDown, Eye, Folder, GitBranch, ListTodo, ShieldCheck, Unlock } from 'lucide-react';
import { pathBasename, pickWorkspaceFolder } from '../ui-util';
import { DirPicker } from '../pages/DirPicker';
import { atomicRange, baseModelName, expandFileRefs, FilePalette, fileHit, ModeIcon, rankFileHits, renderMentionSpans, slashTokenAt, tokenDeleteRange, tokenGuardVerdict, tokenSpanAt } from '../pages/Chat';
import { CommandPalette, filterCommands } from '../CommandPalette';
import { ComposerCard } from '../composer/ComposerCard';
import { MAX_IMAGES, appendImages, loadImages } from '../images';
import { ComposerPlusPanel } from '../composer/ComposerPlusPanel';
import { ImageLightbox } from '../ImageLightbox';
import { EffortChip, EffortSlider } from '../effort-slider';
import { FolderAddIcon } from '../sidebar/ProjectMenu';
import { PlusAddIcon } from '../sidebar/project-menu-util';
import type { WelcomeComposerConn } from './welcome-conn';

/** 欢迎页 composer 独立模块（D32 中口径件批App-1 自 App.tsx 平移,行为零变化;
 *  模块私有件转公开导出——消费方仅 App.tsx 一处）。 */
/** 思考强度档位(G14.10):滑动块 0..5 与档位一一对应(daemon effort 白名单序) */
/** 欢迎页 goal 接力态:welcome 输入的目标,openSession 后由 Chat 播种完成时提交;
 *  images=随行图片附件（2026-10-26,欢迎页粘贴/+面板附件,随首条消息带图发送） */
export interface WelcomeGoal {
  root: string;
  goal: string;
  images?: string[];
}

/** 欢迎页 composer(Codex home 形,G10 用户裁定二轮):
 *  构图=logo+大标题居中偏上,composer 簇贴底;Choose project 独立圆角条嵌在输入卡上沿之后
 *  (卡盖住条下沿,Codex 叠卡形),点击弹层向上浮出(overlay 不推布局):已注册项目可点选 +
 *  「浏览文件夹…」走原生风格 DirPicker 建新项目;footer 左右分列(+审批 左/模型+圆发送 右) */
export function WelcomeComposer({
  conn,
  presetRoot,
  onOpened,
}: {
  conn: WelcomeComposerConn;
  /** 预选工作区(G10-C16):项目行「+」带来的 preset */
  presetRoot?: string;
  onOpened: (sessionId: string, root: string, goal: string, images?: string[]) => void;
}): JSX.Element {
  const [rows, setRows] = useState<Array<{ slug: string; root?: string; sessionCount: number }>>([]);
  const [picked, setPicked] = useState('');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [projOpen, setProjOpen] = useState(false);
  /** G14.51 浏览器态服务端目录选择弹层(Browse folders 无桌面壳时) */
  const [dirOpen, setDirOpen] = useState(false);
  /** + 附加面板(G12 三轮):命令/技能列表浮层(卡顶同宽);文件区需会话,欢迎页不渲染 */
  const [plusOpen, setPlusOpen] = useState(false);
  /** 待发图片附件（dataURL,≤8 张;2026-10-26 图片功能——欢迎页粘贴/+面板附件,随首条消息发送） */
  const [images, setImages] = useState<string[]>([]);
  /** 输入卡缩略图预览(2026-10-26 用户裁定:与主对话同口径,点击开灯箱) */
  const [lightboxSrc, setLightboxSrc] = useState<string | undefined>(undefined);
  const attachImages = (files: File[]): void => {
    void loadImages(files).then((imgs) => {
      if (imgs.length === 0) return;
      setImages((cur) => {
        const { images: merged, overflow } = appendImages(cur, imgs);
        if (overflow > 0) setHint(t(`Up to ${MAX_IMAGES} images per message`, `每条消息最多 ${MAX_IMAGES} 张图片`));
        return merged;
      });
    });
  };
  /** 审批模式(G10-C16):新会话创建时带出;缺省 full-access(serve 缺省档;权限档改名对齐后端) */
  const [mode, setMode] = useState<'read-only' | 'acceptEdits' | 'full-access' | 'plan'>('full-access');
  const [modeOpen, setModeOpen] = useState(false);
  const [hint, setHint] = useState('');
  /** 缺省模型名(G13 反馈轮):settings model 键回显(拉取失败留 undefined → 「默认模型」兜底) */
  const [defaultModel, setDefaultModel] = useState<string | undefined>(undefined);
  const [modelChoices, setModelChoices] = useState<Array<{ id: string; effort?: string }>>([]);
  const [selModel, setSelModel] = useState<string | undefined>(undefined);
  const [selEffort, setSelEffort] = useState<string>('medium');
  const [modelOpen, setModelOpen] = useState(false);
  const projRef = useRef<HTMLDivElement | null>(null);
  /** G14.121 @ 文件面板:光标前 @token 触发;数据= picked 工作区索引(mtime 倒序);选中插 @相对路径 */
  const [filePal, setFilePal] = useState<{ query: string; from: number } | null>(null);
  const [filePalFiles, setFilePalFiles] = useState<string[]>([]);
  const [filePalActive, setFilePalActive] = useState(0);
  // G14.211 @ 面板点外即收(与会话内 Chat 同构):焦点离开输入框后 Esc 不可达,点外须收口
  useEffect(() => {
    // 外点收语义声明(D49,各弹层各表其面):本组四个弹层(项目/分支/模型/plus)同为「容器外
    // pointerdown 即收」,不监听滚动/resize——锚定文档流内(flex 卡内嵌),无 fixed 裁切面;
    // 与 SessionRowMenu(fixed 定位需滚动即收)语义不同属有意设计
    const onDocPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Element && !e.target.closest('.sx-composer')) setFilePal(null);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, []);
  const goalRef = useRef<HTMLTextAreaElement | null>(null);
  /** G14.126 @文件名 记账:选中面板行时 basename → 相对路径(发送期展开解析) */
  const pickRelRef = useRef(new Map<string, string>());
  /** G14.213 IME 组合中标记:onSelect 归位在组合期跳过(防打断输入法) */
  const goalComposingRef = useRef(false);
  /** G14.213 欢迎页 / 命令面板(与会话内同构):命令清单+技能(skillsGroups,无会话依赖) */
  const [welcomeCmdData, setWelcomeCmdData] = useState<{ commands: string[]; descriptions: Record<string, string>; supported: string[] } | null>(null);
  const [welcomeSkills, setWelcomeSkills] = useState<Array<{ id: string; desc: string }>>([]);
  const [welcomeCmdActive, setWelcomeCmdActive] = useState(0);
  const [welcomeSlashDismissed, setWelcomeSlashDismissed] = useState<string | null>(null);
  useEffect(() => {
    conn.commands().then(setWelcomeCmdData, () => setWelcomeCmdData(null));
  }, [conn]);
  /** G14.213 技能清单惰性拉取:敲 `/` 起手才拉一次(挂载即拉会污染 G8c skillsGroupsCalls 计数) */
  const welcomeSkillsFetchedRef = useRef(false);
  const fetchWelcomeSkills = (): void => {
    if (welcomeSkillsFetchedRef.current) return;
    welcomeSkillsFetchedRef.current = true;
    conn.skillsGroups?.(picked).then(
      (r) => {
        const out: Array<{ id: string; desc: string }> = [];
        for (const g of r.groups) for (const s of g.skills) if (!out.some((x) => x.id === s.id)) out.push({ id: s.id, desc: s.description ?? '' });
        setWelcomeSkills(out);
      },
      () => undefined,
    );
  };

  useEffect(() => {
    conn.settings().then(
      (view) => {
        setDefaultModel(view.keys.find((k) => k.key === 'model')?.value ?? undefined);
        setModelChoices(view.providers.choices);
      },
      () => undefined,
    );
  }, [conn]);

  // 弹层外点收(模型/强度弹层)
  useEffect(() => {
    if (!modelOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (e.target instanceof Element && e.target.closest('.sx-menu-pop') === null && e.target.closest('[aria-label="model"]') === null) {
        setModelOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [modelOpen]);

  // G14.133 审批模式弹层外点收(与 modelOpen 同款;菜单内点与锚钮自持)
  useEffect(() => {
    if (!modeOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (e.target instanceof Element && e.target.closest('.sx-menu-pop') === null && e.target.closest('[aria-label="approval mode"]') === null) {
        setModeOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [modeOpen]);

  // G14.127 索引预热:选中工作区即拉清单(手打 @根目录文件 的发送期解析不依赖面板开过);
  // 目录清单(尾斜杠)排前——@面板可滤出文件夹
  useEffect(() => {
    if (picked === '') return;
    void conn
      .workspaceFiles?.(picked)
      ?.then((r) => setFilePalFiles([...(r.dirs ?? []), ...r.files.map((f) => f.path)]), () => undefined);
  }, [picked, conn]);

  /** 预选工作区(G10-C16):项目行「+」带来的 preset——变化即选中(用户仍可在条上切换) */
  useEffect(() => {
    if (presetRoot !== undefined && presetRoot !== '' ) setPicked(presetRoot);
  }, [presetRoot]);
  useEffect(() => {
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
  }, [conn]);
  useEffect(() => {
    if (!projOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (e.target instanceof Element && e.target.closest('.proj-pop') === null && e.target.closest('.choose-project-bar') === null) {
        setProjOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [projOpen]);
  /** + 面板外点收(面板内点与 + 钮自持) */
  useEffect(() => {
    if (!plusOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (e.target instanceof Element && e.target.closest('.sx-plus-panel') === null && e.target.closest('.composer-plus-btn') === null) {
        setPlusOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [plusOpen]);
  const send = (): void => {
    // 提交目标回落 preset(G10-C16 竞态收口:组内 + 的 preset effect 与提交赛跑时,以 preset 为准)
    const target = picked !== '' ? picked : (presetRoot ?? '');
    // G14.124 @短写发送期展开为 md 绝对链接(与会话内 submitText 同口径)
    const g = expandFileRefs(goal, target, (name) => {
      const picked = pickRelRef.current.get(name);
      if (picked !== undefined) return picked;
      return filePalFiles.find((f) => (pathBasename(f)) === name);
    }).trim();
    if ((g === '' && images.length === 0) || target === '' || busy) return;
    const imgs = images.length > 0 ? images : undefined;
    setBusy(true);
    setError('');
    conn
      .newSession(target, mode === 'acceptEdits' ? 'acceptEdits' : undefined)
      .then(({ sessionId }) => {
        // G14.10:欢迎页选定的模型/思考强度随会话创建下发(会话未建前无 /session/:id 面)
        // 随建下发失败降级为缺省模型/强度继续开session(会话已建,回滚无意义);选择面下次可再切——
        // 降级可见面=模型 pill 实际档位,非静默丢失(轻口径,D30 收口口径)
        if (selModel !== undefined) void conn.setSessionModel(sessionId, selModel).catch(() => undefined);
        if (selEffort !== undefined) void conn.setSessionEffort(sessionId, selEffort).catch(() => undefined);
        // read-only 档建后补切(newSession mode 参数只收执行两档,spec §3.2;失败降级缺省档,
        // 快照回显自纠——降级口径同上)。plan 档同族补切(task 10 置灰解除,spec §5.2): armed
        // 提交经 planFlow 规划流程,批准落工作区编辑/拒绝保持
        if (mode === 'read-only') void conn.setSessionMode(sessionId, 'read-only').catch(() => undefined);
        if (mode === 'plan') void conn.setSessionMode(sessionId, 'plan').catch(() => undefined);
        setImages([]); // 图片随首条消息接力发出（pendingGoal 携图）,草稿即清
        onOpened(sessionId, target, g, imgs);
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      });
  };
  const baseName = pathBasename;
  /** G14.34:默认锚点统一显示「默认工作区」(default/sunshinex-default*带尾哈希变体同义) */
  const isDefaultPicked = picked !== '' && (() => {
    const nm = baseName(picked);
    return nm === 'default' || nm.startsWith('sunshinex-default');
  })();
  const projName = picked === '' ? t('Choose project', '选择项目') : isDefaultPicked ? t('Default workspace', '默认工作区') : baseName(picked);
  /** G14.213 欢迎页 / 面板项(渲染期,光标位置):行首 /token → 命令+技能;空=面板不开 */
  const welcomeSlashItems = (() => {
    const caret = goalRef.current?.selectionStart ?? goal.length;
    const tok = slashTokenAt(goal, caret);
    if (tok === null || !tok.atStart || welcomeCmdData === null || `/${tok.query}` === (welcomeSlashDismissed ?? '\u0000')) return null;
    const cmds = filterCommands(welcomeCmdData.commands, welcomeCmdData.descriptions, tok.query, welcomeCmdData.supported);
    const q = tok.query.toLowerCase();
    const skills = welcomeSkills
      .filter((s) => q === '' || s.id.toLowerCase().startsWith(q) || s.id.toLowerCase().includes(q))
      .slice(0, 8)
      .map((s) => {
        const idx = s.id.toLowerCase().indexOf(q);
        return { cmd: `/${s.id}`, name: s.id, desc: s.desc, idx: idx < 0 ? s.id.length : idx, ok: true, kind: 'skill' as const };
      });
    const all = [...cmds, ...skills];
    return all.length > 0 ? all : null;
  })();
  /** G14.113 欢迎页分支选择(picked 为 git 目录时显):分支清单/当前分支/切换 */
  const [gitBr, setGitBr] = useState<{ current: string; branches: string[] } | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const branchRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (picked === '' || isDefaultPicked) { setGitBr(null); setBranchOpen(false); return; }
    let alive = true;
    conn.gitBranches(picked).then(
      (r) => { if (alive) setGitBr(r.branches.length > 0 ? r : null); },
      () => { if (alive) setGitBr(null); },
    );
    return () => { alive = false; };
  }, [picked, conn, isDefaultPicked]);
  useEffect(() => {
    if (!branchOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (branchRef.current !== null && e.target instanceof Node && !branchRef.current.contains(e.target)) setBranchOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [branchOpen]);
  const checkoutBranch = (branch: string): void => {
    void conn.gitCheckout(picked, branch).then(() => {
      void conn.gitBranches(picked).then((r) => setGitBr(r.branches.length > 0 ? r : null));
    });
  };
  /** 浏览新文件夹(G10 用户裁定 + G14.51 收口):桌面壳走 IPC 系统对话框(回全路径);浏览器态
   *  开服务端 DirPicker 逐级浏览——两路都回「既有目录」绝对路径,daemon {path} 分支只登记不建
   *  目录(旧 showDirectoryPicker 拿不到路径按 name 建目录的行为废除)。已登记幂等(daemon
   *  workspace.json 同 root 直返 ok)。 */
  const browseFolder = async (): Promise<void> => {
    setHint('');
    const shell = window.sunshinex;
    if (typeof shell?.pickFolder === 'function') {
      const p = await shell.pickFolder();
      if (p === null) return;
      try {
        const res = await conn.createWorkspace({ path: p });
        setRows((prev) => {
          const list = prev ?? [];
          return list.some((r) => r.slug === res.slug) ? list : [...list, { slug: res.slug, root: res.root, sessionCount: 0 }];
        });
        setPicked(res.root);
        setProjOpen(false);
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
        const res = await conn.createWorkspace({ path: picked.path });
        setRows((prev) => {
          const list = prev ?? [];
          return list.some((x) => x.slug === res.slug) ? list : [...list, { slug: res.slug, root: res.root, sessionCount: 0 }];
        });
        setPicked(res.root);
        setProjOpen(false);
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
      .then((res) => {
        setRows((prev) => {
          const list = prev ?? [];
          return list.some((r) => r.slug === res.slug) ? list : [...list, { slug: res.slug, root: res.root, sessionCount: 0 }];
        });
        setPicked(res.root);
        setProjOpen(false);
      })
      .catch((err: unknown) => setHint(err instanceof Error ? err.message : String(err)));
  };
  // pill 回显文案四态(data-tip 与 pill-label 同源;窄视口 CSS 塌缩面 sx-main-narrow 不变)
  const modeLabel = mode === 'plan' ? t('Plan mode', '计划模式') : mode === 'read-only' ? t('Read-only', '只读模式') : mode === 'acceptEdits' ? t('Workspace edits', '工作区编辑') : t('Full access', '完全访问');
  /** 权限菜单行形(spec §3.4 四项两段):separator 行渲染 mode-pop-sep 分组线;disabled 行置灰不可选 */
  type ModeMenuRow = { separator: true } | { m: 'plan' | 'read-only' | 'acceptEdits' | 'full-access'; label: string; desc: string; icon: JSX.Element; disabled?: boolean };
  // 菜单四项两段(spec §3.4):与会话内 mode-pop 同构——plan 置顶(阶段三 plan-arm 接通正式开放)+分组线+三权限档
  const modeRows: ModeMenuRow[] = [
    { m: 'plan' as const, label: t('Plan mode', '计划模式'), desc: t('Plan first, execute on approval', '先规划，批准后执行'), icon: <ListTodo size={15} strokeWidth={1.75} aria-hidden="true" /> },
    { separator: true },
    { m: 'read-only' as const, label: t('Read-only', '只读模式'), desc: t('Read-only analysis, no changes', '只读分析，不改文件'), icon: <Eye size={15} strokeWidth={1.75} aria-hidden="true" /> },
    { m: 'acceptEdits' as const, label: t('Workspace edits', '工作区编辑'), desc: t('Direct edits in-workspace, asks outside', '工作区内直接改，域外需确认'), icon: <ShieldCheck size={15} strokeWidth={1.75} aria-hidden="true" /> },
    { m: 'full-access' as const, label: t('Full access', '完全访问'), desc: t('Fully automatic, blocks destructive commands', '全自动执行，仅拦破坏性命令'), icon: <Unlock size={15} strokeWidth={1.75} aria-hidden="true" /> },
  ];
  return (
    <div className="sx-welcome sx-welcome-home" aria-label="welcome">
      <div className="welcome-hero">
        {/* mark 几何手工镜像 scripts/gen-shell-icon.mjs（ORBIT_RX/RY、STROKE、CORE_R、TILT）——
            改形两侧同步,生成面只认脚本单源(窗口图标/托盘/ico 由此回填) */}
        <svg className="welcome-logo" width="100" height="100" viewBox="0 0 72 72" fill="none" aria-hidden="true">
          <g transform="rotate(-15 36 36)">
            <g stroke="currentColor" strokeWidth="2.5">
              <path d="M52.11 30.17A19 11 0 0 1 52.11 41.83" />
              <path d="M46.07 45.33A19 11 0 0 1 25.93 45.33" />
              <path d="M19.89 41.83A19 11 0 0 1 19.89 30.17" />
              <path d="M25.93 26.67A19 11 0 0 1 46.07 26.67" />
            </g>
            <circle cx="36" cy="36" r="4.5" fill="currentColor" />
          </g>
        </svg>
        <h1 className="welcome-tagline">{t('What should we do today?', '今天要做些什么？')}</h1>
      </div>
      <div className="welcome-dock">
        <div className="welcome-options-bar">
          <button
            type="button"
            className="choose-project-bar"
            aria-label={t('Choose project', '选择项目')}
            onClick={() => setProjOpen((v) => !v)}
          >
            <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{projName}</span>
          </button>
          {/* G14.113 分支选择 pill(git 目录才显):当前分支+弹层切换 */}
          {gitBr !== null && gitBr.current !== '' && (
            <div className="pill-anchor" ref={branchRef}>
              <button
                type="button"
                className="composer-pill branch-pill"
                aria-label="git branch"
                aria-expanded={branchOpen}
                data-tip={`${t('Current branch', '当前分支')}: ${gitBr.current}`}
                onClick={() => setBranchOpen((v) => !v)}
              >
                <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" />
                <span className="branch-pill-name">{gitBr.current}</span>
                <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
              {branchOpen && (
                <div className="sx-menu-pop pill-pop" role="menu" aria-label={t('Branch', '分支')}>
                  {gitBr.branches.map((b) => (
                    <button
                      key={b}
                      type="button"
                      role="menuitem"
                      className={`sx-menuitem${b === gitBr.current ? ' active' : ''}`}
                      onClick={() => {
                        setBranchOpen(false);
                        checkoutBranch(b);
                      }}
                    >
                      {b}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {projOpen && (
          <div className="proj-pop" role="menu" aria-label={t('Projects', '项目')} ref={projRef}>
            {rows.map((r) => (
              <button
                key={r.slug}
                type="button"
                role="menuitem"
                className={`sx-menuitem${r.root === picked ? ' active' : ''}`}
                onClick={() => {
                  setPicked(r.root ?? '');
                  setProjOpen(false);
                }}
              >
                {(() => {
                  const nm = baseName(r.root ?? r.slug);
                  return nm === 'default' || nm.startsWith('sunshinex-default') ? t('Default workspace', '默认工作区') : nm;
                })()}
              </button>
            ))}
            <button type="button" role="menuitem" className="sx-menuitem proj-browse" onClick={() => void browseFolder()}>
              <FolderAddIcon size={14} /> {t('Browse folders…', '浏览文件夹…')}
            </button>
            {hint !== '' && <div className="proj-hint">{hint}</div>}
          </div>
        )}
        {dirOpen && (
          <div className="modal-overlay" onClick={() => setDirOpen(false)}>
            <div className="modal-body" onClick={(e) => e.stopPropagation()}>
              <DirPicker conn={conn} showManual={false} onCancel={() => setDirOpen(false)} onConfirm={registerFolder} />
            </div>
          </div>
        )}
        {/* 输入卡 = 会话中同一份 ComposerCard(唯一差异:欢迎页在卡外多项目选择条) */}
        <ComposerCard
          label="welcome goal"
          inputRef={goalRef}
          images={images}
          onRemoveImage={(i) => setImages((cur) => cur.filter((_, idx) => idx !== i))}
          onImageOpen={setLightboxSrc}
          onPasteFiles={attachImages}
          highlight={renderMentionSpans(goal, (n) => pickRelRef.current.get(n) ?? filePalFiles.find((f) => pathBasename(f) === n))}
          value={goal}
          rows={Math.min(6, Math.max(1, (goal.match(/\n/g) ?? []).length + 1))}
          placeholder={t('Describe the goal and press Enter…', '描述目标,回车开始…')}
          onChange={(v) => {
            setGoal(v);
            setWelcomeSlashDismissed(null); // G14.213 Esc 收起后任何编辑即重新放行 / 面板
            if (v.includes('/')) fetchWelcomeSkills(); // G14.213 惰性拉技能清单(敲 / 起手一次)
            // G14.124 面板跟随输入(光标前 @token 即开);无匹配=渲染面自然关闭
            const caret = goalRef.current?.selectionStart ?? v.length;
            const m = /@([\w./:\\-]*)$/.exec(v.slice(0, caret));
            if (m !== null) {
              setFilePal({ query: m[1] ?? '', from: caret - (m[1]?.length ?? 0) - 1 });
              setFilePalActive(0); // G14.2xx 查询变更即重置 active(残留箭头位回车选中邻项)
              if (picked !== '') {
                void conn
                  .workspaceFiles(picked)
                  .then((r) => setFilePalFiles([...(r.dirs ?? []), ...r.files.map((f) => f.path)]), () => setFilePalFiles([]));
              }
            } else if (filePal !== null) {
              setFilePal(null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === '/') fetchWelcomeSkills(); // G14.213 / 起手即拉技能清单
            // G14.212 token 原子性(与会话内同构):整删 + 不可在 token 中间落字(键入/IME)
            if (e.key === 'Backspace' || e.key === 'Delete') {
              const ta = e.currentTarget as HTMLTextAreaElement;
              const caret = ta.selectionStart ?? goal.length;
              if (ta.selectionStart === ta.selectionEnd) {
                const range = tokenDeleteRange(goal, caret, e.key);
                if (range !== null) {
                  e.preventDefault();
                  const [s, e2] = range;
                  setGoal((prev) => prev.slice(0, s) + prev.slice(e2));
                  requestAnimationFrame(() => { goalRef.current?.setSelectionRange(s, s); });
                  return;
                }
              }
            }
            if ((e.key.length === 1 || e.key === 'Process') && !e.ctrlKey && !e.metaKey && !e.altKey) {
              const ta = e.currentTarget as HTMLTextAreaElement;
              const cs = ta.selectionStart ?? goal.length;
              const ce = ta.selectionEnd ?? cs;
              const [as, ae] = atomicRange(goal, cs, ce);
              if (as !== cs || ae !== ce) {
                e.preventDefault();
                ta.setSelectionRange(ae, ae);
                return;
              }
            }
            // G14.213 ←/→ 单击跨整个 token(有选区时原生移动)
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              const ta = e.currentTarget as HTMLTextAreaElement;
              const c = ta.selectionStart ?? 0;
              const ce = ta.selectionEnd ?? c;
              if (c === ce) {
                const dir = e.key === 'ArrowLeft' ? -1 : 1;
                const nc = c + dir;
                if (nc >= 0 && nc <= ta.value.length) {
                  const span = tokenSpanAt(ta.value, nc);
                  if (span !== null) {
                    e.preventDefault();
                    const to = dir < 0 ? span[0] : span[1];
                    ta.setSelectionRange(to, to);
                  }
                }
              }
            }
            if (e.key !== 'Process' && e.nativeEvent.isComposing !== true) goalComposingRef.current = false;
            // G14.121 @ 文件面板(与会话内同构):任意位置 @token → 最近改动文件清单;
            // 选中插入 @相对路径(发送期统一展开为 md 绝对链接);面板开时 Enter/↑↓ 归面板
            const taEl = e.currentTarget as HTMLTextAreaElement;
            const caret = taEl.selectionStart ?? goal.length;
            const atMatch = /@([\w./:\\-]*)$/.exec(goal.slice(0, caret));
            if (atMatch !== null) {
              setFilePal({ query: atMatch[1] ?? '', from: caret - (atMatch[1]?.length ?? 0) - 1 });
              if (picked !== '') {
                void conn
                  .workspaceFiles(picked)
                  .then((r) => setFilePalFiles([...(r.dirs ?? []), ...r.files.map((f) => f.path)]), () => setFilePalFiles([]));
              }
            } else if (filePal !== null) {
              setFilePal(null);
            }
            const items = picked === '' ? [] : rankFileHits(filePalFiles, filePal?.query ?? '');
            if (filePal !== null && items.length > 0) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setFilePalActive((a) => (e.key === 'ArrowDown' ? (a + 1) % items.length : (a - 1 + items.length) % items.length));
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setFilePal(null);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                const rel = items[Math.min(filePalActive, items.length - 1)];
                // G14.126 选中只插短写 @文件名(显形=图标+文件名),相对路径记账供发送期展开;
                // 目录项(尾斜杠内部标记):插入文本不带斜杠,记账保标记——芯片/展开面判目录
                const base = pathBasename(rel);
                pickRelRef.current.set(base, rel);
                const atFrom = filePal.from;
                const atEnd = atFrom + 1 + filePal.query.length;
                setGoal((prev) => prev.slice(0, atFrom) + `@${base} ` + prev.slice(Math.max(atEnd, atFrom)));
                setFilePal(null);
                // G14.211 光标钉在插入 token 之后(程序化改值,旧光标位恢复=token 中间)
                requestAnimationFrame(() => {
                  const g = goalRef.current;
                  if (g === null) return;
                  const to = Math.min(atFrom + base.length + 2, g.value.length);
                  g.setSelectionRange(to, to);
                });
                return;
              }
            }
            // G14.213 欢迎页 / 命令+技能面板(与会话内同构):行首 /token → 面板;↑↓ 选择、
            // Enter/Tab 补全 `/cmd `(执行发生在会话建立后:pendingGoal 经 submitText 命令门控),
            // Esc 本次收起;无匹配=面板不开
            const slashTok = slashTokenAt(goal, caret);
            const slashItems =
              slashTok !== null && slashTok.atStart && welcomeCmdData !== null && `/${slashTok.query}` !== (welcomeSlashDismissed ?? '\u0000')
                ? [
                  ...filterCommands(welcomeCmdData.commands, welcomeCmdData.descriptions, slashTok.query, welcomeCmdData.supported),
                  ...welcomeSkills
                    .filter((s) => slashTok.query === '' || s.id.toLowerCase().startsWith(slashTok.query.toLowerCase()) || s.id.toLowerCase().includes(slashTok.query.toLowerCase()))
                    .slice(0, 8)
                    .map((s) => {
                      const idx = s.id.toLowerCase().indexOf(slashTok.query.toLowerCase());
                      return { cmd: `/${s.id}`, name: s.id, desc: s.desc, idx: idx < 0 ? s.id.length : idx, ok: true, kind: 'skill' as const };
                    }),
                ]
                : [];
            if (slashTok !== null && slashItems.length > 0) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setWelcomeCmdActive((a) => (e.key === 'ArrowDown' ? (a + 1) % slashItems.length : (a - 1 + slashItems.length) % slashItems.length));
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setWelcomeCmdActive(0);
                setWelcomeSlashDismissed(`/${slashTok.query}`);
                return;
              }
              if ((e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === 'Tab') {
                e.preventDefault();
                const item = slashItems[Math.min(welcomeCmdActive, slashItems.length - 1)];
                if (item !== undefined) {
                  setGoal((prev) => prev.slice(0, slashTok.from) + item.cmd + ' ' + prev.slice(caret));
                  setWelcomeCmdActive(0);
                }
                return;
              }
            }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            onBeforeInput={(e) => {
              // G14.212 token 原子性兜底面(与会话内同构)
              const ev = e.nativeEvent as InputEvent;
              const ta = e.currentTarget;
              const s = ta.selectionStart ?? 0;
              const en = ta.selectionEnd ?? 0;
              const v = tokenGuardVerdict(goal, s, en, ev.inputType ?? '');
              if (v.action === 'redirectEnd') {
                e.preventDefault();
                ta.setSelectionRange(v.to, v.to);
              } else if (v.action === 'splice') {
                e.preventDefault();
                setGoal((prev) => prev.slice(0, v.s) + prev.slice(v.e));
                requestAnimationFrame(() => ta.setSelectionRange(v.s, v.s));
              }
            }}
            onPasteGuard={(e) => {
              const ta = e.currentTarget;
              const s = ta.selectionStart ?? 0;
              const en = ta.selectionEnd ?? 0;
              const [as, ae] = atomicRange(goal, s, en);
              if (as !== s || ae !== en) {
                e.preventDefault();
                ta.setSelectionRange(ae, ae);
              }
            }}
            onCompositionGuard={(e) => {
              goalComposingRef.current = true; // G14.213 组合中:onSelect 归位跳过
              const ta = e.currentTarget;
              const s = ta.selectionStart ?? 0;
              const en = ta.selectionEnd ?? 0;
              const [as, ae] = atomicRange(goal, s, en);
              if (as !== s || ae !== en) e.preventDefault();
            }}
            onCompositionEndGuard={() => {
              goalComposingRef.current = false;
            }}
            onSelectGuard={() => {
              // G14.213 光标不落 token 中间:↑↓/Home/End 等原生移动后的兜底归位(IME 组合中跳过)
              if (goalComposingRef.current) return;
              const ta = goalRef.current;
              if (ta === null) return;
              const s = ta.selectionStart ?? 0;
              const en = ta.selectionEnd ?? 0;
              if (s !== en) return;
              const span = tokenSpanAt(ta.value, s);
              if (span !== null) ta.setSelectionRange(span[1], span[1]);
            }}
          overlays={
            // G14.121 @ 文件面板优先(命中才渲染;点击行=插入绝对路径,面板收起);
            // G14.211 锚点校验:@ 被删后面板残留在此拦下(同 Chat 渲染面)
            filePal !== null && picked !== '' && goal[filePal.from] === '@' && filePalFiles.some((f) => fileHit(f, filePal.query)) ? (
              <FilePalette
                items={rankFileHits(filePalFiles, filePal.query)}
                active={Math.min(filePalActive, 11)}
                onHover={setFilePalActive}
                onPick={(p) => {
                  // G14.126 选中只插短写 @文件名,相对路径记账供发送期展开
                  const base = pathBasename(p);
                  pickRelRef.current.set(base, p);
                  const atFrom = filePal.from;
                  const atEnd = atFrom + 1 + filePal.query.length;
                  setGoal((prev) => prev.slice(0, atFrom) + `@${base} ` + prev.slice(Math.max(atEnd, atFrom)));
                  setFilePal(null);
                  // G14.211 焦点回输入框 + 光标钉在插入 token 之后(面板行点击带走焦点,
                  // 不回焦则后续键入落空;旧光标位恢复=token 中间)
                  goalRef.current?.focus();
                  requestAnimationFrame(() => {
                    const g = goalRef.current;
                    if (g === null) return;
                    const to = Math.min(atFrom + base.length + 2, g.value.length);
                    g.setSelectionRange(to, to);
                  });
                }}
              />
            ) : welcomeSlashItems !== null ? (
              (() => {
                // G14.213 欢迎页 / 命令+技能面板:行点击补全 `/cmd `(执行在会话建立后)
                const items = welcomeSlashItems;
                const active = Math.min(welcomeCmdActive, Math.max(0, items.length - 1));
                const pick = (item: { cmd: string; ok: boolean }): void => {
                  if (!item.ok) return;
                  const tok = slashTokenAt(goal, goalRef.current?.selectionStart ?? goal.length);
                  const from = tok !== null ? tok.from : goal.length;
                  const caret = goalRef.current?.selectionStart ?? goal.length;
                  setGoal(goal.slice(0, from) + item.cmd + ' ' + goal.slice(caret));
                  setWelcomeCmdActive(0);
                  goalRef.current?.focus();
                };
                return <CommandPalette items={items} active={active} onHover={setWelcomeCmdActive} onPick={pick} />;
              })()
            ) : plusOpen ? (
              <ComposerPlusPanel
                conn={conn}
                root={picked !== '' ? picked : undefined}
                onAttachImages={attachImages}
                onInsert={(text) => {
                  setGoal((v) => (v.trim() === '' ? text : `${v.replace(/\s+$/, '')} ${text}`));
                  setPlusOpen(false);
                }}
              />
            ) : null
          }
          belowInput={error !== '' ? <div className="proj-hint" role="alert">{error}</div> : undefined}
          footLeft={
            <>
              {/* + 开附加面板(卡顶同宽浮层:命令/技能;文件区需会话——欢迎页不渲染) */}
              <button
                type="button"
                className="composer-pill composer-plus-btn"
                aria-label="add attachment"
                aria-expanded={plusOpen}
                data-tip={t('Add skills, commands or files', '添加技能、命令或文件')}
                onClick={() => setPlusOpen((v) => !v)}
              >
                <PlusAddIcon size={16} />
              </button>
              {/* 审批模式:弹层锚按钮正上方(pill-anchor) */}
              <div className="pill-anchor">
                <button
                  type="button"
                  className="composer-pill"
                  aria-label="approval mode"
                  aria-expanded={modeOpen}
                  // D51 G-4:窄栏塌缩(sx-main-narrow)时 tooltip 承载当前模式名——与会话内 pill 同构
                  data-tip={modeLabel}
                  onClick={() => setModeOpen((v) => !v)}
                >
                  {/* G14.133 分档图标与菜单同源(ModeIcon)——静态 Hand 两套渲染退役;
                      标签/箭头走 pill-label/pill-chevron 类:pills-tight 实测塌缩按类收,
                      裸文本无类收不到(600 窗欢迎页「完全访问」不塌的根因),文案由 data-tip 承载 */}
                  <ModeIcon mode={mode} />
                  <span className="pill-label">{modeLabel}</span>
                  <ChevronDown className="pill-chevron" size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
                {modeOpen && (
                  <div className="sx-menu-pop pill-pop mode-pop" role="menu" aria-label="approval mode menu">
                    {/* G14.113 与会话内 mode-pop 同构:四项两段——Plan 首位(置灰)+横线+三权限档;图标+双行(名称+解释) */}
                    {modeRows.map((row, idx) => (
                      <div key={'separator' in row ? `sep-${idx}` : row.m} className="mode-pop-group">
                        {'separator' in row ? (
                          <div className="mode-pop-sep" aria-hidden="true" />
                        ) : (
                          <button
                            type="button"
                            role="menuitem"
                            className={`mode-item${!row.disabled && mode === row.m ? ' active' : ''}`}
                            aria-disabled={row.disabled === true ? true : undefined}
                            data-tip={row.disabled === true ? t('Coming soon', '即将可用') : undefined}
                            onClick={() => {
                              if (row.disabled === true) return; // 阶段一 plan 置灰:不可选(阶段三 plan-arm 接通)
                              setMode(row.m);
                              setModeOpen(false);
                            }}
                          >
                            <span className="mode-item-icon">{row.icon}</span>
                            <span className="mode-item-body">
                              <span className="mode-item-name">{row.label}</span>
                              <span className="mode-item-desc">{row.desc}</span>
                            </span>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          }
          footRight={
            <>
              {/* 模型 pill(G14.10 Codex 形):点击弹层 = 模型列表 + 思考强度滑动块;选定随会话创建下发 */}
              <div className="pill-anchor">
              <button
                type="button"
                className="composer-pill model-pill"
                aria-label="model"
                aria-expanded={modelOpen}
                data-tip={selModel ?? defaultModel ?? undefined}
                onClick={() => setModelOpen((v) => !v)}
              >
                {baseModelName(selModel ?? defaultModel)}
                {selEffort !== undefined && <EffortChip effort={selEffort} />}
                <ChevronDown className="pill-chevron" size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
              {modelOpen && (
                <div className="sx-menu-pop pill-pop pill-pop-right" role="menu" aria-label="model menu">
                  {modelChoices.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="menuitem"
                      // 当前项 ✓+强调色(current 类,样式单点 app.css);显示名比对——defaultModel
                      // 带前缀/变体尾串而 choice id 裸名,精确 id 比对恒 false(会话内同款修法)
                      className={`sx-menuitem${(selModel ?? defaultModel) !== undefined && baseModelName(c.id) === baseModelName(selModel ?? defaultModel) ? ' current' : ''}`}
                      data-tip={c.id}
                      onClick={() => {
                        setSelModel(c.id);
                        if (c.effort !== undefined) setSelEffort(c.effort);
                      }}
                    >
                      {baseModelName(c.id)}
                    </button>
                  ))}
                  <div className="pill-group-head">{t('Reasoning effort', '思考强度')}</div>
                  <EffortSlider value={selEffort ?? 'medium'} onChange={setSelEffort} />
                </div>
              )}
              </div>
              <button
                type="button"
                className="send"
                aria-label="send"
                data-tip={t('Send', '发送')}
                disabled={busy || (goal.trim() === '' && images.length === 0) || picked === ''}
                onClick={send}
              >
                <ArrowUp size={16} strokeWidth={2.25} aria-hidden="true" />
              </button>
            </>
          }
        />
        {lightboxSrc !== undefined && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(undefined)} />}
      </div>
    </div>
  );
}
