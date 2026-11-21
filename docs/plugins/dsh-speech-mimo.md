# dsh-speech-mimo

**来源：原创。** 包名 `dsh-plugin-speech-mimo`，目录 `dsh-speech-mimo/`。

给 agent 的说明：改这个插件前读本页，它记的是「改哪里、容易踩什么、怎么验证」，安装与配置面向使用者的部分在
[`../../dsh-speech-mimo/README.md`](../../dsh-speech-mimo/README.md)。

## 它解决什么

DSH 的语音输入原来只有本地 SenseVoice：首次使用要下载约 228MB 模型，还要在本机跑推理。
本插件注册第二个 provider `mimo-flash`，把录音交给 opencode-go 网关的 `mimo-v2.6-flash`，
本机不加载、不下载任何模型。

## 数据通路

```
浏览器麦克风 ──16 kHz 单声道 PCM16 WAV──▶ speechToText.transcribe
                                             │
                                             ▼  index.js（host）
                                 POST https://opencode.ai/zen/go/v1/chat/completions
                                             │  Authorization: Bearer <credentials.resolve>
                                             ▼
                                 choices[0].message.content
```

- `inject = ['speechToText', 'credentials']`；`apply` 用 `ctx.effect` 包住 `register`，卸载时执行返回的 disposer。
- 不提供 `preparation`：语音服务把「没有 preparation」直接当成 `ready`，设置页不会出现下载入口。
- `info = { id: 'mimo-flash', name: 'MiMo v2.6 Flash（云端）', location: 'cloud', languages: ['auto', 'zh', 'en'] }`。

## 请求约定（不要凭直觉改）

- 请求体是 `messages[0].content = [input_audio, text]`；`input_audio.data` 是**完整 WAV 的裸 base64**，
  不带 `data:` 前缀；`format` 固定 `wav`。
- **必须带 `reasoning_effort: "none"`**。漏了会把转写结果放进思考字段，`content` 变成 `null`。
- 头部三件套：`Authorization: Bearer`、`x-opencode-session`（值固定 `dsh-speech-mimo`）、普通 `User-Agent`
  （`dsh-speech-mimo/0.1.0`）。缺 UA 会被 Cloudflare 拦成 403 `error code: 1010`；缺会话头报 400 `MissingSessionID`。
- 响应优先读 `choices[0].message.content`；为空回退 `reasoning`，再回退 `reasoning_content`，都为空返回空串。
- 错误信息只拼状态码与截断到 160 字的简要原因，并会把 key 替换成 `[redacted]`；不打印完整响应体、不打印音频字节。

## 能量门限

`parseWav` 校验 44 字节规范头（16 kHz / 单声道 / PCM16 / 数据长度一致），`pcmRmsDb` 算 PCM 的 RMS（dBFS）。
低于 `silenceRmsDb`（默认 -50）时直接返回 `{ text: '', audioSeconds, inferenceSeconds: 0 }`，**不发请求**，
并写一条 `speech-mimo: 音频能量低于门限…跳过识别` 的 info 日志。

## 容易踩的坑

1. **不要把 base64 写成裸 PCM**：`input_audio.data` 要整段 WAV（含 RIFF 头），不是 `audio.subarray(44)`。
2. **不要删 `reasoning_effort: 'none'`**：删了表现为「识别成功但文字为空」，很容易误判成网关故障。
3. **WAV 头校验是严格相等**：只接受 44 字节规范头；客户端换成别的容器（webm / mp3）时这里会先报错，
   需要在 `parseWav` 前加转码，而不是放宽校验。
4. **不要在 `apply` 顶层 `await` 凭据**：key 可能后配；凭据解析放在 `transcribe` 里，每次识别前取。
5. **日志里不要加 `payload` / `headers`**：一加就会把 key 或音频字节写进宿主日志。现有日志只记录
   RMS、状态码、时长与字数。

## 验证

```sh
cd dsh-speech-mimo && pnpm test
node --check index.js
```

真机验收（**需要重启 dsh web，会断当前会话；不要在会话里自己重启**）：

1. 语音设置出现「MiMo v2.6 Flash（云端）」，语言可选 auto / zh / en；
2. 录 10 秒中文 → 文字进输入框，允许错字，不允许解释性前缀或引号；
3. 录静音 → 不插入文字，`.dsh-web/web.out.log` 里能看到「音频能量低于门限」；
4. 断网 → 明确报错，输入框不进垃圾内容；
5. 日志与错误里没有 key，没有音频 base64；
6. 禁用插件 → 语音输入回到之前状态，`~/.dsh/speech-to-text` 未新增。

## 同步更新

改动后需要一起看的文件：

- 根 `README.md` 的插件表格
- `docs/plugins/README.md` 的索引表
- `.gitignore` 白名单、`.github/workflows/ci.yml` 的 matrix、`.dsh/pipeline.json` 的 `checks.packages`
