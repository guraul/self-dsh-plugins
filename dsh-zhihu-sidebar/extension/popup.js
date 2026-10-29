import {
  normalize,
  dedupe,
  applyFilters,
  sortItems,
  formatNumber,
  formatDate,
} from './lib/logic.js';

const CACHE_KEY = 'zhihu-topics-cache';
const MAX_CACHED = 2000;

const state = {
  items: [],
  sort: 'traffic_per_answer',
  tabId: null,
  busy: false,
};

const el = {
  tabState: document.getElementById('tab-state'),
  noTab: document.getElementById('no-tab'),
  openZhihu: document.getElementById('open-zhihu'),
  pullRecommend: document.getElementById('pull-recommend'),
  pullPages: document.getElementById('pull-pages'),
  searchKeyword: document.getElementById('search-keyword'),
  runSearch: document.getElementById('run-search'),
  minVisits: document.getElementById('min-visits'),
  maxAnswers: document.getElementById('max-answers'),
  filterKeyword: document.getElementById('filter-keyword'),
  presetHot: document.getElementById('preset-hot'),
  presetFirst: document.getElementById('preset-first'),
  presetAll: document.getElementById('preset-all'),
  sortMode: document.getElementById('sort-mode'),
  clearCache: document.getElementById('clear-cache'),
  notice: document.getElementById('notice'),
  rows: document.getElementById('rows'),
  empty: document.getElementById('empty'),
  status: document.getElementById('status'),
};

function showNotice(text, isError) {
  if (!text) {
    el.notice.classList.add('hidden');
    el.notice.textContent = '';
    return;
  }
  el.notice.textContent = text;
  el.notice.classList.toggle('error', Boolean(isError));
  el.notice.classList.remove('hidden');
}

function setBusy(busy) {
  state.busy = busy;
  const disabled = busy || state.tabId === null;
  el.pullRecommend.disabled = disabled;
  el.runSearch.disabled = disabled;
}

function currentFilters() {
  return {
    minVisits: el.minVisits.value === '' ? null : Number(el.minVisits.value),
    maxAnswers: el.maxAnswers.value === '' ? null : Number(el.maxAnswers.value),
    maxAgeDays: state.maxAgeDays ?? null,
    keyword: el.filterKeyword.value,
  };
}

function computeItems() {
  const filtered = applyFilters(state.items, currentFilters());
  return sortItems(filtered, state.sort);
}

function render() {
  const visible = computeItems();
  el.rows.textContent = '';
  for (const item of visible) {
    const tr = document.createElement('tr');

    const titleCell = document.createElement('td');
    titleCell.className = 'title';
    const link = document.createElement('a');
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = item.title || '（无标题）';
    titleCell.appendChild(link);
    if (item.reason) {
      const reason = document.createElement('span');
      reason.className = 'reason';
      reason.textContent = item.reason;
      titleCell.appendChild(reason);
    }
    tr.appendChild(titleCell);

    const cells = [
      formatNumber(item.visits),
      formatNumber(item.answers),
      formatNumber(item.followers),
      formatNumber(Math.round(item.visits / Math.max(item.answers, 1))),
      formatDate(item.created),
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.className = 'num';
      td.textContent = text;
      tr.appendChild(td);
    }

    el.rows.appendChild(tr);
  }

  if (visible.length === 0) {
    el.empty.textContent =
      state.items.length > 0
        ? '没有符合筛选条件的问题，试试放宽条件或点「全部」。'
        : '还没有数据，先拉取推荐池或搜索一个关键词。';
    el.empty.classList.remove('hidden');
  } else {
    el.empty.classList.add('hidden');
  }
  el.status.textContent = `已加载 ${state.items.length} 条 · 显示 ${visible.length} 条`;
}

let saveTimer = null;

function saveCache() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const items = state.items.slice(0, MAX_CACHED);
    chrome.storage.local.set({ [CACHE_KEY]: { items, savedAt: Date.now() } });
  }, 150);
}

function mergeItems(incoming, source) {
  const normalized = incoming.map((item) => normalize(item, source));
  state.items = dedupe([...normalized, ...state.items]).slice(0, MAX_CACHED);
  saveCache();
  render();
}

function describeError(code) {
  if (code === 'not_logged_in') return '知乎未登录：请先在该知乎页面登录后重试。';
  if (code === 'empty_keyword') return '请先输入关键词。';
  if (code === 'unknown_request') return '扩展版本不匹配，请重新加载扩展。';
  if (typeof code === 'string' && code.startsWith('http_')) {
    return `知乎接口返回 ${code.slice(5)}，可能被风控或接口已改版。`;
  }
  if (
    code === 'no_tab' ||
    code === 'no_receiver' ||
    (typeof code === 'string' && code.includes('Receiving end does not exist')) ||
    (typeof code === 'string' && code.includes('Could not establish connection'))
  ) {
    return '连不上知乎页面：请刷新该知乎标签页后重试（扩展安装前打开的页面需要刷新一次）。';
  }
  return `请求失败：${code || '未知错误'}`;
}

