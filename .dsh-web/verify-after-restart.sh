#!/bin/bash
# 重启后的插件验收：等新宿主起来（判据：/status 报 plugin 0.2.2），再跑只读探针。
# 与 restart-once.sh 同款用法：后台跑，日志写同目录。
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$DIR/post-restart-verify.log"
BASE="http://127.0.0.1:3080"
SKILL="$HOME/.agents/skills/playwright-skill"

{
  echo "=== $(date '+%F %T') 等待新宿主（判据：/api/dsh-auto-upgrade/status 报 plugin 0.2.2）"

  ready=0
  deadline=$(( $(date +%s) + 300 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 3
    body="$(curl -s -m 3 "$BASE/api/dsh-auto-upgrade/status" 2>/dev/null)"
    case "$body" in
      *'"version":"0.2.2"'*) ready=1; break ;;
    esac
  done

  if [ "$ready" = 1 ]; then
    echo "--- $(date '+%F %T') 新宿主已就绪：插件版本 0.2.2 ✓（说明宿主重新读了 manifest）"
  else
    echo "--- $(date '+%F %T') 超时（300s）：仍未看到 0.2.2，下面照样记录现状供排查"
  fi

  echo -n "--- /status: "
  curl -s -m 8 "$BASE/api/dsh-auto-upgrade/status" || echo "（无响应）"
  echo ""
  echo -n "--- /plugins 里的本插件行: "
  curl -s -m 15 "$BASE/api/dsh-auto-upgrade/plugins" \
    | tr ',' '\n' | grep -A 2 'dsh-plugin-auto-upgrade' | head -6 || echo "（无响应）"
  echo ""

  URL="$(grep -ah 'dsh web: http' "$DIR/web.out.log" 2>/dev/null | tail -1 | sed 's/.*dsh web: //')"
  if [ -z "$URL" ]; then
    echo "--- 取不到新 URL（web.out.log 里没有 dsh web: 行），跳过浏览器探针"
  elif [ ! -d "$SKILL" ]; then
    echo "--- 找不到 playwright 技能目录 $SKILL，跳过浏览器探针"
  else
    echo "--- $(date '+%F %T') 浏览器探针（URL token 已隐去）: ${URL%%\?*}?token=…"
    ( cd "$SKILL" && DSH_URL="$URL" node run.js "$DIR/post-restart-probe.mjs" ) 2>&1 \
      | grep -v CVDisplayLink
  fi

  echo "=== $(date '+%F %T') 完成（重启前该插件报 0.1.0 / 旧 inject；现在应为 0.2.2 / 四个新包）"
} >>"$LOG" 2>&1
