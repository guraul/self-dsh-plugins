#!/bin/bash
# 重启 dsh web + 重启后验收（一次性）。
#
# 为什么不是 restart-once.sh：那个脚本是当前 dsh 进程的子进程，kickstart 时
# 会连同自己一起被杀掉。本脚本经 `launchctl submit` 挂在 launchd 下，与 dsh
# 平级，重启不会波及。
#
# 用法：launchctl submit -l <label> -- /bin/bash <本文件> [延迟秒]
set -u

DELAY="${1:-15}"
LABEL="com.deepseek.dsh-web.self-dsh-plugins"
UID_N="$(id -u)"
# 仓库根由脚本位置推导（本文件在 <repo>/.dsh-web/），避免写死任何人的家目录
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/.dsh-web/restart-and-verify.log"
BASE="http://127.0.0.1:3080"

{
  echo "=== $(date '+%F %T') 排定：${DELAY}s 后重启（label=$LABEL）"
  sleep "$DELAY"

  echo "--- $(date '+%F %T') 重启前 PID: $(pgrep -f 'dsh --profile web --no-open --port 3080' | tr '\n' ' ')"
  /bin/launchctl kickstart -k "gui/$UID_N/$LABEL"
  echo "--- kickstart 返回码: $?"

  # 等新宿主起来（用外部讨论插件的健康路由当就绪信号）
  for _ in $(seq 1 45); do
    sleep 2
    curl -s -m 3 "$BASE/api/dsh-external-discuss/health" >/dev/null 2>&1 && break
  done

  echo "--- $(date '+%F %T') 新 PID: $(pgrep -f 'dsh --profile web --no-open --port 3080' | tr '\n' ' ')"
  echo -n "--- external-discuss 健康: "
  curl -s -m 5 "$BASE/api/dsh-external-discuss/health" || echo "(无响应)"
  echo ""

  # ① Host 插件是否加载成功
  echo "--- ① 启动日志里的 prompt-optimizer:"
  grep -i "prompt-optimizer" "$ROOT/.dsh-web/web.out.log" 2>/dev/null | tail -3 | sed 's/^/    /'
  echo "--- ① 启动日志里的失败（应无 ERR_MODULE_NOT_FOUND）:"
  grep -i "ERR_MODULE_NOT_FOUND\|prompt-optimizer.*failed" "$ROOT/.dsh-web/web.err.log" 2>/dev/null \
    | tail -3 | sed 's/^/    /' || true

  # ② Host 路由是否注册（4xx=已注册；405/404=未注册）
  echo "--- ② 路由探测（期望 400 / 409）:"
  for path in "/dsh-prompt-optimizer/optimize" "/dsh-prompt-optimizer/test-model"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$BASE$path" \
      -H 'content-type: application/json' -d '{}')
    echo "    POST $path -> HTTP $code"
  done

  # ③ 客户端 boot 载荷里是否含本插件（需要新 token）
  TOKEN=$(grep -oE 'token=[A-Za-z0-9_-]+' "$ROOT/.dsh-web/web.out.log" 2>/dev/null | tail -1 | cut -d= -f2)
  if [ -n "$TOKEN" ]; then
    echo "--- ③ 客户端 boot 载荷检查（token=${TOKEN:0:8}…）:"
    JAR=$(mktemp)
    curl -sL -m 20 -c "$JAR" -b "$JAR" "$BASE/?token=$TOKEN" -o /tmp/po-boot.html
    n=$(grep -o "prompt-optimizer" /tmp/po-boot.html 2>/dev/null | wc -l | tr -d ' ')
    echo "    prompt-optimizer 出现 $n 处（>0 即客户端已注册）"
    grep -o "prompt-optimizer/client.js[^\"']*" /tmp/po-boot.html 2>/dev/null | head -2 | sed 's/^/    /'
    rm -f "$JAR" /tmp/po-boot.html
    echo "    新访问地址: $BASE/?token=$TOKEN"
  else
    echo "--- ③ 未取到 token，跳过客户端检查"
  fi

  echo "=== $(date '+%F %T') 完成"
} >>"$LOG" 2>&1

# 一次性 job：跑完自删
/bin/launchctl remove "${DAEMON_LABEL:-com.dsh.restart-and-verify}" 2>/dev/null || true
