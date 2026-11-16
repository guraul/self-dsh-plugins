#!/usr/bin/env bash
#
# dsh-web-restart.sh — 本机 dsh web（LaunchAgent 托管宿主）的唯一重启入口
#
# ⚠️ 只在【终端】里运行；禁止在 dsh 会话里真跑：本脚本会 kickstart / 杀进程，
#    而当前会话就跑在这个宿主上，真跑会把正在对话的会话（你自己）一起断掉。
#    会话内只允许 --check（只打印、不操作）。
#
# 用法：
#   ./dsh-web-restart.sh --check    # 只打印现状与建议动作，不做任何操作
#   ./dsh-web-restart.sh            # 重启：job 在管 → kickstart；job 不在管 → bootstrap
#   ./dsh-web-restart.sh --force    # 端口被非 launchd 进程占着时，先 TERM → KILL 再起
#   ./dsh-web-restart.sh --help
#
# 行为要点：
#   * LABEL / PORT / ROOT 都从本脚本推导，日志追加 .dsh-web/restart.log（带时间戳）；
#   * 就绪判定：curl 打 / 拿到 200 或 401 都算活，最多等 90 秒；超时打印
#     .dsh-web/web.err.log 末尾 20 行；
#   * 就绪后刷新 .dsh-web/url.txt（chmod 600），只打印「地址已写入」，绝不回显令牌。
#
# 退出码：0 就绪 / 1 起不来 / 2 端口被野进程占用且未给 --force
#
# 兼容性：macOS 自带 bash 3.2（没有 timeout / mapfile / 关联数组），本脚本只用
#   bash 3.2 语法；变量引用一律写成 ${VAR} 形式（紧跟变量的多字节字符会被当成
#   变量名的一部分，见 upgrade-dsh.sh 同款说明）。
#
set -u

LABEL="com.deepseek.dsh-web.self-dsh-plugins"
PORT=3080
ROOT="$(cd "$(dirname "$0")" && pwd -P)"
UID_N="$(id -u)"
DOMAIN="gui/${UID_N}"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
PLIST_SRC="${ROOT}/.dsh-web/${LABEL}.plist"
# LOG / URL_TXT 在下面按 plist 声明的真机日志目录推导；OLD_PID 是重启前的占用者
LOG=""
URL_TXT=""
OLD_PID=""

LAUNCHCTL="/bin/launchctl"
PS_BIN="/bin/ps"
CHMOD_BIN="/bin/chmod"
LSOF="$(command -v lsof || true)"
CURL="$(command -v curl || true)"

CHECK_ONLY=0
FORCE=0

# ---------------------------------------------------------------- 输出工具
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_R=$'\033[31m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_B=$'\033[36m'; C_D=$'\033[2m'; C_0=$'\033[0m'
else
  C_R=''; C_G=''; C_Y=''; C_B=''; C_D=''; C_0=''
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s  ✓ %s%s\n' "${C_G}" "$*" "${C_0}"; }
warn() { printf '%s  ! %s%s\n' "${C_Y}" "$*" "${C_0}"; }
err()  { printf '%s  ✗ %s%s\n' "${C_R}" "$*" "${C_0}" >&2; }

# 默认模式才写日志；--check 全程只打印、不落任何文件
log() {
  local line dir
  line="$(date '+%F %T') $*"
  say "${line}"
  dir="$(dirname "${LOG}")"
  if [ -d "${dir}" ]; then
    printf '%s\n' "${line}" >>"${LOG}" 2>/dev/null || true
  fi
}

usage() {
  awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"
  exit 0
}

mtime_of() { # 打印文件修改时间（macOS 用 BSD stat，Linux 用 GNU stat）
  [ -e "$1" ] || { printf '(文件不存在)'; return 0; }
  case "$(uname -s)" in
    Darwin) stat -f '%Sm' -t '%F %T' "$1" 2>/dev/null ;;
    *)      stat -c '%y' "$1" 2>/dev/null | cut -d. -f1 ;;
  esac
}

mode_of() { # 打印文件权限（八进制）
  [ -e "$1" ] || { printf '(文件不存在)'; return 0; }
  case "$(uname -s)" in
    Darwin) stat -f '%Lp' "$1" 2>/dev/null ;;
    *)      stat -c '%a' "$1" 2>/dev/null ;;
  esac
}

