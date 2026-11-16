#!/bin/bash
#
# 重启 dsh-web.command — 双击用的重启入口（无参数）
#
# 为什么是 .command：macOS 里双击 .sh 只会用编辑器打开，双击 .command 才会交给终端执行。
#
# 行为：等价于执行同目录的 ./dsh-web-restart.sh --force
#   * job 在管 → launchctl kickstart -k
#   * job 不在管 → 补 plist 后 bootstrap
#   * 端口被非 launchd 进程占着 / 还有别的野宿主 → 先结束它们（野进程判定只认 dsh 入口）
#   * 起来后等就绪、刷新 .dsh-web/url.txt，并自动用浏览器打开新地址
# 令牌只交给 open，不打印。
#
set -u

DIR="$(cd "$(dirname "$0")" && pwd -P)"
MAIN="${DIR}/dsh-web-restart.sh"
# .dsh-web/ 始终在主工作区：脚本在 ops/ 下，仓库根是上一层；
# 在 worktree 里双击时，再按 git-common-dir 回推主仓根
ROOT="$(cd "${DIR}/.." && pwd -P)"
COMMON="$(git -C "${DIR}" rev-parse --git-common-dir 2>/dev/null || true)"
case "${COMMON}" in
  */.git) ROOT="$(cd "$(dirname "${COMMON}")" && pwd -P)" ;;
esac

cd "${DIR}" || { echo "进不去目录：${DIR}"; printf '按回车关闭…'; read -r _; exit 1; }

if [ ! -x "${MAIN}" ]; then
  echo "找不到可执行的重启脚本：${MAIN}"
  printf '按回车关闭…'
  read -r _
  exit 1
fi

echo "=== dsh web 重启（双击入口，等价 ./dsh-web-restart.sh --force）"
for i in 3 2 1; do
  printf '\r%d 秒后开始（Ctrl+C 可取消）… ' "${i}"
  sleep 1
done
printf '\r\033[K'

"${MAIN}" --force
RC=$?

echo
if [ "${RC}" -eq 0 ]; then
  URL="$(/bin/cat "${ROOT}/.dsh-web/url.txt" 2>/dev/null || true)"
  if [ -n "${URL}" ]; then
    if /usr/bin/open "${URL}"; then
      echo "== 已在浏览器里打开新地址（令牌不回显）"
    else
      echo "== 打开浏览器失败，手动打开：${ROOT}/.dsh-web/url.txt"
    fi
  else
    echo "== 重启成功，但没取到新地址：看 ${ROOT}/.dsh-web/web.out.log 最后一行"
  fi
else
  echo "== 重启未完全成功（退出码 ${RC}）"
  echo "   日志：${ROOT}/.dsh-web/restart.log"
  echo "   排障：在终端运行 ./dsh-web-restart.sh --check"
fi

echo
printf '按回车关闭窗口…'
read -r _ || true
