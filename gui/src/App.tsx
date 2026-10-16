import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseLanguage, setLanguage, t } from './i18n';
import { GitBranch, ArrowUp, ChevronDown, GitCompare, MessageCircle, Folder, ListTodo, ShieldCheck, SquareTerminal, Unlock } from 'lucide-react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, MutableRefObject, ReactNode } from 'react';
import { createConnection } from './connection';
import { splitMentionTokens } from './pages/Chat';
import type { Connection, ConnectionState, SnapshotResponse } from './connection';
import type { TodoItem } from '../../src/types';
import { DirPicker } from './pages/DirPicker';
import { applyBoardEvent, applyDelegation, boardEventFrom, emptyBoard } from './projection';
import type { TaskBoardState, Delegation } from './projection';
import { Chat, FilePalette, ModeIcon, baseModelName, expandFileRefs, fileHit, renderMentionSpans } from './pages/Chat';
import type { ChatSink } from './pages/Chat';
import { ComposerCard } from './composer/ComposerCard';
import { EffortChip, EffortSlider } from './effort-slider';
import { ComposerPlusPanel } from './composer/ComposerPlusPanel';
import { ProjectMenu } from './sidebar/ProjectMenu';
import { SettingsShell } from './settings/SettingsShell';
import { TabStrip } from './tabs/TabStrip';
import { tabEntry, registryProbe } from './tabs/registry';
import type { TabServices } from './tabs/registry';
import { ensureSession, openTab, closeTab, setActive, cycleTab, reorderTab, setCollapsed, setWidth, emptyTabSession } from './tabs/tab-state';
import type { TabStates, TabTypeId, TabParams } from './tabs/tab-state';
import { applyAgentEvent } from './tabs/agent-activity';
import type { AgentActivities } from './tabs/agent-activity';
import type { SessionEvent } from '../../src/types';
import { pickWorkspaceFolder } from './ui-util';
import { FolderAddIcon } from './sidebar/ProjectMenu';

/**
 * G8a 三栏壳(G3.5 路由壳重组,spec §1):左栏 ProjectMenu(Home 全页退役,职能内化——工作区
 * 分组/attach/组内新建/添加工作区;连接态点随左栏底栏,brand/topbar 退役)+ 中栏 Chat 恒挂
 * (page 'welcome'|'chat',无会话=欢迎空态;仍 key={sessionId} 会话隔离)+ 右栏会话标签页
 * (TabStrip + tabEntry 渲染;tabStates 每会话独立,openSession 经 ensureSession 缺省开
 * 「任务」单例页)。token 门面(G3 平移)与连接装配(会话维)原样:token 在场才建连接(单连
 * 接生命周期,token 变更=重装配)。
 * 连接装配(会话维):onEvent(sessionId, e, seq) 单 WS 收全会话帧,sessionRef 判据过滤他会话
 * (本会话帧经 chatSinkRef 转投 Chat——连接回调闭包装配时固定,Chat 装配期注册 sink);板/委派
 * 投影随事件维稳(重连=onReset 清零+daemon 全量补发帧重建,任务标签消费)。
 * Chat(T4δ)以 key={sessionId} 挂载:对话面本地态(reducer 投影/输入/播种门/竞态缓冲)随组件
 * 销毁——两会话先后打开各自投影独立,无跨会话串扰,不断连重连。onReset(首连与重连同路径)
 * → Chat.reset 本会话重播种(重连=重置投影+全量重放裁定)。G4 挂起面:onApproval/onAsk/
 * onResetSession 三回调同 pattern——sessionRef 过滤本会话后经 chatSinkRef 转投 Chat 卡片区。
 * G5 板投影(App 态,任务标签经 services 消费):board/delegations + team(经 Chat onSeeded
 * 回调自快照回填——事件流无 teammate 面,reseed 即更新;快照本就携带 board/delegations,一并
 * 回填:开 s2 即见 s2 快照板而非 s1 残留——会话切换串态根除;openSession/backHome 亦清板投影
 * 双保险,重开经快照重建权威态)。gate 审批 onReview → conn.boardReview(sessionId, taskId,
 * approved)。G6 板投影 seq 门(G5 交接 b 根修):Chat 播种窗内到达的 board/delegation 帧若直
 * 投投影,会被 onSeeded 的快照整替清掉(丢一帧增量——快照在途与事件流的窄竞态)。与 Chat
 * pendingRef 同构:seeding 期帧入 boardPendingRef;onSeeded 落定后整替快照板再按 seq 过滤重放
 * (≤ snap.lastSeq 丢——快照已含,再投即双应用;> 逐帧 apply)。窗起讫:openSession/
 * onReset/onResetSession 起(均致 Chat reseed),onSeeded 止;种子失败窗悬挂至下次重置
 * (帧持续缓冲不投,与 Chat「无基线不乱投」语义对齐)。
 * onResetSession(G3.5 交接 d 收口):会话维 reset 除 Chat 重播种外,board/delegations 投影
 * 亦清(此前仅连接级 onReset 清——会话 reset 后板投影悬挂旧任务)。
 * G8a 标签态:tabStates 每会话独立留存(backHome 不清——重开同会话标签还原,spec §1「每会话
 * 独立」);G8d 起 Chat write 工具 path 钮主通道 onOpenDiff → openTabInSession('diff',
 * {callId,path})(by callId 判重多实例);onOpenFile 保留为无 callId 面(种子条)的回退(file
 * 标签仍可从目录/+菜单开);右栏 collapsed 只余折叠钮,拖宽边条 clamp 200..720(右栏在右,
 * 向左拖=变宽)。
 * token 门面(G3 平移):URL ?token= 优先(回写 localStorage 持久)→ localStorage。
 */

