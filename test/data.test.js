'use strict';

const test = require('node:test');
const assert = require('node:assert');
const data = require('../src/data');

const fresh = () => {
  delete require.cache[require.resolve('../src/data')];
  return require('../src/data');
};

function klineRows(n) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.now() - (n - i) * 86400e3).toISOString().slice(0, 10);
    return { d, c: 100 + i };
  });
}

test('Yahoo、新浪失败时回退到东方财富', async () => {
  const d = fresh();
  const klines = klineRows(300).map((r) => `${r.d},100,${r.c},101,99,0,0`);
  d.setTransport(async (url) => {
    if (url.includes('yahoo') || url.includes('sina')) throw Object.assign(new Error('x'), { code: 'ECONNRESET' });
    if (url.includes('eastmoney') && url.includes('kline')) return { status: 200, text: JSON.stringify({ data: { klines } }) };
    if (url.includes('eastmoney') && url.includes('trends2')) {
      return { status: 200, text: JSON.stringify({ data: { preClose: 398, trends: ['2024-01-03 22:31,0,401.5,0,0,0,0,0'] } }) };
    }
    return { status: 403, text: '' };
  });
  const q = await d.fetchQuote('sp500');
  assert.strictEqual(q.source, '东方财富');
  assert.strictEqual(q.price, 401.5);
  assert.strictEqual(q.previousClose, 398);
  const h = await d.fetchHistory('sp500');
  assert.strictEqual(h.source, '东方财富');
  assert.strictEqual(h.points.length, 300);
});

test('东方财富 HTTPS 被断开时改用 HTTP', async () => {
  const d = fresh();
  const klines = klineRows(300).map((r) => `${r.d},100,${r.c},101,99,0,0`);
  const seen = [];
  d.setTransport(async (url) => {
    seen.push(url.slice(0, 8));
    if (!url.includes('eastmoney') || url.startsWith('https:')) throw Object.assign(new Error('closed'), { code: 'ECONNRESET' });
    return { status: 200, text: JSON.stringify({ data: { klines } }) };
  });
  const h = await d.fetchHistory('gold');
  assert.strictEqual(h.source, '东方财富');
  assert.ok(seen.includes('http://p'));
});

test('新浪财经报价与日线', async () => {
  const d = fresh();
  const rows = klineRows(400);
  d.setTransport(async (url) => {
    if (url.includes('hq.sinajs.cn/list=gb_$inx')) {
      return { status: 200, text: 'var hq_str_gb_$inx="标普500指数,5864.67,0.40,2024-10-11 05:00:00,23.20,5841.41,5878.04,5832.84";' };
    }
    if (url.includes('hq.sinajs.cn/list=hf_GC')) {
      return { status: 200, text: 'var hq_str_hf_GC="2650.300,,2650.200,2650.400,2662.800,2643.200,06:59:59,2639.700,2640.000,0,1,1,2024-10-11,纽约黄金,0";' };
    }
    if (url.includes('getDailyK')) return { status: 200, text: `var _INX=(${JSON.stringify(rows.map((r) => ({ d: r.d, o: '1', c: String(r.c) })))});` };
    if (url.includes('GlobalFutures')) return { status: 200, text: `var _GC=(${JSON.stringify(rows.map((r) => ({ date: r.d, close: String(r.c) })))});` };
    return { status: 403, text: '' };
  });
  const sp = await d.fetchQuote('sp500');
  assert.strictEqual(sp.source, '新浪财经');
  assert.strictEqual(sp.price, 5864.67);
  assert.ok(Math.abs(sp.previousClose - 5841.47) < 1e-9);
  assert.strictEqual(new Date(sp.marketTime).toISOString(), '2024-10-10T21:00:00.000Z');
  const gold = await d.fetchQuote('gold');
  assert.strictEqual(gold.price, 2650.3);
  assert.strictEqual(gold.previousClose, 2639.7);
  const h1 = await d.fetchHistory('sp500');
  const h2 = await d.fetchHistory('gold');
  assert.strictEqual(h1.points.length, 400);
  assert.strictEqual(h2.points.at(-1).c, 499);
});

test('全部失败时错误信息列出每个数据源', async () => {
  const d = fresh();
  d.setTransport(async () => ({ status: 403, text: 'no' }));
  await assert.rejects(d.fetchQuote('gold'), /Yahoo Finance: HTTP 403；新浪财经: HTTP 403；东方财富: HTTP 403；Stooq: HTTP 403/);
});

test('网络层：带浏览器请求头、跟随重定向', async () => {
  const http = require('http');
  const srv = http.createServer((req, res) => {
    if (req.url === '/old') {
      res.writeHead(302, { Location: '/new' });
      return res.end();
    }
    res.end(JSON.stringify({ url: req.url, ua: req.headers['user-agent'], ref: req.headers.referer }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { port } = srv.address();
    const res = await data.nodeGet(`http://127.0.0.1:${port}/old`, { 'User-Agent': 'UA-X', Referer: 'R' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.text), { url: '/new', ua: 'UA-X', ref: 'R' });
  } finally {
    srv.close();
  }
});
