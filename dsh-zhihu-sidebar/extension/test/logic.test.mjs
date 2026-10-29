import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalize,
  dedupe,
  applyFilters,
  sortItems,
  formatNumber,
  formatDate,
} from '../lib/logic.js';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function recommendItem(overrides = {}) {
  return {
    reason: '你在「合成话题」下获得过 12 个赞同',
    question: {
      id: '000',
      title: '合成问题 <em>甲</em>',
      url: 'https://www.zhihu.com/question/000',
      visit_count: 100,
      answer_count: 3,
      follower_count: 9,
      created: NOW - DAY,
      ...overrides,
    },
  };
}

function searchItem(overrides = {}) {
  return {
    object: {
      id: '001',
      title: '合成问题 <em>乙</em>',
      url: 'https://www.zhihu.com/question/001',
      visits_count: 250,
      answer_count: 0,
      follower_count: 4,
      updated_time: NOW - DAY,
      ...overrides,
    },
  };
}

test('normalize 处理推荐池形状并去掉高亮标签', () => {
  const item = normalize(recommendItem(), 'recommend');
  assert.equal(item.id, '000');
  assert.equal(item.title, '合成问题 甲');
  assert.equal(item.url, 'https://www.zhihu.com/question/000');
  assert.equal(item.visits, 100);
  assert.equal(item.answers, 3);
  assert.equal(item.followers, 9);
  assert.equal(item.created, NOW - DAY);
  assert.equal(item.reason, '你在「合成话题」下获得过 12 个赞同');
  assert.equal(item.source, 'recommend');
});

test('normalize 处理搜索池形状且 created 为 null', () => {
  const item = normalize(searchItem(), 'search');
  assert.equal(item.id, '001');
  assert.equal(item.title, '合成问题 乙');
  assert.equal(item.visits, 250);
  assert.equal(item.answers, 0);
  assert.equal(item.followers, 4);
  assert.equal(item.created, null);
  assert.equal(item.reason, '');
  assert.equal(item.source, 'search');
});

test('normalize 兼容 visit_count 与 visits_count 两种浏览字段', () => {
  assert.equal(normalize(recommendItem(), 'recommend').visits, 100);
  assert.equal(normalize(searchItem(), 'search').visits, 250);
  assert.equal(
    normalize({ question: { id: '002', title: '合成问题', visits_count: 7 } }, 'recommend').visits,
    7,
  );
  assert.equal(
    normalize({ object: { id: '003', title: '合成问题', visit_count: 8 } }, 'search').visits,
    8,
  );
});

test('normalize 缺字段时回落为 0 与空值', () => {
  const item = normalize({ question: { id: '004', title: '合成问题' } }, 'recommend');
  assert.equal(item.visits, 0);
  assert.equal(item.answers, 0);
  assert.equal(item.followers, 0);
  assert.equal(item.created, null);
  assert.equal(item.url, 'https://www.zhihu.com/question/004');
});

test('dedupe 按 id 去重并保留先出现的条目', () => {
  const first = normalize(recommendItem({ title: '合成问题 先' }), 'recommend');
  const second = normalize(recommendItem({ title: '合成问题 后' }), 'recommend');
  const other = normalize(searchItem(), 'search');
  const result = dedupe([first, second, other]);
  assert.equal(result.length, 2);
  assert.equal(result[0].title, '合成问题 先');
  assert.equal(result[1].id, '001');
});

test('applyFilters 独立生效：最小浏览', () => {
  const items = [
    normalize({ question: { id: '010', title: '合成问题 低', visit_count: 10 } }, 'recommend'),
    normalize({ question: { id: '011', title: '合成问题 高', visit_count: 20000 } }, 'recommend'),
  ];
  const result = applyFilters(items, { minVisits: 10000 });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, '011');
});

test('applyFilters 独立生效：最大回答数', () => {
  const items = [
    normalize({ question: { id: '020', title: '合成问题 少', answer_count: 2 } }, 'recommend'),
    normalize({ question: { id: '021', title: '合成问题 多', answer_count: 300 } }, 'recommend'),
  ];
  const result = applyFilters(items, { maxAnswers: 100 });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, '020');
});

