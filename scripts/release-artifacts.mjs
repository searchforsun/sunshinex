// 桌面安装包命名单点（2026-11-09）：与 shell/electron-builder.yml 的 artifactName 模板同口径——
//   sunshinex-<ver>-<os>-<arch>[-setup].<ext>   os=win/mac/linux（electron-builder ${os}）、arch=x64/arm64 等
// release.mjs（收集上传）、shell-dist-smoke.mjs 与 deploy-gui.mjs（按本机挑包）共用，改名只动这里与 yml。
import * as fs from 'node:fs';
import * as path from 'node:path';

const OS_OF_PLATFORM = { win32: 'win', darwin: 'mac', linux: 'linux' };

/** 本机对应的 electron-builder ${os}/${arch} 取值（冒烟/部署只能用本机能跑的包） */
export function nativeTarget() {
  return { os: OS_OF_PLATFORM[process.platform] ?? process.platform, arch: process.arch };
}

/** 解析产物名；不是本格式（含旧格式 sunshinex-<ver>-setup.exe、.blockmap 等旁件）返回 null */
export function parseArtifactName(name) {
  const m = /^sunshinex-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(win|mac|linux)-([0-9A-Za-z_]+)(-setup)?\.(exe|dmg|zip|AppImage|deb|rpm|tar\.gz)$/.exec(name);
  if (m === null) return null;
  return { version: m[1], os: m[2], arch: m[3], setup: m[4] !== undefined, ext: m[5] };
}

/** 输出目录下指定版本的全部桌面产物（按名排序，保证发版说明与上传顺序稳定） */
export function listDesktopArtifacts(dir, version) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => ({ name, info: parseArtifactName(name) }))
    .filter((x) => x.info !== null && (version === undefined || x.info.version === version))
    .map((x) => ({ file: path.join(dir, x.name), name: x.name, ...x.info }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 本机可运行的安装程序（冒烟/部署用）；多个版本并存时取 mtime 最新 */
export function nativeSetup(dir, version) {
  const { os, arch } = nativeTarget();
  const hits = listDesktopArtifacts(dir, version).filter((a) => a.setup && a.os === os && a.arch === arch);
  hits.sort((a, b) => fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs);
  return hits[0];
}

/** 发版说明里的人类可读标签：Windows x64 安装程序 / macOS arm64 等 */
export function artifactLabel(a) {
  const osName = { win: 'Windows', mac: 'macOS', linux: 'Linux' }[a.os] ?? a.os;
  return `${osName} ${a.arch}${a.setup ? ' installer' : ` .${a.ext}`}`;
}
