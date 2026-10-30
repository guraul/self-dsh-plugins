# dsh-plugin-awake

给 DeepSeek Harness Web 的发送栏加一个**咖啡杯按钮**：点一下，由**宿主进程**拉起一个
`caffeinate -i`，macOS 就不会因为「空闲」而睡眠；再点一下（或点底部状态条上的「关闭」）就停。

**纯开关，没有档位、没有时长、不会自己到期。** 开就是开到你关为止。

> 只在 **macOS** 上有意义。`caffeinate` 是 macOS 自带命令，其它平台上 `POST /start`
> 直接返回 `501 E_UNSUPPORTED_PLATFORM`。

## 为什么需要它

macOS 判「空闲」只看 HID 输入（键盘 / 鼠标 / 触控板），**不看有没有进程在跑，也不看网络流量**。
所以 DSH 的 agent 在后台跑一晚，系统照样会在 N 分钟没碰键鼠后进入空闲睡眠，把这些活儿全掐掉。

`caffeinate -i` 做的事就是按住一个 **`PreventUserIdleSystemSleep` 断言**：只要这个进程活着，
空闲睡眠就不会发生。它不改任何全局 `pmset` 配置、不需要 sudo，关掉就恢复原状——
这正是「按需」的形态。

## 怎么用

1. 打开 dsh Web，在发送栏右侧找到**咖啡杯图标**（与提示词优化按钮同一排）。
2. 点一下：图标变成 accent 色 + 实心，屏幕底部出现一条通栏 `☕ 保持唤醒中 [关闭]`。
3. 再点按钮，或点状态条上的**关闭**：断言消失。

状态存在**宿主进程**里，不在浏览器里：

- **刷新页面 / 切换会话**：按钮和状态条仍然是 active（每次挂载重新读一次 `GET /status`）；
- **不轮询、不订阅 SSE**，所以页面不会因为它在后台一直发请求；
- **多个标签页不同步**（v1 明确接受）：一个页面关了，另一个页面要刷新才能看到。

## 它挡不住什么

| 场景 | `caffeinate -i` 能挡吗 |
|---|---|
| 空闲睡眠（没键鼠输入 → `Idle Sleep`） | ✅ 能 |
| 显示器休眠 / 屏保 | ❌ 不能（那是 `-d`，本插件故意不加） |
| **合盖休眠** | ❌ **不能**。合盖是硬件层事件，只有 `pmset disablesleep 1`（要 sudo、且是全局配置）能压住 |

**本插件不阻止合盖休眠。** 需要「合盖也继续跑」请自己评估 `pmset disablesleep`，那不是本插件的目标。

## 接口

所有端点都挂在本插件的**独立前缀**（不是 dsh 的 `/api`），并且**只服务本机**：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/plugins/awake/status` | `{ ok, active, pid, startedAt }` |
| `POST` | `/plugins/awake/start` | 拉起 `caffeinate -i`（幂等，已开启时不会起第二个） |
| `POST` | `/plugins/awake/stop` | `SIGTERM` 掉子进程 |

围栏（顺序执行，任一不过就失败）：

1. **loopback**：socket 远端必须是 `127.0.0.0/8` 或 `::1`，`Host` 必须是本机名，
   `Sec-Fetch-Site` 不得是跨站 —— 否则 `403 E_LOOPBACK_ONLY`。
2. **跨站防护**（只对两个 `POST`）：必须带 `X-DSH-Plugin: awake`，且 `Origin` 为空或与 `Host` 同源 ——
   否则 `403 E_FORBIDDEN`。自定义头会强制跨源预检，而本插件不返回任何 `Access-Control-Allow-*`，
   所以别的网站发不出来；同源页面不触发预检，零额外成本。

## 自己验一下

```sh
# 点开按钮之后
pgrep -x caffeinate                      # 恰好 1 个（单实例）
pmset -g assertions | grep -i caffeinate # 能看到 PreventUserIdleSystemSleep

# 点关闭之后
pgrep -x caffeinate                      # 本插件的那个已消失
pmset -g assertions | grep -i caffeinate # 断言消失
```

## 安装

本仓库的插件统一以 `link:` 依赖挂进 profile，不走 npm 发布：

```sh
# 在 profile 目录（默认 ~/.dsh/profiles/web）里把本目录加进 dependencies，然后
pnpm install
```

装完**重启 dsh web** 才会加载新插件（重启会终止当前会话，注意时机）。

## 已知限制

- 只支持 macOS；
- 不探测、也不杀**别人**（其它进程 / 其它终端）持有的唤醒断言——本插件只认自己那一个子进程；
- 多标签页状态不同步；
- 合盖仍然休眠，见上。
