import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Connection, ScheduleJobView, SessionRow, SunxTemplateEntry, WorkspaceRow } from '../connection';
import { errText, pickWorkspaceFolder } from '../ui-util';
import { t } from '../i18n';
import { ArrowLeft, Clock, PanelLeft, Search, Settings, SquarePen } from 'lucide-react';
import { SunxIcon } from '../sunx-icon';
import { DirPicker } from '../pages/DirPicker';
import { NewSunxDialog } from '../welcome/NewSunxDialog';
import { DirectoryTab } from '../tabs/DirectoryTab';
import { NavButtons } from '../NavButtons';
import type { NavControls } from '../nav-history';
import {
  listShallowEqual,
} from './project-menu-util';
import { useMenuSeen } from './use-menu-seen';
import { useMenuSearch } from './use-menu-search';
import { useMenuSunx } from './use-menu-sunx';
import { useMenuChannels } from './use-menu-channels';
import { useMenuArchive, useMenuPins, useMenuRecentsDisplay } from './use-menu-sections';
import { ProjectSearch } from './project-menu-search';
import { ProjectsSection } from './project-menu-projects';
import { RecentsSection } from './project-menu-recents';
import { SunxSection } from './project-menu-sunx';
import { ChannelsSection } from './project-menu-channels';
import { ArchiveSection } from './archive-group';
import { PinnedSection } from './pinned-section';
import type { PinEntry } from './pin-store';
import type { SearchAction } from '../search-actions';

// FolderAddIcon 消费方(App.tsx)零迁移:原路径再导出
export { FolderAddIcon } from './project-menu-util';


/**
 * 左栏项目分组菜单(G8a-T4,spec §1):Home 页职能内化——工作区=项目组,一项目一工作区。
 * 组列表(GET /workspaces):组头(chevron+Folder+slug+会话数)点击展开惰拉 GET /sessions?root=
 * (slug 守卫照搬 Home——openSlugRef 过期应答丢弃);root 缺场历史组禁用不可展开;组内「+」
 * 回欢迎页预选该项目(审批模式由欢迎页选择器承载,G10-C16);会话行 Attach 两步(newSession 装配壳
 * → attach 播种)→ onOpenSession(sessionId, root)。Projects 分区头「+」开原生文件选择器(选完自动建项目, G10-C11);品牌行查找钮开项目/会话搜索面板 + 30s 定时自动刷新(G10-C13);
 * Home 的 modal-overlay 结构原样)。连接态显示退役(G10:一体本地,无连接语义可显)。
 * activeRoot 组自动展开(T5 App 壳传当前活动工作区;自动加开自己,不关其他已开组)。
 * 样式用 app.css T1 的 sx- 类 + Home 既有测试钩子类(workspace-、ws-、session- 前缀与
 * attach、no-root,零 e2e 迁移);唯一内联样式为组行锚定(mode 弹层定位面)与 chevron 旋转。
 */

/** 连接面:Home.tsx HomeConn 原样五方法(G8a-T4 平移源;本文件独立等价声明,不 import
 *  Home——T5 删 Home 页时本组件零牵连) */
export interface ProjectMenuConn {
  workspaces(): Promise<WorkspaceRow[]>;
  sessionsOf(root: string): Promise<SessionRow[]>;
  /** 跨工作区扁平最近会话(G10-C2 侧栏 Recents 区;daemon /sessions/recent 聚合) */
  recentSessions(): Promise<Array<SessionRow & { root: string; slug: string }>>;
  /** GET /sunx/sessions(sunx P3 Task 3 数据源改向):sunx 域容器全域枚举——SUNX 过滤组数据源单点 */
  sunxSessions(): Promise<SessionRow[]>;
  /** GET /channels/sessions(2026-11-21 channels Task 13):通道域容器全域枚举——侧栏「通道」
   *  组数据源(可选声明同 schedules? 先例:旧测试桩缺名=组不渲染,App 实传整只 Connection) */
  channelSessions?(): Promise<SessionRow[]>;
  /** GET /settings/channels(channels Task 12):通道配置读面——平台图标按 SessionRow.channel 反查 */
  settingsChannels?(): Promise<{ channels: import('../connection-api').ChannelConfigMsg[]; warnings: string[] }>;
  /** GET /schedules(2026-11-21 搜索分类扩展):定时任务清单供聚合搜索按类型检索;
   *  旧桩缺名=不出「定时任务」分类(App 传整只 Connection 运行时满足) */
  schedules?(): Promise<{ jobs: ScheduleJobView[] }>;
  /** POST /sunx/attach(sunx P3 Task 3):journalId 直寻址重开 sunx 实例——SUNX 组条目点击链 */
  attachSunx(journalId: string): Promise<{ sessionId: string; root: string; kind?: string }>;
  dirpicker(path?: string): Promise<{ path: string; parent: string; dirs: string[] }>;
  /** 建会话单点(attach 装壳/组内新建;sunx P1 Task 6 增第 5 参 opts——kind/name/charter 透传,
   *  缺席时 body 与旧形态逐字节相同):App 实传整只 Connection(运行时满足) */
  newSession(root: string, mode?: 'acceptEdits' | 'full-access', worktree?: boolean, branch?: string, opts?: { kind?: 'sunx'; name?: string; charter?: string }): Promise<{ sessionId: string; worktree?: { name: string; path: string; branch: string } }>;
  /** GET /settings/sunx-templates(sunx P2 Task 6,NewSunxDialog 模板挑选数据源;只读面无写端点。
   *  App 实传整只 Connection 运行时满足) */
  sunxTemplates(root?: string): Promise<{ entries: SunxTemplateEntry[]; warnings: string[] }>;
  /** 建项目(G10-C11):原生选择器确认后注册/创建工作区 */
  createWorkspace(body: { name?: string; path?: string }): Promise<{ ok: true; root: string; slug: string }>;
  /** 移除工作区(2026-10-23):仅摘出侧栏,数据保留;重新 create 即原地加回 */
  hideWorkspace(slug: string): Promise<void>;
  /** G14.69 原生选择定位:按标记文件找所选目录绝对路径 */
  locateWorkspace(body: { token: string; roots?: string[] }): Promise<{ path: string | null }>;
  /** 2026-10-24 用户裁定:会话行 hover tooltip 分支信息(source=gitBranches.current) */
  gitBranches(root: string): Promise<{ current: string; branches: string[] }>;
  /** attach:daemon 可能收编同 journal 在座会话(运行中刷新恢复)——返回**实际** sessionId */
  attach(sessionId: string, journalId: string): Promise<{ sessionId: string; root: string; kind?: string }>;
  /** GET /session/:id/charter(sunx P2 Task 7 读面):当前品性全文+rev——CharterDialog 预填数据源 */
  sessionCharter(id: string): Promise<{ text: string | null; charterRev: number }>;
  /** POST /session/:id/charter {text}(sunx P2 Task 7 封装):品性全文替换——成功回新 rev */
  editCharter(id: string, text: string): Promise<{ ok: true; charterRev: number }>;
  /** POST /session/:id/rename {title}(sunx 改名):显示名+尾追同步(daemon 侧) */
  renameSession(id: string, title: string): Promise<{ ok: true; title: string }>;
  /** T6 归档/撤销(Connection 结构化子集):侧栏行归档钮落库面(归档行由服务端列表滤除) */
  archiveSession(id: string, archived: boolean): Promise<void>;
  /** 置顶档(2026-10-21 GUI 专属,GET/PUT /app/pins;userConfigDir/gui/pins.json)。kind=sunx 形态
   *  快照(sunx P2 Task 7 徽标透传;服务端 PUT 同键闭合透传,老钉缺省) */
  appPins(): Promise<{ pins: Array<{ id: string; root: string; title?: string; updatedAt?: number; kind?: string }> }>;
  saveAppPins(pins: Array<{ id: string; root: string; title?: string; updatedAt?: number; kind?: string }>): Promise<void>;
  /** 已读档(2026-10-23,GET/PUT /app/seen;userConfigDir/gui/seen.json,已读/未读态落底层) */
  appSeen(): Promise<{ seen: Record<string, number> }>;
  saveAppSeen(seen: Record<string, number>): Promise<void>;
  /** config-changed 帧订阅(2026-11-11 用户实测「输入框添加项目,左侧菜单不同步」根修):
   *  daemon /workspace/create afterCreate 必广播(幂等登记同拍)——侧栏订阅即回源,欢迎页/
   *  他窗建的项目免切页即显。可选(旧测试桩缺名不订阅,守卫同 use-config-changed 先例) */
  onConfigChanged?(cb: (f: { resource: string }) => void): () => void;
  /** 归档区数据面(跨工作区聚合行;GET /sessions/archived)+ 受控删除(已归档态)。kind=sunx 形态
   *  透出(归档行徽标,sunx P2 Task 7) */
  archivedSessions(): Promise<Array<{ id: string; slug: string; root: string; title?: string; updatedAt: number; archivedAt: number; liveSessionId?: string; awaiting?: boolean; kind?: string }>>;
  deleteSession(id: string): Promise<void>;
}