# ---------------------------------------------------------------- launchd / 端口探测
job_exists() { "${LAUNCHCTL}" print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; }

job_field() { # job_field state|pid → 空表示读不到
  # 注意：launchctl 的行是「<TAB>state = running」，按 "= " 切分后 $1 带尾随空格，
  # 所以锚在 $0 上匹配，再剥掉第一个 "= " 之前的前缀，避免值里含 "= " 被截断。
  "${LAUNCHCTL}" print "${DOMAIN}/${LABEL}" 2>/dev/null | awk -v k="$1" '
    { pat = "^[[:space:]]*" k " = "
      if ($0 ~ pat) { sub(/^[^=]*= /, "", $0); print $0; exit } }'
}

port_pids() {
  [ -n "${LSOF}" ] || return 0
  "${LSOF}" -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true
}

pid_cwd() {
  [ -n "${LSOF}" ] || { printf '(无 lsof)'; return 0; }
  "${LSOF}" -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

pid_cmd() {
  "${PS_BIN}" -p "$1" -o command= 2>/dev/null || printf '(进程已不在)'
}

pid_ppid() {
  "${PS_BIN}" -p "$1" -o ppid= 2>/dev/null | tr -d ' ' || true
}

# 日志路径以 launchd plist 声明的为准（worktree 里脚本与真机日志不同目录），
# 读不到再退回脚本所在目录的 .dsh-web/。
plist_log_path() { # $1 = StandardOutPath | StandardErrorPath
  local src=""
  if [ -f "${PLIST_DST}" ]; then src="${PLIST_DST}"; elif [ -f "${PLIST_SRC}" ]; then src="${PLIST_SRC}"; fi
  [ -n "${src}" ] || return 0
  awk -v k="$1" '$0 ~ "<key>"k"</key>" {getline; if (match($0,/<string>[^<]*<\/string>/)) {print substr($0,RSTART+8,RLENGTH-17); exit}}' "${src}"
}

WEB_OUT="$(plist_log_path StandardOutPath)"
WEB_ERR="$(plist_log_path StandardErrorPath)"
[ -n "${WEB_OUT}" ] && [ -f "${WEB_OUT}" ] || WEB_OUT="${ROOT}/.dsh-web/web.out.log"
[ -n "${WEB_ERR}" ] && [ -f "${WEB_ERR}" ] || WEB_ERR="${ROOT}/.dsh-web/web.err.log"
# 运行态文件跟着真机日志走（worktree 里脚本目录与宿主日志目录不同）
LOG="$(dirname "${WEB_OUT}")/restart.log"
URL_TXT="$(dirname "${WEB_OUT}")/url.txt"

# ---------------------------------------------------------------- --check：只打印、不操作
do_check() {
  local pids state jpid listener ppid cmd cwd managed=""
  say "${C_B}=== dsh-web-restart.sh --check（只打印，不做任何操作）${C_0}"
  say "  LABEL       : ${LABEL}"
  say "  PORT        : ${PORT}"
  say "  脚本目录    : ${ROOT}"

  pids="$(port_pids)"
  jpid=""
  state=""

  if job_exists; then
    state="$(job_field state)"
    jpid="$(job_field pid)"
    say "  launchd job : 存在，state=${state:-未知}，声明 pid=${jpid:-无}"
  else
    say "  launchd job : 不存在（域 ${DOMAIN}/${LABEL}）"
  fi

  if [ -z "${LSOF}" ]; then
    say "  ${PORT} 监听  : 未知（PATH 里没有 lsof）"
  elif [ -z "${pids}" ]; then
    say "  ${PORT} 监听  : 否（空闲）"
  else
    say "  ${PORT} 监听  : 是"
    for listener in ${pids}; do
      ppid="$(pid_ppid "${listener}")"
      cmd="$(pid_cmd "${listener}")"
      cwd="$(pid_cwd "${listener}")"
      say "    pid=${listener}  ppid=${ppid:-?}"
      say "      启动命令: ${cmd}"
      say "      cwd     : ${cwd}"
      # 口径（任务书）：ppid=1 且 job 存在即视为 launchd 子进程；
      # 再用 launchd 声明的 pid 交叉核对，避免「野进程被过继给 launchd」误判成在管。
      if [ "${ppid}" = "1" ] && job_exists; then
        say "      launchd 子进程: 是（ppid=1 且 job 存在）"
      else
        say "      launchd 子进程: 否"
      fi
      if [ -n "${jpid}" ] && [ "${listener}" = "${jpid}" ]; then
        say "      与 launchd 声明 pid 一致: 是"
        managed=1
      else
        say "      与 launchd 声明 pid 一致: 否"
      fi
    done
  fi

  say "  web.out.log : ${WEB_OUT}"
  say "    mtime     : $(mtime_of "${WEB_OUT}")"
  say "  url.txt     : ${URL_TXT}"
  say "    mtime     : $(mtime_of "${URL_TXT}")  权限 $(mode_of "${URL_TXT}")"
  say ""

  # 结论（建议动作）
  if ! job_exists; then
    warn "结论：launchd job 不存在 → 在【终端】运行 ./dsh-web-restart.sh（会 bootstrap LaunchAgent 并等就绪）"
  elif [ -z "${pids}" ]; then
    warn "结论：job 在管但 ${PORT} 空闲（宿主没起来）→ 在【终端】运行 ./dsh-web-restart.sh"
  elif [ -n "${managed}" ]; then
    ok "结论：宿主由 launchd 在管且在监听 ${PORT}；需要重启时在【终端】运行 ./dsh-web-restart.sh"
  else
    warn "结论：${PORT} 被非 launchd 进程占着 → ./dsh-web-restart.sh --force（默认不杀，退出码 2）"
  fi
  say ""
  say "${C_D}本命令不重启、不杀进程、不写文件。${C_0}"
}

# ---------------------------------------------------------------- 野进程清理
kill_unmanaged() { # $1 = 1 表示允许杀（--force）
  local pids p i
  pids="$(port_pids)"
  [ -n "${pids}" ] || return 0

  local unmanaged=""
  for p in ${pids}; do
    [ "${p}" = "$(job_field pid)" ] || unmanaged="${unmanaged} ${p}"
  done
  [ -n "${unmanaged}" ] || return 0

  warn "端口 ${PORT} 被以下非 launchd 进程占着："
  for p in ${unmanaged}; do
    say "  pid=${p}  ppid=$(pid_ppid "${p}")"
    say "    命令: $(pid_cmd "${p}")"
    say "    cwd : $(pid_cwd "${p}")"
  done

  if [ "$1" -ne 1 ]; then
    err "默认不杀进程。确认无误后加 --force 重试：$0 --force"
    exit 2
  fi

  log "按 --force 结束以上进程"
  for p in ${unmanaged}; do kill -TERM "${p}" 2>/dev/null || true; done
  i=0
  while [ "${i}" -lt 15 ]; do
    [ -z "$(port_pids)" ] && break
    sleep 1
    i=$((i + 1))
  done
  if [ -n "$(port_pids)" ]; then
    warn "TERM 15 秒未退出，改用 KILL"
    for p in ${unmanaged}; do kill -KILL "${p}" 2>/dev/null || true; done
    sleep 1
  fi
  if [ -n "$(port_pids)" ]; then
    err "端口 ${PORT} 仍被占用，请手动处理后重试"
    exit 1
  fi
  ok "占用者已结束，端口 ${PORT} 空闲"
}

# ---------------------------------------------------------------- 重启
ensure_plist() { # job 不存在时：把 plist 装到 ~/Library/LaunchAgents/
  if [ -f "${PLIST_DST}" ]; then
    return 0
  fi
  if [ ! -f "${PLIST_SRC}" ]; then
    err "找不到 LaunchAgent plist：${PLIST_DST}（也不存在仓内副本 ${PLIST_SRC}）"
    exit 1
  fi
  mkdir -p "$(dirname "${PLIST_DST}")"
  cp "${PLIST_SRC}" "${PLIST_DST}"
  "${CHMOD_BIN}" 644 "${PLIST_DST}"
  log "已把 plist 复制到 ${PLIST_DST}"
}

start_service() {
  if job_exists; then
    log "kickstart -k ${DOMAIN}/${LABEL}"
    if ! "${LAUNCHCTL}" kickstart -k "${DOMAIN}/${LABEL}"; then
      err "launchctl kickstart 失败"
      exit 1
    fi
  else
    ensure_plist
    log "bootout（忽略失败）→ bootstrap ${DOMAIN}"
    "${LAUNCHCTL}" bootout "${DOMAIN}" "${PLIST_DST}" >/dev/null 2>&1 || true
    if ! "${LAUNCHCTL}" bootstrap "${DOMAIN}" "${PLIST_DST}"; then
      err "launchctl bootstrap 失败"
      exit 1
    fi
  fi
}

wait_ready() { # 最多 90 秒；200 / 401 都算活
  local i=0 code="" now=""
  [ -n "${CURL}" ] || { err "PATH 里没有 curl，无法探测就绪状态"; exit 1; }

  # 先等旧进程让出端口（kickstart -k 之后旧 pid 还挂着时，curl 打到的是旧进程）
  if [ -n "${OLD_PID}" ]; then
    i=0
    while [ "${i}" -lt 20 ]; do
      now="$(port_pids)"
      if [ -z "${now}" ] || [ "${now}" != "${OLD_PID}" ]; then break; fi
      sleep 1
      i=$((i + 1))
    done
  fi

  i=0
  while [ "${i}" -lt 90 ]; do
    code="$("${CURL}" -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${PORT}/" 2>/dev/null || true)"
    case "${code}" in
      200|401) return 0 ;;
    esac
    sleep 1
    i=$((i + 1))
  done
  err "90 秒内 http://127.0.0.1:${PORT}/ 未就绪（最后 http_code=${code:-无}）"
  if [ -f "${WEB_ERR}" ]; then
    say "${C_D}--- ${WEB_ERR} 末尾 20 行 ---${C_0}"
    tail -n 20 "${WEB_ERR}"
    say "${C_D}--- 结束 ---${C_0}"
  fi
  exit 1
}

