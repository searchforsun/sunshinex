import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { refContentConsume } from './mention';

/** 进程内未落盘草稿镜像(2026-11-25 输入粘滞轮):停顿窗内的最新文本以内存为权威(对齐
 *  scroll-mem 手法)——同键重挂(换座/弹窗重开)初始化读档先查镜像再落 localStorage;flush
 *  落盘后即删,此后读档=盘面即最新 */
const draftMem = new Map<string, string>();
/** 落盘节奏(scroll-mem 同契约):最后一次落盘后 400ms 静默才写(连打中零同步 I/O);
 *  距上次落盘 ≥800ms 的首个改动直写(冷却直写);连打不断时最老未落盘改动满 2s 强制落一次
 *  (硬杀丢字上界 2s,同步写 ≤0.5 次/s) */
const DRAFT_SETTLE_MS = 400;
const DRAFT_COOLDOWN_MS = 800;
const DRAFT_MAXAGE_MS = 2000;

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
    const mirrored = draftMem.get(archiveKey);
    if (mirrored !== undefined) return mirrored;
    try {
      return localStorage.getItem(`sx-draft:${archiveKey}`) ?? '';
    } catch {
      return '';
    }
  });

  /** 落盘去同步化(2026-11-25 用户实测「输入卡顿粘滞,CPU 0.5%→1.2%」根修):旧实现每键同步
   *  setItem×2 + 芯片账本全量 stringify(账本存 @文件全文,可达几百 KB)=主线程磁盘 I/O 打进
   *  按键帧。现内存即权威(上方 draftMem),按 DRAFT_* 节奏停顿落盘,打字中零同步 I/O */
  const inputMirrorRef = useRef(input);
  const pendingKeyRef = useRef(archiveKey);
  const dirtyRef = useRef(false);
  const oldestDirtyAtRef = useRef(0);
  const lastFlushAtRef = useRef(0);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = (): void => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const key = pendingKeyRef.current;
    try {
      localStorage.setItem(`sx-draft:${key}`, inputMirrorRef.current);
      // 芯片内容账本随草稿同键持久化(2026-11-07 用户裁定「重启后草稿片段也要加载出来」):
      // 文本恢复了、账本(内存态)不恢复=芯片空壳 hover/发送皆失。此刻 stringify 而非每键
      localStorage.setItem(`sx-draft-refs:${key}`, JSON.stringify([...refContentsRef.current]));
    } catch {
      // 隐私模式等写失败静默:草稿是尽力而为的会话便利,不入错误面
    }
    draftMem.delete(key);
    lastFlushAtRef.current = Date.now();
  };
  useEffect(() => {
    // 档键切换先把旧键未落盘草稿冲掉(用旧镜像+旧键;迁移面随后读旧键须见最新——本 effect
    // 声明序先于下方迁移 effect)
    if (pendingKeyRef.current !== archiveKey) {
      flush();
      pendingKeyRef.current = archiveKey;
    }
    inputMirrorRef.current = input;
    draftMem.set(archiveKey, input);
    const now = Date.now();
    if (!dirtyRef.current) oldestDirtyAtRef.current = now;
    dirtyRef.current = true;
    if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current);
    if (now - lastFlushAtRef.current > DRAFT_COOLDOWN_MS || now - oldestDirtyAtRef.current > DRAFT_MAXAGE_MS) flush();
    else flushTimerRef.current = setTimeout(flush, DRAFT_SETTLE_MS);
  }, [input, archiveKey, refContentsRef]);
  // 卸载冲刷:换会话/关座前把未落盘草稿写掉(同键紧邻重挂的读档面由 draftMem 镜像兜——
  // 新实例 initializer 在 render 期先跑,早于本实例 cleanup)
  useEffect(() => flush, []);
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
