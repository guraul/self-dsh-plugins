#!/bin/bash
# dsh-prompt-optimizer 安装后验收（只读探针，不改任何配置）。
# 触发：重启 DSH web 之后跑一次，结果写进同目录 post-install-verify.log。
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG="$ROOT/post-install-verify.log"
BASE="http://127.0.0.1:3080"

{
  echo "=== $(date '+%F %T') 验收开始"

  # 等新宿主起来（沿用外部讨论插件的健康路由作为就绪信号）
  for _ in $(seq 1 40); do
    sleep 2
    curl -s -m 3 "$BASE/api/dsh-external-discuss/health" >/dev/null 2>&1 && break
  done

  echo "--- 宿主 PID: $(pgrep -f 'dsh --profile web --no-open --port 3080' | tr '\n' ' ')"
  echo "--- 外部讨论插件健康路由: $(curl -s -m 5 "$BASE/api/dsh-external-discuss/health" || echo '(无响应)')"

  # 插件 Host 路由是否注册：注册了但参数不合法 -> 4xx；没注册 -> 404
  echo "--- prompt-optimizer 路由探测（期望 4xx=已注册，404=未注册）:"
  for path in "/dsh-prompt-optimizer/optimize" "/dsh-prompt-optimizer/test-model"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$BASE$path" \
      -H 'content-type: application/json' -d '{}')
    echo "    POST $path -> HTTP $code"
  done

  echo "--- web.err.log 里 prompt-optimizer 相关行（空=无加载错误）:"
  grep -i "prompt-optimizer" "$ROOT/web.err.log" 2>/dev/null | tail -15 | sed 's/^/    /' || true
  grep -qi "prompt-optimizer" "$ROOT/web.err.log" 2>/dev/null || echo "    (无匹配)"

  echo "--- web.out.log 里 prompt-optimizer 相关行:"
  grep -i "prompt-optimizer" "$ROOT/web.out.log" 2>/dev/null | tail -10 | sed 's/^/    /' || true

  echo "=== $(date '+%F %T') 验收结束"
} >>"$LOG" 2>&1
