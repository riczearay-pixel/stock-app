'use strict';

const test = require('node:test');
const assert = require('node:assert');

// 模拟：Yahoo 不可用，东方财富可用 → 应自动回退到东方财富
test('Yahoo 失败时回退到东方财富', async () => {
  const realFetch = global.fetch;
  const klines = Array.from({ length: 300 }, (_, i) => {
    const d = new Date(Date.UTC(2023, 0, 1) + i * 86400e3).toISOString().slice(0, 10);
    return `${d},100,${100 + i},101,99,0,0`;
  });
  global.fetch = async (url) => {
    if (url.includes('yahoo')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    if (url.includes('eastmoney') && url.includes('kline')) return new Response(JSON.stringify({ data: { klines } }));
    if (url.includes('eastmoney') && url.includes('trends2')) {
      return new Response(JSON.stringify({ data: { preClose: 398, trends: ['2024-01-03 22:31,0,401.5,0,0,0,0,0'] } }));
    }
    return new Response('blocked', { status: 403 });
  };
  try {
    const { fetchQuote, fetchHistory } = require('../src/data');
    const q = await fetchQuote('sp500');
    assert.strictEqual(q.source, '东方财富');
    assert.strictEqual(q.price, 401.5);
    assert.strictEqual(q.previousClose, 398);
    const h = await fetchHistory('sp500');
    assert.strictEqual(h.source, '东方财富');
    assert.strictEqual(h.points.length, 300);
  } finally {
    global.fetch = realFetch;
  }
});

test('全部失败时错误信息列出每个数据源', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => new Response('no', { status: 403 });
  try {
    delete require.cache[require.resolve('../src/data')];
    const { fetchQuote } = require('../src/data');
    await assert.rejects(fetchQuote('gold'), /Yahoo Finance: HTTP 403；东方财富: HTTP 403；Stooq: HTTP 403/);
  } finally {
    global.fetch = realFetch;
  }
});
