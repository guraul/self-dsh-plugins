#!/usr/bin/env bash
#
# dsh-web-restart.sh — 本机 dsh web（LaunchAgent 托管宿主）的唯一重启入口
#
# ⚠️ 只在【终端】里运行；禁止在 dsh 会话里真跑：本脚本会 kickstart / 杀进程，
#    而当前会话就跑在这个宿主上，真跑会把正在对话的会话（你自己）一起断掉。
#    会话内只允许 --check（只打印、不操作）。
#
# 用法：
#   ops/dsh-web-restart.sh --check    # 只打印现状与建议动作（含「其它 dsh 宿主」），不做任何操作
#   ops/dsh-web-restart.sh            # 重启：job 在管 → kickstart；job 不在管 → bootstrap
#   ops/dsh-web-restart.sh --force    # 结束所有非 launchd 的 dsh 进程（占 3080 的 + 其它端口的）再重启
#   ops/dsh-web-restart.sh --help
#
# 行为要点：
#   * LABEL / PORT / ROOT 都从本脚本推导，日志追加 .dsh-web/restart.log（带时间戳）；
#   * 野宿主：argv[0] 是 `*/dsh`（或 argv[0] 是 node 且 argv[1] 是 `*/dsh`）、带 `--port`、
#     且不是 launchd 声明的那个 pid 的 LISTEN 进程——**不做「命令行含 dsh 字样」的子串匹配**，
#     否则提示词里提到 dsh 的无关进程会被误判（2026-11-16 实测），--force 下就被误杀。
#     --check 单列一节（没有就写「无」）。默认模式**不给 --force 就不杀**它们：重启照常进行，
#     就绪后打印告警，退出码仍是 0；给了 --force 才按「先清 3080 占用者 → 再清其它野宿主 →
#     再启动」的顺序一并结束。只有「3080 被野进程占着且没给 --force」才退 2；
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
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
# ROOT 是仓库根：脚本在 ops/ 下，.dsh-web/ 与源码都在上一层
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
UID_N="$(id -u)"
DOMAIN="gui/${UID_N}"
PLIST_DST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
PLIST_SRC="${ROOT}/.dsh-web/${LABEL}.plist"
# LOG / URL_TXT 在下面按 plist 声明的真机日志目录推导；OLD_PID 是重启前的占用者
LOG=""
URL_TXT=""
OLD_PID=""
# 重启开始时的 web.out.log 行数：刷新 url.txt 只认这之后追加的行
WEB_OUT_BASE=0
# 野宿主扫描结果（stray_hosts 填）：个数 / pid 列表 / 展示文本
STRAY_N=0
STRAY_PIDS=""
STRAY_OUT=""

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

# ---------------------------------------------------------------- 野宿主探测
# 三条口径（挑的是「命令里含 dsh 且含 --port 的 LISTEN 进程」）：
#   ① 启动命令含 `dsh` 且含 `--port`；
#   ② pid ≠ launchd 声明的 pid；
#   ③ ppid ≠ 1。
# ② ③ 是「怎么判定不在 launchd 管辖下」，两者按情况二选一：launchd 声明得出 pid 就直接比 pid
# （能抓到被过继给 launchd 的孤儿野宿主——nohup 出来的宿主 ppid 也是 1，只看 ppid 会漏）；
# 只有「job 在跑却读不到声明 pid」这种解析异常时才退回 ③ 的保守口径，宁可漏报也不误杀宿主。
# 只读，不杀任何进程。
consider_stray() { # $1=pid  $2=lsof 的短命令名（仅兜底）  $3=端口列表  $4=launchd 声明的 pid
  local p="$1" name="$2" ports="$3" jp="$4" c ppid cwd a0 a1
  # 判定用 ps 的完整命令行：lsof 的 c 字段只是短进程名（如 node），里面没有 --port
  c="$(pid_cmd "${p}")"
  [ -n "${c}" ] || c="${name}"
  # 只认「dsh 作为入口被调用」：argv[0] 是 */dsh，或 argv[0] 是 node/nodejs 且 argv[1] 是 */dsh。
  # 不能用「命令行含 dsh 且含 --port」的子串判定——2026-11-16 实测会把只是命令行里提到这两个词的
  # 无关进程（如提示词里带这些字样的审核会话）误判成野宿主，--force 下就被误杀。
  set -- ${c}
  a0="${1:-}"
  a1="${2:-}"
  case "${a0##*/}" in
    node|nodejs)
      case "${a1##*/}" in dsh) ;; *) return 0 ;; esac ;;
    dsh) ;;
    *) return 0 ;;
  esac
  case "${c}" in *--port*) ;; *) return 0 ;; esac
  if [ -n "${jp}" ]; then
    if [ "${p}" = "${jp}" ]; then return 0; fi
  elif job_exists; then
    ppid="$(pid_ppid "${p}")"
    if [ "${ppid}" = "1" ]; then return 0; fi
  fi
  cwd="$(pid_cwd "${p}")"
  STRAY_N=$((STRAY_N + 1))
  STRAY_PIDS="${STRAY_PIDS} ${p}"
  STRAY_OUT="${STRAY_OUT}    pid=${p}  端口:${ports# }
      命令: ${c}
      cwd : ${cwd}
