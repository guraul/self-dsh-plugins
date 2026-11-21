# dsh-plugin-speech-mimo

给 DSH 语音输入注册一个云端识别提供方：把一段 16 kHz 单声道 PCM16 WAV 发到 opencode-go 网关的
`mimo-v2.6-flash`，返回文字。**本机不跑模型，也不下载模型。**

## 安装

1. 在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 里加本包（目录名 `dsh-speech-mimo/`）：

   ```json
   "dsh-plugin-speech-mimo": "link:/Users/gubin/workspace/self-dsh-plugins/dsh-speech-mimo"
   ```

2. 在同一个文件的 `dsh.profile.bundles` 里加两行，**语音 bundle 必须排在前面**
   （先有 `speechToText` 服务，provider 才能注册）：

   ```json
   "@deepseek-ai/dsh-experimental-voice-input-bundle",
   "dsh-plugin-speech-mimo"
   ```

3. 在 `~/.dsh/profiles/web` 跑 `pnpm install`（只建链接）。
4. 重启 dsh web，打开语音设置，把默认识别器选成 **MiMo v2.6 Flash（云端）**，语言选 `auto` / `zh` / `en`。

凭据放在 `~/.dsh/.credentials.yaml` 的 `refs.OPENCODE_GO_API_KEY`，插件用
`ctx.credentials.resolve('OPENCODE_GO_API_KEY')` 取，不会把 key 写进日志、错误或响应体。

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `baseURL` | `https://opencode.ai/zen/go/v1/chat/completions` | 网关地址 |
| `model` | `mimo-v2.6-flash` | 模型 id |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | 凭据名 |
| `sessionHeader` | `x-opencode-session` | 网关要求的会话头名；缺了会报 400 `MissingSessionID` |
| `silenceRmsDb` | `-50` | PCM 的 RMS 低于该值视为静音，直接返回空文字、不发请求 |
| `timeoutMs` | `120000` | 单次识别超时（同时接受调用方取消信号） |

## 已知限制

- **静音可能被编造**：插件用能量门限挡掉纯静音；门限以上的噪声（键盘、风扇）仍可能被模型编出一句话。
  嫌吵可把 `silenceRmsDb` 调高（例如 `-40`）。
- **纯云端**：断网、key 失效、额度耗尽都会明确报错，不插入任何文字；没有本地兜底。
- **整段上传**：每次识别上传完整 WAV，没有流式转写。参考耗时：6.8 秒音频约 3.2–3.6 秒，
  24.3 秒音频约 9.7 秒。
- **只有三种语言**：`auto` / `zh` / `en`；其它语言会被语音服务拒绝。
- **没有 preparation**：不检查缓存、不下载文件，语音服务直接把它当成 ready。

## 测试

```sh
cd dsh-speech-mimo && pnpm test
```

单测用 stub 的 `fetch`，不打真实网关，覆盖能量门限、`content` 为空时回退 `reasoning` /
`reasoning_content`、非 2xx 报错，以及请求头与请求体形状。
