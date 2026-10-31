// src/shared/contract.ts
var RPC_OVERVIEW = "usage-stats/overview";
var RPC_PATH = "/api/usage-stats/overview";
var RPC_SUBAGENTS = "usage-stats/subagents";
var RPC_SUBAGENTS_PATH = "/api/usage-stats/subagents";

// src/shared/usage.ts
var HEAT_DAYS = 182;
var RECENT_DAYS = 30;
function emptyBuckets() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
function emptyTotals() {
  return { ...emptyBuckets(), total: 0 };
}
function totalsFrom(b) {
  return { ...b, total: b.input + b.output + b.cacheRead + b.cacheWrite };
}
function sortedModels(map) {
  return Object.keys(map).map((model) => {
    const b = map[model];
    return { model, ...b, total: b.input + b.output + b.cacheRead + b.cacheWrite };
  }).sort((a, b) => b.total - a.total);
}
function totalsFromModels(models) {
  const totals2 = emptyTotals();
  for (const item of models) {
    totals2.input += item.input;
    totals2.output += item.output;
    totals2.cacheRead += item.cacheRead;
    totals2.cacheWrite += item.cacheWrite;
    totals2.total += item.total;
  }
  return totals2;
}
function dayKeyUTC(ts) {
  const d = new Date(ts);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
function parseDayKeyUTC(key) {
  const p = key.split("-");
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
}
function keyOfDateUTC(d) {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
function todayKeyUTC(now) {
  return dayKeyUTC(now);
}
function buildDayWindow(byDay, now) {
  const days = [];
  const today = todayKeyUTC(now);
  const todayDate = parseDayKeyUTC(today);
  for (let i = HEAT_DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(todayDate.getUTCFullYear(), todayDate.getUTCMonth(), todayDate.getUTCDate() - i));
    const key = keyOfDateUTC(d);
    const record2 = byDay[key];
    const models = {};
    let total = 0;
    if (record2) {
      for (const model of Object.keys(record2)) {
        const b = record2[model];
        models[model] = totalsFrom(b);
        total += models[model].total;
      }
    }
    days.push({ date: key, total, models });
  }
  return days;
}

// src/host/projection.ts
import { z } from "zod";
var bucketSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number()
});
var stepSchema = z.object({
  buckets: bucketSchema,
  lastTime: z.number(),
  model: z.string(),
  provider: z.string(),
  mode: z.enum(["provisional", "authoritative"])
});
var epochSchema = z.object({
  totals: bucketSchema,
  byModel: z.record(z.string(), bucketSchema),
  byDay: z.record(z.string(), z.record(z.string(), bucketSchema)),
  byProvider: z.record(z.string(), bucketSchema),
  retries: z.number(),
  compactionTokens: z.number(),
  firstTime: z.number().nullable(),
  lastTime: z.number().nullable(),
  // Seq of the session/end-seed marker that closed this epoch; null = open.
  end: z.number().nullable()
});
var usagePanelSchema = z.object({
  // Closed epochs in marker order, then the still-open accumulator.
  epochs: z.array(epochSchema),
  current: epochSchema,
  // Caller-preset seed boundary (scan path only; see header comment).
  seedEnd: z.number().nullable(),
  currentModel: z.string(),
  currentProvider: z.string(),
  openStep: z.string().nullable(),
  steps: z.record(z.string(), stepSchema)
});
var USAGE_PANEL_KEY = "usagePanel";
var EMPTY = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
function emptyEpoch() {
  return {
    totals: { ...EMPTY },
    byModel: {},
    byDay: {},
    byProvider: {},
    retries: 0,
    compactionTokens: 0,
    firstTime: null,
    lastTime: null,
    end: null
  };
}
function initState() {
  return {
    epochs: [],
    current: emptyEpoch(),
    seedEnd: null,
    currentModel: "unknown",
    currentProvider: "unknown",
    openStep: null,
    steps: {}
  };
}
function stepKey(turn, step) {
  return turn + ":" + step;
}
function add(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite
  };
}
function addInto(map, key, b) {
  const cur = map[key];
  return { ...map, [key]: cur ? add(cur, b) : { ...b } };
}
function addIntoDay(byDay, day, model, b) {
  const dayMap = byDay[day];
  return { ...byDay, [day]: dayMap ? addInto(dayMap, model, b) : { [model]: { ...b } } };
}
function isCounted(state, event) {
  return state.seedEnd === null || event.seq >= state.seedEnd;
}
function absorbUsage(ep, b, model, provider, time2) {
  const day = dayKeyUTC(time2);
  return {
    ...ep,
    totals: add(ep.totals, b),
    byModel: addInto(ep.byModel, model, b),
    byDay: addIntoDay(ep.byDay, day, model, b),
    byProvider: addInto(ep.byProvider, provider, b),
    firstTime: ep.firstTime === null ? time2 : Math.min(ep.firstTime, time2),
    lastTime: ep.lastTime === null ? time2 : Math.max(ep.lastTime, time2)
  };
}
function commitStep(state, key) {
  const step = state.steps[key];
  if (!step) return state;
  const steps = { ...state.steps };
  delete steps[key];
  const openStep = state.openStep === key ? null : state.openStep;
  const b = step.buckets;
  if (b.input === 0 && b.output === 0 && b.cacheRead === 0 && b.cacheWrite === 0) {
    return { ...state, steps, openStep };
  }
  return {
    ...state,
    current: absorbUsage(state.current, b, step.model, step.provider, step.lastTime),
    steps,
    openStep
  };
}
function commitOpenStep(state, incomingKey) {
  if (state.openStep !== null && state.openStep !== incomingKey) {
    return commitStep(state, state.openStep);
  }
  return state;
}
function applyEvent(state, event) {
  if (event.type === "assistant/chunk") {
    if (!isCounted(state, event)) return state;
    const data = event.data;
    const chunk = data.chunk;
    if (!chunk || chunk.type !== "usage" || !chunk.usage) return state;
    const key = stepKey(data.turn, data.step);
    const usage = chunk.usage;
    const b = {
      input: Number(usage.inputTokens) || 0,
      output: Number(usage.outputTokens) || 0,
      cacheRead: Number(usage.cacheReadTokens) || 0,
      cacheWrite: Number(usage.cacheWriteTokens) || 0
    };
    let next = commitOpenStep(state, key);
    const existing = next.steps[key];
    const step = existing ? { ...existing, buckets: add(existing.buckets, b), lastTime: event.time } : {
      buckets: b,
      lastTime: event.time,
      model: next.currentModel,
      provider: next.currentProvider,
      mode: "provisional"
    };
    return {
      ...next,
      steps: { ...next.steps, [key]: step },
      openStep: key
    };
  }
  switch (event.type) {
    case "session/end-seed": {
      const flushed = state.openStep !== null ? commitStep(state, state.openStep) : state;
      return {
        ...flushed,
        epochs: [...flushed.epochs, { ...flushed.current, end: event.seq }],
        current: emptyEpoch()
      };
    }
    case "request/context": {
      const { model, provider } = event.data;
      if (!model && !provider) return state;
      return {
        ...state,
        currentModel: model || state.currentModel,
        currentProvider: provider || state.currentProvider
      };
    }
    case "request/header": {
      const cfg = event.data.header && event.data.header.config;
      if (!cfg || !cfg.model && !cfg.provider) return state;
      return {
        ...state,
        currentModel: cfg.model || state.currentModel,
        currentProvider: cfg.provider || state.currentProvider
      };
    }
    case "assistant/attempt": {
      if (!isCounted(state, event)) return state;
      let b = null;
      for (const rec of event.data.stream ?? []) {
        if (rec.type !== "chunk" || rec.chunk.type !== "usage" || !rec.chunk.usage) continue;
        const u = rec.chunk.usage;
        const uu = {
          input: Number(u.inputTokens) || 0,
          output: Number(u.outputTokens) || 0,
          cacheRead: Number(u.cacheReadTokens) || 0,
          cacheWrite: Number(u.cacheWriteTokens) || 0
        };
        b = b ? add(b, uu) : uu;
      }
      if (!b) return state;
      return { ...state, current: absorbUsage(state.current, b, state.currentModel, state.currentProvider, event.time) };
    }
    case "assistant/message": {
      if (!isCounted(state, event)) return state;
      const usage = event.data.usage;
      if (!usage) return state;
      const key = stepKey(event.data.turn, event.data.step);
      const b = {
        input: Number(usage.inputTokens) || 0,
        output: Number(usage.outputTokens) || 0,
        cacheRead: Number(usage.cacheReadTokens) || 0,
        cacheWrite: Number(usage.cacheWriteTokens) || 0
      };
      let next = commitOpenStep(state, key);
      const step = {
        buckets: b,
        lastTime: event.time,
        model: next.currentModel,
        provider: next.currentProvider,
        mode: "authoritative"
      };
      return {
        ...next,
        steps: { ...next.steps, [key]: step },
        openStep: key
      };
    }
    case "step/end": {
      const key = stepKey(event.data.turn, event.data.step);
      return commitStep(state, key);
    }
    case "turn/end": {
      return state.openStep !== null ? commitStep(state, state.openStep) : state;
    }
    case "llm/retry": {
      if (!isCounted(state, event)) return state;
      const cur = state.current;
      return {
        ...state,
        current: {
          ...cur,
          retries: cur.retries + 1,
          firstTime: cur.firstTime === null ? event.time : Math.min(cur.firstTime, event.time),
          lastTime: cur.lastTime === null ? event.time : Math.max(cur.lastTime, event.time)
        }
      };
    }
    case "compaction/summary": {
      if (!isCounted(state, event)) return state;
      const usage = event.data.usage;
      if (!usage) return state;
      const b = {
        input: Number(usage.inputTokens) || 0,
        output: Number(usage.outputTokens) || 0,
        cacheRead: Number(usage.cacheReadTokens) || 0,
        cacheWrite: Number(usage.cacheWriteTokens) || 0
      };
      const model = event.data.model || state.currentModel;
      const provider = event.data.provider || state.currentProvider;
      const absorbed = absorbUsage(state.current, b, model, provider, event.time);
      return {
        ...state,
        current: { ...absorbed, compactionTokens: absorbed.compactionTokens + b.input + b.output + b.cacheRead + b.cacheWrite }
      };
    }
    default:
      return state;
  }
}
function selectEpochs(value, seedLength) {
  return [...value.epochs, value.current].filter((e) => e.end === null || e.end > seedLength);
}
function flattenEpochs(epochs) {
  const out = emptyEpoch();
  for (const ep of epochs) {
    out.totals = add(out.totals, ep.totals);
    out.retries += ep.retries;
    out.compactionTokens += ep.compactionTokens;
    if (ep.firstTime !== null) out.firstTime = out.firstTime === null ? ep.firstTime : Math.min(out.firstTime, ep.firstTime);
    if (ep.lastTime !== null) out.lastTime = out.lastTime === null ? ep.lastTime : Math.max(out.lastTime, ep.lastTime);
    for (const model of Object.keys(ep.byModel)) out.byModel = addInto(out.byModel, model, ep.byModel[model]);
    for (const provider of Object.keys(ep.byProvider)) out.byProvider = addInto(out.byProvider, provider, ep.byProvider[provider]);
    for (const day of Object.keys(ep.byDay)) {
      for (const model of Object.keys(ep.byDay[day])) out.byDay = addIntoDay(out.byDay, day, model, ep.byDay[day][model]);
    }
  }
  return out;
}
function recentOf(epochs, cutoffKey) {
  const totals2 = { ...EMPTY };
  const byModel = {};
  for (const ep of epochs) {
    for (const day of Object.keys(ep.byDay)) {
      if (day < cutoffKey) continue;
      for (const model of Object.keys(ep.byDay[day])) {
        const b = ep.byDay[day][model];
        totals2.input += b.input;
        totals2.output += b.output;
        totals2.cacheRead += b.cacheRead;
        totals2.cacheWrite += b.cacheWrite;
        const cur = byModel[model];
        byModel[model] = cur ? {
          input: cur.input + b.input,
          output: cur.output + b.output,
          cacheRead: cur.cacheRead + b.cacheRead,
          cacheWrite: cur.cacheWrite + b.cacheWrite
        } : { ...b };
      }
    }
  }
  return { totals: totals2, byModel };
}