"
}

stray_hosts() { # 扫一遍所有 LISTEN 的 TCP 进程，结果进 STRAY_N / STRAY_PIDS / STRAY_OUT
  STRAY_N=0
  STRAY_PIDS=""
  STRAY_OUT=""
  [ -n "${LSOF}" ] || return 0

  local listing jpid line pid cmd ports port
  listing="$("${LSOF}" -nP -iTCP -sTCP:LISTEN -Fpcfn 2>/dev/null || true)"
  [ -n "${listing}" ] || return 0
  jpid="$(job_field pid)"

  pid=""; cmd=""; ports=""
  while IFS= read -r line; do
    case "${line}" in
      p[0-9]*)
        if [ -n "${pid}" ]; then consider_stray "${pid}" "${cmd}" "${ports}" "${jpid}"; fi
        pid="${line#p}"; cmd=""; ports="" ;;
      c*) cmd="${line#c}" ;;
      n*)
        # lsof -P：IPv4 写成 127.0.0.1:3080，IPv6 写成 *.8080，端口一律取最后一段
        port="$(printf '%s\n' "${line#n}" | sed -E 's/.*[:.]([0-9]+)$/\1/')"
        case " ${ports} " in
          *" ${port} "*) ;;
          *) ports="${ports} ${port}" ;;
        esac ;;
    esac
  done <<< "${listing}"
  if [ -n "${pid}" ]; then consider_stray "${pid}" "${cmd}" "${ports}" "${jpid}"; fi
  return 0
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
  say "  脚本目录    : ${SCRIPT_DIR}"

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
  say "  其它 dsh 宿主:"
  stray_hosts
  if [ "${STRAY_N}" -eq 0 ]; then
    say "    无"
  else
    printf '%s' "${STRAY_OUT}"
  fi
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
  if [ "${STRAY_N}" -gt 0 ]; then
    warn "⚠ 另有 ${STRAY_N} 个非 launchd 的 dsh 宿主在跑（可能抢企微连接）；重启时加 --force 可一并结束"
  fi
  say ""
  say "${C_D}本命令不重启、不杀进程、不写文件。${C_0}"
}

