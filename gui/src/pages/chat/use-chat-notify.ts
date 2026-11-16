import { useEffect, useRef } from 'react';
import { t } from '../../i18n';

/**
 * Win 完成通知卡(Chat 外提,D62 批I;2026-10-31 用户裁定「桌面端支持 win 的完成右下角卡片提示」):
 * 运行→收束沿且窗口失焦/后台时弹系统通知(前台在看不弹不打扰);点击通知聚焦窗口。Notification
 * 不可用的环境(旧壳/权限拒绝)静默降级。文案定版(2026-11-01 用户裁定):标题「运行完成」,正文
 * 「任务:{会话名称}」;点击经壳桥唤起——hide-on-close/最小化窗 window.focus() 无效,preload
 * focusMain → 主进程 show+focus(还原最小化)。
 */
export function useChatNotify({ running, displayTitle }: { running: boolean; displayTitle: string }): void {
  const prevRunNotifRef = useRef(false);
  useEffect(() => {
    const prev = prevRunNotifRef.current;
    prevRunNotifRef.current = running;
    if (prev === running || running) return; // 只报完成沿
    if (document.hasFocus()) return; // 前台在看=无需提醒
    const name = displayTitle.trim();
    try {
      const n = new Notification(t('Run finished', '运行完成'), {
        body: name !== '' ? `${t('Task', '任务')}：${name}` : t('The session task has completed.', '会话任务已完成。'),
        silent: false,
      });
      n.onclick = (): void => {
        const bridge = window.sunshinexWindow;
        if (bridge?.focusMain !== undefined) bridge.focusMain();
        else window.focus(); // 旧壳无桥:退化为尽力 focus
        n.close();
      };
    } catch {
      /* 无通知能力:静默 */
    }
  }, [running, displayTitle]);
}