// src/host/aggregate.ts
function emptyAggregate() {
  return {
    allTimeTotals: emptyTotals(),
    allTimeByModel: {},
    allTimeByProvider: {},
    byDay: {},
    recentTotals: emptyTotals(),
    recentByModel: {},
    recentSessionCount: 0,
    allTimeSessionCount: 0,
    retries: 0,
    compactionTokens: 0,
    from: null,
    to: null,
    usageSessionsMain: 0,
    usageSessionsSubagent: 0,
    sessions: []
  };
}
function mergeSessionValue(a, value, sessionId, now, depth = 0, inheritedEventCount = 0, archived = false) {
  const cutoffKey = dayKeyUTC(now - RECENT_DAYS * 24 * 3600 * 1e3);
  const epochs = selectEpochs(value, inheritedEventCount);
  const flat = flattenEpochs(epochs);
  const recent = recentOf(epochs, cutoffKey);
  const totals2 = totalsFrom(flat.totals);
  const next = {
    ...a,
    allTimeTotals: {
      input: a.allTimeTotals.input + totals2.input,
      output: a.allTimeTotals.output + totals2.output,
      cacheRead: a.allTimeTotals.cacheRead + totals2.cacheRead,
      cacheWrite: a.allTimeTotals.cacheWrite + totals2.cacheWrite,
      total: a.allTimeTotals.total + totals2.total
    },
    recentTotals: {
      input: a.recentTotals.input + recent.totals.input,
      output: a.recentTotals.output + recent.totals.output,
      cacheRead: a.recentTotals.cacheRead + recent.totals.cacheRead,
      cacheWrite: a.recentTotals.cacheWrite + recent.totals.cacheWrite,
      total: a.recentTotals.total + recent.totals.input + recent.totals.output + recent.totals.cacheRead + recent.totals.cacheWrite
    },
    retries: a.retries + flat.retries,
    compactionTokens: a.compactionTokens + flat.compactionTokens,
    from: a.from === null ? flat.firstTime : flat.firstTime === null ? a.from : Math.min(a.from, flat.firstTime),
    to: a.to === null ? flat.lastTime : flat.lastTime === null ? a.to : Math.max(a.to, flat.lastTime)
  };
  for (const model of Object.keys(flat.byModel)) {
    const b = flat.byModel[model];
    const cur = next.allTimeByModel[model];
    next.allTimeByModel[model] = cur ? mergeB(cur, b) : { ...b };
  }
  for (const provider of Object.keys(flat.byProvider)) {
    const b = flat.byProvider[provider];
    const cur = next.allTimeByProvider[provider];
    next.allTimeByProvider[provider] = cur ? mergeB(cur, b) : { ...b };
  }
  for (const day of Object.keys(flat.byDay)) {
    const dayMap = flat.byDay[day];
    const target = next.byDay[day] || (next.byDay[day] = {});
    for (const model of Object.keys(dayMap)) {
      const b = dayMap[model];
      const cur = target[model];
      target[model] = cur ? mergeB(cur, b) : { ...b };
    }
  }
  for (const model of Object.keys(recent.byModel)) {
    const b = recent.byModel[model];
    const cur = next.recentByModel[model];
    next.recentByModel[model] = cur ? mergeB(cur, b) : { ...b };
  }
  const countsAsMain = depth === 0 && !archived;
  const hasRecentUsage = recent.totals.input + recent.totals.output + recent.totals.cacheRead + recent.totals.cacheWrite > 0;
  if (countsAsMain) next.allTimeSessionCount += 1;
  if (hasRecentUsage && countsAsMain) {
    next.recentSessionCount += 1;
  }
  if (totals2.total > 0) {
    if (depth > 0) next.usageSessionsSubagent += 1;
    else if (countsAsMain) next.usageSessionsMain += 1;
    next.sessions.push({ id: sessionId, totals: totals2, lastActive: flat.lastTime ?? 0, depth });
  }
  return next;
}
function mergeB(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite
  };
}
function rankSessions(sessions, limit) {
  return [...sessions].sort((a, b) => b.totals.total - a.totals.total).slice(0, limit);
}
function finalizeOverview(input) {
  const { aggregate: a, now, mode, sessionsTotal, sessionsOk, sessionsFailed, sessionsPending, eventsCounted, titles, providerNames } = input;
  const recentByModel = sortedModels(a.recentByModel);
  const allTimeByModel = sortedModels(a.allTimeByModel);
  const providerRows = Object.keys(a.allTimeByProvider).map((id) => {
    const b = a.allTimeByProvider[id];
    return { id, name: providerNames[id] || id, totals: totalsFrom(b) };
  }).sort((x, y) => y.totals.total - x.totals.total);
  const top = rankSessions(a.sessions, 10);
  const topSessions = top.map((s) => ({
    id: s.id,
    title: titles.has(s.id) ? titles.get(s.id) : null,
    totals: s.totals,
    lastActive: s.lastActive,
    depth: s.depth
  }));
  const coverage = {
    mode,
    timezone: "UTC",
    sessionsTotal,
    sessionsOk,
    sessionsFailed,
    sessionsPending,
    eventsCounted,
    retries: a.retries,
    compactionTokens: a.compactionTokens,
    from: a.from,
    to: a.to,
    usageSessionsMain: a.usageSessionsMain,
    usageSessionsSubagent: a.usageSessionsSubagent
  };
  return {
    days: buildDayWindow(a.byDay, now),
    totals: totalsFromModels(recentByModel),
    sessionCount: a.recentSessionCount,
    byModel: recentByModel,
    allTime: {
      totals: totalsFromModels(allTimeByModel),
      sessionCount: a.allTimeSessionCount,
      byModel: allTimeByModel
    },
    coverage,
    topSessions,
    providers: providerRows,
    updatedAt: now
  };
}
function emptyOverview(now) {
  return finalizeOverview({
    aggregate: emptyAggregate(),
    now,
    mode: "none",
    sessionsTotal: 0,
    sessionsOk: 0,
    sessionsFailed: 0,
    sessionsPending: 0,
    eventsCounted: 0,
    titles: /* @__PURE__ */ new Map(),
    providerNames: {}
  });
}

