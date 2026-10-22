/**
 * dsh-plugin-memx —— memx 的 DSH 薄壳包。
 *
 * 单一事实源是 memx 仓的 DSH 宿主适配器：
 *   /Users/gubin/workspace/memx/src/hosts/dsh/index.ts
 * 这里不复制任何记忆逻辑（注入 / 捕获 / 提炼 / 写盘全部在 memx 的 core 里），
 * 只把它的导出原样转发给 Cordis。
 *
 * 为什么不直接 `export { … } from "<…>/index.ts"`：
 * Node 24 默认只有 strip-only 类型剥离，memx 源码里有 parameter property
 * （`constructor(private …)` 之类），直接 import 会抛
 * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX（2026-10-22 实测）。所以这里注册一个
 * 只作用于 memx 源码目录的 load hook，用 transform 模式剥类型；
 * 路径仍指向 memx 源码本身，memx 改代码后无需在本包重编译。
 */
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MEMX_ROOT = "/Users/gubin/workspace/memx/";
const MEMX_ENTRY = `${MEMX_ROOT}src/hosts/dsh/index.ts`;

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".ts")) {
      const path = fileURLToPath(url);
      if (path.startsWith(MEMX_ROOT)) {
        return {
          format: "module",
          source: stripTypeScriptTypes(readFileSync(path, "utf8"), { mode: "transform" }),
          shortCircuit: true,
        };
      }
    }
    return nextLoad(url, context);
  },
});

const memx = await import(MEMX_ENTRY);

export const {
  name,
  inject,
  apply,
  Config,
  INJECT_SECTION_ORDER,
  INJECT_SECTION_NAME,
  DEFAULT_THROTTLE_MINUTES,
  NOTICE_MAX_CHARS,
} = memx;
