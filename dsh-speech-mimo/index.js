/**
 * MiMo v2.6 Flash 云端语音识别提供方（opencode-go 网关）。
 *
 * 只负责把一段 16 kHz 单声道 PCM16 WAV 发到网关换成文字：本机不加载模型，
 * 也没有 preparation 阶段（语音服务把无准备态直接当成 ready）。
 *
 * 凭据只从 ctx.credentials 取，且只以 Authorization 头发给上游；
 * 日志与错误信息里不含 key、响应体全文或音频字节。
 * @module dsh-plugin-speech-mimo
 */

const DEFAULTS = Object.freeze({
  baseURL: 'https://opencode.ai/zen/go/v1/chat/completions',
  model: 'mimo-v2.6-flash',
  apiKeyEnv: 'OPENCODE_GO_API_KEY',
  sessionHeader: 'x-opencode-session',
  silenceRmsDb: -50,
  timeoutMs: 120_000,
})

const SESSION_ID = 'dsh-speech-mimo'
const USER_AGENT = 'dsh-speech-mimo/0.1.0'
const LANGUAGES = Object.freeze(['auto', 'zh', 'en'])
const INSTRUCTION = '把音频逐字转写成文字，只输出文字。'
const LANGUAGE_HINTS = Object.freeze({
  zh: '语言：简体中文。',
  en: 'Language: English.',
})

const INFO = Object.freeze({
  id: 'mimo-flash',
  name: 'MiMo v2.6 Flash（云端）',
  location: 'cloud',
  languages: LANGUAGES,
})

const ASCII = (bytes, start, end) => {
  let text = ''
  for (let index = start; index < end; index += 1) text += String.fromCharCode(bytes[index])
  return text
}

/**
 * 校验浏览器录制的规范 WAV 头，返回音频时长。
 * @param {Uint8Array} audio 完整 WAV 字节。
 * @returns {{audioSeconds: number, dataBytes: number}}
 */
export function parseWav(audio) {
  if (!(audio instanceof Uint8Array) || audio.byteLength < 44) {
    throw new Error('语音音频不是有效的 WAV')
  }
  const u16 = (offset) => audio[offset] | (audio[offset + 1] << 8)
  const u32 = (offset) => (audio[offset] | (audio[offset + 1] << 8) | (audio[offset + 2] << 16) | (audio[offset + 3] << 24)) >>> 0
  const dataBytes = u32(40)
  if (ASCII(audio, 0, 4) !== 'RIFF' || ASCII(audio, 8, 12) !== 'WAVE'
    || ASCII(audio, 12, 16) !== 'fmt ' || u32(16) !== 16 || u16(20) !== 1
    || u16(22) !== 1 || u32(24) !== 16000 || u32(28) !== 32000 || u16(32) !== 2
    || u16(34) !== 16 || ASCII(audio, 36, 40) !== 'data'
    || audio.byteLength !== 44 + dataBytes) {
    throw new Error('语音音频必须是 16 kHz 单声道 PCM16 WAV')
  }
  return { audioSeconds: dataBytes / 32000, dataBytes }
}

/**
 * 计算 PCM 的 RMS（dBFS）；纯静音返回 -Infinity。
 * @param {Uint8Array} audio 完整 WAV 字节。
 * @returns {number}
 */
export function pcmRmsDb(audio) {
  const samples = Math.floor((audio.byteLength - 44) / 2)
  if (samples === 0) return -Infinity
  let sum = 0
  for (let index = 0; index < samples; index += 1) {
    const offset = 44 + index * 2
    const value = (audio[offset] | (audio[offset + 1] << 8)) << 16 >> 16
    sum += value * value
  }
  const rms = Math.sqrt(sum / samples)
  return rms === 0 ? -Infinity : 20 * Math.log10(rms / 32768)
}

/**
 * 从网关响应里取转写文字：先 content，空了再回退 reasoning / reasoning_content。
 * @param {unknown} json 上游 JSON。
 * @returns {string}
 */
export function transcriptText(json) {
  const message = json?.choices?.[0]?.message
  for (const candidate of [message?.content, message?.reasoning, message?.reasoning_content]) {
    const text = textOf(candidate)
    if (text !== '') return text
  }
  return ''
}

function textOf(value) {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')
    .join('')
    .trim()
}

function instruction(language) {
  const hint = LANGUAGE_HINTS[language]
  return hint === undefined ? INSTRUCTION : `${INSTRUCTION}${hint}`
}

function normalizeConfig(config) {
  const merged = { ...DEFAULTS, ...config }
  for (const name of ['baseURL', 'model', 'apiKeyEnv', 'sessionHeader']) {
    if (typeof merged[name] !== 'string' || merged[name] === '') throw new Error(`speech-mimo ${name} 不能为空`)
  }
  if (!Number.isFinite(merged.silenceRmsDb)) throw new Error('speech-mimo silenceRmsDb 必须是数字')
  if (!Number.isFinite(merged.timeoutMs) || merged.timeoutMs <= 0) throw new Error('speech-mimo timeoutMs 必须是正数')
  return merged
}

