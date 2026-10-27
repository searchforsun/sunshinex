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
  fontPreset: 'sunshinex.font-preset',
} as const;

let conn: UiPrefConn | null = null;
let pending: Partial<Record<keyof typeof LOCAL_KEYS, string>> = {};
let flushTimer: number | undefined;
/** 远程值应用中(抑制 notify 回环:appliers→applyZoom→notify 会把服务端旧值重新入队,
 *  旧值反过来覆盖新值——「放大缩小失效,每次都回 110%」根因) */
let applyingRemote = false;
/** boot 拉取后的应用回调(宿主注入——避免本模块反向依赖 ui-zoom/theme 造成环) */
let appliers: { zoom: (v: string) => void; theme: (v: string) => void; fontPreset: (v: string) => void } | null = null;

/** 连接就绪后调用一次:拉公共档覆盖本地,并回填本地缺键 */
export function initUiPrefSync(c: UiPrefConn, apply: { zoom: (v: string) => void; theme: (v: string) => void; fontPreset: (v: string) => void }): void {
  conn = c;
  appliers = apply;
  void flush();
}

/** 偏好变更上抛(去抖合并;未连接时仅队列,连接建立后冲刷) */
export function notifyUiPref(key: keyof typeof LOCAL_KEYS, value: string): void {
  if (applyingRemote) return; // 远程应用引发的 setItem/apply 不回环入队
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
    // ① 本地 pending 优先(=用户最新意图,先落 blob+本地)
    for (const short of Object.keys(pending) as Array<keyof typeof LOCAL_KEYS>) {
      const v = pending[short];
      if (v !== undefined) {
        blob[short] = v;
        localStorage.setItem(LOCAL_KEYS[short], v);
      }
    }
    pending = {};
    // ② 服务端权威仅补无 pending 的键;应用远程值时 applyingRemote 抑制回环
    applyingRemote = true;
    for (const short of Object.keys(LOCAL_KEYS) as Array<keyof typeof LOCAL_KEYS>) {
      const server = blob[short];
      const local = localStorage.getItem(LOCAL_KEYS[short]);
      if (typeof server === 'string' && server !== '') {
        if (local !== server) {
          localStorage.setItem(LOCAL_KEYS[short], server);
          if (short === 'uiZoom') appliers?.zoom(server);
          if (short === 'theme') appliers?.theme(server);
          if (short === 'fontPreset') appliers?.fontPreset(server);
        }
      } else if (local !== null && local !== '') {
        blob[short] = local; // 服务端缺键:本地回填上收(旧档/首联)
      }
    }
    applyingRemote = false;
    // 恒回写(幂等):①pending 落 blob/②本地回填上收都改 blob,且上次 flush 的远端写也可能尚未
    // 冲合——不做 changed 记账(2026-10-27 技术债轮 I1:原 `changed || true` 恒真+死记账误导,删)
    await conn.saveAppGuiState(blob);
  } catch {
    // 断链/旧 daemon 无端点:静默——本地层自足,下一拍重试
    window.clearTimeout(flushTimer);
    flushTimer = window.setTimeout(() => void flush(), 5000);
  }
}
