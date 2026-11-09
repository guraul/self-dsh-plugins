# scripts/pipeline/ — 生成的入口

本目录 6 个 `*.sh` 全部由共享包 `@guraul/dsh-pipeline` 生成，**不是手写脚本，禁止手改**：

- 重新生成：`node tools/node_modules/dsh-pipeline/bin/cli.mjs shim install --root .`
- 校验一致性：`node tools/node_modules/dsh-pipeline/bin/cli.mjs shim check --root .`
  ——手改任何一个字节它都会**变红**（退出码 1）。
- `pipeline.sh` 是通用入口（第一个参数即子命令），其余 5 个按文件名转发到
  `task` / `pr` / `merge` / `review` / `status`。
- 检查清单（跑哪些包）在 `.dsh/pipeline.json` 的 `checks.packages`，不在这里维护。
- 行为契约见 `guraul/dsh-pipeline` 仓的 [`docs/CONTRACT.md`](https://github.com/guraul/dsh-pipeline/blob/main/docs/CONTRACT.md)。
- 本目录 `README.md` 是唯一手写文件，可改。
