import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { refContentConsume } from './mention';

/**
 * 会话草稿持久化簇(Chat 外提,D62 批I):输入草稿按会话持久化(2026-10-26 用户裁定,localStorage
 * 键=journalId 优先同滚动存档口径)——切会话/重启回来都能恢复未发送文本;发送置空即清档;芯片内容
 * 账本随草稿同键持久化(2026-11-07 用户裁定「重启后草稿片段也要加载出来」)。键迁移(2026-11-07
 * 用户实测「欢迎页升级后点会话行,草稿被清」根修):升级链 journalId 晚到,archiveKey 由临时
 * sessionId 切到 journalId——旧键草稿/芯片账本整体迁到新键(新键已有非空草稿=真换会话,不迁)。
 * 账本回灌只补不清现有——每档键只回灌一次(渲染期同步读盘,逐渲染执行=流式每帧付一次 localStorage
 * 往返);首问 token 内容入私有账本亦渲染期直写(2026-11-07 实测时序根修:子组件 ComposerCard 的
 * 规范化 effect 先于本组件 effect 执行,种子晚于改名=键对不上=回落全局注册表取到别会话内容)。
 */
export function useChatDraft({ archiveKey, refContentsRef, initialInsert, initialInsertContent }: {
  archiveKey: string;
  refContentsRef: { current: Map<string, string> };
  initialInsert: string | undefined;
  initialInsertContent: string | undefined;
}): { input: string; setInput: Dispatch<SetStateAction<string>> } {
  const [input, setInput] = useState<string>(() => {
    try {
      return localStorage.getItem(`sx-draft:${archiveKey}`) ?? '';
    } catch {
      return '';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(`sx-draft:${archiveKey}`, input);
      // 芯片内容账本随草稿同键持久化(2026-11-07 用户裁定「重启后草稿片段也要加载出来」):
      // 文本恢复了、账本(内存态)不恢复=芯片空壳 hover/发送皆失。键变更(切会话)即换档
      localStorage.setItem(`sx-draft-refs:${archiveKey}`, JSON.stringify([...refContentsRef.current]));
    } catch {
      // 隐私模式等写失败静默:草稿是尽力而为的会话便利,不入错误面
    }
  }, [input, archiveKey, refContentsRef]);
  // 草稿键迁移(2026-11-07 用户实测「欢迎页升级后点会话行,草稿被清」根修):升级链 journalId
  // 晚到,archiveKey 由临时 sessionId 切到 journalId——新档键下草稿为空,恢复面读到空串=清稿。
  // 键切换时把旧键草稿/芯片账本整体迁到新键(新键已有非空草稿=真换会话,不迁)
  const draftKeyRef = useRef(archiveKey);
  useEffect(() => {
    if (draftKeyRef.current === archiveKey) return;
    const oldKey = draftKeyRef.current;
    draftKeyRef.current = archiveKey;
    try {
      const carried = localStorage.getItem(`sx-draft:${oldKey}`);
      if (carried !== null && carried !== '' && (localStorage.getItem(`sx-draft:${archiveKey}`) ?? '') === '') {
        localStorage.setItem(`sx-draft:${archiveKey}`, carried);
        localStorage.setItem(`sx-draft-refs:${archiveKey}`, localStorage.getItem(`sx-draft-refs:${oldKey}`) ?? '[]');
        localStorage.removeItem(`sx-draft:${oldKey}`);
        localStorage.removeItem(`sx-draft-refs:${oldKey}`);
        setInput(carried);
        const refs = JSON.parse(localStorage.getItem(`sx-draft-refs:${archiveKey}`) ?? '[]') as Array<[string, string]>;
        for (const [k, v] of refs) refContentsRef.current.set(k, v);
      }
    } catch {
      // 档损坏静默:草稿尽力而为
    }
  }, [archiveKey, refContentsRef]);
  // 芯片账本回灌(2026-11-07 落地即清配套:草稿文本有 sx-draft 持久化,账本不持久则恢复的芯片
  // 全空壳)。只补不清现有——insertContent 渲染期种子/事件入账不受影响。每档键只回灌一次:
  // 渲染期同步读盘+JSON 解析,逐渲染执行=流式每帧付一次 localStorage 往返
  const refsHydratedKeyRef = useRef<string | null>(null);
  if (refsHydratedKeyRef.current !== archiveKey) {
    refsHydratedKeyRef.current = archiveKey;
    try {
      const rawRefs = localStorage.getItem(`sx-draft-refs:${archiveKey}`);
      if (rawRefs !== null) {
        for (const [tk, c] of JSON.parse(rawRefs) as Array<[string, string]>) refContentsRef.current.set(tk, c);
      }
    } catch {
      // 档损坏即弃:芯片失去内容是尽力而为面的失败,不入错误面
    }
  }
  // 首问 token 内容入私有账本——渲染期直写(2026-11-07 实测时序根修:子组件 ComposerCard 的
  // 规范化 effect 先于本组件 effect 执行,种子晚于改名=键对不上=回落全局注册表取到别会话内容)
  if (initialInsert !== undefined && initialInsert !== '' && initialInsertContent !== undefined && initialInsertContent !== '') {
    refContentsRef.current.set(initialInsert, initialInsertContent);
    refContentConsume(initialInsert); // 落地即清共享层
  }
  return { input, setInput };
}
