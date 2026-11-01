import { Fragment, memo, useContext, useEffect, useState } from 'react';
import { Check, ArrowRight, FileText, Wrench, PenLine, FilePenLine, SquareTerminal, Search, FolderSearch, ChevronRight, Sparkles, Globe, Telescope, Brain, ListTodo, ListChecks, Kanban, Radar, GitBranch, Bot, Square, Hourglass, BookOpen, MessageCircleQuestion, ListPlus, GitMerge, UserPlus, UsersRound, Puzzle, AppWindow, MousePointerClick, Send, ClipboardList, type LucideIcon } from 'lucide-react';
import { t } from '../../i18n';
import { highlightCommand, stripAnsi } from '../../highlight';
import { openExternalUrl, pathBasename } from '../../ui-util';
import type { ChatEntry } from '../../chat-reducer';
import type { Connection } from '../../connection';
import { DiffLines } from '../../diff-lines';
import { FileIcon } from '../../file-icon';
import { ImageLightbox } from '../../ImageLightbox';
import { ImageMissing } from './EntryViews';
import { MdImageContext } from './md-render';
import ReactMarkdown from 'react-markdown';
import { keepUrl, mdComponentsPlain, MD_REHYPE_PLUGINS, MD_REMARK_PLUGINS } from '../Chat';
import { COMPUTER_USE_PREFIX } from './computer-use-contract';
import type { DiffResp } from '../../connection';

/** 工具动词 → 图标(渲染面映射;md 形态不变,未知工具通用件);任务板工具专属图标(去扳手默认) */
const TOOL_ICONS: Record<string, LucideIcon> = {
  read: FileText, write: PenLine, edit: FilePenLine, exec: SquareTerminal, grep: Search, glob: FolderSearch,
  skill: Sparkles, webfetch: Globe, websearch: Telescope, memory: Brain, memory_write: Brain, todo_write: ListTodo,
  worktree: GitBranch, spawn: Bot, task_stop: Square, task_wait: Hourglass, kb_search: BookOpen,
  ask_question: MessageCircleQuestion, // G14.82:问询专属图标(不用扳手)
  create_task: ListPlus, set_dependency: GitMerge, assign: UserPlus, // G14.168 看板工具
  // 建队/建成员同 UsersRound(2026-11-01 用户裁定:创建团队图标与创建成员一致)
  create_team: UsersRound,
  create_teammate: UsersRound,
  update_task: ListChecks, get_board: Kanban, probe: Radar, // 2026-10-31 用户裁定「内置工具还没有完全 i18n 化」:任务板更新/看板读取/探测三件专属图标(退役扳手兜底)
  send_message: Send,
  get_task: ClipboardList,
};

/** 电脑控制类工具(2026-10-27 用户裁定):computer-use server 全族专属图标前缀(MousePointerClick,
 *  区别于通用 MCP 拼图件)——图标标类(含观察件),徽标标进行中的控制;特殊色只归顶栏徽标(2026-10-27
 *  二次裁定:工具行不用特殊色),className 留作语义/查询锚;前缀常量单点在 computer-use-contract
 *  (2026-10-27 技术债轮收敛,与徽标判定面/插件 manifest 三方同源,对拍钉锁镜像) */

/** MCP 工具名拆解单点(2026-10-26 用户裁定:MCP 工具行显业界通用图标+短工具名,参数/返回值同其他工具):
 *  登记名 `mcp__<server>__<tool>` → { server, tool };非 MCP 名返回 null。server 段取首个 `__` 前
 *  (server 键不含 `__`——配置名即文件/清单键),tool 段为余量(可含 `__`) */