// src/host/external/collect.ts
import { readFile as readFile2, stat } from "node:fs/promises";
import os4 from "node:os";
import path4 from "node:path";

// src/host/external/codebuddy.ts
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
function cwdSlug(cwd) {
  return cwd.replace(/\\/g, "/").replace(/\//g, "-").replace(/^-+/, "");
}
function defaultCodebuddyProjectsDir() {
  return path.join(os.homedir(), ".codebuddy", "projects");
}
function codebuddyTranscriptPath(projectsDir, cwd, remoteId) {
  return path.join(projectsDir, cwdSlug(cwd), remoteId + ".jsonl");
}
function messageOf(err) {
  return String(err?.message ?? err);
}
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function time(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function firstNumber(...values) {
  for (const value of values) {
    const n = toNumber(value);
    if (n !== null) return n;
  }
  return null;
}
function dominantModel(models) {
  let best = null;
  let bestCount = 0;
  for (const [model, count] of models) {
    if (count > bestCount) {
      best = model;
      bestCount = count;
    }
  }
  return best;
}
function objectOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
async function readCodebuddySession(remoteId, cwd, options = {}) {
  const errors = [];
  if (!remoteId) return { hit: null, errors };
  if (!cwd) {
    errors.push("codebuddy: no cwd for remote " + remoteId + " (cannot locate transcript)");
    return { hit: null, errors };
  }
  const projectsDir = options.projectsDir ?? defaultCodebuddyProjectsDir();
  const filePath = codebuddyTranscriptPath(projectsDir, cwd, remoteId);
  try {
    await access(filePath);
  } catch {
    return { hit: null, errors };
  }
  const agg = {
    models: /* @__PURE__ */ new Map(),
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    calls: 0,
    credit: 0,
    hasCredit: false,
    startedAt: null,
    endedAt: null
  };
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record2;
      try {
        record2 = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record2 || typeof record2 !== "object" || Array.isArray(record2)) continue;
      const row = record2;
      if (row.type !== "message" || row.role !== "assistant") continue;
      const providerData = row.providerData;
      if (!providerData || typeof providerData !== "object" || Array.isArray(providerData)) continue;
      const pd = providerData;
      const usage = pd.usage;
      if (!usage || typeof usage !== "object" || Array.isArray(usage)) continue;
      const buckets = usage;
      const rawUsage = objectOf(pd.rawUsage);
      const details = Array.isArray(buckets.inputTokensDetails) ? objectOf(buckets.inputTokensDetails[0]) : null;
      const promptTotal = num(buckets.inputTokens);
      const cacheRead = firstNumber(rawUsage?.prompt_cache_hit_tokens, objectOf(rawUsage?.prompt_tokens_details)?.cached_tokens, details?.cached_tokens) ?? 0;
      const cacheMiss = firstNumber(rawUsage?.prompt_cache_miss_tokens);
      const uncachedInput = cacheMiss !== null ? cacheMiss : Math.max(0, promptTotal - cacheRead);
      agg.input += uncachedInput;
      agg.cacheRead += cacheRead;
      agg.cacheWrite += firstNumber(rawUsage?.prompt_cache_write_tokens) ?? 0;
      agg.output += num(buckets.outputTokens);
      if (typeof pd.model === "string" && pd.model) {
        agg.models.set(pd.model, (agg.models.get(pd.model) ?? 0) + 1);
      }
      if (rawUsage) {
        const credit = rawUsage.credit;
        const value = Number(credit);
        if (credit !== void 0 && credit !== null && Number.isFinite(value)) {
          agg.credit += value;
          agg.hasCredit = true;
        }
      }
      const ts = time(row.timestamp);
      if (ts !== null) {
        agg.startedAt = agg.startedAt === null ? ts : Math.min(agg.startedAt, ts);
        agg.endedAt = agg.endedAt === null ? ts : Math.max(agg.endedAt, ts);
      }
      agg.calls += 1;
    }
  } catch (err) {
    errors.push("codebuddy: read " + filePath + ": " + messageOf(err));
  } finally {
    lines.close();
    stream.destroy();
  }
  if (agg.calls === 0 || agg.startedAt === null) return { hit: null, errors };
  const totals2 = {
    input: agg.input,
    output: agg.output,
    cacheRead: agg.cacheRead,
    cacheWrite: agg.cacheWrite,
    total: agg.input + agg.output + agg.cacheRead + agg.cacheWrite
  };
  const hit = {
    executor: "codebuddy",
    remoteId,
    model: dominantModel(agg.models),
    totals: totals2,
    calls: agg.calls,
    startedAt: agg.startedAt,
    endedAt: agg.endedAt,
    source: "codebuddy-jsonl"
  };
  if (agg.hasCredit) hit.credit = agg.credit;
  return { hit, errors };
}

