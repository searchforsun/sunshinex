#!/bin/sh
# SunshineX 发版脚本：全量验证 → npm pack → 创建 GitHub Release 并上传 tgz 附件。
# 发布后任何机器一条链接直装（npm 原生支持 tarball URL）：
#   npm install -g https://github.com/<owner>/<repo>/releases/download/<tag>/<name>-<version>.tgz
set -eu

usage() {
  cat <<'USAGE'
用法: scripts/release.sh [--dry-run] [--skip-verify] [--allow-dirty]

  --dry-run      只做全量验证 + npm pack，不触网上传（打印将产生的安装链接）
  --skip-verify  跳过全量测试与 selfcheck（不推荐）
  --allow-dirty  允许工作区未提交/未推送时发布（tag 打在远端 HEAD，本地未推送提交不包含在内）

上传通道（自动探测，二选一）:
  1. gh CLI（推荐）          gh auth login 一次即可
  2. GITHUB_TOKEN + curl + jq  GITHUB_TOKEN=<pat> scripts/release.sh
USAGE
}

die() { echo "release: $*" >&2; exit 1; }
say() { echo "==> $*"; }

DRY_RUN=0
SKIP_VERIFY=0
ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$arg（支持 --dry-run / --skip-verify / --allow-dirty，--help 看用法）" ;;
  esac
done

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(dirname -- "$SCRIPT_DIR")
cd -- "$ROOT"

command -v node >/dev/null 2>&1 || die "需要 node（≥22.9，见 package.json engines）"
command -v npm >/dev/null 2>&1 || die "需要 npm"
command -v git >/dev/null 2>&1 || die "需要 git"

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
TGZ_NAME="sunshinex-agent-$VERSION.tgz"

REPO=$(git remote get-url origin 2>/dev/null | sed -E 's#^git@github\.com:##; s#^https://github\.com/##; s#\.git$##') \
  || die "未找到 origin 远程"
echo "$REPO" | grep -Eq '^[^/]+/[^/]+$' || die "origin 不是 github 仓库：$REPO"

# 正式发布要求工作区干净且已推送：tag 由 GitHub 打在远端 HEAD，本地未推送的提交不会进 Release
if [ "$DRY_RUN" -eq 0 ] && [ "$ALLOW_DIRTY" -eq 0 ]; then
  [ -z "$(git status --porcelain)" ] || die "工作区有未提交改动：先提交推送，或加 --allow-dirty"
  UPSTREAM=$(git rev-parse '@{u}' 2>/dev/null || true)
  if [ -n "$UPSTREAM" ] && [ "$UPSTREAM" != "$(git rev-parse HEAD)" ]; then
    die "本地 HEAD 与上游不一致：先 git push，或加 --allow-dirty"
  fi
fi

if [ "$SKIP_VERIFY" -eq 0 ]; then
  say "全量验证（tsc + node --test 全量 + selfcheck）"
  if command -v pnpm >/dev/null 2>&1; then pnpm run test; else npm run test; fi
  node --env-file-if-exists=.env dist/cli/index.js selfcheck
fi

say "npm pack → $TGZ_NAME"
TGZ=$(npm pack --cache .npm-cache 2>/dev/null | tail -n 1)
[ -f "$TGZ" ] || die "npm pack 未产出 $TGZ_NAME（实际输出：$TGZ）"
say "包体：$(du -h "$TGZ" | cut -f1) $TGZ"

DOWNLOAD_URL="https://github.com/$REPO/releases/download/$TAG/$TGZ"
# curl 通道的 JSON body 不换行、不含双引号（JSON 字符串字面量限制）
NOTES="SunshineX TUI $TAG. Install: npm install -g $DOWNLOAD_URL"

if [ "$DRY_RUN" -eq 1 ]; then
  say "--dry-run 结束：未触网。正式发布将执行 gh release create（或 curl 通道）并上传 $TGZ_NAME"
  echo "  安装链接：npm install -g $DOWNLOAD_URL"
  exit 0
fi

if command -v gh >/dev/null 2>&1; then
  say "gh CLI 通道：创建/更新 Release $TAG"
  if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
    gh release upload "$TAG" "$TGZ" -R "$REPO" --clobber
    say "Release $TAG 已存在，附件覆盖上传完成"
  else
    gh release create "$TAG" "$TGZ" -R "$REPO" --title "$TAG" --notes "$NOTES"
  fi
elif command -v curl >/dev/null 2>&1 && [ -n "${GITHUB_TOKEN:-}" ] && command -v jq >/dev/null 2>&1; then
  say "curl + GITHUB_TOKEN 通道：创建/更新 Release $TAG"
  AUTH="Authorization: Bearer $GITHUB_TOKEN"
  API="https://api.github.com/repos/$REPO/releases"
  RESP=$(curl -sf -X POST -H "$AUTH" -H "Accept: application/vnd.github+json" \
    -d "{\"tag_name\":\"$TAG\",\"name\":\"$TAG\",\"body\":\"$NOTES\"}" "$API") \
    || RESP=$(curl -sf -H "$AUTH" "$API/tags/$TAG") \
    || die "创建/查询 Release 失败（检查 GITHUB_TOKEN 是否具备 repo 权限）"
  UPLOAD_URL=$(printf '%s' "$RESP" | jq -r '.upload_url' | sed 's/{.*//')
  [ -n "$UPLOAD_URL" ] && [ "$UPLOAD_URL" != "null" ] || die "未取得 upload_url"
  curl -sf -X POST -H "$AUTH" -H "Content-Type: application/octet-stream" \
    --data-binary @"$TGZ" "$UPLOAD_URL?name=$TGZ_NAME" >/dev/null || die "附件上传失败"
else
  die "缺少上传通道：安装 gh CLI（gh auth login），或提供 GITHUB_TOKEN 且装有 curl + jq"
fi

say "发布完成"
echo "  Release 页：https://github.com/$REPO/releases/tag/$TAG"
echo "  安装命令：npm install -g $DOWNLOAD_URL"
