import { describe, expect, test } from 'vitest';
import { taskOpNameOf } from './tool-entry-data';

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
