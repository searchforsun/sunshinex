import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Bot, Feather, MessageCircle, MessageSquare, MessagesSquare, Send } from 'lucide-react';
import type { SessionRow, WorkspaceRow } from '../connection';
import type { ChannelConfigMsg } from '../connection-api';
import { pathBasename } from '../ui-util';
import { listShallowEqual } from './project-menu-util';

/** 通道组行集连接面(结构满足即收;App 实传整只 Connection 运行时满足)。可选声明同
 *  ProjectMenuConn.schedules? 先例:旧测试桩缺名=组不渲染,零牵连 */
interface MenuChannelsConn {
  /** GET /channels/sessions(channels Task 9):通道域容器全域枚举——行 root=域目录(GUI attach
   *  直寻址),kind 钉 'channel',channel=出生通道配置 id(Task 13 分组/平台反查键) */
  channelSessions?(): Promise<SessionRow[]>;
  /** GET /settings/channels(channels Task 12):通道配置读面——平台图标按 SessionRow.channel
   *  反查键(实现裁定:反查最顺,域目录名 im-<slug>-<slug> 反解有歧义不采用,报告注明) */
  settingsChannels?(): Promise<{ channels: ChannelConfigMsg[]; warnings: string[] }>;
}

/** 侧栏「通道」组行形(channels Task 13,spec §9.1):SessionRow 携 root 直寻址行,再富化三列
 *  ——platform=平台图标反查结果(配置读面失败/通道标缺席=undefined,行退中性图标);
 *  channelLabel=聊天标识(通道配置 id 优先,域目录 basename 兜底);channelName=应用名称
 *  (2026-11-22 用户裁定「一个应用通道相当于一个项目」:组头展示名=配置 name 优先回退 id) */
export interface ChannelSessionRow extends SessionRow {
  root: string;
  channelLabel: string;
  channelName?: string;
  platform?: ChannelConfigMsg['platform'];
}

/** 平台元数据单点(图标+双语名;Task 13 侧栏行与 Chat 信息条共用——零新依赖,lucide 通用
 *  字形近似各平台品牌,平台名以文字/data-tip 权威):未知/缺席=中性「通道」回落 */
export function platformMeta(platform?: string): { Icon: LucideIcon; en: string; zh: string } {
  switch (platform) {
    case 'feishu':
      return { Icon: Feather, en: 'Feishu', zh: '飞书' };
    case 'dingtalk':
      return { Icon: MessageCircle, en: 'DingTalk', zh: '钉钉' };
    case 'wecom':
      return { Icon: MessagesSquare, en: 'WeCom', zh: '企业微信' };
    case 'telegram':
      return { Icon: Send, en: 'Telegram', zh: 'Telegram' };
    case 'mock':
      return { Icon: Bot, en: 'Mock', zh: 'Mock' };
    default:
      return { Icon: MessageSquare, en: 'Channel', zh: '通道' };
  }
}

/**
 * 「通道」组行集(channels Task 13,spec §9.1;useMenuSunx 平移先例):GET /channels/sessions
 * 域容器全域枚举单点(独立容器专属枚举面,宿主 /sessions 不扫通道域)。行携出生 root(域目录)
 * 直寻址;平台图标信息从 SessionRow.channel 反查 settingsChannels() 取得(配置读面失败静默
 * 降级=platform undefined,行面退中性图标,侧栏计数面非权威数据)。拉取失败按空清单降级;
 * 刷新驱动(2026-11-22 用户实测「发了消息侧栏没有通道组」根修):通道会话由 IM 侧外来创建,
 * 宿主 rows 引用(listShallowEqual 保引用)与 reloadNonce 都不动它——除宿主 nonce 外内置 30s
 * tick 自驱重拉,组新会话落盘后至迟半分钟现身(与既有侧栏刷新节奏同拍)。浅等守卫内容未变保
 * 旧引用。空列=空容器合法空态(组整块不渲染,组内自守卫)。
 */
const CHANNELS_REFRESH_MS = 30_000;

export function useMenuChannels(conn: MenuChannelsConn, rows: WorkspaceRow[] | null, reloadNonce = 0): ChannelSessionRow[] | null {
  const [channelRows, setChannelRows] = useState<ChannelSessionRow[] | null>(null);
  useEffect(() => {
    // 旧桩缺方法守卫(schedules? 同口径):不出「通道」组
    if (typeof conn.channelSessions !== 'function') {
      setChannelRows((prev) => (prev === null ? prev : []));
      return;
    }
    let alive = true;
    const load = (): void => {
      void Promise.all([
        conn.channelSessions!(),
        typeof conn.settingsChannels === 'function'
          ? conn.settingsChannels().catch(() => ({ channels: [], warnings: [] }))
          : Promise.resolve({ channels: [], warnings: [] }),
      ])
        .then(([list, cfgs]) => {
          if (!alive) return;
          const byId = new Map(cfgs.channels.map((c) => [c.id, c]));
          const mapped = list.map((x) => ({
            ...x,
            root: x.root ?? '',
            platform: x.channel !== undefined ? byId.get(x.channel)?.platform : undefined,
            channelName: x.channel !== undefined ? byId.get(x.channel)?.name : undefined,
            channelLabel: x.channel !== undefined && x.channel !== '' ? x.channel : pathBasename(x.root ?? ''),
          }));
          setChannelRows((prev) => (listShallowEqual(prev, mapped) ? prev : mapped));
        })
        .catch(() => {
          if (alive) setChannelRows([]);
        });
    };
    load();
    const timer = window.setInterval(load, CHANNELS_REFRESH_MS); // IM 侧外来创建自驱重拉(见上注)
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [rows, conn, reloadNonce]);
  return channelRows;
}
