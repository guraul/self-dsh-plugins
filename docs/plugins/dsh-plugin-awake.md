# dsh-plugin-awake（插件级 agent 说明）

> 仓库级约定见根 [`AGENTS.md`](../../AGENTS.md)；面向使用者的说明见 [`../../dsh-awake/README.md`](../../dsh-awake/README.md)。
> 本文只写「改哪里、注意什么、怎么验证」，不重复用户手册。

- 目录：`dsh-awake/`　包名：`dsh-plugin-awake`　来源：**原创**　当前版本：`0.1.0`

## 术语表（先读这一节）

| 术语 | 含义 | 在本插件里的对应物 |
|---|---|---|
| **保持唤醒** | 让机器「正在被使用」这件事对系统成立，从而不进入空闲睡眠。**不是**不休眠的万能开关。 | 咖啡杯按钮 / 底部状态条的 active 态 |
| **唤醒断言** | macOS 里的一个「有人在用」的声明（assertion）。持有断言期间，对应种类的睡眠被抑制。种类由参数决定：`-i` 抑制空闲系统睡眠、`-d` 抑制显示器睡眠、`-s` 抑制系统睡眠。 | `caffeinate -i` 进程本身持有的 `PreventUserIdleSystemSleep` |
| **空闲睡眠** | 一段时间没有任何 **HID**（键盘 / 鼠标 / 触控板）输入后，系统主动 `Sleep`。判据只有 HID，**不看进程、不看网络**。 | 本插件唯一要压的东西 |
| **合盖休眠** | 合上屏幕触发的休眠。硬件层事件，软件断言挡不住。 | **本插件不处理**（README 明写） |
| **外部断言** | 不是本插件起的、但同样在抑制睡眠的东西：别的 `caffeinate`、`caffeinate -u -t`、某 App 自己的断言、`pmset disablesleep`。 | **本插件不探测、不杀**（留 v2）；`pgrep -x caffeinate` 看到的进程不一定是本插件的 |

### 为什么用 `caffeinate -i` 而不是 `pmset disablesleep`

| 维度 | `caffeinate -i`（本插件） | `pmset disablesleep 1` |
|---|---|---|
| 权限 | 普通用户即可 | 需要 **sudo** |
| 作用域 | **一个进程**持有，进程没了断言自动消失 | **全局系统配置**，写进电源管理状态 |
| 出事时的后果 | 最坏是多一个 `caffeinate` 进程，`kill` 就干净 | 忘关就一直不休眠，甚至过夜放电 |
| 合盖 | 挡不住 | 能挡（这也是它危险的地方） |

结论：**按需**场景要的是「跟着一个进程生命周期走」的断言，而不是一份要人记得撤销的全局配置。
所以这里只调 `caffeinate`，`-i`（只压空闲系统睡眠），**永不带 `-t`**——带 `-t` 就是「到期自停」，
而本插件的规格是纯开关：开就开到用户关。

## 目录与分工

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 宿主入口：`name = 'dsh-awake'`、`inject = ['webServer']`、注册 3 条路由、`ctx.effect` 清理 |
| `lib/host/protocol.js` | **唯一真相**：路由表、`X-DSH-Plugin` 头名与值、`BINARY` / `ARGS`、观察窗口、错误码 |
| `lib/host/service.js` | **状态机**（纯逻辑 + 可注入副作用）：start / stop / 重复 start / exit 自愈 / dispose |
| `lib/host/cross-site.js` | 跨站防护：自定义头 + `Origin` 同源判定 |
| `lib/host/loopback.js` | loopback 围栏（与 `dsh-auto-upgrade` 同构的复制件） |
| `lib/host/http.js` | JSON 信封、`RequestError`、有界 body、方法分发（同上，复制件） |
| `lib/client.js` | 浏览器半边：`conversation.input.right` 按钮 + `shell.bottom` 状态条 + 中英字典 + 内联样式 |
| `scripts/lint.js` | 门禁之一：对 `lib/**`、`test/**` 逐个 `node --check` |
| `test/*.test.mjs` | 状态机、路由、跨站/loopback 围栏、客户端注册与 store |

## 架构与数据流

