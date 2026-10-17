#!/usr/bin/env bash
#
# upgrade-dsh.sh — DeepSeek Harness (dsh) npm 全局安装版：一键升级 / 回滚 / 恢复数据
#
# 用法：
#   ./upgrade-dsh.sh                       # 交互式升级到 npm latest
#   ./upgrade-dsh.sh --check               # 只检查（不改动任何东西）
#   ./upgrade-dsh.sh --version 0.2.0-rc.2  # 升级到指定版本
#   ./upgrade-dsh.sh --yes --no-restart    # 无人值守，不自动重启
#   ./upgrade-dsh.sh --rollback 0.1.5-rc.3 # 回滚到旧版
#   ./upgrade-dsh.sh --restore-backup      # 用最近一次备份覆盖 ~/.dsh
#   ./upgrade-dsh.sh --help
#
# 设计要点：
#   * 用「当前 dsh 所在的那个 Node」的 npm 来安装，避免 nvm 多版本装错目录；
#   * 升级前备份 ~/.dsh，升级后校验版本号并做 profile 组合冒烟测试；
#   * 停服务前会打印将要杀掉的进程并要求确认；
#   * 全程日志落在 ~/.dsh-upgrade-logs/ 。
#
# 兼容性：macOS 自带的 bash 3.2 在 UTF-8 locale 下会把紧跟变量的多字节字符
# （如全角「（」「，」）当成变量名的一部分，因此本脚本内所有变量引用一律写成
# ${VAR} 形式，不要改回 $VAR，否则会报 "unbound variable"。
#
set -euo pipefail

PKG="@deepseek-ai/dsh"
PORT="${DSH_PORT:-3080}"
WORKDIR="${DSH_WORKDIR:-}"
TARGET=""
ROLLBACK=""
RESTORE_BACKUP=0
LIST_VERSIONS=0
ASSUME_YES=0
DO_BACKUP=1
DO_RESTART=1
CHECK_ONLY=0
ALLOW_SCRIPTS="fs-ext,koffi,node-pty,protobufjs,@google/genai,@deepseek-ai/dsh-subprocess-local"

TS="$(date +%Y%m%d-%H%M%S)"
LOG_DIR="${HOME}/.dsh-upgrade-logs"
LOG="${LOG_DIR}/upgrade-${TS}.log"
BACKUP=""

# ---------------------------------------------------------------- 输出工具
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_R=$'\033[31m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_B=$'\033[36m'; C_D=$'\033[2m'; C_0=$'\033[0m'
else
  C_R=''; C_G=''; C_Y=''; C_B=''; C_D=''; C_0=''
fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "${C_B}" "$*" "${C_0}"; }
ok()   { printf '%s  ✓ %s%s\n' "${C_G}" "$*" "${C_0}"; }
warn() { printf '%s  ! %s%s\n' "${C_Y}" "$*" "${C_0}"; }
err()  { printf '%s  ✗ %s%s\n' "${C_R}" "$*" "${C_0}" >&2; }
die()  { err "$*"; exit 1; }

confirm() { # confirm "问题" -> 0=yes
  [ "${ASSUME_YES}" -eq 1 ] && return 0
  local ans
  printf '%s  ? %s [y/N] %s' "${C_Y}" "$1" "${C_0}"
  read -r ans || true
  case "${ans}" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

usage() {
  awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"
  exit 0
}

# ---------------------------------------------------------------- 参数解析
while [ $# -gt 0 ]; do
  case "$1" in
    --version)   [ $# -ge 2 ] || die "--version 需要版本号"; TARGET="$2"; shift 2 ;;
    --rollback)  [ $# -ge 2 ] || die "--rollback 需要版本号"; ROLLBACK="$2"; shift 2 ;;
    --restore-backup) RESTORE_BACKUP=1; shift ;;
    --list)      LIST_VERSIONS=1; shift ;;
    --check|--dry-run) CHECK_ONLY=1; shift ;;
    --port)      [ $# -ge 2 ] || die "--port 需要端口号"; PORT="$2"; shift 2 ;;
    --workdir)   [ $# -ge 2 ] || die "--workdir 需要目录"; WORKDIR="$2"; shift 2 ;;
    --no-backup) DO_BACKUP=0; shift ;;
    --no-restart) DO_RESTART=0; shift ;;
    --yes|-y)    ASSUME_YES=1; shift ;;
    --help|-h)   usage ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

