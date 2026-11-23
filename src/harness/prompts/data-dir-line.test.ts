// 数据域事实行钉测（2026-11-23 用户裁定「系统上下文说明两个地址：当前项目在 X、数据目录在 Y 及其
// 内容文件夹；workspace 即原来的工作区，两者分开」）：stableSegmentOf dataDir 槽——
// ①行含双地址+内容清单+分离语义；②缺席=逐字节旧行为（golden 回归锚 sunx-charter.test 已锁基线）；
// ③行插入槽位=workDir 行之后 FILE_PATH 行之前。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stableSegmentOf, workDirLine, dataDirLine } from './shared';

test('dataDirLine:双地址+内容清单（sessions/tasks/memory/runs/skills/images-cache）,无冗余分离说明', () => {
  const line = dataDirLine('D:\\proj\\demo', 'D:\\sunshinex\\D-demo\\data');
  assert.ok(line.includes('Working workspace (project root): D:\\proj\\demo'), 'workspace 地址（原工作区）');
  assert.ok(line.includes('session data directory: D:\\sunshinex\\D-demo\\data'), '数据域地址');
  assert.ok(!line.includes('separate'), '两地址并列陈述，无冗余分离说明（用户二轮裁定）');
  for (const dir of ['sessions/', 'tasks/', 'memory/', 'runs/', 'skills/', 'images-cache/']) {
    assert.ok(line.includes(`${dir} =`), `内容清单应含 ${dir}`);
  }
  assert.ok(line.includes('Read or grep the data directory directly'), '工具直达指引（审计/找回场景）');
});

test('stableSegmentOf dataDir 槽:行落 workDir 之后 FILE_PATH 之前;缺席=逐字节旧行为', () => {
  const withData = stableSegmentOf({ contextRoot: '/r', dataDir: '/data-domain' });
  const without = stableSegmentOf({ contextRoot: '/r' });
  const linesWithData = withData.split('\n');
  const linesWithout = without.split('\n');
  // 缺席=旧行为：与带槽前的结构同长（golden 基线由 sunx-charter.test 锁逐字节）
  assert.equal(linesWithData.length, linesWithout.length + 1, '带 dataDir 恰多一行');
  const idx = linesWithData.findIndex((l) => l.startsWith('Session data directory:') || l.includes('Working workspace (project root): /r'));
  assert.ok(idx > 0, '数据域行在段内');
  assert.equal(linesWithData[idx], dataDirLine('/r', '/data-domain'), '行内容=dataDirLine 产物');
  assert.equal(linesWithData[idx - 1], workDirLine('/r'), '槽位：workDir 行之后');
  assert.ok(linesWithData[idx + 1].startsWith('When referencing a file'), '槽位：FILE_PATH 行之前');
  // 其余行逐字节不受影响（除插入行外前后拼接一致）
  assert.equal(
    linesWithData.filter((l) => l !== linesWithData[idx]).join('\n'),
    linesWithout.join('\n'),
    '缺席槽外行零漂移',
  );
});
