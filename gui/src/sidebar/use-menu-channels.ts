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
  /** 聊天名称(2026-11-24 用户裁定「hover 显示聊天名称,单聊=聊天人名称,群聊=群聊名称」):
   *  daemon 行透出(meta 出生档/绑定反查双兜底);悬浮卡聊天行显示面,缺席回落 chatId 旧行 */
  chatTitle?: string;
}

/** 通道变更事件（2026-11-25 用户裁定「删除后要立即隐藏对应的通道显示」):设置页删除/保存
 *  成功即广播,ProjectMenu 监听 bump channelReload——通道组立即重拉(容器域/配置双源),不再等
 *  30s tick;窗口事件与 SESSION_ARCHIVE_CHANGED 同款跨组件信号 */
export const CHANNELS_CHANGED_EVENT = 'sunshinex:channels-changed';

export function notifyChannelsChanged(): void {
  window.dispatchEvent(new CustomEvent(CHANNELS_CHANGED_EVENT));
}

/** 平台目录单点（图标 + 双语名 + 新增可选）：侧栏行 / Chat 信息条 / ChannelsPane 下拉三面共用
 *  ——此前 ChannelsPane PLATFORMS 与本表两张注册表并行维护（钉钉/企微启用须双改，已收敛）。
 *  supports=「新增通道」平台下拉可选；mock=daemon 测试夹具（e2e 用），生产下拉不可选；
 *  钉钉/企微「即将支持」占位。未知/缺席平台=中性「通道」回落 */
export const CHANNEL_PLATFORMS: ReadonlyArray<{ v: string; Icon: LucideIcon; en: string; zh: string; supports: boolean }> = [
  { v: 'feishu', Icon: Feather, en: 'Feishu', zh: '飞书', supports: true },
  { v: 'telegram', Icon: Send, en: 'Telegram', zh: 'Telegram', supports: true },
  { v: 'mock', Icon: Bot, en: 'Mock', zh: 'Mock', supports: false },
  { v: 'dingtalk', Icon: MessageCircle, en: 'DingTalk', zh: '钉钉', supports: false },
  { v: 'wecom', Icon: MessagesSquare, en: 'WeCom', zh: '企业微信', supports: false },
];

/** 平台元数据反查（图标+双语名）：未知/缺席=中性「通道」回落 */
export function platformMeta(platform?: string): { Icon: LucideIcon; en: string; zh: string } {
  return CHANNEL_PLATFORMS.find((p) => p.v === platform) ?? { Icon: MessageSquare, en: 'Channel', zh: '通道' };
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

export function useMenuChannels(conn: MenuChannelsConn, rows: WorkspaceRow[] | null, reloadNonce = 0): { rows: ChannelSessionRow[] | null; cfgs: ChannelConfigMsg[] } {
  const [channelRows, setChannelRows] = useState<ChannelSessionRow[] | null>(null);
  /** 通道配置清单（2026-11-25 用户裁定「sunx 类型通道怎么不显示了」根修:组存在性改配置驱动
   *  ——同一次 settingsChannels 拉取顺带回传,通道组播种消费） */
  const [cfgs, setCfgs] = useState<ChannelConfigMsg[]>([]);
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
        .then(([list, cfgView]) => {
          if (!alive) return;
          setCfgs(cfgView.channels);
          const byId = new Map(cfgView.channels.map((c) => [c.id, c]));
          const mapped = list.map((x) => ({
            ...x,
            root: x.root ?? '',
            platform: x.channel !== undefined ? byId.get(x.channel)?.platform : undefined,
            channelName: x.channel !== undefined ? byId.get(x.channel)?.name : undefined,
            channelLabel: x.channel !== undefined && x.channel !== '' ? x.channel : pathBasename(x.root ?? ''),
            // 聊天名称(2026-11-24 用户裁定「hover 显示聊天名称」):daemon 行透出(SessionRow 未
            // 收该键——通道行富化列,随 JSON 直达;cast 窄化取值)
            chatTitle: (x as SessionRow & { chatTitle?: string }).chatTitle,
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
  return { rows: channelRows, cfgs };
}
