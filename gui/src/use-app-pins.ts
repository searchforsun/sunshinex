import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { Connection } from './connection';
import { normalizePins, type PinEntry } from './sidebar/pin-store';

/** 置顶档单源(D62 批H 二段一段 自 App.tsx 逐字平迁,行为零变化):乐观态直更零往返;持久化双写——
 *  本地镜像(瞬时)+gui/pins.json(服务端,重启不丢)。此前慢/Failed to fetch 真凶=daemon
 *  keepAliveTimeout 5s 关空闲连接,浏览器池中旧 socket 上 PUT 不重试直接炸(服务端已加长 65s);
 *  网络失败走本地镜像兜底,置顶标记永不因网络丢失 */
export function useAppPins(
  connRef: MutableRefObject<Connection | null>,
  connInstance: Connection | null,
): { pins: PinEntry[]; persistPins: (next: PinEntry[]) => void } {
  const [pins, setPins] = useState<PinEntry[]>(() => normalizePins((() => {
    try {
      return JSON.parse(localStorage.getItem('sunshinex.pins') ?? '[]');
    } catch {
      return [];
    }
  })()));
  const pendingPinsRef = useRef<PinEntry[] | null>(null);
  const persistPins = useCallback((next: PinEntry[]): void => {
    setPins(next);
    try {
      localStorage.setItem('sunshinex.pins', JSON.stringify(next));
    } catch {
      /* 隐私模式静默 */
    }
    void connRef.current?.saveAppPins(next).then(
      () => {
        try {
          localStorage.removeItem('sunshinex.pins'); // 服务端落库成功:本地镜像使命完成
        } catch {
          /* 静默 */
        }
      },
      () => undefined, // 网络失败:本地镜像已在,重启读档兜底
    );
  }, [connRef]);
  // 置顶读档:服务端 gui/pins.json 权威(重启不丢),失败/缺档回落本地镜像;PUT 在途跳过防闪屏。
  // 连接就位读一次——置顶态单源在此,此后只经 persistPins 乐观直更,切会话不重拉
  useEffect(() => {
    if (connInstance === null || pendingPinsRef.current !== null || typeof connInstance.appPins !== 'function') return;
    void connInstance.appPins().then(
      (r) => {
        const serverPins = normalizePins(r.pins);
        if (serverPins.length > 0 || pendingPinsRef.current === null) setPins(serverPins);
      },
      () => undefined, // 网络失败:本地镜像已在初值
    );
  }, [connInstance]);
  return { pins, persistPins };
}
