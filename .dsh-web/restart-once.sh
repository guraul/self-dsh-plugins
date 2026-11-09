#!/bin/bash
# 一次性重启助手：延迟执行，让当前对话轮次先把回复发出去。
# 重启后自检：新 PID + 外部讨论插件的健康路由 + 企微连接，结果写进同目录日志。
set -u

LABEL="com.deepseek.dsh-web.self-dsh-plugins"
UID_N="$(id -u)"
DELAY="${1:-30}"
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$DIR/restart-once.log"
PATTERN='dsh --profile web --no-open --port 3080'
STATUS=0

# 真机日志以 LaunchAgent plist 的 StandardOutPath 为准：worktree 里脚本与宿主日志不同目录。
WECOM_LOG="$(grep -A1 '<key>StandardOutPath</key>' "$DIR/$LABEL.plist" 2>/dev/null | sed -n 's|.*<string>\(.*\)</string>.*|\1|p')"
if [[ -z "$WECOM_LOG" ]]; then
  WECOM_LOG="$DIR/web.out.log"
fi
WECOM_MARK='[im-bridge] 认证成功'

{
  echo "=== $(date '+%F %T') 排定重启（延迟 ${DELAY}s，label=${LABEL}）"
  sleep "$DELAY"

  # 企微自检基线：记重启前的日志行数，只认本次重启之后新写入的行
  if [[ -f "$WECOM_LOG" ]]; then
    WECOM_BASELINE=$(($(wc -l < "$WECOM_LOG")))
  else
    WECOM_BASELINE=0
  fi

  echo "--- $(date '+%F %T') 重启前 PID: $(pgrep -f "$PATTERN" | tr '\n' ' ')"
  /bin/launchctl kickstart -k "gui/$UID_N/$LABEL"
  echo "--- kickstart 返回码: $?"

  # 等新宿主起来并装配完插件
  for _ in $(seq 1 30); do
    sleep 2
    if curl -s -m 3 "http://127.0.0.1:3080/api/dsh-external-discuss/health" >/dev/null 2>&1; then
      break
    fi
  done

  echo "--- $(date '+%F %T') 新 PID: $(pgrep -f "$PATTERN" | tr '\n' ' ')"
  echo -n "--- 插件健康检查: "
  curl -s -m 5 "http://127.0.0.1:3080/api/dsh-external-discuss/health" || echo "（无响应）"
  echo ""

  # 企微连接自检：最多等 60 秒，轮询本次重启之后新写入的「认证成功」日志
  WECOM_OK=""
  for _ in $(seq 1 60); do
    sleep 1
    if [[ -f "$WECOM_LOG" ]] && tail -n "+$((WECOM_BASELINE + 1))" "$WECOM_LOG" 2>/dev/null | grep -qF "$WECOM_MARK"; then
      WECOM_OK=1
      break
    fi
  done
  if [[ -n "$WECOM_OK" ]]; then
    echo "企微已连接"
  else
    echo "ERROR: 企微未在 60 秒内连接（见 web.out.log / web.err.log）"
    STATUS=1
  fi

  echo "=== 完成"
} >>"$LOG" 2>&1
exit "$STATUS"