test('applyFilters 独立生效：关键词不区分大小写', () => {
  const items = [
    normalize({ question: { id: '030', title: '合成问题 GPT' } }, 'recommend'),
    normalize({ question: { id: '031', title: '合成问题 其他' } }, 'recommend'),
  ];
  assert.equal(applyFilters(items, { keyword: 'gpt' }).length, 1);
  assert.equal(applyFilters(items, { keyword: '  GPT  ' }).length, 1);
});

test('applyFilters 在 maxAgeDays 下保留 created 为 null 的条目', () => {
  const fresh = normalize(recommendItem({ id: '040', created: NOW - DAY }), 'recommend');
  const stale = normalize(recommendItem({ id: '041', created: NOW - 30 * DAY }), 'recommend');
  const unknown = normalize(searchItem({ id: '042' }), 'search');
  const result = applyFilters([fresh, stale, unknown], { maxAgeDays: 7 });
  assert.deepEqual(result.map((item) => item.id), ['040', '042']);
});

test('applyFilters 组合条件与空值不过滤', () => {
  const items = [
    normalize(
      { question: { id: '050', title: '合成问题 命中', visit_count: 50000, answer_count: 10 } },
      'recommend',
    ),
    normalize(
      { question: { id: '051', title: '合成问题 回答太多', visit_count: 50000, answer_count: 800 } },
      'recommend',
    ),
    normalize(
      { question: { id: '052', title: '合成问题 浏览太低', visit_count: 20, answer_count: 10 } },
      'recommend',
    ),
  ];
  const combined = applyFilters(items, { minVisits: 10000, maxAnswers: 100 });
  assert.deepEqual(combined.map((item) => item.id), ['050']);
  assert.equal(applyFilters(items, { minVisits: null, maxAnswers: '', maxAgeDays: null, keyword: '' }).length, 3);
});

test('sortItems 每回答流量：回答为 0 时除数为 1', () => {
  const zero = normalize({ question: { id: '060', title: '合成问题 零', visit_count: 500, answer_count: 0 } }, 'recommend');
  const many = normalize({ question: { id: '061', title: '合成问题 多', visit_count: 500, answer_count: 50 } }, 'recommend');
  const result = sortItems([many, zero], 'traffic_per_answer');
  assert.equal(result[0].id, '060');
  assert.ok(Number.isFinite(result[0].visits / Math.max(result[0].answers, 1)));
});

test('sortItems 蓝海指数按关注数除以回答数', () => {
  const a = normalize({ question: { id: '070', title: '合成问题 A', follower_count: 100, answer_count: 2 } }, 'recommend');
  const b = normalize({ question: { id: '071', title: '合成问题 B', follower_count: 100, answer_count: 50 } }, 'recommend');
  const c = normalize({ question: { id: '072', title: '合成问题 C', follower_count: 10, answer_count: 0 } }, 'recommend');
  const result = sortItems([b, c, a], 'blue_ocean');
  assert.deepEqual(result.map((item) => item.id), ['070', '072', '071']);
});

test('sortItems 按浏览量降序', () => {
  const low = normalize({ question: { id: '080', title: '合成问题 低', visit_count: 1 } }, 'recommend');
  const high = normalize({ question: { id: '081', title: '合成问题 高', visit_count: 999 } }, 'recommend');
  assert.deepEqual(sortItems([low, high], 'visits').map((item) => item.id), ['081', '080']);
});

test('sortItems 最新：created 为 null 排最后', () => {
  const old = normalize({ question: { id: '090', title: '合成问题 旧', created: NOW - 10 * DAY } }, 'recommend');
  const recent = normalize({ question: { id: '091', title: '合成问题 新', created: NOW - DAY } }, 'recommend');
  const unknown = normalize(searchItem({ id: '092' }), 'search');
  assert.deepEqual(sortItems([unknown, old, recent], 'newest').map((item) => item.id), ['091', '090', '092']);
});

test('formatNumber 万级格式化', () => {
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(1234), '1234');
  assert.equal(formatNumber(12345), '1.2万');
  assert.equal(formatNumber(13028673), '1302.9万');
});

test('formatDate 处理正常时间戳与 null', () => {
  const ts = Math.floor(new Date(2026, 9, 29, 12, 0, 0).getTime() / 1000);
  assert.equal(formatDate(ts), '2026-10-29');
  assert.equal(formatDate(null), '—');
  assert.equal(formatDate(undefined), '—');
});
