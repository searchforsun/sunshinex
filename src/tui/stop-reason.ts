import { StopReason } from '../types';

/**
 * 未完成终止的用户可见文案（纯函数）。正常完成返回空串；
 * 模型失败同样返回空串——它已由 error 通道上屏，重复提示只会干扰阅读。
 */
export function describeIncomplete(stopReason: StopReason | undefined): string {
  switch (stopReason) {
    case 'deadline':
      return 'Incomplete: submission time limit reached';
    case 'budget':
      return 'Incomplete: token budget exhausted (resumable)';
    case 'max-steps':
      return 'Incomplete: max steps reached';
    default:
      return '';
  }
}
