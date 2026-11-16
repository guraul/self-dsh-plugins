# ops/ — 宿主运维脚本

放**本机 dsh web 的运维入口**，不进任何插件包（插件目录是 npm 风格的包，`files` 白名单只收插件代码；
运维脚本要能在插件加载失败、升级装坏时照样可用，所以放在包外）。

| 文件 | 用途 | 什么时候用 |
|---|---|---|
| `dsh-web-restart.sh` | 唯一重启入口：launchd 托管时 `kickstart -k`，job 不在时补 plist 后 `bootstrap`；`--force` 才结束非 launchd 的 dsh 进程；就绪后刷新 `.dsh-web/url.txt` | 终端里排障、脚本 / 自动化调用 |
| `重启 dsh-web.command` | 双击入口（Finder 里双击即由终端执行），无参数，内部等价 `dsh-web-restart.sh --force`；成功后自动用浏览器打开新地址 | UI 打不开、想点一下就恢复 |
| `upgrade-dsh.sh` | 升级 / 回滚 / 备份恢复：默认按**已装版本所在渠道**选目标（rc→next、alpha→alpha、正式→latest）；降级必须显式 `--allow-downgrade`（`--yes` 也不替你答应）；装完调 `dsh-web-restart.sh` 重启 | 不走 UI 升级时、要指定版本、要 `--rollback` / `--restore-backup` |
| `dsh-web-stop.sh` | 停服（`launchctl bootout` 两个 label），停到下次登录或手动 kickstart | 换端口、检修、彻底停掉 |

约定：

- **不要在 dsh 会话里真跑重启**：当前会话就跑在这个宿主上，重启会把自己断掉；排障只跑 `--check`（只读）。
- 令牌只在 `.dsh-web/url.txt` 里，脚本只打印路径，不回显内容；`重启 dsh-web.command` 只把地址交给 `open`。
- 日志：重启相关写 `.dsh-web/restart.log`，升级写 `~/.dsh-upgrade-logs/`。
