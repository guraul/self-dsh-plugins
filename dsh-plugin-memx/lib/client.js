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
var THROTTLE_MIN = 1;
var THROTTLE_MAX = 1440;
var THROTTLE_COMMIT_DELAY_MS = 500;
function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  const message = error?.message;
  return typeof message === "string" && message ? message : String(error);
}
function isConflict(error) {
  const code = error?.code;
  return code === "SETTINGS_CONFLICT" || errorMessage(error).includes("SETTINGS_CONFLICT");
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
    ".memx-st-card{display:flex;flex-direction:column;gap:18px;padding:16px 18px;border-radius:12px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.24));background:var(--dsw-alias-fill-primary,transparent);}",
    ".memx-st-row{display:grid;grid-template-columns:minmax(120px,200px) minmax(0,1fr);gap:6px 20px;align-items:start;}",
    ".memx-st-label{font-size:13px;font-weight:600;line-height:28px;color:var(--dsw-alias-label-primary,inherit);}",
    ".memx-st-label small{display:block;font-weight:400;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#6b7280);}",
    ".memx-st-field{display:flex;flex-direction:column;gap:6px;min-width:0;}",
    ".memx-st-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
    ".memx-st-select,.memx-st-input{box-sizing:border-box;min-height:28px;padding:4px 8px;border-radius:8px;font-size:13px;color:inherit;background:var(--dsw-alias-fill-secondary,rgba(128,128,128,.06));border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.32));}",
    ".memx-st-select{min-width:0;max-width:100%;flex:1 1 260px;}",
    ".memx-st-input{width:110px;}",
    ".memx-st-select:focus-visible,.memx-st-input:focus-visible,.memx-st-check:focus-visible{outline:2px solid var(--dsw-alias-state-focus-ring,#4f7cf7);outline-offset:1px;}",
    ".memx-st-check{width:16px;height:16px;margin:6px 8px 0 0;accent-color:var(--dsw-alias-state-focus-ring,#4f7cf7);}",
    ".memx-st-hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b7280);}",
    ".memx-st-error{font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error,#d93025);}",
    ".memx-st-notice{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.6;}",
    '.memx-st-notice[data-kind="error"]{color:var(--dsw-alias-state-error,#d93025);background:color-mix(in srgb,var(--dsw-alias-state-error,#d93025) 10%,transparent);}',
    '.memx-st-notice[data-kind="info"]{color:var(--dsw-alias-label-secondary,#6b7280);background:var(--dsw-alias-fill-secondary,rgba(128,128,128,.08));}',
    ".memx-st-dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0;font-size:12px;line-height:1.6;}",
    ".memx-st-dl dt{color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap;}",
    ".memx-st-dl dd{margin:0;color:var(--dsw-alias-label-primary,inherit);word-break:break-word;}",
    ".memx-st-disabled{opacity:.6;}"
  ].join("");
  document.head.appendChild(style);
}
function createMemorySettings(options) {
  const { form, loadCatalog } = options;
  return function MemxMemorySettings(_props) {
    ensureStyles();
    const snapshot = (0, import_react.useSyncExternalStore)(
      (callback) => form.subscribe(callback),
      () => form.getSnapshot()
    );
    const value = snapshot.value ?? {};
    const writable = snapshot.writable !== false;
    const status = snapshot.status;
    const [notice, setNotice] = (0, import_react.useState)(null);
    const [catalog, setCatalog] = (0, import_react.useState)({ state: "loading", groups: [] });
    const alive = (0, import_react.useRef)(true);
    const reloadCatalog = (0, import_react.useCallback)(() => {
      setCatalog((current) => ({ state: "loading", groups: current.groups }));
      void loadCatalog().then((result) => {
        if (!alive.current) return;
        setCatalog({ state: "ready", groups: result?.groups ?? [] });
      }).catch((err) => {
        if (!alive.current) return;
        setCatalog({ state: "error", groups: [], error: errorMessage(err) });
      });
    }, [loadCatalog]);
    (0, import_react.useEffect)(() => {
      alive.current = true;
      reloadCatalog();
      return () => {
        alive.current = false;
      };
    }, [reloadCatalog]);
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
    const groups = catalog.groups;
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
    if (status === "loading") {
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "memx-st-hint", children: "\u6B63\u5728\u8BFB\u53D6 memx \u914D\u7F6E\u2026" });
    }
    if (status === "unavailable") {
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "memx-st-hint", children: "\u5F53\u524D\u5BBF\u4E3B\u6CA1\u6709\u66B4\u9732 memx \u7684\u914D\u7F6E\uFF08\u63D2\u4EF6\u672A\u542F\u7528\uFF0C\u6216 dsh \u8FD8\u6CA1\u91CD\u542F\u52A0\u8F7D\u65B0\u7248\u8584\u58F3\u5305\uFF09\u3002\u91CD\u542F dsh web \u540E\u518D\u770B\u8FD9\u4E00\u9875\u3002" });
    }
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "memx-st-page", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "memx-st-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { className: "memx-st-title", children: "\u8BB0\u5FC6" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "memx-st-sub", children: "memx \u957F\u671F\u8BB0\u5FC6\uFF1A\u6CE8\u5165\u3001\u81EA\u52A8\u63D0\u70BC\u4E0E\u63D0\u70BC\u6A21\u578B\u3002\u6539\u52A8\u5373\u65F6\u4FDD\u5B58\uFF0C\u6CA1\u6709\u4FDD\u5B58\u6309\u94AE\u3002" })
      ] }),
      notice && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "memx-st-notice", "data-kind": notice.kind, role: "status", children: notice.text }),
      !writable && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "memx-st-notice", "data-kind": "info", role: "status", children: "\u5F53\u524D\u90E8\u7F72\u7684\u8BBE\u7F6E\u6587\u6863\u662F\u53EA\u8BFB\u7684\uFF08writable = false\uFF09\uFF0C\u8FD9\u91CC\u7684\u6539\u52A8\u4E0D\u4F1A\u843D\u76D8\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `memx-st-card${writable ? "" : " memx-st-disabled"}`, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "memx-st-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "memx-st-label", htmlFor: "memx-st-model", children: [
            "\u63D0\u70BC\u6A21\u578B",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("small", { children: "\u8F6E\u672B\u81EA\u52A8\u63D0\u70BC\u7528\uFF1B\u663E\u5F0F memory_write \u4E0D\u53D7\u5F71\u54CD" })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "memx-st-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "memx-st-inline", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
                "select",
                {
                  id: "memx-st-model",
                  className: "memx-st-select",
                  "aria-label": "\u63D0\u70BC\u6A21\u578B",
                  value: selected,
                  disabled: !writable || catalog.state === "loading",
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
                  className: "memx-st-input",
                  style: { width: "auto", cursor: "pointer" },
                  onClick: reloadCatalog,
                  disabled: catalog.state === "loading",
                  title: "\u91CD\u65B0\u8BFB\u53D6\u6A21\u578B\u76EE\u5F55",
                  children: catalog.state === "loading" ? "\u8BFB\u53D6\u4E2D\u2026" : "\u5237\u65B0\u76EE\u5F55"
                }
              )
            ] }),
            catalog.state === "error" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "memx-st-error", children: [
              "\u6A21\u578B\u76EE\u5F55\u8BFB\u53D6\u5931\u8D25\uFF1A",
              catalog.error
            ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "memx-st-hint", children: "\u9009\u9879\u6309 provider \u5206\u7EC4\uFF1B\u7A7A = \u8DDF\u968F\u5F53\u524D\u4F1A\u8BDD\uFF08\u7528\u4F1A\u8BDD\u81EA\u5DF1\u7684\u6A21\u578B\uFF09\u3002" })
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
  };
}

// src/client/index.tsx
var name = "dsh-plugin-memx-client";
var inject = ["slots", "remote", "configForms"];
var SETTINGS_ENTRY_ID = "memx";
var SECTION_ID = "memx-memory";
var SECTION_ORDER = 60;
function apply(ctx) {
  const form = ctx.configForms.get(SETTINGS_ENTRY_ID);
  const Section = createMemorySettings({
    form,
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
