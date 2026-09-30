import * as React from 'react';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Text, Box } from 'ink';

interface BoundaryState {
  error: Error | undefined;
}

/**
 * TUI 渲染兜底边界（2026-09-30 真机「点 Esc 即 RangeError 杀进程」防御纵深）：渲染/提交期任何异常
 * （ink Output 尺寸异常、yoga 布局 NaN、第三方渲染分支）只降级为错误提示行 + 崩溃诊断落盘，
 * 不再整进程退出（任务与终端现场保全）；恢复经重挂路径（resize/Ctrl+B）自愈。崩溃诊断落
 * %TEMP%/sunshinex-render-crash.log（错误 + 崩溃帧 stdout.columns/rows 快照）供离线定位。
 */
export class RenderBoundary extends React.Component<{ children: React.ReactNode }, BoundaryState> {
  state: BoundaryState = { error: undefined };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    try {
      const file = path.join(os.tmpdir(), 'sunshinex-render-crash.log');
      const stdout = process.stdout as unknown as { columns?: number; rows?: number };
      const snap = JSON.stringify({ columns: stdout.columns, rows: stdout.rows, at: Date.now() });
      fs.appendFileSync(file, `${error.stack ?? String(error)}\nframe=${snap}\ncomponent=${JSON.stringify(info.componentStack ?? '')}\n---\n`);
    } catch {
      /* 诊断落盘失败静默 */
    }
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <Box flexDirection="column">
          <Text color="red">{'⚠ render error (recovered — resize or Ctrl+B to rebuild): '}</Text>
          <Text dimColor>{this.state.error.message}</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