```
浏览器（lib/client.js，同一份 store 供两个槽位）
   │  GET /status            ← 挂载时各读一次（并发合并）
   │  POST /start|/stop      ← 带 X-DSH-Plugin: awake
   ▼
宿主路由（lib/index.js）
   │  围栏1 loopback → 围栏2 跨站（仅 POST）→ 无 body
   ▼
lib/host/service.js（状态机）
   │  spawn('caffeinate', ['-i']) ── 500ms 观察窗口 ── 仍在跑才算 active
   │  child.on('exit') → 状态自愈回 inactive
   ▼
caffeinate ──持有──► PreventUserIdleSystemSleep
```

## 改之前必须知道的五件事

1. **`ARGS` 只能放宽、不能加 `-t`。** 加 `-t` 等于偷偷引入「到期回落」，和规格（纯开关）冲突。
   单测 `test/service.test.mjs` 有一条断言专门守这个。
2. **状态只在宿主。** 客户端不写 `localStorage`、不轮询、不接 SSE。要在页面上「记住」什么，
   想清楚它是不是该由宿主回答——本插件的答案是：宿主答，页面读。
3. **`shell.bottom` 是 root 作用域的单槽位**，`conversation.input.right` 是 **session 作用域**。
   两者必须各自 `slots.inject(...)` 注册：`SlotCore` 对**未声明**槽位是同步抛错，
   共用一次注册会让「某个宿主版本缺一个槽位」把另一个也拖垮。
   `shell.bottom` 空内容不预留空间（layout README 明写），所以 inactive 时组件直接返回 `null` 就够，
   **不要**用 `shell.overlay`（会盖住正文）或侧栏角标（过重）。
4. **跨站防护是新增的那一层，不要删。** loopback 只回答「是不是本机发来的」，
   回答不了「是本机哪个页面发来的」——本机浏览器里任何网页都能往 `127.0.0.1:3080` 发简单 POST。
   判据：`X-DSH-Plugin: awake` **且** `Origin` 为空或与 `Host` 同 authority。两条任一不满足 → 403。
5. **不留孤儿。** 三条路径都要杀子进程：`ctx.effect` 的清理函数（disable / 卸载 / 重启）、
   子进程自己退出（外部 kill，状态自愈）、以及 `stop` 撞上正在飞的 `start`（先 `await` 再杀）。
   改 `service.js` 时这三条都要保住。

## 验证

```sh
cd dsh-awake
node --test "test/*.test.mjs"   # 34 条：状态机 / 路由 / 围栏 / 客户端注册与 store
node scripts/lint.js            # 11 个文件的 node --check
```

单测**绝不 spawn 真实 `caffeinate`**：`createAwakeService({ spawn, wait, now, platform })` 全是注入缝，
`test/routes.test.mjs` 用假 `webServer.register` + 真 `node:http` 服务驱动路由。

真机验收（需要重启 dsh web 才能加载新插件，**重启会终止当前会话**）：

```sh
# 1) 点按钮 → 断言出现、单实例
pgrep -x caffeinate; pmset -g assertions | grep -i caffeinate
# 2) 刷新页面 / 切会话 → 按钮仍 active、状态条仍在
# 3) 再点（或点状态条「关闭」）→ 断言消失、无本插件进程
# 4) 禁用插件 / 重启 dsh → pgrep -x caffeinate 为空
# 5) 不带 X-DSH-Plugin 头的 POST → 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3080/plugins/awake/start
# 6) 合盖仍休眠：这是**预期**，README 已写「本插件不阻止合盖休眠」
```

## 已知坑

- **`pgrep -x caffeinate` 可能看到别人的进程**：用户自己开过的 `caffeinate`、别的 App 起的都算。
  判归属只看 `GET /plugins/awake/status` 返回的 `pid`，别拿进程总数当断言。
- **`caffeinate` 参数写错会秒退**，`spawn` 成功也只说明 fork 成功。所以有 500ms 观察窗口：
  窗口内退出 → `500 E_SPAWN_FAILED`，绝不返回「看起来开了」。这个窗口时间在 `protocol.js`。
- **不声明 `@deepseek-ai/dsh` 的 `peerDependencies`**（与 `dsh-auto-upgrade` 一致）：
  免得平台闸门在某天把插件整个跳过；本插件只用 `webServer.register` 与两个稳定槽位。
- **非 macOS 平台**返回 `501 E_UNSUPPORTED_PLATFORM`，不 spawn 任何东西——不要在测试里去掉这条分支。
