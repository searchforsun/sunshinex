import { t } from '../i18n';

/** 内置斜杠命令清单唯一源（规格 2026-09-22-skill-as-command D6）：
 *  App 重导出保持既有 import 路径（components/App），session 消费同一单点防双清单漂移；
 *  数组内容与顺序零漂移（原 components/App.tsx 声明照搬），顺序即 Tab 循环顺序。 */
export const SLASH_COMMANDS = ['/help', '/init', '/status', '/tasks', '/skill', '/new', '/resume', '/rewind', '/fork', '/compact', '/context', '/plan', '/goal', '/model', '/model-effort', '/add-dir', '/memory', '/memory-add', '/memory-rm', '/memory-gc', '/memory-on', '/memory-off'];

/** 内置命令描述（2026-09-30 纵向命令面板）：键为去斜杠命令词，值为运行期求值的本地化描述——
 *  t() 运行期求值防语言装配冻结（先例：approvalSelectorOptions）；文案与 slashHelp 同源口径收一行为限 */
export function slashCommandDescriptions(): Record<string, string> {
  return {
    help: t('show available commands', '查看可用命令'),
    init: t('analyze & write SUNSHINE.md', '分析生成/完善 SUNSHINE.md'),
    status: t('session & ledger summary', '会话与账本摘要'),
    tasks: t('list background tasks', '列出后台任务'),
    skill: t('load a skill into context', '加载技能进上下文'),
    new: t('new session (soft reset)', '新会话（软重置）'),
    resume: t('resume a saved session', '恢复已保存会话'),
    rewind: t('rewind to an earlier turn', '回退到更早的任务轮'),
    fork: t('fork a parallel session', '分叉出平行会话'),
    compact: t('compress context', '压缩上下文'),
    context: t('context usage breakdown', '上下文各段占比与大小'),
    plan: t('plan first, execute on approval', '先规划后执行'),
    goal: t('run the verify-fix loop', '运行完整验收修正环'),
    model: t('switch model tier', '切换模型档位'),
    'model-effort': t('switch reasoning effort', '切换思考强度'),
    'add-dir': t('extend trusted directories', '扩展信任目录'),
    memory: t('list persistent memories', '列出持久记忆'),
    'memory-add': t('add a memory', '添加记忆'),
    'memory-rm': t('delete memories (multi-select)', '删除记忆（多选卡）'),
    'memory-gc': t('consolidate memories now', '立即整理记忆'),
    'memory-on': t('enable memory for this session', '本会话开启持久记忆'),
    'memory-off': t('disable memory for this session', '本会话关闭持久记忆'),
  };
}