# ---------------------------------------------------------------- 野进程清理
kill_unmanaged() { # $1 = 1 表示允许杀（--force）
  local pids p i
  pids="$(port_pids)"
  [ -n "${pids}" ] || return 0

  local jp unmanaged=""
  jp="$(job_field pid)"
  for p in ${pids}; do
    if [ -n "${jp}" ]; then
      [ "${p}" = "${jp}" ] || unmanaged="${unmanaged} ${p}"
    elif [ "$(job_field state)" = "running" ] && [ "$(pid_ppid "${p}")" = "1" ]; then
      # 解析不出声明 pid、但 job 确实在跑且该进程 ppid=1：按在 launchd 名下处理，宁可漏杀
      :
    else
      unmanaged="${unmanaged} ${p}"
    fi
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

strays_alive() { # $1 = 空格分隔的 pid；打印其中还活着的
  local p out=""
  for p in $1; do
    if kill -0 "${p}" 2>/dev/null; then out="${out} ${p}"; fi
  done
  printf '%s' "${out}"
}

kill_strays() { # 结束「其它端口上的野宿主」，只在 --force 时调用；3080 的归 kill_unmanaged
  local targets="$1" p i rest
  [ -n "${targets}" ] || return 0

  log "按 --force 结束 ${STRAY_N} 个非 launchd 的 dsh 宿主："
  for p in ${targets}; do
    say "  pid=${p}"
    say "    命令: $(pid_cmd "${p}")"
    say "    cwd : $(pid_cwd "${p}")"
  done
  for p in ${targets}; do kill -TERM "${p}" 2>/dev/null || true; done
  i=0
  rest="$(strays_alive "${targets}")"
  while [ -n "${rest}" ] && [ "${i}" -lt 15 ]; do
    sleep 1
    i=$((i + 1))
    rest="$(strays_alive "${targets}")"
  done
  if [ -n "${rest}" ]; then
    warn "TERM 15 秒未退出，改用 KILL：${rest}"
    for p in ${rest}; do kill -KILL "${p}" 2>/dev/null || true; done
    sleep 1
    rest="$(strays_alive "${targets}")"
  fi
  if [ -n "${rest}" ]; then
    warn "仍有进程没退出，请手动处理：${rest}"
  else
    ok "野宿主已全部结束"
  fi
  return 0
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

refresh_url() { # 只认本次重启之后追加的日志行；绝不回显令牌
  local url="" code="" from total
  if [ ! -f "${WEB_OUT}" ]; then
    warn "找不到 ${WEB_OUT}，跳过刷新 ${URL_TXT}"
    return 0
  fi
  from="$((WEB_OUT_BASE + 1))"
  total="$(wc -l <"${WEB_OUT}" | tr -d ' ')"
  # 日志轮转过（当前行数比基线少）时退回全文，避免 tail 取空
  if [ "${total}" -lt "${from}" ]; then from=1; fi
  url="$(tail -n "+${from}" "${WEB_OUT}" 2>/dev/null \
    | grep -o "http://127\.0\.0\.1:${PORT}/?token=[A-Za-z0-9._~%+=/-]*" | tail -n 1)"
  if [ -z "${url}" ]; then
    warn "本次重启后 ${WEB_OUT} 没有新的带令牌地址，保留原 ${URL_TXT}"
    return 0
  fi
  # 候选地址必须真能认证（200/301/302/303），否则不覆盖现有 url.txt —— 免得把过期令牌写进去
  code="$("${CURL}" -s -o /dev/null -w '%{http_code}' --max-time 5 "${url}" 2>/dev/null || true)"
  case "${code}" in
    200|301|302|303) ;;
    *)
      warn "候选地址校验失败（http_code=${code:-无}），未覆盖 ${URL_TXT}"
      return 0
      ;;
  esac
  mkdir -p "$(dirname "${URL_TXT}")"
  printf '%s\n' "${url}" >"${URL_TXT}"
  "${CHMOD_BIN}" 600 "${URL_TXT}"
  log "地址已写入 .dsh-web/url.txt（${URL_TXT}，chmod 600，令牌不回显）"
}

do_restart() {
  log "=== 重启开始 label=${LABEL} port=${PORT} force=${FORCE} ==="
  OLD_PID="$(port_pids)"        # 重启前占用端口的 pid，用来确认起来的是新进程
  if [ -f "${WEB_OUT}" ]; then  # 日志基线：只从这之后追加的行里取新令牌地址
    WEB_OUT_BASE="$(wc -l <"${WEB_OUT}" | tr -d ' ')"
  fi
  kill_unmanaged "${FORCE}"     # ① 3080 的占用者（野进程 + 没给 --force → 这里就退 2）
  stray_hosts                   # ② 扫其它端口上的野宿主（只读）
  if [ "${FORCE}" -eq 1 ] && [ "${STRAY_N}" -gt 0 ]; then
    kill_strays "${STRAY_PIDS}" # ③ --force 才把它们一并结束
  fi
  start_service                 # ④ 启动（kickstart / bootstrap）
  wait_ready
  refresh_url
  ok "dsh web 已就绪：http://127.0.0.1:${PORT}/"
  # 没给 --force：不杀野宿主，重启本身照常算成功，只告警，退出码仍是 0
  if [ "${FORCE}" -eq 0 ] && [ "${STRAY_N}" -gt 0 ]; then
    warn "另有 ${STRAY_N} 个野宿主在跑，会抢企微；确认后可加 --force 一并结束"
  fi
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
