/**
 * 线上协议常量：路由表、错误码、子进程形态、跨站防护头。
 * 纯数据、无副作用——宿主半边与单测共用同一份真相。
 * @module dsh-plugin-awake/host/protocol
 */

/**
 * 路由族前缀。
 *
 * 注意它**不是** `/api/...`：这些端点是本插件自己的宿主 API，
 * 只服务本机浏览器的发送栏按钮，不需要经过 dsh 的 `/api` 桥。
 */
export const API_PREFIX = '/plugins/awake'

/**
 * 端点表。webServer 以 (kind, path) 为键注册，重复注册直接抛错，
 * 所以一条路径只注册一次，GET / POST 在 handler 内部分派。
 */
export const API = {
  status: `${API_PREFIX}/status`,
  start: `${API_PREFIX}/start`,
  stop: `${API_PREFIX}/stop`,
}

/** 跨站防护：POST 必须带的自定义请求头（小写，node 的 header 名一律小写）。 */
export const PLUGIN_HEADER = 'x-dsh-plugin'

/** `X-DSH-Plugin` 必须等于这个值。 */
export const PLUGIN_HEADER_VALUE = 'awake'

/** 被拉起的可执行文件。 */
export const BINARY = 'caffeinate'

/**
 * `-i` = `PreventUserIdleSystemSleep`：只压空闲睡眠，不压显示器睡眠。
 *
 * **绝不带 `-t`**：带 `-t` 就是「到期自停」，而本插件是纯开关，停止权只归用户。
 */
export const ARGS = ['-i']

/** 唯一支持平台：`caffeinate` 只在 macOS 上存在。 */
export const SUPPORTED_PLATFORM = 'darwin'

/**
 * spawn 之后的观察窗口。参数写错 / 二进制不存在都会让子进程立刻退出，
 * 在这个窗口内看到退出就当作失败，绝不返回「看起来开了」。
 */
export const VERIFY_DELAY_MS = 500

/** 统一错误码（风格对齐 dsh-plugin-auto-upgrade 的 `CODE`）。 */
export const CODE = {
  LOOPBACK_ONLY: 'E_LOOPBACK_ONLY',
  METHOD_NOT_ALLOWED: 'E_METHOD_NOT_ALLOWED',
  FORBIDDEN: 'E_FORBIDDEN',
  BAD_REQUEST: 'E_BAD_REQUEST',
  UNSUPPORTED_PLATFORM: 'E_UNSUPPORTED_PLATFORM',
  SPAWN_FAILED: 'E_SPAWN_FAILED',
  INTERNAL: 'E_INTERNAL',
}

/** 请求体上限：本插件所有端点都不吃 body，这个值只是防滥用。 */
export const MAX_BODY_BYTES = 1024