interface ProjectMenuProps {
  readonly conn: ProjectMenuConn;
  readonly connState: string; // 'connecting'|'online'|'offline'|'reconnecting'(显示态)
  readonly activeSessionId: string; // '' = 无会话
  readonly activeRoot: string; // '' = 无(其所属组自动展开)
  /** G14.16 标题统一流联动:rename 落盘后 App bump——变化即重拉 recentSessions(侧栏即时同名) */
  readonly recentVersion?: number;
  /** 置顶档单源(2026-11-07 置顶卡顿根修:状态上提 App,顶栏/侧栏共享乐观态,点击零往返) */
  readonly pins?: PinEntry[];
  readonly persistPins?: (next: PinEntry[]) => void;
  /** G14.52 活动会话运行态(App 本地权威,model-start 置位/done·error 复位):圆点亮熄以此为准 */
  readonly runningIds?: ReadonlySet<string>;
  readonly onOpenSession: (sessionId: string, root: string, journalId?: string, kind?: string) => void;
  /** 本运行已打开会话直达(2026-11-18 冷进入提速):命中=App 侧直接复用在座运行时打开(零
   *  newSession/attach 往返——实测 attach 198ms);未命中返回 false 走既有两步链 */
  readonly onOpenLiveSeat?: (journalId: string) => boolean;
  /** G8c-T8 设置钮回调:App 开设置态(可选——未配时钮不渲染,免独立测试装配面死 UI) */
  readonly onOpenSettings?: () => void;
  /** 定时任务主区页(2026-11-20):入口在「新建 Sunx」下方(可选——未配时钮不渲染) */
  readonly onOpenSchedules?: () => void;
  /** 定时任务搜索跳转(2026-11-21):开任务页并定位到指定任务卡;未配时搜索不出该分类 */
  readonly onOpenSchedule?: (id: string) => void;
  /** 设置项搜索跳转(2026-11-21):开设置面板并滚到行锚;未配时搜索不出设置分类 */
  readonly onOpenSettingsItem?: (pane: string, row?: string) => void;
  /** 操作类快捷项(宿主注入:菜单/页面动作从搜索框直达) */
  readonly searchActions?: readonly SearchAction[];
  /** 「New chat」:回欢迎页开新对话(G10-C16) */
  readonly onNewChat: () => void;
  /** 项目行「+」:回欢迎页并预选该项目(G10-C16;审批模式由欢迎页选择器承载,旧 auto/manual 直进面退役) */
  readonly onComposeIn: (root: string) => void;
  /** 组头目录钮(2026-10-23 用户裁定):开当前会话/项目第一会话的目录页签(宿主解析会话+开页签) */
  readonly onOpenDirectory: (root: string) => void;
  /** SUNX 组头看板钮(sunx P2 Task 7 留开合点,可选 guard):宿主开 Sunx 总览页——Task 8 注册
   *  'sunxboard' 页签后 App 传 openTab 接线;未配时钮不渲染(不产死钮) */
  readonly onOpenSunxBoard?: () => void;
  /** 2026-10-27 用户裁定:目录树入左菜单视图层——App 持状态(openProjectDirectory 落值),
   *  视图=返回+DirectoryTab 复用;文件行点击经 onOpenFileFromTree 开右侧文件标签 */
  /** locate=相对目录(posix /),打开后 DirectoryTab 逐层展开定位 */
  readonly dirView?: { readonly root: string; readonly sessionId: string; readonly locate?: string } | null;
  readonly onCloseDirView?: () => void;
  readonly onOpenFileFromTree?: (path: string, root: string) => void;
  /** 2026-10-24 用户裁定:菜单头收起钮(PanelLeft,搜索钮右侧)=宿主收起菜单(抽屉/关闭态由宿主管) */
  readonly onCollapse?: () => void;
  /** 2026-10-25 应用级导航(前进/后退)控制面(全局史):菜单开着时钮对驻菜单头(用户裁定——
   *  菜单存在=菜单里承载,收起才回落顶栏/欢迎浮出簇);缺省不渲染(独立装配面免配) */
  readonly nav?: NavControls;
  /** 收起过渡中(2026-11-18 用户裁定「展开和关闭要平滑」):宿主在关闭后保留挂载 200ms,根节点挂
   *  sx-closing 把宽度收到 0 让过渡跑完再卸载;打开时由 sx-panel-in keyframe 入场 */
  readonly closing?: boolean;
}

