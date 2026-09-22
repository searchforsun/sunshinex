/** 内置斜杠命令清单唯一源（规格 2026-09-22-skill-as-command D6）：
 *  App 重导出保持既有 import 路径（components/App），session 消费同一单点防双清单漂移；
 *  数组内容与顺序零漂移（原 components/App.tsx 声明照搬），顺序即 Tab 循环顺序。 */
export const SLASH_COMMANDS = ['/help', '/init', '/status', '/tasks', '/skill', '/new', '/resume', '/rewind', '/fork', '/compact', '/plan', '/goal', '/model', '/model-effort', '/memory', '/memory-add', '/memory-rm', '/memory-gc', '/memory-on', '/memory-off'];
