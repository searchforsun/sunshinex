import { describe, expect, test } from 'vitest';
import { fileLabelOf, taskOpNameOf, toolTargetOf, zhToolName } from './tool-entry-data';

/** task_stop 折叠行任务名解析（2026-11-17 用户实测「停止行显示命令原文,不是后台任务名称」+
 *  「taskid 不对(带 task 前缀)」三修回归）：人名(purpose/转录映射)优先→回执 label 兜底;
 *  taskId「task 」前缀剥除归一(resolveId 容错同拍) */
describe('taskOpNameOf', () => {
  const receipt = 'task find-name-swift-20261117T022449Z-z2ww stopped (find / -name "x.jar" 2>/dev/null | head)';

  test('task_stop：taskAgentOf purpose 人名优先——命令原文回执 label 不再当任务名示出', () => {
    const name = taskOpNameOf('task_stop', { taskId: 'find-name-swift-20261117T022449Z-z2ww' }, receipt, () => 'find-name-swift', (id) =>
      id === 'find-name-swift-20261117T022449Z-z2ww' ? { name: '查找 swift framework JsonForm 类定义', kind: 'exec' } : undefined,
    );
    expect(name).toBe('查找 swift framework JsonForm 类定义');
  });

  test('task_stop：「task <id>」前缀照抄形态剥除归一——映射与回执正则按裸 id 命中', () => {
    const name = taskOpNameOf('task_stop', { taskId: 'task find-name-swift-20261117T022449Z-z2ww' }, receipt, undefined, (id) =>
      id === 'find-name-swift-20261117T022449Z-z2ww' ? { name: '查找 swift framework JsonForm 类定义', kind: 'exec' } : undefined,
    );
    expect(name).toBe('查找 swift framework JsonForm 类定义');
  });

  test('task_stop：新格式回执「<id> stopped — <任务名>」直接出任务名', () => {
    const name = taskOpNameOf('task_stop', { taskId: 'find-name-swift-20261117T022449Z-z2ww' }, 'find-name-swift-20261117T022449Z-z2ww stopped — 查找 swift framework JsonForm 类定义', undefined);
    expect(name).toBe('查找 swift framework JsonForm 类定义');
  });

  test('task_stop：无名 exec（无 purpose 映射）回执 label 兜底', () => {
    const name = taskOpNameOf('task_stop', { taskId: 'find-name-swift-20261117T022449Z-z2ww' }, receipt, undefined);
    expect(name).toBe('find / -name "x.jar" 2>/dev/null | head');
  });

  test('非 task_stop 工具走 taskNameOf 链；缺解析器回落裸 id', () => {
    expect(taskOpNameOf('get_task', { taskId: 't-1' }, '', () => '架构评审')).toBe('架构评审');
    expect(taskOpNameOf('get_task', { taskId: 't-1' }, '', undefined)).toBe('t-1');
    expect(taskOpNameOf('task_stop', {}, receipt, undefined)).toBeUndefined();
  });
});


/** 折叠行路径相对化(2026-11-19 用户实测「相对路径怎么还是渲染成了绝对路径」):Windows 根路径的
 *  反斜杠归一正则曾写成 /\\/(匹配双反斜杠),实际单反斜杠路径永不命中→回显绝对路径 */
describe('fileLabelOf 根相对化', () => {
  test('Windows 反斜杠绝对路径 → 根相对目录(单反斜杠也归一)', () => {
    expect(fileLabelOf(String.raw`D:\project\bi-kronos-internals\src\main\java\A.java`, String.raw`D:\project\bi-kronos-internals`)).toEqual({
      base: 'A.java',
      dir: 'src/main/java/',
    });
  });

  test('正斜杠绝对路径/根尾斜杠/根目录文件', () => {
    expect(fileLabelOf('D:/repo/src/a.ts', 'D:/repo/')).toEqual({ base: 'a.ts', dir: 'src/' });
    expect(fileLabelOf(String.raw`D:\repo\a.ts`, String.raw`D:\repo`)).toEqual({ base: 'a.ts', dir: '' });
  });

  test('POSIX 根(linux/macos)同样相对化', () => {
    expect(fileLabelOf('/home/u/proj/src/a.ts', '/home/u/proj')).toEqual({ base: 'a.ts', dir: 'src/' });
    expect(fileLabelOf('/Users/u/proj/a.ts', '/Users/u/proj/')).toEqual({ base: 'a.ts', dir: '' });
  });

  test('根外路径保持原样(不误剥)', () => {
    expect(fileLabelOf('E:/other/x.md', 'D:/repo')).toEqual({ base: 'x.md', dir: 'E:/other/' });
  });
});


/** create_scheduled_task（2026-11-21 用户实测「工具没有特殊图标和 i18n」）：工具行双语名 +
 *  目标取入参 name（任务名），不再露原始 snake_case 名；图标映射在 tool-entry-icon（Clock） */
describe('create_scheduled_task 工具行', () => {
  test('zhToolName 双语化（不再是原始工具名）；target=任务名', () => {
    const label = zhToolName('create_scheduled_task');
    expect(label).not.toBe('create_scheduled_task');
    expect(label).toMatch(/^(Create scheduled task|创建定时任务)$/);
    expect(toolTargetOf('create_scheduled_task', { name: '晨间巡检' })).toBe('晨间巡检');
    expect(toolTargetOf('create_scheduled_task', {})).toBeUndefined();
  });
});