export function mcpToolParts(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice(5);
  const i = rest.indexOf('__');
  if (i <= 0 || i >= rest.length - 2) return null;
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

function ToolIcon({ verb }: { verb: string }): JSX.Element {
  // computer-use 全族=鼠标点击件(2026-10-27 二次裁定:无专属色,className 留语义/查询锚)
  if (verb.startsWith(COMPUTER_USE_PREFIX)) {
    return <MousePointerClick size={12} strokeWidth={1.75} className="tool-icon-controlling" aria-hidden="true" />;
  }
  // 浏览器操作全族(browser-use 插件,工具名 browser_*)=浏览器窗件(2026-10-31 用户裁定:
  // 「换成浏览器相关的」——该插件即浏览器专用,通用拼图件不达意;AppWindow 与 webfetch 的
  // Globe 区分:一个是浏览器窗,一个是网页抓取)
  const mcp = mcpToolParts(verb);
  if (mcp !== null && mcp.tool.startsWith('browser_')) {
    return <AppWindow size={12} strokeWidth={1.75} className="tool-icon-browser" aria-hidden="true" />;
  }
  // MCP 工具=Puzzle 拼图件(业界 MCP 集成的通用视觉母题,区别于内置工具的扳手兜底)
  if (mcp !== null) return <Puzzle size={12} strokeWidth={1.75} aria-hidden="true" />;
  const Icon = TOOL_ICONS[verb] ?? Wrench;
  return <Icon size={12} strokeWidth={1.75} aria-hidden="true" />;
}

export interface TodoBatch {
  key: string;
  ts: number;
  goal: string;
  items: Array<{ text: string; status: 'completed' | 'in_progress' | 'pending' }>;
}

/** 工具折叠行动词中文展示单点(en=现有字面,zh=本地化;未登记工具(MCP 引入等)回退原名)。
 *  G14.216 命名口径(用户裁定,替代 G14.213「两字优先」):自然两字且项目既定的保留不动——
 *  读取/写入/执行/查阅/查找/搜索/抓取/停止/取消/分派/提问(工作树为项目自然词);
 *  凑两字而失读性的展开为目标域词,与运行态标签(RUNNING_LABELS)同口径——加载技能、保存记忆、
 *  更新待办、等待任务、检索知识库、创建任务、设置依赖、分派子智能体 */
const TOOL_VERB_ZH: Record<string, string> = {
  read: '读取', write: '写入', edit: '编辑', exec: '执行', grep: '查阅', glob: '查找',
  skill: '加载技能', webfetch: '抓取', websearch: '搜索', memory_write: '保存记忆',
  todo_write: '更新待办', worktree: '工作树', spawn: '分派子智能体', task_stop: '停止',
  task_wait: '等待任务', kb_search: '检索知识库', ask_question: '提问',
  create_task: '创建任务', set_dependency: '设置依赖', assign: '分派',
  create_team: '创建智能体团队',
  create_teammate: '创建智能体团队成员',
  update_task: '更新任务', get_board: '看板', probe: '探测', // 2026-10-31 i18n 补全(看板=项目既定自然词)
  send_message: '发送消息', get_task: '读取任务',
};

/** 中文工具名映射(2026-10-30 用户裁定「操作电脑和浏览器的工具行显中文工具名」):电脑操作
 *  11 工具 + 浏览器操作常用族;未收录回退短名(server 面在展开体/工具清单承载,折叠行不重复) */
/** MCP 工具双语名映射(2026-10-30 用户裁定「档位/强度/工具名走 i18n,不是改成中文」):电脑操作
 *  11 工具 + 浏览器操作常用族;渲染期 t(en, zh) 求值随语言切换;未收录回退短名(server 面在
 *  展开体/工具清单承载,折叠行不重复) */
const MCP_TOOL_LABELS: Record<string, { en: string; zh: string }> = {
  screenshot: { en: 'Screenshot', zh: '截屏' }, click: { en: 'Click', zh: '点击' }, type: { en: 'Type', zh: '输入' }, key: { en: 'Key', zh: '按键' },
  scroll: { en: 'Scroll', zh: '滚动' }, drag: { en: 'Drag', zh: '拖拽' }, app: { en: 'Switch app', zh: '切换应用' },
  uia_snapshot: { en: 'UI snapshot', zh: '界面快照' }, window_list: { en: 'Window list', zh: '窗口列表' },
  wait: { en: 'Wait', zh: '等待' }, wait_for: { en: 'Wait for', zh: '等待至' },
  browser_navigate: { en: 'Open page', zh: '打开网页' }, browser_navigate_back: { en: 'Back', zh: '网页后退' }, browser_navigate_forward: { en: 'Forward', zh: '网页前进' },
  browser_click: { en: 'Click', zh: '点击' }, browser_type: { en: 'Type', zh: '输入' }, browser_press_key: { en: 'Press key', zh: '按键' }, browser_hover: { en: 'Hover', zh: '悬停' },
  browser_drag: { en: 'Drag', zh: '拖拽' }, browser_select: { en: 'Select', zh: '选择' }, browser_fill: { en: 'Fill', zh: '填充' }, browser_snapshot: { en: 'Snapshot', zh: '页面快照' },
  browser_take_screenshot: { en: 'Screenshot', zh: '网页截图' }, browser_screenshot: { en: 'Screenshot', zh: '网页截图' }, browser_evaluate: { en: 'Evaluate', zh: '执行脚本' },
  browser_wait_for: { en: 'Wait for', zh: '等待至' }, browser_check: { en: 'Check', zh: '勾选' }, browser_annotate: { en: 'Annotate', zh: '页面标注' },
  browser_emulate_media: { en: 'Emulate media', zh: '模拟媒体' }, browser_handle_dialog: { en: 'Handle dialog', zh: '处理对话框' }, browser_pdf: { en: 'Export PDF', zh: '导出 PDF' },
  browser_tab_select: { en: 'Select tab', zh: '切换标签' }, browser_tab_new: { en: 'New tab', zh: '新建标签' }, browser_tab_close: { en: 'Close tab', zh: '关闭标签' },
  browser_tab_list: { en: 'Tab list', zh: '标签列表' }, browser_tab_update: { en: 'Update tab', zh: '更新标签' },
  browser_console_messages: { en: 'Console', zh: '读控制台' }, browser_console_clear: { en: 'Clear console', zh: '清控制台' }, browser_network_requests: { en: 'Network requests', zh: '网络请求' },
  browser_cookie_get: { en: 'Get cookie', zh: '读 Cookie' }, browser_cookie_set: { en: 'Set cookie', zh: '设 Cookie' }, browser_cookie_delete: { en: 'Delete cookie', zh: '删 Cookie' },
  browser_cookie_list: { en: 'Cookie list', zh: 'Cookie 列表' }, browser_cookie_clear: { en: 'Clear cookies', zh: '清 Cookie' }, browser_file_upload: { en: 'Upload file', zh: '上传文件' },
  browser_close: { en: 'Close page', zh: '关闭页面' }, browser_resize: { en: 'Resize', zh: '调整窗口' }, browser_install: { en: 'Install browser', zh: '安装浏览器' },
  // browser-use 全族补全(2026-10-31 用户报障「浏览器操作的方法没有完全 i18n」;清单=插件 server 注册面 84 工具)
  browser_find: { en: 'Find', zh: '查找' }, browser_tabs: { en: 'Tabs', zh: '标签管理' }, browser_select_option: { en: 'Select option', zh: '选下拉项' },
  browser_generate_locator: { en: 'Locator', zh: '生成定位器' }, browser_uncheck: { en: 'Uncheck', zh: '取消勾选' }, browser_drop: { en: 'Drop', zh: '拖放' },
  browser_fill_form: { en: 'Fill form', zh: '填表单' }, browser_reload: { en: 'Reload', zh: '刷新页面' }, browser_resume: { en: 'Resume', zh: '恢复执行' },
  browser_highlight: { en: 'Highlight', zh: '高亮元素' }, browser_hide_highlight: { en: 'Clear highlight', zh: '清高亮' },
  browser_get_config: { en: 'Browser config', zh: '读浏览器配置' },
  browser_keydown: { en: 'Key down', zh: '按下' }, browser_keyup: { en: 'Key up', zh: '松开' }, browser_press_sequentially: { en: 'Type keys', zh: '逐键输入' },
  browser_mouse_move_xy: { en: 'Move mouse', zh: '移动鼠标' }, browser_mouse_down: { en: 'Mouse down', zh: '按下鼠标' }, browser_mouse_up: { en: 'Mouse up', zh: '松开鼠标' },
  browser_mouse_wheel: { en: 'Wheel', zh: '滚轮' }, browser_mouse_click_xy: { en: 'Click at', zh: '坐标点击' }, browser_mouse_drag_xy: { en: 'Drag at', zh: '坐标拖拽' },
  browser_network_request: { en: 'Request detail', zh: '看网络请求' }, browser_network_clear: { en: 'Clear network', zh: '清网络记录' }, browser_network_state_set: { en: 'Set network state', zh: '设网络状态' },
  browser_pdf_save: { en: 'Save PDF', zh: '存为 PDF' },
  browser_start_recording: { en: 'Start recording', zh: '开始录制' }, browser_stop_recording: { en: 'Stop recording', zh: '停止录制' },
  browser_start_video: { en: 'Start video', zh: '开始录屏' }, browser_stop_video: { en: 'Stop video', zh: '停止录屏' },
  browser_video_chapter: { en: 'Video chapter', zh: '视频章节' }, browser_video_show_actions: { en: 'Show actions', zh: '显示操作标注' }, browser_video_hide_actions: { en: 'Hide actions', zh: '隐藏操作标注' },
  browser_start_tracing: { en: 'Start tracing', zh: '开始追踪' }, browser_stop_tracing: { en: 'Stop tracing', zh: '停止追踪' },
  browser_route: { en: 'Set route', zh: '设路由拦截' }, browser_route_list: { en: 'Route list', zh: '路由列表' }, browser_unroute: { en: 'Remove route', zh: '撤路由' },
  browser_run_code_unsafe: { en: 'Run code', zh: '运行代码' },
  browser_storage_state: { en: 'Storage state', zh: '读存储状态' }, browser_set_storage_state: { en: 'Set storage state', zh: '设存储状态' },
  browser_verify_element_visible: { en: 'Verify element', zh: '验证元素可见' }, browser_verify_text_visible: { en: 'Verify text', zh: '验证文本可见' },
  browser_verify_list_visible: { en: 'Verify list', zh: '验证列表可见' }, browser_verify_value: { en: 'Verify value', zh: '验证取值' },
  browser_webmcp_list: { en: 'Page MCP list', zh: '列页面 MCP' }, browser_webmcp_call: { en: 'Call page MCP', zh: '调页面 MCP' },
  browser_localstorage_list: { en: 'Local storage list', zh: '列本地存储' }, browser_localstorage_get: { en: 'Get local storage', zh: '读本地存储' },
  browser_localstorage_set: { en: 'Set local storage', zh: '写本地存储' }, browser_localstorage_delete: { en: 'Delete local storage', zh: '删本地存储' }, browser_localstorage_clear: { en: 'Clear local storage', zh: '清本地存储' },
  browser_sessionstorage_list: { en: 'Session storage list', zh: '列会话存储' }, browser_sessionstorage_get: { en: 'Get session storage', zh: '读会话存储' },
  browser_sessionstorage_set: { en: 'Set session storage', zh: '写会话存储' }, browser_sessionstorage_delete: { en: 'Delete session storage', zh: '删会话存储' }, browser_sessionstorage_clear: { en: 'Clear session storage', zh: '清会话存储' },
};

export function zhToolName(name: string): string {
  // MCP 工具显本地化名(t(en, zh) 渲染期求值随语言切换;未收录回退短名;server 面在展开体/工具清单承载)
  const mcp = mcpToolParts(name);
  if (mcp !== null) {
    const pair = MCP_TOOL_LABELS[mcp.tool];
    return pair !== undefined ? t(pair.en, pair.zh) : mcp.tool;
  }
  const zh = TOOL_VERB_ZH[name];
  return zh === undefined ? name : t(name, zh);
}

/** 折叠行目标字段(工具展示元数据同口径):各内置工具取其主字段;换行拍平,超长中段省略。
 *  MCP 工具无固定主字段——入参整体压单行 JSON 摘要(与 exec 命令行同级的目标信息) */
export function toolTargetOf(name: string, input: Record<string, unknown>): string | undefined {
  if (mcpToolParts(name) !== null) {
    const keys = Object.keys(input);
    if (keys.length === 0) return undefined;
    const flat = JSON.stringify(input);
    if (flat.length <= 72) return flat;
    return `${flat.slice(0, 48)}…${flat.slice(-20)}`;
  }
  const key =
    name === 'exec'
      ? 'command'
      : name === 'grep' || name === 'glob'
        ? 'pattern'
        : name === 'websearch'
          ? 'query'
          : name === 'webfetch'
            ? 'url'
            : name === 'skill'
              ? 'id'
              : 'path';
  const v = input[key];
  if (typeof v !== 'string' || v === '') return undefined;
  const flat = (v.split('\n')[0] ?? v).trim();
  if (flat.length <= 72) return flat;
  return `${flat.slice(0, 48)}…${flat.slice(-20)}`;
}

/** 各工具执行中标签(G14.13):「正在…」双语;未知工具回落 正在执行 */
/** 斜杠命令运行态标签外窥(系统提示行三态渲染,EntryViews CommandEntryView 消费) */
export function commandRunningLabel(name: string): string {
  const pair = RUNNING_LABELS[name] ?? ['Running', '正在执行'];
  return t(pair[0], pair[1]);
}

const RUNNING_LABELS: Record<string, [string, string]> = {
  // 斜杠命令三态行(2026-10-31 用户裁定「命令执行与工具行三态一致」):/cmd 名即工具名
  '/compact': ['Compacting context', '上下文压缩中'],
  '/status': ['Querying status', '查询状态'],
  '/context': ['Inspecting context', '检查上下文'],
  '/skills-rm': ['Removing learned skill', '删除学习技能'],
  '/memory-on': ['Enabling memory', '开启记忆'],
  '/memory-off': ['Disabling memory', '关闭记忆'],
  '/archive': ['Archiving session', '归档会话'],
  '/unarchive': ['Unarchiving session', '取消归档'],
  '/delete': ['Deleting session', '删除会话'],
  '/plan': ['Preparing plan', '准备计划'],
  read: ['Reading file', '正在读取文件'],
  write: ['Writing file', '正在写入'],
  edit: ['Editing file', '正在编辑'],
  exec: ['Running command', '正在执行'],
  glob: ['Searching files', '正在搜索文件'],
  grep: ['Searching', '正在搜索'],
  skill: ['Loading skill', '正在加载技能'],
  webfetch: ['Fetching page', '正在抓取网页'],
  websearch: ['Searching the web', '正在搜索网页'],
  memory_write: ['Saving memory', '正在保存记忆'],
  spawn: ['Dispatching subagent', '正在分派子智能体'],
  create_teammate: ['Creating teammate', '正在创建智能体团队成员'],
  create_team: ['Creating team', '正在创建智能体团队'],
  update_task: ['Updating task', '正在更新任务'], get_board: ['Reading board', '正在读取看板'], probe: ['Probing', '正在探测'], // 2026-10-31 i18n 补全
  send_message: ['Sending message', '正在发送消息'], get_task: ['Reading task', '正在读取任务'],
  task_wait: ['Waiting for tasks', '正在等待任务'],
  task_stop: ['Stopping task', '正在停止任务'],
  todo_write: ['Updating todos', '正在更新待办'],
  worktree: ['Preparing worktree', '正在准备工作树'],
  kb_search: ['Searching knowledge base', '正在检索知识库'],
  ask_question: ['Waiting for answer', '正在等待回答'],
  create_task: ['Creating task', '正在创建任务'],
  set_dependency: ['Setting dependency', '正在设置依赖'],
  assign: ['Assigning task', '正在分派任务'],
};

/** 单 taskId 工具集合（折叠行/运行态带任务名；task_wait 已单列）：入参均含 taskId 字符串，
 *  折叠行默认分型只出动词——任务名经 taskNameOf 单点解析后跟行 */
const TASK_OP_TOOLS = new Set(['task_stop', 'update_task', 'assign', 'set_dependency', 'get_task']);

/** G14.214 运行态动词对（拼接任务名替代泛文案，仿 spawn G14.166 先例）；折叠行动词走 zhToolName 既有映射 */
const TASK_OP_RUNNING: Record<string, [string, string]> = {
  task_stop: ['Stopping', '正在停止'],
  update_task: ['Updating', '正在更新'],
  assign: ['Assigning', '正在分派'],
  set_dependency: ['Setting dependency of', '正在设置依赖'],
  get_task: ['Reading task', '正在读取任务'],
};

/** 文件行拆分(G14.8):basename + 所在目录(恒显,根目录 = './')——文件名后永远看得到位置 */
export function fileLabelOf(path: string): { base: string; dir: string } {
  const norm = path.replace(/\\/g, '/');
  const base = pathBasename(norm);
  const dir = norm.slice(0, norm.length - base.length);
  return { base, dir }; // 根目录文件 dir = ''(名称即相对路径,不重复显示)
}

/** write/edit 结果首行 `written/edited +3 -1` → diff stat 拆分(G14 底层同源;前缀无关,认 +N -M 形);无 stat 回空 */
export function writeStatOf(result: string): { added?: string; removed?: string } {
  const m = /\+(\d+) -(\d+)/.exec(result);
  return m === null ? {} : { added: `+${m[1]}`, removed: `-${m[2]}` };
}

/** G6 工具条目(折叠态一行/点击展开):write/edit 两件(call 名判定——事件 text 即
 *  注册名)展开接 G7 fetchDiff(oldStr=oldContent/newStr=newContent 双列;加载期先示右列现内容
 *  +加载标,404/失败退 input 侧兜底——write=newContent/edit=oldString→newString 替换对;
 *  快照种子条/无 callId 面恒兜底列)+ path 文本按钮(G8d 起
 *  callId 在场优先 onOpenDiff 开 diff 标签,缺场回落 onOpenFile 文件标签预览);其他工具展开
 *  Input/Output 双段(G11 §2:input JSON + result 全文,各段 280px 内滚)。P11 T7 字段单源:
 *  name/input/result/status 直映 entry 字段(旁路 info prop 随工具 input 暂存退役——G6 双通道
 *  归一),md 解析全数退役。折叠壳 grid 化(0fr→1fr 生长):展开面常挂 DOM,折叠仅 CSS 收起。 */
/** P1 行级 memo(Task 3):entry 身份由 chat-reducer WeakMap 视图缓存保证(未变行引用恒定),
 *  MessageList 侧回调经 ref 稳定化——token 帧重渲染时本组件 props 全等即 bail-out,
 *  行体(含 exec 高亮 highlightCode 调用)零执行。导出名不变(AgentTranscriptTab 等消费面无感) */
/** read 图片行展开体(2026-10-27 用户裁定):点击展开时按路径经 MdImageContext 重读图片——
 *  不依赖 result 帧随行 images(切会话回放即丢,曾「切会话后无法再次显示」),随时可显;
 *  裸显无框无底/与其他展开行左缘对齐/contain 保比例高 240 不越行宽/点击开灯箱缩放 */
/** 工具行图片缩略(2026-10-31 用户裁定「工具下拉中的内部图片要渲染;原图删除渲染占位」):
 *  dataURL 直显;本地文件地址(截屏落盘 images-cache 后档内即地址)经 MdImageContext loader
 *  取回 dataURL;失败渲染同位占位图标识(默认缩略尺寸,不显破图) */
function ToolImageThumb({ src, onOpen }: { src: string; onOpen: (src: string) => void }): JSX.Element {
  const loader = useContext(MdImageContext);
  const [resolved, setResolved] = useState<string | null>(src.startsWith('data:') || /^https?:/i.test(src) ? src : null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (src.startsWith('data:') || /^https?:/i.test(src) || loader === null) return;
    let alive = true;
    void loader(src).then(
      (f) => {
        if (!alive) return;
        if (f.type === 'image' && f.mime !== undefined && f.data !== undefined) setResolved(`data:${f.mime};base64,${f.data}`);
        else setFailed(true);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [src, loader]);
  if (failed) return <ImageMissing name={src} size={120} />;
  if (resolved === null) return <span style={{ width: 120, height: 72, display: 'inline-block', borderRadius: 'var(--radius-sm)', border: '1px dashed var(--border)' }} aria-hidden="true" />;
  return (
    <img
      src={resolved}
      alt={t('Tool image', '工具图片')}
      className="tool-image-thumb"
      /* 原始长宽比同比缩小(2026-10-31 用户裁定「保持原始长宽比,同比缩小,不超过工具行宽度」):
         width/height auto + maxWidth 100% + maxHeight 240(与 ReadImageBody 展开体同口径) */
      style={{ width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: 240, objectFit: 'contain' }}
      onClick={() => onOpen(resolved)}
    />
  );
}

function ReadImageBody({ path }: { path: string }): JSX.Element {
  const loader = useContext(MdImageContext);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [lightbox, setLightbox] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (loader === null) return;
    let alive = true;
    void loader(path).then(
      (f) => {
        if (!alive) return;
        if (f.type === 'image' && f.mime !== undefined && f.data !== undefined) setSrc(`data:${f.mime};base64,${f.data}`);
        else setFailed(true);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [loader, path]);
  if (src !== null) {
    return (
      <div className="tool-image-plain">
        <img src={src} alt="" onClick={() => setLightbox(src)} />
        {lightbox !== undefined && <ImageLightbox src={lightbox} onClose={() => setLightbox(undefined)} />}
      </div>
    );
  }
  if (failed) return <span className="tool-image-miss">{t('image unavailable', '图片不可用')}</span>;
  return <span className="tool-image-miss">{t('loading image…', '图片加载中…')}</span>;
}

export const ToolEntryView = memo(function ToolEntryView({
  entry,
  conn,
  sessionId,
  callId,
  onOpenFile,
  onOpenDiff,
  onOpenAgent,
  onOpenTask,
  taskNameOf,
  teamNameOf,
  teams,
}: {
  entry: ChatEntry;
  conn: Connection;
  sessionId: string;
  callId?: string;
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (callId: string, path: string) => void;
  /** G14.171 spawn 行子智能体名=蓝色链接,点开对应 agent 只读标签页(App 注入 openTabInSession) */
  onOpenAgent?: (label: string, agentTitle: string, task?: string) => void;
  /** 任务名/队名链接:任务 ref 开板高亮;`team:` 前缀开指定队卡(App 注入 openTaskFocus) */
  onOpenTask?: (taskRef: string) => void;
  /** G14.172 task_wait 行任务名解析(App 注入:board+转录映射单点;缺省显示原 id) */
  taskNameOf?: (id: string) => string;
  /** 队名解析(get_board/create_team;缺省显示原 ref) */
  teamNameOf?: (ref: string) => string;
  /** 会话团队清单(get_board 单队回落队名) */
  teams?: readonly { teamId: string; name: string }[];
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  /** 2026-10-26 三期 §4.5:快照分页剥 result.full——展开且缺 full 时按 seq 单条拉观测端点;
   *  ''=已拉且无 full(回落 text),undefined=未拉。live 帧自带 full 不触发 */
  const [fetchedFull, setFetchedFull] = useState<string | undefined>(undefined);
  /** G7 diff 拉取态:undefined=未拉/在途(null 前先示右列现内容);null=拉取失败(退单列现内容);
   *  对象=成功(diff2html 面板)。拉一次缓存——折叠再展开不重拉 */
  const [diff, setDiff] = useState<DiffResp | null | undefined>(undefined);
  /** 工具结果图片查看浮层(2026-10-26 插件体系图片通道;组件自持——ToolEntryView 主对话/agents
   *  页签两消费面无差别直用,不依赖页级回调接线)。undefined=关;关闭即清(浮层卸载) */
  const [lightbox, setLightbox] = useState<string | undefined>(undefined);
  // P11 T7 渲染中立:字段单源(entry.name/input/result/status 直映)——md 首行解析与旁路 info
  // 双通道全退役,渲染记号与截断全是本组件职责
  const toolName = entry.name ?? '';
  const input: Record<string, unknown> = entry.input ?? {};
  const entrySeq = entry.key.startsWith('k') ? Number(entry.key.slice(1)) : NaN;
  useEffect(() => {
    if (!expanded || fetchedFull !== undefined) return;
    if (entry.result?.full !== undefined || !Number.isInteger(entrySeq) || entrySeq <= 0) return;
    if (typeof conn.fetchObservation !== 'function') return; // 测试桩/旧 daemon:优雅回落 text
    let alive = true;
    void conn.fetchObservation(sessionId, entrySeq).then(
      (o) => {
        if (alive) setFetchedFull(o.full ?? '');
      },
      () => {
        if (alive) setFetchedFull('');
      },
    );
    return () => {
      alive = false;
    };
  }, [expanded, entrySeq, fetchedFull, entry.result?.full, conn, sessionId]);
  const resultText = entry.result?.full ?? (expanded ? fetchedFull : undefined) ?? entry.result?.text ?? '';
  const path = typeof input.path === 'string' && input.path !== '' ? input.path : undefined;
  const command = toolName === 'exec' && typeof input.command === 'string' && input.command !== '' ? input.command : undefined;
  const target = toolTargetOf(toolName, input);
  /** 文件写入/编辑分型(G14):折叠=文件名+相对路径+diff stat,展开=diff 面板;read 分型:整行=打开文件标签 */
  const isWrite = (toolName === 'write' || toolName === 'edit') && path !== undefined;
  const isRead = toolName === 'read' && path !== undefined && onOpenFile !== undefined;
  /** read 图片分型(2026-10-27):结果只是 [image] 说明——行=可折叠展开(展开体重读图片显),
   *  普通 read 文件行维持「整行=打开文件标签」既有面 */
  const isReadImage = toolName === 'read' && path !== undefined && resultText.trim().startsWith('[image]');
  const fileLabel = path !== undefined ? fileLabelOf(path) : undefined;
  const stat = isWrite ? writeStatOf(resultText) : {};
  /** G14.171 spawn 子智能体名(label ?? agent_id)——运行态文案与折叠行链接共用 */
  const spawnAgentName =
    toolName === 'spawn'
      ? typeof input.label === 'string' && input.label !== ''
        ? input.label
        : typeof input.agent_id === 'string'
          ? input.agent_id
          : ''
      : '';
  /** 2026-10-24 create_teammate 队友名(name 必填)——与 spawn 同款:运行态文案+折叠行蓝色链接 */
  const teammateName =
    toolName === 'create_teammate' && typeof input.name === 'string' && input.name !== '' ? input.name : '';
  /** create_team 队名——折叠行「创建智能体团队 {name}」;运行态同构 */
  const teamName =
    toolName === 'create_team' && typeof input.name === 'string' && input.name !== '' ? input.name : '';
  /** send_message 收件人与正文(展开体显示正文;折叠行只跟收件人名) */
  const messageTo =
    toolName === 'send_message' && typeof input.to === 'string' && input.to !== '' ? input.to : '';
  const messageText =
    toolName === 'send_message' && typeof input.text === 'string' ? input.text : '';
  /** G14.172 task_wait 折叠行任务名(taskNameOf 单点解析)——用户裁决「等待任务显示任务名称,不要用 id」;保留 id 供链接定位 */
  const waitTasks = toolName === 'task_wait'
    ? (Array.isArray(input.taskIds) ? (input.taskIds as unknown[]) : [])
        .filter((x): x is string => typeof x === 'string' && x !== '')
        .map((id) => ({ id, name: taskNameOf !== undefined ? taskNameOf(id) : id }))
    : [];
  /** get_board 折叠行队名:回执 team=… 去重 → 队名解析;无 team 行且会话仅一队时回落该队 */
  const boardTeamRefs = (() => {
    if (toolName !== 'get_board') return [] as Array<{ ref: string; name: string }>;
    const ids = [...new Set([...resultText.matchAll(/\bteam=([^\s\]]+)/g)].map((m) => m[1]!))];
    if (ids.length > 0) {
      return ids.map((id) => ({ ref: id, name: teamNameOf !== undefined ? teamNameOf(id) : id }));
    }
    if (teams !== undefined && teams.length === 1) {
      const only = teams[0]!;
      return [{ ref: only.teamId, name: only.name !== '' ? only.name : only.teamId }];
    }
    return [] as Array<{ ref: string; name: string }>;
  })();
  /** G14.214 task_* 折叠行/运行态任务名：input.taskId 经 taskNameOf 单点解析（board 直查→转录映射→短 id 兜底，
   *  与 task_wait G14.172 同口径）；set_dependency 额外解析 dependsOn（「任务 ← 依赖目标」双名）。
   *  缺 taskId/解析器（测试桩、种子条旧格式）不进该分型，回落默认动词行 */
  const taskOpName = (() => {
    if (!TASK_OP_TOOLS.has(toolName)) return undefined;
    const id = typeof input.taskId === 'string' && input.taskId !== '' ? input.taskId : undefined;
    if (id === undefined) return undefined;
    // task_stop 完成态优先取回执 label（后台任务 id 不在 board/转录面，taskNameOf 只剩短 id 兜底——
    // 回执行 `task <id> stopped (<label>)` 携带真实名）；未完成/无 label 落 taskNameOf 链
    if (toolName === 'task_stop') {
      const m = new RegExp(`task ${id} stopped \\((.*)\\)`).exec(resultText);
      if (m !== null && m[1] !== '') return m[1]!;
    }
    return taskNameOf !== undefined ? taskNameOf(id) : id;
  })();
  const taskOpDepName = (() => {
    if (toolName !== 'set_dependency') return undefined;
    const id = typeof input.dependsOn === 'string' && input.dependsOn !== '' ? input.dependsOn : undefined;
    if (id === undefined) return undefined;
    return taskNameOf !== undefined ? taskNameOf(id) : id;
  })();
  /** P11 全工具双态:executing 读三态 status(md 占位 `…` 判定退役)——pending/running=执行中
   *  (流光+「正在…」),done(缺省终态)=各型折叠行 */
  const executing = entry.status === 'pending' || entry.status === 'running';
  const runningLabel = (() => {
    // G14.166 spawn 运行态带子智能体名(label ?? agent_id)——「正在分派 架构分析」替代泛文案
    if (toolName === 'spawn' && spawnAgentName !== '') return t(`Dispatching ${spawnAgentName}`, `正在分派 ${spawnAgentName}`);
    // 2026-10-24 create_teammate 运行态带队友名(与 spawn 同构)
    if (toolName === 'create_teammate' && teammateName !== '') return t(`Creating teammate ${teammateName}`, `正在创建智能体团队成员 ${teammateName}`);
    if (toolName === 'create_team' && teamName !== '') return t(`Creating team ${teamName}`, `正在创建智能体团队 ${teamName}`);
    if (toolName === 'send_message' && messageTo !== '') return t(`Sending message to ${messageTo}`, `正在发送消息给 ${messageTo}`);
    // create_task 运行态带任务标题——「正在创建任务 调研项目结构」,id 不进折叠行
    if (toolName === 'create_task' && typeof input.title === 'string' && input.title !== '') {
      return t(`Creating task ${input.title}`, `正在创建任务 ${input.title}`);
    }
    // G14.2xx skill 运行态带技能名(与完成态「加载技能 xxx」同构,回溯前后显示一致)
    if (toolName === 'skill' && target !== undefined) return t(`Loading skill ${target}`, `正在加载技能 ${target}`);
    // task_* 运行态带任务名——「正在更新 架构评审」替代泛文案（taskOpName 已在场即有值）
    const opPair = taskOpName !== undefined ? TASK_OP_RUNNING[toolName] : undefined;
    if (opPair !== undefined) return t(`${opPair[0]} ${taskOpName}`, `${opPair[1]} ${taskOpName}`);
    // 2026-10-26 MCP 工具运行态带本地化工具名——「正在调用 截屏」(双语对随语言切换,与完成态同口径)
    const mcp = mcpToolParts(toolName);
    // 运行态带本地化工具名(2026-10-30 用户裁定;双语对渲染期求值)
    if (mcp !== null) {
      const pair = MCP_TOOL_LABELS[mcp.tool];
      return pair !== undefined
        ? t(`Calling ${pair.en}`, `正在调用 ${pair.zh}`)
        : t(`Calling ${mcp.tool}`, `正在调用 ${mcp.tool}`);
    }
    const pair = RUNNING_LABELS[toolName] ?? ['Running', '正在执行'];
    return t(pair[0], pair[1]);
  })();
  /** 展开面全文=resultText(entry.result full 全量观测优先,text 兜底——旁路 info 通道退役) */
  const fullResult = resultText;
  /** G14.82 ask_question 结构化问答体:问题+选项(✓ 选中)+用户回答(选/自定义/跳过),替代原始 I/O */
  const askInput: { question: string; options: Array<{ label: string; description?: string }> } | null =
    toolName === 'ask_question'
      ? (typeof input.question === 'string'
          ? {
              question: input.question,
              options: Array.isArray(input.options)
                ? input.options.map((o) => {
                    const ob = (o ?? {}) as { label?: unknown; description?: unknown };
                    const label = String(ob.label ?? '').trim();
                    const description = typeof ob.description === 'string' && ob.description.trim() !== '' ? ob.description.trim() : undefined;
                    return description !== undefined ? { label, description } : { label };
                  })
                : [],
            }
          : null)
      : null;
  const askAnswer = (() => {
    const r = fullResult.trim();
    if (r === '' || r === '…') return { kind: 'pending' as const };
    if (r.startsWith('answers: ')) return { kind: 'answers' as const, labels: r.slice(9).split('; ').map((x) => x.trim()) };
    if (r.startsWith('answer: ')) return { kind: 'answer' as const, labels: [r.slice(8).trim()] };
    if (r.startsWith('custom: ')) return { kind: 'custom' as const, text: r.slice(8).trim() };
    return { kind: 'dismissed' as const };
  })();


  /** 展开且可寻址(callId 在场——无 callId 面不拉)即异步拉 diff;折叠即弃在途应答
   *  (面板已不在场),重展开重拉;已缓存(diff≠undefined)不重拉 */
  useEffect(() => {
    if (!expanded || isWrite !== true || diff !== undefined) return;
    if (callId === undefined && path === undefined) return; // 两无:无从寻快照(理论不可达)
    // G14.4:种子回放行无 callId——占位 id + path 随参,daemon 按 journal snapshots 行回退真 pre-image
    const cid = callId ?? 'replay';
    let alive = true;
    conn.fetchDiff(sessionId, cid, path).then(
      (d) => {
        if (alive) setDiff(d);
      },
      () => {
        if (alive) setDiff(null); // 404 无快照/会话已回收等——退单列现内容
      },
    );
    return () => {
      alive = false;
    };
  }, [expanded, isWrite, callId, diff, conn, sessionId]);

  /** 折叠行主体(G14 分型;2026-10-22 用户裁定:运行态=流光动词标签+目标内容同行——spawn/skill/
 *  taskOp 的流光标签已含目标名故不重示):文件工具=文件名+相对路径(+stat);exec=完整命令;其余=动词+目标 */
  const createTaskTitle = toolName === 'create_task' && typeof input.title === 'string' ? input.title : '';
  const hideTargetWhileRunning = executing && (
    toolName === 'spawn' || toolName === 'create_teammate' || toolName === 'create_team'
    || toolName === 'send_message'
    || (toolName === 'create_task' && createTaskTitle !== '')
    || toolName === 'skill' || taskOpName !== undefined
  );
  const verbSpan = executing ? (
    // G14.88 纯流光文字(去工具图标+波纹框——双图标视感,用户裁定)
    <span className="tool-verb exec-running">
      <span className="exec-running-text">{runningLabel}</span>
    </span>
  ) : toolName === 'ask_question' ? (
    <span className="tool-verb">{t('ask', '提问')}</span>
  ) : toolName === 'todo_write' ? (
    <span className="tool-verb">{t('todo', '待办')}</span>
  ) : toolName === 'spawn' ? (
    <span className="tool-verb">{t('spawn', '分派子智能体')}</span>
  ) : toolName === 'task_wait' ? (
    <span className="tool-verb">{t('task_wait', '等待任务')}</span>
  ) : (
    <span className="tool-verb">{zhToolName(toolName)}</span>
  );
  const collapsed = (
    <>
      {verbSpan}
      {path !== undefined && (isWrite || toolName === 'read') ? (
        <>
          {/* G14.4 行序:动词+文件图标+文件名+相对路径(+stat);结果不进折叠行 */}
          {' '}
          <FileIcon path={path} />
          {' '}
          {(isWrite || toolName === 'read') && onOpenFile !== undefined ? (
            <span
              role="button"
              tabIndex={-1}
              className="tool-file-base tool-file-link"
              data-tip={t('Open in file tab', '在文件标签预览')}
              onClick={(e) => {
                e.stopPropagation();
                onOpenFile(path);
              }}
            >
              {fileLabel!.base}
              {fileLabel!.dir !== '' && <span className="tool-file-rel">{' '}{fileLabel!.dir}</span>}
            </span>
          ) : (
            <>
              <span className="tool-file-base">{fileLabel!.base}</span>
              {fileLabel!.dir !== '' && <span className="tool-file-rel">{' '}{fileLabel!.dir}</span>}
            </>
          )}
          {isWrite && stat.added !== undefined && <span className="tool-stat tool-stat-add">{' '}{stat.added}</span>}
          {isWrite && stat.removed !== undefined && <span className="tool-stat tool-stat-del">{' '}{stat.removed}</span>}
        </>
      ) : !hideTargetWhileRunning && toolName === 'ask_question' ? (
        /* G14.82:折叠行直接示问题文本(问询即内容,非动词+目标) */
        <span className="tool-file-base tool-cmd">{' '}{typeof input.question === 'string' ? input.question : ''}</span>
      ) : !hideTargetWhileRunning && toolName === 'todo_write' ? (
        /* G14.138 折叠行本地化;G14.199 格式「待办 {完成}/{总数}」(对号去除,用户裁定) */
        (() => {
          const arr = Array.isArray(input.todos) ? (input.todos as Array<Record<string, unknown>>) : [];
          const done = arr.filter((o) => (o ?? {}).status === 'completed').length;
          return <span className="tool-file-base tool-cmd">{' '}{done}/{arr.length}</span>;
        })()
      ) : !hideTargetWhileRunning && toolName === 'create_team' ? (
        /* 折叠行「创建智能体团队 {name}」——队名蓝色链接开指定队卡 */
        teamName !== '' && onOpenTask !== undefined ? (
          <span
            role="button"
            tabIndex={-1}
            className="tool-file-base tool-agent-link"
            data-tip={t('Open team board', '打开该团队任务板')}
            onClick={(e) => {
              e.stopPropagation();
              const idHit = /teamId=([^\s);,]+)/.exec(resultText);
              onOpenTask(`team:${idHit !== null ? idHit[1]! : teamName}`);
            }}
          >
            {' '}{teamName}
          </span>
        ) : (
          <span className="tool-file-base tool-cmd">{teamName !== '' ? ` ${teamName}` : ''}</span>
        )
      ) : !hideTargetWhileRunning && toolName === 'get_board' ? (
        /* 看板后跟队名链接(回执 team= 解析);点开指定队卡;多链接均分省略 */
        boardTeamRefs.length > 0 && onOpenTask !== undefined ? (
          <span className="tool-link-list">
            {boardTeamRefs.map((team, i) => (
              <Fragment key={`${team.ref}:${i}`}>
                {i > 0 ? <span className="tool-link-sep" aria-hidden="true">, </span> : null}
                <span
                  role="button"
                  tabIndex={-1}
                  className="tool-file-base tool-agent-link tool-link-chip"
                  data-tip={t('Open team board', '打开该团队任务板')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenTask(`team:${team.ref}`);
                  }}
                >
                  {team.name}
                </span>
              </Fragment>
            ))}
          </span>
        ) : boardTeamRefs.length > 0 ? (
          <span className="tool-file-base tool-cmd">{' '}{boardTeamRefs.map((x) => x.name).join(', ')}</span>
        ) : null
      ) : !hideTargetWhileRunning && toolName === 'create_task' ? (
        /* G14.168 折叠行带任务名;G14.176 任务名=蓝色链接,点开任务板定位高亮对应卡 */
        onOpenTask !== undefined && typeof input.title === 'string' && input.title !== '' ? (
          <span
            role="button"
            tabIndex={-1}
            className="tool-file-base tool-agent-link"
            data-tip={t('Open task board card', '在任务板中定位')}
            onClick={(e) => {
              e.stopPropagation();
              // 回执名优先形态 `task "…" created (id=task-xxx)`——按 id= 取真 id,旧形态兜底
              const created = /id=(\S+)/.exec(resultText) ?? /task (\S+) created/.exec(resultText);
              const id = created !== null ? created[1]!.replace(/[);,].*$/, '') : (input.title as string);
              onOpenTask(id);
            }}
          >
            {' '}{input.title}
          </span>
        ) : (
          <span className="tool-file-base tool-cmd">
            {typeof input.title === 'string' ? ` ${input.title}` : ''}
          </span>
        )
      ) : !hideTargetWhileRunning && toolName === 'spawn' ? (
        /* G14.166 折叠行带子智能体名(G14.171:蓝色链接,点开对应 agent 只读标签页) */
        spawnAgentName !== '' && onOpenAgent !== undefined ? (
          <span
            role="button"
            tabIndex={-1}
            className="tool-file-base tool-agent-link"
            data-tip={t('View subagent', '查看子智能体')}
            onClick={(e) => {
              e.stopPropagation(); // 不触发行展开
              // 2026-10-25 用户裁定:任务说明禁止截断——fork 型子智能体无 taskBand,页签任务带即此
              // prompt,截断即「任务说明被拦腰砍」(展示文本=开档参数全量,模型侧本就全量)
              onOpenAgent(spawnAgentName, spawnAgentName, typeof input.prompt === 'string' ? input.prompt : undefined);
            }}
          >
            {' '}{spawnAgentName}
          </span>
        ) : (
          <span className="tool-file-base tool-cmd">{spawnAgentName !== '' ? ` ${spawnAgentName}` : ''}</span>
        )
      ) : !hideTargetWhileRunning && toolName === 'create_teammate' ? (
        /* 2026-10-24 折叠行带队友名(蓝色链接同 spawn,点开对应 agent 只读标签页) */
        teammateName !== '' && onOpenAgent !== undefined ? (
          <span
            role="button"
            tabIndex={-1}
            className="tool-file-base tool-agent-link"
            data-tip={t('View teammate', '查看队友')}
            onClick={(e) => {
              e.stopPropagation(); // 不触发行展开
              onOpenAgent(teammateName, teammateName, typeof input.prompt === 'string' ? input.prompt : undefined); // 任务说明不截断(同 spawn,2026-10-25 裁定)
            }}
          >
            {' '}{teammateName}
          </span>
        ) : (
          <span className="tool-file-base tool-cmd">{teammateName !== '' ? ` ${teammateName}` : ''}</span>
        )
      ) : !hideTargetWhileRunning && toolName === 'send_message' ? (
        /* 折叠行带收件人名(lead 纯文本;队友名可点开转录);正文进展开体 */
        messageTo !== '' && messageTo !== 'lead' && onOpenAgent !== undefined ? (
          <span
            role="button"
            tabIndex={-1}
            className="tool-file-base tool-agent-link"
            data-tip={t('View teammate', '查看队友')}
            onClick={(e) => {
              e.stopPropagation();
              onOpenAgent(messageTo, messageTo);
            }}
          >
            {' '}{messageTo}
          </span>
        ) : (
          <span className="tool-file-base tool-cmd">{messageTo !== '' ? ` ${messageTo}` : ''}</span>
        )
      ) : !hideTargetWhileRunning && toolName === 'task_wait' ? (
        /* G14.167 折叠行带等待任务名(链接开板高亮;null=等全部在跑);多链接均分省略 */
        waitTasks.length > 0 && onOpenTask !== undefined ? (
          <span className="tool-link-list">
            {waitTasks.map((task, i) => (
              <Fragment key={`${task.id}:${i}`}>
                {i > 0 ? <span className="tool-link-sep" aria-hidden="true">, </span> : null}
                <span
                  role="button"
                  tabIndex={-1}
                  className="tool-file-base tool-agent-link tool-link-chip"
                  data-tip={t('Open task board card', '在任务板中定位')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenTask(task.id);
                  }}
                >
                  {task.name}
                </span>
              </Fragment>
            ))}
          </span>
        ) : (
          <span className="tool-file-base tool-cmd">
            {' '}
            {waitTasks.length > 0
              ? waitTasks.map((x) => x.name).join(', ')
              : Array.isArray(input.taskIds)
                ? ''
                : t('all background tasks', '全部后台任务')}
          </span>
        )
      ) : !hideTargetWhileRunning && taskOpName !== undefined ? (
        /* G14.214 task_* 折叠行带任务名(链接开板高亮;set_dependency 双名「任务 ← 依赖目标」);多链接均分省略 */
        onOpenTask !== undefined ? (
          <span className="tool-link-list">
            <span
              role="button"
              tabIndex={-1}
              className="tool-file-base tool-agent-link tool-link-chip"
              data-tip={t('Open task board card', '在任务板中定位')}
              onClick={(e) => {
                e.stopPropagation();
                const id = typeof input.taskId === 'string' ? input.taskId : taskOpName;
                onOpenTask(id);
              }}
            >
              {taskOpName}
            </span>
            {taskOpDepName !== undefined && (
              <>
                <span className="tool-link-sep" aria-hidden="true"> ← </span>
                <span
                  role="button"
                  tabIndex={-1}
                  className="tool-file-base tool-agent-link tool-link-chip"
                  data-tip={t('Open task board card', '在任务板中定位')}
                  onClick={(e) => {
                    e.stopPropagation();
                    const id = typeof input.dependsOn === 'string' ? input.dependsOn : taskOpDepName;
                    onOpenTask(id);
                  }}
                >
                  {taskOpDepName}
                </span>
              </>
            )}
            {toolName === 'assign' && typeof input.assignee === 'string' && input.assignee !== '' && onOpenAgent !== undefined && (
              <>
                <span className="tool-link-sep" aria-hidden="true"> · </span>
                <span
                  role="button"
                  tabIndex={-1}
                  className="tool-file-base tool-agent-link tool-link-chip"
                  data-tip={t('View teammate', '查看队友')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenAgent(input.assignee as string, input.assignee as string);
                  }}
                >
                  {input.assignee as string}
                </span>
              </>
            )}
          </span>
        ) : (
          <span className="tool-file-base tool-cmd">
            {' '}{taskOpName}
            {taskOpDepName !== undefined && ` ← ${taskOpDepName}`}
          </span>
        )
      ) : command !== undefined ? (
        /* G14.50:展开态不重复命令文本(下方 $ 行已完整示出) */
        <span className="tool-file-base tool-cmd">{' '}{command}</span>
      ) : !hideTargetWhileRunning && target !== undefined ? (
        /* G14.168 目标字段(MCP 等未登记工具回退原名+目标) */
        <span className="tool-file-base tool-cmd">{' '}{target}</span>
      ) : null}
    </>
  );

  /** 展开面主体(G14 分型):write/edit=行级 diff 面板;skill=md 正文;exec=$ 命令高亮+输出;
   *  todo_write=本地化清单(G14.138,daemon 英文结果不进展开面);其余=输出原文 */
  let body: JSX.Element;
  if (toolName === 'send_message') {
    // 正文进工具井(.tool-md=surface-code 黑框,与 skill/ask 同面);回执次级灰跟在正文下
    body = (
      <div className="tool-md tool-msg">
        {messageText !== '' && <div className="tool-msg-body">{messageText}</div>}
        {resultText !== '' && <div className="tool-msg-receipt">{resultText}</div>}
        {messageText === '' && resultText === '' && <div className="tool-todo-empty">{t('(empty)', '（空）')}</div>}
      </div>
    );
  } else if (toolName === 'todo_write') {
    const arr = Array.isArray(input.todos) ? (input.todos as Array<Record<string, unknown>>) : [];
    body = (
      <div className="tool-todos" aria-label="todo list">
        {arr.length === 0 && <div className="tool-todo tool-todo-empty">{t('(empty list)', '（空清单）')}</div>}
        {arr.map((o, i) => {
          const st = (o ?? {}).status === 'completed' ? 'completed' : (o ?? {}).status === 'in_progress' ? 'in_progress' : 'pending';
          return (
            <div key={i} className={`tool-todo tool-todo-${st}`}>
              {/* G14.169 统一圆圈三态:完成=绿底√/进行=→/等待=虚线圈(用户裁决,替代 ☑◐☐ 字符) */}
              <span className={`todo-dot ${st}`} aria-hidden="true">
                {st === 'completed' && <Check size={9} strokeWidth={3} />}
                {st === 'in_progress' && <ArrowRight size={9} strokeWidth={3} />}
              </span>
              <span className="tool-todo-text">{typeof (o ?? {}).text === 'string' ? String((o ?? {}).text) : ''}</span>
            </div>
          );
        })}
      </div>
    );
  } else if (isWrite) {
    // 拦截态先行(2026-10-31 用户实测「守卫拦截了但没显示报错」):失败(write/edit 被拒/NOT_READ/
    // STALE_READ 等)渲染 err 色错误横幅替代 diff——尝试的替换对未落盘,当 diff 显是误导
    if (entry.result?.ok === false && !executing) {
      body = (
        <div className="tool-detail" role="alert">
          <div style={{ color: 'var(--err)', fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>✗ {resultText}</div>
        </div>
      );
    } else {
    // 快照兜底列(404/失败/加载期):write=整稿新内容(input.content);edit=本次替换对(oldString→newString)
    const fallbackOld = toolName === 'edit' && typeof input.oldString === 'string' ? input.oldString : undefined;
    const fallbackNew =
      toolName === 'edit'
        ? typeof input.newString === 'string'
          ? input.newString
          : ''
        : typeof input.content === 'string'
          ? input.content
          : '';
    const openDiff =
      onOpenDiff !== undefined && callId !== undefined && path !== undefined
        ? (): void => {
            onOpenDiff(callId, path);
          }
        : onOpenFile !== undefined && path !== undefined
          ? (): void => {
              onOpenFile(path);
            }
          : undefined;
    const openDiffTitle =
      onOpenDiff !== undefined && callId !== undefined ? t('Open diff tab', '打开 diff 标签') : t('Preview in file tab', '在文件标签预览');
    body = (
      <div className="tool-detail">
        {/* G14.51:自绘行级 diff;⇄ 开 diff 标签钮迁入(原 DiffPanel 角标钮,可及名=路径) */}
        <div className="tool-diffwrap">
          <DiffLines oldStr={diff?.oldContent ?? fallbackOld} newStr={diff !== null && diff !== undefined ? diff.newContent : fallbackNew} path={path} maxHeight={280} />
          {openDiff !== undefined && (
            <button
              type="button"
              className="tool-path"
              aria-label={path}
              data-tip={openDiffTitle}
              onClick={openDiff}
            >
              <span aria-hidden="true">⇄</span>
            </button>
          )}
        </div>
      </div>
    );
    }
  } else if (toolName === 'skill') {
    body = (
      <div className="tool-md">
        <ReactMarkdown remarkPlugins={MD_REMARK_PLUGINS} rehypePlugins={MD_REHYPE_PLUGINS} urlTransform={keepUrl} components={mdComponentsPlain}>{fullResult}</ReactMarkdown>
      </div>
    );
  } else if (toolName === 'ask_question' && askInput !== null) {
    const askQ = askInput;
    // G14.82:结构化问答体——问题+选项清单(✓ 用户所选/跳过态)+回答条,替代原始 I/O 文本块
    // G14.102 回答行去「✓ Answered」前缀:回答态只示回答内容(accent),skip 示「Skipped」(灰),
    // 自定义示输入内容;等待态保留 spinner+文案
    const answerRow =
      askAnswer.kind === 'answers' || askAnswer.kind === 'answer'
        ? { kind: 'answer' as const, text: askAnswer.labels.join('、') }
        : askAnswer.kind === 'custom'
          ? { kind: 'custom' as const, text: askAnswer.text }
          : askAnswer.kind === 'dismissed'
            ? { kind: 'dismissed' as const, text: t('Skipped', '已跳过') }
            : { kind: 'waiting' as const, text: t('Waiting for answer', '等待回答') };
    // G14.84/G14.102:展开体=问题(加重)+回答结果,普通展开区域包裹(选项清单挂起表单已示,不复读)
    body = (
      <div className="tool-md ask-record">
        <div className="ask-q">{askQ.question}</div>
        <div className={`ask-answer kind-${answerRow.kind}`}>
          {answerRow.kind === 'waiting' && <span className="run-spinner" aria-hidden="true" />}
          <span className="ask-answer-text">{answerRow.text}</span>
        </div>
      </div>
    );
  } else if (command !== undefined) {
    body = (
      // G14.50:命令与输出合一区(终端形态:$ 行命令着色 + 输出同块次级灰——2026-10-25 用户裁定
      // 「结果再偏灰一点,方便区分命令行和结果」;输出剥 ANSI 转义(终端色码渲染即乱码))
      <div className="tool-exec">
        <pre className="tool-io-pre">
          <span className="exec-prompt" aria-hidden="true">$ </span>
          <code dangerouslySetInnerHTML={{ __html: highlightCommand(command) }} />
          {'\n'}
          <span className="exec-output">{fullResult !== '' ? stripAnsi(fullResult) : t('(no result)', '(无结果)')}</span>
        </pre>
      </div>
    );
  } else if (mcpToolParts(toolName) !== null) {
    // 2026-10-26 MCP 工具展开面(用户裁定「参数和返回值显示和其他工具一样」):server·tool 标识行 +
    // params JSON(入参全量,空参显 {})+ 返回值,终端块同形态($ 行/输出 的 MCP 对位)
    const mcp = mcpToolParts(toolName)!;
    const params = Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : '{}';
    body = (
      <div className="tool-exec">
        <pre className="tool-io-pre">
          <span className="exec-prompt" aria-hidden="true">mcp </span>
          <code>{mcp.server}</code>
          {' · '}
          <code>{mcp.tool}</code>
          {'\n'}
          <span className="exec-prompt" aria-hidden="true">params </span>
          <code>{params}</code>
          {'\n'}
          <span className="exec-output">{fullResult !== '' ? stripAnsi(fullResult) : t('(no result)', '(无结果)')}</span>
        </pre>
        {/* 回显带图(2026-10-30 用户裁定「回显也要显示截图的图片」):截屏类工具的截图在展开体
            结果后同样渲染——回显卡不只有参数/元数据,图片就近可看(缩略行同款,点击开灯箱) */}
        {entry.images !== undefined && entry.images.length > 0 && (
          <div className="tool-images">
            {entry.images.map((src, i) => (
              <ToolImageThumb key={`${i}:${src.slice(-24)}`} src={src} onOpen={setLightbox} />
            ))}
          </div>
        )}
      </div>
    );
  } else if (toolName === 'websearch') {
    // 2026-11-01 用户裁定「网址名做链接不显示 url,点击开系统默认浏览器」:websearch 输出结构化解析——
    // 标题=可点链接(preload 桥 shell.openExternal,OS 默认浏览器承接),URL 行不显示,摘要保留
    const hits = parseWebSearchOutput(fullResult);
    body =
      hits.length > 0 ? (
        <div className="tool-websearch">
          {hits.map((h) => (
            <div key={h.n} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 13 }}>
                {h.n}.{' '}
                <a
                  href={h.url}
                  style={{ color: 'var(--accent, #6ea8fe)' }}
                  onClick={(e) => {
                    e.preventDefault();
                    openExternalUrl(h.url);
                  }}
                >
                  {h.title}
                </a>
              </div>
              <div style={{ fontSize: 12, opacity: 0.75, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', paddingLeft: 14 }}>{h.snippet}</div>
            </div>
          ))}
        </div>
      ) : (
        <pre className="tool-io-pre">{fullResult !== '' ? stripAnsi(fullResult) : t('(no result)', '(无结果)')}</pre>
      );
  } else {
    body = <pre className="tool-io-pre">{fullResult !== '' ? stripAnsi(fullResult) : t('(no result)', '(无结果)')}</pre>;
  }

  return (
    <div className={`entry entry-tool${expanded ? ' open' : ''}`}>
      <button
        type="button"
        className="tool-summary"
        aria-expanded={isReadImage ? expanded : isRead ? undefined : expanded}
        onClick={() => {
          if (isRead && !isReadImage) onOpenFile?.(path!);
          else {
            setExpanded((v) => !v);
            window.dispatchEvent(new Event('sx-row-toggle')); // 贴地时展开/收起→滚动跟随(use-chat-scroll)
          }
        }}
      >
        <ToolIcon verb={toolName} />
        {collapsed}
        {(!isRead || isReadImage) && <ChevronRight className="tool-chev" size={12} strokeWidth={1.75} aria-hidden="true" />}
      </button>
      {/* 折叠壳外常驻图片缩略行退役(2026-10-31 用户裁定「去掉常驻显示的图片,保留内部的就可以」):
          截图只在展开体回显(ec9159c 面),折叠行不占版面;点击行展开即看 */}
      <div className={`tool-body${expanded ? ' open' : ''}`} aria-hidden={!expanded}>
        <div className="tool-body-inner">{isReadImage && path !== undefined ? <ReadImageBody path={path} /> : body}</div>
      </div>
      {lightbox !== undefined && <ImageLightbox src={lightbox} onClose={() => setLightbox(undefined)} />}
    </div>
  );
});

/** websearch stdout → 结构化条目(2026-11-01 展开面链接化):格式=「N. 标题⏎ 空格+URL⏎ 摘要(可多行)」,
 *  记录界=下一行「N. 」;不匹配整段返回空数组(退回原文展示) */
export function parseWebSearchOutput(text: string): Array<{ n: number; title: string; url: string; snippet: string }> {
  const out: Array<{ n: number; title: string; url: string; snippet: string }> = [];
  const re = /^(\d+)\. (.+)\n\s+(https?:\S+)\n([\s\S]*?)(?=(?:\n\d+\. )|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ n: Number(m[1]), title: m[2].trim(), url: m[3], snippet: m[4].trim() });
  }
  return out;
}
