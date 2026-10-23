/**
 * dsh-plugin-memx 的 Web 客户端入口：往设置面注册一页「记忆」。
 *
 * `settings.section` 是**独立一页**（不是「插件」分区里的标签），由 ui-settings
 * 声明、ui-settings-general 渲染；注册必须经 `ctx.slots.inject`（宿主声明槽位
 * 的时机与本插件激活顺序无关）。
 *
 * 配置读写走 `ctx.configForms.get('memx')`——entry id 就是 `cordis.patch.yml` 里
 * 那一行的 `id: memx`，不是包名。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 类型级引入：激活 ctx.slots（ui-renderer）、ctx.configForms + settings.section
// 槽位声明（ui-settings）、ctx.remote 的 session 命名空间（api-remotes）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createMemorySettings, type MemxSettingsValue } from './MemorySettings.js'

export const name = 'dsh-plugin-memx-client'

/** 三个服务都是页面必需：缺任何一个这一页都无从渲染。 */
export const inject = ['slots', 'remote', 'configForms']

/** 宿主配置条目 id（`cordis.patch.yml` → `- insert: - id: memx`）。 */
const SETTINGS_ENTRY_ID = 'memx'

/** 设置页 id（导航键）。 */
const SECTION_ID = 'memx-memory'

/** 导航位置：官方 account(-10) / general(0) / models(10) / plugins(15) / agent-presets(20) 之后。 */
const SECTION_ORDER = 60

export function apply(ctx: ClientContext): void {
  const form = ctx.configForms.get<MemxSettingsValue>(SETTINGS_ENTRY_ID)
  const Section = createMemorySettings({
    form,
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