// src/host/external/opencode.ts
import { readdir } from "node:fs/promises";
import os2 from "node:os";
import path2 from "node:path";
import { DatabaseSync } from "node:sqlite";
var COLUMNS = "id, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, time_created, time_updated";
function messageOf2(err) {
  return String(err?.message ?? err);
}
function num2(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function timeOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function totalsOf(input, output, cacheRead, cacheWrite) {
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
function parseOpencodeModel(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const id = parsed.id;
        if (typeof id === "string" && id) return id;
        return null;
      }
    } catch {
    }
  }
  return text;
}
async function defaultOpencodeDbPaths() {
  const home = os2.homedir();
  const paths = [path2.join(home, ".local", "share", "opencode", "opencode.db")];
  const backupsDir = path2.join(home, "backups");
  try {
    const entries = await readdir(backupsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("opencode-sessions-")) continue;
      paths.push(path2.join(backupsDir, entry.name, "opencode.db"));
    }
  } catch {
  }
  return paths;
}
function queryRows(db, table, ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const statement = db.prepare("SELECT " + COLUMNS + " FROM " + table + " WHERE id IN (" + placeholders + ")");
  const rows = statement.all(...ids);
  return rows;
}
function isMissingTable(err) {
  return /no such table/i.test(messageOf2(err));
}
function countCalls(db, table, id) {
  if (table === "session_v2") {
    try {
      const row = db.prepare("SELECT count(*) AS c FROM session_message WHERE session_id = ? AND type = 'assistant'").get(id);
      return num2(row?.c);
    } catch {
    }
  }
  try {
    const row = db.prepare("SELECT count(*) AS c FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'").get(id);
    return num2(row?.c);
  } catch {
    return 1;
  }
}
function toExternal(db, table, row) {
  const remoteId = typeof row.id === "string" ? row.id : "";
  if (!remoteId) return null;
  const input = num2(row.tokens_input);
  const output = num2(row.tokens_output);
  const cacheRead = num2(row.tokens_cache_read);
  const cacheWrite = num2(row.tokens_cache_write);
  const startedAt = timeOrNull(row.time_created);
  if (startedAt === null) return null;
  return {
    executor: "opencode",
    remoteId,
    model: parseOpencodeModel(row.model),
    totals: totalsOf(input, output, cacheRead, cacheWrite),
    calls: countCalls(db, table, remoteId),
    startedAt,
    endedAt: timeOrNull(row.time_updated),
    source: "opencode-db"
  };
}
async function readOpencodeSessions(remoteIds, options = {}) {
  const hits = /* @__PURE__ */ new Map();
  const errors = [];
  const wanted = [...new Set(remoteIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (wanted.length === 0) return { hits, errors };
  const dbPaths = options.dbPaths ?? await defaultOpencodeDbPaths();
  for (const dbPath of dbPaths) {
    const pending = wanted.filter((id) => !hits.has(id));
    if (pending.length === 0) break;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch (err) {
      errors.push("opencode: cannot open " + dbPath + ": " + messageOf2(err));
      continue;
    }
    try {
      for (const table of ["session_v2", "session"]) {
        const ids = table === "session_v2" ? pending : wanted.filter((id) => !hits.has(id));
        if (ids.length === 0) continue;
        let rows;
        try {
          rows = queryRows(db, table, ids);
        } catch (err) {
          if (!isMissingTable(err)) errors.push("opencode: query " + table + " in " + dbPath + ": " + messageOf2(err));
          continue;
        }
        for (const row of rows) {
          const external = toExternal(db, table, row);
          if (external && !hits.has(external.remoteId)) hits.set(external.remoteId, external);
        }
      }
    } catch (err) {
      errors.push("opencode: scan " + dbPath + ": " + messageOf2(err));
    } finally {
      try {
        db.close();
      } catch {
      }
    }
  }
  return { hits, errors };
}

// src/host/external/registry.ts
import { readFile } from "node:fs/promises";
import os3 from "node:os";
import path3 from "node:path";
function normalizeSessionId(id) {
  return String(id ?? "").replace(/^session-/, "");
}
function defaultRegistryPath() {
  const home = process.env.DSH_HOME || path3.join(os3.homedir(), ".dsh");
  return path3.join(home, "product-subagents-registry.json");
}
function messageOf3(err) {
  return String(err?.message ?? err);
}
async function loadRegistry(filePath = defaultRegistryPath()) {
  const errors = [];
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    errors.push("registry: cannot read " + filePath + ": " + messageOf3(err));
    return { entries: /* @__PURE__ */ new Map(), errors };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    errors.push("registry: invalid JSON in " + filePath + ": " + messageOf3(err));
    return { entries: /* @__PURE__ */ new Map(), errors };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push("registry: root is not an object in " + filePath);
    return { entries: /* @__PURE__ */ new Map(), errors };
  }
  const entries = /* @__PURE__ */ new Map();
  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record2 = value;
    const remoteId = typeof record2.remoteId === "string" ? record2.remoteId.trim() : "";
    if (!remoteId) continue;
    const id = normalizeSessionId(key);
    if (!id) continue;
    entries.set(id, {
      product: typeof record2.product === "string" && record2.product ? record2.product : "unknown",
      remoteId,
      cwd: typeof record2.cwd === "string" ? record2.cwd : "",
      updatedAt: typeof record2.updatedAt === "number" && Number.isFinite(record2.updatedAt) ? record2.updatedAt : 0
    });
  }
  return { entries, errors };
}

