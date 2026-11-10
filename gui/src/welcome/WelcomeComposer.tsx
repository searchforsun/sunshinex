import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import { ArrowUp, ChevronDown, Folder, FolderGit2, GitBranch } from 'lucide-react';
import { pathBasename } from '../ui-util';
import { DirPicker } from '../pages/DirPicker';
import { atomicRange, baseModelName, expandFileRefs, FilePalette, fileHit, ModeIcon, rankFileHits, renderMentionSpans, slashTokenAt, tokenDeleteRange, tokenGuardVerdict, tokenSpanAt } from '../pages/Chat';
import { RefPalette } from '../pages/chat/mention';
import { CommandPalette } from '../CommandPalette';
import { flatRefItems, refTokenAt } from '../pages/chat/ref-palette';
import type { RefEntries, RefPal } from '../pages/chat/ref-palette';
import { ComposerCard } from '../composer/ComposerCard';
import { ModeMenu, sessionModeLabel } from '../composer/mode-menu';
import { MAX_IMAGES, appendImages, loadImages } from '../images';
import { ComposerPlusPanel } from '../composer/ComposerPlusPanel';
import { ImageLightbox } from '../ImageLightbox';
import { EffortChip } from '../effort-slider';
import { FolderAddIcon } from '../sidebar/ProjectMenu';
import { PlusAddIcon } from '../sidebar/project-menu-util';
import type { WelcomeComposerConn } from './welcome-conn';
import { usePopOutsideClose } from '../use-pop-outside-close';
import { useWelcomeWorkspaces } from './use-welcome-workspaces';
import { useWelcomeFiles } from './use-welcome-files';
import { useWelcomeSlash } from './use-welcome-slash';
import { useWelcomeBranch } from './use-welcome-branch';
import { WelcomeLogo } from './welcome-logo';
import { WelcomeModelMenu } from './welcome-model-menu';
import { WelcomeBranchMenu } from './welcome-branch-menu';

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
  presetSeq,
  onOpened,
}: {
  conn: WelcomeComposerConn;
  /** 预选工作区(G10-C16):项目行「+」带来的 preset */
  presetRoot?: string;
  /** 预选意图序号:递增即按 presetRoot 重选(缺 presetRoot=回默认工作区) */
  presetSeq?: number;
  onOpened: (sessionId: string, root: string, goal: string, images?: string[]) => void;
}): JSX.Element {
  const [picked, setPicked] = useState('');
  // 草稿持久化(2026-11-07 用户裁定「应用重启后,所有输入框内容不丢失」):goal+@引用账本
  // 落 localStorage(欢迎页全局单档;发送清档,openSession 接力不受影响)
  const [goal, setGoal] = useState<string>(() => {
    try {
      return localStorage.getItem('sx-draft:welcome') ?? '';
    } catch {
      return '';
    }
  });
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
  /** 工作区隔离(2026-11-10 用户裁定「新会话可选 git worktree 隔离」):pill 武装态随提交下发;
   *  首次开启弹说明框(益处/代价),armed 后再点即解除。仅 git 项目可开(gitBr 在场判定) */
  const [isolate, setIsolate] = useState(false);
  const [isoOpen, setIsoOpen] = useState(false);
  /** 发送前切换确认(2026-11-10 用户裁定「选择不切换,发送时统一落地」):非隔离+选了异于当前
   *  的分支 → 弹「切换并发送」(branchDiffStat 代价面;脏树带提交信息框) */
  const [switchPending, setSwitchPending] = useState<{ branch: string; stat: { files: number; added: number; deleted: number; dirty: number; dirtyAdded: number; dirtyDeleted: number; missing: boolean } | null } | null>(null);
  const [switchMsg, setSwitchMsg] = useState('');
  /** 隔离分支被占 409 BRANCH_HELD(2026-11-10 用户裁定「提示已被签出,输入框空=随机分支,
   *  『创建分支并隔离』」):重选/改名两通道 */
  const [heldBranch, setHeldBranch] = useState<string | null>(null);
  const [heldNew, setHeldNew] = useState('');
  /** 缺省模型名(G13 反馈轮):settings model 键回显(拉取失败留 undefined → 「默认模型」兜底) */
  const [defaultModel, setDefaultModel] = useState<string | undefined>(undefined);
  const [modelChoices, setModelChoices] = useState<Array<{ id: string; effort?: string }>>([]);
  // 模型/思考强度持久(2026-11-09 用户裁定「欢迎页记录上次选的模型和强度,切换会话后还是当时选择的」):
  // localStorage 即时层,挂载读回;跨端漫游不上收(ui-pref-sync 口径外,设备本地即可)
  const [selModel, setSelModel] = useState<string | undefined>(() => localStorage.getItem('sx-welcome:model') ?? undefined);
  const [selEffort, setSelEffort] = useState<string>(() => localStorage.getItem('sx-welcome:effort') ?? 'medium');
  useEffect(() => {
    if (selModel !== undefined) localStorage.setItem('sx-welcome:model', selModel);
    else localStorage.removeItem('sx-welcome:model');
  }, [selModel]);
  useEffect(() => {
    localStorage.setItem('sx-welcome:effort', selEffort);
  }, [selEffort]);
  // 记忆的模型已不在清单(providers 变更删除)→ 回落缺省,不把失效 id 带进新会话
  useEffect(() => {
    if (selModel !== undefined && modelChoices.length > 0 && !modelChoices.some((c) => c.id === selModel)) setSelModel(undefined);
  }, [modelChoices, selModel]);
  const [modelOpen, setModelOpen] = useState(false);
  const projRef = useRef<HTMLDivElement | null>(null);
  /** G14.121 @ 文件面板:光标前 @token 触发;数据= picked 工作区索引(mtime 倒序);选中插 @相对路径 */
  const [filePal, setFilePal] = useState<{ query: string; from: number } | null>(null);
  const { files: filePalFiles, refresh: refreshFilePalFiles } = useWelcomeFiles(conn, picked);
  const [filePalActive, setFilePalActive] = useState(0);
  /** $/# 引用面板(2026-11-05 用户裁定:欢迎页与会话页同构)——检测/懒加载/键盘/overlays 四件套
   *  全按 Chat 页同款;数据源缺法(conn 桩未挂)=面板永不触发 */
  const [refPal, setRefPal] = useState<RefPal | null>(null);
  const [refEntries, setRefEntries] = useState<RefEntries>({ agents: [], teams: [] });
  const [refActive, setRefActive] = useState(0);
  const refEntriesLoadedRef = useRef(false);
  const loadRefEntries = (): void => {
    if (refEntriesLoadedRef.current) return;
    if (conn.agentsView === undefined || conn.teamsView === undefined) return;
    refEntriesLoadedRef.current = true;
    const refRoot = picked !== '' ? picked : undefined;
    void Promise.all([conn.agentsView(refRoot), conn.teamsView(refRoot)]).then(
      ([a, tv]) => {
        setRefEntries({
          // 内置四角色并入候选池+同 id 去重(builtin-first)——与会话页 Chat 同口径
          agents: [
            ...a.builtins.map((b) => ({ id: b.role, name: b.name })),
            ...a.view.entries.filter((e) => e.shadowed !== true).map((e) => ({ id: e.id, name: e.name })),
          ].filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i),
          teams: tv.view.entries.filter((e) => e.shadowed !== true).map((e) => ({ id: e.id, name: e.name })),
        });
      },
      () => {}, // 失败静默空列(面板照开仅空态引导;不重试——零网络纪律)
    );
  };
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
  // @引用账本回灌(芯片/短写展开依赖;随草稿落盘,重启恢复)
  try {
    const rawPicks = localStorage.getItem('sx-draft:welcome:refs');
    if (rawPicks !== null) {
      for (const [k, v] of JSON.parse(rawPicks) as Array<[string, string]>) pickRelRef.current.set(k, v);
    }
  } catch {
    // 档损坏即弃
  }

  // 草稿持久化(2026-11-07 用户裁定「重启后所有输入框内容不丢失」):goal 变更即落;
  // @引用账本随渲染全量序列化(set 分散在事件/面板各处,量小代价可忽略)
  useEffect(() => {
    try {
      localStorage.setItem('sx-draft:welcome', goal);
      localStorage.setItem('sx-draft:welcome:refs', JSON.stringify([...pickRelRef.current]));
    } catch {
      // 隐私模式写失败静默
    }
  }, [goal]);
  /** G14.213 IME 组合中标记:onSelect 归位在组合期跳过(防打断输入法) */
  const goalComposingRef = useRef(false);

  useEffect(() => {
    conn.settings().then(
      (view) => {
        setDefaultModel(view.keys.find((k) => k.key === 'model')?.value ?? undefined);
        setModelChoices(view.providers.choices);
      },
      () => undefined,
    );
  }, [conn]);

  // 弹层外点收(模型/审批模式两弹层;usePopOutsideClose 单点,面板内点与锚钮自持)
  usePopOutsideClose(modelOpen, '.sx-menu-pop', '[aria-label="model"]', () => setModelOpen(false));
  usePopOutsideClose(modeOpen, '.sx-menu-pop', '[aria-label="approval mode"]', () => setModeOpen(false));

  usePopOutsideClose(projOpen, '.proj-pop', '.choose-project-bar', () => setProjOpen(false));
  // + 面板外点收(面板内点与 + 钮自持);2026-10-31 用户裁定:主动点开 + 即拉最新技能清单(5s 节流在 fetch 侧)
  usePopOutsideClose(plusOpen, '.sx-plus-panel', '.composer-plus-btn', () => setPlusOpen(false));
  useEffect(() => {
    if (!plusOpen) return;
    fetchWelcomeSkills();
  }, [plusOpen]);
  const sendRef = useRef<() => void>(() => undefined);
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
    // 分支选择落地(2026-11-10 用户裁定「选择不切换,发送时统一落地」):非隔离且选了异于当前的
    // 分支 → 先弹「切换并发送」确认(脏树带提交信息框,branchDiffStat 示代价);隔离 → worktree
    // 签出选中分支(被占 409 BRANCH_HELD → 弹「已被签出」重选/改名框)
    if (!isolate && gitBr !== null && selectedBranch !== '' && selectedBranch !== gitBr.current) {
      setSwitchMsg('');
      setSwitchPending({ branch: selectedBranch, stat: null });
      conn.branchDiffStat?.(target, selectedBranch).then(
        (stat) => setSwitchPending((p) => (p !== null && p.branch === selectedBranch ? { ...p, stat } : p)),
        () => setSwitchPending((p) => (p !== null ? { ...p, stat: { files: 0, added: 0, deleted: 0, dirty: 0, dirtyAdded: 0, dirtyDeleted: 0, missing: true } } : p)),
      );
      return;
    }
    void doSend(target, undefined, undefined);
  };
  /** 真实发送(switchBranch 在场=先提交并切换再建会话) */
  const doSend = (target: string, switchBranch: string | undefined, switchMessage: string | undefined): void => {
    // G14.124 @短写发送期展开为 md 绝对链接(与会话内 submitText 同口径)
    const g = expandFileRefs(goal, target, (name) => {
      const picked = pickRelRef.current.get(name);
      if (picked !== undefined) return picked;
      return filePalFiles.find((f) => (pathBasename(f)) === name);
    }).trim();
    if ((g === '' && images.length === 0) || target === '' || busy) return;
    const imgs = images.length > 0 ? images : undefined;
    const isolateOn = isolate === true && gitBr !== null && gitBr.current !== '';
    const treeBranch = isolateOn && selectedBranch !== '' ? selectedBranch : undefined;
    const proceed = (): void => {
      conn
        .newSession(target, mode === 'acceptEdits' ? 'acceptEdits' : undefined, isolateOn, treeBranch)
        .then(({ sessionId, worktree }) => {
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
        try {
          localStorage.removeItem('sx-draft:welcome');
          localStorage.removeItem('sx-draft:welcome:refs');
        } catch {
          // 隐私模式写失败静默
        }
        onOpened(sessionId, worktree !== undefined ? worktree.path : target, g, imgs);
      })
      .catch((err: unknown) => {
        setBusy(false);
        if ((err as { code?: unknown } | null)?.code === 'BRANCH_HELD') {
          setHeldBranch(treeBranch ?? '');
          setError('');
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      });
    };
    if (switchBranch !== undefined) {
      setBusy(true);
      setError('');
      (typeof conn.gitCommitCheckout === 'function'
        ? conn.gitCommitCheckout(target, switchBranch, false, switchMessage)
        : Promise.reject(new Error(t('Not supported', '不支持'))))
        .then(() => {
          setBusy(false);
          setSwitchPending(null);
          proceed();
        })
        .catch((err: unknown) => {
          setBusy(false);
          setError(err instanceof Error ? err.message : String(err));
        });
      return;
    }
    proceed();
  };
  sendRef.current = send;
  const baseName = pathBasename;
  /** G14.34:默认锚点统一显示「默认工作区」(default/sunshinex-default*带尾哈希变体同义) */
  const isDefaultPicked = picked !== '' && (() => {
    const nm = baseName(picked);
    return nm === 'default' || nm.startsWith('sunshinex-default');
  })();
  const projName = picked === '' ? t('Choose project', '选择项目') : isDefaultPicked ? t('Default workspace', '默认工作区') : baseName(picked);
  const { welcomeCmdActive, setWelcomeCmdActive, setWelcomeSlashDismissed, fetchWelcomeSkills, welcomeSlashItems, slashItemsAt } = useWelcomeSlash(conn, picked, goal, goalRef);
  const { gitBr, branchOpen, setBranchOpen, branchRef, selectedBranch, pick: pickBranch, createBranchOnly, setSelectedBranch: setSelBranch } = useWelcomeBranch(conn, picked, isDefaultPicked, setHint);
  const { rows, browseFolder, registerFolder } = useWelcomeWorkspaces(conn, presetRoot, presetSeq, { setPicked, setProjOpen, setHint, setDirOpen });
  return (
    <div className="sx-welcome sx-welcome-home" aria-label="welcome">
      <div className="welcome-hero">
        <WelcomeLogo />
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
                className={`composer-pill branch-pill${selectedBranch !== '' ? ' picked' : ''}`}
                aria-label="git branch"
                aria-expanded={branchOpen}
                data-tip={selectedBranch !== '' ? `${t('Will switch to at send', '发送时将切换到')}: ${selectedBranch}` : `${t('Current branch', '当前分支')}: ${gitBr.current}`}
                onClick={() => setBranchOpen((v) => !v)}
              >
                <GitBranch size={14} strokeWidth={1.75} aria-hidden="true" />
                <span className="branch-pill-name">{selectedBranch !== '' ? selectedBranch : gitBr.current}</span>
                <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
              {branchOpen && (
                <WelcomeBranchMenu
                  gitBr={gitBr}
                  onPick={pickBranch}
                  onCreate={createBranchOnly}
                  selected={selectedBranch}
                />
              )}
            </div>
          )}
          {/* 工作区隔离 pill(2026-11-10,git 项目才显):武装态高亮;首开弹益处/代价说明框 */}
          {gitBr !== null && gitBr.current !== '' && (
            <button
              type="button"
              className={`composer-pill isolate-pill${isolate ? ' on' : ''}`}
              aria-label="isolate workspace"
              aria-pressed={isolate}
              data-tip={isolate ? t('Isolated workspace on — click to turn off', '隔离工作区已开启，点击关闭') : t('Isolated workspace (git worktree)', '隔离工作区（git worktree）')}
              onClick={() => (isolate ? setIsolate(false) : setIsoOpen(true))}
            >
              <FolderGit2 size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{t('Isolate', '隔离')}</span>
            </button>
          )}
        </div>
        {/* 发送前切换确认(全局 portal):branchDiffStat 代价面;脏树=提交信息框+±数量 */}
        {switchPending !== null &&
          createPortal(
            <div className="modal-overlay" onClick={() => setSwitchPending(null)}>
              <div className="modal-body sx-dirty-dialog" role="dialog" aria-label={t('Switch and send', '切换并发送')} onClick={(e) => e.stopPropagation()}>
                <p className="sx-dirty-target">
                  {t('Send after switching to', '发送后切换到')} <b>{switchPending.branch}</b>
                </p>
                <p className="sx-dirty-text">
                  {switchPending.stat === null || switchPending.stat.missing
                    ? t('Uncommitted changes may block the switch; committed history is unaffected.', '未提交改动可能阻断切换；已提交历史不受影响')
                    : switchPending.stat.dirty > 0
                      ? t(`Uncommitted changes (+${switchPending.stat.dirtyAdded} −${switchPending.stat.dirtyDeleted}) will be committed first; type a message or leave empty for the default.`, `有未提交改动（+${switchPending.stat.dirtyAdded} −${switchPending.stat.dirtyDeleted}），将先提交；可输入提交信息，留空用缺省`)
                      : switchPending.stat.files === 0
                        ? t('No file differences between the branches.', '目标分支与当前无文件差异')
                        : t(`The workspace will update ${switchPending.stat.files} files (+${switchPending.stat.added} −${switchPending.stat.deleted}).`, `工作区 ${switchPending.stat.files} 个文件将被更新（+${switchPending.stat.added} −${switchPending.stat.deleted}）`)}
                </p>
                {switchPending.stat !== null && !switchPending.stat.missing && switchPending.stat.dirty > 0 && (
                  <input
                    className="sx-dirty-msg"
                    aria-label={t('Commit message', '提交信息')}
                    placeholder={t('Commit message (optional)', '提交信息（可留空）')}
                    value={switchMsg}
                    maxLength={200}
                    autoFocus
                    onChange={(e) => setSwitchMsg(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') send();
                      if (e.key === 'Escape') setSwitchPending(null);
                    }}
                  />
                )}
                <div className="sx-dirty-actions">
                  <button type="button" disabled={busy} onClick={() => setSwitchPending(null)}>
                    {t('Cancel', '取消')}
                  </button>
                  <button type="button" className="primary" disabled={busy} onClick={send}>
                    {t('Switch and send', '切换并发送')}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )}
        {/* 隔离分支被占(全局 portal):输入框空=随机新分支;重选分支=重开分支菜单 */}
        {heldBranch !== null &&
          createPortal(
            <div className="modal-overlay" onClick={() => setHeldBranch(null)}>
              <div className="modal-body sx-dirty-dialog" role="dialog" aria-label={t('Branch already checked out', '分支已被签出')} onClick={(e) => e.stopPropagation()}>
                <p className="sx-dirty-target">
                  {t('Branch already checked out', '分支已被签出')} <b>{heldBranch === '' ? '' : heldBranch}</b>
                </p>
                <p className="sx-dirty-text">
                  {t('This branch is checked out by another worktree. Pick another, or create a new one for this isolated workspace.', '该分支已被其他工作区签出。请选择其他分支，或为本次隔离工作区新建一个（输入框留空则自动命名）')}
                </p>
                <input
                  className="sx-dirty-msg"
                  aria-label={t('New branch name', '新分支名')}
                  placeholder={t('New branch name (empty = auto)', '新分支名（留空自动命名）')}
                  value={heldNew}
                  maxLength={80}
                  autoFocus
                  onChange={(e) => setHeldNew(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setHeldBranch(null);
                  }}
                />
                <div className="sx-dirty-actions">
                  <button type="button" disabled={busy} onClick={() => setHeldBranch(null)}>
                    {t('Cancel', '取消')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setHeldBranch(null);
                      setBranchOpen(true);
                    }}
                  >
                    {t('Pick another branch', '重选分支')}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
              onClick={() => {
                      const b = heldNew.trim();
                      setHeldBranch(null);
                      setSelBranch(b);
                      setTimeout(() => sendRef.current(), 0);
                    }}
                  >
                    {t('Create branch and isolate', '创建分支并隔离')}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )}
        {/* 全局弹窗(2026-11-10 用户裁定「弹窗是全局的」):portal 到 body——composer 祖先带定位上下文,
            内联 modal-overlay 的 fixed 会被困住落底部 */}
        {isoOpen &&
          createPortal(
            <div className="modal-overlay" onClick={() => setIsoOpen(false)}>
              <div className="modal-body sx-iso-dialog" role="dialog" aria-label={t('Isolated workspace', '隔离工作区')} onClick={(e) => e.stopPropagation()}>
                <p className="sx-dirty-target">{t('Isolated workspace (git worktree)', '隔离工作区（git worktree）')}</p>
                <p className="sx-dirty-text">
                  {t('Works in a dedicated branch copy; the main workspace stays clean.', '在独立分支的副本中工作，主工作区不受影响')}
                </p>
                <div className="sx-dirty-actions">
                  <button type="button" onClick={() => setIsoOpen(false)}>
                    {t('Cancel', '取消')}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      setIsolate(true);
                      setIsoOpen(false);
                    }}
                  >
                    {t('Turn on isolation', '开启隔离')}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )}
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
        {/* 输入卡 = 会话中同一份 ComposerCard(唯一差异:欢迎页在卡外多项目选择条)。
            highlight 第5参 composer=true(2026-11-06 用户实测「光标越来越多偏」根修):漏传=
            高亮层走气泡分支(无定界符/占位区,芯片 56px)而 textarea 原文=全 token(79.8px),
            每枚恒差 23.8px——层与原文位置的隔阂即「光标越来越飞,越多偏越多」 */}
        <ComposerCard
          label="welcome goal"
          inputRef={goalRef}
          images={images}
          onRemoveImage={(i) => setImages((cur) => cur.filter((_, idx) => idx !== i))}
          onImageOpen={setLightboxSrc}
          onPasteFiles={attachImages}
          highlight={renderMentionSpans(goal, (n) => pickRelRef.current.get(n) ?? filePalFiles.find((f) => pathBasename(f) === n), undefined, undefined, true)}
          onDropFile={(rel) => {
            // 与会话内同构:拖入 → @文件名短写+账本记绝对/相对路径(目录保尾斜杠)
            const bare = rel.replace(/[\\/]+$/, '');
            const isDir = bare !== rel;
            const ta = goalRef.current;
            const pos = ta?.selectionStart ?? goal.length;
            const base = bare.split(/[\\/]/).filter(Boolean).pop() ?? bare;
            pickRelRef.current.set(base, isDir ? `${bare}/` : bare);
            setGoal((prev) => prev.slice(0, pos) + `@${base} ` + prev.slice(pos));
            goalRef.current?.focus();
            requestAnimationFrame(() => {
              const g = goalRef.current;
              if (g === null) return;
              const to = Math.min(pos + base.length + 2, g.value.length);
              g.setSelectionRange(to, to);
            });
          }}
          value={goal}
          rows={Math.min(6, Math.max(1, (goal.match(/\n/g) ?? []).length + 1))}
          placeholder={t('Ask Sunshinex. Use @ to add context, / for commands or skills', '向 Sunshinex 提问，使用 @ 添加上下文，使用 / 选择命令或技能')}
          onChange={(v) => {
            setGoal(v);
            setWelcomeSlashDismissed(null); // G14.213 Esc 收起后任何编辑即重新放行 / 面板
            if (v.includes('/')) fetchWelcomeSkills(); // G14.213 惰性拉技能清单(敲 / 起手一次)
            // G14.124 面板跟随输入(光标前 @token 即开);无匹配=渲染面自然关闭
            const caret = goalRef.current?.selectionStart ?? v.length;
            const m = /@([\w./:\\-]*)$/.exec(v.slice(0, caret));
            const rt = refTokenAt(v, caret);
            if (m !== null) {
              setFilePal({ query: m[1] ?? '', from: caret - (m[1]?.length ?? 0) - 1 });
              setFilePalActive(0); // G14.2xx 查询变更即重置 active(残留箭头位回车选中邻项)
              setRefPal(null); // 面板互斥(与 Chat 同款)
              refreshFilePalFiles();
            } else if (rt !== null) {
              // $/# 引用面板触发(2026-11-05 用户裁定:欢迎页与会话页同构)——锚符号+空 query 起手
              setRefPal(rt);
              setRefActive(0);
              loadRefEntries();
            } else {
              if (filePal !== null) setFilePal(null);
              if (refPal !== null) setRefPal(null);
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
              setRefPal(null); // 面板互斥
              refreshFilePalFiles();
            } else if (filePal !== null) {
              setFilePal(null);
            }
            // $/# 引用面板键分支(2026-11-05;先于 @/命令面板——同 Chat 链序):↑↓ 单域循环、
            // Esc 收、Enter 插 `$id `/`#id ` 尾随空格并钉光标;锚符号已被改写=面板不拦键
            const effRefTok = refTokenAt(goal, caret);
            const effRefPal = effRefTok ?? refPal;
            if (effRefPal !== null && (effRefTok !== null || goal[effRefPal.from] === effRefPal.sym)) {
              const refItems = flatRefItems(refEntries, effRefPal.query, effRefPal.sym);
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (refItems.length > 0) {
                  setRefActive((a) => (e.key === 'ArrowDown' ? (a + 1) % refItems.length : (a - 1 + refItems.length) % refItems.length));
                }
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setRefPal(null);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && refItems.length > 0) {
                e.preventDefault();
                const item = refItems[Math.min(refActive, refItems.length - 1)];
                setGoal((prev) => prev.slice(0, effRefPal.from) + `${item.sym}${item.id} ` + prev.slice(Math.max(effRefPal.from + 1 + effRefPal.query.length, effRefPal.from)));
                setRefPal(null);
                requestAnimationFrame(() => {
                  const g = goalRef.current;
                  if (g === null) return;
                  const to = Math.min(effRefPal.from + item.id.length + 2, g.value.length);
                  g.setSelectionRange(to, to);
                });
                return;
              }
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
            // G14.213 欢迎页 / 命令+技能面板(与会话内同构):行首 /token → 命令+技能,行中 → 仅
            // 技能池(2026-11-05 用户二次裁定);↑↓ 选择、Enter/Tab 补全 `/cmd `(执行发生在会话
            // 建立后:pendingGoal 经 submitText 命令门控),Esc 本次收起;无匹配=面板不开
            const slashTok = slashTokenAt(goal, caret);
            const slashItems = slashItemsAt(goal, caret); // 与渲染期 welcomeSlashItems 同派生单点
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
            // $/# 引用面板链首(2026-11-05;与 Chat 同构互斥:在场时 @/+/命令面板一律不渲染)
            refPal !== null && goal[refPal.from] === refPal.sym ? (
              (() => {
                const items = flatRefItems(refEntries, refPal.query, refPal.sym);
                const emptyHint =
                  refEntries.agents.length === 0 && refEntries.teams.length === 0
                    ? t(
                        'No registered sub-agents or teams yet — create them in Settings → Agents / Agent Teams, then reference here with $ or #',
                        '尚无在册子智能体/团队 — 在 设置 → 智能体 / 智能体团队 创建后，即可在此 $ 引用 / # 拉队',
                      )
                    : t('No matching entry', '无匹配条目');
                return (
                  <RefPalette
                          items={items}
                    emptyHint={emptyHint}
                    active={Math.max(0, Math.min(refActive, items.length - 1))}
                    onHover={setRefActive}
                    onPick={(item) => {
                      const from = refPal.from;
                      const end = from + 1 + refPal.query.length;
                      setGoal((prev) => prev.slice(0, from) + `${item.sym}${item.id} ` + prev.slice(Math.max(end, from)));
                      setRefPal(null);
                      goalRef.current?.focus();
                      requestAnimationFrame(() => {
                        const g = goalRef.current;
                        if (g === null) return;
                        const to = Math.min(from + item.id.length + 2, g.value.length);
                        g.setSelectionRange(to, to);
                      });
                    }}
                  />
                );
              })()
            ) : // G14.121 @ 文件面板优先(命中才渲染;点击行=插入绝对路径,面板收起);
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
                data-tip={t('Add context', '添加上下文')}
                onClick={() => setPlusOpen((v) => !v)}
              >
                <PlusAddIcon size={16} />
              </button>
              {/* 审批模式:弹层锚按钮正上方(pill-anchor) */}
              <div className="pill-anchor">
                <button
                  type="button"
                  className={'composer-pill' + (mode === 'full-access' ? ' mode-pill-warn' : '')}
                  aria-label="approval mode"
                  aria-expanded={modeOpen}
                  // D51 G-4:窄栏塌缩(sx-main-narrow)时 tooltip 承载当前模式名——与会话内 pill 同构
                  data-tip={sessionModeLabel(mode)}
                  onClick={() => setModeOpen((v) => !v)}
                >
                  {/* G14.133 分档图标与菜单同源(ModeIcon)——静态 Hand 两套渲染退役;
                      标签/箭头走 pill-label/pill-chevron 类:pills-tight 实测塌缩按类收,
                      裸文本无类收不到(600 窗欢迎页「完全访问」不塌的根因),文案由 data-tip 承载 */}
                  <ModeIcon mode={mode} />
                  <span className="pill-label">{sessionModeLabel(mode)}</span>
                  <ChevronDown className="pill-chevron" size={14} strokeWidth={1.75} aria-hidden="true" />
                </button>
                {modeOpen && (
                  <ModeMenu
                    mode={mode}
                    ariaLabel="approval mode menu"
                    onPick={(m) => {
                      setMode(m);
                      setModeOpen(false);
                    }}
                  />
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
                data-tip={selModel ?? defaultModel ?? modelChoices[0]?.id ?? undefined}
                onClick={() => setModelOpen((v) => !v)}
              >
                {/* 2026-10-29 用户裁定:默认兜底显示当前(首个)provider 的第一个 model——不再笼统「默认模型」 */}
                {baseModelName(selModel ?? defaultModel ?? modelChoices[0]?.id)}
                <EffortChip effort={selEffort ?? 'medium'} />
                <ChevronDown className="pill-chevron" size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
              {modelOpen && (
                <WelcomeModelMenu
                  choices={modelChoices}
                  current={selModel ?? defaultModel}
                  effort={selEffort ?? 'medium'}
                  onPick={(id, e) => {
                    setSelModel(id);
                    if (e !== undefined) setSelEffort(e);
                  }}
                  onEffort={setSelEffort}
                />
              )}
              </div>
              <button
                type="button"
                className="send"
                aria-label="send"
                data-tip={`${t('Send', '发送')} · Enter`}
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
