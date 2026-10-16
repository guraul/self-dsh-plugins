/**
 * npm registry 只读查询：dist-tags 与版本清单。
 * 失败一律返回 `{ ok:false }`，由上层翻成 `decision:'unknown'`——
 * 「检测失败」绝不允许伪装成「已是最新」。
 * @module dsh-plugin-auto-upgrade/host/registry
 */
import { DSH_PACKAGE } from './protocol.js'

/**
 * 包名转 registry 路径段（只编码斜杠，作用域名保留 @）。
 * @param {string} name 包名。
 * @returns {string} 路径段。
 */
export function packagePath(name) {
  return name.replace('/', '%2f')
}

/**
 * 拉取 packument（缩略格式）。
 * @param {string} registry registry 基址。
 * @param {string} name 包名。
 * @param {{timeoutMs?:number, fetchImpl?:typeof fetch}} [options] 选项。
 * @returns {Promise<{ok:true, tags:Record<string,string>, versions:string[], modified?:string}|{ok:false, error:string, status?:number}>} 结果。
 */
export async function fetchPackument(registry, name = DSH_PACKAGE, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 12000
  const url = `${registry.replace(/\/+$/, '')}/${packagePath(name)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      return { ok: false, error: `registry responded ${response.status}`, status: response.status }
    }
    const body = await response.json()
    const tags = body['dist-tags'] !== null && typeof body['dist-tags'] === 'object' ? body['dist-tags'] : {}
    const versions = body.versions !== null && typeof body.versions === 'object' ? Object.keys(body.versions) : []
    return { ok: true, tags, versions, modified: typeof body.modified === 'string' ? body.modified : undefined }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}