// src/host/external/collect.ts
var CACHE_TTL_MS = 6e4;
var LABEL_MAX = 80;
var PROJ_CONCURRENCY = 16;
var TITLE_CONCURRENCY = 8;
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: width }, async () => {
    for (; ; ) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
var cache = null;
function defaultProjCacheDir() {
  const home = process.env.DSH_HOME || path4.join(os4.homedir(), ".dsh");
  return path4.join(home, "storages", "session_projcache", "sessions");
}
function num3(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function timeOrNull2(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function totals(input, output, cacheRead, cacheWrite) {
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
function executorOf(product) {
  if (product === "opencode" || product === "codebuddy" || product === "acp") return product;
  return "unknown";
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
async function readProjCache(dir, sessionId) {
  const filePath = path4.join(dir, sessionId + ".json");
  let raw;
  try {
    raw = await readFile2(filePath, "utf8");
  } catch {
    return null;
  }
  let root;
  try {
    root = record(JSON.parse(raw));
  } catch {
    return null;
  }
  const rows = record(record(root?.record)?.rows);
  if (!rows) return null;
  const subagent = record(record(rows.subagent)?.val);
  const identity = record(subagent?.identity);
  const identityLabel = typeof identity?.label === "string" && identity.label ? identity.label : null;
  const legacyLabel = typeof subagent?.label === "string" && subagent.label ? subagent.label : null;
  const label = identityLabel ?? legacyLabel;
  let model = null;
  let relay = emptyTotals();
  let firstTime = null;
  let lastTime = null;
  const usagePanel = record(record(rows.usagePanel)?.val);
  const current = record(usagePanel?.current);
  if (current) {
    const currentTotals = record(current.totals);
    if (currentTotals) {
      const b = {
        input: num3(currentTotals.input),
        output: num3(currentTotals.output),
        cacheRead: num3(currentTotals.cacheRead),
        cacheWrite: num3(currentTotals.cacheWrite)
      };
      relay = { ...b, total: b.input + b.output + b.cacheRead + b.cacheWrite };
    }
    firstTime = timeOrNull2(current.firstTime);
    lastTime = timeOrNull2(current.lastTime);
    if (typeof usagePanel?.currentModel === "string" && usagePanel.currentModel) model = usagePanel.currentModel;
  }
  if (model === null) {
    const lastUsed = record(record(record(rows.modelSelection)?.val)?.lastUsed);
    if (lastUsed && typeof lastUsed.model === "string" && lastUsed.model) model = lastUsed.model;
  }
  if (relay.total === 0) {
    const tu = record(record(record(rows.tokenUsage)?.val)?.totals);
    if (tu) {
      relay = totals(
        num3(tu.uncachedInputTokens),
        num3(tu.outputTokens),
        num3(tu.cacheReadTokens),
        num3(tu.cacheWriteTokens)
      );
    }
  }
  return { label, model, totals: relay, firstTime, lastTime };
}
async function titleLabel(sq, sessionId) {
  try {
    const snapshot = await sq.readTitle(sessionId);
    const title = snapshot && typeof snapshot.title === "string" ? snapshot.title : "";
    return title ? title.slice(0, LABEL_MAX) : null;
  } catch {
    return null;
  }
}
async function signaturePart(filePath) {
  try {
    const info = await stat(filePath);
    return filePath + ":" + info.mtimeMs + ":" + info.size;
  } catch {
    return filePath + ":-";
  }
}
function codebuddyKey(cwd, remoteId) {
  return cwd + "\0" + remoteId;
}
async function collectSubagents(deps) {
  const now = deps.now ?? Date.now();
  const ttl = deps.ttlMs ?? CACHE_TTL_MS;
  const registryPath = deps.registryPath ?? defaultRegistryPath();
  const projCacheDir = deps.projCacheDir ?? defaultProjCacheDir();
  const codebuddyProjectsDir = deps.codebuddyProjectsDir ?? defaultCodebuddyProjectsDir();
  const dbPaths = deps.opencodeDbPaths ?? await defaultOpencodeDbPaths();
  const signature = (await Promise.all([
    signaturePart(registryPath),
    signaturePart(projCacheDir),
    signaturePart(codebuddyProjectsDir),
    ...dbPaths.map((dbPath) => signaturePart(dbPath))
  ])).join("|");
  if (cache && cache.key === signature && now - cache.at < ttl) return cache.payload;
  const scanStart = Date.now();
  const sessions = await deps.sq.listSessions();
  const { entries, errors: registryErrors } = await loadRegistry(registryPath);
  const errors = [...registryErrors];
  const subagents = sessions.filter((rec) => Number(rec?.header?.delegationDepth) > 0);
  const sessionIds = subagents.map((rec) => String(rec.header.id));
  const registryOf = (sessionId) => entries.get(normalizeSessionId(sessionId));
  const opencodeIds = [];
  const codebuddyTasks = /* @__PURE__ */ new Map();
  for (const rec of subagents) {
    const entry = registryOf(String(rec.header.id));
    if (!entry) continue;
    if (entry.product === "opencode" || entry.product === "acp") opencodeIds.push(entry.remoteId);
    if (entry.product === "codebuddy") {
      const key = codebuddyKey(entry.cwd, entry.remoteId);
      if (!codebuddyTasks.has(key)) {
        codebuddyTasks.set(key, readCodebuddySession(entry.remoteId, entry.cwd, { projectsDir: codebuddyProjectsDir }));
      }
    }
  }
  const codebuddyEntries = [...codebuddyTasks.entries()];
  const [opencode, codebuddyResults, projCaches] = await Promise.all([
    readOpencodeSessions(opencodeIds, { dbPaths }),
    Promise.all(codebuddyEntries.map(async ([key, pending]) => [key, await pending])),
    mapLimit(sessionIds, PROJ_CONCURRENCY, (sessionId) => readProjCache(projCacheDir, normalizeSessionId(sessionId)))
  ]);
  errors.push(...opencode.errors);
  const codebuddyHits = /* @__PURE__ */ new Map();
  for (const [key, result] of codebuddyResults) {
    errors.push(...result.errors);
    if (result.hit) codebuddyHits.set(key, result.hit);
  }
  function externalOf(entry) {
    if (!entry) return null;
    if (entry.product === "opencode" || entry.product === "acp") {
      const hit = opencode.hits.get(entry.remoteId);
      return hit ? { ...hit, executor: executorOf(entry.product) } : null;
    }
    if (entry.product === "codebuddy") {
      return codebuddyHits.get(codebuddyKey(entry.cwd, entry.remoteId)) ?? null;
    }
    return null;
  }
  const labels = projCaches.map((proj) => proj?.label ?? null);
  const needTitle = [];
  for (let index = 0; index < labels.length; index += 1) {
    if (!labels[index]) needTitle.push(index);
  }
  await mapLimit(needTitle, TITLE_CONCURRENCY, async (index) => {
    labels[index] = await titleLabel(deps.sq, sessionIds[index]);
  });
  const items = [];
  for (let index = 0; index < subagents.length; index += 1) {
    const header = subagents[index].header;
    const sessionId = sessionIds[index];
    const entry = registryOf(sessionId);
    const proj = projCaches[index] ?? null;
    const label = labels[index] ?? null;
    const external = externalOf(entry);
    const startCandidates = [];
    if (timeOrNull2(header.createdAt) !== null) startCandidates.push(Number(header.createdAt));
    if (proj?.firstTime !== null && proj?.firstTime !== void 0) startCandidates.push(proj.firstTime);
    if (external) startCandidates.push(external.startedAt);
    const startedAt = startCandidates.length > 0 ? Math.min(...startCandidates) : null;
    const activeCandidates = [];
    if (timeOrNull2(header.createdAt) !== null) activeCandidates.push(Number(header.createdAt));
    if (proj?.lastTime !== null && proj?.lastTime !== void 0) activeCandidates.push(proj.lastTime);
    if (external) {
      activeCandidates.push(external.startedAt);
      if (external.endedAt !== null) activeCandidates.push(external.endedAt);
    }
    const lastActive = activeCandidates.length > 0 ? Math.max(...activeCandidates) : null;
    const parentSessionId = typeof header.parentSession === "string" ? String(header.parentSession) : null;
    items.push({
      sessionId,
      parentSessionId,
      label,
      depth: Number(header.delegationDepth) || 0,
      startedAt,
      lastActive,
      relay: { model: proj?.model ?? null, totals: proj?.totals ?? emptyTotals() },
      external
    });
  }
  items.sort((a, b) => {
    const left = a.startedAt ?? Number.NEGATIVE_INFINITY;
    const right = b.startedAt ?? Number.NEGATIVE_INFINITY;
    return right - left;
  });
  const matched = items.reduce((count, item) => count + (item.external ? 1 : 0), 0);
  console.log("[dsh-usage-panel] subagents scan done: items=" + items.length + " matched=" + matched + " ms=" + (Date.now() - scanStart));
  const payload = {
    items,
    coverage: {
      total: items.length,
      matched,
      noExternal: items.length - matched,
      registryEntries: entries.size,
      errors
    },
    updatedAt: now
  };
  cache = { key: signature, at: now, payload };
  return payload;
}

// src/host/projection-unit.ts
var PROJECTION_STATE_VERSION = 2;
var usagePanelProjectionDefinition = {
  key: USAGE_PANEL_KEY,
  stateSchema: usagePanelSchema,
  init: (_header, inheritedEventCount) => ({
    ...initState(),
    seedEnd: inheritedEventCount > 0 ? Number(inheritedEventCount) + 1 : null
  }),
  apply: applyEvent,
  wire: {
    viewSchema: usagePanelSchema,
    view: (state) => state
  },
  stateVersion: PROJECTION_STATE_VERSION
};

// src/host/scan.ts
function isCountedEvent(seedLength, event) {
  if (event.seq <= seedLength) return false;
  if (event.type === "assistant/chunk") {
    const chunk = event.data.chunk;
    return !!chunk && chunk.type === "usage" && !!chunk.usage;
  }
  switch (event.type) {
    case "assistant/message":
      return !!event.data.usage;
    case "assistant/attempt":
      return (event.data.stream ?? []).some(
        (rec) => rec.type === "chunk" && rec.chunk.type === "usage" && !!rec.chunk.usage
      );
    case "compaction/summary":
      return !!event.data.usage;
    case "llm/retry":
      return true;
    default:
      return false;
  }
}
async function scanFallback(deps, now) {
  const { sq, providerNames, logFailure, isArchived } = deps;
  let a = emptyAggregate();
  const titles = /* @__PURE__ */ new Map();
  let sessionsTotal = 0;
  let sessionsOk = 0;
  let sessionsFailed = 0;
  let sessionsPending = 0;
  let eventsCounted = 0;
  let sessions = [];
  try {
    sessions = await sq.listSessions();
  } catch (err) {
    logFailure("listSessions failed: " + String(err?.message ?? err));
    return finalizeOverview({
      aggregate: a,
      now,
      mode: "scan",
      sessionsTotal: 0,
      sessionsOk: 0,
      sessionsFailed: 0,
      sessionsPending: 0,
      eventsCounted: 0,
      titles,
      providerNames
    });
  }
  for (const rec of sessions) {
    const header = rec && rec.header;
    if (!header) {
      sessionsTotal += 1;
      sessionsFailed += 1;
      continue;
    }
    const sessionId = header.id;
    sessionsTotal += 1;
    if (!rec.persisted) {
      sessionsPending += 1;
      continue;
    }
    let snapshot = null;
    try {
      snapshot = await sq.readSession(header.id);
    } catch (err) {
      sessionsFailed += 1;
      logFailure("readSession " + sessionId + " failed: " + String(err?.message ?? err));
      continue;
    }
    const events = snapshot && snapshot.events || [];
    const inherited = Number(snapshot?.inheritedEventCount) || Number(header.seedLength) || 0;
    let state = { ...initState(), seedEnd: inherited > 0 ? inherited + 1 : null };
    let title = null;
    for (const event of events) {
      if (event.type === "session/title") {
        title = event.data.title;
      }
      if (isCountedEvent(inherited, event)) eventsCounted += 1;
      state = applyEvent(state, event);
    }
    titles.set(sessionId, title);
    const depth = Number(header.delegationDepth) || 0;
    a = mergeSessionValue(a, state, sessionId, now, depth, inherited, isArchived(sessionId));
    sessionsOk += 1;
  }
  return finalizeOverview({
    aggregate: a,
    now,
    mode: "scan",
    sessionsTotal,
    sessionsOk,
    sessionsFailed,
    sessionsPending,
    eventsCounted,
    titles,
    providerNames
  });
}

// src/host/index.ts
var name = "dsh-usage-panel";
var inject = ["timer", "connection"];
var STALE_MS = 10 * 60 * 1e3;
var RESCAN_MS = 10 * 60 * 1e3;
function apply(ctx) {
  const tag = "[dsh-usage-panel]";
  const sq = ctx.get("sessionQuery");
  const registry = ctx.get("sessionProjections");
  const projCache = ctx.get("sessionProjectionCache");
  const connection = ctx.get("connection");
  const llm = ctx.get("llm");
  let workspaceRegistry;
  let markRegistryReady = () => {
  };
  const registryReady = new Promise((resolve) => {
    markRegistryReady = resolve;
  });
  ctx.inject(["workspaceRegistry"], (regCtx) => {
    workspaceRegistry = regCtx.workspaceRegistry;
    console.log(tag, "workspaceRegistry resolved: archivedSessionIds=" + (workspaceRegistry?.archivedSessionIds.length ?? 0));
    markRegistryReady();
  });
  let registryWaited = false;
  async function awaitRegistryOnce() {
    if (registryWaited) return;
    registryWaited = true;
    await Promise.race([registryReady, new Promise((r) => setTimeout(r, 1500))]);
  }
  let mode = registry && projCache && sq ? "projection" : sq ? "scan" : "none";
  console.log(
    tag,
    "boot: mode=" + mode,
    "services: sessionQuery=" + Boolean(sq) + " sessionProjections=" + Boolean(registry) + " sessionProjectionCache=" + Boolean(projCache)
  );
  let disposeUnit = null;
  if (mode === "projection") {
    try {
      disposeUnit = registry.register(usagePanelProjectionDefinition);
    } catch (err) {
      console.warn(tag, "projection registration failed; falling back to full scan:", String(err?.message ?? err));
      disposeUnit = null;
      mode = "scan";
    }
  }
  let providerNames = {};
  if (llm && typeof llm.listProviders === "function") {
    Promise.resolve(llm.listProviders()).then((infos) => {
      providerNames = Object.fromEntries((infos || []).map((p) => [p.id, p.name]));
    }).catch((err) => console.warn(tag, "listProviders failed:", String(err?.message ?? err)));
  }
  let cache2 = null;
  let inflight = null;
  let disposed = false;
  function logFailure(message) {
    console.warn(tag, message);
  }
  function archivedSet() {
    return new Set((workspaceRegistry?.archivedSessionIds ?? []).map(String));
  }
  async function scanProjection(now) {
    let a = emptyAggregate();
    const archived = archivedSet();
    let sessionsTotal = 0;
    let sessionsOk = 0;
    let sessionsFailed = 0;
    let sessionsPending = 0;
    const failures = [];
    let sessions = [];
    try {
      sessions = await sq.listSessions();
    } catch (err) {
      logFailure("listSessions failed: " + String(err?.message ?? err));
      return emptyOverview(now);
    }
    for (const rec of sessions) {
      const header = rec && rec.header;
      if (!header) {
        sessionsTotal += 1;
        sessionsFailed += 1;
        continue;
      }
      const id = header.id;
      sessionsTotal += 1;
      if (!rec.persisted) {
        sessionsPending += 1;
        continue;
      }
      try {
        const snap = await sq.readSession(id);
        const projected = projCache.coldSnapshot(snap.session, snap.inheritedEventCount, snap.events);
        const value = projected.values.usagePanel;
        if (!value) {
          sessionsPending += 1;
          continue;
        }
        const depth = Number(header.delegationDepth) || 0;
        const inherited = Number(snap.inheritedEventCount) || 0;
        a = mergeSessionValue(a, value, id, now, depth, inherited, archived.has(String(id)));
        sessionsOk += 1;
      } catch (err) {
        sessionsFailed += 1;
        if (failures.length < 3) failures.push(String(err?.message ?? err));
      }
    }
    if (failures.length > 0) {
      logFailure(sessionsFailed + " session(s) failed to read (first " + failures.length + "): " + failures.join(" | "));
    }
    const titles = /* @__PURE__ */ new Map();
    await Promise.all(
      rankSessions(a.sessions, 10).map(async (s) => {
        try {
          const t = await sq.readTitle(s.id);
          titles.set(s.id, t ? t.title : null);
        } catch {
          titles.set(s.id, null);
        }
      })
    );
    return finalizeOverview({
      aggregate: a,
      now,
      mode: "projection",
      sessionsTotal,
      sessionsOk,
      sessionsFailed,
      sessionsPending,
      eventsCounted: 0,
      titles,
      providerNames
    });
  }
  async function scan(now) {
    if (disposed) return cache2 ? cache2.payload : emptyOverview(now);
    if (mode === "none") {
      console.log(tag, "sessionQuery unavailable; returning empty overview");
      return emptyOverview(now);
    }
    await awaitRegistryOnce();
    if (mode === "projection") return scanProjection(now);
    return scanFallback({ sq, providerNames, logFailure, isArchived: (id) => archivedSet().has(id) }, now);
  }
  function startScan() {
    if (disposed) return Promise.resolve(cache2 ? cache2.payload : emptyOverview(Date.now()));
    if (inflight) return inflight;
    const run = scan(Date.now()).then((payload) => {
      if (!disposed) cache2 = { at: Date.now(), payload };
      return payload;
    });
    inflight = run;
    run.catch(() => {
    }).then(() => {
      if (inflight === run) inflight = null;
    });
    return run;
  }
  function overview(args) {
    const force = !!(args && args.force);
    if (!force && cache2) {
      if (Date.now() - cache2.at < STALE_MS) return Promise.resolve(cache2.payload);
      startScan();
      return Promise.resolve(Object.assign({}, cache2.payload, { stale: true }));
    }
    return startScan();
  }
  const disposeRpc = connection && connection.fetch.register({
    path: RPC_PATH,
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      const message = await request.json().catch(() => void 0);
      if (!message || message.type !== "client-request" || typeof message.rpcId !== "string") {
        return new Response("bad request", { status: 400 });
      }
      const respond = (result) => Response.json({ type: "server-response", rpcId: message.rpcId, result });
      if (message.method !== RPC_OVERVIEW) {
        return respond({
          ok: false,
          error: { code: "bad-request", message: "unknown endpoint: " + String(message.method), details: { issues: [] } }
        });
      }
      return respond(
        await overview(message.payload).then(
          (value) => ({ ok: true, value }),
          (err) => ({
            ok: false,
            error: { code: "internal", message: String(err?.message ?? err), details: {} }
          })
        )
      );
    }
  });
  const disposeSubagentsRpc = connection && connection.fetch.register({
    path: RPC_SUBAGENTS_PATH,
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      const message = await request.json().catch(() => void 0);
      if (!message || message.type !== "client-request" || typeof message.rpcId !== "string") {
        return new Response("bad request", { status: 400 });
      }
      const respond = (result) => Response.json({ type: "server-response", rpcId: message.rpcId, result });
      if (message.method !== RPC_SUBAGENTS) {
        return respond({
          ok: false,
          error: { code: "bad-request", message: "unknown endpoint: " + String(message.method), details: { issues: [] } }
        });
      }
      if (!sq) {
        return respond({
          ok: false,
          error: { code: "service-unavailable", message: "sessionQuery unavailable", details: {} }
        });
      }
      return respond(
        await collectSubagents({ sq }).then(
          (value) => ({ ok: true, value }),
          (err) => ({
            ok: false,
            error: { code: "internal", message: String(err?.message ?? err), details: {} }
          })
        )
      );
    }
  });
  startScan().then((o) => {
    console.log(
      tag,
      "first scan done:",
      "mode=" + o.coverage.mode,
      "sessions=" + o.coverage.sessionsTotal + "/" + o.coverage.sessionsOk + " (failed " + o.coverage.sessionsFailed + ", pending " + o.coverage.sessionsPending + ")",
      "withUsage=" + o.allTime.sessionCount,
      "dataRange=" + (o.coverage.from === null ? "-" : new Date(o.coverage.from).toISOString()) + ".." + (o.coverage.to === null ? "-" : new Date(o.coverage.to).toISOString())
    );
  });
  const stopTimer = ctx.interval(() => {
    if (!inflight) startScan();
  }, RESCAN_MS);
  ctx.effect(() => () => {
    disposed = true;
    if (disposeUnit) disposeUnit();
    if (stopTimer) stopTimer();
    if (disposeRpc) disposeRpc();
    if (disposeSubagentsRpc) disposeSubagentsRpc();
  });
}
export {
  apply,
  inject,
  name
};
