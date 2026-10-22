#!/usr/bin/env bash
# 发布 v0.5.0 到 npm + 创建 GitHub Release
# 前置:
#   1) npm 已登录(npm login / ~/.npmrc 内有 read-and-publish token),且 registry 指向官方源
#   2) gh 已登录(gh auth login),或提供 GH_TOKEN 环境变量(推荐,免交互)
# 用法: bash scripts/publish-v0.5.0.sh
set -euo pipefail

# 系统代理会劫持内网/localhost 请求,发布走直连
export NO_PROXY='*'
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy 2>/dev/null || true

VERSION="0.5.0"
TAG="v${VERSION}"
TGZ="y1x1n-dsh-prompt-optimizer-${VERSION}.tgz"
NOTES="docs/release-${TAG}.md"

cd "$(dirname "$0")/.."

echo "=== 0. 预检 ==="
node -e "const v=require('./package.json').version; if(v!=='${VERSION}'){console.error('版本不匹配: '+v+' != ${VERSION}');process.exit(1)}; console.log('package.json 版本 OK: '+v)"
[ -f "$TGZ" ] || { echo "缺失 tarball,先跑 npm pack"; exit 1; }
[ -f "$NOTES" ] || { echo "缺失 release notes: $NOTES"; exit 1; }

echo "=== 1. 检查 npm registry 与登录 ==="
REG=$(npm config get registry)
echo "当前 registry: $REG"
case "$REG" in
  *registry.npmjs.org*) : ;;
  *) echo "⚠️  registry 不是官方源,正在切换..."; npm config set registry https://registry.npmjs.org/ ;;
esac

# npm 认证失败不阻断 GitHub Release:两者是独立渠道,v0.4.0 的先例是
# 只发 GitHub Release(当时 npm 也未发布)。带上 NPM_OK 标志继续。
NPM_OK=0
if npm whoami >/dev/null 2>&1; then
  echo "npm 登录态 OK: $(npm whoami)"
  NPM_OK=1
else
  echo "⚠️  npm 未登录或 token 失效(E401),将跳过 npm 发布,仅创建 GitHub Release"
fi

if [ "$NPM_OK" = "1" ]; then
  echo "=== 2. 发布到 npm ==="
  # 若已发布过同版本,npm 会报错;此处直接暴露错误由调用方判断
  npm publish "$TGZ" --access public
else
  echo "=== 2. 跳过 npm 发布(whoami 失败) ==="
fi

echo "=== 3. 创建 GitHub Release ==="
if [ -n "${GH_TOKEN:-}" ]; then
  echo "使用 GH_TOKEN 创建 Release..."
  gh release create "$TAG" "$TGZ" \
    --title "$TAG — 长文本优化提速 + opencode 会话头兜底 + 解析与路由健壮性修复" \
    --notes-file "$NOTES"
elif command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh release create "$TAG" "$TGZ" \
    --title "$TAG — 长文本优化提速 + opencode 会话头兜底 + 解析与路由健壮性修复" \
    --notes-file "$NOTES"
else
  echo "⚠️  gh 未登录且未提供 GH_TOKEN,跳过自动化创建。请手动到以下地址创建 Release 并上传 $TGZ:"
  echo "    https://github.com/Y1X1n/dsh-prompt-optimizer/releases/new?tag=$TAG"
fi

if [ "$NPM_OK" = "0" ]; then
  echo "=== 注意 ==="
  echo "npm 上仍为旧版本;更新 ~/.npmrc 的 token 后重新执行本脚本即可补发(同版本可重跑,GitHub Release 已存在时会报错,可忽略该步)。"
fi

echo "=== 完成 ==="
