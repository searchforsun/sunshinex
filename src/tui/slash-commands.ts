import { t } from '../i18n';

/** 内置斜杠命令清单唯一源：TUI 分发/补全/help 与 GUI /commands 同源消费；
 *  技能已退出命令面（2026-11-04 agents-teams-catalog spec §4），命令面仅内置命令。
 *  App 重导出保持既有 import 路径（components/App），session 消费同一单点防双清单漂移；
 *  顺序即 Tab 循环顺序（handleSlash 分支与 /help 文案的相邻排布同源：/terminal-setup 紧随 /status，
 *  2026-10-03 批A D1 补登——实现与 /help 文案早已在场，清单缺席即三源漂移病根）。 */
export const SLASH_COMMANDS = ['/help', '/init', '/status', '/terminal-setup', '/tasks', '/skill', '/new', '/resume', '/rewind', '/fork', '/btw', '/side', '/archive', '/unarchive', '/delete', '/compact', '/context', '/plan', '/goal', '/model', '/model-tier', '/model-effort', '/mcp', '/agents', '/plugins', '/providers', '/add-dir', '/kb-index', '/memory', '/memory-add', '/memory-rm', '/memory-gc', '/memory-on', '/memory-off'];

/** 内置命令描述（2026-09-30 纵向命令面板）：键为去斜杠命令词，值为运行期求值的本地化描述——
 *  t() 运行期求值防语言装配冻结（先例：approvalSelectorOptions）；文案与 slashHelp 同源口径收一行为限 */
export function slashCommandDescriptions(): Record<string, string> {
  return {
    help: t('show available commands', '查看可用命令'),
    init: t('analyze & write SUNSHINE.md', '分析生成/完善 SUNSHINE.md'),
    status: t('session & ledger summary', '会话与账本摘要'),
    'terminal-setup': t('configure terminal keys (Shift+Enter newline, Windows Terminal)', '配置终端键位（Shift+Enter 换行，Windows Terminal）'),
    tasks: t('list background tasks', '列出后台任务'),
    skill: t('insert a skill reference into the input', '插入技能引用到输入框'),
    new: t('new session (soft reset)', '新会话（软重置）'),
    resume: t('resume a saved session', '恢复已保存会话'),
    rewind: t('rewind to an earlier turn', '回退到更早的任务轮'),
    fork: t('fork a parallel session', '分叉出平行会话'),
    btw: t('side Q&A on a forked side session: /btw <question>', '辅助问答（fork 旁路，不进主链）：/btw <问题>'),
    side: t('side Q&A (alias of /btw)', '辅助问答（/btw 别名）'),
    archive: t('archive this session (move out of main lists)', '归档当前会话（移出主列表）'),
    unarchive: t('unarchive an archived session (picker)', '撤销归档（选择卡）'),
    delete: t('delete this session (must be archived first)', '删除当前会话（须先归档）'),
    compact: t('compress context', '压缩上下文'),
    context: t('context usage breakdown', '上下文各段占比与大小'),
    plan: t('plan mode: bare=arm · /plan <goal> plan it · /plan off leave', '计划模式：裸 /plan 武装 · /plan <目标> 规划 · /plan off 退出'),
    goal: t('run the verify-fix loop', '运行完整验收修正环'),
    model: t('switch model (settings providers)', '切换模型（多源清单）'),
    'model-tier': t('switch model tier', '切换模型档位'),
    'model-effort': t('switch reasoning effort', '切换思考强度'),
    mcp: t('MCP servers panel (list / enable|disable|approve|deny)', 'MCP 服务器面板（清单/启停/批准/拒绝）'),
    agents: t('subagents panel (list / enable|disable)', '子智能体面板（清单/启停）'),
    plugins: t('plugins panel (list / enable|disable)', '插件面板（清单/启停）'),
    providers: t('model providers panel (read-only list)', '模型提供方面板（只读清单）'),
    'add-dir': t('extend trusted directories', '扩展信任目录'),
    'kb-index': t('build the knowledge-base index', '构建知识库索引'),
    memory: t('list persistent memories', '列出持久记忆'),
    'memory-add': t('add a memory', '添加记忆'),
    'memory-rm': t('delete memories (multi-select)', '删除记忆（多选卡）'),
    'memory-gc': t('consolidate memories now', '立即整理记忆'),
    'memory-on': t('enable memory for this session', '本会话开启持久记忆'),
    'memory-off': t('disable memory for this session', '本会话关闭持久记忆'),
  };
}
