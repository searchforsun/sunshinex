/** 欢迎页 hero 标志（D62 批C 自 WelcomeComposer 外提，纯静态件）。
 *  mark 几何手工镜像 scripts/gen-shell-icon.mjs（ORBIT_RX/RY、STROKE、CORE_R、TILT）——
 *  改形两侧同步,生成面只认脚本单源(窗口图标/托盘/ico 由此回填) */
export function WelcomeLogo(): JSX.Element {
  return (
    <svg className="welcome-logo" width="100" height="100" viewBox="0 0 72 72" fill="none" aria-hidden="true">
      <g transform="rotate(-15 36 36)">
        <g stroke="currentColor" strokeWidth="2.5">
          <path d="M52.11 30.17A19 11 0 0 1 52.11 41.83" />
          <path d="M46.07 45.33A19 11 0 0 1 25.93 45.33" />
          <path d="M19.89 41.83A19 11 0 0 1 19.89 30.17" />
          <path d="M25.93 26.67A19 11 0 0 1 46.07 26.67" />
        </g>
        <circle cx="36" cy="36" r="4.5" fill="currentColor" />
      </g>
    </svg>
  );
}
