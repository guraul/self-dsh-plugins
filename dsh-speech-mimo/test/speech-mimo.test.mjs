import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

function ascii(bytes, offset, text) {
  for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index)
}

function wav({ seconds = 1, amplitude = 0.2 } = {}) {
  const sampleRate = 16000
  const samples = Math.round(seconds * sampleRate)
  const data = new Uint8Array(samples * 2)
  const samplesView = new DataView(data.buffer)
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * amplitude * 32767)
    samplesView.setInt16(index * 2, value, true)
  }
  const bytes = new Uint8Array(44 + data.byteLength)
  const head = new DataView(bytes.buffer)
  ascii(bytes, 0, 'RIFF')
  head.setUint32(4, 36 + data.byteLength, true)
  ascii(bytes, 8, 'WAVE')
  ascii(bytes, 12, 'fmt ')
  head.setUint32(16, 16, true)
  head.setUint16(20, 1, true)
  head.setUint16(22, 1, true)
  head.setUint32(24, sampleRate, true)
  head.setUint32(28, sampleRate * 2, true)
  head.setUint16(32, 2, true)
  head.setUint16(34, 16, true)
  ascii(bytes, 36, 'data')
  head.setUint32(40, data.byteLength, true)
  bytes.set(data, 44)
  return bytes
}

function setup(options = {}) {
  let provider
  const logs = []
  const ctx = {
    credentials: {
      resolve: async () => options.key === null ? undefined : { value: options.key ?? 'test-key' },
    },
    logger: {
      info: (message) => logs.push(message),
      warn: () => {},
      debug: () => {},
    },
    effect(run) {
      return run()
    },
    speechToText: {
      register(candidate) {
        provider = candidate
        return async () => {}
      },
    },
  }
  apply(ctx, { fetch: options.fetch, timeoutMs: options.timeoutMs ?? 1000 })
  return {
    logs,
    transcribe: (audio, language = 'auto') => provider.transcribe({ audio, language }, new AbortController().signal),
  }
}

const reply = (message) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message }] }),
})

test('静音音频被能量门限拦下，不发请求', async () => {
  let calls = 0
  const harness = setup({ fetch: async () => { calls += 1; throw new Error('不应发起请求') } })
  const result = await harness.transcribe(wav({ amplitude: 0 }), 'zh')
  assert.equal(result.text, '')
  assert.equal(result.inferenceSeconds, 0)
  assert.equal(calls, 0)
  assert.ok(harness.logs.some((line) => line.includes('低于门限')))
})

test('content 为空时回退 reasoning', async () => {
  const harness = setup({ fetch: reply({ content: null, reasoning: '你好，世界' }) })
  const result = await harness.transcribe(wav(), 'zh')
  assert.equal(result.text, '你好，世界')
})

test('content 与 reasoning 都为空时回退 reasoning_content', async () => {
  const harness = setup({ fetch: reply({ content: '', reasoning: '', reasoning_content: '备用字段' }) })
  const result = await harness.transcribe(wav(), 'auto')
  assert.equal(result.text, '备用字段')
})

test('非 2xx 报状态码且不含 key', async () => {
  const harness = setup({
    fetch: async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: async () => JSON.stringify({ error: { message: 'upstream exploded' } }),
    }),
  })
  await assert.rejects(harness.transcribe(wav(), 'en'), (error) => {
    assert.match(error.message, /HTTP 503/)
    assert.match(error.message, /upstream exploded/)
    assert.ok(!error.message.includes('test-key'))
    assert.ok(!error.message.includes('{'))
    return true
  })
})

test('错误原因跨越截断边界时 key 仍被脱敏', async () => {
  const secret = 'SECRETKEY123'
  const harness = setup({
    key: secret,
    fetch: async () => ({
      ok: false,
      status: 400,
      statusText: '',
      text: async () => JSON.stringify({ error: { message: `${'x'.repeat(150)}${secret}` } }),
    }),
  })
  await assert.rejects(harness.transcribe(wav(), 'zh'), (error) => {
    assert.ok(!error.message.includes('SECRETKEY'))
    assert.match(error.message, /\[redacted\]/)
    return true
  })
})

test('正常请求带齐头部、音频与语言提示', async () => {
  const audio = wav({ seconds: 2, amplitude: 0.3 })
  let request
  const harness = setup({
    fetch: async (url, init) => {
      request = { url, init }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '这是转写结果。' } }] }) }
    },
  })
  const result = await harness.transcribe(audio, 'zh')

  assert.equal(result.text, '这是转写结果。')
  assert.equal(result.audioSeconds, 2)
  assert.equal(request.url, 'https://opencode.ai/zen/go/v1/chat/completions')
  assert.equal(request.init.method, 'POST')
  assert.equal(request.init.headers.authorization, 'Bearer test-key')
  assert.equal(request.init.headers['x-opencode-session'], 'dsh-speech-mimo')
  assert.ok(request.init.headers['user-agent'])

  const body = JSON.parse(request.init.body)
  assert.equal(body.model, 'mimo-v2.6-flash')
  assert.equal(body.reasoning_effort, 'none')
  const [audioPart, textPart] = body.messages[0].content
  assert.equal(audioPart.type, 'input_audio')
  assert.equal(audioPart.input_audio.format, 'wav')
  assert.equal(audioPart.input_audio.data, Buffer.from(audio).toString('base64'))
  assert.ok(!audioPart.input_audio.data.startsWith('data:'))
  assert.ok(textPart.text.includes('简体中文'))
})

test('auto 不追加语言提示', async () => {
  let body
  const harness = setup({
    fetch: async (_url, init) => {
      body = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }
    },
  })
  await harness.transcribe(wav(), 'auto')
  assert.equal(body.messages[0].content[1].text, '把音频逐字转写成文字，只输出文字。')
})
