function unwrap(item) {
  const node = item && typeof item === 'object' ? item : {};
  const reason = typeof node.reason === 'string' ? node.reason : '';
  if (node.question && typeof node.question === 'object') {
    return { raw: node.question, reason };
  }
  if (node.object && typeof node.object === 'object') {
    return { raw: node.object, reason };
  }
  return { raw: node, reason };
}

function toCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function isBlank(value) {
  return value === null || value === undefined || value === '';
}

export function normalize(item, source) {
  const { raw, reason } = unwrap(item);
  const title = String(raw.title === null || raw.title === undefined ? '' : raw.title)
    .replace(/<[^>]+>/g, '')
    .trim();
  const id = raw.id === null || raw.id === undefined ? '' : String(raw.id);
  const url = typeof raw.url === 'string' && raw.url
    ? raw.url
    : id
      ? `https://www.zhihu.com/question/${id}`
      : '';
  const created = Number(raw.created);
  return {
    id,
    title,
    url,
    visits: toCount(raw.visit_count ?? raw.visits_count ?? 0),
    answers: toCount(raw.answer_count ?? 0),
    followers: toCount(raw.follower_count ?? 0),
    created: Number.isFinite(created) && created > 0 ? created : null,
    reason: reason || (typeof raw.reason === 'string' ? raw.reason : ''),
    source: source === 'search' ? 'search' : 'recommend',
  };
}

export function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    if (!item) continue;
    const key = item.id || item.url;
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function applyFilters(items, filters) {
  const opts = filters || {};
  const minVisits = isBlank(opts.minVisits) ? null : Number(opts.minVisits);
  const maxAnswers = isBlank(opts.maxAnswers) ? null : Number(opts.maxAnswers);
  const maxAgeDays = isBlank(opts.maxAgeDays) ? null : Number(opts.maxAgeDays);
  const keyword = isBlank(opts.keyword) ? '' : String(opts.keyword).trim().toLowerCase();
  const cutoff =
    maxAgeDays === null || !Number.isFinite(maxAgeDays)
      ? null
      : Date.now() - maxAgeDays * 86400000;

  return (items || []).filter((item) => {
    if (minVisits !== null && Number.isFinite(minVisits) && item.visits < minVisits) {
      return false;
    }
    if (maxAnswers !== null && Number.isFinite(maxAnswers) && item.answers > maxAnswers) {
      return false;
    }
    if (cutoff !== null && item.created !== null && item.created * 1000 < cutoff) {
      return false;
    }
    if (keyword && !item.title.toLowerCase().includes(keyword)) return false;
    return true;
  });
}

function score(item, mode) {
  if (mode === 'traffic_per_answer') return item.visits / Math.max(item.answers, 1);
  if (mode === 'blue_ocean') return item.followers / Math.max(item.answers, 1);
  if (mode === 'visits') return item.visits;
  return 0;
}

export function sortItems(items, mode) {
  const list = [...(items || [])];
  if (mode === 'newest') {
    return list.sort((a, b) => {
      if (a.created === null && b.created === null) return b.visits - a.visits;
      if (a.created === null) return 1;
      if (b.created === null) return -1;
      if (b.created !== a.created) return b.created - a.created;
      return b.visits - a.visits;
    });
  }
  const key = mode === 'blue_ocean' || mode === 'visits' ? mode : 'traffic_per_answer';
  return list.sort((a, b) => {
    const diff = score(b, key) - score(a, key);
    if (diff !== 0 && Number.isFinite(diff)) return diff;
    if (b.visits !== a.visits) return b.visits - a.visits;
    if (b.created !== null && a.created !== null && b.created !== a.created) {
      return b.created - a.created;
    }
    return String(a.id).localeCompare(String(b.id));
  });
}

export function formatNumber(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs < 10000) return String(Math.round(value));
  const scaled = (value / 10000).toFixed(1).replace(/\.0$/, '');
  return `${scaled}万`;
}

export function formatDate(ts) {
  const value = Number(ts);
  if (ts === null || ts === undefined || !Number.isFinite(value) || value <= 0) return '—';
  const date = new Date(value * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
