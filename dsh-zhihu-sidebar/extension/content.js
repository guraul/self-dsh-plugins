const RECOMMEND_URL =
  'https://www.zhihu.com/api/v4/creators/question_route/pc_member_related/recommend';
const SEARCH_URL = 'https://www.zhihu.com/api/v4/search_v3';

const PAGE_SIZE = 20;
const REQUEST_GAP_MS = 900;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url) {
  const response = await fetch(url, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('not_logged_in');
  }
  if (!response.ok) {
    throw new Error(`http_${response.status}`);
  }
  const payload = await response.json();
  if (payload && payload.error) {
    throw new Error('not_logged_in');
  }
  return payload;
}

function toPageCount(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 50);
}

async function collectRecommend(pages) {
  const total = toPageCount(pages, 2);
  const items = [];
  for (let page = 0; page < total; page += 1) {
    if (page > 0) await sleep(REQUEST_GAP_MS);
    const offset = page * PAGE_SIZE;
    const url =
      `${RECOMMEND_URL}?page_source=pc_panel&limit=${PAGE_SIZE}&offset=${offset}`;
    const payload = await requestJson(url);
    const data = Array.isArray(payload.data) ? payload.data : [];
    for (const entry of data) items.push(entry);
    if (!data.length) break;
    if (payload.paging && payload.paging.is_end) break;
  }
  return items;
}

async function collectSearch(keyword, count) {
  const wanted = toPageCount(count, 40);
  const items = [];
  let offset = 0;
  while (items.length < wanted) {
    if (offset > 0) await sleep(REQUEST_GAP_MS);
    const url =
      `${SEARCH_URL}?t=question&q=${encodeURIComponent(keyword)}` +
      `&correction=1&offset=${offset}&limit=${PAGE_SIZE}`;
    const payload = await requestJson(url);
    const data = Array.isArray(payload.data) ? payload.data : [];
    for (const entry of data) items.push(entry);
    if (!data.length) break;
    offset += PAGE_SIZE;
    if (payload.paging && payload.paging.is_end) break;
  }
  return items.slice(0, wanted);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  const run = async () => {
    try {
      if (message.type === 'recommend') {
        return { ok: true, items: await collectRecommend(message.pages) };
      }
      if (message.type === 'search') {
        const keyword = String(message.keyword || '').trim();
        if (!keyword) return { ok: false, error: 'empty_keyword' };
        return { ok: true, items: await collectSearch(keyword, message.count) };
      }
      return { ok: false, error: 'unknown_request' };
    } catch (error) {
      const name = error && error.message ? error.message : 'request_failed';
      return { ok: false, error: name };
    }
  };

  run().then(sendResponse);
  return true;
});
