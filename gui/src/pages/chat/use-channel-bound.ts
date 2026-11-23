import { useEffect, useState } from 'react';
import type { ChannelBindingMsg } from '../../connection-api';

/**
 * 通道会话判定(2026-11-22 用户裁定系列):journalId 命中绑定档 = 通道域会话。返回
 * { isChannel, chatId, platform }——① MessageList 空态:通道会话走欢迎页样式分支(平台大图标
 * +「新会话」);② ChatTopbar ⋯ 菜单:通道会话去置顶、复制会话 ID=平台聊天 id(飞书 oc_);
 * platform=配置读面反查(空态大图标随应用;拉取失败=undefined 走中性图标)。
 * 拉取失败/conn 缺方法(旧测试桩)=非通道口径静默降级(ChannelInfoBar 同语义)。
 */
export interface ChannelJournalInfo {
  readonly isChannel: boolean;
  /** 平台聊天会话标识(飞书 oc_ / Telegram chat id 等;绑定 key=`<channelId>:<chatId>` 尾段) */
  readonly chatId: string;
  /** 通道平台(配置读面反查;缺席=未知) */
  readonly platform?: string;
}

interface ChannelBoundConn {
  channelBindings?(): Promise<{ bindings: ChannelBindingMsg[] }>;
  settingsChannels?(): Promise<{ channels: Array<{ id: string; platform: string }>; warnings: string[] }>;
}

const EMPTY: ChannelJournalInfo = { isChannel: false, chatId: '' };

/** 绑定键拆解单点:key=`channelId:chatId`,channelId 惯例不含 ':'(engine/router 裁定)——
 *  首 ':' 切分,chatId 段保留其余(含 ':' 等保留字)。Chat 信息条同款消费(原两份内联已收编) */
export function splitBindingKey(key: string): { channelId: string; chatId: string } {
  const i = key.indexOf(':');
  return i < 0 ? { channelId: key, chatId: '' } : { channelId: key.slice(0, i), chatId: key.slice(i + 1) };
}

export function useChannelJournalInfo(conn: ChannelBoundConn | null, journalId: string): ChannelJournalInfo {
  const [info, setInfo] = useState<ChannelJournalInfo>(EMPTY);
  useEffect(() => {
    if (conn === null || journalId === '' || typeof conn.channelBindings !== 'function') {
      setInfo(EMPTY);
      return;
    }
    let alive = true;
    conn.channelBindings().then(
      (r) => {
        if (!alive) return;
        const hit = r.bindings.find((b) => b.journalId === journalId);
        if (hit === undefined) {
          setInfo(EMPTY);
          return;
        }
        const { channelId, chatId } = splitBindingKey(hit.key);
        setInfo({ isChannel: true, chatId, platform: undefined });
        // 平台反查(配置读面;失败静默=platform 缺席,图标走中性通道形)
        if (typeof conn.settingsChannels === 'function') {
          conn.settingsChannels().then(
            (cfgs) => {
              if (!alive) return;
              const platform = cfgs.channels.find((c) => c.id === channelId)?.platform;
              setInfo({ isChannel: true, chatId, platform });
            },
            () => undefined,
          );
        }
      },
      () => {
        if (alive) setInfo(EMPTY); // 拉取失败=非通道口径(信息条整块 null 同语义)
      },
    );
    return () => {
      alive = false;
    };
  }, [conn, journalId]);
  return info;
}
