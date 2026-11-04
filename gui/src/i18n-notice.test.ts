import { describe, expect, it, beforeEach } from 'vitest';
import { localizeNotice } from './i18n-notice';
import { setLanguage } from './i18n';

/**
 * 固定提示/告警头渲染面本地化单测（2026-11-04 裁定细化：固定系统提示与固定告警头随 GUI 语言
 * 渲染，动态内容按捕获组透传）。模式表与 daemon 文案人工同源——本表即防脱节锚：
 * daemon 侧文案变更（src/serve/session-commands.ts、src/serve/session.ts）不更新模式表即测红。
 */

/** 映射面用例钉 zh（语言门：en 整行透传，专测见末组） */
beforeEach(() => setLanguage('zh'));

describe('localizeNotice /plan 全族', () => {
  it('bare /plan 武装与幂等提示', () => {
    expect(localizeNotice('Plan mode on — submissions will be planned first')).toBe('已进入计划模式：提交将先规划再确认实施');
    expect(localizeNotice('Already in plan mode')).toBe('已处于计划模式');
  });

  it('/plan off 解除武装三态', () => {
    expect(localizeNotice('Left plan mode')).toBe('已退出计划模式');
    expect(localizeNotice('Not in plan mode')).toBe('当前不在计划模式');
    expect(localizeNotice('Busy — leave plan mode when the session is idle')).toBe('会话忙——空闲后再退出计划模式');
  });

  it('带目标提交的入队提示(计划裁决诊断行已退役:2026-11-04 用户裁定「用户不关心,从底层去掉」——卡面即结果)', () => {
    expect(localizeNotice('Queued — planning will start when the current task finishes')).toBe('已入队：当前任务收口后将先规划');
    // 计划裁决不再 pump 系统提示:英文原行透传(无 zh 映射)即证映射面已摘
    expect(localizeNotice('plan-approval p12 resolved: approved')).toBe('plan-approval p12 resolved: approved');
  });

  it('规划中断标签', () => {
    expect(localizeNotice('Planning interrupted')).toBe('规划已中断');
  });
});

describe('localizeNotice 挂起裁决与压缩/构成回执', () => {
  it('approval 裁决三态与 ask 作答:pid 透传', () => {
    expect(localizeNotice('approval p7 resolved: allow')).toBe('审批 p7 已裁决：允许');
    expect(localizeNotice('approval p7 resolved: deny')).toBe('审批 p7 已裁决：拒绝');
    expect(localizeNotice('approval p7 resolved: always')).toBe('审批 p7 已裁决：总是允许');
    expect(localizeNotice('ask p9 answered')).toBe('问询 p9 已作答');
  });

  it('压缩完成行捕获组回填', () => {
    expect(localizeNotice('Compressed: 3 summary chunks re-injected (ctx 90000 → 40000 tokens)')).toBe(
      '已压缩：3 个摘要块重注入（水位 90000 → 40000 tokens）',
    );
  });

  it('压缩中提示:daemon 现文案无省略号,旧省略号形态兼容双命中', () => {
    expect(localizeNotice('Compacting context')).toBe('上下文压缩中');
    expect(localizeNotice('Compacting context…')).toBe('上下文压缩中');
  });

  it('/context 整块:头与尾总量本地化,明细正文原样保留(旧裸前缀命中即整替吞正文,回归钉)', () => {
    const md = 'Context breakdown:\nstable: 1200 (30%)\nchain: 2800 (70%)\ntotal 4000 / 200000';
    expect(localizeNotice(md)).toBe('上下文构成：\nstable: 1200 (30%)\nchain: 2800 (70%)\n总量 4000 / 200000');
  });

  it('/context 无 total 尾行的形态:前缀兜底保正文不吞', () => {
    expect(localizeNotice('Context breakdown:\nstable: 10 (100%)')).toBe('上下文构成：\nstable: 10 (100%)');
  });
});

describe('localizeNotice skills/memory/archive/delete 族', () => {
  it('/skills-rm 三态', () => {
    expect(localizeNotice('Learned skill removed: web-docs')).toBe('已删除学习技能：web-docs');
    expect(localizeNotice("No learned skill 'x' in this workspace")).toBe('本工作区没有学习技能 "x"');
    expect(localizeNotice('Usage: /skills-rm <id> — remove a learned skill from this workspace')).toBe('用法：/skills-rm <id>——删除本工作区的一个学习技能');
  });

  it('/memory-on|off', () => {
    expect(localizeNotice('Persistent memory on for this session')).toBe('本会话持久记忆已开启');
    expect(localizeNotice('Persistent memory off for this session')).toBe('本会话持久记忆已关闭');
  });

  it('/archive /unarchive /delete 全部固定回执', () => {
    expect(localizeNotice('Nothing to archive yet')).toBe('暂无可归档的会话档');
    expect(localizeNotice('Session archived')).toBe('已归档');
    expect(localizeNotice('Nothing to unarchive yet')).toBe('暂无可撤销归档的会话档');
    expect(localizeNotice('Session is not archived')).toBe('该会话未在归档中');
    expect(localizeNotice('Session unarchived')).toBe('已撤销归档');
    expect(localizeNotice('Nothing to delete yet')).toBe('暂无可删除的会话档');
    expect(localizeNotice('Archive first (/archive), then /delete')).toBe('先归档（/archive）再删除');
    expect(localizeNotice('Session deleted')).toBe('已删除');
  });
});

describe('localizeNotice /status、中断泛式与透传兜底', () => {
  it('/status 行:状态闭集词拆分映射(running/idle),未知状态词落泛式透传', () => {
    expect(localizeNotice('session abc · running · model gpt-x · mode plan')).toBe('会话 abc · 运行中 · 模型 gpt-x · 权限 plan');
    expect(localizeNotice('session abc · idle · model gpt-x · mode acceptEdits')).toBe('会话 abc · 空闲 · 模型 gpt-x · 权限 acceptEdits');
    expect(localizeNotice('session abc · busy · model gpt-x · mode plan')).toBe('会话 abc · busy · 模型 gpt-x · 权限 plan');
  });

  it('命令中断:专有名先命中,泛式按命令词透传', () => {
    expect(localizeNotice('Context compaction interrupted')).toBe('上下文压缩已中断');
    expect(localizeNotice('/status interrupted')).toBe('/status 已中断');
  });

  it('未命中模式原样透出(未知/新命令回执英文兜底不丢信息;模型正文/动态内容零触碰)', () => {
    const md = 'Plan for the migration:\n1. do X\n2. do Y';
    expect(localizeNotice(md)).toBe(md);
    expect(localizeNotice('')).toBe('');
  });

  it('daemon 中文回执(表不命中)原样透出', () => {
    expect(localizeNotice('已退出计划模式')).toBe('已退出计划模式');
  });

  it('语言门:GUI 英文整行透传(en 用户看 en——命中表也不强翻中文,e2e 断言撕裂根因)', () => {
    setLanguage('en');
    expect(localizeNotice('Left plan mode')).toBe('Left plan mode');
    expect(localizeNotice('approval p1 resolved: allow')).toBe('approval p1 resolved: allow');
    expect(localizeNotice('Compressed: 3 summary chunks re-injected (ctx 90000 → 40000 tokens)')).toBe(
      'Compressed: 3 summary chunks re-injected (ctx 90000 → 40000 tokens)',
    );
  });
});