function sendToTab(message) {
  return new Promise((resolve) => {
    if (state.tabId === null) {
      resolve({ ok: false, error: 'no_tab' });
      return;
    }
    chrome.tabs.sendMessage(state.tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message || 'no_receiver' });
        return;
      }
      resolve(response || { ok: false, error: 'no_response' });
    });
  });
}

async function refreshTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.zhihu.com/*' });
  const tab = tabs[0];
  state.tabId = tab && typeof tab.id === 'number' ? tab.id : null;
  if (state.tabId === null) {
    el.tabState.textContent = '未找到知乎标签页';
    el.tabState.classList.add('bad');
    el.noTab.classList.remove('hidden');
  } else {
    el.tabState.textContent = `当前标签页：${tab.title || '知乎'}`;
    el.tabState.classList.remove('bad');
    el.noTab.classList.add('hidden');
  }
  setBusy(state.busy);
}

async function pullRecommend() {
  setBusy(true);
  showNotice('正在拉取推荐池…', false);
  const pages = Math.max(1, Math.min(20, Number(el.pullPages.value) || 2));
  const response = await sendToTab({ type: 'recommend', pages });
  setBusy(false);
  if (!response.ok) {
    showNotice(describeError(response.error), true);
    return;
  }
  mergeItems(response.items || [], 'recommend');
  showNotice(`推荐池返回 ${response.items ? response.items.length : 0} 条。`, false);
}

async function runSearch() {
  const keyword = el.searchKeyword.value.trim();
  if (!keyword) {
    showNotice(describeError('empty_keyword'), true);
    el.searchKeyword.focus();
    return;
  }
  setBusy(true);
  showNotice(`正在搜索「${keyword}」…`, false);
  const response = await sendToTab({ type: 'search', keyword, count: 40 });
  setBusy(false);
  if (!response.ok) {
    showNotice(describeError(response.error), true);
    return;
  }
  mergeItems(response.items || [], 'search');
  showNotice(`搜索「${keyword}」返回 ${response.items ? response.items.length : 0} 条。`, false);
}

function applyPreset(name) {
  state.maxAgeDays = null;
  for (const button of [el.presetHot, el.presetFirst, el.presetAll]) {
    button.classList.toggle('active', button === el[name]);
  }
  if (name === 'presetHot') {
    el.minVisits.value = '10000';
    el.maxAnswers.value = '100';
  } else if (name === 'presetFirst') {
    el.minVisits.value = '';
    el.maxAnswers.value = '0';
    state.maxAgeDays = 7;
  } else {
    el.minVisits.value = '';
    el.maxAnswers.value = '';
    el.filterKeyword.value = '';
  }
  render();
}

function onFilterInput() {
  for (const button of [el.presetHot, el.presetFirst, el.presetAll]) {
    button.classList.remove('active');
  }
  state.maxAgeDays = null;
  render();
}

async function loadCache() {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  const cache = stored ? stored[CACHE_KEY] : null;
  if (cache && Array.isArray(cache.items)) {
    state.items = cache.items;
    render();
  }
}

function clearCache() {
  state.items = [];
  state.maxAgeDays = null;
  el.minVisits.value = '';
  el.maxAnswers.value = '';
  el.filterKeyword.value = '';
  for (const button of [el.presetHot, el.presetFirst, el.presetAll]) {
    button.classList.remove('active');
  }
  chrome.storage.local.remove(CACHE_KEY);
  render();
  showNotice('已清空本地数据。', false);
}

function bind() {
  el.openZhihu.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.zhihu.com' });
  });
  el.pullRecommend.addEventListener('click', pullRecommend);
  el.runSearch.addEventListener('click', runSearch);
  el.searchKeyword.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') runSearch();
  });
  el.sortMode.addEventListener('change', () => {
    state.sort = el.sortMode.value;
    render();
  });
  for (const input of [el.minVisits, el.maxAnswers, el.filterKeyword]) {
    input.addEventListener('input', onFilterInput);
  }
  el.presetHot.addEventListener('click', () => applyPreset('presetHot'));
  el.presetFirst.addEventListener('click', () => applyPreset('presetFirst'));
  el.presetAll.addEventListener('click', () => applyPreset('presetAll'));
  el.clearCache.addEventListener('click', clearCache);
}

async function init() {
  state.maxAgeDays = null;
  bind();
  await loadCache();
  await refreshTab();
  render();
}

init();