interface ImportMetaEnv {
  readonly VITE_SERVE_URL?: string;
}
declare global {
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

/** 判重/单例探针(tab-state 真实现,TAB_REGISTRY 装配;模块级单例——零态闭包可安全共享) */
const PROBE = registryProbe();

/** G12 左栏宽度档:clamp 与持久化键(拖拽手柄在 .sx-menu-resizer;宽度经 --menu-w 落 .sx-menu) */
const MENU_WIDTH_MIN = 220;
const MENU_WIDTH_MAX = 420;
const MENU_WIDTH_DEFAULT = 260;
const MENU_WIDTH_KEY = 'sunshinex.menuWidth';

export function App(): JSX.Element {
  // G10:token 填写逻辑退役——本地 serve 免鉴权档(恒绑回环),连接不再携带凭证
  return <AppShell />;
}

/** 思考强度档位(G14.10):滑动块 0..5 与档位一一对应(daemon effort 白名单序) */
/** 欢迎页 goal 接力态:welcome 输入的目标,openSession 后由 Chat 播种完成时提交 */
interface WelcomeGoal {
  root: string;
  goal: string;
}

/** 欢迎页 composer(Codex home 形,G10 用户裁定二轮):
 *  构图=logo+大标题居中偏上,composer 簇贴底;Choose project 独立圆角条嵌在输入卡上沿之后
 *  (卡盖住条下沿,Codex 叠卡形),点击弹层向上浮出(overlay 不推布局):已注册项目可点选 +
 *  「浏览文件夹…」走原生风格 DirPicker 建新项目;footer 左右分列(+审批 左/模型+圆发送 右) */
function WelcomeComposer({
  conn,
  presetRoot,
  presetMode,
  onOpened,
}: {
  conn: {
    dirpicker(path?: string): Promise<{ path: string; parent: string; dirs: string[] }>;
    workspaces(): Promise<Array<{ slug: string; root?: string; sessionCount: number }>>;
    newSession(root: string, mode?: 'manual'): Promise<{ sessionId: string }>;
    /** 建项目(G10-C11):原生选择器确认后注册/创建工作区 */
    createWorkspace(body: { name?: string; path?: string }): Promise<{ ok: true; root: string; slug: string }>;
    /** G14.194 原生选择标记定位(daemon 全盘找标记回绝对路径) */
    locateWorkspace(body: { token: string; roots?: string[] }): Promise<{ path: string | null }>;
    /** G14.113 分支清单/切换(欢迎页分支选择;实现体见 createConnection) */
    gitBranches(root: string): Promise<{ current: string; branches: string[] }>;
    gitCheckout(root: string, branch: string): Promise<void>;
    /** + 附加面板数据源(G12 三轮;文件区需会话——欢迎页不传 sessionId 不渲染) */
    commands(): Promise<{ commands: string[]; descriptions: Record<string, string>; supported: string[] }>;
    skillsGroups(root?: string): Promise<{
      groups: Array<{ source: string; skills: Array<{ id: string; name?: string; description?: string }> }>;
    }>;
    tree(sessionId: string, path?: string): Promise<{ entries: Array<{ name: string; kind: 'dir' | 'file' }>; truncated?: boolean }>;
    /** 缺省模型名回显(G13 反馈轮):settings model 键——欢迎页 pill 显示具体模型而非静态「default model」 */
    settings(root?: string): Promise<{
      keys: Array<{ key: string; value: string | null }>;
      providers: { choices: Array<{ id: string; model: string; effort?: string }> };
    }>;
    /** G14.121 工作区文件索引(@ 文件面板;posix 相对路径+mtime 倒序=最近改动优先) */
    workspaceFiles(root: string): Promise<{ files: Array<{ path: string; mtime: number }> }>;
    setSessionModel(id: string, model?: string): Promise<void>;
    setSessionEffort(id: string, effort?: string): Promise<void>;
    /** G14.113 分支清单/切换(欢迎页分支选择弹窗;非 git 目录 branches 空) */
    gitBranches(root: string): Promise<{ current: string; branches: string[] }>;
    gitCheckout(root: string, branch: string): Promise<void>;
  };
  /** 预选工作区(G10-C16):项目行「+」带来的 preset */
  presetRoot?: string;
  /** 预选审批模式(G10-C16):项目行 + 的 manual 档带出 */
  presetMode?: 'manual';
  onOpened: (sessionId: string, root: string, goal: string) => void;
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
  /** 审批模式(G10-C16):新会话创建时带出;缺省 dontAsk(TUI 默认权限) */
  const [mode, setMode] = useState<'dontAsk' | 'manual' | 'plan'>('dontAsk');
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
  const goalRef = useRef<HTMLTextAreaElement | null>(null);
  /** G14.126 @文件名 记账:选中面板行时 basename → 相对路径(发送期展开解析) */
  const pickRelRef = useRef(new Map<string, string>());

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

  // G14.127 索引预热:选中工作区即拉清单(手打 @根目录文件 的发送期解析不依赖面板开过)
  useEffect(() => {
    if (picked === '') return;
    void conn
      .workspaceFiles?.(picked)
      ?.then((r) => setFilePalFiles(r.files.map((f) => f.path)), () => undefined);
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
        // 'default'(daemon createSession 同规则解析)。default 行置顶。
        const baseOf = (root: string): string => root.split(/[\\/]+/).filter(Boolean).pop() ?? '';
        // G14.34 去重:default 与 sunshinex-default*(含旧临时锚点的带尾哈希变体)同义——
        // 全部坍缩为唯一「默认工作区」项(root 取现存锚点行;全无则回落字面 'default')
        const isDefaultNm = (nm: string): boolean => nm === 'default' || nm.startsWith('sunshinex-default');
        const anchorRow =
          usable.find((r) => r.root !== undefined && baseOf(r.root) === 'sunshinex-default') ??
          usable.find((r) => isDefaultNm(baseOf(r.root ?? r.slug)));
        const deduped = usable.filter((r) => !isDefaultNm(baseOf(r.root ?? r.slug)));
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
      return filePalFiles.find((f) => (f.split('/').pop() ?? f) === name);
    }).trim();
    if (g === '' || target === '' || busy) return;
    setBusy(true);
    setError('');
    conn
      .newSession(target, mode === 'manual' ? 'manual' : undefined)
      .then(({ sessionId }) => {
        // G14.10:欢迎页选定的模型/思考强度随会话创建下发(会话未建前无 /session/:id 面)
        if (selModel !== undefined) void conn.setSessionModel(sessionId, selModel).catch(() => undefined);
        if (selEffort !== undefined) void conn.setSessionEffort(sessionId, selEffort).catch(() => undefined);
        onOpened(sessionId, target, g);
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      });
  };
  const baseName = (p: string): string => p.split(/[\\/]+/).filter(Boolean).pop() || p;
  /** G14.34:默认锚点统一显示「默认工作区」(default/sunshinex-default*带尾哈希变体同义) */
  const isDefaultPicked = picked !== '' && (() => {
    const nm = baseName(picked);
    return nm === 'default' || nm.startsWith('sunshinex-default');
  })();
  const projName = picked === '' ? t('Choose project', '选择项目') : isDefaultPicked ? t('Default workspace', '默认工作区') : baseName(picked);
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
    const shell = (window as unknown as { sunshinex?: { pickFolder?: () => Promise<string | null> } }).sunshinex;
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
  return (
    <div className="sx-welcome sx-welcome-home" aria-label="welcome">
      <div className="welcome-hero">
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
          highlight={renderMentionSpans(goal)}
          value={goal}
          rows={Math.min(6, Math.max(1, (goal.match(/\n/g) ?? []).length + 1))}
          placeholder={t('Describe the goal and press Enter…', '描述目标,回车开始…')}
          onChange={(v) => {
            setGoal(v);
            // G14.124 面板跟随输入(光标前 @token 即开);无匹配=渲染面自然关闭
            const caret = goalRef.current?.selectionStart ?? v.length;
            const m = /@([\w./:\\-]*)$/.exec(v.slice(0, caret));
            if (m !== null) {
              setFilePal({ query: m[1] ?? '', from: caret - (m[1]?.length ?? 0) - 1 });
              if (picked !== '') {
                void conn.workspaceFiles(picked).then((r) => setFilePalFiles(r.files.map((f) => f.path)), () => setFilePalFiles([]));
              }
            } else if (filePal !== null) {
              setFilePal(null);
            }
          }}
          onKeyDown={(e) => {
            // G14.121 @ 文件面板(与会话内同构):任意位置 @token → 最近改动文件清单;
            // 选中插入 @相对路径(发送期统一展开为 md 绝对链接);面板开时 Enter/↑↓ 归面板
            const taEl = e.currentTarget as HTMLTextAreaElement;
            const caret = taEl.selectionStart ?? goal.length;
            const atMatch = /@([\w./:\\-]*)$/.exec(goal.slice(0, caret));
            if (atMatch !== null) {
              setFilePal({ query: atMatch[1] ?? '', from: caret - (atMatch[1]?.length ?? 0) - 1 });
              if (picked !== '') {
                void conn.workspaceFiles(picked).then((r) => setFilePalFiles(r.files.map((f) => f.path)), () => setFilePalFiles([]));
              }
            } else if (filePal !== null) {
              setFilePal(null);
            }
            const items = picked === '' ? [] : filePalFiles.filter((f) => fileHit(f, filePal?.query ?? '')).slice(0, 12);
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
                // G14.126 选中只插短写 @文件名(显形=图标+文件名),相对路径记账供发送期展开
                const base = rel.split('/').pop() ?? rel;
                pickRelRef.current.set(base, rel);
                const atFrom = filePal.from;
                const atEnd = atFrom + 1 + filePal.query.length;
                setGoal((prev) => prev.slice(0, atFrom) + `@${base} ` + prev.slice(Math.max(atEnd, atFrom)));
                setFilePal(null);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          overlays={
            // G14.121 @ 文件面板优先(命中才渲染;点击行=插入绝对路径,面板收起)
            filePal !== null && picked !== '' && filePalFiles.some((f) => fileHit(f, filePal.query)) ? (
              <FilePalette
                items={filePalFiles.filter((f) => fileHit(f, filePal.query)).slice(0, 12)}
                active={Math.min(filePalActive, 11)}
                onHover={setFilePalActive}
                onPick={(p) => {
                  // G14.126 选中只插短写 @文件名,相对路径记账供发送期展开
                  const base = p.split('/').pop() ?? p;
                  pickRelRef.current.set(base, p);
                  const atFrom = filePal.from;
                  const atEnd = atFrom + 1 + filePal.query.length;
                  setGoal((prev) => prev.slice(0, atFrom) + `@${base} ` + prev.slice(Math.max(atEnd, atFrom)));
                  setFilePal(null);
                }}
              />
            ) : plusOpen ? (
              <ComposerPlusPanel
                conn={conn}
                root={picked !== '' ? picked : undefined}
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
                title={t('Add skills, commands or files', '添加技能、命令或文件')}
                onClick={() => setPlusOpen((v) => !v)}
              >
                +
              </button>
              {/* 审批模式:弹层锚按钮正上方(pill-anchor) */}
              <div className="pill-anchor">
                <button
                  type="button"
                  className="composer-pill"
                  aria-label="approval mode"
                  aria-expanded={modeOpen}
                  title={t('Approval mode for this session', '本会话的审批模式')}
                  onClick={() => setModeOpen((v) => !v)}
                >
                  {/* G14.133 分档图标与菜单同源(ModeIcon)——静态 Hand 两套渲染退役 */}
                  <ModeIcon mode={mode} />
                  {mode === 'manual' ? t('Confirm changes', '变更确认') : mode === 'plan' ? t('Plan mode', '计划模式') : t('Full access', '完全访问')}
                  <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
                {modeOpen && (
                  <div className="sx-menu-pop pill-pop mode-pop" role="menu" aria-label="approval mode menu">
                    {/* G14.113 与会话内 mode-pop 同构:Plan 首位+横线+两执行档;图标+双行(名称+解释) */}
                    {([
                      { m: 'plan' as const, label: t('Plan mode', '计划模式'), desc: t('Plan first — no changes until you approve', '先规划方案,经你确认后才执行'), icon: <ListTodo size={15} strokeWidth={1.75} aria-hidden="true" /> },
                      { m: 'dontAsk' as const, label: t('Full access', '完全访问'), desc: t('Full permissions — no confirmation prompts', '完全权限,操作不再逐一确认'), icon: <Unlock size={15} strokeWidth={1.75} aria-hidden="true" /> },
                      { m: 'manual' as const, label: t('Confirm changes', '变更确认'), desc: t('Writes and commands ask first', '写入与命令需逐一确认'), icon: <ShieldCheck size={15} strokeWidth={1.75} aria-hidden="true" /> },
                    ]).map((row, idx) => (
                      <div key={row.m} className="mode-pop-group">
                        {idx === 1 && <div className="mode-pop-sep" />}
                        <button
                          type="button"
                          role="menuitem"
                          className={`mode-item${mode === row.m ? ' active' : ''}`}
                          onClick={() => {
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
                className="composer-pill"
                aria-label="model"
                aria-expanded={modelOpen}
                title={selModel ?? defaultModel ?? undefined}
                onClick={() => setModelOpen((v) => !v)}
              >
                {baseModelName(selModel ?? defaultModel)}
                {selEffort !== undefined && <EffortChip effort={selEffort} />}
                <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
              {modelOpen && (
                <div className="sx-menu-pop pill-pop pill-pop-right" role="menu" aria-label="model menu">
                  {modelChoices.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="menuitem"
                      className={`sx-menuitem${(selModel ?? defaultModel) !== undefined && c.id === (selModel ?? defaultModel) ? ' active' : ''}`}
                      title={c.id}
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
                title={t('Send', '发送')}
                disabled={busy || goal.trim() === '' || picked === ''}
                onClick={send}
              >
                <ArrowUp size={16} strokeWidth={2.25} aria-hidden="true" />
              </button>
            </>
          }
        />
      </div>
    </div>
  );
}

/** 应用壳:单连接装配 + 三栏路由(左 ProjectMenu|中 Chat 恒挂|右标签栏);welcome = 无会话空态 */
function AppShell(): JSX.Element {
  /** 欢迎页 goal 接力(G10):welcome 提交建会话后,Chat 播种完成即提交该目标 */
  const [welcomeGoal, setWelcomeGoal] = useState<WelcomeGoal | null>(null);
  const [page, setPage] = useState<'welcome' | 'chat'>('welcome');
  /** 欢迎页预选工作区(G10-C16):New chat=空(自选);项目行「+」=该项目(快捷预选) */
  const [composePresetRoot, setComposePresetRoot] = useState<string | null>(null);
  const [openSessionId, setOpenSessionId] = useState<string>('');
  /** 当前会话所属工作区 root(ProjectMenu activeRoot 组自动展开的判据;'' = 无) */
  const [openRoot, setOpenRoot] = useState<string>('');
  /** G14.16 标题统一流联动:rename 落盘后 bump → ProjectMenu 重拉 recentSessions(侧栏即时同名) */
  const [recentVersion, setRecentVersion] = useState(0);
  /** G14.52 活动会话运行态(GUI 本地权威):model-start 置位,done/error 复位——侧栏运行圆点消费 */
  const [runActive, setRunActive] = useState(false);
  /** G8a 标签态总表:每会话独立(backHome 保留——重开同会话标签还原,spec §1) */
  const [tabStates, setTabStates] = useState<TabStates>({});
  const [connState, setConnState] = useState<ConnectionState>('connecting');
  const [board, setBoard] = useState<TaskBoardState>(emptyBoard);
  /** G14.137 会话待办(todo_write 上抛):任务标签「会话待办」区数据源;会话切换清零(与板同纪律) */
  const [sessionTodos, setSessionTodos] = useState<TodoItem[]>([]);
  const [delegations, setDelegations] = useState<Delegation[]>([]);
  /** G5 teammate 投影(App 态):snapshot.team 经 Chat onSeeded 回填——reseed 即更新 */
  const [team, setTeam] = useState<Array<{ name: string; busy: boolean }>>([]);
  /** 会话级操作(fork/rewind)失败提示:sx-toast 底部浮出 3s 自隐(设置页同形态)——旁路失败此前零反馈,
   *  用户点「分叉/回到此轮」无响应会误以为成功 */
  const [opError, setOpError] = useState('');
  const opErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showOpError = (err: unknown): void => {
    setOpError(err instanceof Error ? err.message : String(err));
    if (opErrorTimer.current !== null) clearTimeout(opErrorTimer.current);
    opErrorTimer.current = setTimeout(() => setOpError(''), 3_000);
  };
  /** G8d 子代理活动聚合(App 态):payload.subagent 标签流经 applyAgentEvent 归约——Agents 标签
   *  只读消费(services.agentActivities);delegation 起止 label 命中既有卡时改状态(权威终语) */
  const [agentActivities, setAgentActivities] = useState<AgentActivities>({});
  /** G14.174 待办批次/关联轮次输入(Chat 从转录重建上抛)——待办/任务板页签数据面 */
  const [todoBatches, setTodoBatches] = useState<import('./pages/Chat').TodoBatch[]>([]);
  const [turnGoal, setTurnGoal] = useState('');
  /** G14.176 create_task 行点开的定位信号(任务板滚动高亮对应卡) */
  const [taskFocus, setTaskFocus] = useState<{ ref: string; nonce: number } | null>(null);
  const connRef = useRef<Connection | null>(null);
  /** 连接实例态:effect 装配后落位(左栏/中栏/标签体消费;null = 装配中占位) */
  const [connInstance, setConnInstance] = useState<Connection | null>(null);
  /** 事件分发判据:连接回调闭包在装配时固定,会话切换经 ref 免闭包陈旧 */
  const sessionRef = useRef<string>('');
  sessionRef.current = openSessionId;
  /** Chat 事件转投面:Chat 装配期注册(卸载注销)——onEvent/onReset 经此投递 */
  const chatSinkRef = useRef<ChatSink | null>(null);
  /** G14.29 辅助会话 sink 表(sideId → sink ref):连接帧按键路由到旁路 Chat(板/委派/子代理不聚) */
  const sideSinksRef = useRef<Map<string, MutableRefObject<ChatSink | null>>>(new Map());
  /** G6 板投影 seq 门:播种窗(快照在途)内 board/delegation 帧缓冲(与 Chat pendingRef 同构
   *  {seq, e}[])——onSeeded 整替快照板后过滤重放;窗由 Chat reseed 生命周期驱动 */
  const boardPendingRef = useRef<Array<{ e: SessionEvent; seq: number }>>([]);
  /** 板播种窗开关:true = 快照在途(帧入缓冲不直投);onSeeded 落定置 false */
  const boardSeedingRef = useRef(true);
  /** 拖宽在途清理句柄:mouseup 解绑外,卸载兜底解绑(会话切走/组件卸毁不泄漏 window 监听) */
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  /** G8b pty 记账:terminal 标签 uid → ptyId(TerminalTab onPtyAllocated 落账;关标签 →
   *  killPty 寻址。切标签/会话不清——pty 生命周期属标签不属渲染,backHome 亦不 kill) */
  const ptyIdsRef = useRef(new Map<string, string>());
  /** G8c-T8 设置态:settingsOpen=true 时三栏内容整体切换(SettingsShell 占左+主栏,右标签栏
   *  不渲染,Chat 卸载——返回重播种,与 backHome 同语义可接受);settingsRoot=设置面隐式项目
   *  上下文(开设置时快照 openRoot,无则 ''=仅全局;无顶部切换面——项目区分下沉到配置项徽标,
   *  项目级行以此为写回锚) */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRoot, setSettingsRoot] = useState('');
  /** G12 左栏宽度可调:拖右缘边条改 --menu-w(clamp 220..420),localStorage 持久;SettingsShell
   *  的左栏同为 .sx-menu,随同一变量联动 */
  const [menuWidth, setMenuWidth] = useState<number>(() => {
    const raw = Number(localStorage.getItem(MENU_WIDTH_KEY));
    return Number.isFinite(raw) && raw >= MENU_WIDTH_MIN && raw <= MENU_WIDTH_MAX ? raw : MENU_WIDTH_DEFAULT;
  });
  /** 左栏拖宽在途清理句柄(mouseup 解绑;卸载兜底) */
  const menuResizeCleanupRef = useRef<(() => void) | null>(null);

  /** 播种窗重开(清缓冲):openSession/onReset/onResetSession 三处——均伴随 Chat reseed,
   *  窗内残留帧属旧基线/旧板,弃 */
  const reopenBoardSeedWindow = (): void => {
    boardPendingRef.current = [];
    boardSeedingRef.current = true;
  };

  useEffect(() => {
    const conn = createConnection({
      baseUrl: import.meta.env.VITE_SERVE_URL ?? location.origin,
      onEvent: (sessionId, e: SessionEvent, seq: number) => {
        if (e.type === 'model-start' || e.type === 'done') setRecentVersion((v) => v + 1); // G14.52:run 起跑/收束都刷侧栏(运行圆点亮起与熄灭跟手)
        if (sessionId === sessionRef.current && (e.type === 'model-start' || e.type === 'done' || e.type === 'error')) {
          setRunActive(e.type === 'model-start'); // G14.52:活动会话运行态本地权威(daemon 标注有清锁竞态,收束圆点以此熄灭)
        }
        if (sessionId !== sessionRef.current) {
          // G14.29 辅助会话帧:只投旁路聊天流(板/委派/子代理投影不涉旁路,丢弃)
          if (typeof e.payload?.subagent !== 'string') sideSinksRef.current.get(sessionId)?.current?.on(e, seq);
          return;
        }
        if (e.type.startsWith('task-') || e.type.startsWith('gate-')) {
          // G6 seq 门:播种窗内缓冲(onSeeded 后过滤重放),窗外直投
          if (boardSeedingRef.current) boardPendingRef.current.push({ e, seq });
          else setBoard((b) => applyBoardEvent(b, boardEventFrom(e)));
          return;
        }
        if (e.type.startsWith('delegation-')) {
          if (boardSeedingRef.current) boardPendingRef.current.push({ e, seq });
          else {
            setDelegations((d) => applyDelegation(d, e));
            // G8d:delegation 起止无 subagent 标签——payload.label 命中既有卡才改状态(Runner 权威
            // 终语:ended failed → error·done → done;未建卡原引用返回,React 同引用即免重渲染)
            setAgentActivities((a) => applyAgentEvent(a, e));
          }
        }
        if (typeof e.payload?.subagent === 'string') {
          // G8d 子代理事件另轨(Agents 标签聚合):不投 chat——chat reducer 入口另有同判过滤兜底
          // (种子重放等路径仍过 reducer,零害保留);建卡/行化/水位在此单点归约
          setAgentActivities((a) => applyAgentEvent(a, e));
          return;
        }
        chatSinkRef.current?.on(e, seq);
      },
      onReset: () => {
        // 重连/首连同路径:板/委派投影清零 + 播种窗重开(随补发帧经 onSeeded 过滤重放;Chat 投影
        // 由 sink.reset 清+本会话重播种;welcome 无 sink 时帧被会话过滤,窗恒空悬挂至下次 openSession)
        reopenBoardSeedWindow();
        setBoard(emptyBoard());
        setTodoBatches([]);
        setTurnGoal('');
      setSessionTodos([]);
        setDelegations([]);
        setAgentActivities({}); // G8d:子代理聚合清零(重连补发帧重建——连接层 seq 过滤防双应用)
        chatSinkRef.current?.reset();
      },
      // G4 挂起面装配:连接层回调闭包固定,经 sessionRef 过滤本会话后转投 Chat sink(卡片区);
      //  他会话挂起卡不显(本会话外无渲染面),他会话 reset 不触发重播种
      onApproval: (sessionId, pid, req) => {
        if (sessionId !== sessionRef.current) {
          sideSinksRef.current.get(sessionId)?.current?.onApproval(pid, req);
          return;
        }
        chatSinkRef.current?.onApproval(pid, req);
      },
      onAsk: (sessionId, pid, req) => {
        if (sessionId !== sessionRef.current) {
          sideSinksRef.current.get(sessionId)?.current?.onAsk(pid, req);
          return;
        }
        chatSinkRef.current?.onAsk(pid, req);
      },
      onResetSession: (sessionId) => {
        if (sessionId !== sessionRef.current) {
          sideSinksRef.current.get(sessionId)?.current?.resetSession();
          return;
        }
        // G3.5 交接 d 收口(G5):会话维 reset 清 board/delegations 投影(仅连接级 onReset 清的缺口
        //  ——会话 reset 后旧任务悬挂)+ 播种窗重开清缓冲(窗内帧属旧板,弃);Chat 卡区清+重播种经 sink
        reopenBoardSeedWindow();
        setBoard(emptyBoard());
        setTodoBatches([]);
        setTurnGoal('');
        setDelegations([]);
        setAgentActivities({}); // G8d:会话维 reset 子代理聚合同清(swap 新 Harness,旧卡作废)
        chatSinkRef.current?.resetSession();
      },
      onStateChange: setConnState,
    });
    connRef.current = conn;
    setConnInstance(conn);
    return () => {
      connRef.current = null;
      setConnInstance(null);
      conn.close();
    };
  }, []);

  /** 拖宽在途兜底解绑(会话切走/壳卸毁时 window 监听不泄漏) */
  /** G14.104 语言切换重渲染触发(t 为模块级非响应式) */
  const [langTick, setLangTick] = useState(0);
  const renderHighlightSpans = (text: string): ReactNode =>
    splitMentionTokens(text).map((t, i) =>
      t.kind === 'plain' ? <span key={i}>{t.text}</span> : <span key={i} className={`hn hn-${t.kind}`}>{t.text}</span>,
    );
  /** GUI chrome 双语(G10-C3c):语言源 = daemon settings language 键,连接装配即同步 */
  useEffect(() => {
    if (connInstance === null) return;
    connInstance.settings().then(
      (view) => {
        const raw = view.keys.find((k) => k.key === 'language')?.value ?? undefined;
        if (raw !== undefined) setLanguage(parseLanguage(raw)); // 未设置不覆盖(缺省 zh 由 i18n 模块承载;测试钉 en 由 setup 承载)
        setLangTick((v) => v + 1); // G14.104 语言是模块级非响应式——补一次重渲染,静止页面即时翻语言
      },
      () => {},
    );
  }, [connInstance]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);
  /** 左栏拖宽在途兜底解绑(壳卸毁时 window 监听不泄漏) */
  useEffect(() => () => menuResizeCleanupRef.current?.(), []);

  /** 左栏选中会话(attach/新建完成):切路由(Chat 装配期自播种基线)+ ensureSession 建席
   *  (缺省「任务」页)+ 板投影/team 清零(会话切换串态防线——快照落定后经 onSeeded 重建
   *  权威态)+ 播种窗重开;tabStates 已有该会话则原样(重开同会话标签还原) */
  /** G14.29 辅助对话:fork 主会话整档(side 标记,列表滤除)→ 右栏 sidechat 标签绑定旁路会话。
   *  帧路由经 sideSinksRef(onEvent 同键转投);卡点与 /btw /side 输入拦截同汇本口 */
  const startSideChat = (insert?: string): void => {
    const conn = connRef.current;
    if (conn === null || openSessionId === '') return;
    void (async () => {
      try {
        const anchors = await conn.sessionAnchors(openSessionId);
        const last = anchors.length > 0 ? anchors[anchors.length - 1]!.turn : 1;
        const r = await conn.forkSession(openSessionId, last, true);
        sideSinksRef.current.set(r.sessionId, { current: null });
        openTabInSession('sidechat', { sideId: r.sessionId, insert });
      } catch {
        /* fork 失败静默(旁路非关键路径) */
      }
    })();
  };

  const openSession = (sessionId: string, root: string): void => {
    sessionRef.current = sessionId;
    setOpenSessionId(sessionId);
    setOpenRoot(root);
    setTabStates((s) => ensureSession(s, sessionId, PROBE));
    reopenBoardSeedWindow();
    setBoard(emptyBoard());
        setTodoBatches([]);
        setTurnGoal('');
    setDelegations([]);
    setTeam([]);
    setAgentActivities({}); // G8d:会话切换串态防线(板/team 同款——聚合只挂当前会话帧)
    setPage('chat');
  };

  /** 返回欢迎态:会话关窗(Chat 卸毁本地态;连接保持,再开经左栏重播种)+ 板投影/team 清零
   *  (无会话期无帧消费,残留即陈旧)+ 播种窗缓冲清(再开重开窗);tabStates 保留(每会话
   *  独立留存,spec §1——重开同会话标签还原) */
  const backHome = (): void => {
    sessionRef.current = '';
    setOpenSessionId('');
    setOpenRoot('');
    reopenBoardSeedWindow();
    setBoard(emptyBoard());
        setTodoBatches([]);
        setTurnGoal('');
    setDelegations([]);
    setTeam([]);
    setAgentActivities({}); // G8d:无会话期无帧消费,残留即陈旧
    setPage('welcome');
  };

  /** G8c-T8 开设置态:settingsRoot 快照当前 openRoot(无会话=''=仅全局);connInstance 在场才
   *  可达(设置钮只在 ProjectMenu 底栏,其渲染前提即连接装配完成) */
  const openSettings = useCallback((): void => {
    setSettingsRoot(openRoot);
    setSettingsOpen(true);
  }, [openRoot]);

  /** G8c-T8 回会话态(返回钮/Esc 同路径):page 态未动——开设置前是 chat 则回 chat(Chat 重挂
   *  重播种),welcome 则回欢迎空态;useCallback 零依赖稳定(SettingsShell Esc effect 依赖面) */
  const closeSettings = useCallback((): void => {
    setSettingsOpen(false);
  }, []);

  /** G8a 开标签(会话内):Chat write 工具 path 按钮 / 标签条「+」菜单共用——判重聚焦经
   *  tab-state(同目标重开=聚焦既有,单例类型单份) */
  const openTabInSession = (type: TabTypeId, params: TabParams = {}): void => {
    // G14.38:程序化开标签即展开右栏(默认折叠下 write/diff/目录跳转/卡片开面板均可见)
    setTabStates((st) => setCollapsed(st, openSessionId, false));
    setTabStates((s) => openTab(s, openSessionId, type, params, PROBE));
  };

  /** G8b pty 分配落定记账(TerminalTab 回传;registry render props 面)——useCallback 零依赖
   *  (仅 ref)保稳定:TerminalTab 装配 effect 以此为依赖,inline 箭头会令其随 App 重渲染重跑 */
  const handlePtyAllocated = useCallback((uid: string, ptyId: string): void => {
    ptyIdsRef.current.set(uid, ptyId);
  }, []);

  /** G8b pty 记账读取面(TerminalTab 重挂重连判据):命中 = 该标签 pty 存活未 kill——重挂
   *  跳过 openPty 直连同 ptyId(replay 恢复屏幕);同上 useCallback 稳定注入 */
  const ptyIdFor = useCallback((uid: string): string | undefined => ptyIdsRef.current.get(uid), []);

  /** G8b 关标签链(TabStrip onClose/onCloseActive 共用):被关标签为 terminal 且 pty 已记账 →
   *  fire-and-forget killPty(拒约吞——关标签不等 HTTP;已关会话侧幂等)再关标签态 */
  const closeTabInSession = (uid: string): void => {
    const t = tabState.tabs.find((x) => x.uid === uid);
    if (t?.type === 'terminal') {
      const ptyId = ptyIdsRef.current.get(uid);
      if (ptyId !== undefined) {
        ptyIdsRef.current.delete(uid);
        const conn = connRef.current;
        if (conn !== null) void conn.killPty(openSessionId, ptyId).catch(() => {});
      }
    }
    setTabStates((s) => closeTab(s, openSessionId, uid));
  };

  /** G5 gate 审批装配:任务标签 onReview → boardReview(sessionId, taskId, approved)——失败倒
   *  Chat error 条不静默(经 sink 合成 error 帧,seq 取上界保证种子缓冲过滤恒放行;成功面无
   *  HTTP 回执帧,daemon 侧 review 触发的 gate-resolved/task-status 事件帧自然回投板投影)。
   *  useCallback 零依赖(仅 refs)——services useMemo 稳定 */
  const reviewTask = useCallback((taskId: string, approved: boolean): void => {
    const conn = connRef.current;
    if (conn === null) return;
    void conn.boardReview(sessionRef.current, taskId, approved).catch((err: unknown) => {
      chatSinkRef.current?.on(
        { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() },
        Number.MAX_SAFE_INTEGER,
      );
    });
  }, []);

  /** G5 Chat 播种回调:快照权威态回填 App 投影——team(事件流无此面)+board/delegations
   *  (快照本就携带:会话打开/reseed 即板随快照)。G6 seq 门(G5 交接 b 根修):整替前先关窗+
   *  过滤缓冲(≤ snap.lastSeq 丢——快照已含,再投即双应用;> 逐帧依序 apply 重放到快照板上)
   *  ——播种窗内到达的增量帧不再被整替吞掉(丢一帧增量竞态根除)。lastSeq 运行时必在
   *  (sessionSnapshot 应答字段;ChatSink 类型面未声明,收窄读取防 undefined 旧档) */
  const seedFromSnapshot = (snap: SnapshotResponse): void => {
    const lastSeq = (snap as SnapshotResponse & { lastSeq?: number }).lastSeq ?? 0;
    const replay = boardPendingRef.current.filter((f) => f.seq > lastSeq);
    boardPendingRef.current = [];
    boardSeedingRef.current = false;
    let nextBoard = snap.board;
    let nextDelegations = snap.delegations;
    for (const f of replay) {
      if (f.e.type.startsWith('task-') || f.e.type.startsWith('gate-')) {
        nextBoard = applyBoardEvent(nextBoard, boardEventFrom(f.e));
      } else if (f.e.type.startsWith('delegation-')) {
        nextDelegations = applyDelegation(nextDelegations, f.e);
        // G8e-T2:delegation 帧补投子代理聚合(与 board/delegation 同窗)——窗外路径本就投
        // applyAgentEvent(权威终语:ended failed→error/done→done;label 命中既有卡才动),
        // 窗内缓冲帧此前只重放板/委派不投聚合,delegation 终语在播种窗内被吞(卡滞 running)
        setAgentActivities((a) => applyAgentEvent(a, f.e));
      }
    }
    setTeam(snap.team ?? []);
    setBoard(nextBoard);
    setDelegations(nextDelegations);
  };

  /** 标签体服务面(任务/Agents 标签消费):板投影 + 浅拷贝数组(既有 Board 收可变数组,T3 桥接)+
   *  G8d 子代理活动聚合(AgentsTab 只读) */
  const services = useMemo<TabServices>(
    () => ({ board, delegations: [...delegations], team: [...team], onReview: reviewTask, agentActivities, todos: [...sessionTodos], todoBatches, turnGoal, taskFocus }),
    [board, delegations, team, reviewTask, agentActivities, sessionTodos, todoBatches, turnGoal, taskFocus],
  );

  /** 当前会话标签席(welcome 期空席占位——TabStrip 灰条;宽 32) */
  const tabState = tabStates[openSessionId] ?? emptyTabSession();
  const activeTab = tabState.tabs.find((t) => t.uid === tabState.activeUid) ?? null;

  /** 拖宽边条 mousedown:window mousemove 计算宽(右栏在右侧,向左拖=变宽;clamp 200..720 在
   *  tab-state.setWidth 单点),mouseup 解绑 + 移 active 类;每次 move 直接落态(React 批处理
   *  兜底);sessionId 起拖时定格(拖拽中会话切换属病态,不追) */
  const startResize = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (page !== 'chat' || openSessionId === '' || tabState.collapsed) return;
    e.preventDefault(); // 拖宽期间禁原生文本选择拖选(G8e 终审 B;.sx-resizer 另挂 user-select:none)
    const el = e.currentTarget;
    el.classList.add('active');
    const startX = e.clientX;
    const startWidth = tabState.width;
    const sessionId = openSessionId;
    const onMove = (ev: MouseEvent): void => {
      setTabStates((s) => setWidth(s, sessionId, startWidth + startX - ev.clientX));
    };
    const stop = (): void => {
      el.classList.remove('active');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', stop);
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = stop;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
  };

  const sidebarWidth = page === 'chat' && openSessionId !== '' ? (tabState.collapsed ? 32 : tabState.width) : 32;

  /** G12 左栏拖宽边条 mousedown:window mousemove 计算宽(左栏在左侧,向右拖=变宽;clamp
   *  220..420 模块级常量单点),mouseup 解绑+持久化;settings 态不渲染手柄 */
  const startMenuResize = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const el = e.currentTarget;
    el.classList.add('active');
    const startX = e.clientX;
    const startWidth = menuWidth;
    let next = startWidth;
    const onMove = (ev: MouseEvent): void => {
      next = Math.min(MENU_WIDTH_MAX, Math.max(MENU_WIDTH_MIN, startWidth + ev.clientX - startX));
      setMenuWidth(next);
    };
    const stop = (): void => {
      el.classList.remove('active');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', stop);
      menuResizeCleanupRef.current = null;
      localStorage.setItem(MENU_WIDTH_KEY, String(next));
    };
    menuResizeCleanupRef.current = stop;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
  };

  return (
    <div className="sx-shell" style={{ '--menu-w': `${menuWidth}px` } as CSSProperties}>
      {settingsOpen && connInstance !== null ? (
        /* G8c-T8 设置态:左栏+主栏整体切换(SettingsShell 内含左导航与所选面板),右标签栏不渲染;
           Chat 卸载——返回重挂重播种(backHome 同语义),连接/板投影态不受扰 */
        <SettingsShell conn={connInstance} root={settingsRoot} onBack={closeSettings} />
      ) : (
        <>
          {/* 左栏:项目分组(Home 职能内化;装配中占位) */}
          {connInstance !== null ? (
            <ProjectMenu
              conn={connInstance}
              connState={connState}
              activeSessionId={openSessionId}
              activeRoot={openRoot}
              recentVersion={recentVersion}
              runActive={runActive}
              onOpenSession={openSession}
              onOpenSettings={openSettings}
              onNewChat={() => {
                setComposePresetRoot(null);
                setPage('welcome');
              }}
              onComposeIn={(root) => {
                setComposePresetRoot(root);
                setPage('welcome');
              }}
            />
          ) : (
            <nav className="sx-menu" aria-label="projects">
              <p className="home-loading">连接装配中…</p>
            </nav>
          )}
          {/* G12 左栏拖宽手柄:overlay 在 nav 右缘(负 margin 零布局占位),拖动改 --menu-w */}
          <div
            className="sx-menu-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('Resize sidebar', '调整侧栏宽度')}
            title={t('Drag to resize', '拖动调整宽度')}
            onMouseDown={startMenuResize}
          />
          {/* 中栏:Chat 恒挂(无会话=欢迎空态) */}
          <main className="sx-main">
            {page === 'chat' && connInstance !== null ? (
              <Chat
                key={openSessionId}
                conn={connInstance}
                sessionId={openSessionId}
                connState={connState}
                onBack={backHome}
                sinkRef={chatSinkRef}
                onSeeded={seedFromSnapshot}
                onOpenFile={(p) => openTabInSession('file', { path: p })}
                onOpenDiff={(callId, path) => openTabInSession('diff', { callId, path })}
                onOpenAgent={(label, agentTitle, task) => openTabInSession('agent', { label, agentTitle, task })}
                onOpenTask={(ref) => {
                  openTabInSession('agents', {});
                  setTaskFocus({ ref, nonce: Date.now() });
                }}
                onOpenTab={(type) => openTabInSession(type, {})}
                board={board}
                onTodoBatches={setTodoBatches}
                onTurnGoal={setTurnGoal}
                pendingGoal={welcomeGoal ?? undefined}
                onPendingGoalDone={() => setWelcomeGoal(null)}
                root={openRoot}
                onTodos={setSessionTodos}
                onRenamed={() => setRecentVersion((v) => v + 1)}
                showExpandSidebar={tabState.collapsed}
                onExpandSidebar={() => setTabStates((s) => setCollapsed(s, openSessionId, false))}
                onSideChat={startSideChat}
                onOpenMemory={() => openTabInSession('memory')}
                onFork={() => {
                  if (connInstance === null) return;
                  void connInstance
                    .sessionAnchors(openSessionId)
                    .then(async (a) => {
                      const last = a.length > 0 ? a[a.length - 1]!.turn : 1;
                      const r = await connInstance.forkSession(openSessionId, last);
                      openSession(r.sessionId, openRoot);
                    })
                    .catch(showOpError);
                }}
                onRewind={(turn) => {
                  void connInstance
                    .rewindSession(openSessionId, turn)
                    .then(() => {
                      // 回退=换 journal 重新播种(Chat 内 reseed 由 key 不变触发不了——手动重挂:切走再切回同会话)
                      const rid = openSessionId;
                      const rr = openRoot;
                      setPage('welcome');
                      requestAnimationFrame(() => openSession(rid, rr));
                    })
                    .catch(showOpError);
                }}
              />
            ) : connInstance !== null ? (
              <WelcomeComposer
                conn={connInstance}
                presetRoot={composePresetRoot ?? undefined}
                onOpened={(sessionId, root, goal) => {
                  setWelcomeGoal({ root, goal });
                  openSession(sessionId, root);
                }}
              />
            ) : (
              <div className="sx-welcome-brand">Sunshinex</div>
            )}
          </main>
          {/* 右栏:会话标签页(G10:welcome 态整体不渲染;G14.28:折叠态也不渲染——展开钮入 Chat 顶栏) */}
          {page === 'chat' && !tabState.collapsed && (
          <aside className="sx-sidebar" style={{ width: sidebarWidth }}>
            <TabStrip
              tabs={tabState.tabs}
              activeUid={tabState.activeUid}
              collapsed={tabState.collapsed || page !== 'chat'}
              disabled={page !== 'chat'}
              onSelect={(uid) => setTabStates((s) => setActive(s, openSessionId, uid))}
              onReorder={(from, to) => setTabStates((s) => reorderTab(s, openSessionId, from, to))}
              onClose={closeTabInSession}
              onOpenType={(t) => openTabInSession(t, tabEntry(t).mintParams?.())}
              onToggleCollapse={() =>
                setTabStates((s) => setCollapsed(s, openSessionId, !(s[openSessionId]?.collapsed ?? false)))
              }
              onCycle={(d) => setTabStates((s) => cycleTab(s, openSessionId, d))}
              onCloseActive={() => {
                const uid = tabState.activeUid;
                if (uid !== null) closeTabInSession(uid);
              }}
            />
            {page === 'chat' && !tabState.collapsed && connInstance !== null && activeTab !== null && (
              // key={activeTab.uid}:同型标签(file→file)互切强制重挂——React 同树位同元素类型会复用
              // 一个 Files 实例(initialPath 自动加载 effect no-op,空标签串上一标签内容/路径输入)
              <div className="sx-tabbody" key={activeTab.uid}>

                {tabEntry(activeTab.type).render({
                  conn: connInstance,
                  sessionId: openSessionId,
                  root: openRoot,
                  params: activeTab.params,
                  services,
                  uid: activeTab.uid,
                  // G8b T7:标签体自治跳转面(DirectoryTab 文件行 → file 标签;Chat onOpenFile 同源)
                  openTab: openTabInSession,
                  startSideChat,
                  ptyIdFor,
                  onPtyAllocated: handlePtyAllocated,
                  // G14.29 辅助对话:按 sideId 注入旁路 sink(App onEvent 同键路由帧)
                  chatSinkRef: activeTab.params.sideId !== undefined ? sideSinksRef.current.get(activeTab.params.sideId) : undefined,
                })}
              </div>
            )}
            {page === 'chat' && !tabState.collapsed && activeTab === null && (
              // G14.27 零标签空态=Codex 推荐项:标题+副题+三张常用页卡(点击即开,不再默认开任务页)
              <div className="sx-tab-empty">
                <div className="sx-tab-empty-title">{t('Open tabs', '打开标签页')}</div>
                <div className="sx-tab-empty-sub">{t('Choose tabs to open in the side panel.', '选择要在侧边面板中打开的标签。')}</div>
                <div className="sx-tab-empty-cards">
                  {([['side', MessageCircle, t('Side chat', '辅助对话'), () => startSideChat()], ['tasks', ListTodo, t('Todos', '待办'), () => openTabInSession('tasks')], ['diff', GitCompare, t('Review', '审查'), () => openTabInSession('diff')]] as const).map(([key, Icon, label, onClick]) => (
                    <button key={key} type="button" className="sx-tab-empty-card" onClick={onClick}>
                      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {page === 'chat' && !tabState.collapsed && <div className="sx-resizer" onMouseDown={startResize} />}
          </aside>
          )}
        </>
      )}
      {opError !== '' && (
        <div className="sx-toast" role="alert">
          {opError}
        </div>
      )}
    </div>
  );
}