async function resolveKey(ctx, name) {
  let hit
  try {
    hit = await ctx.credentials.resolve(name)
  } catch {
    hit = undefined
  }
  const value = typeof hit === 'string' ? hit : hit?.value
  if (typeof value !== 'string' || value === '') throw new Error(`MiMo 语音识别缺少凭据：${name}`)
  return value
}

function brief(value, key) {
  let text = typeof value === 'string' ? value : ''
  if (key !== undefined && key !== '') text = text.split(key).join('[redacted]')
  return text.replace(/\s+/g, ' ').trim().slice(0, 160)
}

async function failureReason(response, key) {
  let detail = ''
  try {
    const raw = await response.text()
    try {
      const json = JSON.parse(raw)
      detail = typeof json?.error?.message === 'string' ? json.error.message
        : typeof json?.message === 'string' ? json.message : ''
    } catch {
      detail = ''
    }
  } catch {
    detail = ''
  }
  const reason = brief(detail, key)
  return reason === '' ? brief(response.statusText, key) : reason
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('语音识别已取消')
}

function networkLabel(error) {
  return error?.cause?.code ?? error?.code ?? error?.name ?? 'fetch failed'
}

function audioBase64(audio) {
  return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength).toString('base64')
}

async function transcribe(ctx, config, input, signal) {
  signal?.throwIfAborted()
  if (!LANGUAGES.includes(input.language)) throw new Error(`不支持的语音语言：${String(input.language)}`)
  const { audioSeconds } = parseWav(input.audio)
  const level = pcmRmsDb(input.audio)
  if (level < config.silenceRmsDb) {
    ctx.logger?.info?.(`speech-mimo: 音频能量低于门限（${level.toFixed(1)} dBFS < ${config.silenceRmsDb} dBFS），跳过识别`)
    return { text: '', audioSeconds, inferenceSeconds: 0 }
  }

  const key = await resolveKey(ctx, config.apiKeyEnv)
  const fetchImpl = config.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境没有 fetch，无法调用 MiMo')

  const payload = JSON.stringify({
    model: config.model,
    reasoning_effort: 'none',
    max_completion_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        { type: 'input_audio', input_audio: { data: audioBase64(input.audio), format: 'wav' } },
        { type: 'text', text: instruction(input.language) },
      ],
    }],
  })

  const deadline = AbortSignal.timeout(config.timeoutMs)
  const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  const started = process.hrtime.bigint()
  let response
  try {
    response = await fetchImpl(config.baseURL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        [config.sessionHeader]: SESSION_ID,
      },
      body: payload,
      signal: combined,
    })
  } catch (error) {
    if (deadline.aborted) throw new Error(`MiMo 语音识别超时（${config.timeoutMs} ms）`)
    if (signal?.aborted) throw abortReason(signal)
    throw new Error(`MiMo 语音识别网络错误：${networkLabel(error)}`)
  }

  if (!response.ok) {
    const reason = await failureReason(response, key)
    ctx.logger?.warn?.(`speech-mimo: 上游返回 HTTP ${response.status}`)
    throw new Error(`MiMo 语音识别失败：HTTP ${response.status}${reason === '' ? '' : `（${reason}）`}`)
  }

  let json
  try {
    json = await response.json()
  } catch {
    if (deadline.aborted) throw new Error(`MiMo 语音识别超时（${config.timeoutMs} ms）`)
    if (signal?.aborted) throw abortReason(signal)
    throw new Error('MiMo 语音识别失败：响应不是合法 JSON')
  }
  combined.throwIfAborted()

  const inferenceSeconds = Number(process.hrtime.bigint() - started) / 1e9
  const text = transcriptText(json)
  ctx.logger?.debug?.(`speech-mimo: 识别完成，音频 ${audioSeconds.toFixed(1)}s，耗时 ${inferenceSeconds.toFixed(1)}s，${text.length} 字`)
  return { text, audioSeconds, inferenceSeconds }
}

/**
 * 注册云端识别提供方；无 preparation，语音服务直接视为 ready。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文。
 * @param {object} config 插件配置；另含测试注入缝 `fetch`。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const resolved = normalizeConfig(config)
  const provider = {
    info: { ...INFO, languages: [...LANGUAGES] },
    transcribe: (input, signal) => transcribe(ctx, resolved, input, signal),
  }
  ctx.effect(() => ctx.speechToText.register(provider))
}

export const name = 'dsh-plugin-speech-mimo'

export const inject = ['speechToText', 'credentials']
