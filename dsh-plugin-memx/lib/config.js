// src/config.ts
import Schema from "@deepseek-ai/schemastery";
var Config = Schema.object({
  provider: Schema.string().default("").volatile(),
  model: Schema.string().default("").volatile(),
  autoRefine: Schema.boolean().default(true).volatile(),
  throttleMinutes: Schema.number().min(1).max(1440).default(10).volatile()
});
export {
  Config
};
