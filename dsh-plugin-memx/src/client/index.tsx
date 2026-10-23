/**
 * dsh-plugin-memx 的 Web 客户端入口：往设置面注册一页「记忆」。
 *
 * `settings.section` 是**独立一页**（不是「插件」分区里的标签），由 ui-settings
 * 声明、ui-settings-general 渲染；注册必须经 `ctx.slots.inject`（宿主声明槽位
 * 的时机与本插件激活顺序无关）。
 *
 * 配置读写走 `ctx.configForms.get('memx')`——entry id 就是 `cordis.patch.yml` 里
 * 那一行的 `id: memx`，不是包名。
 *
 * ⚠️ 不要在这里把 form 取成快照再闭包进组件：宿主下发设置项的时机同样与本插件
 * 激活顺序无关，apply 那一刻可能是空的。传取值函数，由页面自己轮询（见
 * MemorySettings.tsx）。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 类型级引入：激活 ctx.slots（ui-renderer）、ctx.configForms + settings.section
// 槽位声明（ui-settings）、ctx.remote 的 session 命名空间（api-remotes）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createMemorySettings, SETTINGS_ENTRY_ID, type MemxSettingsValue } from './MemorySettings.js'

export const name = 'dsh-plugin-memx-client'

/** 页面必需的服务：缺任何一个这一页都无从渲染。
 * `remote.session` 必须单独声明——只写 `remote` 时访问 `ctx.remote.session` 会抛
 * `cannot get property "remote.session" without inject`（线上白屏的真凶）。 */
export const inject = ['slots', 'remote', 'remote.session', 'configForms']

/** 设置页 id（导航键）。 */
const SECTION_ID = 'memx-memory'

/** 导航位置：官方 account(-10) / general(0) / models(10) / plugins(15) / agent-presets(20) 之后。 */
const SECTION_ORDER = 60

export function apply(ctx: ClientContext): void {
  const Section = createMemorySettings({
    // 取值函数：每次渲染现取，宿主还没下发设置项时返回 undefined（页面会显示状态并重试）。
    formFor: () => ctx.configForms.get<MemxSettingsValue>(SETTINGS_ENTRY_ID),
    loadCatalog: () => ctx.remote.session.modelCatalog(),
  })

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: SECTION_ID,
        order: SECTION_ORDER,
        label: () => '记忆',
      },
      Section,
    ),
  )
}
