import { t } from '../i18n';
import { StopReason } from '../types';

/**
 * 未完成终止的用户可见文案（纯函数）。正常完成与模型失败返回空串——
 * 前者无「未完成」可讲，后者已由 error 通道上屏，重复提示只会干扰阅读。
 * 五个枚举成员逐一显式 case：新增 StopReason 成员而未接文案时，
 * default 分支的 never 赋值在编译期即报错（D11：防静默吞掉新枚举值）。
 */
export function describeIncomplete(stopReason: StopReason | undefined): string {
  switch (stopReason) {
    case 'deadline':
      return t('Incomplete: submission time limit reached', '未完成终止：已达单次提交时间上限');
    case 'budget':
      return t('Incomplete: token budget exhausted (resumable)', '未完成终止：token 预算耗尽（可续跑）');
    case 'max-steps':
      return t('Incomplete: max steps reached', '未完成终止：已达步数上限');
    case 'done':
    case 'model-error':
    case undefined:
      return '';
    default: {
      // 枚举扩展守卫：类型层不可达；运行时脏值兜底为显式文案而非空串
      const exhaustive: never = stopReason;
      return t(`Incomplete: ${String(exhaustive)}`, `未完成终止：${String(exhaustive)}`);
    }
  }
}
