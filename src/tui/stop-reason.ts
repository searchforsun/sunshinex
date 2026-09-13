import { StopReason } from '../types';

/**
 * 未完成终止的用户可见文案（纯函数）。正常完成返回空串；
 * 模型失败同样返回空串——它已由 error 通道上屏，重复提示只会干扰阅读。
 */
export function describeIncomplete(stopReason: StopReason | undefined): string {
  switch (stopReason) {
    case 'deadline':
      return '未完成终止：已达单次提交时间上限';
    case 'budget':
      return '未完成终止：token 预算耗尽（可续跑）';
    case 'max-steps':
      return '未完成终止：已达步数上限';
    default:
      return '';
  }
}
