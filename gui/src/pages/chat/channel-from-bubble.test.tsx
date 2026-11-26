import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { UserEntryView } from './EntryViews';
import type { ChatEntry } from '../../chat-reducer';
import { setLanguage } from '../../i18n';

setLanguage('zh');

function userEntry(md: string): ChatEntry {
  return { key: 'k1', kind: 'user', md, ts: Date.now() };
}

/** 通道群聊来源章（2026-11-25 用户裁定「参考智能体团队,在气泡上侧显示一个飞书图标跟上用户名称,
 *  不用显示成蓝色,因为不可跳转,hover 时显示对应飞书 id」）:router ⑫ 的 `[来自 x]: ` 前缀从气泡
 *  正文剥离,改由上侧来源行承载;hover 走 data-tip(名称缺席时 router 以 userId 兜底=即 id) */
describe('通道消息气泡来源行', () => {
  it('前缀剥离:正文不含 [来自],来源行显发送者(飞书图标),data-tip=发送者 id', () => {
    const { container } = render(<UserEntryView entry={userEntry('[来自 ou_abc123]: 帮我看下这个报错')} platform="feishu" />);
    expect(container.textContent).toContain('帮我看下这个报错');
    expect(container.textContent).not.toContain('[来自');
    const from = container.querySelector('.user-from-channel .user-from-sunx-btn');
    expect(from).not.toBeNull();
    expect(from!.getAttribute('data-tip')).toBe('ou_abc123');
    expect(from!.textContent).toContain('ou_abc123');
    expect(from!.querySelector('svg')).not.toBeNull(); // 平台图标(飞书)
    // 非链接形态:不可点(span 非 button),无 underline 语义
    expect(from!.tagName).toBe('SPAN');
  });

  it('单聊无前缀:普通用户气泡零变化(无来源行)', () => {
    const { container } = render(<UserEntryView entry={userEntry('单聊原文')} platform="feishu" />);
    expect(container.querySelector('.user-from-channel')).toBeNull();
    expect(container.textContent).toContain('单聊原文');
  });

  it('辅助会话不剥前缀:sideChat 口径保持原状', () => {
    const { container } = render(<UserEntryView entry={userEntry('[来自 张三]: 旁问')} platform="feishu" sideChat />);
    expect(container.querySelector('.user-from-channel')).toBeNull();
    expect(container.textContent).toContain('[来自 张三]: 旁问');
  });
});