refresh_url() { # 从 web.out.log 取最后一条带令牌的地址写入 url.txt；绝不回显令牌
  local url=""
  if [ -f "${WEB_OUT}" ]; then
    url="$(grep -o "http://127\.0\.0\.1:${PORT}/?token=[A-Za-z0-9._~-]*" "${WEB_OUT}" 2>/dev/null | tail -n 1)"
  fi
  if [ -z "${url}" ]; then
    warn "未在 ${WEB_OUT} 找到带令牌的地址，跳过刷新 ${URL_TXT}"
    return 0
  fi
  mkdir -p "$(dirname "${URL_TXT}")"
  printf '%s\n' "${url}" >"${URL_TXT}"
  "${CHMOD_BIN}" 600 "${URL_TXT}"
  log "地址已写入 .dsh-web/url.txt（${URL_TXT}，chmod 600，令牌不回显）"
}

do_restart() {
  log "=== 重启开始 label=${LABEL} port=${PORT} force=${FORCE} ==="
  OLD_PID="$(port_pids)" # 重启前占用端口的 pid，用来确认起来的是新进程
  kill_unmanaged "${FORCE}"
  start_service
  wait_ready
  refresh_url
  ok "dsh web 已就绪：http://127.0.0.1:${PORT}/"
  log "=== 重启完成（退出码 0）==="
}

# ---------------------------------------------------------------- 主流程
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    --force) FORCE=1; shift ;;
    --help|-h) usage ;;
    *) err "未知参数：$1（用 --help 查看用法）"; exit 1 ;;
  esac
done

if [ "${CHECK_ONLY}" -eq 1 ]; then
  do_check
  exit 0
fi

if [ ! -x "${LAUNCHCTL}" ]; then
  err "找不到 ${LAUNCHCTL}"
  exit 1
fi

do_restart
exit 0