/** 相对时间:G8e-T2 抽共享 ui-util(与 SettingsForm 同款逻辑本地复制收敛) */

/** runningIds 缺省空集(2026-11-16 流畅轮:模块级单例——内联 `new Set()` 每渲染换身份击穿 memo 分区) */
const EMPTY_RUNNING: ReadonlySet<string> = new Set();

export function ProjectMenu(props: ProjectMenuProps): JSX.Element {
  const { conn, activeSessionId, activeRoot, onOpenSession, onOpenSettings, onOpenSchedules, onOpenSchedule, onOpenSettingsItem, onNewChat, onComposeIn, onOpenDirectory, dirView, onCloseDirView, onOpenFileFromTree, onOpenLiveSeat } = props;
  const recentVersion = props.recentVersion ?? 0;
  const pins = props.pins ?? [];
  const persistPins = props.persistPins ?? ((): void => undefined);
  const runningIds = props.runningIds ?? EMPTY_RUNNING;
  const [rows, setRows] = useState<WorkspaceRow[] | null>(null);
  /** 2026-10-24 用户裁定:会话行 hover tooltip 附分支信息(如 dev1)——按工作区 root 拉 gitBranches
   *  current 缓存(失败落 '' 防重试风暴);ProjectsSection 消费 */
  const [branchByRoot, setBranchByRoot] = useState<Record<string, string>>({});
  /** 分支缓存镜像 ref(2026-11-07 用户实测「置顶/归档卡+Failed to fetch」根修):state 值原在
   *  loadWorkspaces 闭包与 effect deps 双现——每个分支应答都重跑全部加载请求=请求风暴,daemon
   *  忙时(会话运行中)同源 fetch 被重置=「Failed to fetch」+动作假卡。ref 直读即只拉一次 */
  const branchByRootRef = useRef(branchByRoot);
  branchByRootRef.current = branchByRoot;
  /** Recents 扁平最近会话(G10-C2;跨工作区,daemon 聚合) */
  const [recents, setRecents] = useState<Array<SessionRow & { root: string; slug: string }> | null>(null);
  /** 最近显形簇(开合/逐步显形)收口 use-menu-sections(D62 批J) */
  const { recentsOpen, recentLimit, toggleRecents, recentsShowMore, recentsCollapse } = useMenuRecentsDisplay(recents);
  const [listError, setListError] = useState('');
  /** G14.51 浏览器态服务端目录选择弹层(添加工作区无桌面壳时) */
  const [dirOpen, setDirOpen] = useState(false);
  /** 「新建 Sunx」弹窗(sunx P1 Task 6;2026-11-15 用户实测反馈「怎么没有对应入口」:入口提为
   *  顶部快捷区行——与「新对话」主钮真同级(RECENTS 头簇的小钮用户看不见);成功后不走欢迎页,
   *  直接 openSession 打开新会话) */
  const [sunxOpen, setSunxOpen] = useState(false);
  /** 展开中的组 slug 集(2026-11-18 用户裁定「左侧打开项目菜单,不要自动关闭另一个项目的」):
   *  多组可同开——旧单 openSlug 是手风琴语义(开一组=收上一组)。集合同步进 ref:惰拉应答守卫/
   *  30s 聚焦刷新/归档重拉都在异步回调里读现值 */
  const [openSlugs, setOpenSlugs] = useState<ReadonlySet<string>>(() => new Set());
  const openSlugsRef = useRef<ReadonlySet<string>>(openSlugs);
  openSlugsRef.current = openSlugs;
  /** 组会话行/错误/「显示更多」按 slug 分桶:各组独立惰拉、独立报错、独立放开 */
  const [sessionsBySlug, setSessionsBySlug] = useState<Record<string, SessionRow[] | null>>({});
  const [sessionsErrorBySlug, setSessionsErrorBySlug] = useState<Record<string, string>>({});
  /** attach/组内新建/添加工作区在途(按钮禁用防双发) */
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  /** 组内「+」的 mode 弹层挂哪组(slug;null = 收) */
  /** 分区折叠(G10-C18):PROJECTS/RECENTS 分区头可折叠(平滑过渡) */
  const [projectsOpen, setProjectsOpen] = useState(true);
  // G14.2xx 组内会话默认收窄(2026-11-18 多组同开):「显示更多」按组独立(slug → 全量),
  // 收起该组即复位;旧单布尔是全侧栏一份,多组同开下会互相串档
  const [showAllBySlug, setShowAllBySlug] = useState<Record<string, boolean>>({});
  /** 查找面板簇(开合/查询词/聚合会话集/定时任务)收口 use-menu-search(D62 批J) */
  const { searchOpen, setSearchOpen, allSessions, schedules, query, setQuery } = useMenuSearch(conn, rows);
  /** 搜索「操作」分类:本面动作(新建 Sunx)+ App 注入的菜单/页面动作 */
  const searchActions = useMemo<readonly SearchAction[]>(
    () => [
      { id: 'new-sunx', en: 'New Sunx', zh: '新建 Sunx', run: () => setSunxOpen(true) },
      ...(props.searchActions ?? []),
    ],
    [props.searchActions],
  );
  /** 各组已载会话行并集(已读映射/journal 行寻址面):多组同开后活跃行不再只认单组数据 */
  const openSessions = useMemo(() => {
    const out: SessionRow[] = [];
    for (const list of Object.values(sessionsBySlug)) {
      if (list !== null && list !== undefined) out.push(...list);
    }
    return out;
  }, [sessionsBySlug]);
  /** 已读档+journal 映射簇收口 use-menu-seen(D62 批J):双写收敛/自动已读/attach 映射 */
  const { isUnseen, markSeen, markJournal, loadSeen, journalOfSession } = useMenuSeen(conn, openSessions, activeSessionId);

  const loadWorkspaces = useCallback((): void => {
    conn.workspaces().then(
      (list) => {
        // 2026-11-16 流畅轮:浅等守卫——30s 轮询/聚焦刷新内容未变时保旧引用,下游 memo 分区零重渲
        setRows((prev) => (listShallowEqual(prev, list) ? prev : list));
        setListError('');
        // 分支缓存补拉:每个未缓存的 root 一次(缓存守卫防风暴;失败落空串标记已试)
        for (const w of list) {
          const rt = w.root;
          if (!rt || branchByRootRef.current[rt] !== undefined) continue;
          conn.gitBranches(rt).then(
            (r) => { if (r.current) setBranchByRoot((m) => (m[rt] === undefined ? { ...m, [rt]: r.current } : m)); },
            () => setBranchByRoot((m) => ({ ...m, [rt]: '' })),
          );
        }
      },
      (err: unknown) => setListError(err instanceof Error ? err.message : String(err)),
    );
    conn.recentSessions().then(
      (list) => setRecents((prev) => (listShallowEqual(prev, list) ? prev : list)), // Recents 静默降级:空列表即可用
      () => setRecents([]),
    );
  }, [conn]);

  /** 归档区簇(开合/聚合行/装载)收口 use-menu-sections(D62 批J) */
  const { archiveOpen, setArchiveOpen, archivedRows, loadArchived, openArchivedWithReload, exitArchiveView } = useMenuArchive(conn);
  /** 归档层作用域(2026-11-16 用户裁定「归档 Sunx 不能和归档会话混为一谈」):SUNX 组头入口=
   *  'sunx' 专域(标题「归档 Sunx」+行只显 sunx);项目组头入口='session'(原通用层,sunx 行滤除) */
  const [archiveScope, setArchiveScope] = useState<'session' | 'sunx'>('session');
  /** SUNX 组行集(域枚举拉取收口 use-menu-sunx,D62 批J) */
  /** SUNX 组即时重拉触发(2026-11-16 用户实测「创建后没有立刻显示到 SUNX 下」):新建成功链
   *  setSunxReload——workspaces 未变(rows 保引用)时既有驱动点全不触发,nonce 即时缝兜底 */
  const [sunxReload, setSunxReload] = useState(0);
  const sunxRows = useMenuSunx(conn, rows, sunxReload);
  /** 「通道」组行集(channels Task 13,spec §9.1;域枚举拉取收口 use-menu-channels):空容器=组整块不渲染(组内自守卫) */
  const channelRows = useMenuChannels(conn, rows);
  // G14.2xx 名称截断隐现(chrome 同形,同标签条):项目名/会话名溢出打 data-cut=右缘渐隐,无省略号。
  // RO 盯滚动容器(拖栏宽度变化即重测)。2026-11-16 流畅轮:补数据依赖(原无 deps=每次渲染全量
  // DOM 扫描+重建 RO,App 壳高频态即触发);数据引用不变时零扫描,宽变仍由 RO 兜底。
  // 块置于全部数据声明之后(deps 求值需引用在座)
  const sideScrollRef = useRef<HTMLDivElement>(null);
  const markSideCut = useCallback((): void => {
    const root = sideScrollRef.current;
    if (root === null) return;
    for (const el of root.querySelectorAll<HTMLElement>('.sx-ws-name, .session-summary')) {
      if (el.scrollWidth > el.clientWidth + 1) el.setAttribute('data-cut', '');
      else el.removeAttribute('data-cut');
    }
  }, []);
  useLayoutEffect(() => {
    markSideCut();
    const el = sideScrollRef.current;
    if (el === null) return;
    const ro = new ResizeObserver(markSideCut);
    ro.observe(el);
    return () => ro.disconnect();
  }, [markSideCut, rows, openSessions, recents, sunxRows, archivedRows, pins, openSlugs, showAllBySlug, recentLimit, projectsOpen, archiveOpen, searchOpen]);



  useEffect(() => {
    loadWorkspaces();
    loadArchived(); // 2026-10-23 置顶组滤除已归档钉:归档集与钉档同拍重拉
    loadSeen(); // 2026-10-23 已读/未读态落底层:与钉档同拍重拉(顶栏标记为未读经 recentVersion bump 驱动)
  }, [loadWorkspaces, loadArchived, loadSeen, recentVersion]); // G14.52:run 起跑经 App recentVersion bump 驱动刷新(liveSessionId 圆点跟手);branchByRoot 走 ref(风暴根修)

  /** config-changed 回源(2026-11-11):他面(欢迎页输入框「浏览文件夹…」/他窗)创建/登记工作区后
   *  daemon afterCreate 广播帧——300ms 合帧防抖(skills 等高频帧幂等 GET)静默重拉组列表,新项目
   *  免切页即显。conn 缺 onConfigChanged(旧测试桩)不订阅 */
  useEffect(() => {
    if (typeof conn.onConfigChanged !== 'function') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = conn.onConfigChanged(() => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        loadWorkspaces();
      }, 300);
    });
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [conn, loadWorkspaces]);

  /** 组开合单点(集合同步写 ref:惰拉守卫/异步刷新须已见新集) */
  const setGroupOpen = useCallback((slug: string, open: boolean): void => {
    const cur = openSlugsRef.current;
    if (open === cur.has(slug)) return;
    const next = new Set(cur);
    if (open) next.add(slug);
    else next.delete(slug);
    openSlugsRef.current = next;
    setOpenSlugs(next);
  }, []);

  /** 移除工作区(2026-10-23):conn.hideWorkspace 落库后刷新清单;若它正展开即收(多组同开只收自己)。
   *  数据保留——重新「添加工作区」即原地加回 */
  const removeWorkspace = useCallback((slug: string): void => {
    conn.hideWorkspace(slug).then(
      () => {
        if (openSlugsRef.current.has(slug)) {
          setGroupOpen(slug, false);
          setSessionsBySlug((prev) => {
            if (!(slug in prev)) return prev;
            const next = { ...prev };
            delete next[slug];
            return next;
          });
        }
        loadWorkspaces();
      },
      (err: unknown) => setActionError(errText(err)),
    );
  }, [conn, loadWorkspaces, setGroupOpen]);

  /** 拉指定组的会话列表(slug 守卫):应答到达时该组已收起/已移除则丢弃(慢应答竞态收口) */
  const loadSessions = useCallback(
    (root: string, slug: string): void => {
      conn.sessionsOf(root).then(
        (list) => {
          if (!openSlugsRef.current.has(slug)) return;
          // 2026-11-16 流畅轮:浅等守卫(同 loadWorkspaces——recentVersion bump/30s 重拉内容未变零重渲)
          setSessionsBySlug((prev) => {
            const before = prev[slug];
            if (before !== undefined && before !== null && listShallowEqual(before, list)) return prev;
            return { ...prev, [slug]: list };
          });
          // 树会话行分支缓存补拉(2026-11-11):隔离会话 sr.root=工作树路径,悬浮卡分支按真根取
          for (const r of list) {
            const rt = r.root;
            if (rt === undefined || rt === '' || branchByRootRef.current[rt] !== undefined) continue;
            conn.gitBranches(rt).then(
              (b) => { if (b.current) setBranchByRoot((m) => (m[rt] === undefined ? { ...m, [rt]: b.current } : m)); },
              () => setBranchByRoot((m) => ({ ...m, [rt]: '' })),
            );
          }
        },
        (err: unknown) => {
          if (!openSlugsRef.current.has(slug)) return;
          const msg = err instanceof Error ? err.message : String(err);
          setSessionsErrorBySlug((prev) => (prev[slug] === msg ? prev : { ...prev, [slug]: msg }));
        },
      );
    },
    [conn],
  );

  /** 展开组:展开即惰拉 sessionsOf(root);多组可同开(2026-11-18 用户裁定——不再收上一组) */
  const expandGroup = useCallback(
    (row: WorkspaceRow): void => {
      if (row.root === undefined) return;
      setGroupOpen(row.slug, true);
      setShowAllBySlug((prev) => (prev[row.slug] === undefined || prev[row.slug] === false ? prev : { ...prev, [row.slug]: false }));
      setSessionsBySlug((prev) => (prev[row.slug] === undefined ? { ...prev, [row.slug]: null } : prev));
      setSessionsErrorBySlug((prev) => (prev[row.slug] === undefined || prev[row.slug] === '' ? prev : { ...prev, [row.slug]: '' }));
      loadSessions(row.root, row.slug);
    },
    [loadSessions, setGroupOpen],
  );

  const toggleGroup = useCallback((row: WorkspaceRow): void => {
    if (row.root === undefined) return;
    if (openSlugsRef.current.has(row.slug)) {
      setGroupOpen(row.slug, false);
      setShowAllBySlug((prev) => (prev[row.slug] === true ? { ...prev, [row.slug]: false } : prev));
      return;
    }
    expandGroup(row);
  }, [expandGroup, setGroupOpen]);

  /** 已开组会话行全量重拉(归档/撤销/运行态变化后同拍回显;多组同开各自独立跟手) */
  const reloadOpenGroups = useCallback((): void => {
    for (const slug of openSlugsRef.current) {
      const row = (rows ?? []).find((r) => r.slug === slug);
      if (row?.root !== undefined) loadSessions(row.root, slug);
    }
  }, [rows, loadSessions]);

  /** activeRoot 组自动展开(当前会话所属组;多组同开:只加开自己,不再收其他组) */
  useEffect(() => {
    const row = (rows ?? []).find((r) => r.root === activeRoot);
    if (row === undefined || openSlugsRef.current.has(row.slug)) return;
    expandGroup(row);
  }, [activeRoot, rows, expandGroup]);

  /** G14.52:run 起跑/收束(App recentVersion bump)时,展开中的各组重拉会话行——liveSessionId
   *  运行圆点跟手。组列表只在展开时惰拉,不重拉则行恒为展开时刻快照(圆点不亮/不熄) */
  useEffect(() => {
    if (recentVersion === 0) return;
    reloadOpenGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recentVersion 即刷新信号;rows/openSlugsRef 取现值
  }, [recentVersion]);




  // 30s 定时自动刷新(G10-C13)+ 窗口聚焦刷新(G14.9:回窗即见最新会话列表)。
  // 2026-10-23:展开组会话行同拍重拉——后台会话收束后 liveSessionId 卡旧列表即「已完成仍在转圈」
  // (workspaces 只刷计数/recents,组行本不在此列;他端/他页起落的运行态 30s/聚焦自愈)
  const refreshExpandedGroupRef = useRef<() => void>(() => undefined);
  refreshExpandedGroupRef.current = reloadOpenGroups;
  useEffect(() => {
    const tick = (): void => {
      loadWorkspaces();
      refreshExpandedGroupRef.current();
    };
    const timer = setInterval(tick, 30_000);
    const onFocus = (): void => tick();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadWorkspaces]);



  /** Attach 两步(daemon 形态对齐,Home 照搬):newSession(root) 装配壳 → attach(sessionId,
   *  journalId) 播种恢复 → onOpenSession(sessionId, root);失败行内报错,busy 防双发。
   *  2026-11-16 流畅轮:useCallback+busyRef(memo 分区判等面;busy 读 ref 免依赖抖动) */
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const attachJournal = useCallback((root: string, journalId: string, journalUpdatedAt?: number): void => {
    if (busyRef.current) return;
    // 2026-11-18 直达快路径:本运行已打开过的会话(daemon 在座、运行时 id 有效)直接复用——省
    // newSession+attach 两次往返(实测 attach 198ms,是冷进入「卡一下才到」的主延迟)
    if (onOpenLiveSeat?.(journalId) === true) {
      markSeen(journalId, journalUpdatedAt ?? Date.now());
      loadWorkspaces();
      return;
    }
    setBusy(true);
    setActionError('');
    conn
      .newSession(root)
      .then(({ sessionId }) => conn.attach(sessionId, journalId).then((r) => ({ sid: r.sessionId, root: r.root || root, kind: r.kind }))) // G14.2xx daemon 可能收编在座会话,以返回 id 为准;root 同取真根(树会话重挂),缺省回退行根(旧 daemon/应答缺 root 不落 undefined=渲染崩)
      .then(
        ({ sid: sessionId, root: realRoot, kind }) => {
          setBusy(false);
          markSeen(journalId, journalUpdatedAt ?? Date.now());
          markJournal(sessionId, journalId);
          onOpenSession(sessionId, realRoot, journalId, kind); // journalId=滚动位存档稳定键;root=attach 归位真根;kind=应答形态(2026-11-17 首帧欢迎面)
          loadWorkspaces(); // 点会话即刷新(G10-C13:计数/最近区即时更新)
        },
        (err: unknown) => {
          setBusy(false);
          setActionError(err instanceof Error ? err.message : String(err));
        },
      );
  }, [conn, markSeen, markJournal, onOpenSession, loadWorkspaces, onOpenLiveSeat]);
  /** SUNX 条目点击链（sunx P3 Task 3 数据源改向）：attachSunx(journalId) 直寻址重开——域定位/
   *  壳铸造/attach 全链在 daemon 单点（不再 newSession(root)+attach 两步）。busy 防双发/已读压戳/
   *  journal 映射回填/onOpenSession 下发与 attachJournal 同拍；root 取应答真根（域旁车 meta.root） */
  const attachSunxJournal = useCallback((journalId: string, journalUpdatedAt?: number): void => {
    if (busyRef.current) return;
    setBusy(true);
    setActionError('');
    conn
      .attachSunx(journalId)
      .then((r) => {
        setBusy(false);
        markSeen(journalId, journalUpdatedAt ?? Date.now());
        markJournal(r.sessionId, journalId);
        onOpenSession(r.sessionId, r.root, journalId, r.kind ?? 'sunx'); // journalId=滚动位存档键;root=域旁车真根;域重开恒 sunx
        loadWorkspaces(); // 点会话即刷新(G10-C13:计数/最近区即时更新)
      }, (err: unknown) => {
        setBusy(false);
        setActionError(errText(err));
      });
  }, [conn, markSeen, markJournal, onOpenSession, loadWorkspaces, onOpenLiveSeat]);
  /** T6 行内归档(确认 morph 由分区组件行级 confirmId 承载):archiveSession 落库后重拉——
   *  组列表计数 + Recents(loadWorkspaces)、归档层列表(loadArchived,置顶行归档时归档层若
   *  开着需即时回显)与展开组会话行(loadSessions,归档行由服务端列表滤除,T2c)。失败经既有
   *  actionError 通道上屏(终审 F4:不再静默,下次 30s/聚焦刷新自愈) */
  const archiveRow = useCallback(
    (id: string, archived: boolean): void => {
      conn.archiveSession(id, archived).then(() => {
        loadWorkspaces();
        loadArchived();
        reloadOpenGroups();
      }, (err: unknown) => setActionError(errText(err)));
    },
    [conn, loadWorkspaces, loadArchived, reloadOpenGroups],
  );

  const unarchiveArchivedRow = useCallback(
    (id: string): void => {
      conn.archiveSession(id, false).then(() => {
        loadArchived();
        loadWorkspaces(); // 撤销即回主列表:组计数/Recents 即时归位
        reloadOpenGroups(); // 已开组会话行即时回行(与 archiveRow 对称)
      }, (err: unknown) => setActionError(errText(err)));
    },
    [conn, loadArchived, loadWorkspaces, reloadOpenGroups],
  );

  /** 置顶簇(行快照入列/撤钉/钉 id 集)收口 use-menu-sections(D62 批J) */
  const { pinSessionRow, unpinRow, pinnedIds } = useMenuPins(pins, persistPins, markSeen);
  /** 归档层红删除(二次确认 morph 后):受控删除会话档全家后重拉归档层/组计数/Recents;
   *  真删时随删钉防悬挂钉,保存失败经 actionError 可见化(与 persistPins 同口径) */
  const deleteArchivedRow = useCallback(
    (id: string): void => {
      conn.deleteSession(id).then(() => {
        loadArchived();
        loadWorkspaces();
        persistPins(pins.filter((p) => p.id !== id)); // 真删防悬挂钉(钉档随会话档清除)
      }, (err: unknown) => setActionError(errText(err)));
    },
    [conn, loadArchived, loadWorkspaces, persistPins, pins],
  );
  const archivedIds = useMemo(() => new Set((archivedRows ?? []).map((r) => r.id)), [archivedRows]);
  /** journal → daemon 运行标注(置顶组非当前会话的运行/待确认态数据源;最近会话为运行中会话的超集) */
  const liveJournals = useMemo(() => {
    const m = new Map<string, { liveSessionId: string; awaiting: boolean }>();
    for (const r of recents ?? []) if (r.liveSessionId !== undefined) m.set(r.id, { liveSessionId: r.liveSessionId, awaiting: r.awaiting === true });
    return m;
  }, [recents]);

  /** 「+ 添加工作区」(G10-C11 + G14.51 收口):桌面壳走 IPC 系统对话框(回全路径);浏览器态
   *  开服务端 DirPicker 逐级浏览——两路都回「既有目录」绝对路径,daemon {path} 分支只登记不建
   *  目录(旧按 name 在 projectsRoot 下 mkdir 的行为废除)。登记后回欢迎页预选该项目。 */
  const pickAndAdd = useCallback((): void => {
    setActionError('');
    const shell = window.sunshinex;
    if (typeof shell?.pickFolder === 'function') {
      void shell.pickFolder().then((p) => {
        if (p === null) return;
        conn
          .createWorkspace({ path: p })
          .then((res) => {
            loadWorkspaces(); // 建项目落位即刷新组列表
            onComposeIn(res.root); // 纯回调无 busy,目标提交即刻可用
          })
          .catch((err: unknown) => setActionError(errText(err)));
      });
      return;
    }
    // G14.69 浏览器态:原生系统文件夹选择(showDirectoryPicker)→ 标记文件定位绝对路径→登记;
    // 取消静默;不支持/权限被拒/定位超时 → 回退自建目录浏览
    void pickWorkspaceFolder((q) => conn.locateWorkspace(q)).then((r) => {
      if (r === null) return;
      if (r !== 'unsupported' && r !== 'denied' && r !== 'timeout') {
        conn
          .createWorkspace({ path: r.path })
          .then((res) => {
            loadWorkspaces();
            onComposeIn(res.root);
          })
          .catch((err: unknown) => setActionError(errText(err)));
        return;
      }
      setDirOpen(true);
    });
  }, [conn, loadWorkspaces, onComposeIn]);
  /** 分区回调簇(2026-11-16 流畅轮:useCallback 恒稳——五 memo 分区的判等面,内联箭头每渲染
   *  换新即全分区每帧重渲) */
  const addWorkspaceFromHead = useCallback((e: ReactMouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    setActionError('');
    pickAndAdd();
  }, [pickAndAdd]);
  const attachSunxFromRow = useCallback((_root: string, journalId: string, updatedAt?: number): void => {
    attachSunxJournal(journalId, updatedAt); // P3 Task 3:条目点击=attachSunx 链(root 参数退役——journalId 直寻址重开)
  }, [attachSunxJournal]);
  /** DirPicker 确认:登记所选既有目录为工作区(同桌面壳后段;已登记幂等) */
  const registerFolder = (p: string): void => {
    setDirOpen(false);
    conn
      .createWorkspace({ path: p })
      .then((res) => {
        loadWorkspaces();
        onComposeIn(res.root);
      })
      .catch((err: unknown) => setActionError(errText(err)));
  };

  /** 新建 Sunx 成功链(sunx P1 Task 6):清单重拉(组计数/Recents 即时归位)+ 既有 openSession
   *  链路打开新会话(回调用经 App 装配——抽屉态自动收抽屉,同 attach 行为) */
  const openCreatedSunx = (sessionId: string, root: string): void => {
    loadWorkspaces();
    setSunxReload((v) => v + 1); // 新实例即时入组(2026-11-16 用户实测;不等 30s tick/手动切换)
    onOpenSession(sessionId, root, undefined, 'sunx'); // 新建链恒 sunx(2026-11-17 首帧定欢迎面)
  };
  /** 分区回调簇(2026-11-16 流畅轮:useCallback 恒稳——五 memo 分区的判等面,内联箭头每渲染
   *  换新即全分区每帧重渲) */
  const toggleProjects = useCallback((): void => setProjectsOpen((v) => !v), []);
  const groupShowMore = useCallback((slug: string): void => {
    setShowAllBySlug((prev) => (prev[slug] === true ? prev : { ...prev, [slug]: true }));
  }, []);
  const openNewSunxDialog = useCallback((): void => setSunxOpen(true), []);

  return (
    <nav className={`sx-menu${props.closing === true ? ' sx-closing' : ''}`} aria-label="projects">
      <header className="sx-menu-head" data-drag-band>
        <span className="sx-brand">Sunshinex</span>
        {/* 2026-10-25 前进/后退(全局导航史):品牌右侧左聚(浏览器/IDE 惯例位);菜单收起时
            由顶栏/欢迎浮出簇接管(宿主 ChatTopbar/Welcome 簇,单点不双显) */}
        {props.nav !== undefined && <NavButtons nav={props.nav} />}
        {/* 2026-10-24 拖拽重构:头部窗拖拽把手=本空白带(品牌字与收起钮的 space-between 空隙,
            margin 安全边两侧避让)——旧「容器 drag+挖孔」在 zoom 下位图错位吞收起钮(实证),
            故当年裁定头部整体退出拖拽区,「菜单头区域拖不动窗」即其代价;空白带几何互斥两全 */}
        <div className="sx-menu-head-drag" data-drag-band aria-hidden="true" />
        {/* 收起钮=原面板展开图标镜像(PanelLeft),菜单头右上;顶栏 [|] 与之互斥不双显。 */}
        <button type="button" aria-label="collapse menu" className="sx-winbtn" data-tip={t('Close menu', '收起菜单')} onClick={props.onCollapse}>
          <PanelLeft size={16} strokeWidth={1.75} />
        </button>
      </header>
      {dirView !== undefined && dirView !== null && onCloseDirView !== undefined ? (
        /* 2026-10-27 用户裁定:目录视图的返回钮占「新对话」位(同款样式槽),根路径文字不显 */
        <button type="button" className="sx-new-chat" aria-label="back to menu" onClick={onCloseDirView}>
          <ArrowLeft size={16} strokeWidth={1.75} />
          <span>{t('Back', '返回')}</span>
        </button>
      ) : (
        <button
          type="button"
          className="sx-new-chat"
          aria-label="new chat"
          onClick={onNewChat}
        >
          <SquarePen size={16} strokeWidth={1.75} />
          <span>{t('New chat', '新对话')}</span>
        </button>
      )}
      {/* 「新建 Sunx」入口与「新对话」真同级(2026-11-15 用户实测反馈;sunx P1 Task 6 的 RECENTS
          头簇小钮撤除——入口只留这一处,RECENTS 头簇保留看板钮)。dirView 态随「新对话/搜索」同隐藏 */}
      {dirView === undefined || dirView === null || onCloseDirView === undefined ? (<button
        type="button"
        className="sx-new-chat"
        aria-label="new sunx"
        onClick={() => setSunxOpen(true)}
      >
        <SunxIcon size={16} strokeWidth={1.75} />
        <span>{t('New Sunx', '新建 Sunx')}</span>
      </button>) : null}
      {/* 定时任务主区页入口(2026-11-20):「新建 Sunx」下方、「搜索」上方;dirView 态随同隐藏 */}
      {onOpenSchedules !== undefined && (dirView === undefined || dirView === null || onCloseDirView === undefined) ? (
        <button
          type="button"
          className="sx-new-chat"
          aria-label="scheduled tasks"
          onClick={onOpenSchedules}
        >
          <Clock size={16} strokeWidth={1.75} />
          <span>{t('Scheduled tasks', '定时任务')}</span>
        </button>
      ) : null}
      {/* 2026-10-24 用户裁定:搜索升级「新对话」同级项(图标+文字;原头部小钮退役) */}
      {dirView === undefined || dirView === null || onCloseDirView === undefined ? (<button
        type="button"
        className="sx-new-chat"
        aria-label="search"
        onClick={() => setSearchOpen((v) => !v)}
      >
        <Search size={16} strokeWidth={1.75} />
        <span>{t('Search', '搜索')}</span>
      </button>) : null}
      {searchOpen && (
        <ProjectSearch
          rows={rows}
          allSessions={allSessions}
          allSunx={sunxRows}
          schedules={schedules}
          searchActions={searchActions}
          query={query}
          onQuery={setQuery}
          onClose={() => setSearchOpen(false)}
          activeSessionId={activeSessionId}
          runningIds={runningIds}
          journalOfSession={journalOfSession}
          busy={busy}
          isUnseen={isUnseen}
          onAttach={attachJournal}
          onComposeIn={onComposeIn}
          onAttachSunx={attachSunxJournal}
          onOpenSchedule={onOpenSchedule}
          onOpenSettingsItem={onOpenSettingsItem}
        />
      )}
            {/* 2026-10-27 目录视图层(用户裁定:目录树从右侧栏挪入左菜单,参考 ZCode):返回+树复用
          DirectoryTab(会话寻址 tree API,sessionId 由 App ensureSession 落值)。整替滚动区内容 */}
      {dirView !== undefined && dirView !== null && onCloseDirView !== undefined ? (
        <div className="sx-dirview">
          {/* 2026-10-29 用户裁定「去掉项目路径行,下面整体上移」:dirview-root 行整行退役——
              工作区名仍在树头行(tree-head-name,FlUppercase)不失项目上下文 */}
          <div className="sx-dirview-body">
            <DirectoryTab
              /* ProjectMenuConn=收窄接口,App 实传整只 Connection(运行时满足 tree/searchTree 面) */
              conn={conn as unknown as Connection}
              sessionId={dirView.sessionId}
              root={dirView.root}
              locate={dirView.locate}
              openTab={(type, params) => {
                // DirectoryTab 已在有 root 时产出绝对路径;此处原样上交(兼容旧相对入参)
                if (type === 'file' && params !== undefined && typeof params.path === 'string') {
                  onOpenFileFromTree?.(params.path, dirView.root);
                }
              }}
            />
          </div>
        </div>
      ) : (
      <>
      {/* G14.9:单一滚动区装 PROJECTS + RECENTS;footer 贴底 */}
      <div className="sx-side-scroll" ref={sideScrollRef}>
        {/* 置顶组(2026-10-21 用户裁定):「项目」上方,不支持折叠;无钉不渲染(PinnedSection 判空) */}
        {!archiveOpen && (
        // SUNX 分组第一段(2026-11-15 用户裁定「SUNX 放在第一行」+「SUNX分组常驻」):空态「暂无Sunx」
        // 归档层开启时不渲染(归档层整替语义)
        <SunxSection
          rows={sunxRows}
          activeSessionId={activeSessionId}
          runningIds={runningIds}
          journalOfSession={journalOfSession}
          isUnseen={isUnseen}
          busy={busy}
          onAttach={attachSunxFromRow}
          onArchiveRow={archiveRow}
          onOpenBoard={props.onOpenSunxBoard}
          onNewSunx={openNewSunxDialog}
          onOpenArchive={() => {
            setArchiveScope('sunx'); // 归档 Sunx 专域(标题/行过滤随域,2026-11-16 用户裁定)
            loadArchived();
            setArchiveOpen(true);
          }}
        />
        )}
        {!archiveOpen && (
        // 通道组(channels Task 13,spec §9.1):SUNX 组邻位(容器域专属组相邻,基础组「项目」之前);
        // 空容器/装载中整块不渲染(组内自守卫);归档层开启不渲染(整替语义同 SUNX 组);
        // 行点击=attachJournal(root, journalId) 直寻址链(行 root=域目录,attach 落在正确的域)
        <ChannelsSection
          rows={channelRows}
          activeSessionId={activeSessionId}
          runningIds={runningIds}
          journalOfSession={journalOfSession}
          isUnseen={isUnseen}
          busy={busy}
          onAttach={attachJournal}
        />
        )}
        <PinnedSection
          pins={pins}
          busy={busy}
          activeSessionId={activeSessionId}
          runningIds={runningIds}
          journalOfSession={journalOfSession}
          isUnseen={isUnseen}
          onOpenSession={attachJournal}
          onUnpin={unpinRow}
          onArchiveRow={archiveRow}
          archivedIds={archivedIds}
          liveJournals={liveJournals}
        />
        <ProjectsSection
          projectsOpen={projectsOpen}
          onToggleProjects={toggleProjects}
          onRemoveWorkspace={removeWorkspace}
          onOpenDirectory={onOpenDirectory}
          branchByRoot={branchByRoot}
          busy={busy}
          archiveMode={archiveOpen}
          archiveScope={archiveScope} // 归档层标题随域(2026-11-16 用户裁定「归档 Sunx ≠ 归档会话」)
          onExitArchive={exitArchiveView}
          onAddWorkspace={addWorkspaceFromHead}
          actionError={actionError}
          rows={rows}
          listError={listError}
          openSlugs={openSlugs}
          showAllBySlug={showAllBySlug}
          onGroupShowMore={groupShowMore}
          sessionsBySlug={sessionsBySlug}
          sessionsErrorBySlug={sessionsErrorBySlug}
          activeRoot={activeRoot}
          activeSessionId={activeSessionId}
          runningIds={runningIds}
          journalOfSession={journalOfSession}
          isUnseen={isUnseen}
          onToggleGroup={toggleGroup}
          onComposeIn={onComposeIn}
          onAttach={attachJournal}
          onArchiveRow={archiveRow}
          onOpenArchived={() => {
            setArchiveScope('session'); // 通用归档层(回归会话域)
            openArchivedWithReload();
          }}
          pinnedIds={pinnedIds}
          onPinRow={pinSessionRow}
        />
        {/* 归档层(2026-10-21 用户裁定):整替 Projects 列表体+Recents——无独立分组,组头 X 退出 */}
        {archiveOpen ? (
          <ArchiveSection
            rows={archivedRows === null ? null : archivedRows.filter((r) => (archiveScope === 'sunx' ? r.kind === 'sunx' : r.kind !== 'sunx'))}
            scope={archiveScope}
            busy={busy}
            onOpenSession={attachJournal}
            onUnarchive={unarchiveArchivedRow}
            onDelete={deleteArchivedRow}
            activeSessionId={activeSessionId}
            runningIds={runningIds}
            journalOfSession={journalOfSession}
          />
        ) : (
          <>
            <RecentsSection
              recentsOpen={recentsOpen}
              onToggleRecents={toggleRecents}
              onNewChat={onNewChat}
              recents={recents}
              recentLimit={recentLimit}
              onShowMore={recentsShowMore}
              onCollapse={recentsCollapse}
              activeSessionId={activeSessionId}
              runningIds={runningIds}
              journalOfSession={journalOfSession}
              isUnseen={isUnseen}
              busy={busy}
              onAttach={attachJournal}
              onArchiveRow={archiveRow}
              pinnedIds={pinnedIds}
              onPinRow={pinSessionRow}
            />
          </>
        )}
        {dirOpen && (
          <div className="modal-overlay" onClick={() => setDirOpen(false)}>
            <div className="modal-body" onClick={(e) => e.stopPropagation()}>
              <DirPicker conn={conn} showManual={false} onCancel={() => setDirOpen(false)} onConfirm={registerFolder} />
            </div>
          </div>
        )}
        {/* 「新建 Sunx」创建弹窗(sunx P1 Task 6):组件全局 portal 到 body,挂载点随 dirOpen 弹层惯例 */}
        {sunxOpen && (
          <NewSunxDialog
            open
            onClose={() => setSunxOpen(false)}
            conn={conn}
            onOpenSession={openCreatedSunx}
          />
        )}
      </div>
      </>
      )}
      <footer className="sx-menu-foot">
        {onOpenSettings !== undefined && (
          <button
            type="button"
            aria-label="open settings"
            className="sx-iconbtn"
            data-tip={t('Settings', '设置')}
            onClick={onOpenSettings}
          >
            <Settings size={18} strokeWidth={1.75} />
          </button>
        )}
      </footer>
    </nav>
  );
}
