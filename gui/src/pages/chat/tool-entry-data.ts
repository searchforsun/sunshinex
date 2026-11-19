/**
 * 工具行纯数据/纯函数单点（D62 批A 外提，行为零变化）：i18n 映射表（TOOL_VERB_ZH/MCP_TOOL_LABELS/
 * RUNNING_LABELS/TASK_OP_RUNNING）、解析与拆分纯函数（mcpToolParts/zhToolName/toolTargetOf/
 * commandRunningLabel/fileLabelOf/writeStatOf/parseWebSearchOutput）与 TodoBatch 类型——
 * ToolEntry.tsx 保留渲染件（ToolIcon/ToolEntryView/图片件），本模块零 JSX 零 React 依赖。
 * 公开符号经 ToolEntry 原路径再导出（消费面零迁移，D32 纪律）。
 */
import { t } from '../../i18n';
import { pathBasename } from '../../ui-util';

export function mcpToolParts(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice(5);
  const i = rest.indexOf('__');
  if (i <= 0 || i >= rest.length - 2) return null;
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

/** 内置宿主插件 server 名单(镜像 src/harness/plugin-host HOSTED 键——purpose=宿主注入的模型自拟
 *  操作说明参数;第三方 MCP 工具自带的 purpose 字段不当标题,mcp-row.test 钉住该契约)。名单漂移由
 *  tool-entry-mirror.test 对拍钉咬住(读宿主源码比对此集合,新增宿主插件两侧必同步) */
export const PURPOSE_SERVERS: ReadonlySet<string> = new Set(['browser-use', 'computer-use']);

function isPurposeTool(name: string): boolean {
  const mcp = mcpToolParts(name);
  return mcp !== null && PURPOSE_SERVERS.has(mcp.server);
}

/** 工具行操作说明(2026-11-07 用户裁定):宿主插件工具与 exec 入参 purpose——模型按对话语言自拟的
 *  本次目的;工具行以它为标题(插件=整行替换;exec=描述+命令明细)。null/缺省/空串 → undefined */
export function toolPurposeOf(name: string, input: Record<string, unknown>): string | undefined {
  const v = input.purpose;
  if (!isPurposeTool(name) && name !== 'exec') return undefined;
  if (typeof v !== 'string') return undefined;
  const flat = v.replace(/\s+/g, ' ').trim();
  return flat === '' ? undefined : flat;
}

/** 展开体/目标摘要用入参:剥掉 purpose(它已是行标题,展开内容保持插件真实收到的参数) */
export function withoutPurpose(name: string, input: Record<string, unknown>): Record<string, unknown> {
  if (!isPurposeTool(name) || !Object.prototype.hasOwnProperty.call(input, 'purpose')) return input;
  const { purpose: _purpose, ...rest } = input;
  return rest;
}

export interface TodoBatch {
  key: string;
  ts: number;
  goal: string;
  /** 关联轮次用户条键(k<seq>,2026-11-03 待办卡定位面):待办页签点主名字滚到该正文气泡;旧投影无 */
  userKey?: string;
  items: Array<{ text: string; status: 'completed' | 'in_progress' | 'pending' }>;
}

/** 工具折叠行动词双语展示单点(2026-11-05 用户裁定:EN 不再露原始工具名——两语都见名知意,
 *  EN 首字母大写;未登记工具(MCP 引入等)回退原名)。G14.216 zh 命名口径不变——读取/写入/执行/
 *  查阅/查找/搜索/抓取/停止/取消/分派/提问 + 加载技能、保存记忆、更新待办、等待任务、
 *  检索知识库、创建任务、设置依赖、分派子智能体、加载智能体团队、加载子智能体 */
const TOOL_VERBS: Record<string, { en: string; zh: string }> = {
  read: { en: 'Read', zh: '读取' }, write: { en: 'Write', zh: '写入' }, edit: { en: 'Edit', zh: '编辑' },
  exec: { en: 'Exec', zh: '执行' }, grep: { en: 'Grep', zh: '查阅' }, glob: { en: 'Glob', zh: '查找' },
  skill: { en: 'Load skill', zh: '加载技能' }, webfetch: { en: 'Fetch', zh: '抓取' }, websearch: { en: 'Search', zh: '搜索' },
  memory_write: { en: 'Save memory', zh: '保存记忆' },
  todo_write: { en: 'Update todos', zh: '更新待办' }, worktree: { en: 'Worktree', zh: '工作树' },
  spawn: { en: 'Subagent', zh: '子智能体' }, // 2026-11-14 用户裁定「只显示子智能体,不再显示分派什么的」
  task_stop: { en: 'Stop task', zh: '停止任务' }, // 2026-11-16 用户实测「task_stop 没有 i18n」——原词条被上行行内注释吞成死代码,zhToolName 回退原始名
  load_subagent: { en: 'Load subagent', zh: '加载子智能体' }, // agents-teams P0 章程卡工具(2026-11-05 更名自 agent;子智能体域,不受智能体团队控制)
  kb_search: { en: 'Search knowledge base', zh: '检索知识库' }, ask_question: { en: 'Ask', zh: '提问' },
  exit_plan: { en: 'Submit plan', zh: '提交计划' },
  report_artifacts: { en: 'Register artifacts', zh: '登记产物' }, // 2026-11-14 kind 化:产物声明工具(点名字开产物页签)
  load_agent_teams: { en: 'Load agent teams', zh: '加载智能体团队' }, // 智能体团队域(与八件套同族;2026-11-05 更名自 team)
  create_agent_team_task: { en: 'Create team task', zh: '创建团队任务' }, set_dependency: { en: 'Set dependency', zh: '设置依赖' },
  assign: { en: 'Assign', zh: '分派' },
  create_agent_team: { en: 'Create agent team', zh: '创建智能体团队' },
  create_agent_teammate: { en: 'Create team member', zh: '创建团队成员' },
  update_agent_team_task: { en: 'Update team task', zh: '更新团队任务' },
  get_agent_team_board: { en: 'View team board', zh: '查看团队看板' }, probe: { en: 'Probe', zh: '探测' },
  send_agent_team_message: { en: 'Send team message', zh: '发送团队消息' }, get_task: { en: 'Read task', zh: '读取任务' },
  agent_team_task_stop: { en: 'Stop team task', zh: '停止团队任务' },
  task_wait: { en: 'Wait for task', zh: '等待任务' }, agent_team_task_wait: { en: 'Wait for team task', zh: '等待团队任务' },
  // sunx 编排/调度域(2026-11-15 用户实测「分派任的工具没有加上特殊的图标样式和 i18n,其他新加的
  // 图标都要这个问题,补上」——四件双语名,折叠行不再露原始工具名)
  dispatch_task: { en: 'Dispatch task', zh: '分派任务' }, task_status: { en: 'Task status', zh: '任务状态' },
  schedule_wakeup: { en: 'Schedule wake-up', zh: '定时唤醒' }, schedule_task: { en: 'Schedule task', zh: '定时分派' },
};

/** 中文工具名映射(2026-10-30 用户裁定「操作电脑和浏览器的工具行显中文工具名」):电脑操作
 *  11 工具 + 浏览器操作常用族;未收录回退短名(server 面在展开体/工具清单承载,折叠行不重复) */
/** MCP 工具双语名映射(2026-10-30 用户裁定「档位/强度/工具名走 i18n,不是改成中文」):电脑操作
 *  11 工具 + 浏览器操作常用族;渲染期 t(en, zh) 求值随语言切换;未收录回退短名(server 面在
 *  展开体/工具清单承载,折叠行不重复) */
export const MCP_TOOL_LABELS: Record<string, { en: string; zh: string }> = {
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
  const pair = TOOL_VERBS[name];
  return pair === undefined ? name : t(pair.en, pair.zh);
}

/** 折叠行目标字段(工具展示元数据同口径):各内置工具取其主字段;换行拍平,超长中段省略。
 *  MCP 工具无固定主字段——入参整体压单行 JSON 摘要(与 exec 命令行同级的目标信息) */
export function toolTargetOf(name: string, input: Record<string, unknown>): string | undefined {
  if (mcpToolParts(name) !== null) {
    const shown = withoutPurpose(name, input);
    const keys = Object.keys(shown);
    if (keys.length === 0) return undefined;
    const flat = JSON.stringify(shown);
    if (flat.length <= 72) return flat;
    return `${flat.slice(0, 48)}…${flat.slice(-20)}`;
  }
  if (name === 'exit_plan') {
    const v = input.name;
    if (typeof v !== 'string' || v === '') return undefined;
    const flat = (v.split('\n')[0] ?? v).trim();
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
            : name === 'skill' || name === 'load_agent_teams' || name === 'load_subagent'
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

export const RUNNING_LABELS: Record<string, [string, string]> = {
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
  spawn: ['Subagent', '子智能体'],
  create_agent_teammate: ['Creating member', '正在创建团队成员'],
  create_agent_team: ['Creating team', '正在创建智能体团队'],
  update_agent_team_task: ['Updating team task', '正在更新团队任务'], get_agent_team_board: ['Reading team board', '正在查看团队看板'], probe: ['Probing', '正在探测'],
  send_agent_team_message: ['Sending team message', '正在发送团队消息'], get_task: ['Reading task', '正在读取任务'],
  task_wait: ['Waiting for tasks', '正在等待任务'],
  agent_team_task_wait: ['Waiting for team tasks', '正在等待团队任务'],
  task_stop: ['Stopping task', '正在停止任务'],
  agent_team_task_stop: ['Stopping team task', '正在停止团队任务'],
  todo_write: ['Updating todos', '正在更新待办'],
  worktree: ['Preparing worktree', '正在准备工作树'],
  kb_search: ['Searching knowledge base', '正在检索知识库'],
  ask_question: ['Waiting for answer', '正在等待回答'],
  exit_plan: ['Presenting plan', '正在提交计划'],
  create_agent_team_task: ['Creating team task', '正在创建团队任务'],
  set_dependency: ['Setting dependency', '正在设置依赖'],
  assign: ['Assigning task', '正在分派任务'],
  // sunx 编排/调度域运行态(2026-11-15 用户实测 i18n 补齐,与 TOOL_VERBS 同批)
  dispatch_task: ['Dispatching task', '正在分派任务'],
  task_status: ['Checking task', '正在查看任务'],
  schedule_wakeup: ['Scheduling wake-up', '正在设置定时唤醒'],
  schedule_task: ['Scheduling task', '正在设置定时分派'],
};

/** 单 taskId 工具集合（折叠行/运行态带任务名；task_wait 已单列）：入参均含 taskId 字符串，
 *  折叠行默认分型只出动词——任务名经 taskNameOf 单点解析后跟行 */
export const TASK_OP_TOOLS = new Set(['task_stop', 'agent_team_task_stop', 'update_agent_team_task', 'assign', 'set_dependency', 'get_task']);

/** G14.214 运行态动词对（拼接任务名替代泛文案，仿 spawn G14.166 先例）；折叠行动词走 zhToolName 既有映射 */
export const TASK_OP_RUNNING: Record<string, [string, string]> = {
  task_stop: ['Stopping', '正在停止'],
  agent_team_task_stop: ['Stopping', '正在停止'],
  update_agent_team_task: ['Updating', '正在更新'],
  assign: ['Assigning', '正在分派'],
  set_dependency: ['Setting dependency of', '正在设置依赖'],
  get_task: ['Reading task', '正在读取任务'],
};

/** 文件行拆分(G14.8):basename + 所在目录(恒显,根目录 = './')——文件名后永远看得到位置 */
export function fileLabelOf(path: string, root?: string): { base: string; dir: string } {
  let norm = path.replace(/\\/g, '/');
  // 根下绝对路径相对化(2026-11-14 用户问「多项目时工具行怎么显示绝对路径」:模型传绝对路径合法
  // (read/write/edit 均允许),折叠行显示归一根相对——与 @ 面包屑同语言;根外路径保持原样)
  if (root !== undefined && root !== '') {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (r !== '' && norm.toLowerCase().startsWith(r.toLowerCase() + '/')) norm = norm.slice(r.length + 1);
  }
  const base = pathBasename(norm);
  const dir = norm.slice(0, norm.length - base.length);
  return { base, dir }; // 根目录文件 dir = ''(名称即相对路径,不重复显示)
}

/** write/edit 结果首行 `written/edited +3 -1` → diff stat 拆分(G14 底层同源;前缀无关,认 +N -M 形);无 stat 回空 */
export function writeStatOf(result: string): { added?: string; removed?: string } {
  const m = /\+(\d+) -(\d+)/.exec(result);
  return m === null ? {} : { added: `+${m[1]}`, removed: `-${m[2]}` };
}

export function parseWebSearchOutput(text: string): Array<{ n: number; title: string; url: string; snippet: string }> {
  const out: Array<{ n: number; title: string; url: string; snippet: string }> = [];
  const re = /^(\d+)\. (.+)\n\s+(https?:\S+)\n([\s\S]*?)(?=(?:\n\d+\. )|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ n: Number(m[1]), title: m[2].trim(), url: m[3], snippet: m[4].trim() });
  }
  return out;
}

/** G14.82 ask_question 结构化问答体输入面：问题+选项（label/description 归一）；非 ask 行或缺问题回 null */
export function parseAskInput(toolName: string, input: Record<string, unknown>): { question: string; options: Array<{ label: string; description?: string }> } | null {
  if (toolName !== 'ask_question' || typeof input.question !== 'string') return null;
  return {
    question: input.question,
    options: Array.isArray(input.options)
      ? input.options.map((o) => {
          const ob = (o ?? {}) as { label?: unknown; description?: unknown };
          const label = String(ob.label ?? '').trim();
          const description = typeof ob.description === 'string' && ob.description.trim() !== '' ? ob.description.trim() : undefined;
          return description !== undefined ? { label, description } : { label };
        })
      : [],
  };
}

/** ask_question 回执文本 → 回答态（daemon 回执前缀协议：answers:/answer:/custom:；空或 `…`=等待；其余=跳过） */
export function parseAskAnswer(result: string):
  | { kind: 'pending' }
  | { kind: 'answers'; labels: string[] }
  | { kind: 'answer'; labels: string[] }
  | { kind: 'custom'; text: string }
  | { kind: 'dismissed' } {
  const r = result.trim();
  if (r === '' || r === '…') return { kind: 'pending' };
  if (r.startsWith('answers: ')) return { kind: 'answers', labels: r.slice(9).split('; ').map((x) => x.trim()) };
  if (r.startsWith('answer: ')) return { kind: 'answer', labels: [r.slice(8).trim()] };
  if (r.startsWith('custom: ')) return { kind: 'custom', text: r.slice(8).trim() };
  return { kind: 'dismissed' };
}

/** task_* 折叠行/运行态任务名解析单点（D62 批G 外提）：input.taskId 经 taskNameOf 链
 *  （board 直查→转录映射→短 id 兜底,G14.214/task_wait G14.172 同口径）；task_stop 完成态回执
 *  label 兜底。2026-11-17 用户实测「停止行显示命令原文,不是后台任务名称」：
 *  - taskId 先剥「task 」前缀归一（exec 转后台回执原文带 task 前缀,模型照抄传入——与 resolveId
 *    容错同拍,剥后任务名映射/回执正则都能命中）；
 *  - 人名优先：taskAgentOf 转录映射（后台命令 purpose 名/后台 spawn goal 名）命中即用,命令原文
 *    （回执 label=exec 台账 label=命令行）只作无名 exec 的兜底 */
export function taskOpNameOf(toolName: string, input: Record<string, unknown>, resultText: string, taskNameOf: ((id: string) => string | undefined) | undefined, taskAgentOf?: (id: string) => { name: string; prompt?: string; kind?: 'exec' } | undefined): string | undefined {
  if (!TASK_OP_TOOLS.has(toolName)) return undefined;
  const id = typeof input.taskId === 'string' && input.taskId !== '' ? input.taskId : undefined;
  if (id === undefined) return undefined;
  const bare = /^task\s+(.+)$/.exec(id.trim());
  const nid = bare !== null ? bare[1]! : id;
  if (toolName === 'task_stop') {
    const ref = taskAgentOf !== undefined ? taskAgentOf(nid) : undefined;
    if (ref !== undefined && ref.name !== '') return ref.name;
    // 回执格式 2026-11-17 根治同拍:新形「<id> stopped — <任务名>」主匹配;旧形「task <id> stopped (label)」历史档兜底
    const m = new RegExp(`${nid} stopped — (.*)`).exec(resultText) ?? new RegExp(`task ${nid} stopped \\((.*)\\)`).exec(resultText);
    if (m !== null && m[1] !== '') return m[1]!;
  }
  return taskNameOf !== undefined ? taskNameOf(nid) : nid;
}

/** set_dependency 依赖目标名解析单点（D62 批G 外提,行为零变化）：dependsOn 经 taskNameOf 链 */
export function taskOpDepNameOf(input: Record<string, unknown>, taskNameOf: ((id: string) => string | undefined) | undefined): string | undefined {
  if (typeof input.dependsOn !== 'string' || input.dependsOn === '') return undefined;
  return taskNameOf !== undefined ? taskNameOf(input.dependsOn) : input.dependsOn;
}

/** 运行态标签装配单点（D62 批G 外提,行为零变化）：ToolEntryView runningLabel IIFE 平移——分型
 *  优先级 spawn/teammate/team/消息/板任务/skill/task 系/exit_plan/MCP/兜底 RUNNING_LABELS；
 *  taskOpName 由调用方先经 taskOpNameOf 解出（本函数只装配文案） */
export function runningLabelOf(deps: {
  toolName: string;
  input: Record<string, unknown>;
  spawnAgentName: string;
  teammateName: string;
  teamName: string;
  messageTo: string;
  messageToLabel: string;
  target: string | undefined;
  taskOpName: string | undefined;
  planName: string;
}): string {
  const { toolName, input } = deps;
  // G14.166 spawn 运行态带子智能体名(label ?? agent_id);2026-11-14 用户裁定「只显示子智能体 {}」(不再分派/正在字样)
  if (toolName === 'spawn' && deps.spawnAgentName !== '') return t(`Subagent ${deps.spawnAgentName}`, `子智能体 ${deps.spawnAgentName}`);
  if (toolName === 'create_agent_teammate' && deps.teammateName !== '') return t(`Creating member ${deps.teammateName}`, `正在创建团队成员 ${deps.teammateName}`);
  if (toolName === 'create_agent_team' && deps.teamName !== '') return t(`Creating team ${deps.teamName}`, `正在创建智能体团队 ${deps.teamName}`);
  if (toolName === 'send_agent_team_message' && deps.messageTo !== '') return t(`Sending team message to ${deps.messageToLabel}`, `正在发送团队消息给 ${deps.messageToLabel}`);
  // create_agent_team_task 运行态带任务标题——「正在创建团队任务 …」,id 不进折叠行
  if (toolName === 'create_agent_team_task' && typeof input.title === 'string' && input.title !== '') {
    return t(`Creating team task ${input.title}`, `正在创建团队任务 ${input.title}`);
  }
  // G14.2xx skill 运行态带技能名(与完成态「加载技能 xxx」同构,回溯前后显示一致)
  if (toolName === 'skill' && deps.target !== undefined) return t(`Loading skill ${deps.target}`, `正在加载技能 ${deps.target}`);
  // task_* 运行态带任务名——「正在更新 架构评审」替代泛文案（taskOpName 已在场即有值）
  const opPair = deps.taskOpName !== undefined ? TASK_OP_RUNNING[toolName] : undefined;
  if (opPair !== undefined && deps.taskOpName !== undefined) return t(`${opPair[0]} ${deps.taskOpName}`, `${opPair[1]} ${deps.taskOpName}`);
  // exit_plan 运行态带计划名——「正在提交计划 重构认证模块」
  if (toolName === 'exit_plan' && deps.planName !== '') return t('Presenting plan', '正在提交计划'); // 计划名归蓝链(2026-11-04 用户裁定「只显示蓝色」——折叠行名+链双显退役)
  // MCP 工具运行态带本地化工具名(2026-10-30 用户裁定;双语对渲染期求值)
  const mcp = mcpToolParts(toolName);
  if (mcp !== null) {
    const pair = MCP_TOOL_LABELS[mcp.tool];
    return pair !== undefined
      ? t(`Calling ${pair.en}`, `正在调用 ${pair.zh}`)
      : t(`Calling ${mcp.tool}`, `正在调用 ${mcp.tool}`);
  }
  const pair = RUNNING_LABELS[toolName] ?? ['Running', '正在执行'];
  return t(pair[0], pair[1]);
}
