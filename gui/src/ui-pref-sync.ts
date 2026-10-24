/**
 * 公共持久化偏好上收(2026-10-24 用户裁定「能放到公共持久化的务必放到公共持久化文件」):
 * GUI 偏好双写——localStorage 仍为即时层(boot 零闪、断链自足),/app/gui-state(公共持久化
 * 文件 userConfigDir/gui/ui-state.json,浏览器/壳跨端共用)为公共权威层。
 * 上收面=ui-zoom/theme(跨端漫游偏好);menuWidth 系窗口形状相关,保持设备本地不上收。
 * 冲突口径:boot 拉取时服务端已有值覆盖本地(公共权威);服务端缺键则本地回填上收(旧档首联)。
 */
type UiPrefConn = {
  appGuiState(): Promise<{ state: unknown }>;
  saveAppGuiState(state: object): Promise<void>;
};

const LOCAL_KEYS = {
  uiZoom: 'sunshinex.ui-zoom',
  theme: 'sunshinex.theme',
} as const;

let conn: UiPrefConn | null = null;
let pending: Partial<Record<keyof typeof LOCAL_KEYS, string>> = {};
let flushTimer: number | undefined;
/** boot 拉取后的应用回调(宿主注入——避免本模块反向依赖 ui-zoom/theme 造成环) */
let appliers: { zoom: (v: string) => void; theme: (v: string) => void } | null = null;

/** 连接就绪后调用一次:拉公共档覆盖本地,并回填本地缺键 */
export function initUiPrefSync(c: UiPrefConn, apply: { zoom: (v: string) => void; theme: (v: string) => void }): void {
  conn = c;
  appliers = apply;
  void flush();
}

/** 偏好变更上抛(去抖合并;未连接时仅队列,连接建立后冲刷) */
export function notifyUiPref(key: keyof typeof LOCAL_KEYS, value: string): void {
  pending[key] = value;
  if (conn === null) return;
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => void flush(), 400);
}

async function flush(): Promise<void> {
  if (conn === null) return;
  try {
    const { state } = await conn.appGuiState();
    const blob = state !== null && typeof state === 'object' && !Array.isArray(state) ? { ...state } as Record<string, unknown> : {};
    let changed = false;
    for (const short of Object.keys(LOCAL_KEYS) as Array<keyof typeof LOCAL_KEYS>) {
      const local = localStorage.getItem(LOCAL_KEYS[short]);
      const server = blob[short];
      if (typeof server === 'string' && server !== '') {
        // 公共权威:服务端有值覆盖本地(并应用)
        if (local !== server) {
          localStorage.setItem(LOCAL_KEYS[short], server);
          if (short === 'uiZoom') appliers?.zoom(server);
          if (short === 'theme') appliers?.theme(server);
        }
      } else if (local !== null && local !== '') {
        // 服务端缺键:本地回填上收(旧档/首联)
        blob[short] = local;
        changed = true;
      }
    }
    // 队列中的新值最后落(覆盖上面拉回的旧值)
    for (const short of Object.keys(pending) as Array<keyof typeof LOCAL_KEYS>) {
      const v = pending[short];
      if (v !== undefined && blob[short] !== v) {
        blob[short] = v;
        localStorage.setItem(LOCAL_KEYS[short], v);
        changed = true;
      }
    }
    pending = {};
    if (changed) await conn.saveAppGuiState(blob);
  } catch {
    // 断链/旧 daemon 无端点:静默——本地层自足,下一拍重试
    window.clearTimeout(flushTimer);
    flushTimer = window.setTimeout(() => void flush(), 5000);
  }
}
