window.__ModuleLoader__.load({
	id: "dsh-plugin-memx",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);

// src/client/MemorySettings.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var SETTINGS_ENTRY_ID = "memx";
var LLM_SETTINGS_ENTRY_ID = "llm-pi-ai";
var THROTTLE_MIN = 1;
var THROTTLE_MAX = 1440;
var THROTTLE_COMMIT_DELAY_MS = 500;
var FORM_RETRY_INTERVAL_MS = 300;
var FORM_RETRY_TIMEOUT_MS = 2e4;
function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  const message = error?.message;
  return typeof message === "string" && message ? message : String(error);
}
function isConflict(error) {
  const code = error?.code;
  return code === "SETTINGS_CONFLICT" || errorMessage(error).includes("SETTINGS_CONFLICT");
}
var MODEL_SOURCE_LABEL = {
  config: "\u6A21\u578B\u6765\u6E90\uFF1A\u914D\u7F6E\uFF08llm-pi-ai\uFF09",
  "config+catalog": "\u6A21\u578B\u6765\u6E90\uFF1A\u914D\u7F6E + \u8FD0\u884C\u65F6\u76EE\u5F55",
  catalog: "\u6A21\u578B\u6765\u6E90\uFF1A\u8FD0\u884C\u65F6\u76EE\u5F55",
  empty: "\u6A21\u578B\u6765\u6E90\uFF1A\u65E0\uFF08\u914D\u7F6E\u4E0E\u8FD0\u884C\u65F6\u76EE\u5F55\u5747\u4E3A\u7A7A\uFF09"
};
function readConfigProviders(value) {
  const providers = value?.providers;
  if (!providers || typeof providers !== "object") return [];
  const groups = [];
  for (const [routeId, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== "object") continue;
    const seen = /* @__PURE__ */ new Set();
    const models = [];
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      if (!model || typeof model.id !== "string" || !model.id || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push({ id: model.id, name: typeof model.name === "string" && model.name ? model.name : model.id });
    }
    if (models.length === 0) continue;
    groups.push({
      id: routeId,
      name: typeof provider.name === "string" && provider.name ? provider.name : routeId,
      models
    });
  }
  return groups;
}
function mergeModelSources(input) {
  const { configGroups, configNote, catalog, catalogError } = input;
  const catalogGroups = catalog?.groups ?? [];
  const failures = catalog?.failures ?? [];
  const groups = configGroups.map(
    (group) => ({ ...group, models: [...group.models] })
  );
  const seen = new Set(groups.flatMap((group) => group.models.map((model) => `${group.id}/${model.id}`)));
  for (const group of catalogGroups) {
    const additions = group.models.filter((model) => {
      const key = `${group.id}/${model.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (additions.length === 0) continue;
    const existing = groups.find((candidate) => candidate.id === group.id);
    if (existing) existing.models.push(...additions);
    else groups.push({ id: group.id, name: group.name, models: [...additions] });
  }
  const hasConfig = configGroups.length > 0;
  const hasCatalog = catalogGroups.length > 0;
  const source = hasConfig && hasCatalog ? "config+catalog" : hasConfig ? "config" : hasCatalog ? "catalog" : "empty";
  const base = { groups, source, failures };
  if (source !== "empty") {
    return configNote === void 0 ? base : { ...base, configNote };
  }
  const configPart = configNote === void 0 ? "\u914D\u7F6E\u91CC\u6CA1\u6709 provider \u6A21\u578B\uFF08llm-pi-ai\uFF09" : `\u914D\u7F6E\u6682\u4E0D\u53EF\u8BFB\uFF08${configNote}\uFF09`;
  const catalogPart = catalogError === void 0 ? `\u8FD0\u884C\u65F6\u76EE\u5F55 groups=${catalogGroups.length} / failures=${failures.length}` : `\u8FD0\u884C\u65F6\u76EE\u5F55\u8BFB\u53D6\u5931\u8D25\uFF1A${catalogError}`;
  return {
    ...base,
    ...configNote === void 0 ? {} : { configNote },
    reason: `\u76EE\u5F55\u4E3A\u7A7A\uFF1A${configPart}\uFF0C${catalogPart}`
  };
}
function ensureStyles() {
  if (typeof document === "undefined") return;
  const ID = "dsh-plugin-memx-settings-styles";
  if (document.getElementById(ID)) return;
  const style = document.createElement("style");
  style.id = ID;
  style.textContent = [
    ".memx-st-page{display:flex;flex-direction:column;gap:16px;padding:4px 0 24px;}",
    ".memx-st-head{display:flex;flex-direction:column;gap:4px;}",
    ".memx-st-title{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);}",
    ".memx-st-sub{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b7280);}",
    ".memx-st-diag{margin:0;font-size:11px;line-height:1.5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary,#6b7280);word-break:break-word;}",
    ".memx-st-card{display:flex;flex-direction:column;gap:12px;padding:16px 18px;border-radius:12px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.24));background:var(--dsw-alias-fill-primary,transparent);}",
    ".memx-st-row{display:grid;grid-template-columns:minmax(120px,200px) minmax(0,1fr);gap:6px 20px;align-items:start;}",
    ".memx-st-label{font-size:13px;font-weight:600;line-height:28px;color:var(--dsw-alias-label-primary,inherit);}",
    ".memx-st-label small{display:block;font-weight:400;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#6b7280);}",
    ".memx-st-field{display:flex;flex-direction:column;gap:6px;min-width:0;}",
    ".memx-st-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
    ".memx-st-inline--select{flex-wrap:nowrap;}",
    ".memx-st-select,.memx-st-input{box-sizing:border-box;min-height:28px;padding:4px 8px;border-radius:8px;font-size:13px;color:inherit;background:var(--dsw-alias-fill-secondary,rgba(128,128,128,.06));border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.32));}",
    ".memx-st-select{min-width:0;max-width:100%;flex:1 1 auto;}",
    ".memx-st-input{width:110px;}",
    ".memx-st-btn{flex:0 0 auto;white-space:nowrap;box-sizing:border-box;min-height:28px;padding:4px 10px;border-radius:8px;font-size:12px;cursor:pointer;color:inherit;background:var(--dsw-alias-fill-secondary,rgba(128,128,128,.06));border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.32));}",
    ".memx-st-btn:disabled{opacity:.55;cursor:default;}",
    ".memx-st-select:focus-visible,.memx-st-input:focus-visible,.memx-st-btn:focus-visible,.memx-st-check:focus-visible{outline:2px solid var(--dsw-alias-state-focus-ring,#4f7cf7);outline-offset:1px;}",
    ".memx-st-check{width:16px;height:16px;margin:6px 8px 0 0;accent-color:var(--dsw-alias-state-focus-ring,#4f7cf7);}",
    ".memx-st-hint{font-size:12px;line-height:1.6;text-align:left;color:var(--dsw-alias-label-secondary,#6b7280);}",
    ".memx-st-error{font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error,#d93025);}",
    ".memx-st-notice{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.6;}",
    '.memx-st-notice[data-kind="error"]{color:var(--dsw-alias-state-error,#d93025);background:color-mix(in srgb,var(--dsw-alias-state-error,#d93025) 10%,transparent);}',
    '.memx-st-notice[data-kind="info"]{color:var(--dsw-alias-label-secondary,#6b7280);background:var(--dsw-alias-fill-secondary,rgba(128,128,128,.08));}',
    ".memx-st-dl{display:grid;grid-template-columns:96px minmax(0,1fr);gap:6px 14px;margin:0;font-size:12px;line-height:1.6;}",
    ".memx-st-dl dt{color:var(--dsw-alias-label-secondary,#6b7280);}",
    ".memx-st-dl dd{margin:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary,inherit);}",
    ".memx-st-disabled{opacity:.6;}"
  ].join("");
  document.head.appendChild(style);
}
function Diagnostic({ snapshot }) {
  const status = snapshot?.status ?? "missing";
  if (status === "ready") return null;
  const writable = snapshot === void 0 ? "unknown" : String(snapshot.writable);
  const revision = snapshot?.revision === void 0 ? "\u2014" : String(snapshot.revision);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "memx-st-diag", "data-status": status, children: `entry=${SETTINGS_ENTRY_ID} \xB7 status=${status} \xB7 writable=${writable} \xB7 revision=${revision}` });
}
function SettingsPage({ children }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "memx-st-page", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "memx-st-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { className: "memx-st-title", children: "\u8BB0\u5FC6" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "memx-st-sub", children: "memx \u957F\u671F\u8BB0\u5FC6\uFF1A\u6CE8\u5165\u3001\u81EA\u52A8\u63D0\u70BC\u4E0E\u63D0\u70BC\u6A21\u578B\u3002\u6539\u52A8\u5373\u65F6\u4FDD\u5B58\uFF0C\u6CA1\u6709\u4FDD\u5B58\u6309\u94AE\u3002" })
    ] }),
    children
  ] });
}
function createMemorySettings(options) {
  const { formFor, llmFormFor, loadCatalog } = options;
  return function MemxMemorySettings(_props) {
    ensureStyles();
    const form = formFor();
    const [waitedFrom] = (0, import_react.useState)(() => Date.now());
    const [, setProbe] = (0, import_react.useState)(0);
    const waiting = form === void 0;
    const timedOut = waiting && Date.now() - waitedFrom >= FORM_RETRY_TIMEOUT_MS;
    (0, import_react.useEffect)(() => {
      if (!waiting) return;
      const timer = window.setInterval(() => setProbe((count) => count + 1), FORM_RETRY_INTERVAL_MS);
      return () => window.clearInterval(timer);
    }, [waiting]);
    if (form === void 0) {
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(SettingsPage, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Diagnostic, {}),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "memx-st-notice", "data-kind": timedOut ? "error" : "info", role: "status", children: timedOut ? `\u914D\u7F6E\u9879\u4ECD\u672A\u5C31\u7EEA\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\uFF08entry id: ${SETTINGS_ENTRY_ID}\uFF09\u3002` : `\u914D\u7F6E\u9879\u5C1A\u672A\u5C31\u7EEA\uFF1A\u6B63\u5728\u7B49\u5F85\u5BBF\u4E3B\u4E0B\u53D1\u8BBE\u7F6E\u9879\uFF08entry id: ${SETTINGS_ENTRY_ID}\uFF09\u2026` })
      ] });
    }
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MemorySettingsForm, { form, llmFormFor, loadCatalog });
  };
}
function MemorySettingsForm({ form, llmFormFor, loadCatalog }) {
  const snapshot = (0, import_react.useSyncExternalStore)(
    (callback) => form.subscribe(callback),
    () => form.getSnapshot()
  );
  const value = snapshot.value ?? {};
  const writable = snapshot.writable !== false;
  const status = snapshot.status;
  const [notice, setNotice] = (0, import_react.useState)(null);
  const [modelList, setModelList] = (0, import_react.useState)({
    state: "loading",
    list: { groups: [], source: "empty", failures: [] }
  });
  const [catalogError, setCatalogError] = (0, import_react.useState)(void 0);
  const llmForm = llmFormFor();
  const [, setLlmProbe] = (0, import_react.useState)(0);
  (0, import_react.useEffect)(() => {
    if (llmForm) return;
    const timer2 = window.setInterval(() => setLlmProbe((count) => count + 1), FORM_RETRY_INTERVAL_MS);
    return () => window.clearInterval(timer2);
  }, [llmForm]);
  const llmSnapshot = (0, import_react.useSyncExternalStore)(
    (0, import_react.useCallback)((callback) => llmForm ? llmForm.subscribe(callback) : () => {
    }, [llmForm]),
    (0, import_react.useCallback)(() => llmForm ? llmForm.getSnapshot() : null, [llmForm])
  );
  const alive = (0, import_react.useRef)(true);
  const reloadCatalog = (0, import_react.useCallback)(() => {
    setModelList((current) => ({ state: "loading", list: current.list }));
    let configGroups = [];
    let configNote;
    try {
      if (!llmForm) {
        configNote = "llm-pi-ai \u8BBE\u7F6E\u9879\u672A\u4E0B\u53D1";
      } else {
        const llmSnap = llmForm.getSnapshot();
        if (llmSnap.status === "ready" && llmSnap.value) configGroups = readConfigProviders(llmSnap.value);
        else configNote = `llm-pi-ai \u914D\u7F6E\u72B6\u6001 ${String(llmSnap.status)}`;
      }
    } catch (err) {
      configGroups = [];
      configNote = `\u914D\u7F6E\u8BFB\u53D6\u5931\u8D25\uFF1A${errorMessage(err)}`;
    }
    const finish = (result) => {
      if (!alive.current) return;
      setCatalogError(result.error);
      setModelList({
        state: "ready",
        list: mergeModelSources({
          configGroups,
          ...configNote === void 0 ? {} : { configNote },
          ...result.catalog === void 0 ? {} : { catalog: result.catalog },
          ...result.error === void 0 ? {} : { catalogError: result.error }
        })
      });
    };
    let request;
    try {
      request = Promise.resolve(loadCatalog());
    } catch (err) {
      finish({ error: errorMessage(err) });
      return;
    }
    void request.then((result) => finish({ catalog: result ?? void 0 })).catch((err) => finish({ error: errorMessage(err) }));
  }, [llmForm, loadCatalog]);
  (0, import_react.useEffect)(() => {
    alive.current = true;
    reloadCatalog();
    return () => {
      alive.current = false;
    };
  }, [reloadCatalog]);
  const seenLlmSnapshot = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => {
    if (!llmSnapshot) {
      seenLlmSnapshot.current = null;
      return;
    }
    if (seenLlmSnapshot.current !== null && !Object.is(seenLlmSnapshot.current, llmSnapshot)) reloadCatalog();
    seenLlmSnapshot.current = llmSnapshot;
  }, [llmSnapshot, reloadCatalog]);
  const save = (0, import_react.useCallback)(
    async (ops) => {
      if (!writable) return;
      try {
        const accepted = await form.mutate(ops);
        setNotice(
          accepted ? null : {
            kind: "error",
            text: "\u4FDD\u5B58\u5931\u8D25\uFF1A\u5BBF\u4E3B\u6CA1\u6709\u63A5\u53D7\u8FD9\u6B21\u4FEE\u6539\uFF08\u53EF\u80FD\u5DF2\u88AB\u5176\u5B83\u9875\u9762\u6539\u52A8\uFF09\u3002\u5DF2\u91CD\u65B0\u8BFB\u53D6\u6700\u65B0\u503C\uFF0C\u8BF7\u518D\u8BD5\u4E00\u6B21\u3002"
          }
        );
      } catch (err) {
        setNotice({
          kind: "error",
          text: isConflict(err) ? "\u4FDD\u5B58\u51B2\u7A81\uFF1A\u8BBE\u7F6E\u5DF2\u5728\u522B\u5904\u88AB\u4FEE\u6539\u3002\u5DF2\u91CD\u65B0\u8BFB\u53D6\u6700\u65B0\u503C\uFF0C\u8BF7\u518D\u8BD5\u4E00\u6B21\u3002" : `\u4FDD\u5B58\u5931\u8D25\uFF1A${errorMessage(err)}`
        });
      }
    },
    [form, writable]
  );
  const selected = value.provider && value.model ? `${value.provider}/${value.model}` : "";
  const { list } = modelList;
  const groups = list.groups;
  const selectedInCatalog = selected === "" || groups.some((group) => group.models.some((model) => `${group.id}/${model.id}` === selected));
  const selectedLabel = (() => {
    if (selected === "") return "\u8DDF\u968F\u5F53\u524D\u4F1A\u8BDD";
    for (const group of groups) {
      for (const model of group.models) {
        if (`${group.id}/${model.id}` === selected) return `${group.name} \xB7 ${model.name}`;
      }
    }
    return selected;
  })();
  const pickModel = (next) => {
    if (next === "") {
      void save([
        { op: "set", path: ["provider"], value: "" },
        { op: "set", path: ["model"], value: "" }
      ]);
      return;
    }
    const slash = next.indexOf("/");
    if (slash <= 0 || slash === next.length - 1) return;
    void save([
      { op: "set", path: ["provider"], value: next.slice(0, slash) },
      { op: "set", path: ["model"], value: next.slice(slash + 1) }
    ]);
  };
  const committed = typeof value.throttleMinutes === "number" ? value.throttleMinutes : 10;
  const [draft, setDraft] = (0, import_react.useState)(String(committed));
  const [throttleError, setThrottleError] = (0, import_react.useState)(null);
  const editing = (0, import_react.useRef)(false);
  const pending = (0, import_react.useRef)(null);
  const timer = (0, import_react.useRef)(void 0);
  (0, import_react.useEffect)(() => {
    if (!editing.current) setDraft(String(committed));
  }, [committed]);
  const clearTimer = () => {
    if (timer.current !== void 0) {
      window.clearTimeout(timer.current);
      timer.current = void 0;
    }
  };
  (0, import_react.useEffect)(() => clearTimer, []);
  const parseThrottle = (text) => {
    const trimmed = text.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
    if (parsed < THROTTLE_MIN || parsed > THROTTLE_MAX) return null;
    return parsed;
  };
  const commitThrottle = () => {
    clearTimer();
    const next = pending.current;
    pending.current = null;
    if (next === null || next === committed) return;
    void save([{ op: "set", path: ["throttleMinutes"], value: next }]);
  };
  const changeThrottle = (text) => {
    setDraft(text);
    const parsed = parseThrottle(text);
    if (parsed === null) {
      setThrottleError(`\u8BF7\u8F93\u5165 ${THROTTLE_MIN}\u2013${THROTTLE_MAX} \u4E4B\u95F4\u7684\u6574\u6570\uFF08\u5206\u949F\uFF09`);
      pending.current = null;
      clearTimer();
      return;
    }
    setThrottleError(null);
    pending.current = parsed;
    clearTimer();
    if (parsed === committed) return;
    timer.current = window.setTimeout(() => {
      timer.current = void 0;
      commitThrottle();
    }, THROTTLE_COMMIT_DELAY_MS);
  };
  if (status !== "ready") {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(SettingsPage, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Diagnostic, { snapshot }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "memx-st-notice", "data-kind": status === "unavailable" ? "error" : "info", role: "status", children: status === "loading" ? "\u6B63\u5728\u8BFB\u53D6 memx \u914D\u7F6E\u2026\uFF08\u5BBF\u4E3B\u5DF2\u4E0B\u53D1\u8BBE\u7F6E\u9879\uFF0C\u7B49\u5F85\u9996\u4E2A\u914D\u7F6E\u503C\uFF09" : "\u5F53\u524D\u5BBF\u4E3B\u6CA1\u6709\u66B4\u9732 memx \u7684\u914D\u7F6E\uFF08\u63D2\u4EF6\u672A\u542F\u7528\uFF0C\u6216 dsh \u8FD8\u6CA1\u91CD\u542F\u52A0\u8F7D\u65B0\u7248\u8584\u58F3\u5305\uFF09\u3002\u91CD\u542F dsh web \u540E\u518D\u770B\u8FD9\u4E00\u9875\u3002" })
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(SettingsPage, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Diagnostic, { snapshot }),
    notice && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "memx-st-notice", "data-kind": notice.kind, role: "status", children: notice.text }),
    !writable && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "memx-st-notice", "data-kind": "info", role: "status", children: "\u5F53\u524D\u90E8\u7F72\u7684\u8BBE\u7F6E\u6587\u6863\u662F\u53EA\u8BFB\u7684\uFF08writable = false\uFF09\uFF0C\u8FD9\u91CC\u7684\u6539\u52A8\u4E0D\u4F1A\u843D\u76D8\u3002" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `memx-st-card${writable ? "" : " memx-st-disabled"}`, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "memx-st-row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "memx-st-label", htmlFor: "memx-st-model", children: [
          "\u63D0\u70BC\u6A21\u578B",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("small", { children: "\u8F6E\u672B\u81EA\u52A8\u63D0\u70BC\u7528\uFF1B\u663E\u5F0F memory_write \u4E0D\u53D7\u5F71\u54CD" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "memx-st-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "memx-st-inline memx-st-inline--select", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
              "select",
              {
                id: "memx-st-model",
                className: "memx-st-select",
                "aria-label": "\u63D0\u70BC\u6A21\u578B",
                value: selected,
                disabled: !writable || modelList.state === "loading",
                onChange: (event) => pickModel(event.target.value),
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: "\u8DDF\u968F\u5F53\u524D\u4F1A\u8BDD" }),
                  !selectedInCatalog && selected !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: selected, children: selected }),
                  groups.map((group) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("optgroup", { label: group.name, children: group.models.map((model) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: `${group.id}/${model.id}`, children: model.name }, `${group.id}/${model.id}`)) }, group.id))
                ]
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                className: "memx-st-btn",
                onClick: reloadCatalog,
                disabled: modelList.state === "loading",
                title: "\u91CD\u65B0\u8BFB\u53D6\u6A21\u578B\u6765\u6E90\uFF08\u914D\u7F6E + \u8FD0\u884C\u65F6\u76EE\u5F55\uFF09",
                children: modelList.state === "loading" ? "\u8BFB\u53D6\u4E2D\u2026" : "\u5237\u65B0\u76EE\u5F55"
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "memx-st-hint", "data-role": "model-source", children: modelList.state === "loading" && list.source === "empty" ? "\u6A21\u578B\u6765\u6E90\uFF1A\u8BFB\u53D6\u4E2D\u2026" : MODEL_SOURCE_LABEL[list.source] }),
          catalogError && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "memx-st-error", children: [
            "\u8FD0\u884C\u65F6\u76EE\u5F55\u8BFB\u53D6\u5931\u8D25\uFF1A",
            catalogError
          ] }),
          list.configNote && list.source !== "empty" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "memx-st-diag", children: [
            "\u914D\u7F6E\u6682\u4E0D\u53EF\u8BFB\uFF08",
            list.configNote,
            "\uFF09\uFF0C\u5217\u8868\u4EC5\u6765\u81EA\u8FD0\u884C\u65F6\u76EE\u5F55\u3002"
          ] }),
          list.reason && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "memx-st-error", "data-role": "model-empty-reason", children: list.reason }),
          list.failures.map((failure) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "memx-st-diag", children: `${failure.id}: ${failure.message}` }, failure.id)),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "memx-st-hint", children: "\u9009\u9879\u6309 provider \u5206\u7EC4\uFF1B\u7A7A = \u8DDF\u968F\u5F53\u524D\u4F1A\u8BDD\uFF08\u7528\u4F1A\u8BDD\u81EA\u5DF1\u7684\u6A21\u578B\uFF09\u3002" })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "memx-st-row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "memx-st-label", htmlFor: "memx-st-auto", children: [
          "\u81EA\u52A8\u63D0\u70BC",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("small", { children: "\u5173\u6389\u540E\u8F6E\u672B\u4E0D\u518D\u8865\u8BB0" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "memx-st-field", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "memx-st-inline", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              id: "memx-st-auto",
              className: "memx-st-check",
              type: "checkbox",
              checked: value.autoRefine ?? true,
              disabled: !writable,
              onChange: (event) => void save([{ op: "set", path: ["autoRefine"], value: event.target.checked }])
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "memx-st-hint", children: value.autoRefine ?? true ? "\u5F00\uFF1A\u6BCF\u8F6E\u7ED3\u675F\u8BC6\u522B\u5230\u8BB0\u5FC6\u4FE1\u53F7\u5C31\u81EA\u52A8\u63D0\u70BC\u5199\u76D8" : '\u5173\uFF1A\u53EA\u4FDD\u7559\u663E\u5F0F memory_write\uFF08\u5BF9\u8BDD\u91CC\u8BF4"\u8BB0\u4F4F"\u4ECD\u7136\u4F1A\u5199\uFF09' })
        ] }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "memx-st-row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "memx-st-label", htmlFor: "memx-st-throttle", children: [
          "\u63D0\u70BC\u95F4\u9694",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("small", { children: "\u5206\u949F\uFF1B\u4E24\u6B21\u81EA\u52A8\u63D0\u70BC\u4E4B\u95F4\u7684\u6700\u5C0F\u95F4\u9694" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "memx-st-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "memx-st-inline", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                id: "memx-st-throttle",
                className: "memx-st-input",
                type: "number",
                inputMode: "numeric",
                min: THROTTLE_MIN,
                max: THROTTLE_MAX,
                step: 1,
                value: draft,
                disabled: !writable,
                "aria-invalid": throttleError ? "true" : void 0,
                onFocus: () => {
                  editing.current = true;
                },
                onChange: (event) => changeThrottle(event.target.value),
                onBlur: () => {
                  editing.current = false;
                  commitThrottle();
                },
                onKeyDown: (event) => {
                  if (event.key === "Enter") commitThrottle();
                }
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "memx-st-hint", children: [
              "\u5206\u949F\uFF08",
              THROTTLE_MIN,
              "\u2013",
              THROTTLE_MAX,
              "\uFF09"
            ] })
          ] }),
          throttleError ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "memx-st-error", children: throttleError }) : null
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "memx-st-notice", "data-kind": "info", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dl", { className: "memx-st-dl", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", { children: "\u6CE8\u5165" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", { children: "\u6BCF\u4E2A\u4F1A\u8BDD\u8BFB\u4E00\u6B21\uFF08\u4F1A\u8BDD\u5185\u5B57\u8282\u6052\u5B9A\uFF09\uFF1B\u672C\u4F1A\u8BDD\u65B0\u5199\u7684\u8BB0\u5FC6\uFF0C\u4E0B\u4E2A\u4F1A\u8BDD\u624D\u53EF\u89C1\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", { children: "\u5F53\u524D\u63D0\u70BC\u6A21\u578B" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", { children: selectedLabel }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", { children: "\u914D\u7F6E\u5F52\u5C5E" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dd", { children: [
        "DSH profile \u8865\u4E01\u6761\u76EE ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "memx" }),
        "\uFF08\u56DB\u4E2A\u5B57\u6BB5\u90FD\u6309 volatile \u70ED\u66F4\uFF0C\u6539\u5B8C\u5373\u65F6\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F\uFF09"
      ] })
    ] }) })
  ] });
}

// src/client/index.tsx
var name = "dsh-plugin-memx-client";
var inject = ["slots", "remote", "remote.session", "configForms"];
var SECTION_ID = "memx-memory";
var SECTION_ORDER = 60;
function apply(ctx) {
  const Section = createMemorySettings({
    // 取值函数：每次渲染现取，宿主还没下发设置项时返回 undefined（页面会显示状态并重试）。
    formFor: () => ctx.configForms.get(SETTINGS_ENTRY_ID),
    // 模型选项主来源（官方 llm-pi-ai 的配置 providers）；同样现取，缺失时页面降级。
    llmFormFor: () => ctx.configForms.get(LLM_SETTINGS_ENTRY_ID),
    loadCatalog: () => ctx.remote.session.modelCatalog()
  });
  ctx.slots.inject(
    "settings.section",
    () => ctx.slots.register(
      {
        name: "settings.section",
        id: SECTION_ID,
        order: SECTION_ORDER,
        label: () => "\u8BB0\u5FC6"
      },
      Section
    )
  );
}
		return module.exports;
	}
});