mkdir -p "${LOG_DIR}"
# 输出同时写日志；stdin 保持给交互确认用
exec > >(tee -a "${LOG}") 2>&1

say "${C_D}日志：${LOG}${C_0}"

# ---------------------------------------------------------------- 环境探测
DSH_BIN=""; DSH_BIN_DIR=""; DSH_REAL=""; NODE_BIN=""; NPM_BIN=""; NPM_ROOT_G=""

resolve_link() { # 逐级解开符号链接
  local f="$1" t
  while [ -L "${f}" ]; do
    t="$(readlink "${f}")"
    case "${t}" in /*) f="${t}" ;; *) f="$(dirname "${f}")/${t}" ;; esac
  done
  printf '%s\n' "${f}"
}

preflight() {
  step "环境检查"
  case "$(uname -s)" in
    Darwin|Linux) ;;
    *) die "本脚本目前只支持 macOS / Linux（当前：$(uname -s)）" ;;
  esac

  DSH_BIN="$(command -v dsh || true)"
  [ -n "${DSH_BIN}" ] || die "PATH 里找不到 dsh。请先安装：npm install -g ${PKG}"

  DSH_BIN_DIR="$(cd "$(dirname "${DSH_BIN}")" && pwd)"
  DSH_REAL="$(resolve_link "${DSH_BIN}")"
  DSH_REAL="$(cd "$(dirname "${DSH_REAL}")" && pwd -P)/$(basename "${DSH_REAL}")"
  NODE_BIN="${DSH_BIN_DIR}/node"
  NPM_BIN="${DSH_BIN_DIR}/npm"
  if [ ! -x "${NPM_BIN}" ]; then
    warn "${DSH_BIN_DIR} 下没有 npm，回退到 PATH 里的 npm（可能属于另一个 Node 版本）"
    NPM_BIN="$(command -v npm || true)"
    NODE_BIN="$(command -v node || true)"
  fi
  [ -n "${NPM_BIN}" ] || die "找不到 npm"
  [ -n "${NODE_BIN}" ] || die "找不到 node"

  NPM_ROOT_G="$("${NPM_BIN}" root -g 2>/dev/null || true)"
  [ -n "${NPM_ROOT_G}" ] || die "无法获取 npm 全局目录（npm root -g）"

  say "  dsh         : ${DSH_BIN}"
  say "  dsh 实现    : ${DSH_REAL}"
  say "  node        : ${NODE_BIN}（$("${NODE_BIN}" -v)）"
  say "  npm         : ${NPM_BIN}（v$("${NPM_BIN}" -v)）"
  say "  npm 全局目录: ${NPM_ROOT_G}"
  say "  数据目录    : ${DSH_HOME:-${HOME}/.dsh}"

  case "${DSH_REAL}" in
    "${NPM_ROOT_G}"/*) ok "dsh 属于当前 npm 的全局目录，安装位置正确" ;;
    *) warn "dsh 不在 ${NPM_ROOT_G} 下；本脚本仍会用 ${NPM_BIN} 安装，请确认这是你想要的位置" ;;
  esac
}

# ---------------------------------------------------------------- 版本查询
DIST_LATEST=""; DIST_NEXT=""; DIST_ALPHA=""

detect_versions() {
  step "版本信息"
  local tags_json
  tags_json="$("${NPM_BIN}" view "${PKG}" dist-tags --json 2>/dev/null || echo '{}')"
  DIST_LATEST="$("${NODE_BIN}" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write((JSON.parse(s).latest)||"")}catch(e){}})' <<<"${tags_json}")"
  DIST_NEXT="$("${NODE_BIN}" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write((JSON.parse(s).next)||"")}catch(e){}})' <<<"${tags_json}")"
  DIST_ALPHA="$("${NODE_BIN}" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write((JSON.parse(s).alpha)||"")}catch(e){}})' <<<"${tags_json}")"

  CURRENT="$("${DSH_BIN}" --version 2>/dev/null | tr -d '\r' | tail -n 1)"
  say "  已安装      : ${CURRENT:-未知}"
  say "  npm latest  : ${DIST_LATEST:-?}"
  [ -n "${DIST_NEXT}" ]  && say "  npm next    : ${DIST_NEXT}"
  [ -n "${DIST_ALPHA}" ] && say "  npm alpha   : ${DIST_ALPHA}"
  say "  安装方式    : npm 全局（${PKG}）"
}

list_versions() {
  step "最近发布的版本（npm registry）"
  "${NPM_BIN}" view "${PKG}" versions --json 2>/dev/null \
    | "${NODE_BIN}" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);process.stdout.write(v.slice(-12).join("\n")+"\n")}catch(e){process.stdout.write("(查询失败)\n")}})'
}

# ---------------------------------------------------------------- 端口 / 进程
PORT_PIDS=""

find_port_pids() {
  PORT_PIDS=""
  if command -v lsof >/dev/null 2>&1; then
    PORT_PIDS="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  elif command -v ss >/dev/null 2>&1; then
    PORT_PIDS="$(ss -H -tlnp "sport = :${PORT}" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)"
  fi
}

stop_server() {
  step "停止占用 ${PORT} 端口的 dsh 服务"
  find_port_pids
  if [ -z "${PORT_PIDS}" ]; then
    ok "端口 ${PORT} 空闲，无需停止"
    return 0
  fi
  local pid
  for pid in ${PORT_PIDS}; do
    say "  监听 ${PORT} 的进程："
    ps -p "${pid}" -o pid=,command= 2>/dev/null | sed 's/^/    /' || say "    (pid ${pid})"
  done
  confirm "结束以上进程？（会断开当前 Web 会话，会话数据已落盘，重启后可继续）" || die "已取消，未做任何改动"

  for pid in ${PORT_PIDS}; do kill -TERM "${pid}" 2>/dev/null || true; done
  local i=0
  while [ ${i} -lt 15 ]; do
    find_port_pids
    [ -z "${PORT_PIDS}" ] && break
    sleep 1; i=$((i+1))
  done
  find_port_pids
  if [ -n "${PORT_PIDS}" ]; then
    warn "TERM 15 秒未退出，改用 KILL"
    for pid in ${PORT_PIDS}; do kill -9 "${pid}" 2>/dev/null || true; done
    sleep 1
  fi
  find_port_pids
  [ -z "${PORT_PIDS}" ] && ok "服务已停止" || die "端口 ${PORT} 仍被占用，请手动处理后重试"
}

start_server() {
  [ "${DO_RESTART}" -eq 1 ] || { warn "按参数要求不自动重启，请手动执行： cd ${WORKDIR:-${PWD}} && dsh web"; return 0; }
  step "重启 dsh web"
  local dir="${WORKDIR}"
  if [ -z "${dir}" ]; then
    if [ -d "${HOME}/workspace" ]; then dir="${HOME}/workspace"; else dir="${PWD}"; fi
  fi
  [ -d "${dir}" ] || die "工作目录不存在：${dir}"
  local web_log="${LOG_DIR}/dsh-web-${TS}.log"
  ( cd "${dir}" && nohup "${DSH_BIN}" web --no-open --port "${PORT}" >>"${web_log}" 2>&1 & echo $! >"${LOG_DIR}/dsh-web.pid" )
  say "  工作目录：${dir}"
  say "  服务日志：${web_log}"

  local i=0 up=0
  while [ ${i} -lt 60 ]; do
    if command -v curl >/dev/null 2>&1 && curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/" 2>/dev/null; then up=1; break; fi
    find_port_pids
    [ -n "${PORT_PIDS}" ] && { up=1; break; }
    sleep 1; i=$((i+1))
  done
  if [ "${up}" -eq 1 ]; then
    ok "服务已起来：http://127.0.0.1:${PORT}/"
  else
    warn "60 秒内没探测到服务；请看日志：${web_log}"
  fi
}

# ---------------------------------------------------------------- 备份
do_backup() {
  [ "${DO_BACKUP}" -eq 1 ] || { warn "按参数要求跳过 ~/.dsh 备份"; return 0; }
  step "备份数据目录"
  local home_dir="${DSH_HOME:-${HOME}/.dsh}"
  if [ ! -d "${home_dir}" ]; then
    warn "${home_dir} 不存在，跳过备份"; return 0
  fi
  BACKUP="${home_dir}.bak-${TS}"
  [ -e "${BACKUP}" ] && die "备份目标已存在：${BACKUP}"
  cp -a "${home_dir}" "${BACKUP}"
  {
    echo "backup at : ${TS}"
    echo "dsh before: ${CURRENT:-unknown}"
    echo "dsh bin   : ${DSH_BIN}"
    echo "npm       : ${NPM_BIN}"
    echo "target    : ${TARGET:-${ROLLBACK}}"
  } >"${BACKUP}/UPGRADE-INFO.txt" 2>/dev/null || true
  ok "已备份到 ${BACKUP}"
  say "  ${C_D}确认升级正常后可删除：rm -rf \"${BACKUP}\"${C_0}"
}

# ---------------------------------------------------------------- 安装
install_version() { # install_version <版本>
  local ver="$1"
  step "安装 ${PKG}@${ver}"
  say "  ${NPM_BIN} install -g --allow-scripts=... ${PKG}@${ver}"
  if "${NPM_BIN}" install -g --allow-scripts="${ALLOW_SCRIPTS}" "${PKG}@${ver}"; then
    return 0
  fi
  warn "带 --allow-scripts 的安装失败，尝试不带该参数重试（旧版 npm 可能不认识它）"
  "${NPM_BIN}" install -g "${PKG}@${ver}"
}

verify_install() { # verify_install <期望版本>
  local want="$1" got
  step "校验安装结果"
  got="$("${DSH_BIN}" --version 2>/dev/null | tr -d '\r' | tail -n 1)"
  say "  dsh --version → ${got:-空}"
  if [ "${got}" != "${want}" ]; then
    err "版本不符（期望 ${want}，实际 ${got:-空}）"
    say "  可重装：${NPM_BIN} install -g --force --allow-scripts=${ALLOW_SCRIPTS} ${PKG}@${want}"
    say "  可回滚：$0 --rollback ${CURRENT:-<旧版本>}"
    return 1
  fi
  ok "版本号正确"

  # 0.1.x 的 --dump-default-config 是 launcher 级开关，0.2.x 起必须显式给 --profile。
  # 两种写法都试，任何一代能打印出 profile 树即算通过。
  local smoke_out="" smoke_ok=0
  if smoke_out="$("${DSH_BIN}" --profile web --dump-default-config 2>&1)"; then
    smoke_ok=1
  elif smoke_out="$("${DSH_BIN}" --dump-default-config 2>&1)"; then
    smoke_ok=1
  fi
  if [ "${smoke_ok}" -eq 1 ]; then
    ok "profile 组合冒烟测试通过"
  else
    warn "profile 组合测试失败（dsh --profile web --dump-default-config 非零退出），输出："
    printf '%s\n' "${smoke_out}" | tail -n 20 | sed 's/^/    /' || true
    return 1
  fi
}

# ---------------------------------------------------------------- 恢复备份
do_restore_backup() {
  step "恢复 ~/.dsh 备份"
  local home_dir="${DSH_HOME:-${HOME}/.dsh}"
  local src
  src="$(ls -1d "${home_dir}".bak-* 2>/dev/null | sort | tail -n 1 || true)"
  [ -n "${src}" ] || die "找不到任何备份（${home_dir}.bak-*）"
  say "  将用备份覆盖当前数据目录："
  say "    备份：${src}"
  say "    当前：${home_dir}"
  confirm "确认恢复？（当前目录会先改名为 ${home_dir}.before-restore-${TS}）" || die "已取消"
  if [ -d "${home_dir}" ]; then
    mv "${home_dir}" "${home_dir}.before-restore-${TS}"
    ok "当前数据已移到 ${home_dir}.before-restore-${TS}"
  fi
  cp -a "${src}" "${home_dir}"
  ok "已从备份恢复：${src}"
}

# ---------------------------------------------------------------- 主流程
preflight
detect_versions
if [ "${LIST_VERSIONS}" -eq 1 ]; then list_versions; fi

if [ "${RESTORE_BACKUP}" -eq 1 ]; then
  do_restore_backup
  say ""
  say "完成。如需重启：cd ${WORKDIR:-${HOME}/workspace} && dsh web"
  exit 0
fi

if [ -n "${ROLLBACK}" ]; then
  TARGET="${ROLLBACK}"
  say ""
  warn "回滚模式：目标 ${TARGET}（当前 ${CURRENT:-未知}）"
fi

[ -n "${TARGET}" ] || TARGET="${DIST_LATEST}"
[ -n "${TARGET}" ] || die "无法确定目标版本（npm 查询失败）；可用 --version 手动指定"

if [ "${TARGET}" = "${CURRENT:-}" ]; then
  ok "已经是 ${TARGET}，无需升级"
  [ "${CHECK_ONLY}" -eq 1 ] && exit 0
  confirm "仍要强制重装 ${TARGET} 吗？" || exit 0
fi

if [ "${CHECK_ONLY}" -eq 1 ]; then
  step "检查模式（不做任何改动）"
  say "  计划：${PKG}  ${CURRENT:-未知} → ${TARGET}"
  say "  备份：$([ "${DO_BACKUP}" -eq 1 ] && echo "是（${DSH_HOME:-${HOME}/.dsh}.bak-${TS}）" || echo "否")"
  say "  停服务：端口 ${PORT}（如被占用）"
  say "  重启：$([ "${DO_RESTART}" -eq 1 ] && echo "是" || echo "否")"
  say "  安装命令：${NPM_BIN} install -g --allow-scripts=${ALLOW_SCRIPTS} ${PKG}@${TARGET}"
  say ""
  say "去掉 --check 即可真正执行。"
  exit 0
fi

step "升级计划"
say "  ${PKG}  ${CURRENT:-未知} → ${TARGET}"
case "${TARGET}" in
  *-*) warn "目标是预发布版本（含 -rc/-alpha 后缀），确认这是你要的渠道" ;;
esac
confirm "开始升级？" || die "已取消，未做任何改动"

do_backup
stop_server
if ! install_version "${TARGET}"; then
  err "安装失败"
  if [ -n "${BACKUP}" ]; then
    say "  数据备份仍在：${BACKUP}"
    say "  可回滚：${NPM_BIN} install -g ${PKG}@${CURRENT:-<旧版本>}"
  fi
  exit 1
fi
if ! verify_install "${TARGET}"; then
  warn "安装已完成但冒烟测试未通过；服务不会自动重启，避免带病运行"
  say "  手动启动：cd ${WORKDIR:-${HOME}/workspace} && dsh web"
  say "  修复建议见上方输出；数据备份：${BACKUP:-无}"
  exit 1
fi
start_server

step "完成"
say "  版本：${CURRENT:-未知} → ${TARGET}"
say "  备份：${BACKUP:-未做}"
say "  日志：${LOG}"
say "  回滚：$0 --rollback ${CURRENT:-<旧版本>}"
say "  ${C_D}提示：本机若用 nvm，请确认新开的终端里 node -v 仍是 $("${NODE_BIN}" -v)${C_0}"
