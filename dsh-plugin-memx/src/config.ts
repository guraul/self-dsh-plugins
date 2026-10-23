// memx 薄壳包的配置声明（Web 设置页「记忆」的唯一真源）。
//
// 为什么必须在这里声明、而不是继续转发 memx 的 `Config`：
// 宿主 0.2.1 的设置面只认 **schemastery + `.volatile()`** —— dsh-settings 用
// `volatileForm(Config)` 投影可编辑字段，memx 那边手写的 standard-schema（只有
// `~standard.validate`）投影不出任何字段，设置页会整页消失。
//
// 四个字段全部 `.volatile()`：宿主把它们以**引用 cell** 的形态传给 `apply`
// （cosmokit Volatile，`{ get() }`），memx 的适配层负责拆包后读。
//
// `.default()` 的口径必须与 memx `DshMemxConfig` 的注释一致：
// provider / model 空 = 跟随当前会话；autoRefine 缺省开；throttleMinutes 缺省 10。
import Schema from '@deepseek-ai/schemastery'

/** 与 memx `DshMemxConfig` 对齐的四个字段（顺序即设置面渲染顺序）。 */
export interface Config {
  /** 提炼用 provider；空 = 跟随当前会话。 */
  provider?: string
  /** 提炼用 model；空 = 跟随当前会话。 */
  model?: string
  /** 轮末自动提炼开关；false 只关轮末补记，显式 memory_write 不受影响。 */
  autoRefine?: boolean
  /** 轮末补记节流（分钟，1–1440）。 */
  throttleMinutes?: number
}

export const Config = Schema.object({
  provider: Schema.string().default('').volatile(),
  model: Schema.string().default('').volatile(),
  autoRefine: Schema.boolean().default(true).volatile(),
  throttleMinutes: Schema.number().min(1).max(1440).default(10).volatile(),
})
