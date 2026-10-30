#!/bin/bash
# 一次性重启助手：延迟执行，让当前对话轮次先把回复发出去。
# 重启后自检：新 PID + 外部讨论插件的健康路由，结果写进同目录日志。
set -u

LABEL="com.deepseek.dsh-web.self-dsh-plugins"
UID_N="$(id -u)"
DELAY="${1:-30}"
LOG="$(cd "$(dirname "$0")" && pwd)/restart-once.log"
PATTERN='dsh --profile web --no-open --port 3080'

{
  echo "=== $(date '+%F %T') 排定重启（延迟 ${DELAY}s，label=${LABEL}）"
  sleep "$DELAY"

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
  echo "=== 完成"
} >>"$LOG" 2>&1
